// Google Drive sync: every EOD job gets its own folder holding the EOD PDF and that job's receipts.
//   <Root>/<YYYY>/<MM> <Month>/<YYYY-MM-DD>/<Job> (<Type>)/EOD <date> <job>.pdf + receipts
// (year folder > month folder > day folder > one folder per job). Google Calendar events live in ./gcal.js and use the same connection.
// Two ways to connect:
//   oauth: a Google account via the OAuth device flow (scope drive.file: the app only sees what it creates). Files use that account's storage.
//   sa:    a service account key + a folder in a Shared Drive (service accounts have no storage of their own, so My Drive won't work).
// Plain fetch against Drive REST v3, a retry queue in SQLite, and nothing here ever blocks saving an EOD.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
const { entryPdf } = require('./drivepdf');

const env = process.env;
const API = (env.GDRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, ''); // override only for tests (mock server)
const OAUTH = (env.GDRIVE_OAUTH_BASE || 'https://oauth2.googleapis.com').replace(/\/+$/, '');
const TICK_MS = Number(env.GDRIVE_TICK_MS || 20000);
const RETRY_BASE_S = Number(env.GDRIVE_RETRY_BASE_SEC || 30);
const MAX_ATTEMPTS = 12; // ~ a day of backoff, then it stays "failed" until Sync all / next edit
const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE_USER = 'https://www.googleapis.com/auth/drive.file';
const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar';
const SCOPE_SA = 'https://www.googleapis.com/auth/drive ' + SCOPE_CAL; // a service account's scopes are just a request (no consent screen); Calendar only works once a calendar is shared with it
const AUTH_URL = (env.GDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth');
const LOOPBACK = 'http://127.0.0.1:9004'; // desktop-app clients may redirect to any loopback port; nothing listens here, the person copies the address bar instead
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- settings (secrets live in the DB on the /data volume or in env; never logged, never rendered back)
const S = {
  get: (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get('gd_' + k); return r ? r.value : null; },
  set: (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('gd_' + k, v == null ? null : String(v)),
  del: (k) => db.prepare('DELETE FROM settings WHERE key=?').run('gd_' + k),
};
const clientId = () => env.GDRIVE_CLIENT_ID || S.get('client_id') || '';
const clientSecret = () => env.GDRIVE_CLIENT_SECRET || S.get('client_secret') || '';
const mode = () => S.get('mode') || 'oauth';
/** 'desktop' = Desktop-app client + "paste the address" sign-in (Drive + Calendar). 'tv' = TVs and Limited Input client + device code (Drive only: Google does not allow Calendar scopes there). */
const clientType = () => (env.GDRIVE_CLIENT_TYPE === 'tv' || env.GDRIVE_CLIENT_TYPE === 'desktop' ? env.GDRIVE_CLIENT_TYPE : S.get('client_type') || (clientId() ? 'tv' : 'desktop'));
/** Does the saved sign-in include Calendar? (A service account always "has" it; the calendar must then be shared with it.) */
function calendarScopeOk() { return mode() === 'sa' ? true : / ?https:\/\/www\.googleapis\.com\/auth\/calendar( |$)/.test(S.get('scope') || ''); }
function saKey() {
  let raw = S.get('sa_json');
  if (!raw && env.GDRIVE_SA_FILE) { try { raw = fs.readFileSync(env.GDRIVE_SA_FILE, 'utf8'); } catch { /* missing */ } }
  if (!raw) return null;
  try { const k = JSON.parse(raw); return k.client_email && k.private_key ? k : null; } catch { return null; }
}
function connected() {
  if (mode() === 'sa') return Boolean(saKey() && S.get('shared_folder_id'));
  return Boolean(S.get('refresh_token') && clientId());
}
const enabled = () => connected() && S.get('auto') !== '0';

// ---------- naming
const MAXNAME = 120;
function safeName(s, max = MAXNAME) {
  let n = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\/\\]/g, '-').replace(/\s+/g, ' ').trim();
  if (n.length > max) n = n.slice(0, max - 1).trim() + '…';
  return n || 'Untitled';
}
const money = (n) => '$' + Number(n).toFixed(2);
function yearName(date) { return date.slice(0, 4); }
function monthName(date) { return `${date.slice(5, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1]}`; }
const dayName = (date) => date;
/** The job's own folder inside the day folder: "Job name (Type)". The date is already in the day folder above it. */
function folderName(e) { return safeName(`${e.job}${e.job_type ? ` (${e.job_type})` : ''}`); }
/** Two EODs for the same job and day (e.g. two crews) must not share a folder: the later one gets " #2", " #3"... */
function jobFolderName(e) {
  const base = folderName(e);
  const earlier = db.prepare('SELECT job, job_type FROM entries WHERE date=? AND id<? ORDER BY id').all(e.date, e.id).filter((o) => folderName(o) === base).length;
  return earlier ? safeName(`${base} #${earlier + 1}`) : base;
}
function pdfName(e) { return safeName(`EOD ${e.date} ${e.job}`, 150) + '.pdf'; }
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif', 'image/gif': '.gif', 'application/pdf': '.pdf' };
/** Receipt file names: "<date> <job> - <expense> - $12.34 (Card|Personal) 1.jpg"; numbered per expense. */
function receiptNames(e) {
  const out = {};
  const byExp = new Map();
  e.receipts.forEach((r) => { const k = r.expense_id || 0; if (!byExp.has(k)) byExp.set(k, []); byExp.get(k).push(r); });
  byExp.forEach((list, expId) => {
    const x = expId ? e.expenses.find((y) => y.id === expId) : null;
    list.forEach((r, i) => {
      const ext = EXT[r.mime] || path.extname(r.original || r.stored || '').toLowerCase() || '';
      let label;
      if (x) {
        const bits = [x.description || x.category || 'Expense'];
        if (x.amount != null) bits.push(`${money(x.amount)} (${x.paid_by === 'personal' ? 'Personal' : 'Card'})`);
        label = bits.join(' - ');
      } else label = 'Receipt';
      out[r.stored] = safeName(`${e.date} ${e.job} - ${label}${list.length > 1 || !x ? ' ' + (i + 1) : ''}`, 150) + ext;
    });
  });
  return out;
}

