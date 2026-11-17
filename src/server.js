const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cfg = require('./config');
const { db } = require('./db');
const store = require('./store');
const auth = require('./auth');
const views = require('./views');
const summary = require('./summary');
const mailer = require('./mailer');
const drive = require('./drive');
const gcal = require('./gcal');
const { isDate, weekStart, todayIn, addDays, str, nowParts, TIMEZONES } = require('./util');
const H = require('../public/hours.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', cfg.TRUST_PROXY);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.type('text').send('ok'); });
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', index: false }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

const send = (res, page, status = 200) => res.status(status).type('html').send(String(page));

// ---- auth
app.use((req, res, next) => { req.session = auth.readSession(req); next(); });
app.get('/login', (req, res) => send(res, views.login({ needSetup: auth.passwordRequired() && !cfg.APP_PASSWORD })));
app.post('/login', (req, res) => {
  if (auth.limited(req.ip)) return send(res, views.login({ error: 'Too many tries. Wait 10 minutes.', name: req.body.name }), 429);
  const pw = req.body.password || '';
  let role = null;
  if (auth.checkAdmin(pw)) role = 'admin'; else if (auth.checkTeam(pw)) role = 'team';
  if (!role) { auth.recordFail(req.ip); return send(res, views.login({ error: 'Wrong password.', name: req.body.name }), 401); }
  auth.writeSession(req, res, { r: role, n: str(req.body.name, 80) || '' });
  res.redirect(303, '/');
});
app.post('/logout', (req, res) => { auth.clearSession(res); res.redirect(303, '/login'); });

app.use((req, res, next) => {
  if (!auth.passwordRequired()) { req.session = req.session || { r: 'team', n: '' }; return next(); }
  if (req.session) return next();
  if (req.method === 'GET' && req.accepts('html')) return res.redirect(303, '/login');
  res.status(401).send('Sign in required');
});

function requireAdmin(req, res, next) {
  if (auth.isAdmin(req)) return next();
  if (req.method === 'GET') return res.redirect(303, '/admin-login?next=' + encodeURIComponent(req.originalUrl));
  return send(res, views.message(req, { title: 'Admin only', text: 'This needs the admin password.', back: '/admin-login?next=' + encodeURIComponent(req.get('referer') ? new URL(req.get('referer')).pathname : '/') }), 403);
}
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : '/settings');
app.get('/admin-login', (req, res) => send(res, views.layout(req, { title: 'Admin', body: views.adminLogin({ next: safeNext(req.query.next) }) })));
app.post('/admin-login', (req, res) => {
  const next = safeNext(req.body.next);
  if (auth.limited(req.ip)) return send(res, views.layout(req, { title: 'Admin', body: views.adminLogin({ next, error: 'Too many tries. Wait 10 minutes.' }) }), 429);
  if (!auth.checkAdmin(req.body.password)) { auth.recordFail(req.ip); return send(res, views.layout(req, { title: 'Admin', body: views.adminLogin({ next, error: 'Wrong admin password.' }) }), 401); }
  auth.writeSession(req, res, { ...req.session, r: 'admin' });
  res.redirect(303, next);
});

// ---- uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: cfg.UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'image/gif': '.gif', 'application/pdf': '.pdf' }[file.mimetype] || '';
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 40, fields: 200 },
  fileFilter: (req, file, cb) => cb(null, /^(file_g|file_x[a-z0-9]{1,20})$/i.test(file.fieldname) && /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/.test(file.mimetype)),
});
function withUpload(req, res, next) {
  upload.any()(req, res, (err) => {
    if (!err) return next();
    const text = err.code === 'LIMIT_FILE_SIZE' ? `A file is bigger than ${cfg.MAX_UPLOAD_MB} MB.` : 'Upload failed: ' + err.message;
    cleanup(req.files);
    send(res, views.message(req, { title: 'Upload problem', text, back: req.get('referer') || '/' }), 400);
  });
}
const cleanup = (files) => (files || []).forEach((f) => fs.rm(f.path, { force: true }, () => {}));

