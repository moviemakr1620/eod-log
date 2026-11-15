class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s == null ? '' : String(s));
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// ---- dates (all "YYYY-MM-DD" strings, maths in UTC so DST never bites)
const DAY = 86400000;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDate = (d) => d.toISOString().slice(0, 10);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseDate(s));
const addDays = (s, n) => fmtDate(new Date(parseDate(s).getTime() + n * DAY));
function weekStart(s) { const d = parseDate(s); const wd = (d.getUTCDay() + 6) % 7; return addDays(s, -wd); } // Monday
function todayIn(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA gives YYYY-MM-DD
}
function nowParts(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday: wd, hhmm: `${parts.hour}:${parts.minute}`, date: todayIn(tz) };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function prettyDate(s, withYear) { const d = parseDate(s); return `${WD[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? ', ' + d.getUTCFullYear() : ''}`; }
function rangeLabel(a, b) {
  const da = parseDate(a), dbb = parseDate(b);
  const sameMonth = da.getUTCMonth() === dbb.getUTCMonth();
  return `${MONTHS[da.getUTCMonth()]} ${da.getUTCDate()} – ${sameMonth ? '' : MONTHS[dbb.getUTCMonth()] + ' '}${dbb.getUTCDate()}, ${dbb.getUTCFullYear()}`;
}
const money = (n) => (n == null || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; };
const str = (v, max = 4000) => { if (v === undefined || v === null) return null; const s = String(v).trim().slice(0, max); return s === '' ? null : s; };
const timeStr = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);

const TIMEZONES = [
  ['America/New_York', 'Eastern (ET)'], ['America/Chicago', 'Central (CT)'], ['America/Denver', 'Mountain (MT)'],
  ['America/Phoenix', 'Arizona (MST)'], ['America/Los_Angeles', 'Pacific (PT)'], ['America/Anchorage', 'Alaska (AKT)'],
  ['Pacific/Honolulu', 'Hawaii (HT)'], ['Europe/London', 'London (UK)'], ['UTC', 'UTC'],
];
const tzLabel = (tz) => (TIMEZONES.find((t) => t[0] === tz) || [tz, tz || ''])[1];
const tzShort = (tz) => { const l = tzLabel(tz); const m = /\(([^)]+)\)/.exec(l); return m ? m[1] : l; };
const JOB_TYPES = ['Film shoot', 'AV install', 'Live event', 'Edit / DIT', 'Other'];
const EXPENSE_CATS = ['Fuel', 'Tolls', 'Parking', 'Meals', 'Supplies', 'Equipment rental', 'Lodging', 'Travel', 'Other'];

module.exports = { Raw, raw, esc, html, render, parseDate, fmtDate, isDate, addDays, weekStart, todayIn, nowParts, prettyDate, rangeLabel, money, num, str, timeStr, TIMEZONES, tzLabel, tzShort, JOB_TYPES, EXPENSE_CATS, WDL, MONTHS };