// ---------- HTTP
class DriveError extends Error {
  constructor(msg, status, reason) { super(msg); this.status = status; this.reason = reason; }
}
async function readErr(r) {
  let body = ''; try { body = await r.text(); } catch { /* none */ }
  let msg = body.slice(0, 300), reason = '';
  try { const j = JSON.parse(body); if (j.error && typeof j.error === 'object') { msg = j.error.message || msg; reason = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.status || ''; } else if (j.error) { reason = j.error; msg = j.error_description || j.error; } } catch { /* not json */ }
  return new DriveError(`${r.status} ${msg}`.trim(), r.status, reason);
}
async function form(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw await readErr(r);
  return r.json();
}

let tok = { access: '', exp: 0 };
function b64u(x) { return Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url'); }
async function accessToken() {
  if (tok.access && Date.now() < tok.exp - 60000) return tok.access;
  let j;
  if (mode() === 'sa') {
    const k = saKey(); if (!k) throw new DriveError('No service account key saved', 0, 'not_configured');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: k.client_email, scope: SCOPE_SA, aud: OAUTH + '/token', iat: now, exp: now + 3600 })}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key).toString('base64url');
    j = await form(OAUTH + '/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` });
  } else {
    const rt = S.get('refresh_token'); if (!rt) throw new DriveError('Not connected', 0, 'not_configured');
    try { j = await form(OAUTH + '/token', { client_id: clientId(), client_secret: clientSecret(), refresh_token: rt, grant_type: 'refresh_token' }); } catch (err) {
      if (err.reason === 'invalid_grant') { S.set('auth_error', 'Google refused the saved sign-in (revoked or expired). Click Connect again.'); err.reason = 'auth'; }
      throw err;
    }
  }
  S.del('auth_error');
  tok = { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.access;
}
const resetToken = () => { tok = { access: '', exp: 0 }; };

