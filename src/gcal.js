// Google Calendar: every EOD becomes ONE event on a dedicated calendar, with the EOD PDF (from Drive) attached.
// Uses the same Google connection as the Drive sync (./drive.js): OAuth (Desktop-app client, Drive + Calendar scopes) or a service account.
// Runs from the same background worker, after the PDF is in Drive; its own retry queue (cal_queue) so a Calendar problem never re-uploads Drive files.
const cfg = require('./config');
const { db } = require('./db');
const D = require('./drive');
const H = require('../public/hours.js');
const { addDays, todayIn, prettyDate, money } = require('./util');

const S = D.S;
const enc = encodeURIComponent;
const MAX_DESC = 7800; // Calendar's limit is 8192 characters

// ---------- settings
const calName = () => D.naming.safeName(S.get('cal_name') || cfg.APP_NAME || 'EOD Log', 100);
/** A service account can't own a calendar a person can see, so it always uses a calendar ID someone shared with it. */
const calMode = () => (D.mode() === 'sa' || S.get('cal_mode') === 'paste' ? 'paste' : 'auto');
const wanted = () => S.get('cal_on') === '1';
const active = () => wanted() && D.connected();
/** Ready to talk to Calendar: switched on, Drive connected, and the sign-in has the Calendar scope. */
const usable = () => active() && D.calendarScopeOk();
const needsReconnect = () => wanted() && D.connected() && !D.calendarScopeOk();

// ---------- HTTP (errors get plain-English messages and a reason the queue understands)
async function calApi(method, url, opts) {
  try { return await D.api(method, url, opts); } catch (err) {
    const m = String(err.message || '');
    if (err.status === 403 && (/insufficient.*(scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(m + ' ' + (err.reason || '')))) {
      throw new D.DriveError('Google refused: this sign-in does not include Calendar. Reconnect to enable Calendar.', 403, 'auth');
    }
    if (err.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(m + ' ' + (err.reason || ''))) {
      throw new D.DriveError('The Google Calendar API is not turned on. In Google Cloud: APIs & Services > Library > Google Calendar API > Enable.', 403, 'not_configured');
    }
    if (err.status === 404 && D.mode() === 'sa' && /calendars\//.test(url)) {
      throw new D.DriveError('Calendar not found, or not shared with the service account. Share it with the service account email using "Make changes to events".', 404, 'not_configured');
    }
    throw err;
  }
}

// ---------- which calendar
let calChecked = 0;
async function calendarId() {
  if (calMode() === 'paste') {
    const id = S.get('cal_paste_id');
    if (!id) throw new D.DriveError('Paste a calendar ID in Settings > Google Calendar.', 0, 'not_configured');
    return id;
  }
  let id = S.get('cal_auto_id');
  if (id) {
    if (Date.now() - calChecked < 600000 && S.get('cal_auto_name') === calName()) return id;
    try {
      const c = await calApi('GET', `/calendar/v3/calendars/${enc(id)}`);
      if (c.summary !== calName()) await calApi('PATCH', `/calendar/v3/calendars/${enc(id)}`, { json: { summary: calName() } });
      S.set('cal_auto_name', calName()); calChecked = Date.now();
      return id;
    } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; id = null; S.del('cal_auto_id'); }
  }
  const c = await calApi('POST', '/calendar/v3/calendars', { json: { summary: calName(), description: `End of day logs from ${cfg.APP_NAME}`, timeZone: validTz(cfg.TZ) } });
  S.set('cal_auto_id', c.id); S.set('cal_auto_name', calName()); calChecked = Date.now();
  enqueueAll(); // a new calendar is empty: put every EOD on it
  return c.id;
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return cfg.TZ; } }

// ---------- the event
const pad = (n) => String(n).padStart(2, '0');
const hm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
/** Every EOD is an ALL-DAY event (date + next day, exclusive) so the calendar reads as a list and nothing overlaps.
 *  `range` is the crew's earliest start to latest stop (a stop earlier than its start means past midnight), shown in the description. null when nobody has times. */
