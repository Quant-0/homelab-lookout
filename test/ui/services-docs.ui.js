const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const M = 'http://127.0.0.1:18090';
const FP = process.env.MOCK_FP;
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
  const { csrf } = await (await page.request.get(B + '/api/session')).json();
  const H = { 'X-CSRF-Token': csrf };
  const post = (p, data) => page.request.post(B + p, { headers: H, data });
  await post('/api/admin/devices', { name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  await post('/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', tlsMode: 'pin', fingerprint: FP, secret: 'unifipass' }] });
  const ph = await (await post('/api/admin/icons/library', { name: 'pi-hole' })).json();
  await post('/api/admin/services', { name: 'Pi-hole', group: 'Network', description: 'DNS filter', href: 'https://pihole.example.lan', connection: { url: `${M}/pihole` }, integration: { type: 'pihole', options: {} }, secret: 'svc-key-123', icon: { kind: 'file', id: ph.icon.id } });
  await post('/api/admin/services', { name: 'Home Assistant', group: 'Home', href: 'https://ha.example.lan', connection: { url: `${M}/homeassistant` }, integration: { type: 'homeassistant', options: {} }, secret: 'svc-key-123' });
  await post('/api/admin/services', { name: 'Wiki', group: 'Home', href: 'https://wiki.example.lan', description: 'Plain link' });
  await page.waitForTimeout(2000);

  // --- dashboard tabs ---
  await page.reload();
  await page.waitForSelector('.sidebar .nav-list a');
  check((await page.$$eval('.sidebar .nav-list .label', (a) => a.map((x) => x.textContent))).join() === 'Home,Rack,Services,Energy,Docs,Updates', 'the top bar shows Home · Rack · Services · Energy · Docs · Updates');

  // --- admin: add Jellyfin through the form ---
  await page.goto(B + '/admin#services');
  await page.waitForSelector('#svc-list .svc-row');
  await page.click('#svc-new');
  await page.selectOption('#svc-integration', 'jellyfin');
  await page.waitForFunction(() => document.querySelector('#svc-icon-preview img'));
  check(await page.inputValue('#svc-form input[name=name]') === 'Jellyfin' && await page.inputValue('#svc-form input[name=group]') === 'Media', 'choosing Jellyfin fills in name, group and icon');
  const jellyIcon = await page.getAttribute('#svc-icon-preview img', 'src');
  await page.selectOption('#svc-integration', 'emby');
  await page.waitForFunction((src) => document.querySelector('#svc-icon-preview img')?.getAttribute('src') !== src, jellyIcon);
  check(await page.inputValue('#svc-form input[name=name]') === 'Emby', 'changing the integration changes the logo and name too');
  await page.selectOption('#svc-integration', 'jellyfin');
  await page.waitForFunction((src) => document.querySelector('#svc-icon-preview img')?.getAttribute('src') === src, jellyIcon);
  check(await page.inputValue('#svc-form input[name=name]') === 'Jellyfin', '...and back again');
  await page.fill('#svc-form input[name=url]', `${M}/jellyfin`);
  await page.fill('#svc-form input[name=href]', 'https://jellyfin.example.lan');
  await page.fill('#svc-int-fields input[type=password]', 'svc-key-123');
  check(await page.isVisible('#svc-http-warning'), 'warning shown: key over plain http');
  await page.click('#svc-test');
  await page.waitForFunction(() => /Movies/.test(document.getElementById('svc-test-result').textContent));
  const tr = await page.textContent('#svc-test-result');
  check(/Up/.test(tr) && /Movies: 812/.test(tr), `Test before saving: ${tr.trim()}`);
  const picked = await page.$$eval('#svc-numbers input[type=checkbox]', (n) => n.map((x) => [x.parentElement.textContent.trim(), x.checked]));
  check(picked.length === 4 && picked.filter(([, c]) => c).map(([l]) => l).join() === 'Movies,Series,Streaming', `after Test you can pick the numbers (defaults ticked: ${picked.filter(([, c]) => c).map(([l]) => l)})`);
  // icon search shows thumbnails served by this server
  await page.fill('#icon-search', 'sonarr');
  await page.waitForSelector('#icon-results .icon-choice img');
  await page.waitForFunction(() => [...document.querySelectorAll('#icon-results img')].some((i) => i.complete && i.naturalWidth > 0));
  check(true, 'icon search shows thumbnails');
  await page.screenshot({ path: `${S}/ui6-admin-service.png`, fullPage: true });
  await page.fill('#icon-search', '');
  await page.click('#svc-save');
  await page.waitForSelector('#svc-editor[hidden]', { state: 'attached' });
  check((await page.textContent('#svc-list')).includes('Jellyfin'), 'Jellyfin saved');

  // --- a UniFi card on the numbers of the UDM Pro already added: no second password ---
  await page.click('#svc-new');
  await page.selectOption('#svc-integration', 'unifi');
  await page.waitForSelector('#svc-int-fields select[name=source]');
  check(/UDM Pro/.test(await page.$eval('#svc-int-fields select[name=source]', (x) => x.selectedOptions[0].textContent)) && await page.locator('#svc-int-fields input[type=password]').count() === 0 && /optional/.test(await page.textContent('#svc-url-label')), 'UniFi: numbers from the UDM Pro by default, no password field, the URL optional');
  await page.click('#svc-test');
  await page.waitForFunction(() => /Clients/.test(document.getElementById('svc-test-result').textContent));
  check(/WAN: Up/.test(await page.textContent('#svc-test-result')), `Test shows the device's numbers: ${(await page.textContent('#svc-test-result')).trim()}`);
  await page.selectOption('#svc-int-fields select[name=source]', '');
  check(await page.locator('#svc-int-fields input[type=password]').count() === 1 && (await page.textContent('#svc-url-label')) === 'Connection URL', 'its own login: user name, password and URL');
  await page.selectOption('#svc-int-fields select[name=source]', { index: 0 });
  await page.screenshot({ path: `${S}/ui6-admin-service-from-device.png`, fullPage: true });
  await page.click('#svc-save');
  await page.waitForSelector('#svc-editor[hidden]', { state: 'attached' });
  check((await page.textContent('#svc-list')).includes('UniFi Network'), 'UniFi card saved');
  await page.evaluate(async (c) => {
    const { services } = await (await fetch('/api/admin/services')).json();
    const id = services.find((x) => x.name === 'UniFi Network').id;
    await fetch(`/api/admin/services/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': c } });
  }, csrf);

  // --- services page ---
  await page.waitForTimeout(1500);
  await page.goto(B + '/services');
  await page.waitForSelector('.svc-card');
  const cards = await page.$$eval('.svc-card', (cs) => cs.map((c) => ({
    name: c.querySelector('strong').textContent, href: c.getAttribute('href'), rel: c.getAttribute('rel'),
    img: Boolean(c.querySelector('img.svc-icon')), stats: c.querySelectorAll('.svc-stat').length, up: Boolean(c.querySelector('.led.good')),
  })));
  console.log('  cards:', JSON.stringify(cards));
  const jf = cards.find((c) => c.name === 'Jellyfin');
  check(jf && jf.img && jf.stats === 3 && jf.up, 'Jellyfin card: icon, its 3 default numbers, up');
  const rows = await page.$$eval('.svc-stats', (list) => list.map((r) => {
    const tiles = [...r.children];
    const card = r.closest('.svc-card').getBoundingClientRect();
    return { name: r.closest('.svc-card').querySelector('strong').textContent, inside: tiles.every((t) => t.getBoundingClientRect().right <= card.right - 8 && t.querySelector('.v').scrollWidth <= t.querySelector('.v').clientWidth + 1) };
  }));
  check(rows.length && rows.every((r) => r.inside), `numbers stay inside their cards (${rows.length} cards${rows.filter((r) => !r.inside).map((r) => `; ${r.name} overflows`).join('')})`);
  check(cards.every((c) => !c.href || c.rel === 'noopener noreferrer'), 'links open with noopener noreferrer');
  check((await page.$$eval('.svc-group h2', (h) => h.map((x) => x.textContent))).length === 3, 'grouped (Network, Home, Media)');
  await page.screenshot({ path: `${S}/ui6-services.png` });

  // --- docs ---
  await page.goto(B + '/docs');
  await page.waitForSelector('#docs-nav a');
  await page.click('#docs-nav a:has-text("Orion")');
  await page.waitForSelector('table.facts');
  const facts = await page.textContent('table.facts');
  check(/PowerEdge R730xd/.test(facts) && /ABC1234/.test(facts) && /port 7/.test(facts), 'server sheet: model, service tag and switch port (from UniFi)');
  await page.click('button:has-text("Edit notes")');
  await page.fill('input[placeholder="e.g. Proxmox host"]', 'Proxmox host');
  await page.fill('textarea.md-input', '## Setup\n\n- [x] BIOS updated\n- [ ] iDRAC licence\n\n<script>window.__pwned = 1</script> <img src=x onerror="window.__pwned=2">\n\n[bad](javascript:alert(1)) and [good](https://example.com)\n\n| Disk | Size |\n|---|---|\n| sda | 1 TB |');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('.md');
  const md = await page.evaluate(() => {
    const m = document.querySelector('.docs-content .md');
    return {
      h: m.querySelector('h3')?.textContent, tasks: m.querySelectorAll('input[type=checkbox]').length, table: Boolean(m.querySelector('table')),
      scripts: m.querySelectorAll('script, img').length, pwned: window.__pwned || 0,
      links: [...m.querySelectorAll('a')].map((a) => a.getAttribute('href')), text: m.textContent.includes('<script>'),
    };
  });
  check(md.h === 'Setup' && md.tasks === 2 && md.table, 'Markdown: heading, task list and table rendered');
  check(md.scripts === 0 && md.pwned === 0 && md.text, 'HTML in notes is shown as text, never executed');
  check(md.links.length === 1 && md.links[0] === 'https://example.com/', `only safe links become links (${md.links})`);
  await page.screenshot({ path: `${S}/ui6-docs-server.png`, fullPage: true });

  await page.click('#docs-nav a:has-text("Network plan")');
  await page.click('.docs-toolbar button:has-text("Edit")');
  await page.click('button:has-text("Import networks from UniFi")');
  await page.click('button:has-text("Import fixed IPs from UniFi")');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('.docs-toolbar button:has-text("Edit")');
  const plan = await page.textContent('.docs-content');
  check(/192\.168\.1\.0\/24/.test(plan) && /Mgmt/.test(plan) && /192\.168\.1\.80/.test(plan), 'network plan imported from UniFi (networks + fixed IPs)');
  check(!/PPPOE|IPSEC/.test(plan), 'no secrets from UniFi network settings');
  await page.click('#docs-nav a:has-text("Switch ports")');
  await page.waitForSelector('.docs-content h2:has-text("Switch ports")');
  await page.waitForSelector('.docs-content table');
  const ports = await page.textContent('.docs-content');
  check(/U7 Pro Hallway/.test(ports) && /Printer/.test(ports) && !/\[object /.test(ports), 'switch ports: AP and wired clients on their ports');
  await page.click('#docs-nav a:has-text("Topology")');
  await page.waitForSelector('.topology svg');
  const topo = await page.$$eval('.topo-node .topo-label', (t) => t.map((x) => x.textContent));
  check(topo.includes('Internet') && topo.includes('UDM Pro') && topo.includes('USW-24-POE Rack') && topo.includes('U7 Pro Hallway') && topo.includes('Orion'), `topology: ${topo.join(' → ')}`);
  await page.screenshot({ path: `${S}/ui6-topology.png` });
  await page.click('.topo-node.own');
  await page.waitForTimeout(300);
  check(page.url().includes('#server/'), 'clicking Orion in the diagram opens its sheet');

  await page.click('#docs-nav a:has-text("New page")');
  await page.fill('input[placeholder="e.g. Restore from backup"]', 'Update Proxmox');
  await page.fill('.md-editor textarea', '1. Migrate VMs\n2. Run `apt full-upgrade`\n\n```\nreboot\n```');
  check(await page.$eval('.md-preview', (p) => Boolean(p.querySelector('ol') && p.querySelector('pre'))), 'live preview while writing');
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => location.hash.startsWith('#page/'));
  check(/Pages\s*1/.test(await page.textContent('#docs-nav .nav-group[data-id="pages"] .nav-group-toggle')) && (await page.textContent('#docs-nav .nav-group[data-id="pages"]')).includes('Update Proxmox'), 'page saved in the Pages group');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['/services', '/docs']) {
    await page.goto(B + p);
    await page.waitForTimeout(600);
    check((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `${p}: no horizontal overflow on phone`);
  }
  console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nUI OK: no console/CSP errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
