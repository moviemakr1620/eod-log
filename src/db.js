const fs = require('fs');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.UPLOAD_DIR, { recursive: true });
const db = new Database(cfg.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  job TEXT NOT NULL,
  job_type TEXT,
  client TEXT,
  location TEXT,
  tz TEXT,
  crew_chief TEXT,
  vehicle TEXT,
  vehicle_kind TEXT,
  driver TEXT,
  miles REAL,
  tolls REAL,
  media_taken TEXT,
  media_used TEXT,
  equip_requested TEXT,
  equip_provided TEXT,
  issues TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
CREATE TABLE IF NOT EXISTS crew (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  role TEXT,
  leave_shop TEXT, on_set TEXT, start TEXT, stop TEXT, wheels_up TEXT, return_shop TEXT,
  meals TEXT,
  hours_override REAL,
  edit_hours REAL,
  total_min INTEGER, onsite_min INTEGER, meal_min INTEGER, paid_min INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS crew_entry ON crew(entry_id);
CREATE INDEX IF NOT EXISTS crew_name ON crew(name);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL DEFAULT 0,
  person TEXT,
  description TEXT,
  category TEXT,
  amount REAL,
  paid_by TEXT
);
CREATE INDEX IF NOT EXISTS expenses_entry ON expenses(entry_id);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  stored TEXT NOT NULL,
  original TEXT,
  mime TEXT,
  size INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_entry ON receipts(entry_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  recipients TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT 'weekly',  -- daily | weekdays | weekly
  weekday INTEGER NOT NULL DEFAULT 1,        -- weekly only, 0=Sun..6=Sat
  send_time TEXT NOT NULL DEFAULT '08:00',
  tz TEXT NOT NULL DEFAULT 'America/New_York',
  covers TEXT NOT NULL DEFAULT 'yesterday',  -- daily/weekdays: yesterday | today
  attach INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- one row per schedule+period: claimed BEFORE sending, so restarts/double ticks can't send twice
CREATE TABLE IF NOT EXISTS sends (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL,                      -- sending | sent | skipped | failed
  detail TEXT,
  entries INTEGER,
  at TEXT NOT NULL,
  UNIQUE (schedule_id, period_from, period_to)
);
`);

// Google Drive sync bookkeeping (Drive file IDs per entry / receipt, and the retry queue)
db.exec(`
CREATE TABLE IF NOT EXISTS drive_entries (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER UNIQUE,               -- NULL once the EOD was deleted (row then waits for its Drive folder to be marked/trashed)
  folder_id TEXT, folder_name TEXT, parent_id TEXT, pdf_id TEXT,
  synced_at TEXT, pending_delete INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE TABLE IF NOT EXISTS drive_files (
  stored TEXT PRIMARY KEY,               -- receipts.stored (random, never reused)
  entry_id INTEGER NOT NULL, file_id TEXT NOT NULL, name TEXT
);
CREATE TABLE IF NOT EXISTS drive_queue (
  entry_id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, queued_at TEXT
);
CREATE TABLE IF NOT EXISTS drive_folders (key TEXT PRIMARY KEY, file_id TEXT NOT NULL);
`);

// ---- migrations (PRAGMA user_version)
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
let ver = db.pragma('user_version', { simple: true });
if (ver < 2) {
  db.transaction(() => {
    const c = cols('crew');
    if (c.includes('wrap')) db.exec('ALTER TABLE crew RENAME COLUMN wrap TO stop');
    if (c.includes('work_min')) db.exec('ALTER TABLE crew RENAME COLUMN work_min TO onsite_min');
    // v2 hours rule: Stop - Start - meals (travel times no longer count). Recompute stored totals.
    const H = require('../public/hours.js');
    const upd = db.prepare('UPDATE crew SET total_min=?, onsite_min=?, meal_min=?, paid_min=? WHERE id=?');
    db.prepare('SELECT * FROM crew').all().forEach((r) => {
      let meals = []; try { meals = JSON.parse(r.meals || '[]') || []; } catch { /* keep [] */ }
      const x = H.compute({ ...r, meals });
      upd.run(x.totalMin, x.onSiteMin, x.mealMin, x.paidMin, r.id);
    });
    db.pragma('user_version = 2');
  })();
  ver = 2;
}

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (r) return r.value;
  return cfg.DEFAULTS[key] !== undefined ? cfg.DEFAULTS[key] : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? null : String(value));
}

// v3: move the single weekly summary (settings/env) into the first notification schedule
if (ver < 3) {
  db.transaction(() => {
    if (!db.prepare('SELECT COUNT(*) n FROM schedules').get().n) {
      const r = db.prepare(`INSERT INTO schedules (name,recipients,frequency,weekday,send_time,tz,covers,attach,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        'Weekly summary', getSetting('manager_emails') || '', 'weekly', Number(getSetting('summary_day') || 1), getSetting('summary_time') || '08:00',
        getSetting('summary_tz') || cfg.TZ, 'yesterday', getSetting('summary_attach') === '1' ? 1 : 0, getSetting('summary_enabled') === '0' ? 0 : 1, new Date().toISOString());
      const last = getSetting('summary_last_week'); // already sent this week under v1? don't send it again
      if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
        const end = new Date(Date.parse(last + 'T00:00:00Z') + 6 * 864e5).toISOString().slice(0, 10);
        db.prepare('INSERT OR IGNORE INTO sends (schedule_id,period_from,period_to,status,detail,at) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, last, end, 'sent', 'sent by v1', new Date().toISOString());
      }
    }
    db.pragma('user_version = 3');
  })();
}

module.exports = { db, getSetting, setSetting };
