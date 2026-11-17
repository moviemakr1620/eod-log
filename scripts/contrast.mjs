// Contrast audit: every visible text node vs its effective background, on every main page, in light and dark.
//   TOOLS_DIR=... BASE=... APP_PASSWORD=... ADMIN_PASSWORD=... node scripts/contrast.mjs   (exit 1 if anything is below WCAG AA: 4.5, or 3 for large text)
import { createRequire } from 'node:module';
const require = createRequire(process.env.TOOLS_DIR ? process.env.TOOLS_DIR + '/' : import.meta.url);
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://127.0.0.1:7240';
const PAGES = (process.env.PAGES || '/,/list,/new,/e/1,/settings,/settings/n/1,/settings/drive,/settings/calendar,/settings/clear,/summary?from=2026-11-09&to=2026-11-15').split(',');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
await page.type('input[name=name]', 'Audit'); await page.type('input[name=password]', process.env.APP_PASSWORD);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await page.goto(BASE + '/admin-login?next=/settings', { waitUntil: 'networkidle0' });
if (process.env.ADMIN_PASSWORD) { await page.type('input[name=password]', process.env.ADMIN_PASSWORD); await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]); }
const audit = () => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bgOf = (el) => { let stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] === 1) break; } let base = [255, 255, 255]; if (!stack.length || stack[stack.length - 1][3] < 1) base = parse(getComputedStyle(document.documentElement).backgroundColor).slice(0, 3); if (base.length < 3 || (stack.length === 0)) { const b = parse(getComputedStyle(document.body).backgroundColor); base = b[3] > 0 ? b.slice(0, 3) : [255, 255, 255]; } let out = base; for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out).concat(1) && over(stack[i], out); return out; };
  const bad = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement; if (!el || el.closest('.emailprev,script,style,option')) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
    const fg = parse(cs.color); const bg = bgOf(el); const fgc = over(fg, bg);
    const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700, large = px >= 24 || (px >= 18.66 && bold);
    const eff = Number(cs.opacity); if (ratio < (large ? 3 : 4.5) && eff >= 0.99) bad.push(`${ratio.toFixed(2)} ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${n.nodeValue.trim().slice(0, 40)}"`);
  }
  return bad;
});
let fails = 0;
for (const theme of ['light', 'dark']) {
  for (const url of PAGES) {
    await page.evaluateOnNewDocument((t) => localStorage.setItem('eod-theme', t), theme).catch(() => {});
    await page.goto(BASE + url, { waitUntil: 'networkidle0' });
    await page.evaluate((t) => { localStorage.setItem('eod-theme', t); window.eodTheme.reapply(); }, theme);
    for (const sel of ['details:not([open])']) await page.$$eval(sel, (ds) => ds.forEach((d) => { d.open = true; }));
    const bad = await audit(); fails += bad.length;
    console.log(`${theme.padEnd(5)} ${url}: ${bad.length ? bad.length + ' low-contrast' : 'ok'}`); bad.slice(0, 12).forEach((b) => console.log('   ', b));
  }
}
await browser.close(); process.exit(fails ? 1 : 0);
