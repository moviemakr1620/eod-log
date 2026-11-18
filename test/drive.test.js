// Google Drive sync against the local mock (scripts/mock-google.mjs): naming, device sign-in, queue, edits, deletes, retries.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eod-drive-'));
let mockServer, BASE, drive, store, db;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = async (p, method = 'POST') => (await fetch(BASE + p, { method })).json();
const state = () => mock('/mock/state', 'GET');
const tree = (s) => { // id -> path
  const by = Object.fromEntries(s.files.map((f) => [f.id, f]));
  const full = (f) => (f.parents && by[f.parents[0]] ? full(by[f.parents[0]]) + '/' : '') + f.name;
  return s.files.filter((f) => !f.inTrash).map(full).sort();
};
function fakeUpload(name, bytes, mime = 'image/jpeg', key = '1') {
  const filename = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${mime === 'application/pdf' ? '.pdf' : '.jpg'}`;
  const data = Buffer.alloc(bytes, 7); fs.writeFileSync(path.join(tmp, 'uploads', filename), data);
  return { fieldname: 'file_x' + key, filename, originalname: name, mimetype: mime, size: bytes };
}
const body = (o) => ({
  date: o.date || '2026-11-13', job: o.job || 'Villanova promo', job_type: 'Film shoot', client: 'Villanova', crew_chief: 'Jason',
  crew_json: JSON.stringify([{ name: 'Jason', role: 'DP', start: '07:00', stop: '17:00', meals: [{ start: '12:00', end: '12:30' }] }, { name: 'Sam', start: '08:00', stop: '16:00', on_set: '07:30', wheels_up: '16:30' }]),
  expenses_json: JSON.stringify(o.expenses || [{ key: '1', description: 'Lunch / crew', category: 'Meals', amount: '86.4', paid_by: 'personal', person: 'Jason', hasFiles: true }, { key: '2', description: 'Gas', category: 'Fuel', amount: '63.65', paid_by: 'company', hasFiles: true }]),
});

test.before(async () => {
  const { startMock } = await import('../scripts/mock-google.mjs');
  mockServer = await startMock(0);
  BASE = `http://127.0.0.1:${mockServer.address().port}`;
  Object.assign(process.env, { DATA_DIR: tmp, GDRIVE_API_BASE: BASE, GDRIVE_OAUTH_BASE: BASE, GDRIVE_RETRY_BASE_SEC: '0.05', GDRIVE_TICK_MS: '3600000' });
  ({ db } = require('../src/db'));
  drive = require('../src/drive');
  store = require('../src/store');
});
test.after(() => { mockServer.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('names are tidy, safe and sortable', () => {
  const n = () => drive.naming;
  assert.strictEqual(n().folderName({ date: '2026-11-13', job: 'Acme / Spring\npromo', job_type: 'Film shoot' }), 'Acme - Spring promo (Film shoot)');
  assert.strictEqual(n().dayName('2026-11-13'), '2026-11-13'); assert.strictEqual(n().yearName('2026-11-13'), '2026');
  assert.strictEqual(n().pdfName({ date: '2026-11-13', job: 'Gala' }), 'EOD 2026-11-13 Gala.pdf');
  assert.strictEqual(n().monthName('2026-03-02'), '03 March');
  assert.ok(n().folderName({ date: '2026-01-01', job: 'x'.repeat(400) }).length <= 120);
  const e = { date: '2026-11-13', job: 'Gala', expenses: [{ id: 1, description: 'Lunch', amount: 86.4, paid_by: 'personal' }, { id: 2, description: null, category: 'Fuel', amount: 63.65, paid_by: 'company' }],
    receipts: [{ stored: 'a.jpg', expense_id: 1, mime: 'image/jpeg' }, { stored: 'b.jpg', expense_id: 2, mime: 'image/jpeg' }, { stored: 'c.pdf', expense_id: 2, mime: 'application/pdf' }, { stored: 'd.png', expense_id: null, mime: 'image/png' }] };
  assert.deepStrictEqual(n().receiptNames(e), {
    'a.jpg': '2026-11-13 Gala - Lunch - $86.40 (Personal).jpg',
    'b.jpg': '2026-11-13 Gala - Fuel - $63.65 (Card) 1.jpg',
    'c.pdf': '2026-11-13 Gala - Fuel - $63.65 (Card) 2.pdf',
    'd.png': '2026-11-13 Gala - Receipt 1.png',
  });
  assert.strictEqual(drive.backoff(1), 50); assert.strictEqual(drive.backoff(3), 200);
});

test('device sign-in, upload, edit, move, retry, delete, sharing, disconnect', async () => {
  assert.strictEqual(drive.connected(), false);
  drive.enqueue(1); assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_queue').get().n, 0, 'nothing queued while not connected');
  drive.S.set('client_id', 'test-client.apps.googleusercontent.com'); drive.S.set('client_secret', 'test-secret');
  const dev = await drive.startDevice();
  assert.match(dev.user_code, /^MOCK-/); assert.strictEqual(dev.verification_url, 'https://www.google.com/device');
  await sleep(1300); assert.strictEqual(drive.deviceState().state, 'waiting');
  await mock('/mock/approve');
  for (let i = 0; i < 30 && drive.deviceState().state === 'waiting'; i++) await sleep(200);
  assert.strictEqual(drive.deviceState().state, 'done');
  assert.ok(drive.connected()); assert.strictEqual(drive.status().account, 'jason@kpi.example');

  // create an EOD with 2 expenses + 3 receipt files (one > 5 MB to force a resumable upload)
  const d = store.normalise(body({}));
  const files = [fakeUpload('lunch.jpg', 2000, 'image/jpeg', '1'), fakeUpload('gas1.jpg', 3000, 'image/jpeg', '2'), fakeUpload('gas2.pdf', 5.5 * 1024 * 1024, 'application/pdf', '2')];
  const id = store.create(d, files, 'Jason');
  drive.enqueue(id);
  await drive.runOnce();
  let s = await state();
  assert.deepStrictEqual(tree(s), [
    'EOD Log', 'EOD Log/2026', 'EOD Log/2026/11 November', 'EOD Log/2026/11 November/2026-11-13', 'EOD Log/2026/11 November/2026-11-13/Villanova promo (Film shoot)',
    'EOD Log/2026/11 November/2026-11-13/Villanova promo (Film shoot)/2026-11-13 Villanova promo - Gas - $63.65 (Card) 1.jpg',
    'EOD Log/2026/11 November/2026-11-13/Villanova promo (Film shoot)/2026-11-13 Villanova promo - Gas - $63.65 (Card) 2.pdf',
    'EOD Log/2026/11 November/2026-11-13/Villanova promo (Film shoot)/2026-11-13 Villanova promo - Lunch - crew - $86.40 (Personal).jpg',
    'EOD Log/2026/11 November/2026-11-13/Villanova promo (Film shoot)/EOD 2026-11-13 Villanova promo.pdf',
  ]);
  assert.ok(s.calls.some((c) => c.endsWith('uploadType=resumable')) && s.calls.some((c) => c.endsWith('uploadType=multipart')), 'small files multipart, big file resumable');
  const big = s.files.find((f) => f.name.endsWith('2.pdf')); assert.strictEqual(big.size, 5.5 * 1024 * 1024);
  const pdf = s.files.find((f) => /^EOD 2026.*\.pdf$/.test(f.name)); assert.ok(pdf.size > 1500, 'entry PDF uploaded');
  assert.strictEqual(drive.status().pending, 0); assert.strictEqual(drive.status().synced, 1);

  // edit: rename job, delete one receipt, add one, change an amount -> folder renamed, PDF replaced in place, receipts follow
  const e1 = store.get(id);
  const gas1 = e1.receipts.find((r) => r.original === 'gas1.jpg');
  const exps = e1.expenses.map((x) => ({ id: x.id, key: String(x.id), description: x.description, category: x.category, amount: x.description === 'Gas' ? '70' : String(x.amount), paid_by: x.paid_by }));
  const d2 = store.normalise({ ...body({ job: 'Villanova commencement', expenses: exps }) });
  store.update(id, d2, [fakeUpload('new.jpg', 1500, 'image/jpeg', String(exps[0].id))], [gas1.id]);
  drive.enqueue(id); await drive.runOnce();
  s = await state();
  const live = tree(s).filter((x) => x.includes('Villanova'));
  assert.deepStrictEqual(live.map((x) => x.split('/').pop()), [
    'Villanova commencement (Film shoot)',
    '2026-11-13 Villanova commencement - Gas - $70.00 (Card).pdf',
    '2026-11-13 Villanova commencement - Lunch - crew - $86.40 (Personal) 1.jpg',
    '2026-11-13 Villanova commencement - Lunch - crew - $86.40 (Personal) 2.jpg',
    'EOD 2026-11-13 Villanova commencement.pdf',
  ]);
  const pdf2 = s.files.find((f) => f.id === pdf.id);
  assert.ok(pdf2.versions === 2 && pdf2.name === 'EOD 2026-11-13 Villanova commencement.pdf', 'same PDF file updated (new version)');
  assert.ok(s.files.find((f) => f.name.includes('(Card) 1.jpg')).inTrash, 'removed receipt trashed in Drive');

  // date moved to December -> folder moved into a new month folder
  store.update(id, store.normalise(body({ job: 'Villanova commencement', date: '2026-12-02', expenses: exps })), [], []);
  drive.enqueue(id); await drive.runOnce();
  s = await state();
  assert.ok(tree(s).includes('EOD Log/2026/12 December/2026-12-02/Villanova commencement (Film shoot)'));

  // a failing Drive call is retried with backoff, never lost
  await mock('/mock/fail?n=1&status=503&reason=backendError');
  store.update(id, store.normalise(body({ job: 'Retry job', date: '2026-12-02', expenses: exps })), [], []);
  drive.enqueue(id); await drive.runOnce();
  let q = db.prepare('SELECT * FROM drive_queue WHERE entry_id=?').get(id);
  assert.ok(q && q.attempts === 1 && /503/.test(q.last_error), 'failure recorded');
  assert.strictEqual(drive.status().failing, 1);
  await sleep(80); await drive.runOnce();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_queue').get().n, 0, 'retried and done');
  assert.ok(tree(await state()).some((x) => x.endsWith('2026-12-02/Retry job (Film shoot)')));

  // someone trashes the whole root folder in Drive -> a fresh tree is made on the next sync
  await mock('/mock/trash?id=' + drive.S.get('root_id'));
  drive.enqueueAll();
  // root is only re-checked every 10 min; force it like the Test button does
  await drive.test(); await drive.runOnce();
  s = await state();
  assert.ok(tree(s).includes('EOD Log/2026/12 December/2026-12-02/Retry job (Film shoot)/EOD 2026-12-02 Retry job.pdf'), 'recreated after root was trashed');

  // delete in the app -> the job folder goes to the trash (not renamed), and the emptied day + month folders are tidied up
  const treeBefore = tree(await state()); assert.ok(treeBefore.some((x) => x.endsWith('2026-12-02/Retry job (Film shoot)')));
  drive.onDelete(id); store.remove(id); await drive.runOnce();
  s = await state();
  assert.ok(!tree(s).some((x) => x.includes('Retry job')), 'job folder trashed'); assert.ok(!s.files.some((f) => f.name.startsWith('(deleted)')), 'no "(deleted)" rename any more');
  assert.ok(s.files.find((f) => f.name === 'Retry job (Film shoot)').inTrash);
  assert.ok(!tree(s).some((x) => x.includes('2026-12-02')) && !tree(s).some((x) => x.includes('12 December')), 'empty day + month folders tidied up');
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM drive_folders WHERE key IN ('d:2026-12-02','m:2026-12')").get().n, 0);
  assert.deepStrictEqual(tree(s), ['EOD Log'], 'year folder tidied too (nothing left in it); the root folder stays');
  const id2 = store.create(store.normalise(body({ job: 'Trash me', expenses: [] })), [], 'Jason');
  drive.enqueue(id2); await drive.runOnce();
  assert.ok(tree(await state()).some((x) => x.endsWith('Trash me (Film shoot)')));
  drive.onDelete(id2); store.remove(id2); await drive.runOnce();
  assert.ok(!tree(await state()).some((x) => x.includes('Trash me')));

  // sharing: add two, then drop one; blocked addresses report an error
  let errs = await drive.applySharing(['a@kpi.example', 'b@kpi.example', 'x@blocked.example'], 'reader');
  assert.strictEqual(errs.length, 1); assert.match(errs[0], /blocked/);
  s = await state(); assert.deepStrictEqual(s.perms[drive.S.get('root_id')].map((p) => p.emailAddress).sort(), ['a@kpi.example', 'b@kpi.example']);
  errs = await drive.applySharing(['b@kpi.example'], 'writer');
  s = await state(); assert.deepStrictEqual(s.perms[drive.S.get('root_id')].map((p) => `${p.emailAddress}:${p.role}`), ['b@kpi.example:writer']);

  // disconnect revokes the token; a revoked token shows "connect again"
  await drive.disconnect();
  assert.strictEqual(drive.connected(), false); assert.strictEqual((await state()).revoked, 1);
});

test('service account + Shared Drive folder', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const shared = (await mock('/mock/folder?name=KPI%20Shared%20EODs')).id;
  drive.S.set('mode', 'sa'); drive.resetToken(); drive.resetMapping();
  drive.S.set('sa_json', JSON.stringify({ type: 'service_account', client_email: 'eod@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  drive.S.set('shared_folder_id', shared);
  assert.ok(drive.connected()); assert.strictEqual(drive.status().account, 'eod@proj.iam.gserviceaccount.com');
  const id = store.create(store.normalise(body({ job: 'SA job', expenses: [] })), [], 'Jason');
  drive.enqueue(id); await drive.runOnce();
  assert.ok(tree(await state()).includes('KPI Shared EODs/2026/11 November/2026-11-13/SA job (Film shoot)/EOD 2026-11-13 SA job.pdf'));
});


// ---------- layout: year > month > day > job, existing folders are moved, not duplicated
const CAL = 'https://www.googleapis.com/auth/calendar';
const reconnect = async () => { // desktop-app sign-in: "paste the address" flow
  const link = drive.startLink();
  const q = new URL(link.url).searchParams;
  assert.strictEqual(q.get('redirect_uri'), 'http://127.0.0.1:9004'); assert.strictEqual(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('scope').includes(CAL) && q.get('scope').includes('drive.file'));
  await mock('/mock/code-reset');
  await drive.finishLink(`http://127.0.0.1:9004/?state=${q.get('state')}&code=MOCKCODE&scope=x`);
};
const freshOauth = () => {
  drive.resetToken(); drive.S.set('mode', 'oauth');
  drive.S.set('client_id', 'test-client.apps.googleusercontent.com'); drive.S.set('client_secret', 'test-secret'); drive.S.set('client_type', 'desktop');
  drive.S.del('root_id'); drive.resetMapping(); db.exec('DELETE FROM entries');
};

test('paste-the-address sign-in: state is checked, code is exchanged once, scopes are remembered', async () => {
  await mock('/mock/reset'); freshOauth();
  assert.strictEqual(drive.clientType(), 'desktop');
  const link = drive.startLink(); const st = new URL(link.url).searchParams.get('state');
  await assert.rejects(drive.finishLink('http://127.0.0.1:9004/?state=WRONG&code=MOCKCODE'), /older sign-in/);
  await assert.rejects(drive.finishLink('http://127.0.0.1:9004/?state=' + st + '&error=access_denied'), /denied/);
  await assert.rejects(drive.finishLink('nothing useful'), /No code found/);
  await drive.finishLink('http://127.0.0.1:9004/?state=' + st + '&code=MOCKCODE&scope=a');
  assert.ok(drive.connected()); assert.strictEqual(drive.status().account, 'jason@kpi.example'); assert.ok(drive.calendarScopeOk());
  assert.strictEqual(drive.status().link, null);
  // Google's device flow refuses Calendar: that is why Calendar needs this flow
  const r = await fetch(BASE + '/device/code', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'test-client.apps.googleusercontent.com', scope: 'https://www.googleapis.com/auth/drive.file ' + CAL }) });
  assert.strictEqual(r.status, 400);
  // a device-flow sign-in only gets drive.file -> Calendar would need a reconnect
  drive.S.set('client_type', 'tv'); await drive.startDevice(); await mock('/mock/approve');
  for (let i = 0; i < 30 && drive.deviceState().state === 'waiting'; i++) await sleep(200);
  assert.strictEqual(drive.deviceState().state, 'done'); assert.strictEqual(drive.calendarScopeOk(), false);
});

test('old layout (year > "2026-10 October" > "2026-10-05 Job (Type)") moves to year > month > day > job, in the same Drive folders', async () => {
  await mock('/mock/reset'); freshOauth(); await reconnect();
  const e = store.create(store.normalise(body({ job: 'Legacy job', date: '2026-10-05', expenses: [] })), [], 'Jason');
  drive.enqueue(e); await drive.runOnce();
  const before = await state();
  const jobFolder = before.files.find((f) => f.name === 'Legacy job (Film shoot)');
  const monthF = before.files.find((f) => f.name === '10 October');
  assert.ok(jobFolder && monthF);
  // make Drive + the bookkeeping look like the previous version made them
  const oldName = '2026-10-05 Legacy job (Film shoot)';
  await mock(`/mock/rename?id=${monthF.id}&name=${encodeURIComponent('2026-10 October')}`);
  await mock(`/mock/rename?id=${jobFolder.id}&name=${encodeURIComponent(oldName)}`);
  await mock(`/mock/move?id=${jobFolder.id}&to=${monthF.id}`);
  db.prepare("UPDATE drive_folders SET name=NULL WHERE key LIKE 'm:%'").run();
  db.prepare("DELETE FROM drive_folders WHERE key LIKE 'd:%'").run();
  db.prepare('UPDATE drive_entries SET folder_name=?, parent_id=? WHERE entry_id=?').run(oldName, monthF.id, e);
  drive.S.del('layout'); drive.migrateLayout();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_queue WHERE entry_id=?').get(e).n, 1, 'migration queues entries that are already in Drive');
  await drive.runOnce();
  const s = await state();
  assert.ok(tree(s).includes('EOD Log/2026/10 October/2026-10-05/Legacy job (Film shoot)/EOD 2026-10-05 Legacy job.pdf'), tree(s).join('\n'));
  assert.strictEqual(s.files.find((f) => f.id === jobFolder.id).name, 'Legacy job (Film shoot)', 'same folder, renamed and moved');
  assert.strictEqual(s.files.find((f) => f.id === monthF.id).name, '10 October', 'month folder renamed in place');
  assert.strictEqual(s.files.filter((f) => /October/.test(f.name)).length, 1, 'no second month folder');
  assert.strictEqual(s.files.filter((f) => /Legacy job/.test(f.name) && !f.name.startsWith('EOD')).length, 1, 'no duplicate job folder');
  // two EODs for the same job + day get their own folders
  const a = store.create(store.normalise(body({ job: 'Twin job', expenses: [] })), [], 'Jason');
  const b = store.create(store.normalise(body({ job: 'Twin job', expenses: [] })), [], 'Jason');
  drive.enqueue(a); drive.enqueue(b); await drive.runOnce();
  const t = tree(await state());
  assert.ok(t.some((x) => x.endsWith('2026-11-13/Twin job (Film shoot)/EOD 2026-11-13 Twin job.pdf')) && t.some((x) => x.endsWith('2026-11-13/Twin job (Film shoot) #2/EOD 2026-11-13 Twin job.pdf')), t.join('\n'));
});

// ---------- Google Calendar
const gcal = () => require('../src/gcal');

test('calendar event times: always all-day (date + next day); the crew time range goes in the description', () => {
  const g = gcal();
  const allDay = (t, d, d2) => assert.deepStrictEqual([t.allDay, t.start, t.end], [true, { date: d }, { date: d2 }]);
  const t = g.eventTimes({ date: '2026-11-13', tz: 'America/New_York', crew: [{ start: '08:00', stop: '16:00' }, { start: '07:00', stop: '17:30' }] });
  allDay(t, '2026-11-13', '2026-11-14'); assert.strictEqual(t.range, '7:00am–5:30pm');
  const n = g.eventTimes({ date: '2026-11-13', crew: [{ start: '18:00', stop: '02:00' }] });
  allDay(n, '2026-11-13', '2026-11-14'); assert.strictEqual(n.range, '6:00pm–2:00am (+1 day)');
  const y = g.eventTimes({ date: '2026-12-31', crew: [{ on_set: '22:00', wheels_up: '01:00' }] });
  allDay(y, '2026-12-31', '2027-01-01'); assert.strictEqual(y.range, '10:00pm–1:00am (+1 day)');
  const none = g.eventTimes({ date: '2026-11-13', crew: [{ name: 'x' }] }); allDay(none, '2026-11-13', '2026-11-14'); assert.strictEqual(none.range, null);
  assert.strictEqual(g.eventTimes({ date: '2026-11-13', crew: [{ start: '09:00' }] }).range, '9:00am');
  const e = { id: 1, date: '2026-11-13', job: 'Gala', crew: [{ name: 'A', start: '07:00', stop: '18:30' }], expenses: [] };
  assert.ok(g.description(e).startsWith('Crew times 7:00am–6:30pm\n'));
  assert.ok(!g.description({ ...e, crew: [{ name: 'A' }] }).includes('Crew times'));
  const b = g.eventBody(e, null), pb = g.eventBody(e, null, { patch: true });
  assert.deepStrictEqual([b.start, b.end], [{ date: '2026-11-13' }, { date: '2026-11-14' }]);
  assert.deepStrictEqual([pb.start, pb.end], [{ date: '2026-11-13', dateTime: null, timeZone: null }, { date: '2026-11-14', dateTime: null, timeZone: null }]);
  assert.strictEqual(g.eventTitle({ job: 'Gala', job_type: 'Live event' }), 'Gala (Live event) – EOD');
});

test('calendar (OAuth): own calendar is created, one event per EOD with the PDF attached, edits patch it, delete removes the event', async () => {
  await mock('/mock/reset'); freshOauth(); await reconnect();
  const g = gcal();
  // not switched on: nothing is created
  const e0 = store.create(store.normalise(body({ job: 'Before calendar', expenses: [] })), [], 'Jason');
  drive.enqueue(e0); await drive.runOnce();
  assert.strictEqual((await state()).cals.length, 0);
  g.S.set('cal_on', '1'); g.S.set('cal_name', 'KPI EODs');
  assert.ok(g.usable());
  const id = store.create(store.normalise(body({ job: 'Gala', expenses: [{ key: '1', description: 'Lunch', category: 'Meals', amount: '86.4', paid_by: 'personal', person: 'Jason' }] })), [], 'Jason');
  db.prepare("UPDATE entries SET tz='America/New_York', vehicle='Sprinter', miles=120, notes='Strike took long' WHERE id=?").run(id);
  g.enqueueAll(); drive.enqueue(id); await drive.runOnce();
  let s = await state();
  assert.strictEqual(s.cals.length, 1); assert.strictEqual(s.cals[0].summary, 'KPI EODs'); assert.strictEqual(s.cals[0].timeZone, 'America/New_York');
  const ev = s.events.find((x) => x.summary === 'Gala (Film shoot) – EOD');
  assert.ok(ev, 'event for Gala'); assert.strictEqual(s.events.length, 2, 'one event per EOD (Gala + the earlier one)');
  assert.deepStrictEqual([ev.start, ev.end], [{ date: '2026-11-13' }, { date: '2026-11-14' }], 'all-day, never timed');
  assert.match(ev.description, /^Crew times 7:00am–5:00pm\n/);
  const pdf = s.files.find((f) => f.name === 'EOD 2026-11-13 Gala.pdf');
  assert.strictEqual(ev.attachments.length, 1); assert.strictEqual(ev.attachments[0].fileId, pdf.id);
  assert.strictEqual(ev.attachments[0].fileUrl, `https://drive.google.com/file/d/${pdf.id}/view`); assert.strictEqual(ev.attachments[0].mimeType, 'application/pdf'); assert.strictEqual(ev.attachments[0].title, 'EOD 2026-11-13 Gala.pdf');
  assert.match(ev.description, /Total hours: 17\.5 h · On set hours: 9 h/); assert.match(ev.description, /Jason \(DP\): 7:00am–5:00pm, meal 12:00pm–12:30pm/); assert.match(ev.description, /on set 9 h, total 8 h/);
  assert.match(ev.description, /EXPENSES: \$86\.40 \(\$86\.40 to reimburse\)/); assert.match(ev.description, /Sprinter/); assert.match(ev.description, /120 mi/); assert.match(ev.description, /Strike took long/);
  assert.ok(s.calls.some((c) => /^POST \/calendar\/v3\/calendars$/.test(c)), 'calendars.insert');
  assert.strictEqual(g.status().synced, 2); assert.strictEqual(g.status().pending, 0);

  // edit: same event is patched (not duplicated), still with the (same) PDF; the PDF was re-uploaded BEFORE the calendar call
  store.update(id, store.normalise(body({ job: 'Gala night', expenses: [] })), [], []);
  drive.enqueue(id); await drive.runOnce();
  s = await state();
  assert.strictEqual(s.events.length, 2); const ev2 = s.events.find((x) => x.id === ev.id);
  assert.strictEqual(ev2.summary, 'Gala night (Film shoot) – EOD'); assert.strictEqual(s.cals.length, 1, 'calendar reused');
  const calls = s.calls; // order in the log: the PDF is replaced in Drive first, then the event is patched
  assert.ok(calls.lastIndexOf('PATCH /calendar/v3/calendars/' + encodeURIComponent(s.cals[0].id) + '/events/' + ev.id) > calls.lastIndexOf('PATCH /upload/drive/v3/files/' + pdf.id + '?uploadType=multipart'), calls.slice(-8).join('\n'));
  assert.ok(s.calls.some((c) => c.includes('/events/') && c.startsWith('PATCH')), 'events.patch');

  // an event an older version made as a TIMED one converts to all-day on the next patch (same event id)
  await mock(`/mock/event-timed?id=${ev.id}`);
  s = await state(); assert.ok(s.events.find((x) => x.id === ev.id).start.dateTime, 'precondition: timed');
  store.update(id, store.normalise(body({ job: 'Gala night', expenses: [] })), [], []); drive.enqueue(id); await drive.runOnce();
  s = await state(); const conv = s.events.find((x) => x.id === ev.id);
  assert.deepStrictEqual([conv.start, conv.end], [{ date: '2026-11-13' }, { date: '2026-11-14' }], 'converted to all-day, no dateTime/timeZone left');
  assert.strictEqual(s.events.length, 2, 'converted in place, not duplicated');

  // someone deletes the event in Google Calendar -> next edit makes a fresh one
  await mock(`/mock/event-delete?id=${ev.id}`);
  store.update(id, store.normalise(body({ job: 'Gala night', expenses: [] })), [], []); drive.enqueue(id); await drive.runOnce();
  s = await state(); assert.strictEqual(s.events.filter((x) => x.status !== 'cancelled' && x.summary.startsWith('Gala night')).length, 1);

  // calendar renamed in Settings -> the calendar is renamed, not duplicated
  g.S.set('cal_name', 'KPI Crew EODs'); g.settingsChanged(); store.update(id, store.normalise(body({ job: 'Gala night', expenses: [] })), [], []); drive.enqueue(id); await drive.runOnce();
  s = await state(); assert.strictEqual(s.cals.length, 1); assert.strictEqual(s.cals[0].summary, 'KPI Crew EODs');

  // transient Calendar failure -> retried with backoff, Drive files are NOT re-uploaded
  await mock('/mock/fail?n=1&status=503&reason=backendError');
  store.update(id, store.normalise(body({ job: 'Gala retry', expenses: [] })), [], []); drive.enqueue(id);
  await drive.runOnce(); // the Drive step eats the injected failure here...
  await sleep(80); await drive.runOnce(); await sleep(80); await drive.runOnce();
  s = await state(); assert.ok(s.events.some((x) => x.summary === 'Gala retry (Film shoot) – EOD'), 'event updated after retry');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cal_queue').get().n, 0); assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_queue').get().n, 0);

  // delete in the app: the event is deleted (no "(deleted)" prefix)
  drive.onDelete(id); store.remove(id); await drive.runOnce();
  s = await state(); assert.ok(!s.events.some((x) => /Gala retry/.test(x.summary)), 'event removed'); assert.ok(!s.events.some((x) => x.summary.startsWith('(deleted)')));
  const id2 = store.create(store.normalise(body({ job: 'Temp', expenses: [] })), [], 'Jason'); drive.enqueue(id2); await drive.runOnce();
  assert.ok((await state()).events.some((x) => x.summary.startsWith('Temp ')));
  drive.onDelete(id2); store.remove(id2); await drive.runOnce();
  assert.ok(!(await state()).events.some((x) => x.summary.startsWith('Temp ')), 'event removed');

  // the Test button: finds the calendar, adds + removes a test event
  const before = (await state()).events.length; const r = await g.test(); assert.strictEqual(r.name, 'KPI Crew EODs'); assert.strictEqual((await state()).events.length, before);

  // switching calendars (paste mode) puts events on the other calendar
  const other = (await mock('/mock/calendar?name=Other')).id;
  g.S.set('cal_mode', 'paste'); g.S.set('cal_paste_id', other); g.settingsChanged({ calendarSwitched: true }); await drive.runOnce();
  s = await state(); assert.ok(s.events.filter((x) => x.calendarId === other).length >= 1, 'events created on the pasted calendar');
  g.S.set('cal_mode', 'auto');
});

