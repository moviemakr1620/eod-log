const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// Session secret: env, else a random one kept in the data volume (so sessions survive restarts).
let secret = cfg.SESSION_SECRET;
if (!secret) {
  const f = path.join(cfg.DATA_DIR, '.session-secret');
  try { secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* none yet */ }
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, secret, { mode: 0o600 }); }
}
// Changing APP_PASSWORD or ADMIN_PASSWORD signs everybody out.
const key = crypto.createHmac('sha256', secret).update('v1|' + cfg.APP_PASSWORD + '|' + cfg.ADMIN_PASSWORD).digest();
const COOKIE = 'eod_s';
const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i < 0) return;
    try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* ignore */ }
  });
  return out;
}

function readSession(req) {
  const v = parseCookies(req)[COOKIE];
  if (!v) return null;
  const [data, sig] = v.split('.');
  if (!data || !sig || !safeEqual(sign(data), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() - s.t > cfg.SESSION_DAYS * 86400000) return null;
    return s;
  } catch { return null; }
}

function writeSession(req, res, s) {
  const data = Buffer.from(JSON.stringify({ ...s, t: Date.now() })).toString('base64url');
  const secure = cfg.COOKIE_SECURE === 'auto' ? req.secure : /^(1|true|yes)$/i.test(cfg.COOKIE_SECURE);
  res.append('Set-Cookie', `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(cfg.SESSION_DAYS * 86400)}${secure ? '; Secure' : ''}`);
}
function clearSession(res) { res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

// tiny in-memory limiter for password attempts: 10 per 10 minutes per IP
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 600000);
  attempts.set(ip, a);
  return a.length >= 10;
}
function recordFail(ip) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(Date.now()); }

const passwordRequired = () => !cfg.ALLOW_NO_PASSWORD;
const adminConfigured = () => Boolean(cfg.ADMIN_PASSWORD);
function isAdmin(req) { return !adminConfigured() || (req.session && req.session.r === 'admin'); }

function checkTeam(pw) { return cfg.APP_PASSWORD && safeEqual(pw || '', cfg.APP_PASSWORD); }
function checkAdmin(pw) { return cfg.ADMIN_PASSWORD && safeEqual(pw || '', cfg.ADMIN_PASSWORD); }

module.exports = { readSession, writeSession, clearSession, limited, recordFail, passwordRequired, adminConfigured, isAdmin, checkTeam, checkAdmin };
