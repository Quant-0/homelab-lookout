'use strict';
// Rack: realistic fronts from the reported models, passive panels, the empty-U chooser and the
// front setting in the device editor.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const call = (method, p, body) => page.evaluate(async ([c, method, p, body]) => {
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, [csrf, method, p, body]);

  // a rack like the real one
  await call('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', tlsMode: 'pin', fingerprint: FP, secret: 'unifipass' }] });
  await call('POST', '/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 19, height: 2, connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  await call('POST', '/api/admin/devices', { name: 'orion', kind: 'server', location: 'rack', u: 17, height: 2, front: { model: 'dell14', drives: '8x3.5' } });
  await call('POST', '/api/admin/devices', { name: 'DS418', kind: 'nas', location: 'rack', u: 11, height: 3, front: { model: 'synology-ds', drives: 'auto' } });
  // a server picked from the catalog: the brand chooses the front
  await call('POST', '/api/admin/devices', { name: 'lynx', kind: 'server', location: 'rack', u: 7, height: 2, model: { brand: 'HPE', name: 'ProLiant DL380 Gen10' } });
  await call('POST', '/api/admin/devices', { name: 'core', kind: 'switch', location: 'rack', u: 3, height: 1, front: { model: 'u-usw-pro-max-48-poe', drives: 'auto' } });
  for (const [kind, u, height, ports] of [['patch', 23, 1, 24], ['brush', 21, 1], ['cable', 16, 1], ['blank', 15, 1], ['vented', 14, 1], ['shelf', 10, 1], ['blank', 1, 2]]) {
    await call('POST', '/api/admin/rack/passive', { kind, u, height, ...(ports ? { ports } : {}) });
  }
  await page.waitForTimeout(1500);
  const cfg = await call('GET', '/api/admin/config');
  const sw = cfg.devices.find((d) => d.discovered && /USW/.test(d.name));
  await call('PUT', `/api/admin/devices/${sw.id}/placement`, { location: 'rack', u: 22, height: 1 });

  await page.goto(B + '/#rack');
  await page.waitForSelector('#rack-view .rack-item.front-udm-pro');
  const fronts = await page.$$eval('#rack-view .rack-item:not(.passive)', (n) => n.map((x) => x.className.match(/front-([a-z0-9-]+)/)[1]));
  check(['udm-pro', 'usw-24-poe', 'dell13', 'dell14', 'synology-ds', 'hpe'].every((f) => fronts.includes(f)), `fronts follow the models: ${fronts.join(', ')}`);
  check(await page.locator('#rack-view .front-hpe .drive').count() === 8, 'HPE from the catalog: its own front with 8 × 3.5″ bays');
  check(await page.locator('#rack-view .front-u-usw-pro-max-48-poe .port').count() === 52 && await page.locator('#rack-view .front-u-usw-pro-max-48-poe .u-screen').count() === 1, 'UniFi Pro Max 48 PoE: its touchscreen, 48 jacks and 4 SFP cages');
  check(await page.locator('#rack-view .offrack-item .shape-ap-square').count() === 1, 'the U7 Pro found through the console is drawn as itself beside the rack');
  check(await page.locator('#rack-view .offrack-item .shape-cam-bullet').count() === 1 && await page.locator('#rack-view .offrack-item .shape-doorbell').count() === 1, 'Protect cameras appear by themselves, drawn as their models (G5 Bullet, G4 Doorbell Pro)');
  check(await page.locator('#rack-view .front-dell13 .drive').count() === 12, 'R730xd (13th gen, xd): 12 × 3.5″ bays');
  check(await page.locator('#rack-view .front-dell13 .drive.on').count() === 10 && await page.locator('#rack-view .front-dell13 .drive.empty').count() === 2 && await page.locator('#rack-view .front-dell13 .dell-power.on').count() === 1, 'the drives the iDRAC reports are lit, empty bays are blanks; power LED lit');
  check(await page.locator('#rack-view .front-dell13 .drive.warning').count() === 1 && /Bay 4 · ST4000NM0035 · 4\.0 TB · HDD · predicted to fail/.test(await page.locator('#rack-view .front-dell13 .drive.warning title').textContent()), 'the drive predicted to fail shows amber, with its details on hover');
  check(await page.locator('#rack-view .front-dell14 .drive').count() === 8 && await page.locator('#rack-view .front-dell14 .drive.on').count() === 0, 'orion: chosen front, not monitored, LEDs off');
  check(await page.locator('#rack-view .front-udm-pro .port').count() === 11 && await page.locator('#rack-view .front-usw-24-poe .port').count() === 26, 'UDM Pro 8+1+2 ports, switch 24+2 from live data');
  check(await page.locator('#rack-view .front-usw-24-poe .port.up').count() > 0 && await page.locator('#rack-view .front-usw-24-poe .port.poe').count() > 0, 'link and PoE LEDs from the switch');
  check(await page.locator('#rack-view .rack-label strong', { hasText: 'titan' }).count() === 1 && await page.locator('#rack-view .front-dell13 text').count() === 1, 'the name stands beside the rack, not on the front (only the LCD has text)');
  const passive = await page.$$eval('#rack-view .rack-item.passive', (n) => n.map((x) => [x.className.match(/p-([a-z]+)/)[1], x.getAttribute('aria-hidden'), x.textContent]));
  check(passive.length === 7 && passive.every(([, hidden, text]) => hidden === 'true' && text === ''), `7 passive items, no names, hidden from screen readers (${passive.map((p) => p[0]).join(', ')})`);
  check(await page.locator('#rack-view .p-patch .jack').count() === 24, 'patch panel: 24 jacks');
  const box = await page.locator('#rack-view .front-dell13').boundingBox();
  check(Math.abs(box.width / box.height - 482.6 / 88.9) < 0.12, `drawn to scale: a 2 U front is 482.6 × 88.9 mm (${(box.width / box.height).toFixed(2)} : 1)`);
  await page.locator('#rack-view').screenshot({ path: `${S}/rack-dashboard.png` });
  await page.click('#rack-view .rack-mode button:has-text("Schematic")');
  await page.waitForSelector('#rack-view .rack2.schematic');
  check(await page.locator('#rack-view .rack-item.sch:not(.passive)').count() === 7 && await page.locator('#rack-view .rack-label').count() === 0 && /titan/.test(await page.textContent('#rack-view .rack-item.sch.front-dell13, #rack-view .rack-item.sch.kind-server')), 'Schematic: flat blocks with the names inside');
  await page.locator('#rack-view').screenshot({ path: `${S}/rack-schematic.png` });
  await page.reload();
  await page.waitForSelector('#rack-view .rack2');
  check(await page.locator('#rack-view .rack2.schematic').count() === 1, 'the choice is remembered');
  await page.click('#rack-view .rack-mode button:has-text("Realistic")');
  await page.waitForSelector('#rack-view .rack2.realistic .front-dell13');
  await page.locator('#rack-view .front-dell13').click();
  await page.waitForSelector('dialog.drawer[open]');
  check(await page.textContent('dialog.drawer h2') === 'titan', 'clicking a server opens its details');
  await page.keyboard.press('Escape');

  // admin: empty U → chooser → patch panel; edit it
  await page.goto(B + '/admin#devices');
  await page.waitForSelector('#rack-preview .rack-item');
  await page.evaluate(() => document.querySelector('#rack-preview .rack-bay').scrollIntoView({ block: 'end' }));
  const slots = await page.locator('#rack-preview .rack-bay').boundingBox();
  await page.mouse.dblclick(slots.x + slots.width / 2, slots.y + slots.height * (1 - 4.5 / 24)); // U5
  await page.waitForSelector('#rack-add:not([hidden])');
  check(await page.textContent('#rack-add-title') === 'Add at U5', 'double-click on an empty U offers what to add');
  await page.click('#rack-add-choices button:has-text("Patch panel")');
  await page.waitForSelector('#passive-editor:not([hidden])');
  check(await page.textContent('#passive-title') === 'Patch panel at U5' && await page.isVisible('#passive-form select[name=ports]'), 'patch panel added; editor shows its ports');
  await page.selectOption('#passive-form select[name=ports]', '48');
  await page.fill('#passive-form input[name=height]', '2');
  await page.click('#passive-form button[type=submit]');
  await page.waitForSelector('#passive-editor[hidden]', { state: 'attached' });
  check(await page.locator('#rack-preview .p-patch.h2 .jack').count() === 48, '48-port 2 U patch panel drawn');
  await page.locator('#rack-preview .p-brush').click();
  await page.waitForSelector('#passive-editor:not([hidden])');
  check(!(await page.isVisible('#passive-form select[name=ports]')), 'no ports field for a brush panel');
  await page.click('#passive-delete');
  await page.waitForFunction(() => !document.querySelector('#rack-preview .p-brush'), null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('#rack-preview .p-brush').count() === 0 && await page.locator('#passive-editor').isHidden(), 'panel removed');

  // device editor: front setting
  await page.locator('#rack-preview .front-dell13').click();
  await page.waitForSelector('#device-editor:not([hidden])');
  check(/Automatic here: Dell PowerEdge, 13th gen.*12 × 3.5″/.test(await page.textContent('#device-front-hint')), `front hint: ${await page.textContent('#device-front-hint')}`);
  const kinds = await page.$$eval('#device-kind option', (o) => o.map((x) => x.value));
  check(!kinds.includes('blank') && !kinds.includes('patch-panel'), 'panels are no longer device types');
  await page.selectOption('#device-drives', '24x2.5');
  await page.click('#device-save');
  await page.waitForSelector('#device-editor[hidden]', { state: 'attached' });
  await page.waitForFunction(() => document.querySelectorAll('#rack-preview .front-dell13 .drive').length === 24);
  check(true, 'drive bays changed to 24 × 2.5″');
  await page.locator('.rack-preview-card').screenshot({ path: `${S}/rack-admin.png` });

  // dark theme and a narrow rack panel
  const dark = await (await browser.newContext({ viewport: { width: 1000, height: 900 }, colorScheme: 'dark', storageState: await ctx.storageState() })).newPage();
  await dark.goto(B + '/#rack');
  await dark.waitForSelector('#rack-view .rack-item.front-udm-pro');
  await dark.locator('#rack-view').screenshot({ path: `${S}/rack-dashboard-narrow.png` });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL RACK UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