function eventTimes(e) {
  const pick = (a, b) => {
    let start = null, end = null;
    (e.crew || []).forEach((c) => {
      const s = H.toMin(c[a]), t = H.toMin(c[b]);
      if (s === null) return;
      const en = t === null ? null : s + H.span(c[a], c[b]);
      if (start === null || s < start) start = s;
      if (en !== null && (end === null || en > end)) end = en;
    });
    return start === null ? null : { start, end };
  };
  const t = pick('start', 'stop') || pick('on_set', 'wheels_up');
  const clock = (min) => H.ampm(hm(min % 1440));
  const range = !t ? null : `${clock(t.start)}${t.end === null ? '' : `–${clock(t.end)}${t.end >= 1440 ? ' (+1 day)' : ''}`}`;
  return { allDay: true, start: { date: e.date }, end: { date: addDays(e.date, 1) }, range };
}
const eventTitle = (e) => `${e.job}${e.job_type ? ` (${e.job_type})` : ''} – EOD`;
const entryUrl = (e) => (cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/e/${e.id}` : '');
function description(e) {
  const t = (v) => (v ? H.ampm(v) : '');
  const L = [];
  const range = eventTimes(e).range;
  if (range) L.push(`Crew times ${range}`, '');
  const head = [['Client', e.client], ['Location', e.location], ['Crew chief', e.crew_chief]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (head.length) L.push(head.join(' · '), '');
  L.push('CREW');
  e.crew.forEach((c) => {
    const bits = [];
    if (c.start || c.stop) bits.push(`${t(c.start) || '?'}–${t(c.stop) || '?'}`);
    (c.meals || []).forEach((m) => bits.push(`meal ${t(m.start) || '?'}–${t(m.end) || '?'}`));
    if (c.on_set || c.wheels_up) bits.push(`on set ${t(c.on_set) || '?'}–${t(c.wheels_up) || '?'}`);
    const hrs = [];
    if (c.onsite_min != null) hrs.push(`on set ${H.dec(c.onsite_min)} h`);
    hrs.push(`total ${c.paid_min != null ? H.dec(c.paid_min) + ' h' : '-'}${c.hours_override != null ? ' (typed in)' : ''}`);
    if (c.edit_hours) hrs.push(`edit/DIT ${c.edit_hours} h`);
    L.push(`• ${c.name}${c.role ? ` (${c.role})` : ''}: ${bits.join(', ') ? bits.join(', ') + ' → ' : ''}${hrs.join(', ')}`);
  });
  L.push('', `Total hours: ${H.dec(e.paid_min) || 0} h · On set hours: ${H.dec(e.onsite_min) || 0} h`);
  if (e.expenses.length) {
    const owed = e.expenses.filter((x) => x.paid_by === 'personal').reduce((s, x) => s + (x.amount || 0), 0);
    L.push('', `EXPENSES: ${money(e.expense_total) || '$0.00'}${owed ? ` (${money(owed)} to reimburse)` : ''}`);
    e.expenses.forEach((x) => L.push(`• ${x.description || x.category || 'Expense'}${x.amount != null ? ' ' + money(x.amount) : ''} (${x.paid_by === 'personal' ? 'personal, reimburse' : 'company card'}${x.person ? ', ' + x.person : ''})`));
  }
  const veh = [e.vehicle && `${e.vehicle}${e.vehicle_kind ? ' (' + e.vehicle_kind + ')' : ''}`, e.driver && `driver ${e.driver}`, e.miles != null && `${e.miles} mi`, e.tolls != null && `tolls ${money(e.tolls)}`].filter(Boolean);
  if (veh.length) L.push('', 'VEHICLE: ' + veh.join(' · '));
  if (e.issues) L.push('', 'ISSUES: ' + e.issues);
  if (e.notes) L.push('', 'NOTES: ' + e.notes);
  const url = entryUrl(e);
  if (url) L.push('', `Open in ${cfg.APP_NAME}: ${url}`);
  let out = L.join('\n');
  if (out.length > MAX_DESC) out = out.slice(0, MAX_DESC - 1).trimEnd() + '…' + (url ? `\n\nOpen in ${cfg.APP_NAME}: ${url}` : '');
  return out;
}
/** `patch`: also clear any dateTime/timeZone an older (timed) version of the event had, so it converts to all-day instead of failing or staying timed. */
function eventBody(e, pdfId, { patch = false } = {}) {
  const tm = eventTimes(e);
  const day = (d) => (patch ? { date: d.date, dateTime: null, timeZone: null } : d);
  const url = entryUrl(e);
  return {
    summary: eventTitle(e), description: description(e), ...(e.location ? { location: e.location } : {}),
    start: day(tm.start), end: day(tm.end), transparency: 'transparent', reminders: { useDefault: false },
    ...(url ? { source: { title: cfg.APP_NAME, url } } : {}),
    extendedProperties: { private: { eodlog_entry: String(e.id) } },
    attachments: pdfId ? [{ fileUrl: `https://drive.google.com/file/d/${pdfId}/view`, title: D.naming.pdfName(e), mimeType: 'application/pdf', fileId: pdfId }] : [],
  };
}