// ---- pages
const appToday = () => todayIn(cfg.TZ);

app.get('/', (req, res) => {
  const start = weekStart(isDate(req.query.week) ? req.query.week : appToday());
  send(res, views.week(req, { start, s: summary.build(start), today: appToday() }));
});

app.get('/list', (req, res) => {
  const f = { q: str(req.query.q, 100) || '', type: str(req.query.type, 40) || '', person: str(req.query.person, 120) || '', from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '' };
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const r = store.search({ ...f, limit: 30, offset: (page - 1) * 30 });
  send(res, views.list(req, { f, r, page, pages: Math.max(1, Math.ceil(r.total / 30)), people: store.suggestions().people.slice().sort() }));
});

function blankEntry(req) {
  const me = (req.session && req.session.n) || '';
  return { date: appToday(), tz: cfg.TZ, crew_chief: me, crew: [{ name: me, meals: [] }], expenses: [], receipts: [] };
}
app.get('/new', (req, res) => {
  let e = blankEntry(req);
  const src = req.query.from && store.get(Number(req.query.from));
  if (src) {
    e = { ...src, id: undefined, date: appToday(), expenses: [], receipts: [], notes: null, issues: null, media_taken: null, media_used: null, miles: null, tolls: null,
      crew: src.crew.map((c) => ({ name: c.name, role: c.role, on_set: c.on_set, start: c.start, stop: c.stop, wheels_up: c.wheels_up, meals: c.meals })) };
  }
  send(res, views.form(req, { e, sugg: store.suggestions(), isNew: true }));
});
app.post('/new', withUpload, (req, res) => {
  const data = store.normalise(req.body);
  if (data.errors.length) {
    cleanup(req.files);
    return send(res, views.message(req, { title: 'Missing info', text: data.errors.join('. ') + '.', back: '/new' }), 400);
  }
  const id = store.create(data, req.files, (req.session && req.session.n) || null);
  drive.enqueue(id);
  res.redirect(303, `/e/${id}?saved=1`);
});

const loadEntry = (req, res, next) => { const e = store.get(Number(req.params.id)); if (!e) return send(res, views.message(req, { title: 'Not found', text: 'That EOD does not exist (maybe it was deleted).' }), 404); req.entry = e; next(); };
app.get('/e/:id', loadEntry, (req, res) => send(res, views.detail(req, { e: req.entry, isAdmin: auth.isAdmin(req) })));
app.get('/e/:id/edit', loadEntry, (req, res) => send(res, views.form(req, { e: req.entry, sugg: store.suggestions(), isNew: false })));
app.post('/e/:id/edit', loadEntry, withUpload, (req, res) => {
  const data = store.normalise(req.body);
  if (data.errors.length) { cleanup(req.files); return send(res, views.message(req, { title: 'Missing info', text: data.errors.join('. ') + '.', back: `/e/${req.entry.id}/edit` }), 400); }
  let extra = []; try { extra = JSON.parse(req.body.delete_receipts_json || '[]'); } catch { /* ignore */ }
  const del = [].concat(req.body.delete_receipt || [], Array.isArray(extra) ? extra : []);
  store.update(req.entry.id, data, req.files, del);
  drive.enqueue(req.entry.id);
  res.redirect(303, `/e/${req.entry.id}?saved=1`);
});
app.post('/e/:id/delete', loadEntry, requireAdmin, (req, res) => { drive.onDelete(req.entry.id); store.remove(req.entry.id); res.redirect(303, '/?week=' + weekStart(req.entry.date)); });

