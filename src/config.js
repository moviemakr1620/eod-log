const path = require('path');
const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const DATA_DIR = path.resolve(env.DATA_DIR || '/data');
module.exports = {
  APP_NAME: env.APP_NAME || 'EOD Log',
  COMPANY: env.COMPANY_NAME || 'KPI',
  PORT: Number(env.PORT || 8080),
  DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'eod.sqlite'),
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  APP_PASSWORD: env.APP_PASSWORD || '',
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
  ALLOW_NO_PASSWORD: bool(env.ALLOW_NO_PASSWORD, false),
  SESSION_SECRET: env.SESSION_SECRET || '',
  SESSION_DAYS: Number(env.SESSION_DAYS || 180),
  COOKIE_SECURE: env.COOKIE_SECURE || 'auto',
  TRUST_PROXY: env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  PUBLIC_URL: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  TZ: env.APP_TIMEZONE || env.TZ || 'America/New_York',
  MAX_UPLOAD_MB: Number(env.MAX_UPLOAD_MB || 20),
  SMTP: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE ? bool(env.SMTP_SECURE, false) : Number(env.SMTP_PORT || 587) === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
    tlsRejectUnauthorized: bool(env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
  },
  // defaults for the settings page (the page can override them; stored in the database)
  DEFAULTS: {
    manager_emails: env.MANAGER_EMAILS || '',
    summary_enabled: bool(env.SUMMARY_ENABLED, true) ? '1' : '0',
    summary_day: env.SUMMARY_DAY || '1', // 0=Sun .. 6=Sat
    summary_time: env.SUMMARY_TIME || '08:00',
    summary_tz: env.SUMMARY_TIMEZONE || env.APP_TIMEZONE || 'America/New_York',
    summary_attach: bool(env.SUMMARY_ATTACH_RECEIPTS, false) ? '1' : '0',
  },
};
