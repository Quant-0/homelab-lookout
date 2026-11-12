'use strict';
// The wall's Customize on the wall itself: a new named layout for one screen, more columns, larger
// text and less space, the new panels (clock, note, a graph, one device, one service) with their
// options, and /wall?layout=… showing it while plain /wall keeps the default
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = (await (await page.request.get(`${B}/api/session`)).json()).csrf;
  await page.request.post(`${B}/api/admin/devices`, { data: { name: 'atlas', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ type: 'ping', address: '127.0.0.1' }] }, headers: { 'X-CSRF-Token': csrf } });

  await page.goto(B + '/wall');
  await page.waitForSelector('#spot');
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.type() === 'prompt' ? d.accept('Kitchen tablet') : d.accept();
  });
  await page.click('#wall-customize');
  await page.waitForSelector('#wall-edit:not([hidden])');
  // a new layout, from this one
  await page.selectOption('#wall-edit select[aria-label="Layout"]', '__new');
  await page.waitForFunction(() => document.querySelector('#wall-edit select[aria-label="Layout"]').value === 'kitchen-tablet');
  check(dialogs.some((m) => /name for the new layout/.test(m)), 'a new layout asks for its name');
  await page.selectOption('#wall-edit select[aria-label="Columns"]', '4');
  await page.selectOption('#wall-edit select[aria-label="Space"]', 'tight');
  await page.locator('#wall-edit input[type=range]').fill('130');
  check(await page.evaluate(() => getComputedStyle(document.getElementById('wall-grid')).gridTemplateColumns.split(' ').length) === 4, 'four columns at once');
  check(await page.evaluate(() => document.getElementById('wall').style.getPropertyValue('--wall-scale')) === '1.3', 'the text size follows the slider');
  // a clock, a note and a graph
  const add = async (type) => {
    await page.selectOption('#wall-edit select[aria-label="Add a panel"]', type);
    await page.waitForTimeout(200);
  };
  await add('clock');
  check(await page.locator('.w.clock-panel .big-clock').count() === 1 && /\d\d:\d\d/.test(await page.textContent('.w.clock-panel')), 'a clock panel');
  await add('note');
  await page.waitForSelector('dialog.drawer[open] textarea');
  await page.fill('dialog.drawer textarea', 'Wi-Fi: Guests\nCall Kim if the lights go red');
  await page.locator('dialog.drawer textarea').dispatchEvent('change');
  await page.locator('dialog.drawer .we-opt', { hasText: 'Title' }).first().locator('select').selectOption('own');
  await page.keyboard.press('Escape');
  check(/Call Kim/.test(await page.textContent('.w.note-panel')), 'a note with its own text');
  await add('graph');
  await page.waitForSelector('dialog.drawer[open] .we-opt');
  await page.locator('dialog.drawer .we-opt', { hasText: 'Value' }).locator('select').selectOption('power:total');
  await page.locator('dialog.drawer .we-opt', { hasText: 'Time span' }).locator('select').selectOption('7d');
  await page.keyboard.press('Escape');
  check(/Power draw/.test(await page.textContent('.w.graph')) && /7 days/.test(await page.textContent('.w.graph')), 'a graph of the power draw over 7 days');
  await add('device');
  await page.waitForSelector('dialog.drawer[open] .we-opt');
  await page.locator('dialog.drawer .we-opt', { hasText: 'Device' }).locator('select').selectOption({ label: 'atlas' });
  await page.keyboard.press('Escape');
  check(/atlas/.test(await page.textContent('.w.device-panel')), 'one device, large');
  check(!(await page.locator('#wall-edit select[aria-label="Add a panel"] option[value="spot"]').count()), 'a panel there can only be one of is no longer offered');
  await page.screenshot({ path: `${S}/wall-edit.png` });
  await page.click('#wall-edit button:has-text("Save")');
  await page.waitForURL(/\/wall\?layout=kitchen-tablet$/);
  await page.waitForSelector('.w.note-panel');
  const saved = (await (await page.request.get(`${B}/api/dashboard`)).json()).walls.find((l) => l.slug === 'kitchen-tablet');
  check(saved && saved.name === 'Kitchen tablet' && saved.cols === 4 && saved.scale === 130 && saved.gap === 'tight' && ['clock', 'note', 'graph', 'device'].every((t) => saved.panels.some((p) => p.type === t)), 'saved as its own layout, at its own address');
  check(saved.panels.find((p) => p.type === 'note').opts.text.includes('Call Kim') && saved.panels.find((p) => p.type === 'graph').opts.range === '7d', 'with the panels\' options');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${S}/wall-kitchen.png` });
  check(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth), 'still one screen, no scrolling');
  // plain /wall is still the default one
  await page.goto(B + '/wall');
  await page.waitForSelector('#spot');
  check(await page.locator('.w.note-panel').count() === 0 && await page.evaluate(() => getComputedStyle(document.getElementById('wall-grid')).gridTemplateColumns.split(' ').length) === 3, 'plain /wall keeps the default layout');

  console.log(problems.length ? `\n${problems.length} PROBLEM(S)\n${problems.join('\n')}` : '\nUI OK: no console/CSP errors\nALL WALL UI TESTS PASSED');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
