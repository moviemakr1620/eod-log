// End-to-end check against a running server. Usage:
//   BASE=http://127.0.0.1:7240 APP_PASSWORD=... ADMIN_PASSWORD=... [MAILPIT=http://127.0.0.1:8025] node scripts/e2e.mjs
import fs from 'node:fs';
import { execSync } from 'node:child_process';
// optional: DOCKER_EXEC='sudo docker exec eod-log' lets the clear-data test look inside /data
const DOCKER_EXEC = process.env.DOCKER_EXEC || '';
const inData = (cmd) => execSync(`${DOCKER_EXEC} sh -c ${JSON.stringify(cmd)}`).toString().trim();
const BASE = process.env.BASE || 'http://127.0.0.1:7240';
const MAILPIT = process.env.MAILPIT || '';
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const jar = { team: '', admin: '', team2: '' };
async function req(path, { who = 'team', method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(BASE + path, { method, body, redirect: 'manual', headers: { ...(jar[who] ? { cookie: jar[who] } : {}), ...headers } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar[who] = sc[0].split(';')[0];
  return r;
}
const text = async (r) => r.text();
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const monday = (s) => { const d = new Date(s + 'T00:00:00Z'); return addDays(s, -((d.getUTCDay() + 6) % 7)); };
const lastWeek = addDays(monday(today), -7);

// health + auth wall
ok((await req('/healthz')).status === 200, 'healthz 200');
let r = await req('/', { who: 'none' }); ok(r.status === 303 && /\/login/.test(r.headers.get('location')), 'anonymous / redirects to /login');
r = await req('/r/1', { who: 'none' }); ok(r.status === 401 || r.status === 303, 'anonymous receipt blocked');
r = await req('/login', { who: 'team', method: 'POST', body: new URLSearchParams({ name: 'Jason', password: 'nope' }) }); ok(r.status === 401, 'wrong password rejected');
r = await req('/login', { who: 'team', method: 'POST', body: new URLSearchParams({ name: 'Jason', password: process.env.APP_PASSWORD }) });
ok(r.status === 303 && jar.team, 'team login sets cookie');
ok(/HttpOnly/.test(r.headers.get('set-cookie')) && /Max-Age=\d{6,}/.test(r.headers.get('set-cookie')), 'cookie is HttpOnly and long-lived');

// new form
r = await req('/new'); const formHtml = await text(r);
ok(r.status === 200 && /type="date"/.test(formHtml) && /id="crew-list"/.test(formHtml), 'new EOD form renders with date picker');

// create entry 1: shoot last week, 3 crew with different hours, 2 expenses with receipts
function entryForm(o) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o.fields)) fd.append(k, v);
  fd.append('crew_json', JSON.stringify(o.crew));
  fd.append('expenses_json', JSON.stringify(o.expenses || []));
  (o.files || []).forEach(([field, file, type]) => fd.append(field, new Blob([fs.readFileSync(file)], { type }), file.split('/').pop()));
  return fd;
}
const d1 = addDays(lastWeek, 1);
r = await req('/new', { method: 'POST', body: entryForm({
  fields: { job: 'Acme Spring Promo', date: d1, job_type: 'Film shoot', client: 'Acme Corp', location: 'Conshohocken, PA', tz: 'America/New_York', crew_chief: 'Jason', vehicle: 'Sprinter 2', vehicle_kind: 'company', driver: 'Jason', miles: '42', tolls: '6.50', media_taken: '4 CFexpress', media_used: '3', equip_requested: 'Extra wireless lav', equip_provided: 'Aputure 600d, 2x lav', notes: 'Client happy. Sending selects Friday.', issues: 'Cracked C-stand knuckle' },
  crew: [
    { name: 'Jason', role: 'DP', leave_shop: '06:00', on_set: '07:15', start: '07:30', meals: [{ start: '12:30', end: '13:00' }], stop: '18:00', wheels_up: '18:45', return_shop: '20:00', edit_hours: '2' },
    { name: 'Maria Lopez', role: 'Gaffer', start: '07:30', meals: [{ start: '12:30', end: '13:00' }], stop: '18:00' },
    { name: 'Dev Patel', role: 'PA', start: '09:00', meals: [{ start: '13:00', end: '13:30' }], stop: '15:00' },
  ],
  expenses: [
    { key: '1', description: 'Gas for Sprinter', category: 'Fuel', amount: '63.65', paid_by: 'personal', person: 'Maria Lopez', hasFiles: true },
    { key: '2', description: 'Gaff tape', category: 'Supplies', amount: '24.99', paid_by: 'company', person: 'Jason', hasFiles: true },
  ],
  files: [['file_x1', 'test/fixtures/receipt.jpg', 'image/jpeg'], ['file_x2', 'test/fixtures/receipt.pdf', 'application/pdf']],
}) });
ok(r.status === 303 && /\/e\/\d+/.test(r.headers.get('location')), 'create entry 1 (3 crew, 2 receipts)');
const id1 = Number(/\/e\/(\d+)/.exec(r.headers.get('location'))[1]);