// ---------- sync one entry
async function syncEntry(e) {
  let de = db.prepare('SELECT * FROM drive_entries WHERE entry_id=?').get(e.id);
  if (!de || !de.pdf_id) { await D.syncEntry(e); de = db.prepare('SELECT * FROM drive_entries WHERE entry_id=?').get(e.id); } // the PDF must exist first
  const cid = await calendarId();
  const body = eventBody(e, de && de.pdf_id);
  const row = db.prepare('SELECT * FROM cal_entries WHERE entry_id=?').get(e.id);
  const base = `/calendar/v3/calendars/${enc(cid)}/events`;
  let ev = null;
  if (row && row.event_id && row.calendar_id === cid) {
    try { ev = await calApi('PATCH', `${base}/${enc(row.event_id)}?supportsAttachments=true`, { json: eventBody(e, de && de.pdf_id, { patch: true }) }); } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; }
    if (ev && ev.status === 'cancelled') ev = null; // deleted in Calendar by a person: make a fresh one
  }
  if (!ev) ev = await calApi('POST', `${base}?supportsAttachments=true`, { json: body });
  db.prepare(`INSERT INTO cal_entries (entry_id,calendar_id,event_id,summary,html_link,synced_at,attempts,next_at,last_error) VALUES (?,?,?,?,?,?,0,0,NULL)
    ON CONFLICT(entry_id) DO UPDATE SET calendar_id=excluded.calendar_id, event_id=excluded.event_id, summary=excluded.summary, html_link=excluded.html_link, synced_at=excluded.synced_at`)
    .run(e.id, cid, ev.id, body.summary, ev.htmlLink || null, new Date().toISOString());
}
async function syncDeleted(row) {
  if (row.event_id && row.calendar_id) {
    const url = `/calendar/v3/calendars/${enc(row.calendar_id)}/events/${enc(row.event_id)}`;
    try {
      if (S.get('on_delete') === 'trash') await calApi('DELETE', url);
      else await calApi('PATCH', url, { json: { summary: D.naming.safeName('(deleted) ' + (row.summary || 'EOD'), 250) } });
    } catch (err) { if (err.status !== 404 && err.status !== 410) throw err; }
  }
  db.prepare('DELETE FROM cal_entries WHERE id=?').run(row.id);
}

// ---------- queue (driven by the Drive worker loop)
function enqueue(entryId) {
  if (!usable()) return;
  db.prepare(`INSERT INTO cal_queue (entry_id,attempts,next_at,queued_at) VALUES (?,0,0,?)
    ON CONFLICT(entry_id) DO UPDATE SET attempts=0, next_at=0, last_error=NULL, queued_at=excluded.queued_at`).run(entryId, new Date().toISOString());
  D.kick();
}
function enqueueAll() {
  if (!usable()) return 0;
  const ids = db.prepare('SELECT id FROM entries ORDER BY date, id').all().map((r) => r.id);
  const t = new Date().toISOString();
  const st = db.prepare('INSERT INTO cal_queue (entry_id,attempts,next_at,queued_at) VALUES (?,0,0,?) ON CONFLICT(entry_id) DO UPDATE SET attempts=0, next_at=0, last_error=NULL, queued_at=excluded.queued_at');
  db.transaction(() => ids.forEach((id) => st.run(id, t)))();
  db.prepare('UPDATE cal_entries SET attempts=0, next_at=0 WHERE pending_delete=1').run();
  D.kick();
  return ids.length;
}
/** Call BEFORE the entry row is deleted. */
function onDelete(entryId) {
  db.prepare('DELETE FROM cal_queue WHERE entry_id=?').run(entryId);
  const row = db.prepare('SELECT id, event_id FROM cal_entries WHERE entry_id=?').get(entryId);
  if (!row) return;
  if (!row.event_id) { db.prepare('DELETE FROM cal_entries WHERE id=?').run(row.id); return; }
  db.prepare('UPDATE cal_entries SET entry_id=NULL, pending_delete=1, attempts=0, next_at=0 WHERE id=?').run(row.id);
}
/** New Google account / drive: the old events are not ours any more. */
function reset() { db.exec('DELETE FROM cal_queue; DELETE FROM cal_entries;'); S.del('cal_auto_id'); S.del('cal_auto_name'); calChecked = 0; }
/** "Clear all data": entry ids restart, so forget the id -> event mapping (events in Google Calendar are NOT deleted). */
function forget() { db.exec('DELETE FROM cal_queue; DELETE FROM cal_entries;'); }
/** Settings changed (calendar, name, on/off): refresh every event on the (new) calendar. */
function settingsChanged({ calendarSwitched } = {}) {
  calChecked = 0;
  if (!wanted()) { db.exec('DELETE FROM cal_queue'); return 0; }
  return calendarSwitched ? enqueueAll() : 0;
}

