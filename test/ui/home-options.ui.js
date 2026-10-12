'use strict';
// Admin → Dashboard choices for Home: services as tiles, a compact list, only the ones down, or off;
// "Show on Home" per service; service alerts on or off; where VMs and containers show, and with what.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const M = 'http://127.0.0.1:18090';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let refused = 0; // the one 400 this test asks for
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !(/status of 400/.test(m.text()) && !refused++) && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const call = (method, p, body) => page.evaluate(async ([c, method, p, body]) => {
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }, [csrf, method, p, body]);
  await call('POST', '/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 19, height: 2, connections: [{ type: 'proxmox', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } }] });
  await call('POST', '/api/admin/services', { name: 'Jellyfin', group: 'Media', href: 'https://jellyfin.example.lan', connection: { url: `${M}/jellyfin` }, integration: { type: 'jellyfin', options: {} }, secret: 'svc-key-123' });
  await call('POST', '/api/admin/services', { name: 'Gone', group: 'Media', href: 'https://gone.example.lan', connection: { url: 'http://127.0.0.1:1/' } });
  const quiet = await call('POST', '/api/admin/services', { name: 'Quiet', group: 'Media', href: 'https://quiet.example.lan', onHome: false });
  check(quiet.status === 201 && quiet.json.service.onHome === false, 'a service can be left off Home');
  const { settings } = (await call('GET', '/api/admin/config')).json;
  const dash = settings.dashboard;
  check(dash.homeServices === 'line' && dash.serviceAlerts === true && dash.vms.home && dash.vms.stopped && !dash.vms.homeNumbers, 'defaults: services and VMs as one line at the bottom, alerts on, VMs everywhere');
  const set = async (change) => {
    const r = await call('PUT', '/api/admin/settings', { dashboard: { ...dash, ...change, vms: { ...dash.vms, ...change.vms } } });
    await page.goto(B + '/');
    await page.reload();
    await page.waitForSelector('#summary .pill');
    await page.waitForTimeout(300);
    return r;
  };
  check((await call('PUT', '/api/admin/settings', { dashboard: { ...dash, homeServices: 'big' } })).status === 400, 'an unknown choice is refused');
  await page.waitForTimeout(2500);

  // the default: one line at the bottom for services and VMs
  await set({});
  const foot = await page.textContent('#home-foot');
  check(/1 of 2 services up/.test(foot) && /2 of 3 VMs running/.test(foot) && await page.locator('#services-sec').isHidden() && await page.locator('#vms-sec').isHidden(), `default: one line (${foot.trim()})`);

  // tiles: the two services meant for Home, the down one first
  await set({ homeServices: 'tiles', vms: { homeNumbers: true } });
  await page.waitForSelector('#services .dtile');
  const tiles = await page.locator('#services .dtile .tile-name').allTextContents();
  check(tiles.join() === 'Gone,Jellyfin', `tiles, down first, "Quiet" left out (${tiles})`);
  check(/Gone/.test(await page.textContent('#needs')) && /fault/.test(await page.textContent('#summary')), 'a down service is under "Needs you" and counted at the top');
  // VMs on Home as a section: stopped ones too
  const chips = await page.locator('#vms .chip').allTextContents();
  check(chips.length === 3 && chips.includes('win11'), `VM section on Home, stopped too (${chips})`);
  await page.screenshot({ path: `${S}/home-options-tiles.png`, fullPage: true });

  // compact list
  await set({ homeServices: 'compact' });
  check(await page.locator('#services.svc-lines .svc-line').count() === 2 && await page.locator('#services .dtile').count() === 0, 'compact: one row per service');
  check(/127\.0\.0\.1|refused|Down|ECONN/i.test(await page.textContent('#services .svc-line.critical')), 'compact: the down row says why');
  await page.screenshot({ path: `${S}/home-options-compact.png`, fullPage: true });

  // only the ones down
  await set({ homeServices: 'down' });
  check((await page.locator('#services .svc-line-name').allTextContents()).join() === 'Gone' && (await page.textContent('#services-count')) === '1 down', 'only down: just the one that is down');

  // off, with service alerts off too; VMs with numbers, without stopped ones
  await set({ homeServices: 'off', serviceAlerts: false, vms: { stopped: false, homeNumbers: true, uptime: false } });
  check(await page.locator('#services-sec').isHidden(), 'off: no services section on Home');
  check(!/Gone/.test(await page.textContent('#needs')) && !/services/.test(await page.textContent('#home-foot')), 'service alerts off: not under "Needs you", and services off: not in the line at the bottom');
  const numChips = await page.locator('#vms .chip').allTextContents();
  check(numChips.length === 2 && numChips.every((c) => /CPU .*RAM/.test(c) && !/up /.test(c)), `VMs: running only, with CPU and RAM, no uptime (${numChips.join(' | ')})`);
  await page.screenshot({ path: `${S}/home-options-off.png`, fullPage: true });

  // the host details: its guests in a table with the chosen columns
  await page.locator('#devices .dtile', { hasText: 'titan' }).click();
  await page.waitForSelector('dialog.drawer[open] .guest-table');
  const heads = await page.locator('dialog.drawer .guest-table th').allTextContents();
  check(heads.join() === 'Name,Type,Status,CPU,Memory,Disk' && await page.locator('dialog.drawer .guest-table tbody tr').count() === 2, `host details: guests with CPU, memory and disk (${heads})`);
  // a guest's row opens its disks and graphs
  await page.locator('dialog.drawer .guest-table tr.guest-row', { hasText: 'docker' }).click();
  check(await page.locator('dialog.drawer .guest-table tr.guest-row[aria-expanded="true"]').count() === 1 && /95 %/.test(await page.textContent('dialog.drawer .guest-more')), 'a guest opens its disk use');
  await page.screenshot({ path: `${S}/home-options-drawer.png` });
  await page.keyboard.press('Escape');

  // the rack: a count on the server
  await page.goto(B + '/#rack');
  await page.waitForSelector('.rack-label');
  check(/2 of 3 VMs running/.test(await page.textContent('.rack-label:has-text("titan")')), 'rack: a VM count beside the server');

  // everywhere off
  await set({ homeServices: 'off', vms: { stopped: false, homeNumbers: true, uptime: false, home: false, services: false, host: false, rack: false } });
  await page.goto(B + '/');
  await page.waitForSelector('#summary .pill');
  check(await page.locator('#vms-sec').isHidden(), 'VMs off on Home');
  await page.locator('#devices .dtile', { hasText: 'titan' }).click();
  await page.waitForSelector('dialog.drawer[open] .section-title');
  check(await page.locator('dialog.drawer .guest-table').count() === 0 && !/VMs running/.test(await page.textContent('dialog.drawer')), 'VMs off in the host details');
  await page.keyboard.press('Escape');
  const svc = (await call('GET', '/api/services')).json;
  check(!svc.groups.some((g) => g.key === '@vms') && svc.groups.flatMap((g) => g.services || []).find((s) => s.name === 'Quiet')?.onHome === false, 'VMs off on the Services tab; the services list still has every service');
  await page.goto(B + '/#rack');
  await page.waitForSelector('.rack-label');
  check(!/VMs running/.test(await page.textContent('.rack-label:has-text("titan")')), 'VMs off in the rack');
  await page.goto(B + '/wall');
  await page.waitForSelector('#wall-sub');
  await page.waitForTimeout(500);
  check(!/VMs running/.test(await page.textContent('#wall-sub')) && await page.locator('#svc').isHidden(), 'the wall follows: no VM count, no services');

  // Admin: the form shows and saves the choices
  await page.goto(B + '/admin#dashboard');
  await page.waitForSelector('#dash-form select[name=homeServices]');
  check(await page.inputValue('#dash-form select[name=homeServices]') === 'off' && !(await page.isChecked('#dash-form input[name="vms.home"]')) && await page.isChecked('#dash-form input[name="vms.homeNumbers"]'), 'Admin shows the saved choices');
  await page.selectOption('#dash-form select[name=homeServices]', 'compact');
  await page.check('#dash-form input[name="vms.home"]');
  await page.click('#dash-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('dash-msg').textContent === 'Saved');
  const after = (await call('GET', '/api/dashboard')).json;
  check(after.homeServices === 'compact' && after.vms.home === true && after.vms.services === false, 'Admin saves the choices');
  await page.screenshot({ path: `${S}/home-options-admin.png`, fullPage: true });
  await page.click('#tabbtn-services');
  await page.locator('.svc-row', { hasText: 'Quiet' }).locator('button:has-text("Edit")').click();
  check(!(await page.isChecked('#svc-form input[name=onHome]')), 'the service form shows "Show on Home" unticked for Quiet');

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL HOME OPTIONS UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
