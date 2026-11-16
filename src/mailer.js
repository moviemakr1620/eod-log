const nodemailer = require('nodemailer');
const cfg = require('./config');
const { db } = require('./db');
const summary = require('./summary');
const { addDays, weekStart, nowParts, parseDate, WDL } = require('./util');

const smtpConfigured = () => Boolean(cfg.SMTP.host && cfg.SMTP.from);
let transport;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure,
      auth: cfg.SMTP.user ? { user: cfg.SMTP.user, pass: cfg.SMTP.pass } : undefined,
      tls: { rejectUnauthorized: cfg.SMTP.tlsRejectUnauthorized },
    });
  }
  return transport;
}
const parseList = (s) => [...new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
const stamp = (tz) => new Date().toLocaleString('en-US', { timeZone: tz || cfg.TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const weekdayOf = (d) => parseDate(d).getUTCDay();

// ---- schedules
const FREQS = { daily: 'Every day', weekdays: 'Weekdays (Mon–Fri)', weekly: 'Weekly' };
const listSchedules = () => db.prepare('SELECT * FROM schedules ORDER BY id').all();
const getSchedule = (id) => db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
function describe(s) {
  const when = s.frequency === 'weekly' ? `${WDL[s.weekday]}s` : FREQS[s.frequency];
  const covers = s.frequency === 'weekly' ? 'previous Mon–Sun' : s.frequency === 'weekdays'
    ? (s.covers === 'today' ? 'that day (Monday also covers the weekend)' : 'the day before (Monday covers Fri–Sun)')
    : (s.covers === 'today' ? 'that day' : 'the day before');
  return `${when} at ${s.send_time}, covers ${covers}`;
}

/** Is a send day for this schedule? */
function isSendDay(s, date) {
  const wd = weekdayOf(date);
  if (s.frequency === 'weekly') return wd === Number(s.weekday);
  if (s.frequency === 'weekdays') return wd >= 1 && wd <= 5;
  return true;
}
/** Period covered by a send on `date` (a send day). */
function periodFor(s, date) {
  if (s.frequency === 'weekly') { const from = addDays(weekStart(date), -7); return { from, to: addDays(from, 6) }; }
  const end = s.covers === 'today' ? date : addDays(date, -1);
  if (s.frequency === 'weekdays') {
    // covers everything since the previous send day's period, so weekends are not lost
    let prev = addDays(date, -1); while (!isSendDay(s, prev)) prev = addDays(prev, -1);
    const prevEnd = s.covers === 'today' ? prev : addDays(prev, -1);
    return { from: addDays(prevEnd, 1), to: end };
  }
  return { from: end, to: end };
}
/** Period for "preview / send test now": the most recent send day up to today. */
function previewPeriod(s) {
  let d = nowParts(s.tz || cfg.TZ).date;
  for (let i = 0; i < 8 && !isSendDay(s, d); i++) d = addDays(d, -1);
  return periodFor(s, d);
}

async function sendFor(s, period, to, { test = false, attach } = {}) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST and SMTP_FROM)');
  const recipients = to && to.length ? to : parseList(s.recipients);
  if (!recipients.length) throw new Error('No recipients set for this notification');
  const sum = summary.build(period.from, period.to);
  const doAttach = attach !== undefined ? attach : Boolean(s.attach);
  const info = await getTransport().sendMail({
    from: cfg.SMTP.from, to: recipients.join(', '),
    subject: `${test ? '[TEST] ' : ''}${cfg.APP_NAME}: ${s.name} – ${sum.label}`,
    text: summary.emailText(sum, s.name), html: summary.emailHtml(sum, s.name),
    attachments: doAttach ? summary.attachments(sum) : [],
  });
  return { info, recipients, summary: sum };
}

function log(scheduleId, period, status, detail, entries) {
  db.prepare(`INSERT INTO sends (schedule_id,period_from,period_to,status,detail,entries,at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(schedule_id,period_from,period_to) DO UPDATE SET status=excluded.status, detail=excluded.detail, entries=excluded.entries, at=excluded.at`)
    .run(scheduleId, period.from, period.to, status, detail, entries ?? null, new Date().toISOString());
}

/** One scheduler pass. Exported for tests. */
async function tick() {
  if (!smtpConfigured()) return;
  for (const s of listSchedules()) {
    if (!s.enabled) continue;
    try {
      const n = nowParts(s.tz || cfg.TZ);
      if (!isSendDay(s, n.date) || n.hhmm < s.send_time) continue;
      const period = periodFor(s, n.date);
      if (period.from > period.to) continue;
      // claim the period first: UNIQUE(schedule, from, to) makes this run once, even across restarts
      const claim = db.prepare(`INSERT OR IGNORE INTO sends (schedule_id,period_from,period_to,status,detail,at) VALUES (?,?,?,'sending',NULL,?)`)
        .run(s.id, period.from, period.to, new Date().toISOString());
      if (!claim.changes) continue;
      const count = summary.build(period.from, period.to).entries.length;
      if (!count) { log(s.id, period, 'skipped', `No EODs ${period.from === period.to ? 'on ' + period.from : period.from + ' to ' + period.to}; nothing sent`, 0); console.log(`[notify] "${s.name}" ${period.from}..${period.to}: no entries, skipped`); continue; }
      const recips = parseList(s.recipients);
      if (!recips.length) { log(s.id, period, 'failed', 'No recipients set', count); continue; }
      const r = await sendFor(s, period);
      log(s.id, period, 'sent', `Sent ${stamp(s.tz)} to ${r.recipients.join(', ')}`, count);
      console.log(`[notify] "${s.name}" ${period.from}..${period.to}: sent to ${r.recipients.length}`);
    } catch (err) {
      try { const n = nowParts(s.tz || cfg.TZ); log(s.id, periodFor(s, n.date), 'failed', `${stamp(s.tz)}: ${err.message}`); } catch { /* ignore */ }
      console.error(`[notify] "${s.name}" failed:`, err.message);
    }
  }
}
let running = false;
async function safeTick() { if (running) return; running = true; try { await tick(); } finally { running = false; } }
function startScheduler() { setInterval(safeTick, 30000).unref(); setTimeout(safeTick, 5000).unref(); }

const recentSends = (limit = 20) => db.prepare(`SELECT sends.*, schedules.name FROM sends JOIN schedules ON schedules.id = sends.schedule_id ORDER BY sends.at DESC, sends.id DESC LIMIT ?`).all(limit);

module.exports = { sendFor, startScheduler, tick: safeTick, smtpConfigured, parseList, listSchedules, getSchedule, describe, previewPeriod, periodFor, isSendDay, recentSends, FREQS, log };
