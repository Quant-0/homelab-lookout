'use strict';
// Updates page: sections, versions, package list, release notes, Check now; the Overview's link.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const M = 'http://127.0.0.1:18090';
const FP = process.env.MOCK_FP;
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login?next=updates');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/updates');
  check(true, 'login returns to /updates');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const post = (p, body) => page.evaluate(async ([c, p, body]) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify(body) }).then((r) => r.json()), [csrf, p, body]);
  const c = (type, extra) => ({ type, address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, ...extra });
  await post('/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 10, height: 2, connections: [c('idrac', { username: 'root', secret: 'calvin' }), c('proxmox', { username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } })] });
  await post('/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [c('unifi', { username: 'viewer', secret: 'unifipass' })] });
  for (const [name, type] of [['Sonarr', 'sonarr'], ['Radarr', 'radarr'], ['Home Assistant', 'homeassistant']]) {
    await post('/api/admin/services', { name, group: 'Apps', href: `https://${type}.example.lan`, connection: { url: `${M}/${type}` }, integration: { type, options: {} }, secret: 'svc-key-123' });
  }
  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForSelector('#upd-summary');
  check(await page.locator('.sidebar .nav-item', { hasText: 'Updates' }).getAttribute('aria-current') === 'page', 'Updates is in the sidebar, marked as the current page');
  await page.click('#upd-check');
  await page.waitForSelector('#upd-msg.ok');
  const sections = await page.$$eval('.upd-section h3', (h) => h.map((x) => x.textContent));
  check(/Can be updated \(\d+\)/.test(sections[0]) && sections.some((s) => /Up to date/.test(s)), `sections: ${sections.join(' | ')}`);
  const first = await page.$$eval('.upd-section:first-child .upd-row', (rows) => rows.map((r) => r.textContent));
  check(first.some((t) => /titan.*Proxmox node pve1.*Proxmox VE 8\.2\.4 → Proxmox VE 8\.2\.7.*3 packages/.test(t)) && first.some((t) => /Sonarr.*4\.0\.10\.2544 → 4\.0\.11\.2680/.test(t)) && first.some((t) => /UniFi firmware.*4\.1\.13 → 4\.1\.22/.test(t)), 'Proxmox, Sonarr and UniFi with current → new versions');
  await page.locator('.upd-row', { hasText: 'Proxmox node pve1' }).locator('summary').click();
  check(await page.locator('.upd-row', { hasText: 'Proxmox node pve1' }).locator('tbody tr').count() === 3, 'the package list opens');
  const notes = page.locator('.upd-row', { hasText: 'Sonarr' }).locator('a.upd-notes');
  check(await notes.getAttribute('rel') === 'noopener noreferrer' && /github\.com\/Sonarr/.test(await notes.getAttribute('href')), 'release notes open safely in a new tab');
  check(/can be updated · checked .* · next check (tonight|tomorrow) at 04:00/.test(await page.textContent('#upd-summary')), `summary: ${await page.textContent('#upd-summary')}`);
  await page.screenshot({ path: `${S}/updates.png`, fullPage: true });
  check(await page.isDisabled('#upd-check') && /in a minute/.test(await page.getAttribute('#upd-check', 'title')), 'Check now rests for a minute after a check');

  // Overview
  await page.goto(B + '/');
  await page.waitForSelector('.device-card');
  const link = page.locator('#attention .attn-updates');
  check(/\d+ updates?$/.test(await link.textContent()) && await link.getAttribute('href') === '/updates', `attention links to the updates (${await link.textContent()})`);
  check(await page.locator('.device-card', { hasText: 'titan' }).locator('a.dc-update').count() === 1, 'titan\'s card says "Update available" and links there');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(B + '/updates');
  await page.waitForSelector('.upd-row');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling on a phone');
  await page.screenshot({ path: `${S}/updates-phone.png`, fullPage: true });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL UPDATES UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
