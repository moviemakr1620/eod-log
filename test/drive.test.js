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
  assert.strictEqual(n().folderName({ date: '2026-11-13', job: 'Acme / Spring\npromo', job_type: 'Film shoot' }), '2026-11-13 Acme - Spring promo (Film shoot)');
  assert.strictEqual(n().pdfName({ date: '2026-11-13', job: 'Gala' }), 'EOD 2026-11-13 Gala.pdf');
  assert.strictEqual(n().monthName('2026-03-02'), '2026-03 March');
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
    'EOD Log', 'EOD Log/2026', 'EOD Log/2026/2026-11 November', 'EOD Log/2026/2026-11 November/2026-11-13 Villanova promo (Film shoot)',
    'EOD Log/2026/2026-11 November/2026-11-13 Villanova promo (Film shoot)/2026-11-13 Villanova promo - Gas - $63.65 (Card) 1.jpg',
    'EOD Log/2026/2026-11 November/2026-11-13 Villanova promo (Film shoot)/2026-11-13 Villanova promo - Gas - $63.65 (Card) 2.pdf',
    'EOD Log/2026/2026-11 November/2026-11-13 Villanova promo (Film shoot)/2026-11-13 Villanova promo - Lunch - crew - $86.40 (Personal).jpg',
    'EOD Log/2026/2026-11 November/2026-11-13 Villanova promo (Film shoot)/EOD 2026-11-13 Villanova promo.pdf',
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
    '2026-11-13 Villanova commencement (Film shoot)',
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
  assert.ok(tree(s).includes('EOD Log/2026/2026-12 December/2026-12-02 Villanova commencement (Film shoot)'));

  // a failing Drive call is retried with backoff, never lost
  await mock('/mock/fail?n=1&status=503&reason=backendError');
  store.update(id, store.normalise(body({ job: 'Retry job', date: '2026-12-02', expenses: exps })), [], []);
  drive.enqueue(id); await drive.runOnce();
  let q = db.prepare('SELECT * FROM drive_queue WHERE entry_id=?').get(id);
  assert.ok(q && q.attempts === 1 && /503/.test(q.last_error), 'failure recorded');
  assert.strictEqual(drive.status().failing, 1);
  await sleep(80); await drive.runOnce();
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM drive_queue').get().n, 0, 'retried and done');
  assert.ok(tree(await state()).some((x) => x.endsWith('2026-12-02 Retry job (Film shoot)')));

  // someone trashes the whole root folder in Drive -> a fresh tree is made on the next sync
  await mock('/mock/trash?id=' + drive.S.get('root_id'));
  drive.enqueueAll();
  // root is only re-checked every 10 min; force it like the Test button does
  await drive.test(); await drive.runOnce();
  s = await state();
  assert.ok(tree(s).includes('EOD Log/2026/2026-12 December/2026-12-02 Retry job (Film shoot)/EOD 2026-12-02 Retry job.pdf'), 'recreated after root was trashed');

  // delete in the app -> folder kept but renamed "(deleted) ..." (default)
  drive.onDelete(id); store.remove(id); await drive.runOnce();
  s = await state();
  assert.ok(tree(s).some((x) => x.endsWith('/(deleted) 2026-12-02 Retry job (Film shoot)')));
  // with "trash" chosen, the folder goes to the trash
  drive.S.set('on_delete', 'trash');
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
  assert.ok(tree(await state()).includes('KPI Shared EODs/2026/2026-11 November/2026-11-13 SA job (Film shoot)/EOD 2026-11-13 SA job.pdf'));
});