test('calendar: no Calendar scope -> "reconnect" state, nothing is called; Calendar API off -> clear error', async () => {
  await mock('/mock/reset'); freshOauth(); await mock('/mock/grant?scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive.file')); await reconnect();
  const g = gcal(); g.S.set('cal_on', '1');
  assert.strictEqual(drive.calendarScopeOk(), false); assert.strictEqual(g.needsReconnect(), true); assert.strictEqual(g.usable(), false); assert.strictEqual(g.status().needsReconnect, true);
  const id = store.create(store.normalise(body({ job: 'NoScope', expenses: [] })), [], 'Jason'); drive.enqueue(id); await drive.runOnce();
  let s = await state(); assert.strictEqual(s.cals.length, 0); assert.ok(!s.calls.some((c) => c.includes('/calendar/')), 'no calendar calls without the scope');
  assert.ok(s.files.some((f) => f.name === 'EOD 2026-11-13 NoScope.pdf'), 'Drive still works');
  await assert.rejects(g.test(), /Reconnect to enable Calendar/);
  // reconnect with the scope -> catches up
  await mock('/mock/grant?scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive.file ' + CAL)); await reconnect();
  assert.strictEqual(g.usable(), true); g.enqueueAll(); await drive.runOnce();
  assert.strictEqual((await state()).events.length, 1);
  // Calendar API not enabled in the Google Cloud project
  await mock('/mock/calapi-off');
  store.update(id, store.normalise(body({ job: 'NoScope', expenses: [] })), [], []); drive.enqueue(id); await drive.runOnce();
  const row = db.prepare('SELECT * FROM cal_queue WHERE entry_id=?').get(id);
  assert.ok(row && /Google Calendar API is not turned on/.test(row.last_error), row && row.last_error);
  await mock('/mock/calapi-off?off=0');
});

