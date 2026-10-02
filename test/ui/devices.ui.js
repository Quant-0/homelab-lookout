const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  await page.goto(B + '/admin');
  await page.waitForSelector('#tab-devices:not([hidden])');
  check(page.url().endsWith('#devices'), 'admin opens on the Devices tab');

  const conn = (i) => page.locator('#conn-list .conn-card').nth(i);
  const fill = async (card, label, value) => card.locator('label', { hasText: label }).locator('input').first().fill(value);

  // --- Add device: Orion with iDRAC + Proxmox ---
  await page.click('#device-new');
  await page.fill('#device-form input[name=name]', 'Orion');
  await page.fill('#device-form input[name=height]', '2');
  await page.selectOption('#conn-add', 'idrac');
  let c = conn(0);
  await fill(c, 'Address', '127.0.0.1:18443');
  await fill(c, 'Username', 'root');
  await fill(c, 'Password', 'calvin');
  await c.locator('button', { hasText: 'Fetch certificate' }).click();
  await c.locator('button', { hasText: 'Use this fingerprint' }).click();
  c = conn(0);
  await c.locator('button', { hasText: 'Test' }).click();
  await c.locator('.conn-result .msg').waitFor();
  const t1 = await c.locator('.conn-result').textContent();
  check(/Connected: PowerEdge R730xd/.test(t1), `iDRAC tested before saving (${t1})`);
  await page.selectOption('#conn-add', 'proxmox');
  c = conn(1);
  await fill(c, 'Address', '127.0.0.1:18443');
  await fill(c, 'API token ID', 'root@pam!dash');
  await fill(c, 'Token secret', '11111111-2222-3333-4444-555555555555');
  await c.locator('button', { hasText: 'Fetch certificate' }).click();
  await c.locator('button', { hasText: 'Use this fingerprint' }).click();
  c = conn(1);
  await c.locator('button', { hasText: 'Test' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#conn-list .conn-card')[1]?.querySelectorAll('select option').length >= 4);
  c = conn(1);
  const nodeSelect = c.locator('label', { hasText: 'Node' }).locator('select');
  check((await nodeSelect.locator('option').allTextContents()).join('|').includes('pve1|pve2'), 'Proxmox test fills the node list');
  await nodeSelect.selectOption('pve1');
  check(await conn(0).locator('input[type=password]').first().inputValue() === 'calvin', 'typed iDRAC password kept while editing other connections');
  await page.screenshot({ path: `${S}/ui5-editor.png`, fullPage: true });
  await page.click('#device-save');
  await page.waitForSelector('#device-editor[hidden]', { state: 'attached' });
  const row = page.locator('#device-list .device-row', { hasText: 'Orion' });
  check((await row.textContent()).includes('iDRAC + Proxmox'), `device list: ${await row.locator('.device-links').textContent()}`);

  // re-open: secrets are not shown, only "Stored"
  await row.click();
  const ph = await conn(0).locator('input[type=password]').first().getAttribute('placeholder');
  const val = await conn(0).locator('input[type=password]').first().inputValue();
  check(ph.startsWith('Stored') && val === '', 'saved secret is write-only in the editor');
  check(/Orion/.test(await page.textContent('#device-editor-title')), 'edit opens with the device');
  await page.click('#device-cancel');

  // --- UDM Pro with a UniFi connection; switch + AP appear by themselves ---
  await page.click('#device-new');
  await page.fill('#device-form input[name=name]', 'UDM Pro');
  await page.selectOption('#conn-add', 'unifi');
  check(await page.inputValue('#device-kind') === 'gateway', 'adding a UniFi connection sets the type to gateway');
  c = conn(0);
  await fill(c, 'Address', '127.0.0.1:18443');
  await fill(c, 'Local account', 'viewer');
  await fill(c, 'Password', 'unifipass');
  await c.locator('button', { hasText: 'Fetch certificate' }).click();
  await c.locator('button', { hasText: 'Use this fingerprint' }).click();
  await page.fill('#device-form input[name=u]', '24');
  await page.click('#device-save');
  await page.waitForTimeout(2500);
  await page.click('#tabbtn-power');
  await page.click('#tabbtn-devices');
  await page.waitForTimeout(800);
  const listText = await page.textContent('#device-list');
  check(/USW-24-POE Rack/.test(listText) && /U7 Pro Hallway/.test(listText), 'switch and AP appeared automatically');
  check(/Not placed \(1\)/.test(listText) && /Outside the rack \(1\)/.test(listText), 'switch is "not placed", AP is "outside the rack"');
  await page.screenshot({ path: `${S}/ui5-devices.png`, fullPage: true });

  // --- dashboard: one widget per device ---
  await page.goto(B + '/');
  await page.waitForSelector('.widget[data-id^="device:"]');
  await page.waitForTimeout(800);
  const widgets = await page.$$eval('.widget[data-id^="device:"]', (ws) => ws.map((w) => ({
    name: w.querySelector('h3')?.textContent,
    sections: [...w.querySelectorAll('.section-head h4')].map((h) => h.textContent),
  })));
  console.log('  widgets:', JSON.stringify(widgets));
  const odinW = widgets.find((w) => w.name === 'Orion');
  check(odinW && odinW.sections.includes('Hardware · iDRAC') && odinW.sections.includes('Proxmox · node pve1'), 'Orion: one widget with iDRAC and Proxmox sections');
  const odinText = await page.$$eval('.widget', (ws) => ws.find((x) => x.querySelector('h3')?.textContent === 'Orion').textContent);
  check(odinText.includes('pve1') && !odinText.includes('pve2') && /VMs & containers, \d+ running/.test(odinText) && !odinText.includes('truenas'), 'Orion shows its own node; VMs are summarised with a link to Services');
  const vmPage = await page.context().newPage();
  await vmPage.goto(B + '/services#vms');
  await vmPage.waitForSelector('#vms .vm-card');
  const vms = await vmPage.$$eval('#vms .vm-card strong', (n) => n.map((x) => x.textContent));
  check(vms.includes('truenas') && !vms.includes('tmpl'), `Services page lists the VMs and containers (${vms.join(', ')})`);
  await vmPage.screenshot({ path: `${S}/vms-services.png`, fullPage: true });
  await vmPage.close();
  const udmW = widgets.find((w) => w.name === 'UDM Pro');
  check(udmW && udmW.sections.includes('UniFi network') && udmW.sections.some((x) => /UniFi · UDMPRO/.test(x)), 'UDM Pro: network overview + its own gateway section');
  check(widgets.some((w) => w.name === 'USW-24-POE Rack'), 'switch gets its own widget');
  await page.click('.rack-item.kind-server');
  await page.waitForTimeout(700);
  const flashed = await page.evaluate(() => document.querySelector('.widget.flash h3')?.textContent);
  check(flashed === 'Orion', 'clicking Orion in the rack jumps to the Orion widget');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${S}/ui5-dashboard.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(B + '/admin#devices');
  await page.waitForSelector('#device-list .device-row');
  check((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'admin has no horizontal overflow on phone');
  console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nUI OK: no console/CSP errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
