'use strict';
// History sparklines in the browser: graphs, hover tooltip, range switch, empty state.
// Runs on a data directory seeded by history.test.js (two months of total power).
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');

  // A measured iDRAC so the power card has a draw (and its own, still empty, history)
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  await page.evaluate(async ([csrf, fp]) => fetch('/api/admin/devices', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: 'Orion', kind: 'server', location: 'none', connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: fp, secret: 'calvin' }] }),
  }), [csrf, FP]);
  await page.waitForTimeout(1200);
  await page.reload();

  const power = page.locator('.hero .spark');
  await power.waitFor();
  check(await page.locator('#range button[aria-pressed=true]').textContent() === '24 h', 'range tabs in the top bar, 24 h selected');
  const label = await power.getAttribute('aria-label');
  check(/Measured draw, last 24 h: lowest 20\d W, highest 2\d\d W/.test(label), `power sparkline has a text summary (${label})`);
  const d = await page.locator('.hero .spark-line').getAttribute('d');
  check((d.match(/L/g) || []).length >= 100, 'power sparkline drawn from ~120 points');
  const box = await power.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  const tip = page.locator('.hero .spark-tip');
  check(await tip.isVisible() && /\d+ W/.test(await tip.textContent()), `hover shows value and time (${await tip.textContent()})`);
  const tb = await tip.boundingBox();
  check(tb.y + tb.height <= box.y + 1, 'tooltip sits above the graph');
  await page.screenshot({ path: `${S}/history-24h.png`, fullPage: true });
  const hb = await page.locator('.hero .spark-area').boundingBox();
  check(hb.x > box.x + box.width * 0.7, 'five hours of data fill only the right part of a 24 h graph');

  const empty = page.locator('.card', { hasText: 'Orion' }).locator('.spark-slot').first();
  check(/Collecting history/.test(await empty.textContent()), 'a new connection shows "Collecting history…"');

  // range switch: refetches and is remembered
  const req = page.waitForRequest((r) => r.url().includes('/api/history') && r.url().includes('range=30d'));
  await page.click('#range button:has-text("30 d")');
  await req;
  await page.waitForFunction(() => /last 30 d/.test(document.querySelector('.hero .spark')?.getAttribute('aria-label') || ''));
  check(true, '30 d range fetches the 30-day series');
  await page.reload();
  await page.locator('.hero .spark').waitFor();
  check(await page.locator('#range button[aria-pressed=true]').textContent() === '30 d', 'range choice remembered after reload');
  await page.screenshot({ path: `${S}/history-30d.png` });

  // mobile: no horizontal scroll with the range tabs in the top bar
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on a phone');
  await page.screenshot({ path: `${S}/history-mobile.png` });

  await page.click('#range button:has-text("24 h")');

  // services: response time under each checked service; dark theme
  await page.evaluate(async (csrf) => fetch('/api/admin/services', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: 'Mock web', connection: { url: 'http://127.0.0.1:18090/' } }),
  }), csrf);
  const dark = await (await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: 'dark', storageState: await ctx.storageState() })).newPage();
  await dark.goto(B + '/services');
  await dark.locator('.svc-card .spark-slot').waitFor();
  check(/Response time/.test(await dark.locator('.svc-card .spark-cell').textContent()), 'service card has a response-time graph');
  check(await dark.locator('#range .range-tabs').count() === 1, 'range tabs on the services page');
  await dark.screenshot({ path: `${S}/history-services-dark.png` });
  await dark.goto(B + '/');
  await dark.locator('.hero .spark').waitFor();
  await dark.screenshot({ path: `${S}/history-dark.png`, fullPage: true });
  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL HISTORY UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
