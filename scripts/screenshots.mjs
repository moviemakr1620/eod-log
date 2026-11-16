// Mobile screenshots (390x844 @2x) into preview/. Needs puppeteer-core (outside the project) and Chrome:
//   TOOLS_DIR=/path/with/node_modules BASE=http://127.0.0.1:7240 APP_PASSWORD=... ADMIN_PASSWORD=... node scripts/screenshots.mjs
import { createRequire } from 'node:module';
const require = createRequire(process.env.TOOLS_DIR ? process.env.TOOLS_DIR + '/' : import.meta.url);
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://127.0.0.1:7240';
const OUT = process.env.OUT || 'preview';
const WEEK = process.env.WEEK || '';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.SCHEME || 'light' }]);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name, full = false) => { await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log('saved', `${OUT}/${name}.png`); };
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
await shot('00-login');
await page.type('input[name=name]', 'Jason');
await page.type('input[name=password]', process.env.APP_PASSWORD);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);

await page.goto(BASE + '/' + (WEEK ? '?week=' + WEEK : ''), { waitUntil: 'networkidle0' });
console.log('week overflow px', await overflow());
await shot('01-week'); await shot('01-week-full', true);

await page.goto(BASE + '/list', { waitUntil: 'networkidle0' });
console.log('list overflow px', await overflow());
await shot('02-list');

// new EOD form: fill job, add a second crew member, copy times
await page.goto(BASE + '/new', { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(BASE + '/new', { waitUntil: 'networkidle0' });
await shot('03-new-eod');
await page.type('input[name=job]', 'Acme Spring Promo');
await page.select('select[name=job_type]', 'Film shoot');
const setTime = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
await setTime('.crew-row [data-f=start]', '07:30');
await setTime('.crew-row [data-f=stop]', '18:00');
await page.$eval('.crew-row .addsite', (b) => b.click());
await setTime('.crew-row .site [data-f=on_set]', '07:00');
await setTime('.crew-row .site [data-f=wheels_up]', '18:30');
await page.$eval('#add-crew', (b) => b.click());
await page.type('.crew-row:nth-child(2) [data-f=name]', 'Maria Lopez');
await page.$eval('#add-crew', (b) => b.click());
await page.type('.crew-row:nth-child(3) [data-f=name]', 'Dev Patel');
await setTime('.crew-row:nth-child(3) [data-f=stop]', '15:00');
await page.$eval('.crew-row:nth-child(3) .addmeal', (b) => b.click());
await setTime('.crew-row:nth-child(3) .meal [data-m=start]', '12:00');
await setTime('.crew-row:nth-child(3) .meal [data-m=end]', '12:30');
await page.$eval('#sec-exp', (d) => { d.open = true; });
await page.$eval('#add-exp', (b) => b.click());
await page.type('.exp-row [data-x=amount]', '63.65');
await page.select('.exp-row [data-x=category]', 'Fuel');
await page.type('.exp-row [data-x=description]', 'Gas for Sprinter');
await page.$eval('.exp-row .seg label:nth-child(2) input', (i) => i.click());
const fileInput = await page.$('.exp-row input[type=file]');
await fileInput.uploadFile(process.env.RECEIPT || 'test/fixtures/receipt.jpg');
await new Promise((r) => setTimeout(r, 500));
console.log('form overflow px', await overflow());
await page.evaluate(() => window.scrollTo(0, 0));
await shot('04-new-eod-filled'); await shot('04-new-eod-filled-full', true);
await Promise.all([page.waitForNavigation(), page.$eval('#save-btn', (b) => b.click())]);
console.log('saved to', page.url());
await shot('05-entry-detail'); await shot('05-entry-detail-full', true);
const draftLeft = await page.evaluate(() => localStorage.getItem('eod-draft-new'));
console.log('draft cleared after save:', draftLeft === null);

// admin + summary preview
await page.goto(BASE + '/admin-login?next=/settings', { waitUntil: 'networkidle0' });
await page.type('input[name=password]', process.env.ADMIN_PASSWORD);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await shot('06-settings'); await shot('06-settings-full', true);
const editHref = await page.$eval('.sched a.btn', (a) => a.getAttribute('href'));
await page.goto(BASE + editHref, { waitUntil: 'networkidle0' });
await shot('08-notification-edit-full', true);
await page.goto(BASE + '/summary?n=1&back=/settings' + (WEEK ? '&from=' + WEEK + '&to=' + (process.env.WEEK_END || WEEK) : ''), { waitUntil: 'networkidle0' });
await shot('07-summary-email'); await shot('07-summary-email-full', true);
console.log('preview overflow px', await overflow());
await page.evaluate(() => window.scrollTo(0, 900)); await new Promise((r) => setTimeout(r, 200));
await shot('07-summary-email-scrolled');
await page.goto(BASE + '/settings', { waitUntil: 'networkidle0' });
await page.$eval('.danger-zone', (el) => el.scrollIntoView({ block: 'center' })); await new Promise((r) => setTimeout(r, 200));
await shot('09-settings-danger-zone');
await page.goto(BASE + '/settings/clear', { waitUntil: 'networkidle0' });
await shot('10-clear-all-data'); await shot('10-clear-all-data-full', true);
console.log('clear page overflow px', await overflow());

// Google Drive settings (needs GMOCK: the fake Google server the app was started against)
if (process.env.GMOCK) {
  await page.goto(BASE + '/settings/drive', { waitUntil: 'networkidle0' });
  await shot('11-drive-setup'); await shot('11-drive-setup-full', true);
  console.log('drive page overflow px', await overflow());
  await page.type('input[name=client_id]', 'test-client.apps.googleusercontent.com'); await page.type('input[name=client_secret]', 'test-secret');
  await page.$eval('textarea[name=share]', (el) => { el.value = 'producer@kpi.example, office@kpi.example'; });
  await Promise.all([page.waitForNavigation(), page.click('#drive-form button[type=submit]')]);
  await Promise.all([page.waitForNavigation(), page.$eval('form[action="/settings/drive/connect"] button', (b) => b.click())]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('12-drive-code');
  await fetch(process.env.GMOCK + '/mock/approve', { method: 'POST' });
  await page.waitForNavigation({ timeout: 15000 });
  await Promise.all([page.waitForNavigation(), page.$eval('form[action="/settings/drive/sync-all"] button', (b) => b.click())]);
  await new Promise((r) => setTimeout(r, 4000));
  await page.goto(BASE + '/settings/drive', { waitUntil: 'networkidle0' });
  await shot('13-drive-connected'); await shot('13-drive-connected-full', true);
}
console.log('JS errors:', errors.length ? errors : 'none');
await browser.close();
