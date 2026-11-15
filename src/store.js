const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const cfg = require('./config');
const H = require('../public/hours.js');
const { str, num, timeStr, isDate, JOB_TYPES, EXPENSE_CATS } = require('./util');

const ENTRY_FIELDS = ['date', 'job', 'job_type', 'client', 'location', 'tz', 'crew_chief', 'vehicle', 'vehicle_kind', 'driver', 'miles', 'tolls',
  'media_taken', 'media_used', 'equip_requested', 'equip_provided', 'issues', 'notes'];
const TIME_FIELDS = ['leave_shop', 'on_set', 'start', 'wrap', 'wheels_up', 'return_shop'];

function parseJSON(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } }

/** Validate + normalise a submitted form body. Returns { entry, crew, expenses, errors } */
function normalise(body) {
  const errors = [];
  const e = {
    date: isDate(body.date) ? body.date : null,
    job: str(body.job, 200),
    job_type: JOB_TYPES.includes(body.job_type) ? body.job_type : null,
    client: str(body.client, 200), location: str(body.location, 300), tz: str(body.tz, 60),
    crew_chief: str(body.crew_chief, 120), vehicle: str(body.vehicle, 120),
    vehicle_kind: ['company', 'personal', 'rental'].includes(body.vehicle_kind) ? body.vehicle_kind : null,
    driver: str(body.driver, 120), miles: num(body.miles), tolls: num(body.tolls),
    media_taken: str(body.media_taken, 300), media_used: str(body.media_used, 300),
    equip_requested: str(body.equip_requested), equip_provided: str(body.equip_provided),
    issues: str(body.issues), notes: str(body.notes, 10000),
  };
  if (!e.date) errors.push('Date is required');
  if (!e.job) errors.push('Job / project name is required');

  const crewIn = Array.isArray(parseJSON(body.crew_json, [])) ? parseJSON(body.crew_json, []) : [];
  const crew = [];
  crewIn.slice(0, 60).forEach((c) => {
    const name = str(c && c.name, 120);
    if (!name) return;
    const row = { name, role: str(c.role, 120), note: str(c.note, 1000), hours_override: num(c.hours_override), edit_hours: num(c.edit_hours) };
    TIME_FIELDS.forEach((f) => { row[f] = timeStr(c[f]); });
    row.meals = (Array.isArray(c.meals) ? c.meals : []).slice(0, 6)
      .map((m) => ({ start: timeStr(m && m.start), end: timeStr(m && m.end) }))
      .filter((m) => m.start || m.end);
    const r = H.compute(row);
    Object.assign(row, { total_min: r.totalMin, work_min: r.workMin, meal_min: r.mealMin, paid_min: r.paidMin });
    crew.push(row);
  });
  if (!crew.length) errors.push('Add at least one crew member');

  const expIn = Array.isArray(parseJSON(body.expenses_json, [])) ? parseJSON(body.expenses_json, []) : [];
  const expenses = [];
  expIn.slice(0, 100).forEach((x) => {
    if (!x) return;
    const row = {
      id: Number.isInteger(x.id) ? x.id : null, key: String(x.key || '').replace(/[^a-z0-9]/gi, '').slice(0, 20),
      person: str(x.person, 120), description: str(x.description, 300),
      category: EXPENSE_CATS.includes(x.category) ? x.category : null,
      amount: num(x.amount), paid_by: x.paid_by === 'personal' ? 'personal' : 'company',
    };
    if (row.amount === null && !row.description && !x.hasFiles) return;
    expenses.push(row);
  });
  return { entry: e, crew, expenses, errors };
}

const now = () => new Date().toISOString();

function insertCrew(entryId, crew) {
  const st = db.prepare(`INSERT INTO crew (entry_id,pos,name,role,leave_shop,on_set,start,wrap,wheels_up,return_shop,meals,hours_override,edit_hours,total_min,work_min,meal_min,paid_min,note)
    VALUES (@entry_id,@pos,@name,@role,@leave_shop,@on_set,@start,@wrap,@wheels_up,@return_shop,@meals,@hours_override,@edit_hours,@total_min,@work_min,@meal_min,@paid_min,@note)`);
  crew.forEach((c, i) => st.run({ ...c, entry_id: entryId, pos: i, meals: JSON.stringify(c.meals) }));
}

/** Saves expenses; returns map key -> expense id (for receipts). Existing ids are updated, missing ones deleted. */
function saveExpenses(entryId, expenses) {
  const existing = new Set(db.prepare('SELECT id FROM expenses WHERE entry_id=?').all(entryId).map((r) => r.id));
  const keep = new Set();
  const map = {};
  const ins = db.prepare('INSERT INTO expenses (entry_id,pos,person,description,category,amount,paid_by) VALUES (?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE expenses SET pos=?,person=?,description=?,category=?,amount=?,paid_by=? WHERE id=? AND entry_id=?');
  expenses.forEach((x, i) => {
    let id;
    if (x.id && existing.has(x.id)) { upd.run(i, x.person, x.description, x.category, x.amount, x.paid_by, x.id, entryId); id = x.id; }
    else id = ins.run(entryId, i, x.person, x.description, x.category, x.amount, x.paid_by).lastInsertRowid;
    keep.add(Number(id));
    if (x.key) map[x.key] = Number(id);
  });
  existing.forEach((id) => { if (!keep.has(id)) db.prepare('DELETE FROM expenses WHERE id=?').run(id); }); // receipts fall back to the entry (SET NULL)
  return map;
}

