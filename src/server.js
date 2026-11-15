const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cfg = require('./config');
const { getSetting, setSetting, db } = require('./db');
const store = require('./store');
const auth = require('./auth');
const views = require('./views');
const summary = require('./summary');
const mailer = require('./mailer');
const { isDate, weekStart, todayIn, addDays, str, timeStr, TIMEZONES } = require('./util');

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
  return { date: appToday(), tz: cfg.TZ, crew_chief: me, crew: [{ name: me, meals: [{}] }], expenses: [], receipts: [] };
}
app.get('/new', (req, res) => {
  let e = blankEntry(req);
  const src = req.query.from && store.get(Number(req.query.from));
  if (src) {
    e = { ...src, id: undefined, date: appToday(), expenses: [], receipts: [], notes: null, issues: null, media_taken: null, media_used: null, miles: null, tolls: null,
      crew: src.crew.map((c) => ({ name: c.name, role: c.role, leave_shop: c.leave_shop, on_set: c.on_set, start: c.start, wrap: c.wrap, wheels_up: c.wheels_up, return_shop: c.return_shop, meals: c.meals })) };
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
  res.redirect(303, `/e/${req.entry.id}?saved=1`);
});
app.post('/e/:id/delete', loadEntry, requireAdmin, (req, res) => { store.remove(req.entry.id); res.redirect(303, '/?week=' + weekStart(req.entry.date)); });

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

// ---- summary
app.get('/summary', (req, res) => {
  const start = weekStart(isDate(req.query.week) ? req.query.week : addDays(appToday(), -7));
  const s = summary.build(start);
  if (req.query.raw === '1') return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:12px">${summary.emailHtml(s)}</body>`);
  send(res, views.summaryPage(req, { s, emailHtml: summary.emailHtml(s), isAdmin: auth.isAdmin(req), smtpOk: mailer.smtpConfigured() }));
});
app.post('/summary/send', requireAdmin, async (req, res) => {
  const week = weekStart(isDate(req.body.week) ? req.body.week : addDays(appToday(), -7));
  const to = mailer.parseList(req.body.to);
  try {
    const r = await mailer.sendSummary(week, to, { test: to.length > 0 });
    setSetting('summary_last_result', `${to.length ? 'Test' : 'Manual'} send ${new Date().toLocaleString('en-US', { timeZone: getSetting('summary_tz') || cfg.TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} to ${r.recipients.join(', ')} (week of ${week})`);
    send(res, views.message(req, { title: 'Sent', text: `Summary for ${r.summary.label} sent to ${r.recipients.join(', ')}.`, back: '/settings' }));
  } catch (err) {
    send(res, views.message(req, { title: 'Could not send', text: err.message, back: '/settings' }), 500);
  }
});

// ---- settings
const SETTING_KEYS = ['manager_emails', 'summary_enabled', 'summary_day', 'summary_time', 'summary_tz', 'summary_attach', 'summary_last_result'];
function settingsPage(req, res, extra = {}) {
  const st = Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(k)]));
  const smtp = { ok: mailer.smtpConfigured(), host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure, from: cfg.SMTP.from, user: Boolean(cfg.SMTP.user) };
  send(res, views.settings(req, { st, smtp, lastWeek: addDays(weekStart(appToday()), -7), ...extra }));
}
app.get('/settings', requireAdmin, (req, res) => settingsPage(req, res));
app.post('/settings', requireAdmin, (req, res) => {
  const emails = mailer.parseList(req.body.manager_emails);
  setSetting('manager_emails', emails.join(', '));
  setSetting('summary_enabled', req.body.summary_enabled === '1' ? '1' : '0');
  setSetting('summary_day', /^[0-6]$/.test(req.body.summary_day) ? req.body.summary_day : '1');
  setSetting('summary_time', timeStr(req.body.summary_time) || '08:00');
  setSetting('summary_tz', TIMEZONES.some(([v]) => v === req.body.summary_tz) ? req.body.summary_tz : cfg.TZ);
  setSetting('summary_attach', req.body.summary_attach === '1' ? '1' : '0');
  settingsPage(req, res, { msg: `Saved. ${emails.length} manager address${emails.length === 1 ? '' : 'es'}.` });
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
const H = require('../public/hours.js');
app.get('/export/hours.csv', (req, res) => {
  const rows = [['date', 'job', 'job_type', 'client', 'location', 'time_zone', 'crew_chief', 'name', 'role', 'leave_shop', 'on_set', 'start', 'meals', 'wrap', 'wheels_up', 'return_shop', 'hours', 'work_hours_start_to_wrap', 'meal_hours', 'hours_typed_in', 'edit_dit_hours', 'entry_url']];
  exportEntries(req).forEach((e) => e.crew.forEach((c) => rows.push([e.date, e.job, e.job_type, e.client, e.location, e.tz, e.crew_chief, c.name, c.role, c.leave_shop, c.on_set, c.start,
    (c.meals || []).map((m) => `${m.start || '?'}-${m.end || '?'}`).join(' '), c.wrap, c.wheels_up, c.return_shop, H.dec(c.paid_min), H.dec(c.work_min), H.dec(c.meal_min), c.hours_override, c.edit_hours, `${cfg.PUBLIC_URL}/e/${e.id}`])));
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
app.listen(cfg.PORT, '0.0.0.0', () => console.log(`[eod-log] listening on :${cfg.PORT}, data in ${cfg.DATA_DIR}`));