app.get('/r/:id', (req, res) => {
  const r = store.receipt(Number(req.params.id));
  if (!r) return res.status(404).send('Not found');
  const file = path.join(cfg.UPLOAD_DIR, path.basename(r.stored));
  const inline = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(r.mime);
  res.set('Content-Type', r.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(r.original || r.stored).replace(/[^\w.\- ]+/g, '_')}"`);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).send('File missing'); });
});

// ---- summary preview + notifications
function summaryContext(req) {
  const sch = req.query.n ? mailer.getSchedule(Number(req.query.n)) : null;
  let from, to;
  if (isDate(req.query.from) && isDate(req.query.to) && req.query.from <= req.query.to) { from = req.query.from; to = req.query.to; }
  else if (sch && !req.query.week) ({ from, to } = mailer.previewPeriod(sch));
  else { from = weekStart(isDate(req.query.week) ? req.query.week : addDays(appToday(), -7)); to = addDays(from, 6); }
  return { sch, s: summary.build(from, to), title: sch ? sch.name : 'Weekly summary' };
}
app.get('/summary', (req, res) => {
  const { sch, s, title } = summaryContext(req);
  if (req.query.raw === '1') return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:12px">${summary.emailHtml(s, title)}</body>`);
  const back = typeof req.query.back === 'string' && /^\/(?!\/)[\w\/-]*$/.test(req.query.back) ? req.query.back : '';
  send(res, views.summaryPage(req, { s, sch, title, back, emailHtml: summary.emailHtml(s, title), isAdmin: auth.isAdmin(req), smtpOk: mailer.smtpConfigured() }));
});