/** Run one due calendar task. null = nothing to do. */
async function step(now) {
  if (!usable()) return null;
  const max = D.MAX_ATTEMPTS;
  const del = db.prepare('SELECT * FROM cal_entries WHERE pending_delete=1 AND next_at<=? AND attempts<? ORDER BY id LIMIT 1').get(now, max);
  const job = del ? null : db.prepare('SELECT * FROM cal_queue WHERE next_at<=? AND attempts<? ORDER BY next_at, entry_id LIMIT 1').get(now, max);
  if (!del && !job) return null;
  try {
    if (del) await syncDeleted(del);
    else {
      const store = require('./store');
      const e = store.get(job.entry_id);
      if (e) await syncEntry(e);
      db.prepare('DELETE FROM cal_queue WHERE entry_id=? AND queued_at IS ?').run(job.entry_id, job.queued_at); // edited again meanwhile? it stays and runs again
    }
    S.set('cal_last_sync', new Date().toISOString()); S.del('cal_last_error');
    return { ok: true };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    const attempts = (del || job).attempts + 1;
    const next = err.reason === 'auth' || err.reason === 'not_configured' ? Date.now() + 3600000 : Date.now() + D.backoff(attempts);
    if (del) db.prepare('UPDATE cal_entries SET attempts=?, next_at=?, last_error=? WHERE id=?').run(attempts, next, msg, del.id);
    else db.prepare('UPDATE cal_queue SET attempts=?, next_at=?, last_error=? WHERE entry_id=?').run(attempts, next, msg, job.entry_id);
    S.set('cal_last_error', `${new Date().toISOString()} ${msg}`);
    console.warn(`[eod-log] calendar sync failed (attempt ${attempts}): ${msg}`);
    return { ok: false, fatal: err.reason === 'auth' };
  }
}

/** Test button: find or create the calendar, add a throw-away event and remove it again. */
async function test() {
  if (!D.connected()) throw new D.DriveError('Connect Google Drive first (Settings > Google Drive).', 0);
  if (!D.calendarScopeOk()) throw new D.DriveError('This sign-in does not include Calendar. Reconnect to enable Calendar.', 0, 'auth');
  calChecked = 0;
  const cid = await calendarId();
  const cal = await calApi('GET', `/calendar/v3/calendars/${enc(cid)}`);
  const today = todayIn(cfg.TZ);
  const ev = await calApi('POST', `/calendar/v3/calendars/${enc(cid)}/events`, { json: { summary: `${cfg.APP_NAME} connection test`, start: { date: today }, end: { date: addDays(today, 1) }, transparency: 'transparent' } });
  await calApi('DELETE', `/calendar/v3/calendars/${enc(cid)}/events/${enc(ev.id)}`);
  return { name: cal.summary || calName() };
}

function status() {
  const q = db.prepare('SELECT COUNT(*) n, SUM(attempts>0) failing, SUM(attempts>=?) dead FROM cal_queue').get(D.MAX_ATTEMPTS);
  const d = db.prepare('SELECT COUNT(*) n, SUM(attempts>0) failing FROM cal_entries WHERE pending_delete=1').get();
  const lastErr = db.prepare('SELECT last_error FROM cal_queue WHERE last_error IS NOT NULL UNION ALL SELECT last_error FROM cal_entries WHERE last_error IS NOT NULL AND pending_delete=1 LIMIT 1').get();
  const cid = calMode() === 'paste' ? S.get('cal_paste_id') : S.get('cal_auto_id');
  return {
    on: wanted(), mode: calMode(), driveMode: D.mode(), driveConnected: D.connected(), scopeOk: D.calendarScopeOk(), needsReconnect: needsReconnect(), clientType: D.clientType(),
    name: calName(), pasteId: S.get('cal_paste_id') || '', calendarId: cid || '', created: Boolean(S.get('cal_auto_id')),
    saEmail: (D.saKey() || {}).client_email || '', publicUrlSet: Boolean(cfg.PUBLIC_URL),
    pending: (q.n || 0) + (d.n || 0), failing: (q.failing || 0) + (d.failing || 0), dead: q.dead || 0,
    synced: db.prepare('SELECT COUNT(*) n FROM cal_entries WHERE entry_id IS NOT NULL AND event_id IS NOT NULL AND calendar_id IS ?').get(cid || null).n,
    entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n,
    lastSync: S.get('cal_last_sync') || '', lastError: (lastErr && lastErr.last_error) || S.get('cal_last_error') || '',
  };
}

module.exports = { S, step, enqueue, enqueueAll, onDelete, reset, forget, settingsChanged, test, status, eventTimes, eventTitle, description, eventBody, usable, needsReconnect, wanted, calMode, calendarId };