// entry 2: live event overnight, same week
r = await req('/new', { method: 'POST', body: entryForm({
  fields: { job: 'Gala at the Kimmel', date: addDays(lastWeek, 4), job_type: 'Live event', client: 'Philly Arts Fund', location: 'Kimmel Center', tz: 'America/New_York' },
  crew: [
    { name: 'Jason', role: 'A1', start: '15:00', meals: [{ start: '18:00', end: '18:45' }, { start: '23:30', end: '00:00' }], stop: '02:00' },
    { name: 'Dev Patel', role: 'Stagehand', hours_override: '8' },
  ],
  expenses: [{ key: '1', description: 'Parking garage', category: 'Parking', amount: '30', paid_by: 'personal', person: 'Dev Patel', hasFiles: false }],
}) });
ok(r.status === 303, 'create entry 2 (overnight times, typed-in hours)');
const id2 = Number(/\/e\/(\d+)/.exec(r.headers.get('location'))[1]);

// validation
r = await req('/new', { method: 'POST', body: entryForm({ fields: { job: '', date: today }, crew: [] }) });
ok(r.status === 400, 'missing job/crew rejected with 400');
r = await req('/new', { method: 'POST', body: entryForm({ fields: { job: 'x', date: today }, crew: [{ name: 'A' }], files: [['file_g', 'package.json', 'text/html']] }) });
ok(r.status === 303, 'non-image upload ignored, entry still saved');
const idJunk = Number(/\/e\/(\d+)/.exec(r.headers.get('location'))[1]);

let h;
// time formats + old field name + nameless rows
r = await req('/new', { method: 'POST', body: entryForm({ fields: { job: 'Formats', date: today },
  crew: [{ name: 'Secs', start: '07:30:00', stop: '18:00:00.000' }, { name: 'AmPm', start: '7:30 AM', stop: '6:00 PM' }, { name: 'OldWrap', start: '9:00', wrap: '17:30' }, { name: 'Night', start: '22:00', stop: '06:00', meals: [{ start: '02:00', end: '02:30' }] }] }) });
const idFmt = Number(/\/e\/(\d+)/.exec(r.headers.get('location'))[1]);
h = await text(await req(`/e/${idFmt}`));
ok((h.match(/>10\.5 h</g) || []).length === 2 && h.includes('>8.5 h<') && h.includes('>7.5 h<') && h.includes('7:30am') && h.includes('6:00pm'), 'times with seconds / AM-PM / old "wrap" / overnight all saved (10.5, 10.5, 8.5, 7.5 h)');
r = await req('/new', { method: 'POST', body: entryForm({ fields: { job: 'Nameless', date: today }, crew: [{ name: '', start: '08:00', stop: '17:00' }] }) });
h = await text(r); ok(r.status === 400 && h.includes('has times but no name'), 'crew row with times but no name is refused, not silently dropped');
r = await req('/new', { method: 'POST', body: entryForm({ fields: { job: 'NoMeal', date: today }, crew: [{ name: 'A', start: '08:00', stop: '16:00', meals: [{ start: '', end: '' }] }] }) });
const idNoMeal = Number(/\/e\/(\d+)/.exec(r.headers.get('location'))[1]);
h = await text(await req(`/e/${idNoMeal}`)); ok(h.includes('>8 h<') && !/<dt>Meal/.test(h), 'no meal entered = nothing deducted (8 h)');