test('calendar (service account): needs a calendar shared with it; works once shared', async () => {
  await mock('/mock/reset');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const shared = (await mock('/mock/folder?name=KPI%20Shared%20EODs')).id;
  drive.S.set('mode', 'sa'); drive.resetToken(); drive.resetMapping(); db.exec('DELETE FROM entries');
  drive.S.set('sa_json', JSON.stringify({ type: 'service_account', client_email: 'eod@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  drive.S.set('shared_folder_id', shared);
  const g = gcal(); g.S.set('cal_on', '1'); g.S.set('cal_paste_id', '');
  assert.strictEqual(g.calMode(), 'paste'); assert.ok(drive.calendarScopeOk());
  const id = store.create(store.normalise(body({ job: 'SA cal job', expenses: [] })), [], 'Jason'); drive.enqueue(id); await drive.runOnce();
  let row = db.prepare('SELECT * FROM cal_queue WHERE entry_id=?').get(id);
  assert.ok(row && /Paste a calendar ID/.test(row.last_error), row && row.last_error);
  g.S.set('cal_paste_id', 'nobody@group.calendar.google.com'); g.enqueueAll(); await drive.runOnce(); // not shared with the service account
  row = db.prepare('SELECT * FROM cal_queue WHERE entry_id=?').get(id);
  assert.ok(row && /not shared with the service account/.test(row.last_error), row && row.last_error);
  const cal = (await mock('/mock/calendar?name=EOD%20Log&sa=1')).id;
  g.S.set('cal_paste_id', cal); db.prepare('UPDATE cal_queue SET attempts=0,next_at=0').run(); g.enqueueAll(); await drive.runOnce();
  const s = await state(); const ev = s.events.find((x) => x.calendarId === cal);
  assert.ok(ev && ev.summary === 'SA cal job (Film shoot) – EOD' && ev.attachments[0].fileUrl.includes('/file/d/'), 'event on the shared calendar with the PDF');
  assert.strictEqual(s.cals.filter((c) => !c.sa).length, 0, 'service account mode never creates calendars');
});

test('client type vs Client ID: switching the type without replacing the ID is flagged and Connect refuses', async () => {
  const S = drive.S;
  const keep = ['client_id', 'client_type', 'client_id_type'].map((k) => [k, S.get(k)]);
  try {
    S.set('client_id', 'old-tv.apps.googleusercontent.com'); S.set('client_secret', 'x'); S.set('client_type', 'tv'); S.set('client_id_type', '');
    // Settings save: type switched to desktop, same ID -> the ID stays recorded as a TV client
    S.set('client_type', 'desktop'); drive.noteClientId({ id: 'old-tv.apps.googleusercontent.com', type: 'tv' }, { id: 'old-tv.apps.googleusercontent.com', type: 'desktop' });
    assert.strictEqual(drive.idTypeMismatch(), 'tv');
    assert.throws(() => drive.startLink(), /invalid_request/);
    await assert.rejects(() => drive.startDevice(), /invalid_request/);
    // a new ID entered while the type is desktop -> recorded as desktop, no mismatch
    S.set('client_id', 'new-desktop.apps.googleusercontent.com'); drive.noteClientId({ id: 'old-tv.apps.googleusercontent.com', type: 'desktop' }, { id: 'new-desktop.apps.googleusercontent.com', type: 'desktop' });
    assert.strictEqual(drive.idTypeMismatch(), ''); assert.doesNotThrow(() => drive.startLink()); drive.cancelLink();
  } finally { keep.forEach(([k, v]) => S.set(k, v || '')); drive.cancelLink(); }
});

// ---------- edit / delete / clear all: Drive + Calendar stay in step, nothing is duplicated or left behind
const calOn = () => { const g = gcal(); g.S.set('cal_on', '1'); g.S.set('cal_mode', 'auto'); g.S.set('cal_name', 'KPI EODs'); g.S.del('cal_auto_id'); g.S.del('cal_auto_name'); return g; };
const names = (s, pred) => tree(s).filter(pred);

test('editing an EOD (job + date change): same folder moved/renamed, PDF + receipts replaced, same event moved; no duplicates; old day folder tidied', async () => {
  await mock('/mock/reset'); freshOauth(); await reconnect(); calOn();
  const files = [fakeUpload('lunch.jpg', 2000, 'image/jpeg', '1'), fakeUpload('gas.jpg', 3000, 'image/jpeg', '2')];
  const id = store.create(store.normalise(body({ job: 'Gala', date: '2026-11-13' })), files, 'Jason');
  drive.enqueue(id); await drive.runOnce();
  let s = await state();
  const de = db.prepare('SELECT * FROM drive_entries WHERE entry_id=?').get(id); const ce = db.prepare('SELECT * FROM cal_entries WHERE entry_id=?').get(id);
  assert.ok(de.folder_id && de.pdf_id && ce.event_id);
  assert.strictEqual(s.events.length, 1); assert.deepStrictEqual(s.events[0].start, { date: '2026-11-13' });

  // change the date (other MONTH), rename the job, drop one receipt, add one
  const e = store.get(id); const gas = e.receipts.find((r) => r.original === 'gas.jpg');
  const exps = e.expenses.map((x) => ({ id: x.id, key: String(x.id), description: x.description, category: x.category, amount: String(x.amount), paid_by: x.paid_by }));
  store.update(id, store.normalise(body({ job: 'Gala night', date: '2026-12-02', expenses: exps })), [fakeUpload('new.jpg', 1500, 'image/jpeg', String(exps[0].id))], [gas.id]);
  drive.enqueue(id); await drive.runOnce();
  s = await state();
  const jobFolders = s.files.filter((f) => /^Gala/.test(f.name) && f.mimeType === 'application/vnd.google-apps.folder');
  assert.strictEqual(jobFolders.length, 1, 'one job folder, not two'); assert.strictEqual(jobFolders[0].id, de.folder_id, 'the same folder was moved + renamed');
  const live = tree(s);
  assert.ok(live.includes('EOD Log/2026/12 December/2026-12-02/Gala night (Film shoot)/EOD 2026-12-02 Gala night.pdf'));
  assert.strictEqual(live.filter((x) => x.endsWith('EOD 2026-12-02 Gala night.pdf')).length, 1, 'one PDF');
  assert.ok(!live.some((x) => /2026-11-13|11 November/.test(x)), 'old day + month folders were tidied: ' + live.join('\n'));
  const receipts = live.filter((x) => /\.jpg$/.test(x)); assert.strictEqual(receipts.length, 2, 'lunch + new (gas removed): ' + receipts.join('\n'));
  assert.ok(receipts.every((x) => x.includes('/2026-12-02 Gala night - ')), 'receipts renamed for the new date/job');
  assert.ok(s.files.find((f) => f.name.includes('(Card)') && f.name.endsWith('.jpg')).inTrash, 'removed receipt trashed');
  assert.strictEqual(s.files.find((f) => f.id === de.pdf_id).versions, 2, 'same PDF file, new version');
  // calendar: the same event, now on the new day
  assert.strictEqual(s.events.length, 1, 'no duplicate event'); assert.strictEqual(s.events[0].id, ce.event_id);
  assert.deepStrictEqual([s.events[0].start, s.events[0].end], [{ date: '2026-12-02' }, { date: '2026-12-03' }]); assert.strictEqual(s.events[0].summary, 'Gala night (Film shoot) – EOD');
  // editing again with nothing changed adds nothing
  const n0 = s.files.length; drive.enqueue(id); await drive.runOnce(); s = await state();
  assert.strictEqual(s.files.length, n0, 'no new files'); assert.strictEqual(s.events.length, 1);
  // two edits queued back to back are still one folder / one event
  store.update(id, store.normalise(body({ job: 'Gala night', date: '2026-12-03', expenses: exps })), [], []); drive.enqueue(id);
  store.update(id, store.normalise(body({ job: 'Gala night', date: '2026-12-04', expenses: exps })), [], []); drive.enqueue(id); await drive.runOnce();
  s = await state(); assert.strictEqual(s.files.filter((f) => /^Gala/.test(f.name) && f.mimeType === 'application/vnd.google-apps.folder').length, 1);
  assert.strictEqual(s.events.length, 1); assert.deepStrictEqual(s.events[0].start, { date: '2026-12-04' });
  assert.ok(!tree(s).some((x) => /2026-12-02|2026-12-03/.test(x)), 'stale day folders tidied');

  // delete: folder trashed (recoverable), event deleted, every emptied parent tidied, only the root folder is left
  drive.onDelete(id); store.remove(id); await drive.runOnce();
  s = await state(); assert.deepStrictEqual(tree(s), ['EOD Log']); assert.strictEqual(s.events.length, 0);
  assert.ok(s.files.find((f) => f.name.startsWith('Gala night')).inTrash, 'trashed, not permanently deleted');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_folders').get().n, 0); assert.strictEqual(drive.status().cleanup, 0);
});

test('Clear all data + Google: every job folder is trashed, every event deleted, empty day/month/year folders tidied; retried when Google fails', async () => {
  await mock('/mock/reset'); freshOauth(); await reconnect(); calOn();
  const mk = (job, date, n) => store.create(store.normalise(body({ job, date })), [fakeUpload('a.jpg', 1000 + n, 'image/jpeg', '1'), fakeUpload('b.jpg', 2000 + n, 'image/jpeg', '2')], 'Jason');
  const ids = [mk('Alpha', '2026-11-13', 1), mk('Beta', '2026-11-13', 2), mk('Gamma', '2026-12-01', 3), mk('Delta', '2025-12-30', 4)];
  const g = gcal(); g.enqueueAll(); ids.forEach((i) => drive.enqueue(i)); await drive.runOnce();
  let s = await state(); assert.strictEqual(s.events.length, 4); assert.strictEqual(s.files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder').length, 1 + 2 + 3 + 3 + 4, 'tree built: root, 2 years, 3 months, 3 days, 4 jobs');
  const queuedNotSynced = mk('Epsilon', '2026-11-14', 5); drive.enqueue(queuedNotSynced); // queued but never synced: must not be uploaded after the clear

  // what the Settings "Clear all data" does, with "Also remove from Google" ticked (an outage first: the first Google calls fail)
  await mock('/mock/fail?n=3&status=503&reason=backendError');
  db.transaction(() => { db.exec('DELETE FROM receipts; DELETE FROM expenses; DELETE FROM crew; DELETE FROM entries;'); drive.clearAll(); })();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_entries WHERE pending_delete=1').get().n, 4, 'folder ids survive the wipe in the cleanup queue');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cal_entries WHERE pending_delete=1').get().n, 4, 'event ids survive too');
  for (let i = 0; i < 12 && (drive.status().cleanup > 0); i++) { await drive.runOnce(); await sleep(120); }
  s = await state();
  assert.strictEqual(drive.status().cleanup, 0, 'cleanup finished after retries');
  assert.strictEqual(s.events.length, 0, 'all events deleted'); assert.deepStrictEqual(tree(s), ['EOD Log'], 'only the root folder is left: ' + tree(s).join(' | '));
  assert.ok(s.files.filter((f) => /^(Alpha|Beta|Gamma|Delta)/.test(f.name)).every((f) => f.inTrash), 'job folders are in the Drive trash (recoverable)');
  assert.strictEqual(s.files.some((f) => /Epsilon/.test(f.name)), false, 'a queued-but-unsynced EOD is not uploaded after the clear');
  for (const t of ['drive_entries', 'drive_files', 'drive_queue', 'drive_folders', 'cal_entries', 'cal_queue']) assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  // new EODs after the clear (ids restart at 1) build a fresh tree
  const again = mk('Zeta', '2026-11-13', 6); drive.enqueue(again); await drive.runOnce();
  assert.ok(tree(await state()).includes('EOD Log/2026/11 November/2026-11-13/Zeta (Film shoot)/EOD 2026-11-13 Zeta.pdf'));

  // Clear all data WITHOUT the Google box: Google keeps everything
  const before = (await state()); const nf = tree(before).length, ne = before.events.length;
  db.transaction(() => { db.exec('DELETE FROM receipts; DELETE FROM expenses; DELETE FROM crew; DELETE FROM entries;'); drive.forgetEntries(); })();
  await drive.runOnce(); const after = await state(); assert.strictEqual(tree(after).length, nf); assert.strictEqual(after.events.length, ne);
});

test('service account (Shared Drive): delete + tidy-up send supportsAllDrives (else the Shared Drive items are invisible)', async () => {
  await mock('/mock/reset');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const shared = (await mock('/mock/folder?name=KPI%20Shared%20EODs')).id;
  drive.S.set('mode', 'sa'); drive.resetToken(); drive.resetMapping(); db.exec('DELETE FROM entries');
  drive.S.set('sa_json', JSON.stringify({ type: 'service_account', client_email: 'eod@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  drive.S.set('shared_folder_id', shared);
  const g = gcal(); g.S.set('cal_on', '1'); g.S.set('cal_mode', 'paste'); const cal = (await mock('/mock/calendar?name=EOD%20Log&sa=1')).id; g.S.set('cal_paste_id', cal);
  const a = store.create(store.normalise(body({ job: 'SA one', date: '2026-11-13' })), [fakeUpload('a.jpg', 900, 'image/jpeg', '1')], 'Jason');
  const b = store.create(store.normalise(body({ job: 'SA two', date: '2026-11-14' })), [], 'Jason');
  drive.enqueue(a); drive.enqueue(b); await drive.runOnce();
  let s = await state(); assert.strictEqual(s.events.length, 2);
  // edit with a date change: the old day folder is tidied (needs files.list with supportsAllDrives + includeItemsFromAllDrives)
  store.update(a, store.normalise(body({ job: 'SA one', date: '2026-11-20', expenses: [] })), [], []); drive.enqueue(a); await drive.runOnce();
  s = await state(); assert.ok(!tree(s).some((x) => x.includes('2026-11-13')), 'old day folder tidied in a Shared Drive: ' + tree(s).join(' | ')); assert.ok(tree(s).some((x) => x.includes('2026-11-20/SA one')));
  // delete one, then clear the rest
  drive.onDelete(a); store.remove(a); await drive.runOnce();
  assert.ok(!tree(await state()).some((x) => x.includes('SA one')));
  db.transaction(() => { db.exec('DELETE FROM receipts; DELETE FROM expenses; DELETE FROM crew; DELETE FROM entries;'); drive.clearAll(); })();
  await drive.runOnce(); s = await state();
  assert.deepStrictEqual(tree(s), ['KPI Shared EODs'], 'the user\'s shared folder itself stays'); assert.strictEqual(s.events.length, 0); assert.strictEqual(drive.status().cleanup, 0);
});
