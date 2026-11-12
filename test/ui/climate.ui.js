'use strict';
// Climate on the pages: the sensors on Home by room, a sensor's details, the device it belongs to,
// the wall panel, and the Admin card (sources and the sensor table). Readings are pushed like a
// Shelly H&T does, so no mock is needed.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  check(await page.locator('#climate-sec').isHidden(), 'no Climate on Home before a source is added');

  // a Shelly that pushes, added in Admin
  await page.goto(B + '/admin#climate');
  await page.waitForSelector('#climate-card');
  await page.selectOption('#climate-add', 'shelly');
  await page.fill('#climate-editor input[name=name]', 'Shellies');
  await page.click('#climate-editor button.primary');
  await page.waitForSelector('#climate-editor pre');
  const pushUrl = (await page.textContent('#climate-editor pre')).trim();
  check(/\/climate\/push\/[A-Za-z0-9_-]{32}$/.test(pushUrl), 'the push address is shown for a Shelly without an address');
  const push = (q) => page.request.get(`${B}${new URL(pushUrl).pathname}?${q}`);
  await push('id=bed&temp=19.4&hum=51&bat=90');
  await push('id=office&temp=26.2&hum=35&bat=12');
  const csrf = (await (await page.request.get(`${B}/api/session`)).json()).csrf;
  const dev = (await (await page.request.post(`${B}/api/admin/devices`, { data: { name: 'atlas', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ type: 'ping', address: '127.0.0.1' }] }, headers: { 'X-CSRF-Token': csrf } })).json()).device;
  await page.reload();
  await page.waitForSelector('#climate-sensors table');
  // the sensor table: a room, a device and a limit for the office
  const office = page.locator('#climate-sensors tr', { hasText: '26' });
  await office.locator('input[aria-label=Room]').fill('Office');
  await office.locator('input[aria-label=Room]').dispatchEvent('change');
  await office.locator('select[aria-label=Device]').selectOption(dev.id);
  await office.locator('input[aria-label="Too warm above"]').fill('25');
  await office.locator('input[aria-label="Too warm above"]').dispatchEvent('change');
  await page.waitForTimeout(500);
  const st = (await (await page.request.get(`${B}/api/admin/climate`)).json()).sensors.find((x) => x.temp === 26.2);
  check(st.room === 'Office' && st.deviceId === dev.id && st.max === 25, 'the table saves the room, the device and the limit as they are changed');
  await page.screenshot({ path: `${S}/climate-admin.png`, fullPage: true });

  // Home
  await page.goto(B + '/');
  await page.waitForSelector('#climate-sec .clim-tile');
  const tiles = await page.locator('#climate-sec .clim-tile').count();
  const text = await page.textContent('#climate-sec');
  check(tiles === 2 && /Office/.test(text) && /office/.test(text) && /bed/.test(text) && /26\.2°/.test(text) && /19\.4°/.test(text) && /12 %/.test(text), `a tile per sensor, by room, with the low battery shown (${tiles} tiles)`);
  check(await page.locator('#climate-sec .clim-tile.warning').count() === 1, 'the office, above its limit, is marked');
  check((await page.textContent('#needs-sec')).includes('26.2 °C'), 'and is under Needs you');
  await page.screenshot({ path: `${S}/climate-home.png`, fullPage: true });
  await page.locator('#climate-sec .clim-tile.warning').click();
  await page.waitForSelector('.clim-card');
  const det = await page.textContent('.clim-card');
  check(/Office/.test(det) && /at atlas/.test(det) && /warm above 25/.test(det) && /12 %/.test(det) && (await page.locator('.clim-card .spark-slot, .clim-card [data-key]').count()) >= 1, 'its details: room, device, limits, battery and graphs');
  await page.keyboard.press('Escape');
  // the device shows its sensor
  await page.goto(`${B}/#device-${dev.id}`);
  await page.waitForSelector('.d-climate');
  check(/26\.2°/.test(await page.textContent('.d-climate')), 'the device it belongs to shows the temperature');
  await page.keyboard.press('Escape');

  // the wall
  const wall = (await (await page.request.get(`${B}/api/dashboard`)).json()).wall;
  await page.request.put(`${B}/api/admin/wall`, { data: { ...wall, hidden: wall.hidden.filter((x) => x !== 'climate') }, headers: { 'X-CSRF-Token': csrf } });
  await page.goto(B + '/wall');
  await page.waitForSelector('#climate .clim-wall li');
  const wt = await page.textContent('#climate');
  check((await page.locator('#climate .clim-wall li').count()) === 2 && /office/i.test(wt), `the wall lists the sensors (${wt.slice(0, 120)})`);
  await page.screenshot({ path: `${S}/climate-wall.png` });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState() });
  const pp = await phone.newPage();
  await pp.goto(B + '/');
  await pp.waitForSelector('#climate-sec .clim-tile');
  check(await pp.evaluate(() => document.documentElement.scrollWidth <= 390), 'Climate fits a phone');

  console.log(problems.length ? `\n${problems.length} PROBLEM(S)\n${problems.join('\n')}` : '\nUI OK: no console/CSP errors\nALL CLIMATE UI TESTS PASSED');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