const FREQ_KEYS = Object.keys(mailer.FREQS);
function readSchedule(body) {
  return {
    name: str(body.name, 80) || 'Summary',
    recipients: mailer.parseList(body.recipients).join(', '),
    frequency: FREQ_KEYS.includes(body.frequency) ? body.frequency : 'weekly',
    weekday: /^[0-6]$/.test(body.weekday) ? Number(body.weekday) : 1,
    send_time: H.norm(body.send_time) || '08:00',
    tz: TIMEZONES.some(([v]) => v === body.tz) ? body.tz : cfg.TZ,
    covers: body.covers === 'today' ? 'today' : 'yesterday',
    attach: body.attach === '1' ? 1 : 0,
    enabled: body.enabled === '1' ? 1 : 0,
  };
}
// Saving a schedule after today's send time must not fire an instant surprise email for today's period.
function preclaimToday(id) {
  const sch = mailer.getSchedule(id);
  const n = nowParts(sch.tz);
  if (!mailer.isSendDay(sch, n.date) || n.hhmm < sch.send_time) return;
  const p = mailer.periodFor(sch, n.date);
  db.prepare(`INSERT OR IGNORE INTO sends (schedule_id,period_from,period_to,status,detail,at) VALUES (?,?,?,'skipped','Saved after today''s send time; starts next time',?)`).run(id, p.from, p.to, new Date().toISOString());
}
function settingsPage(req, res, extra = {}, status = 200) {
  const smtp = { ok: mailer.smtpConfigured(), host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure, from: cfg.SMTP.from, user: Boolean(cfg.SMTP.user) };
  const lastBy = {};
  mailer.recentSends(500).forEach((r) => { if (!lastBy[r.schedule_id]) lastBy[r.schedule_id] = r; });
  const schedules = mailer.listSchedules().map((x) => ({ ...x, desc: mailer.describe(x), last: lastBy[x.id], preview: mailer.previewPeriod(x) }));
  send(res, views.settings(req, { smtp, schedules, log: mailer.recentSends(15), stats: dataStats(), drive: drive.status(), cal: gcal.status(), ...extra }), status);
}
app.get('/settings', requireAdmin, (req, res) => settingsPage(req, res, { msg: req.query.msg ? String(req.query.msg).slice(0, 200) : '' }));
app.get('/settings/n/new', requireAdmin, (req, res) => send(res, views.scheduleForm(req, { sch: { name: '', recipients: '', frequency: 'daily', weekday: 1, send_time: '18:00', tz: cfg.TZ, covers: 'today', attach: 0, enabled: 1 }, isNew: true })));
app.post('/settings/n/new', requireAdmin, (req, res) => {
  const x = readSchedule(req.body);
  const id = db.prepare('INSERT INTO schedules (name,recipients,frequency,weekday,send_time,tz,covers,attach,enabled,created_at) VALUES (@name,@recipients,@frequency,@weekday,@send_time,@tz,@covers,@attach,@enabled,@created_at)')
    .run({ ...x, created_at: new Date().toISOString() }).lastInsertRowid;
  preclaimToday(Number(id));
  res.redirect(303, '/settings?msg=' + encodeURIComponent(`Added "${x.name}".`));
});
const loadSch = (req, res, next) => { const x = mailer.getSchedule(Number(req.params.id)); if (!x) return send(res, views.message(req, { title: 'Not found', text: 'That notification does not exist.', back: '/settings' }), 404); req.sch = x; next(); };
app.get('/settings/n/:id', requireAdmin, loadSch, (req, res) => send(res, views.scheduleForm(req, { sch: req.sch, isNew: false })));
app.post('/settings/n/:id', requireAdmin, loadSch, (req, res) => {
  const x = readSchedule(req.body);
  db.prepare('UPDATE schedules SET name=@name,recipients=@recipients,frequency=@frequency,weekday=@weekday,send_time=@send_time,tz=@tz,covers=@covers,attach=@attach,enabled=@enabled WHERE id=@id').run({ ...x, id: req.sch.id });
  preclaimToday(req.sch.id);
  res.redirect(303, '/settings?msg=' + encodeURIComponent(`Saved "${x.name}".`));
});
app.post('/settings/n/:id/delete', requireAdmin, loadSch, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id=?').run(req.sch.id);
  res.redirect(303, '/settings?msg=' + encodeURIComponent(`Deleted "${req.sch.name}".`));
});
app.post('/settings/n/:id/send', requireAdmin, loadSch, async (req, res) => {
  const to = mailer.parseList(req.body.to);
  const period = isDate(req.body.from) && isDate(req.body.to_date) ? { from: req.body.from, to: req.body.to_date } : mailer.previewPeriod(req.sch);
  try {
    const r = await mailer.sendFor(req.sch, period, to, { test: true });
    mailer.log(req.sch.id, { from: 'test:' + new Date().toISOString(), to: period.to }, 'test', `Test (${period.from}${period.to !== period.from ? ' to ' + period.to : ''}) sent to ${r.recipients.join(', ')}`, r.summary.entries.length);
    send(res, views.message(req, { title: 'Test sent', text: `"${req.sch.name}" for ${r.summary.label} (${r.summary.entries.length} EOD${r.summary.entries.length === 1 ? '' : 's'}) sent to ${r.recipients.join(', ')}.${r.summary.entries.length ? '' : ' There were no EODs, so a scheduled send for this period would have been skipped.'}`, back: '/settings' }));
  } catch (err) {
    send(res, views.message(req, { title: 'Could not send', text: err.message, back: '/settings' }), 500);
  }
});

