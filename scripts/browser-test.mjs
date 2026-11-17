// Real-browser form test: WebKit (iPhone 13) and Chromium (Pixel 7). Needs the `playwright` package outside the project:
//   TOOLS_DIR=/path/with/node_modules BASE=http://127.0.0.1:7240 APP_PASSWORD=... node scripts/browser-test.mjs
// Easiest: run inside mcr.microsoft.com/playwright (see README "Testing").
import { createRequire } from 'node:module';
const require = createRequire(process.env.TOOLS_DIR ? process.env.TOOLS_DIR + '/' : import.meta.url);
const { webkit, chromium, firefox, devices } = require('playwright');
const H = createRequire(import.meta.url)('../public/hours.js');
const val = async (loc) => H.norm(await loc.inputValue());
const BASE = process.env.BASE || 'http://127.0.0.1:7240';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

for (const [name, bt, dev] of [['WebKit iPhone 13', webkit, devices['iPhone 13']], ['Chromium Pixel 7', chromium, devices['Pixel 7']], ['Desktop Chromium', chromium, devices['Desktop Chrome']], ['Desktop Firefox', firefox, devices['Desktop Firefox']]]) {
  const desktop = name.startsWith('Desktop');
  const b = await bt.launch(); const ctx = await b.newContext({ ...dev, timezoneId: 'America/New_York' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const dialogs = []; p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.goto(BASE + '/login'); await p.fill('input[name=name]', 'Jason'); await p.fill('input[name=password]', process.env.APP_PASSWORD);
  await Promise.all([p.waitForURL(BASE + '/'), p.click('button[type=submit]')]);
  await p.goto(BASE + '/new'); await p.evaluate(() => localStorage.clear()); await p.goto(BASE + '/new');
  const row = (i) => p.locator('.crew-row').nth(i);
  ok(await p.locator('.meal').count() === 0, `${name}: meals are off by default`);
  ok(await row(0).locator('[data-f=name]').inputValue() === 'Jason', `${name}: first crew row pre-filled with my name`);
  if (desktop) {
    ok(await p.locator('.crew-row input[type=time]').count() === 0 && await row(0).locator('[data-f=start]').getAttribute('placeholder') === 'hh:mm', `${name}: desktop uses typed time fields (no native --:-- inputs, no sample time)`);
    // the reported bug: only the hour typed
    await row(0).locator('[data-f=start]').pressSequentially('7'); await row(0).locator('[data-f=stop]').click();
    ok(await row(0).locator('[data-f=start]').inputValue() === '7:00 AM', `${name}: typing just "7" becomes 7:00 AM on blur`);
    await row(0).locator('[data-f=stop]').pressSequentially('6p'); await p.locator('input[name=job]').click();
    ok(await row(0).locator('[data-f=stop]').inputValue() === '6:00 PM' && (await row(0).locator('[data-total]').textContent()).includes('11 h'), `${name}: "6p" becomes 6:00 PM, total 11 h`);
    await row(0).locator('[data-f=stop]').fill('6:6'); await p.locator('input[name=job]').click();
    ok(await row(0).locator('[data-f=stop]').evaluate((i) => i.classList.contains('bad')), `${name}: half-typed time "6:6" is highlighted`);
    await p.fill('input[name=job]', 'Should not save');
    await p.locator('#save-btn').click(); await p.waitForTimeout(300);
    ok(/\/new$/.test(p.url()) && dialogs.some((d) => /incomplete/.test(d)), `${name}: save blocked with a message while a time is half-typed`);
    await row(0).locator('[data-f=start]').fill(''); await row(0).locator('[data-f=stop]').fill('');
  }
  await p.fill('input[name=job]', `Browser test ${name}`);
  await row(0).locator('[data-f=start]').fill('07:30');
  await row(0).locator('[data-f=stop]').fill('18:00');
  ok((await row(0).locator('[data-total]').textContent()).includes('10.5 h'), `${name}: live total 10.5 h from start/stop`);
  await row(0).locator('.addmeal').click();
  await row(0).locator('[data-m=start]').fill('12:00'); await row(0).locator('[data-m=end]').fill('12:30');
  ok((await row(0).locator('[data-total]').textContent()).includes('10 h'), `${name}: meal deducted once added (10 h)`);
  ok(await row(0).locator('[data-f=on_set]').isVisible() && await row(0).locator('[data-f=wheels_up]').isVisible() && await row(0).locator('[data-f=start]').isVisible() && await row(0).locator('[data-f=stop]').isVisible(), `${name}: Start/Stop and On set start/end are always visible (no + Add, no fold-out)`);
  ok(!(await row(0).locator('[data-onset]').textContent()).includes(' h'), `${name}: on set hours blank until on set times are entered`);
  await row(0).locator('[data-f=on_set]').fill('07:00'); await row(0).locator('[data-f=wheels_up]').fill('18:30');
  ok((await row(0).locator('[data-onset]').textContent()).includes('11 h') && (await row(0).locator('[data-total]').textContent()).includes('10 h'), `${name}: on set 7:00-6:30 = 11.5 h minus the 12:00-12:30 meal = 11 h live, total hours still 10 h`);
  ok((await p.locator('#crew-total').textContent()).includes('Total 10 h') && (await p.locator('#crew-total').textContent()).includes('On set 11 h'), `${name}: entry totals show total + on set hours live`);
  await p.locator('#add-crew').click();
  await row(1).locator('[data-f=name]').fill('Maria Lopez');
  ok(await val(row(1).locator('[data-f=start]')) === '07:30', `${name}: new crew row starts with the first row's times`);
  await p.locator('#add-crew').click();
  await row(2).locator('[data-f=name]').fill('Night Owl');
  await row(2).locator('.meal .rm-meal').click();
  await row(2).locator('[data-f=start]').fill('18:00'); await row(2).locator('[data-f=stop]').fill('02:00');
  ok(await row(2).locator('.addsite, .site').count() === 0 && await row(2).locator('[data-f=on_set]').isVisible() && !(await row(2).locator('details').evaluate((d) => d.open)), `${name}: On set fields are right on the row, not behind + Add or More`);
  await row(2).locator('[data-f=on_set]').fill('17:30'); await row(2).locator('[data-f=wheels_up]').fill('02:30');
  ok((await row(2).locator('[data-total]').textContent()).includes('8 h') && (await row(2).locator('[data-onset]').textContent()).includes('9 h'), `${name}: overnight 6pm-2am = 8 h total, on set 5:30pm-2:30am = 9 h, shown separately`);
  // a 4th row with times but no name must block saving with a message, not silently drop
  await p.locator('#add-crew').click();
  await p.locator('#save-btn').click();
  await p.waitForTimeout(300);
  ok(await p.locator('text=Leave shop').count() === 0 && await p.locator('text=Return to shop').count() === 0, `${name}: no Leave shop / Return to shop fields`);
  ok(dialogs.some((d) => /no name/.test(d)) && /\/new$/.test(p.url()), `${name}: nameless row with times blocks save with a message`);
  await row(3).locator('.rm').click();
  await Promise.all([p.waitForURL(/\/e\/\d+/), p.locator('#save-btn').click()]);
  let t = await p.locator('main').innerText();
  ok(/Saved\. 3 crew, 28 h total/.test(t), `${name}: saved: 3 crew, 28 h total (10 + 10 + 8)`);
  ok(t.includes('7:30am') && t.includes('6:00pm') && t.includes('2:00am') && /On set hours/i.test(t) && /Total hours/i.test(t) && /9 h/.test(t) && /11 h/.test(t), `${name}: start/stop, on set hours and total hours shown on the entry`);
  // edit: change Maria's stop, save again
  const id = /\/e\/(\d+)/.exec(p.url())[1];
  await p.goto(`${BASE}/e/${id}/edit`);
  ok(await val(row(1).locator('[data-f=stop]')) === '18:00' && await val(row(2).locator('[data-f=stop]')) === '02:00', `${name}: edit form loads saved times`);
  ok(await val(row(2).locator('[data-f=on_set]')) === '17:30' && await val(row(0).locator('[data-f=on_set]')) === '07:00' && (await row(0).locator('[data-onset]').textContent()).includes('11 h'), `${name}: edit shows the saved on set times and recalculates on set hours (11 h)`);
  // copy times to everyone carries site time; removing it works
  await row(2).locator('[data-f=name]').fill('Night Owl');
  await p.evaluate(() => { const rows = document.querySelectorAll('.crew-row'); rows[0].parentNode.insertBefore(rows[2], rows[0]); });
  await p.locator('#copy-times').click();
  ok(await val(row(1).locator('[data-f=wheels_up]')) === '02:30' && await val(row(2).locator('[data-f=stop]')) === '02:00' && (await row(1).locator('[data-onset]').textContent()).includes('9 h'), `${name}: "Copy times to everyone" includes on set times`);
  for (const i of [1, 2]) { await row(i).locator('[data-f=on_set]').fill(''); await row(i).locator('[data-f=wheels_up]').fill(''); }
  // restore Jason (row 1, with his meal) and Maria (row 2) to 7:30-6pm
  await row(1).locator('[data-f=start]').fill('07:30'); await row(1).locator('[data-f=stop]').fill('18:00');
  await row(1).locator('.addmeal').click(); await row(1).locator('[data-m=start]').fill('12:00'); await row(1).locator('[data-m=end]').fill('12:30');
  await row(2).locator('[data-f=start]').fill('07:30');
  await row(2).locator('[data-f=stop]').fill('20:00');
  await Promise.all([p.waitForURL(/\/e\/\d+\?saved/), p.locator('#save-btn').click()]);
  t = await p.locator('main').innerText();
  ok(/30\.5 h total/.test(t) && t.includes('8:00pm') && /On set hours/i.test(t), `${name}: edit saved (Night Owl first, Maria to 8pm: 8 + 10 + 12.5 = 30.5 h)`);
  // a browser/device that reports seconds ("07:30:00") must still save
  await p.goto(BASE + '/new'); await p.fill('input[name=job]', `Seconds ${name}`);
  await p.evaluate(() => { const r = document.querySelector('.crew-row'); r.querySelector('[data-f=start]').value = '07:30:00'; r.querySelector('[data-f=stop]').value = '18:00:00.000'; r.querySelector('[data-f=stop]').dispatchEvent(new Event('change', { bubbles: true })); });
  await Promise.all([p.waitForURL(/\/e\/\d+/), p.locator('#save-btn').click()]);
  t = await p.locator('main').innerText();
  ok(/10\.5 h total/.test(t) && t.includes('7:30am'), `${name}: time values with seconds save (10.5 h)`);
  // email preview: Back button (sticky at the top) returns to where it came from
  await p.goto(BASE + '/admin-login?next=/settings'); await p.fill('input[name=password]', process.env.ADMIN_PASSWORD);
  await Promise.all([p.waitForURL(/\/settings$/), p.locator('main button[type=submit]').click()]);
  if (!(await p.locator('.sched').count())) {
    await p.goto(BASE + '/settings/n/new'); await p.fill('input[name=name]', 'Preview test'); await p.fill('textarea[name=recipients]', 'boss@kpi.example');
    await Promise.all([p.waitForURL(/\/settings/), p.locator('#sched-form button[type=submit]').click()]);
  }
  await Promise.all([p.waitForURL(/\/summary/), p.locator('.sched a', { hasText: 'Preview' }).first().click()]);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(200);
  const bb = await p.locator('[data-back]').boundingBox();
  ok(bb && bb.y >= 0 && bb.y < 80, `${name}: preview Back button stays visible at the top after scrolling (y=${bb && Math.round(bb.y)})`);
  const pw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(pw <= 1, `${name}: preview page has no sideways scroll (${pw}px)`);
  await Promise.all([p.waitForURL(/\/settings$/), p.locator('[data-back]').click()]);
  ok(/\/settings$/.test(p.url()), `${name}: Back from preview returns to Settings`);
  await p.locator('.sched a', { hasText: 'Edit' }).first().click(); await p.waitForURL(/\/settings\/n\/\d+$/);
  const editUrl = p.url();
  await Promise.all([p.waitForURL(/\/summary/), p.locator('a', { hasText: 'Preview' }).first().click()]);
  await p.locator('.weeknav a[aria-label="Previous period"]').click(); await p.waitForURL(/from=/);
  await Promise.all([p.waitForURL(editUrl), p.locator('[data-back]').click()]);
  ok(p.url() === editUrl, `${name}: Back from preview (after paging) returns to the notification`);
  // Google Drive settings: connect with the device code (against the fake Google), toggle modes, disconnect
  if (process.env.GMOCK) {
    await p.goto(BASE + '/settings');
    await Promise.all([p.waitForURL(/\/settings\/drive$/), p.locator('a[href="/settings/drive"]').click()]);
    if (await p.locator('button', { hasText: 'Disconnect' }).count()) await Promise.all([p.waitForURL(/Disconnected/), p.locator('button', { hasText: 'Disconnect' }).click()]);
    ok(await p.locator('text=Not connected').count() === 1, `${name}: Drive page shows Not connected`);
    ok(await p.locator('[data-mode=sa]').isHidden() && await p.locator('input[name=client_id]').isVisible(), `${name}: Google account fields shown, service account fields hidden`);
    await p.locator('input[name=mode][value=sa]').check();
    ok(await p.locator('textarea[name=sa_json]').isVisible() && await p.locator('input[name=client_id]').isHidden(), `${name}: switching to Shared Drive shows its fields`);
    await p.locator('input[name=mode][value=oauth]').check();
    await p.fill('input[name=client_id]', 'test-client.apps.googleusercontent.com'); await p.fill('input[name=client_secret]', 'test-secret');
    await Promise.all([p.waitForURL(/msg=Saved/), p.locator('#drive-form button[type=submit]').click()]);
    await Promise.all([p.waitForURL(/\/settings\/drive/), p.locator('button', { hasText: 'Connect Google Drive' }).click()]);
    const code = (await p.locator('.devcode').textContent()).trim();
    ok(/^MOCK-/.test(code) && await p.locator('a[href="https://www.google.com/device"]').isVisible(), `${name}: device code ${code} and google.com/device link shown`);
    const pw2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(pw2 <= 1, `${name}: Drive page fits the screen (${pw2}px)`);
    await fetch(process.env.GMOCK + '/mock/approve', { method: 'POST' });
    await p.waitForURL(/msg=Connected/, { timeout: 15000 });
    t = await p.locator('main').innerText();
    ok(t.includes('jason@kpi.example') && await p.locator('a', { hasText: 'in Google Drive' }).count() >= 0, `${name}: page switches to Connected by itself after approval`);
    await Promise.all([p.waitForURL(/Test%20passed|msg=Test/), p.locator('button', { hasText: 'Test' }).click()]);
    ok(await p.locator('a', { hasText: 'in Google Drive' }).count() === 1, `${name}: Test passes and the folder link appears`);
    await Promise.all([p.waitForURL(/Disconnected/), p.locator('button', { hasText: 'Disconnect' }).click()]);
    ok(dialogs.some((d) => /Disconnect Google Drive/.test(d)) && (await p.locator('main').innerText()).includes('Not connected'), `${name}: Disconnect asks first, then disconnects`);
  }
  // danger zone
  await p.goto(BASE + '/settings');
  await Promise.all([p.waitForURL(/\/settings\/clear$/), p.locator('.danger-zone a', { hasText: 'Clear all data' }).click()]);
  t = await p.locator('main').innerText();
  ok(/This permanently deletes \d+ EOD entr/.test(t) && /backups/.test(t), `${name}: clear page warns with counts and backup note`);
  await p.fill('input[name=confirm]', 'delete'); await p.fill('input[name=password]', process.env.ADMIN_PASSWORD);
  await p.locator('#clear-form button[type=submit]').click(); await p.waitForLoadState();
  t = await p.locator('main').innerText();
  ok(t.includes('Nothing was deleted') && await p.locator('.sched').count() === 0 && /\/settings\/clear$/.test(p.url()), `${name}: wrong confirmation text blocked`);
  await p.fill('input[name=confirm]', 'DELETE'); await p.fill('input[name=password]', process.env.ADMIN_PASSWORD);
  await Promise.all([p.waitForURL(/\/settings\?msg=/), p.locator('#clear-form button[type=submit]').click()]);
  t = await p.locator('main').innerText();
  ok(/Cleared \d+ EODs?/.test(t) && t.includes('backups/eod-'), `${name}: clear succeeds and shows a confirmation banner`);
  await p.goto(BASE + '/list'); ok(await p.locator('.card.entry').count() === 0, `${name}: no entries left after clear`);
  ok(!errs.length, `${name}: no JS errors ${errs.join(' | ')}`);
  await b.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
