// Scheduler check against a running server + Mailpit (takes ~3 minutes). Needs no entries dated today when it starts.
//   BASE=... APP_PASSWORD=... ADMIN_PASSWORD=... MAILPIT=http://127.0.0.1:8025 node scripts/notify-test.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:7240';
const MAILPIT = process.env.MAILPIT || 'http://127.0.0.1:8025';
let fails = 0, cookie = '';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const req = async (p, o = {}) => { const r = await fetch(BASE + p, { redirect: 'manual', ...o, headers: { cookie } }); const s = r.headers.getSetCookie(); if (s.length) cookie = s[0].split(';')[0]; return r; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mails = async () => (await (await fetch(MAILPIT + '/api/v1/messages')).json()).messages || [];
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const hhmmIn = (min) => { const d = new Date(Date.now() + min * 60000); return d.toTimeString().slice(0, 5); };
const waitForMinute = async (hhmm) => { while (new Date().toTimeString().slice(0, 5) < hhmm) await sleep(2000); await sleep(36000); }; // + one 30s tick
const addSchedule = async (o) => { const r = await req('/settings/n/new', { method: 'POST', body: new URLSearchParams({ enabled: '1', tz: 'America/New_York', weekday: '1', ...o }) }); return r.status; };

await req('/login', { method: 'POST', body: new URLSearchParams({ name: 'Tester', password: process.env.ADMIN_PASSWORD }) });
await fetch(MAILPIT + '/api/v1/messages', { method: 'DELETE' });

// 1) daily schedule, no EODs today -> nothing sent, logged as skipped
const t1 = hhmmIn(1);
ok(await addSchedule({ name: 'Empty daily', recipients: 'empty@kpi.example', frequency: 'daily', covers: 'today', send_time: t1 }) === 303, `add "Empty daily" (daily, covers today, ${t1})`);
await waitForMinute(t1);
ok((await mails()).length === 0, 'no EODs today: daily notification sent nothing');
let h = await (await req('/settings')).text();
ok(/Empty daily[\s\S]*?tag-skipped/.test(h) && h.includes('nothing sent'), 'logged as skipped in Settings');

// 2) add an EOD for today, then two schedules with different recipients
const fd = new FormData(); fd.append('job', 'Notify test job'); fd.append('date', today); fd.append('crew_json', JSON.stringify([{ name: 'Jason', start: '08:00', stop: '16:30' }])); fd.append('expenses_json', '[]');
ok((await req('/new', { method: 'POST', body: fd })).status === 303, 'EOD for today saved');
const t2 = hhmmIn(1);
await addSchedule({ name: 'Daily wrap', recipients: 'a@kpi.example', frequency: 'daily', covers: 'today', send_time: t2 });
await addSchedule({ name: 'Office daily', recipients: 'b@kpi.example, c@kpi.example', frequency: 'daily', covers: 'today', send_time: t2 });
await waitForMinute(t2);
const m = await mails();
const to = (x) => x.To.map((t) => t.Address).sort().join(',');
ok(m.length === 2, `two notifications fired (${m.length} emails)`);
ok(m.some((x) => to(x) === 'a@kpi.example' && /Daily wrap/.test(x.Subject)) && m.some((x) => to(x) === 'b@kpi.example,c@kpi.example' && /Office daily/.test(x.Subject)), 'each went to its own recipients');
ok(!m.some((x) => /empty@/.test(to(x))), '"Empty daily" still did not re-send today (period already handled)');
const full = await (await fetch(MAILPIT + '/api/v1/message/' + m[0].ID)).json();
ok(full.HTML.includes('Notify test job') && full.HTML.includes('8.5'), 'email has the job and 8.5 h');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