// ---- danger zone: clear all data
const BACKUP_DIR = path.join(cfg.DATA_DIR, 'backups');
function dataStats() {
  let uploadBytes = 0, files = [];
  try { files = fs.readdirSync(cfg.UPLOAD_DIR); } catch { /* none */ }
  files.forEach((f) => { try { const st = fs.statSync(path.join(cfg.UPLOAD_DIR, f)); if (st.isFile()) uploadBytes += st.size; } catch { /* gone */ } });
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { entries: n('entries'), receipts: n('receipts'), schedules: n('schedules'), uploadBytes };
}
// Same-origin check for the destructive POST (on top of SameSite=Lax cookies and form-action 'self').
function sameOrigin(req) {
  const o = req.get('origin') || req.get('referer');
  if (!o) return true; // non-browser clients; they still need the session + DELETE + admin password
  try { return new URL(o).host === req.get('host'); } catch { return false; }
}
async function backupDb() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').replace('Z', '');
  const file = path.join(BACKUP_DIR, `eod-${stamp}-before-clear.sqlite`);
  await db.backup(file);
  fs.chmodSync(file, 0o600);
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^eod-.*\.sqlite$/.test(f)).sort();
  old.slice(0, Math.max(0, old.length - 3)).forEach((f) => fs.rmSync(path.join(BACKUP_DIR, f), { force: true }));
  return file;
}
const clearPage = (req, res, extra = {}, status = 200) => send(res, views.clearPage(req, { stats: dataStats(), needPw: auth.adminConfigured(), ...extra }), status);
app.get('/settings/clear', requireAdmin, (req, res) => clearPage(req, res));
app.post('/settings/clear', requireAdmin, async (req, res) => {
  const scope = req.body.scope === 'all' ? 'all' : 'entries';
  if (!sameOrigin(req)) return clearPage(req, res, { scope, error: 'Blocked: this request did not come from this site.' }, 403);
  if (String(req.body.confirm || '').trim() !== 'DELETE') return clearPage(req, res, { scope, error: 'Nothing was deleted. Type DELETE (in capitals) to confirm.' }, 400);
  if (auth.adminConfigured()) {
    if (auth.limited(req.ip)) return clearPage(req, res, { scope, error: 'Too many tries. Wait 10 minutes.' }, 429);
    if (!auth.checkAdmin(req.body.password)) { auth.recordFail(req.ip); return clearPage(req, res, { scope, error: 'Nothing was deleted. Wrong admin password.' }, 401); }
  }
  const before = dataStats();
  let backup;
  try { backup = await backupDb(); } catch (err) {
    console.error('[eod-log] backup before clear failed', err);
    return clearPage(req, res, { scope, error: 'Nothing was deleted: could not write the backup to /data/backups (' + err.message + ').' }, 500);
  }
  db.transaction(() => {
    db.exec('DELETE FROM receipts; DELETE FROM expenses; DELETE FROM crew; DELETE FROM entries;');
    if (scope === 'all') db.exec("DELETE FROM sends; DELETE FROM schedules; DELETE FROM settings WHERE substr(key,1,3) <> 'gd_';"); // Google Drive connection is kept
    drive.forgetEntries(); // entry ids restart, so forget the id -> Drive file mapping (files in Drive are NOT deleted)
  })();
  let files = [];
  try { files = fs.readdirSync(cfg.UPLOAD_DIR); } catch { /* none */ }
  files.forEach((f) => fs.rmSync(path.join(cfg.UPLOAD_DIR, f), { force: true, recursive: true }));
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  console.log(`[eod-log] data cleared (${scope}) by ${(req.session && req.session.n) || 'admin'}: ${before.entries} entries, ${before.receipts} receipts; backup ${backup}`);
  const msg = `Cleared ${before.entries} EOD${before.entries === 1 ? '' : 's'} and ${before.receipts} receipt${before.receipts === 1 ? '' : 's'}${scope === 'all' ? ', plus notifications and settings' : ''}. A database backup was saved as backups/${path.basename(backup)}.`;
  res.redirect(303, '/settings?msg=' + encodeURIComponent(msg));
});