async function api(method, url, { json, body, headers = {}, raw = false } = {}) {
  for (let pass = 0; pass < 2; pass++) {
    const r = await fetch(url.startsWith('http') ? url : API + url, {
      method, headers: { authorization: 'Bearer ' + (await accessToken()), ...(json ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(120000),
    });
    if (r.status === 401 && pass === 0) { resetToken(); continue; }
    if (!r.ok) throw await readErr(r);
    if (raw) return r;
    return r.status === 204 ? {} : r.json();
  }
}
const Q = 'supportsAllDrives=true';
const FIELDS = 'fields=id,name,parents,trashed,webViewLink';
async function getFile(id) {
  try { return await api('GET', `/drive/v3/files/${encodeURIComponent(id)}?${Q}&${FIELDS}`); } catch (err) { if (err.status === 404) return null; throw err; }
}
async function createFolder(name, parent) {
  return api('POST', `/drive/v3/files?${Q}&${FIELDS}`, { json: { name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) } });
}
async function patchMeta(id, meta, { add, remove } = {}) {
  const qs = [Q, FIELDS]; if (add) qs.push('addParents=' + encodeURIComponent(add)); if (remove) qs.push('removeParents=' + encodeURIComponent(remove));
  return api('PATCH', `/drive/v3/files/${encodeURIComponent(id)}?${qs.join('&')}`, { json: meta });
}
const SIMPLE_MAX = 5 * 1024 * 1024; // multipart up to 5 MB, resumable above (Drive's limits)
/** Upload bytes as a new file (parents set in the FIRST request: required for Shared Drives) or replace an existing file's content. */
async function upload({ id, name, parent, mime, data }) {
  const meta = id ? { name } : { name, parents: [parent] };
  const base = id ? `/upload/drive/v3/files/${encodeURIComponent(id)}` : '/upload/drive/v3/files';
  const method = id ? 'PATCH' : 'POST';
  if (data.length <= SIMPLE_MAX) {
    const b = 'eodlog' + crypto.randomBytes(12).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`),
      data, Buffer.from(`\r\n--${b}--\r\n`)]);
    return api(method, `${base}?uploadType=multipart&${Q}&${FIELDS}`, { body, headers: { 'content-type': `multipart/related; boundary=${b}` } });
  }
  const start = await api(method, `${base}?uploadType=resumable&${Q}`, { json: meta, headers: { 'x-upload-content-type': mime, 'x-upload-content-length': String(data.length) }, raw: true });
  const loc = start.headers.get('location');
  if (!loc) throw new DriveError('No upload URL from Drive', 500);
  return api('PUT', loc, { body: data, headers: { 'content-type': mime } });
}
async function trash(id) { try { await patchMeta(id, { trashed: true }); } catch (err) { if (err.status !== 404) throw err; } }

// ---------- folders
async function rootId() {
  if (mode() === 'sa') return S.get('shared_folder_id');
  const saved = S.get('root_id');
  if (saved) {
    const f = await getFile(saved);
    if (f && !f.trashed) { if (f.name !== rootName()) await patchMeta(saved, { name: rootName() }); return saved; }
    resetMapping({ requeue: true }); // folder gone (deleted in Drive): start a fresh tree and upload everything again
  }
  const f = await createFolder(rootName(), null);
  S.set('root_id', f.id);
  return f.id;
}
const rootName = () => safeName(S.get('root_name') || cfg.APP_NAME || 'EOD Log');
let rootChecked = 0;
async function root() {
  // check the root at most every 10 minutes (one GET), not on every file
  const id = mode() === 'sa' ? S.get('shared_folder_id') : S.get('root_id');
  if (id && Date.now() - rootChecked < 600000) return id;
  const r = await rootId(); rootChecked = Date.now(); return r;
}
const folderChecked = new Map();
async function folderFor(key, name, parent) {
  const row = db.prepare('SELECT file_id, name FROM drive_folders WHERE key=?').get(key);
  if (row) {
    if (row.name !== name) { // naming scheme changed (older versions called months "2026-11 November"): rename the folder, don't make a second one
      try { await patchMeta(row.file_id, { name }); db.prepare('UPDATE drive_folders SET name=? WHERE key=?').run(name, key); folderChecked.set(key, Date.now()); return row.file_id; } catch (err) { if (err.status !== 404) throw err; db.prepare('DELETE FROM drive_folders WHERE key=?').run(key); row.gone = true; }
    }
    if (!row.gone) {
      // someone may have deleted the folder in Drive: re-check now and then
      if (Date.now() - (folderChecked.get(key) || 0) < 600000) return row.file_id;
      const f = await getFile(row.file_id);
      if (f && !f.trashed) { folderChecked.set(key, Date.now()); return row.file_id; }
      db.prepare('DELETE FROM drive_folders WHERE key=?').run(key);
    }
  }
  const f = await createFolder(name, parent);
  db.prepare('INSERT OR REPLACE INTO drive_folders (key,file_id,name) VALUES (?,?,?)').run(key, f.id, name);
  folderChecked.set(key, Date.now());
  return f.id;
}
/** root > 2026 > 11 November > 2026-11-13 ; returns the day folder's id */
async function dayFolder(date) {
  const r = await root();
  const y = await folderFor(`y:${yearName(date)}`, yearName(date), r);
  const m = await folderFor(`m:${date.slice(0, 7)}`, monthName(date), y);
  return folderFor(`d:${date}`, dayName(date), m);
}

// ---------- sync one entry
async function syncEntry(e) {
  let de = db.prepare('SELECT * FROM drive_entries WHERE entry_id=?').get(e.id);
  const parent = await dayFolder(e.date);
  const fname = jobFolderName(e);
  if (de && de.folder_id) {
    const f = await getFile(de.folder_id);
    if (!f || f.trashed) { db.prepare('DELETE FROM drive_files WHERE entry_id=?').run(e.id); db.prepare('UPDATE drive_entries SET folder_id=NULL, pdf_id=NULL WHERE id=?').run(de.id); de = { ...de, folder_id: null, pdf_id: null }; }
  }
  if (!de || !de.folder_id) {
    const f = await createFolder(fname, parent);
    db.prepare(`INSERT INTO drive_entries (entry_id,folder_id,folder_name,parent_id) VALUES (?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET folder_id=excluded.folder_id, folder_name=excluded.folder_name, parent_id=excluded.parent_id, pdf_id=NULL`).run(e.id, f.id, fname, parent);
    de = db.prepare('SELECT * FROM drive_entries WHERE entry_id=?').get(e.id);
  } else if (de.folder_name !== fname || de.parent_id !== parent) {
    await patchMeta(de.folder_id, { name: fname }, de.parent_id !== parent ? { add: parent, remove: de.parent_id } : {});
    db.prepare('UPDATE drive_entries SET folder_name=?, parent_id=? WHERE id=?').run(fname, parent, de.id);
  }
  // the PDF: replace content in place (same file id, Drive keeps versions)
  const pdf = await entryPdf(e);
  let pdfId = de.pdf_id;
  if (pdfId) { try { await upload({ id: pdfId, name: pdfName(e), mime: 'application/pdf', data: pdf }); } catch (err) { if (err.status !== 404) throw err; pdfId = null; } }
  if (!pdfId) { pdfId = (await upload({ name: pdfName(e), parent: de.folder_id, mime: 'application/pdf', data: pdf })).id; db.prepare('UPDATE drive_entries SET pdf_id=? WHERE id=?').run(pdfId, de.id); }
  // receipts: upload new, rename changed, trash removed
  const names = receiptNames(e);
  const have = new Map(db.prepare('SELECT * FROM drive_files WHERE entry_id=?').all(e.id).map((r) => [r.stored, r]));
  for (const r of e.receipts) {
    const name = names[r.stored]; const cur = have.get(r.stored); have.delete(r.stored);
    if (cur) {
      if (cur.name !== name) {
        try { await patchMeta(cur.file_id, { name }); db.prepare('UPDATE drive_files SET name=? WHERE stored=?').run(name, r.stored); continue; } catch (err) { if (err.status !== 404) throw err; }
      } else continue;
    }
    let data; try { data = fs.readFileSync(path.join(cfg.UPLOAD_DIR, path.basename(r.stored))); } catch { continue; } // file missing on disk: nothing to send
    const f = await upload({ name, parent: de.folder_id, mime: r.mime || 'application/octet-stream', data });
    db.prepare('INSERT OR REPLACE INTO drive_files (stored,entry_id,file_id,name) VALUES (?,?,?,?)').run(r.stored, e.id, f.id, name);
  }
  for (const [stored, gone] of have) { await trash(gone.file_id); db.prepare('DELETE FROM drive_files WHERE stored=?').run(stored); }
  db.prepare('UPDATE drive_entries SET synced_at=? WHERE id=?').run(new Date().toISOString(), de.id);
}

async function syncDeleted(de) {
  if (de.folder_id) {
    if (S.get('on_delete') === 'trash') await trash(de.folder_id);
    else { try { await patchMeta(de.folder_id, { name: safeName('(deleted) ' + (de.folder_name || '')) }); } catch (err) { if (err.status !== 404) throw err; } }
  }
  db.prepare('DELETE FROM drive_entries WHERE id=?').run(de.id);
}

// ---------- queue
const backoff = (attempts) => Math.min(RETRY_BASE_S * 2 ** (attempts - 1), 6 * 3600) * 1000;
function enqueue(entryId) {
  if (!enabled()) return;
  db.prepare(`INSERT INTO drive_queue (entry_id,attempts,next_at,queued_at) VALUES (?,0,0,?)
    ON CONFLICT(entry_id) DO UPDATE SET attempts=0, next_at=0, last_error=NULL, queued_at=excluded.queued_at`).run(entryId, new Date().toISOString());
  kick();
}
/** Call BEFORE deleting the entry row: keeps its Drive folder id so the worker can mark/trash it. */
function onDelete(entryId) {
  require('./gcal').onDelete(entryId);
  db.prepare('DELETE FROM drive_queue WHERE entry_id=?').run(entryId);
  db.prepare('DELETE FROM drive_files WHERE entry_id=?').run(entryId);
  const de = db.prepare('SELECT id FROM drive_entries WHERE entry_id=?').get(entryId);
  if (!de) return;
  db.prepare('UPDATE drive_entries SET entry_id=NULL, pending_delete=1, attempts=0, next_at=0 WHERE id=?').run(de.id);
  kick();
}
function enqueueAll() {
  const ids = db.prepare('SELECT id FROM entries ORDER BY date, id').all().map((r) => r.id);
  const t = new Date().toISOString();
  const st = db.prepare('INSERT INTO drive_queue (entry_id,attempts,next_at,queued_at) VALUES (?,0,0,?) ON CONFLICT(entry_id) DO UPDATE SET attempts=0, next_at=0, last_error=NULL, queued_at=excluded.queued_at');
  db.transaction(() => ids.forEach((id) => st.run(id, t)))();
  db.prepare('UPDATE drive_entries SET attempts=0, next_at=0 WHERE pending_delete=1').run();
  kick();
  return ids.length;
}
/** Entry IDs restart after "Clear all data", so the id -> Drive mapping must go too (the Drive files themselves stay). */
function resetMapping({ requeue = false } = {}) {
  db.exec('DELETE FROM drive_queue; DELETE FROM drive_files; DELETE FROM drive_entries; DELETE FROM drive_folders;');
  if (requeue) db.prepare("INSERT INTO drive_queue (entry_id,attempts,next_at,queued_at) SELECT id,0,0,? FROM entries").run(new Date().toISOString());
  S.del('root_id'); rootChecked = 0; folderChecked.clear();
  if (!requeue) require('./gcal').reset(); // new Google account / drive: the old calendar events no longer belong to us
}
function forgetEntries() { db.exec('DELETE FROM drive_queue; DELETE FROM drive_files; DELETE FROM drive_entries;'); require('./gcal').forget(); }

let running = false, timer = null, kickTimer = null;
function kick() { if (kickTimer) return; kickTimer = setTimeout(() => { kickTimer = null; runOnce().catch(() => {}); }, 300); kickTimer.unref?.(); }
let current = null;
/** Process due queue items. If a run is already going, wait for it and then run again (so callers see their item done). */
async function runOnce(opts) {
  while (current) await current.catch(() => {});
  current = runInner(opts);
  try { return await current; } finally { current = null; scheduleNext(); }
}
// wake up for the next retry instead of waiting for the regular tick
let wake = null;
function scheduleNext() {
  if (!connected()) return;
  const r = db.prepare(`SELECT MIN(n) n FROM (SELECT MIN(next_at) n FROM drive_queue WHERE attempts<${MAX_ATTEMPTS} UNION ALL SELECT MIN(next_at) FROM drive_entries WHERE pending_delete=1 AND attempts<${MAX_ATTEMPTS}
    UNION ALL SELECT MIN(next_at) FROM cal_queue WHERE attempts<${MAX_ATTEMPTS} UNION ALL SELECT MIN(next_at) FROM cal_entries WHERE pending_delete=1 AND attempts<${MAX_ATTEMPTS})`).get();
  if (!r || r.n == null) return;
  const ms = Math.max(200, r.n - Date.now());
  if (ms > TICK_MS) return;
  clearTimeout(wake); wake = setTimeout(() => runOnce().catch(() => {}), ms); wake.unref?.();
}
async function runInner({ limit = 50 } = {}) {
  if (!connected()) return { done: 0 };
  running = true; let done = 0;
  try {
    const store = require('./store');
    for (let i = 0; i < limit; i++) {
      const now = Date.now();
      const del = db.prepare('SELECT * FROM drive_entries WHERE pending_delete=1 AND next_at<=? AND attempts<? ORDER BY id LIMIT 1').get(now, MAX_ATTEMPTS);
      const job = del ? null : db.prepare('SELECT * FROM drive_queue WHERE next_at<=? AND attempts<? ORDER BY next_at, entry_id LIMIT 1').get(now, MAX_ATTEMPTS);
      if (!del && !job) {
        const r = await require('./gcal').step(now); // calendar events run after the PDF is in Drive
        if (!r) break;
        if (r.ok) done++;
        if (r.fatal) break;
        continue;
      }
      try {
        if (del) await syncDeleted(del);
        else {
          const e = store.get(job.entry_id);
          if (e) { await syncEntry(e); require('./gcal').enqueue(job.entry_id); }
          // edited again while uploading? enqueue() gave the row a new queued_at, so it stays and runs again
          db.prepare('DELETE FROM drive_queue WHERE entry_id=? AND queued_at IS ?').run(job.entry_id, job.queued_at);
        }
        done++;
        S.set('last_sync', new Date().toISOString()); S.del('last_error');
      } catch (err) {
        const msg = String(err.message || err).slice(0, 300);
        const attempts = (del || job).attempts + 1;
        // auth / config problems: no point hammering; wait for a reconnect (attempts kept low so it resumes)
        const next = err.reason === 'auth' || err.reason === 'not_configured' ? Date.now() + 3600000 : Date.now() + backoff(attempts);
        if (del) db.prepare('UPDATE drive_entries SET attempts=?, next_at=?, last_error=? WHERE id=?').run(attempts, next, msg, del.id);
        else db.prepare('UPDATE drive_queue SET attempts=?, next_at=?, last_error=? WHERE entry_id=?').run(attempts, next, msg, job.entry_id);
        S.set('last_error', `${new Date().toISOString()} ${msg}`);
        console.warn(`[eod-log] drive sync failed (attempt ${attempts}): ${msg}`);
        if (err.reason === 'auth' || err.status === 403 && /quota/i.test(err.reason || msg)) break;
      }
    }
  } finally { running = false; }
  return { done };
}
/** One-time: the folder layout changed (year > month > day > job). Re-sync every entry that is already in Drive so its folder is moved, not duplicated. */
function migrateLayout() {
  if (S.get('layout') === '3') return;
  if (connected()) {
    const t = new Date().toISOString();
    const ins = db.prepare('INSERT INTO drive_queue (entry_id,attempts,next_at,queued_at) VALUES (?,0,0,?) ON CONFLICT(entry_id) DO UPDATE SET attempts=0, next_at=0, queued_at=excluded.queued_at');
    db.transaction(() => db.prepare('SELECT entry_id FROM drive_entries WHERE entry_id IS NOT NULL AND folder_id IS NOT NULL').all().forEach((r) => ins.run(r.entry_id, t)))();
  }
  S.set('layout', '3');
}
function start() {
  if (timer) return;
  try { migrateLayout(); } catch (err) { console.warn('[eod-log] drive layout migration failed:', err.message); }
  timer = setInterval(() => runOnce().catch(() => {}), TICK_MS); timer.unref?.();
  setTimeout(() => runOnce().catch(() => {}), 3000).unref?.();
}

function status() {
  const q = db.prepare('SELECT COUNT(*) n, SUM(attempts>0) failing, SUM(attempts>=?) dead FROM drive_queue').get(MAX_ATTEMPTS);
  const d = db.prepare('SELECT COUNT(*) n, SUM(attempts>0) failing FROM drive_entries WHERE pending_delete=1').get();
  const lastErr = db.prepare('SELECT last_error FROM drive_queue WHERE last_error IS NOT NULL UNION ALL SELECT last_error FROM drive_entries WHERE last_error IS NOT NULL AND pending_delete=1 LIMIT 1').get();
  const rid = mode() === 'sa' ? S.get('shared_folder_id') : S.get('root_id');
  return {
    mode: mode(), connected: connected(), auto: S.get('auto') !== '0', clientType: clientType(), calendarScope: calendarScopeOk(), link: linkState(),
    account: mode() === 'sa' ? (saKey() || {}).client_email || '' : S.get('account') || '',
    clientIdSet: Boolean(clientId()), clientId: env.GDRIVE_CLIENT_ID ? '' : S.get('client_id') || '', clientFromEnv: Boolean(env.GDRIVE_CLIENT_ID), secretSet: Boolean(clientSecret()),
    saSet: Boolean(saKey()), saEmail: (saKey() || {}).client_email || '', sharedFolderId: S.get('shared_folder_id') || '',
    rootName: rootName(), rootUrl: rid ? `https://drive.google.com/drive/folders/${rid}` : '',
    onDelete: S.get('on_delete') === 'trash' ? 'trash' : 'mark',
    share: JSON.parse(S.get('share') || '{}'), sharePending: S.get('share_pending') || '', shareRole: S.get('share_role') === 'writer' ? 'writer' : 'reader',
    pending: (q.n || 0) + (d.n || 0), failing: (q.failing || 0) + (d.failing || 0), dead: q.dead || 0,
    synced: db.prepare('SELECT COUNT(*) n FROM drive_entries WHERE entry_id IS NOT NULL AND synced_at IS NOT NULL').get().n,
    entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n,
    lastSync: S.get('last_sync') || '', lastError: (lastErr && lastErr.last_error) || S.get('last_error') || '', authError: S.get('auth_error') || '',
  };
}

/** Common tail of both sign-in flows: keep the refresh token, learn the account, apply pending sharing. */
async function finishConnect(j, requestedScope) {
  const prev = S.get('account');
  S.set('mode', 'oauth'); S.set('refresh_token', j.refresh_token); S.set('scope', j.scope || requestedScope); S.del('auth_error'); S.del('cal_scope_note');
  tok = { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  let email = '';
  try { const a = await api('GET', '/drive/v3/about?fields=user(emailAddress,displayName)'); email = (a.user && a.user.emailAddress) || ''; } catch { /* optional */ }
  if (prev && email && prev !== email) resetMapping(); // different Google account: its own fresh folder tree
  S.set('account', email);
  const pend = S.get('share_pending');
  if (pend) { try { await applySharing(pend.split(/[\s,]+/).filter(Boolean), S.get('share_role') === 'writer' ? 'writer' : 'reader'); S.del('share_pending'); } catch { /* shown as not shared; Save again */ } }
  kick();
}

// ---------- connect, way 1 (Desktop-app client): open Google's page, approve, then paste the address the browser lands on.
// Needed for Calendar: Google's device-code flow only allows a short list of scopes (email, openid, profile, drive.appdata, drive.file, youtube) and Calendar is not on it.
// The redirect goes to http://127.0.0.1:9004/?code=..., which nothing listens on, so the browser shows "can't connect"; the code is in the address bar.
let pendingLink = null; // { state, verifier, url, expires }
function startLink() {
  if (!clientId() || !clientSecret()) throw new DriveError('Save the OAuth Client ID and Client secret first.', 0);
  const state = crypto.randomBytes(16).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url');
  const url = AUTH_URL + '?' + new URLSearchParams({
    client_id: clientId(), redirect_uri: LOOPBACK, response_type: 'code', scope: `${SCOPE_USER} ${SCOPE_CAL}`, access_type: 'offline', prompt: 'consent',
    state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  pendingLink = { state, verifier, url: url.toString(), expires: Date.now() + 20 * 60000 };
  return pendingLink;
}
const linkState = () => (pendingLink && Date.now() < pendingLink.expires ? { url: pendingLink.url } : null);
function cancelLink() { pendingLink = null; }
/** `pasted` = the whole address from the browser's address bar (or just the code). */
async function finishLink(pasted) {
  const p = pendingLink;
  if (!p || Date.now() > p.expires) throw new DriveError('That sign-in link expired. Click Connect again.', 0);
  const text = String(pasted || '').trim();
  let code = '', state = '', error = '';
  try { const u = new URL(text); code = u.searchParams.get('code') || ''; state = u.searchParams.get('state') || ''; error = u.searchParams.get('error') || ''; } catch {
    const m = /[?&]code=([^&\s]+)/.exec(text); code = m ? decodeURIComponent(m[1]) : /^[\w\-./]{10,}$/.test(text) ? text : '';
  }
  if (error) throw new DriveError(error === 'access_denied' ? 'Access was denied on the Google page.' : 'Google said: ' + error, 0);
  if (!code) throw new DriveError('No code found. Copy the WHOLE address from the browser (it starts with http://127.0.0.1:9004/?code=).', 0);
  if (state && state !== p.state) throw new DriveError('That address is from an older sign-in attempt. Click Connect again and use the new window.', 0);
  const j = await form(OAUTH + '/token', { client_id: clientId(), client_secret: clientSecret(), code, code_verifier: p.verifier, redirect_uri: LOOPBACK, grant_type: 'authorization_code' });
  if (!j.refresh_token) throw new DriveError('Google did not return a refresh token. Remove "EOD Log" at myaccount.google.com/permissions and connect again.', 0);
  pendingLink = null;
  await finishConnect(j, `${SCOPE_USER} ${SCOPE_CAL}`);
}

// ---------- connect, way 2 (TVs and Limited Input client, Drive only): OAuth device flow; no redirect URI, works on a LAN http NAS)
let pendingAuth = null; // { device_code, user_code, verification_url, expires, interval, state, error }
async function startDevice() {
  if (!clientId() || !clientSecret()) throw new DriveError('Save the OAuth Client ID and Client secret first.', 0);
  pendingLink = null;
  const j = await form(OAUTH + '/device/code', { client_id: clientId(), scope: SCOPE_USER });
  pendingAuth = { device_code: j.device_code, user_code: j.user_code, verification_url: j.verification_url || j.verification_uri, expires: Date.now() + (j.expires_in || 1800) * 1000, interval: Math.max(1, j.interval || 5), state: 'waiting' };
  pollDevice(pendingAuth);
  return pendingAuth;
}
async function pollDevice(p) {
  while (pendingAuth === p && p.state === 'waiting') {
    await new Promise((r) => setTimeout(r, p.interval * 1000));
    if (pendingAuth !== p) return;
    if (Date.now() > p.expires) { p.state = 'expired'; return; }
    try {
      const j = await form(OAUTH + '/token', { client_id: clientId(), client_secret: clientSecret(), device_code: p.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (!j.refresh_token) { p.state = 'error'; p.error = 'Google did not return a refresh token.'; return; }
      await finishConnect(j, SCOPE_USER);
      p.state = 'done';
      kick();
      return;
    } catch (err) {
      if (err.reason === 'authorization_pending') continue;
      if (err.reason === 'slow_down') { p.interval += 5; continue; }
      p.state = err.reason === 'access_denied' ? 'denied' : err.reason === 'expired_token' ? 'expired' : 'error';
      p.error = err.message; return;
    }
  }
}
const deviceState = () => (pendingAuth ? { state: pendingAuth.state, user_code: pendingAuth.user_code, verification_url: pendingAuth.verification_url, error: pendingAuth.error || '' } : { state: 'none' });
function cancelDevice() { pendingAuth = null; }

async function disconnect() {
  const rt = S.get('refresh_token');
  if (rt) { try { await form(OAUTH + '/revoke', { token: rt }); } catch { /* already revoked */ } }
  S.del('refresh_token'); S.del('scope'); S.del('auth_error'); resetToken(); pendingAuth = null; pendingLink = null;
}

/** Test: make sure the folder is reachable and a file can be written there (then trashed). */
async function test() {
  rootChecked = 0;
  const r = await root();
  const f = await upload({ name: 'EOD Log connection test.txt', parent: r, mime: 'text/plain', data: Buffer.from(`Connection test from ${cfg.APP_NAME} at ${new Date().toISOString()}. Safe to delete.\n`) });
  await trash(f.id);
  return { rootUrl: `https://drive.google.com/drive/folders/${r}` };
}

/** Share the root folder with these emails (adds new ones, removes ones taken off the list). */
async function applySharing(emails, role) {
  const r = await root();
  const cur = JSON.parse(S.get('share') || '{}'); // email -> { id, role }
  const want = new Set(emails.map((x) => x.toLowerCase()));
  const errors = [];
  for (const [email, p] of Object.entries(cur)) {
    if (want.has(email) && p.role === role) continue;
    try { await api('DELETE', `/drive/v3/files/${encodeURIComponent(r)}/permissions/${encodeURIComponent(p.id)}?${Q}`); } catch (err) { if (err.status !== 404) { errors.push(`${email}: ${err.message}`); continue; } }
    delete cur[email];
  }
  for (const email of want) {
    if (cur[email]) continue;
    try {
      const p = await api('POST', `/drive/v3/files/${encodeURIComponent(r)}/permissions?${Q}&sendNotificationEmail=true&fields=id`, { json: { type: 'user', role, emailAddress: email } });
      cur[email] = { id: p.id, role };
    } catch (err) { errors.push(`${email}: ${err.message}`); }
  }
  S.set('share', JSON.stringify(cur)); S.set('share_role', role); S.del('share_pending');
  return errors;
}

module.exports = {
  S, api, DriveError, kick, syncEntry, mode, saKey, calendarScopeOk, SCOPE_CAL, status, connected, enabled, enqueue, enqueueAll, onDelete, resetMapping, forgetEntries, runOnce, start, startDevice, deviceState, cancelDevice, disconnect, test, applySharing,
  resetToken, migrateLayout, startLink, finishLink, cancelLink, clientType, naming: { safeName, folderName, jobFolderName, pdfName, receiptNames, yearName, monthName, dayName }, backoff, MAX_ATTEMPTS,
};