// detail
r = await req(`/e/${id1}`); h = await text(r);
ok(h.includes('Acme Spring Promo') && h.includes('Maria Lopez') && h.includes('Dev Patel'), 'detail shows crew');
ok((h.match(/>10 h</g) || []).length >= 2 && h.includes('5.5 h') && h.includes('25.5 h total'), 'detail: separate hours 10 / 10 / 5.5 (travel times ignored, meals deducted)');
ok(h.includes('On-site hours') && h.includes('11.5 h'), 'detail: secondary on-site hours (7:15 to 6:45pm = 11.5 h)');
const rid = Number(/\/r\/(\d+)/.exec(h)[1]);
ok(/<img src="\/r\/\d+"/.test(h) && />PDF</.test(h), 'detail shows image thumbnail and PDF receipt');
r = await req(`/r/${rid}`); ok(r.status === 200 && /image\/jpeg/.test(r.headers.get('content-type')), 'receipt image served to signed-in user');
r = await req(`/e/${id2}`); h = await text(r);
ok(h.includes('9.75 h') && h.includes('8 h'), 'overnight shift 3pm-2am minus 2 meals = 9.75 h; typed-in 8 h');

// week view (last week)
r = await req(`/?week=${lastWeek}`); h = await text(r);
ok(h.includes('Acme Spring Promo') && h.includes('Gala at the Kimmel'), 'week view lists both entries');
ok(h.includes('43.25') && h.includes('$93.65'), 'week totals: 43.25 crew hrs, $93.65 to reimburse');
// list + search + filter
r = await req('/list?q=kimmel'); h = await text(r); ok(h.includes('Gala at the Kimmel') && !h.includes('Acme Spring Promo'), 'list search filters');
r = await req('/list?person=Maria%20Lopez'); h = await text(r); ok(h.includes('Acme Spring Promo') && !h.includes('Gala at'), 'list filter by person');
r = await req('/list?type=Live%20event'); h = await text(r); ok(h.includes('Gala at the Kimmel') && !h.includes('Acme Spring'), 'list filter by job type');
// autocomplete
r = await req('/new'); h = await text(r); ok(h.includes('<option value="Maria Lopez">') && h.includes('<option value="Acme Spring Promo">'), 'form remembers crew names and projects');
r = await req(`/new?from=${id1}`); h = await text(r); ok(h.includes('Acme Spring Promo') && h.includes('Maria Lopez'), 'duplicate prefills job and crew');

// edit: change Dev's stop, add a receipt to the existing expense, delete the PDF
r = await req(`/e/${id1}/edit`); h = await text(r);
const init = JSON.parse(/<script type="application\/json" id="init">([\s\S]*?)<\/script>/.exec(h)[1]);
const pdf = init.expenses[1].receipts[0].id;
const crew = init.crew.map((c) => (c.name === 'Dev Patel' ? { ...c, stop: '17:00' } : c));
const fd = entryForm({ fields: { job: 'Acme Spring Promo', date: d1, job_type: 'Film shoot', client: 'Acme Corp', location: 'Conshohocken, PA', tz: 'America/New_York', crew_chief: 'Jason' },
  crew, expenses: init.expenses.map((x, i) => ({ ...x, key: String(i + 1) })), files: [['file_x1', 'test/fixtures/receipt.jpg', 'image/jpeg']] });
