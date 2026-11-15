const nodemailer = require('nodemailer');
const cfg = require('./config');
const { getSetting, setSetting } = require('./db');
const summary = require('./summary');
const { addDays, weekStart, nowParts } = require('./util');
const stamp = () => new Date().toLocaleString('en-US', { timeZone: getSetting('summary_tz') || cfg.TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

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
const parseList = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));

async function sendSummary(weekStartDate, to, opts = {}) {
  if (!smtpConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST and SMTP_FROM)');
  const recipients = to && to.length ? to : parseList(getSetting('manager_emails'));
  if (!recipients.length) throw new Error('No manager email addresses are set');
  const s = summary.build(weekStartDate);
  const attach = opts.attach !== undefined ? opts.attach : getSetting('summary_attach') === '1';
  const info = await getTransport().sendMail({
    from: cfg.SMTP.from, to: recipients.join(', '),
    subject: `${opts.test ? '[TEST] ' : ''}${cfg.APP_NAME} weekly summary: ${s.label}`,
    text: summary.emailText(s), html: summary.emailHtml(s),
    attachments: attach ? summary.attachments(s) : [],
  });
  return { info, recipients, summary: s };
}

/** Called every 30s: sends last week's summary once on the configured weekday at/after the configured time. */
async function tick() {
  try {
    if (getSetting('summary_enabled') !== '1' || !smtpConfigured()) return;
    const tz = getSetting('summary_tz') || cfg.TZ;
    const n = nowParts(tz);
    if (String(n.weekday) !== String(getSetting('summary_day'))) return;
    if (n.hhmm < (getSetting('summary_time') || '08:00')) return;
    const lastWeek = addDays(weekStart(n.date), -7);
    if (getSetting('summary_last_week') === lastWeek) return;
    setSetting('summary_last_week', lastWeek); // set first so a failure can't loop-send
    const r = await sendSummary(lastWeek);
    setSetting('summary_last_result', `Sent ${stamp()} to ${r.recipients.join(', ')} (week of ${lastWeek})`);
    console.log(`[summary] sent week ${lastWeek} to ${r.recipients.length} recipient(s)`);
  } catch (err) {
    setSetting('summary_last_result', `FAILED ${stamp()}: ${err.message}`);
    console.error('[summary] failed:', err.message);
  }
}
function startScheduler() { setInterval(tick, 30000).unref(); setTimeout(tick, 5000).unref(); }

module.exports = { sendSummary, startScheduler, smtpConfigured, parseList, tick };