// ---- Google Drive
const parseFolderId = (v) => { const s = String(v || '').trim(); const m = /folders\/([\w-]{10,})/.exec(s) || /[?&]id=([\w-]{10,})/.exec(s); return m ? m[1] : (/^[\w-]{10,}$/.test(s) ? s : ''); };
const drivePage = (req, res, extra = {}, status = 200) => send(res, views.drivePage(req, { st: drive.status(), dev: drive.deviceState(), cal: gcal.status(), ...extra }), status);
const driveBack = (res, msg, isErr) => res.redirect(303, '/settings/drive?' + (isErr ? 'err=' : 'msg=') + encodeURIComponent(String(msg).slice(0, 300)));
app.get('/settings/drive', requireAdmin, (req, res) => drivePage(req, res, { msg: str(req.query.msg, 300) || '', err: str(req.query.err, 300) || '' }));
app.get('/settings/drive/status.json', requireAdmin, (req, res) => { const st = drive.status(); res.json({ dev: drive.deviceState(), connected: st.connected, pending: st.pending, synced: st.synced }); });
app.post('/settings/drive/save', requireAdmin, async (req, res) => {
  const b = req.body;
  const m = b.mode === 'sa' ? 'sa' : 'oauth';
  const prevMode = drive.S.get('mode') || 'oauth';
  drive.S.set('mode', m);
  if (m !== prevMode) { drive.resetToken(); drive.resetMapping(); }
  if (b.client_id !== undefined && str(b.client_id, 300)) drive.S.set('client_id', str(b.client_id, 300));
  if (str(b.client_secret, 300)) drive.S.set('client_secret', str(b.client_secret, 300));
  if (str(b.sa_json, 20000)) {
    let k; try { k = JSON.parse(b.sa_json); } catch { return driveBack(res, 'That service account key is not valid JSON. Paste the whole downloaded .json file.', true); }
    if (!k.client_email || !k.private_key) return driveBack(res, 'That JSON has no client_email/private_key. Use a service account key file.', true);
    drive.S.set('sa_json', JSON.stringify({ type: k.type, client_email: k.client_email, private_key: k.private_key, private_key_id: k.private_key_id, token_uri: k.token_uri }));
    drive.resetToken();
  }
  if (b.shared_folder !== undefined) {
    const fid = parseFolderId(b.shared_folder);
    if (b.shared_folder.trim() && !fid) return driveBack(res, 'Could not find a folder ID in that link.', true);
    if (fid !== (drive.S.get('shared_folder_id') || '')) { drive.S.set('shared_folder_id', fid); if (m === 'sa') drive.resetMapping(); }
  }
  if (b.client_type === 'tv' || b.client_type === 'desktop') drive.S.set('client_type', b.client_type);
  const rn = str(b.root_name, 100); if (rn) drive.S.set('root_name', rn);
  drive.S.set('on_delete', b.on_delete === 'trash' ? 'trash' : 'mark');
  drive.S.set('auto', b.auto === '1' ? '1' : '0');
  const emails = mailer.parseList(b.share);
  const role = b.share_role === 'writer' ? 'writer' : 'reader';
  let warn = '';
  if (drive.connected()) {
    try { const errs = await drive.applySharing(emails, role); if (errs.length) warn = ' Sharing problem: ' + errs.join('; '); } catch (err) { warn = ' Could not update sharing: ' + err.message; }
  } else if (emails.length) { drive.S.set('share_pending', emails.join(', ')); drive.S.set('share_role', role); warn = ' Sharing will be applied after you connect.'; }
  driveBack(res, 'Saved.' + warn, Boolean(warn && !/after you connect/.test(warn)));
});
app.post('/settings/drive/connect', requireAdmin, async (req, res) => {
  try {
    if (drive.clientType() === 'desktop') drive.startLink(); else await drive.startDevice();
    res.redirect(303, '/settings/drive#connect');
  } catch (err) { driveBack(res, 'Could not start the Google sign-in: ' + err.message, true); }
});
app.post('/settings/drive/connect-link/finish', requireAdmin, async (req, res) => {
  try { await drive.finishLink(req.body.pasted); driveBack(res, gcal.needsReconnect() ? 'Connected to Google, but Calendar was not allowed. Reconnect and tick the Calendar box.' : 'Connected to Google Drive' + (drive.calendarScopeOk() ? ' and Calendar.' : '.'), gcal.needsReconnect()); } catch (err) { res.redirect(303, '/settings/drive?err=' + encodeURIComponent(String(err.message).slice(0, 300)) + '#connect'); }
});
app.post('/settings/drive/cancel', requireAdmin, (req, res) => { drive.cancelDevice(); drive.cancelLink(); res.redirect(303, '/settings/drive'); });
app.post('/settings/drive/test', requireAdmin, async (req, res) => {
  try { await drive.test(); driveBack(res, 'Test passed: the folder is reachable and a test file was written (and then removed).'); } catch (err) { driveBack(res, 'Test failed: ' + err.message, true); }
});
app.post('/settings/drive/sync-all', requireAdmin, (req, res) => {
  if (!drive.connected()) return driveBack(res, 'Connect Google Drive first.', true);
  const n = drive.enqueueAll(); driveBack(res, `Queued ${n} EOD${n === 1 ? '' : 's'} for upload. This page shows progress.`);
});
app.post('/settings/drive/disconnect', requireAdmin, async (req, res) => {
  if ((drive.S.get('mode') || 'oauth') === 'sa') { drive.S.del('sa_json'); drive.resetToken(); } else await drive.disconnect();
  driveBack(res, 'Disconnected. Files already in Google Drive are untouched.');
});