fd.append('delete_receipts_json', JSON.stringify([pdf]));
r = await req(`/e/${id1}/edit`, { method: 'POST', body: fd }); ok(r.status === 303, 'edit saved');
r = await req(`/e/${id1}`); h = await text(r);
ok(h.includes('7.5 h') && !/>PDF</.test(h) && (h.match(/<img src="\/r\//g) || []).length === 2, 'edit: hours recomputed, PDF removed, 2nd photo added');

// admin gating
r = await req(`/e/${idJunk}/delete`, { method: 'POST' }); ok(r.status === 403, 'team user cannot delete');
r = await req('/settings'); ok(r.status === 303 && /admin-login/.test(r.headers.get('location')), 'settings needs admin');
r = await req('/admin-login', { method: 'POST', body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD, next: '/settings' }) });
ok(r.status === 303 && r.headers.get('location') === '/settings', 'admin elevation works');
r = await req(`/e/${idJunk}/delete`, { method: 'POST' }); ok(r.status === 303, 'admin can delete');
r = await req(`/e/${idJunk}`); ok(r.status === 404, 'deleted entry gone');
for (const x of [idFmt, idNoMeal]) await req(`/e/${x}/delete`, { method: 'POST' });
h = await text(await req('/settings'));
ok(h.includes('Weekly summary') && h.includes('Mondays at 08:00'), 'old weekly summary settings migrated into a first notification');
r = await req('/settings/n/new', { method: 'POST', body: new URLSearchParams({ name: 'Ops weekly', recipients: 'boss@kpi.example, ops@kpi.example, not-an-email', frequency: 'weekly', weekday: '1', send_time: '23:59', tz: 'America/New_York', enabled: '1' }) });
ok(r.status === 303, 'add a notification');
h = await text(await req('/settings')); ok(h.includes('Ops weekly') && h.includes('To: boss@kpi.example, ops@kpi.example') && !h.includes('not-an-email'), 'notification saved (invalid address dropped)');
const opsId = Number([...h.matchAll(/href="\/settings\/n\/(\d+)"/g)].pop()[1]);

// summary preview
r = await req(`/summary?n=${opsId}`); h = await text(r);
ok(h.includes('Hours by person') && h.includes('Maria Lopez') && h.includes('$63.65') && h.includes(`/e/${id1}`), 'summary preview has people, reimbursements, links');
ok(h.includes(`href="/settings/n/${opsId}" data-back`), 'preview Back defaults to the notification');
h = await text(await req(`/summary?n=${opsId}&back=/settings`)); ok(h.includes('href="/settings" data-back') && h.includes('back=%2Fsettings'), 'preview Back returns to Settings, kept on prev/next links');
h = await text(await req(`/summary?n=${opsId}&back=//evil.example`)); ok(!h.includes('evil.example'), 'preview Back ignores off-site targets');
h = await text(await req(`/summary?n=${opsId}&raw=1`)); ok(!h.includes('data-back') && h.includes('Hours by person'), 'raw email HTML has no Back button');

// CSV
r = await req(`/export/hours.csv?from=${lastWeek}&to=${addDays(lastWeek, 6)}`); h = await text(r);
ok(/text\/csv/.test(r.headers.get('content-type')) && h.split('\r\n').length >= 6 && h.includes('Maria Lopez'), 'hours CSV export');
r = await req('/export/expenses.csv'); h = await text(r); ok(h.includes('personal (reimburse)'), 'expenses CSV export');

// email
if (MAILPIT) {
  await fetch(MAILPIT + '/api/v1/messages', { method: 'DELETE' });
  r = await req(`/settings/n/${opsId}/send`, { method: 'POST', body: new URLSearchParams({}) }); h = await text(r);
  ok(r.status === 200 && h.includes('boss@kpi.example'), 'send test of a notification to its recipients');
  await new Promise((res) => setTimeout(res, 800));
  const list = await (await fetch(MAILPIT + '/api/v1/messages')).json();
  ok(list.messages && list.messages.length === 1, 'SMTP catcher received 1 message');
  const m = list.messages[0];
  ok(m && m.To.length === 2 && /Ops weekly/.test(m.Subject), `subject: ${m && m.Subject}`);
  const full = await (await fetch(MAILPIT + '/api/v1/message/' + m.ID)).json();
  ok(!full.HTML.includes('data-back') && !full.HTML.includes('Email preview'), 'sent email has no preview Back button');
  ok(full.HTML.includes('Maria Lopez') && full.HTML.includes('$93.65') && full.Text.includes('Acme Spring Promo'), 'email body has hours + reimbursements (HTML and text)');
  r = await req(`/settings/n/${opsId}`, { method: 'POST', body: new URLSearchParams({ name: 'Ops weekly', recipients: 'boss@kpi.example, ops@kpi.example', frequency: 'weekly', weekday: '1', send_time: '23:59', tz: 'America/New_York', enabled: '1', attach: '1' }) });
  r = await req(`/settings/n/${opsId}/send`, { method: 'POST', body: new URLSearchParams({ to: 'jason@kpi.example' }) });
  await new Promise((res) => setTimeout(res, 800));
  const list2 = await (await fetch(MAILPIT + '/api/v1/messages')).json();
  const t = list2.messages.find((x) => x.To.length === 1);
  ok(t && t.Attachments >= 2, `test email to one address with ${t && t.Attachments} receipt attachment(s)`);
  await req(`/settings/n/${opsId}/delete`, { method: 'POST' });
}

// danger zone: clear all data
{
  const det = await text(await req(`/e/${id1}`));
  const rid = Number(/<img src="\/r\/(\d+)"/.exec(det)[1]);
  h = await text(await req('/settings'));
  ok(h.includes('Danger zone') && h.includes('href="/settings/clear"'), 'settings shows the danger zone');
  h = await text(await req('/settings/clear'));
  const nEntries = (await text(await req('/list'))).match(/class="card entry/g)?.length;
  ok(/This permanently deletes \d+ EOD entr/.test(h) && /\d+ receipts?/.test(h) && /(KB|MB|bytes) of uploaded files/.test(h) && h.includes('/export/hours.csv') && h.includes('/data/backups/'), 'clear page shows counts, CSV link and backup note');
  ok(h.includes('name="password"'), 'clear page asks for the admin password');
  await req('/login', { who: 'team2', method: 'POST', body: new URLSearchParams({ name: 'Crew', password: process.env.APP_PASSWORD }) });
  r = await req('/settings/clear', { who: 'team2' }); ok(r.status === 303 && /admin-login/.test(r.headers.get('location')), 'non-admin cannot open clear page');
  const good = { scope: 'entries', confirm: 'DELETE', password: process.env.ADMIN_PASSWORD };
  r = await req('/settings/clear', { who: 'team2', method: 'POST', body: new URLSearchParams(good) }); ok(r.status === 403, 'non-admin clear blocked (403)');
  r = await req('/settings/clear', { method: 'POST', body: new URLSearchParams({ ...good, confirm: 'delete' }) }); h = await text(r); ok(r.status === 400 && h.includes('Nothing was deleted'), 'wrong confirmation text blocked');
  r = await req('/settings/clear', { method: 'POST', body: new URLSearchParams({ ...good, password: 'nope' }) }); ok(r.status === 401, 'wrong admin password blocked');
  r = await req('/settings/clear', { method: 'POST', body: new URLSearchParams(good), headers: { origin: 'https://evil.example' } }); ok(r.status === 403, 'cross-site clear blocked');
  r = await req(`/e/${id1}`); ok(r.status === 200, 'nothing deleted by the blocked attempts');
  const filesBefore = DOCKER_EXEC ? Number(inData('ls /data/uploads | wc -l')) : 0;
  if (DOCKER_EXEC) { inData('rm -rf /data/backups'); ok(filesBefore >= 2, `uploads present before clear (${filesBefore})`); }
  r = await req('/settings/clear', { method: 'POST', body: new URLSearchParams(good) });
  ok(r.status === 303 && /msg=Cleared/.test(r.headers.get('location')), 'clear succeeds with DELETE + password');
  h = await text(await req(r.headers.get('location'))); ok(h.includes('alert info') && h.includes('Cleared ') && h.includes('backups/eod-'), 'confirmation banner names the backup');
  ok(h.includes('Ops weekly') || h.includes('Weekly summary'), 'notifications kept with the default option');
  r = await req(`/e/${id1}`); ok(r.status === 404, 'entries gone after clear');
  r = await req(`/r/${rid}`); ok(r.status === 404, 'receipt gone after clear');
  ok(!(await text(await req('/list'))).includes('Acme Spring Promo'), `list empty after clear (had ${nEntries})`);
  if (DOCKER_EXEC) {
    ok(inData('ls -A /data/uploads | wc -l') === '0', 'upload files deleted');
    ok(inData('ls /data/backups | wc -l') === '1', 'one database backup written');
    ok(inData('ls /data/backups') .includes('before-clear.sqlite'), 'backup file name');
    for (let i = 0; i < 3; i++) await req('/settings/clear', { method: 'POST', body: new URLSearchParams(good) });
    ok(inData('ls /data/backups | wc -l') === '3', 'only the last 3 backups kept');
  }
  r = await req('/settings/clear', { method: 'POST', body: new URLSearchParams({ ...good, scope: 'all' }) });
  h = await text(await req(r.headers.get('location')));
  ok(h.includes('plus notifications') && h.includes('No notifications'), 'clear everything also removes notifications');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
