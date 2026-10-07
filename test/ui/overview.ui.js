'use strict';
// Home: what needs you as cards, power and the internet, a tile per device (one status word each),
// the details drawer, Customize (hide and reorder tiles), the look on this device, the phone layout,
// and the wall display.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
const WORDS = ['OK', 'Warning', 'Fault', 'Offline', 'Waiting', 'Not monitored'];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const post = (p, body) => page.evaluate(async ([c, p, body]) => (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify(body) })).json(), [csrf, p, body]);
  const c = (type, extra) => ({ type, address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, ...extra });
  await post('/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [c('unifi', { username: 'viewer', secret: 'unifipass' })] });
  await post('/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 19, height: 2, connections: [c('idrac', { username: 'root', secret: 'calvin' }), c('proxmox', { username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } })] });
  await post('/api/admin/devices', { name: 'truenas', kind: 'storage', location: 'rack', u: 13, height: 2, connections: [c('truenas', { username: 'truenas_admin', secret: '1-abcdefKEY' })] });
  await post('/api/admin/devices', { name: 'Rack switch', kind: 'switch', location: 'outside', height: 1, connections: [c('omada', { username: 'omview', secret: 'omadapass', options: { mac: 'aa:bb:cc:00:00:02' } })] });
  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForSelector('#needs .need');

  // what needs you
  const needs = await page.$$eval('#needs .need', (n) => n.map((x) => x.textContent));
  const total = await page.evaluate(async () => (await (await fetch('/api/dashboard')).json()).attention.length);
  check(needs.length === total && needs.some((t) => /titan.*PS2/.test(t)) && needs.some((t) => /truenas.*pool fast/.test(t)), `a card per problem (${needs.length}): ${needs.slice(0, 3).join(' | ')}`);
  check(await page.locator('#summary .pill.critical').count() === 1 && /\d+\/\d+ devices online/.test(await page.textContent('#summary')), 'the summary counts faults and devices online');
  await page.locator('#needs .need', { hasText: 'PS2' }).click();
  await page.waitForSelector('dialog.drawer[open] h2');
  check(await page.textContent('dialog.drawer h2') === 'titan', 'a problem opens its device');
  await page.keyboard.press('Escape');

  // tiles
  const words = await page.$$eval('#devices .dtile .status', (n) => n.map((x) => x.textContent));
  check(words.length === 8 && words.every((w) => WORDS.includes(w)), `one status per tile, from one vocabulary: ${words.join(', ')}`);
  const titan = page.locator('#devices .dtile', { hasText: 'titan' });
  check(/PS2/.test(await titan.locator('.tile-state').textContent()) && /W power/.test(await titan.locator('.tile-val').textContent()), 'titan: its worst problem and its power');
  check((await page.textContent('#devices .dtile:has-text("Rack switch")')).includes('Online'), 'a device bound to an Omada switch shows that switch');
  check(await page.locator('#devices .place').allTextContents().then((t) => t.join()) === 'In the rack,Elsewhere', 'tiles grouped: in the rack, elsewhere');
  check(!(await page.textContent('body')).includes('Collecting history'), 'no placeholders');

  // the drawer
  await titan.click();
  await page.waitForSelector('dialog.drawer[open] .section-title');
  check(await page.locator('dialog.drawer .section-title').allTextContents().then((t) => t.join()) === 'Hardware · iDRAC,Proxmox · node pve1' && await page.locator('dialog.drawer .fan').count() >= 6, 'drawer: iDRAC and Proxmox sections with the fans');
  check(await page.locator('dialog.drawer .callout').count() >= 2 && await page.locator('dialog.drawer .metrics .metric').count() >= 4, 'drawer: the problems first, then the numbers');
  check(!/Service tag|Power state/.test(await page.textContent('dialog.drawer')), 'fixed facts are left to the Docs sheet');
  check(await page.locator('dialog.drawer a:has-text("Server sheet")').count() === 1, 'the drawer links to the Docs sheet');
  await page.screenshot({ path: `${S}/home-drawer.png` });
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog.drawer', { state: 'detached', timeout: 3000 }).catch(() => {});
  check(await page.locator('dialog.drawer').count() === 0, 'Esc closes the drawer');

  // power
  check(await page.locator('.power-tile').count() === 1 && /W/.test(await page.textContent('.power-tile .big-num')), 'one power tile');
  await page.click('.power-tile');
  await page.waitForSelector('dialog.drawer[open] .power-tiles');
  check(await page.locator('dialog.drawer .power-tiles > .ptile').count() === 4 && /Per year at this draw/.test(await page.textContent('dialog.drawer')), 'power details: four numbers and the yearly figures');
  check(await page.locator('dialog.drawer .power-chart').count() === 0, 'no empty 30-day chart on a new install');
  await page.keyboard.press('Escape');
  check(/Up/.test(await page.textContent('.big.net .big-num')), 'the internet tile, from the UniFi console');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at 1440 px');
  await page.screenshot({ path: `${S}/home.png`, fullPage: true });

  // customize: hide truenas, move the UDM Pro last, save; survives a reload
  await page.click('#customize');
  await page.waitForSelector('#edit-bar:not([hidden])');
  await page.locator('#devices .dtile', { hasText: 'truenas' }).locator('.tile-hide').click();
  const udm = page.locator('#devices .dtiles[data-group="rack"] .dtile', { hasText: 'UDM Pro' });
  const last = page.locator('#devices .dtiles[data-group="rack"] .dtile').last();
  const from = await udm.boundingBox();
  const to = await last.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.click('#edit-bar button:text-is("Save")');
  await page.waitForSelector('#edit-bar[hidden]', { state: 'attached' });
  await page.reload();
  await page.waitForSelector('#devices .dtile');
  const rackTiles = await page.$$eval('#devices .dtiles[data-group="rack"] .tile-name', (n) => n.map((x) => x.textContent));
  check(!rackTiles.includes('truenas') && rackTiles[rackTiles.length - 1] === 'UDM Pro', `customize: hidden and reordered, kept after a reload (${rackTiles.join(', ')})`);

  // the look on this device: light with a teal accent, then back to the owner's
  await page.click('.look-button');
  await page.waitForSelector('dialog.look-menu');
  await page.click('dialog.look-menu .seg button:text-is("Light")');
  await page.click('dialog.look-menu .swatch[aria-label="Teal"]');
  await page.reload();
  await page.waitForSelector('#devices .dtile');
  check(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent].join()) === 'light,teal', 'this device keeps its own look after a reload');
  check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(251, 251, 252)', 'and the page is light');
  const owner = await page.evaluate(async () => (await (await fetch('/api/admin/config')).json()).settings.appearance);
  check(owner.theme === 'auto' && owner.accent === 'theme', 'the owner’s default is unchanged');
  await page.click('.look-button');
  await page.click('dialog.look-menu button:has-text("Use the owner")');
  check(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.accent].join()) === 'auto,theme', '"Use the owner’s look" goes back');
  await page.keyboard.press('Escape');

  // the rack view
  await page.click('.sidebar .nav-item:has-text("Rack")');
  await page.waitForSelector('#rack-view .rack-item');
  check(await page.isHidden('#view-home') && await page.locator('.sidebar .nav-item.active').textContent() === 'Rack', 'Rack is its own view in the top bar');

  // the wall display
  const wall = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark', storageState: await ctx.storageState() })).newPage();
  wall.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await wall.goto(B + '/wall');
  await wall.waitForSelector('#spot h2');
  check(/faults?/.test(await wall.textContent('#headline')) && await wall.locator('#probs li').count() === total, `wall: headline and every problem (${await wall.textContent('#headline')})`);
  const first = await wall.textContent('#spot h2');
  await wall.mouse.move(5, 1075);
  await wall.waitForFunction((t) => document.querySelector('#spot h2')?.textContent !== t, first, { timeout: 12000 });
  check(true, 'the spotlight moves on to the next problem by itself');
  check(await wall.locator('#wall-rack .rack-item').count() >= 3 && /\d/.test(await wall.textContent('#power .huge')), 'wall: rack and power');
  check(await wall.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth), 'wall: one screen, no scrolling at 1920 × 1080');
  const rk = await wall.locator('#wall-rack').boundingBox();
  const fig = await wall.locator('#wall-rack .rack-figure').boundingBox();
  check(fig.y + fig.height <= rk.y + rk.height + 2, 'wall: the rack fits its column');
  await wall.screenshot({ path: `${S}/wall.png` });

  // customize the wall: hide the problem list, put the rack first and big, show picked devices
  await wall.click('#wall-customize');
  await wall.waitForSelector('dialog.drawer[open] .wall-panels');
  const row = (id) => wall.locator(`.wall-panels li[data-id="${id}"]`);
  await row('list').locator('input[type=checkbox]').uncheck();
  check(await wall.locator('#list').isHidden(), 'customize: unticking a panel hides it right away (preview)');
  for (let i = 0; i < 2; i++) await row('rack').getByRole('button', { name: /up$/ }).click();
  await row('rack').locator('select').selectOption('big');
  await row('devices').locator('input[type=checkbox]').check();
  await row('devices').locator('select').selectOption('normal');
  await wall.selectOption('dialog.drawer select[name=devices-mode]', 'pick');
  for (const name of ['UDM Pro', 'truenas']) await wall.locator('dialog.drawer .wall-picks label', { hasText: name }).locator('input').uncheck();
  await wall.uncheck('dialog.drawer input[name=clock]');
  check(await wall.locator('dialog.drawer select[name=services-mode]').count() === 1 && !/object HTML/.test(await wall.textContent('dialog.drawer')), 'the services choice is a list (same as Home, or pick)');
  await wall.screenshot({ path: `${S}/wall-customize.png` });
  await wall.click('dialog.drawer button:has-text("Save")');
  await wall.waitForSelector('dialog.drawer', { state: 'detached' });
  const saved = await wall.evaluate(async () => (await (await fetch('/api/dashboard')).json()).wall);
  check(saved.panels[0].id === 'rack' && saved.panels[0].size === 'big' && saved.hidden.includes('list') && !saved.hidden.includes('devices') && saved.devices.length === 6 && !saved.clock, `customize: saved on the server (${saved.panels.map((p) => `${p.id}:${p.size}`).join(' ')})`);
  await wall.reload();
  await wall.waitForSelector('#devs .dev-tile');
  const rackBox = await wall.locator('#rack').boundingBox();
  const spotBox = await wall.locator('#spot').boundingBox();
  check(rackBox.x < spotBox.x && rackBox.width > spotBox.width * 1.8 && await wall.locator('#list').isHidden() && await wall.locator('.clock').isHidden(), 'after a reload: the rack first and big, no problem list, no clock');
  const tiles = await wall.locator('#devs .dev-tile b').allTextContents();
  check(tiles.length === 6 && !tiles.includes('UDM Pro') && tiles.includes('titan'), `the devices panel shows the picked devices (${tiles.join(', ')})`);
  check(await wall.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'still one screen');
  await wall.screenshot({ path: `${S}/wall-custom.png` });
  // a viewer without login sees no Customize; Default layout brings the first look back
  await wall.click('#wall-customize');
  await wall.click('dialog.drawer button:has-text("Default layout")');
  await wall.click('dialog.drawer button:has-text("Save")');
  await wall.waitForSelector('dialog.drawer', { state: 'detached' });
  check(!(await wall.locator('#list').isHidden()) && await wall.locator('#devs').isHidden(), 'Default layout restores the original wall');
  const bad = await wall.evaluate(async () => {
    const { csrf } = await (await fetch('/api/session')).json();
    return (await fetch('/api/admin/wall', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ panels: [{ id: 'evil', size: 'big' }] }) })).status;
  });
  check(bad === 400, 'an unknown panel is refused');

  // phone
  await page.goto(B + '/');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector('#devices .dtile');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling on a phone');
  const cols = await page.$$eval('#devices .dtiles[data-group="other"] .dtile, #devices .dtiles[data-group="rack"] .dtile', (n) => new Set(n.map((x) => Math.round(x.getBoundingClientRect().left))).size);
  check(cols === 2, 'phone: tiles two by two');
  const order = await page.evaluate(() => ['needs-sec', 'hero', 'devices-sec'].map((id) => document.getElementById(id).getBoundingClientRect().top));
  check(order[0] < order[1] && order[1] < order[2], 'phone order: what needs you, power, devices');
  await page.locator('#devices .dtile', { hasText: 'titan' }).click();
  await page.waitForSelector('dialog.drawer.open');
  await page.waitForTimeout(400); // it slides up
  const sheet = await page.locator('dialog.drawer').boundingBox();
  check(Math.round(sheet.y + sheet.height) >= 843 && sheet.width >= 389, 'phone: details come up as a sheet from the bottom');
  await page.screenshot({ path: `${S}/home-phone-sheet.png` });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${S}/home-phone.png`, fullPage: true });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL HOME UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