// ---- Google Calendar (same connection as Drive)
const calPage = (req, res, extra = {}, status = 200) => send(res, views.calendarPage(req, { cal: gcal.status(), ...extra }), status);
const calBack = (res, msg, isErr) => res.redirect(303, '/settings/calendar?' + (isErr ? 'err=' : 'msg=') + encodeURIComponent(String(msg).slice(0, 300)));
const parseCalId = (v) => { const s = String(v || '').trim(); const m = /[?&]src=([^&]+)/.exec(s); return (m ? decodeURIComponent(m[1]) : s).replace(/\s+/g, ''); };
app.get('/settings/calendar', requireAdmin, (req, res) => calPage(req, res, { msg: str(req.query.msg, 300) || '', err: str(req.query.err, 300) || '' }));
app.post('/settings/calendar/save', requireAdmin, (req, res) => {
  const b = req.body;
  const wasOn = gcal.S.get('cal_on') === '1';
  const before = [gcal.calMode(), gcal.S.get('cal_paste_id') || ''].join('|');
  const on = b.cal_on === '1';
  if (on && !drive.connected()) return calBack(res, 'Calendar events need the EOD PDF in Google Drive. Connect Google Drive first (Settings > Google Drive).', true);
  if (b.cal_mode === 'auto' || b.cal_mode === 'paste') gcal.S.set('cal_mode', b.cal_mode);
  const nm = str(b.cal_name, 100); if (nm) gcal.S.set('cal_name', nm);
  if (b.cal_paste_id !== undefined) gcal.S.set('cal_paste_id', parseCalId(b.cal_paste_id));
  if (on && gcal.calMode() === 'paste' && !gcal.S.get('cal_paste_id')) return calBack(res, 'Paste the ID of the calendar to use (Google Calendar > the calendar > Settings and sharing > Integrate calendar > Calendar ID).', true);
  gcal.S.set('cal_on', on ? '1' : '0');
  const after = [gcal.calMode(), gcal.S.get('cal_paste_id') || ''].join('|');
  const n = gcal.settingsChanged({ calendarSwitched: on && (!wasOn || before !== after) });
  const warn = on && gcal.needsReconnect() ? ' Calendar is on, but this Google sign-in does not include Calendar yet: reconnect (Settings > Google Drive).' : '';
  calBack(res, (on ? 'Saved. Calendar is on.' : 'Saved. Calendar is off.') + (n ? ` Adding ${n} EOD${n === 1 ? '' : 's'} to the calendar in the background.` : '') + warn, Boolean(warn));
});
app.post('/settings/calendar/test', requireAdmin, async (req, res) => {
  try { const r = await gcal.test(); calBack(res, `Test passed: calendar “${r.name}” is reachable and a test event was created and removed.`); } catch (err) { calBack(res, 'Test failed: ' + err.message, true); }
});
app.post('/settings/calendar/sync-all', requireAdmin, (req, res) => {
  if (!gcal.wanted()) return calBack(res, 'Turn Google Calendar on first.', true);
  if (!drive.connected()) return calBack(res, 'Connect Google Drive first.', true);
  if (gcal.needsReconnect()) return calBack(res, 'Reconnect to enable Calendar first (Settings > Google Drive).', true);
  const n = gcal.enqueueAll(); calBack(res, `Queued ${n} EOD${n === 1 ? '' : 's'} for the calendar. This page shows progress.`);
});

