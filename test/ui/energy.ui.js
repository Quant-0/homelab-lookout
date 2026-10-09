'use strict';
// Energy report page on seeded data (see energy.test.js): tiles, bars, per device, downloads,
// month/year switching and the phone layout.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  await page.waitForSelector('.power-tile');
  await page.click('.power-tile');
  await page.click('dialog.drawer a:has-text("Energy report")');
  await page.waitForURL(B + '/energy');
  await page.waitForSelector('#en-tiles .tile');
  check(true, 'the power tile opens the details, which link to the report');

  await page.goto(B + '/energy#2026-09');
  await page.waitForFunction(() => document.getElementById('en-period').value === '2026-09');
  const tiles = await page.$$eval('#en-tiles .value', (n) => n.map((x) => x.textContent));
  check(tiles[0] === '180.0 kWh' && /180 kr/.test(tiles[1]) && tiles[2] === '100.0 øre/kWh', `tiles: ${tiles.join(' | ')}`);
  check(await page.locator('#en-chart rect.bar').count() === 30, 'a bar per day');
  const devices = await page.$$eval('.energy-device .label', (n) => n.map((x) => x.textContent));
  check(devices[0] === 'titan' && devices.includes('USW-24-POE'), `per device, largest first (${devices.join(', ')})`);
  const links = await page.$$eval('#en-downloads a', (n) => n.map((a) => a.getAttribute('href')));
  check(links.length === 2 && links.includes('/api/energy/export?period=2026-09&by=day&format=no') && links.includes('/api/energy/export?period=2026-09&by=day&format=std'), 'month: per-day downloads in both formats');
  check(!/null|undefined/.test(await page.textContent('main')), 'no stray "null" on the page');
  await page.locator('#en-chart rect.hit').nth(4).hover();
  check(/2026-09-05/.test(await page.textContent('#en-chart .tooltip')), 'hover shows the day');
  await page.screenshot({ path: `${S}/energy-month.png`, fullPage: true });

  await page.click('#en-year');
  await page.waitForFunction(() => location.hash === '#2026');
  await page.waitForFunction(() => document.querySelectorAll('#en-chart rect.bar').length === 12);
  check((await page.$$eval('#en-downloads a', (n) => n.length)) === 4, 'year: per-day and per-month downloads');
  check(/vs 2025/.test(await page.textContent('#en-tiles')), 'compared with the year before');
  await page.click('#en-prev');
  await page.waitForFunction(() => document.getElementById('en-period').value === '2025');
  check(/2\.40 kWh/.test(await page.textContent('#en-tiles')), 'previous year (2.40 kWh)');
  await page.click('#en-month');
  await page.waitForFunction(() => document.getElementById('en-period').value === '2025-09');
  check(true, 'back to a month with data in that year');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(B + '/energy#2026-09');
  await page.waitForSelector('#en-chart rect.bar');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling on a phone');
  const tops = await page.$$eval('#en-prev, #en-period, #en-next', (n) => n.map((x) => Math.round(x.getBoundingClientRect().top + x.offsetHeight / 2)));
  check(Math.max(...tops) - Math.min(...tops) <= 2, 'phone: ‹ period › stay on one row');
  const totals = await page.$$eval('#en-tiles .tile', (n) => n.map((x) => ({ top: Math.round(x.getBoundingClientRect().top), cut: x.querySelector('.value').scrollWidth > x.querySelector('.value').clientWidth + 1 })));
  check(new Set(totals.map((t) => t.top)).size === 3 && totals.every((t) => !t.cut), 'phone: the three totals are rows, with no number cut short');
  await page.screenshot({ path: `${S}/energy-phone.png`, fullPage: true });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL ENERGY UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