function addReceipts(entryId, files, keyMap) {
  const st = db.prepare('INSERT INTO receipts (entry_id,expense_id,stored,original,mime,size,created_at) VALUES (?,?,?,?,?,?,?)');
  (files || []).forEach((f) => {
    const m = /^file_x([a-z0-9]+)$/i.exec(f.fieldname);
    const expenseId = m && keyMap[m[1]] ? keyMap[m[1]] : null;
    st.run(entryId, expenseId, f.filename, String(f.originalname || '').slice(0, 200), f.mimetype, f.size, now());
  });
}

const create = db.transaction((data, files, user) => {
  const e = data.entry; const t = now();
  const cols = ENTRY_FIELDS.concat(['created_by', 'created_at', 'updated_at']);
  const id = db.prepare(`INSERT INTO entries (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run({ ...e, created_by: user || null, created_at: t, updated_at: t }).lastInsertRowid;
  insertCrew(id, data.crew);
  addReceipts(id, files, saveExpenses(id, data.expenses));
  return Number(id);
});

const update = db.transaction((id, data, files, deleteReceiptIds) => {
  const e = data.entry;
  db.prepare(`UPDATE entries SET ${ENTRY_FIELDS.map((c) => c + '=@' + c).join(',')}, updated_at=@updated_at WHERE id=@id`).run({ ...e, updated_at: now(), id });
  db.prepare('DELETE FROM crew WHERE entry_id=?').run(id);
  insertCrew(id, data.crew);
  addReceipts(id, files, saveExpenses(id, data.expenses));
  (deleteReceiptIds || []).forEach((rid) => removeReceipt(id, Number(rid)));
});

function removeReceipt(entryId, rid) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=? AND entry_id=?').get(rid, entryId);
  if (!r) return;
  db.prepare('DELETE FROM receipts WHERE id=?').run(rid);
  fs.rm(path.join(cfg.UPLOAD_DIR, path.basename(r.stored)), { force: true }, () => {});
}

function remove(id) {
  const files = db.prepare('SELECT stored FROM receipts WHERE entry_id=?').all(id);
  db.prepare('DELETE FROM entries WHERE id=?').run(id);
  files.forEach((f) => fs.rm(path.join(cfg.UPLOAD_DIR, path.basename(f.stored)), { force: true }, () => {}));
}

function hydrate(entries) {
  if (!entries.length) return entries;
  const ids = entries.map((e) => e.id);
  const q = (t, order) => db.prepare(`SELECT * FROM ${t} WHERE entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY ${order}`).all(...ids);
  const by = (rows) => rows.reduce((m, r) => ((m[r.entry_id] = m[r.entry_id] || []).push(r), m), {});
  const crew = by(q('crew', 'pos').map((c) => ({ ...c, meals: parseJSON(c.meals, []) })));
  const exp = by(q('expenses', 'pos'));
  const rec = by(q('receipts', 'id'));
  entries.forEach((e) => {
    e.crew = crew[e.id] || []; e.expenses = exp[e.id] || []; e.receipts = rec[e.id] || [];
    e.paid_min = e.crew.reduce((s, c) => s + (c.paid_min || 0), 0);
    e.expense_total = e.expenses.reduce((s, x) => s + (x.amount || 0), 0);
  });
  return entries;
}

const get = (id) => { const e = db.prepare('SELECT * FROM entries WHERE id=?').get(id); return e ? hydrate([e])[0] : null; };
const range = (from, to) => hydrate(db.prepare('SELECT * FROM entries WHERE date BETWEEN ? AND ? ORDER BY date, id').all(from, to));

function search({ q, type, person, from, to, limit = 50, offset = 0 }) {
  const where = [], args = [];
  if (q) {
    where.push(`(e.job LIKE ? OR e.client LIKE ? OR e.location LIKE ? OR e.notes LIKE ? OR e.issues LIKE ? OR e.crew_chief LIKE ?
      OR EXISTS (SELECT 1 FROM crew c WHERE c.entry_id=e.id AND c.name LIKE ?))`);
    const like = `%${q}%`; args.push(like, like, like, like, like, like, like);
  }
  if (type) { where.push('e.job_type = ?'); args.push(type); }
  if (person) { where.push('EXISTS (SELECT 1 FROM crew c WHERE c.entry_id=e.id AND c.name = ?)'); args.push(person); }
  if (from) { where.push('e.date >= ?'); args.push(from); }
  if (to) { where.push('e.date <= ?'); args.push(to); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM entries e ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT e.* FROM entries e ${w} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { total, entries: hydrate(rows) };
}

function suggestions() {
  const col = (sql) => db.prepare(sql).all().map((r) => r.v).filter(Boolean);
  return {
    people: col(`SELECT v FROM (SELECT name v, MAX(id) m FROM crew GROUP BY name UNION SELECT crew_chief v, MAX(id) m FROM entries WHERE crew_chief IS NOT NULL GROUP BY crew_chief) GROUP BY v ORDER BY MAX(m) DESC LIMIT 200`),
    jobs: col('SELECT job v FROM entries GROUP BY job ORDER BY MAX(date) DESC LIMIT 200'),
    clients: col('SELECT client v FROM entries WHERE client IS NOT NULL GROUP BY client ORDER BY MAX(date) DESC LIMIT 200'),
    locations: col('SELECT location v FROM entries WHERE location IS NOT NULL GROUP BY location ORDER BY MAX(date) DESC LIMIT 200'),
    vehicles: col('SELECT vehicle v FROM entries WHERE vehicle IS NOT NULL GROUP BY vehicle ORDER BY MAX(date) DESC LIMIT 100'),
    roles: col('SELECT role v FROM crew WHERE role IS NOT NULL GROUP BY role ORDER BY COUNT(*) DESC LIMIT 100'),
  };
}

const receipt = (id) => db.prepare('SELECT * FROM receipts WHERE id=?').get(id);

module.exports = { normalise, create, update, remove, get, range, search, suggestions, receipt, removeReceipt, TIME_FIELDS };