// ---- CSV export
const csvCell = (v) => { if (v === null || v === undefined) return ''; let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
function exportRange(req) { return { from: isDate(req.query.from) ? req.query.from : '0000-01-01', to: isDate(req.query.to) ? req.query.to : '9999-12-31' }; }
function exportEntries(req) {
  const { from, to } = exportRange(req);
  const f = { q: str(req.query.q, 100), type: str(req.query.type, 40), person: str(req.query.person, 120), from, to };
  return store.search({ ...f, limit: 100000, offset: 0 }).entries.reverse();
}
app.get('/export/hours.csv', (req, res) => {
  const rows = [['date', 'job', 'job_type', 'client', 'location', 'time_zone', 'crew_chief', 'name', 'role', 'start', 'stop', 'meals', 'on_set_start', 'on_set_end', 'total_hours', 'on_set_hours', 'meal_hours', 'hours_typed_in', 'edit_dit_hours', 'entry_url']];
  exportEntries(req).forEach((e) => e.crew.forEach((c) => rows.push([e.date, e.job, e.job_type, e.client, e.location, e.tz, e.crew_chief, c.name, c.role, c.start, c.stop,
    (c.meals || []).map((m) => `${m.start || '?'}-${m.end || '?'}`).join(' '), c.on_set, c.wheels_up, H.dec(c.paid_min), H.dec(c.onsite_min), H.dec(c.meal_min), c.hours_override, c.edit_hours, `${cfg.PUBLIC_URL}/e/${e.id}`])));
  res.type('text/csv').attachment('eod-hours.csv').send(csv(rows));
});
app.get('/export/expenses.csv', (req, res) => {
  const rows = [['date', 'job', 'person', 'description', 'category', 'amount', 'paid_by', 'receipts', 'entry_url']];
  exportEntries(req).forEach((e) => e.expenses.forEach((x) => rows.push([e.date, e.job, x.person, x.description, x.category, x.amount, x.paid_by === 'personal' ? 'personal (reimburse)' : 'company card',
    e.receipts.filter((r) => r.expense_id === x.id).length, `${cfg.PUBLIC_URL}/e/${e.id}`])));
  res.type('text/csv').attachment('eod-expenses.csv').send(csv(rows));
});

app.use((req, res) => send(res, views.message(req, { title: 'Not found', text: 'That page does not exist.' }), 404));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  cleanup(req.files);
  send(res, views.message(req, { title: 'Something went wrong', text: 'The server hit an error. Try again; if it keeps happening, check the container logs.' }), 500);
});

if (auth.passwordRequired() && !cfg.APP_PASSWORD) console.warn('[eod-log] WARNING: APP_PASSWORD is not set. Nobody can sign in until you set it.');
if (!cfg.ADMIN_PASSWORD) console.warn('[eod-log] ADMIN_PASSWORD not set: everyone signed in can change settings and delete entries.');
mailer.startScheduler();
drive.start();
app.listen(cfg.PORT, '0.0.0.0', () => console.log(`[eod-log] listening on :${cfg.PORT}, data in ${cfg.DATA_DIR}`));
