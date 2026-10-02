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
  for (const [kind, u, height, ports] of [['patch', 23, 1, 24], ['brush', 21, 1], ['cable', 16, 1], ['blank', 15, 1], ['vented', 14, 1], ['shelf', 10, 1], ['blank', 1, 2]]) {
    await call('POST', '/api/admin/rack/passive', { kind, u, height, ...(ports ? { ports } : {}) });
  }
  await page.waitForTimeout(1500);
  const cfg = await call('GET', '/api/admin/config');
  const sw = cfg.devices.find((d) => d.discovered && /USW/.test(d.name));
  await call('PUT', `/api/admin/devices/${sw.id}/placement`, { location: 'rack', u: 22, height: 1 });

  await page.goto(B + '/');
  await page.waitForSelector('#rack-panel .rack-item.front-udm-pro');
  const fronts = await page.$$eval('#rack-panel .rack-item:not(.passive)', (n) => n.map((x) => x.className.match(/front-([a-z0-9-]+)/)[1]));
  check(['udm-pro', 'usw-24-poe', 'dell13', 'dell14', 'synology-ds'].every((f) => fronts.includes(f)), `fronts follow the models: ${fronts.join(', ')}`);
  check(await page.locator('#rack-panel .front-dell13 .drive').count() === 12, 'R730xd (13th gen, xd): 12 × 3.5″ bays');
  check(await page.locator('#rack-panel .front-dell13 .drive.on').count() === 12 && await page.locator('#rack-panel .front-dell13 .dell-power.on').count() === 1, 'powered on: drive and power LEDs lit');
  check(await page.locator('#rack-panel .front-dell14 .drive').count() === 8 && await page.locator('#rack-panel .front-dell14 .drive.on').count() === 0, 'orion: chosen front, not monitored, LEDs off');
  check(await page.locator('#rack-panel .front-udm-pro .port').count() === 11 && await page.locator('#rack-panel .front-usw-24-poe .port').count() === 26, 'UDM Pro 8+1+2 ports, switch 24+2 from live data');
  check(await page.locator('#rack-panel .front-usw-24-poe .port.up').count() > 0 && await page.locator('#rack-panel .front-usw-24-poe .port.poe').count() > 0, 'link and PoE LEDs from the switch');
  check(await page.locator('#rack-panel .front-dell13 .fp-tag').textContent() === 'titan', 'name shown as a label on the front');
  const passive = await page.$$eval('#rack-panel .rack-item.passive', (n) => n.map((x) => [x.className.match(/p-([a-z]+)/)[1], x.getAttribute('aria-hidden'), x.textContent]));
  check(passive.length === 7 && passive.every(([, hidden, text]) => hidden === 'true' && text === ''), `7 passive items, no names, hidden from screen readers (${passive.map((p) => p[0]).join(', ')})`);
  check(await page.locator('#rack-panel .p-patch .patch-jacks i').count() === 24, 'patch panel: 24 jacks');
  await page.locator('#rack-panel').screenshot({ path: `${S}/rack-dashboard.png` });
  await page.locator('#rack-panel .front-dell13').click();
  await page.waitForTimeout(600);
  check(await page.evaluate(() => document.querySelector('.widget.flash h3')?.textContent) === 'titan', 'clicking a server still jumps to its widget');

  // admin: empty U → chooser → patch panel; edit it
  await page.goto(B + '/admin#devices');
  await page.waitForSelector('#rack-preview .rack-item');
  const slots = await page.locator('#rack-preview .rack-slots').boundingBox();
  await page.mouse.dblclick(slots.x + slots.width / 2, slots.y + slots.height - 28 * 5 + 10); // U5
  await page.waitForSelector('#rack-add:not([hidden])');
  check(await page.textContent('#rack-add-title') === 'Add at U5', 'double-click on an empty U offers what to add');
  await page.click('#rack-add-choices button:has-text("Patch panel")');
  await page.waitForSelector('#passive-editor:not([hidden])');
  check(await page.textContent('#passive-title') === 'Patch panel at U5' && await page.isVisible('#passive-form select[name=ports]'), 'patch panel added; editor shows its ports');
  await page.selectOption('#passive-form select[name=ports]', '48');
  await page.fill('#passive-form input[name=height]', '2');
  await page.click('#passive-form button[type=submit]');
  await page.waitForSelector('#passive-editor[hidden]', { state: 'attached' });
  check(await page.locator('#rack-preview .p-patch.h2 .patch-jacks i').count() === 48, '48-port 2 U patch panel drawn');
  await page.locator('#rack-preview .p-brush').click();
  await page.waitForSelector('#passive-editor:not([hidden])');
  check(!(await page.isVisible('#passive-form select[name=ports]')), 'no ports field for a brush panel');
  await page.click('#passive-delete');
  await page.waitForSelector('#passive-editor[hidden]', { state: 'attached' });
  check(await page.locator('#rack-preview .p-brush').count() === 0, 'panel removed');

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
  const dark = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark', storageState: await ctx.storageState() })).newPage();
  await dark.goto(B + '/');
  await dark.waitForSelector('#rack-panel .rack-item.front-udm-pro');
  await dark.locator('#rack-panel').screenshot({ path: `${S}/rack-dashboard-narrow.png` });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL RACK UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
