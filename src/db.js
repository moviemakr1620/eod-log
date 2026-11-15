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
  leave_shop TEXT, on_set TEXT, start TEXT, wrap TEXT, wheels_up TEXT, return_shop TEXT,
  meals TEXT,
  hours_override REAL,
  edit_hours REAL,
  total_min INTEGER, work_min INTEGER, meal_min INTEGER, paid_min INTEGER,
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
`);

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (r) return r.value;
  return cfg.DEFAULTS[key] !== undefined ? cfg.DEFAULTS[key] : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value == null ? null : String(value));
}

module.exports = { db, getSetting, setSetting };
