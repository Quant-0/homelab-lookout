// Screenshots of the example lab for the user guide
const { chromium, devices } = require('playwright');
const http = require('node:http');
const OUT = process.argv[2];
const SVG = process.argv[3];
const B = 'http://127.0.0.1:18080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = [];

// a Docker host behind a read-only socket proxy, for the Containers view
const C = [
  { id: 'a1', name: 'jellyfin', image: 'jellyfin/jellyfin', state: 'running', status: 'Up 6 days (healthy)', health: 'healthy', policy: 'unless-stopped', mem: 820e6 },
  { id: 'b2', name: 'immich-server', image: 'ghcr.io/immich-app/immich-server', state: 'running', status: 'Up 6 days', policy: 'always', mem: 1.4e9 },
  { id: 'c3', name: 'postgres', image: 'postgres:16', state: 'running', status: 'Up 6 days (healthy)', health: 'healthy', policy: 'always', mem: 310e6 },
  { id: 'd4', name: 'paperless', image: 'paperless-ngx/paperless-ngx', state: 'running', status: 'Up 2 days', policy: 'unless-stopped', mem: 540e6 },
  { id: 'e5', name: 'watchtower', image: 'containrrr/watchtower', state: 'exited', status: 'Exited (0) 3 days ago', exitCode: 0, policy: 'no', mem: 0 },
  { id: 'f6', name: 'uptime-test', image: 'louislam/uptime-kuma', state: 'restarting', status: 'Restarting (1) 4 seconds ago', restarts: 14, policy: 'always', mem: 0 },
];
let cpuT = 0;
let sysT = 0;
http.createServer((q, res) => {
  const json = (code, o) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
  if (q.url === '/version') return json(200, { Version: '27.3.1' });
  if (q.url === '/containers/json?all=1') return json(200, C.map((c) => ({ Id: c.id.padEnd(64, '0'), Names: [`/${c.name}`], Image: c.image, State: c.state, Status: c.status, Created: 1790000000, Labels: { 'com.docker.compose.project': 'apps' } })));
  const m = /^\/containers\/([0-9a-z]+)\/(json|stats\?stream=false&one-shot=true)$/.exec(q.url);
  const c = m && C.find((x) => x.id.padEnd(64, '0') === m[1]);
  if (!c) return json(404, {});
  if (m[2] === 'json') return json(200, { State: { Status: c.state, ExitCode: c.exitCode ?? 0, StartedAt: new Date(Date.now() - 6 * 864e5).toISOString(), ...(c.health ? { Health: { Status: c.health } } : {}) }, RestartCount: c.restarts ?? 0, HostConfig: { RestartPolicy: { Name: c.policy } }, Config: { Env: [] } });
  cpuT += 3e8; sysT += 4e9;
  return json(200, { cpu_stats: { cpu_usage: { total_usage: cpuT * (1 + C.indexOf(c)) }, system_cpu_usage: sysT, online_cpus: 4 }, memory_stats: { usage: c.mem, limit: 8e9, stats: { inactive_file: 0 } } });
}).listen(18471, '127.0.0.1');

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const shot = async (name, fn) => {
    try {
      await fn();
      done.push(name);
    } catch (e) {
      console.log('FAILED', name, e.message.split('\n')[0]);
    }
  };
  const full = (name, opts = {}) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, ...opts });
  const el = async (name, sel) => (await p.$(sel)).screenshot({ path: `${OUT}/${name}.png` });
  const top = (name, h = 860) => p.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: 1280, height: h } });

  // sign-in page first, then sign in
  await p.goto(B + '/login'); await sleep(800);
  await shot('signin', () => top('signin', 700));
  await p.fill('#username', 'admin'); await p.fill('#password', 'correct horse battery'); await p.click('button[type=submit]'); await p.waitForURL(B + '/');

  // set the scene: logo, provider logo, faster refresh, patch panel and cables
  await p.evaluate(async (svg) => {
    const { csrf } = await (await fetch('/api/session')).json();
    const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
    const up = await (await fetch('/api/admin/logo', { method: 'POST', headers: { 'Content-Type': 'image/svg+xml', 'X-CSRF-Token': csrf }, body: svg })).json();
    const cfg = await (await fetch('/api/admin/config')).json();
    await fetch('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({
      appearance: { ...cfg.settings.appearance, logo: { kind: 'icon', name: 'server', color: 'teal' } },
      dashboard: { ...cfg.settings.dashboard, refreshSeconds: 10, carrierLogo: { kind: 'file', id: up.icon.id } },
    }) });
    await fetch('/api/admin/rack/passive', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'patch', u: 11, height: 1, ports: 24 }) });
    const d = await (await fetch('/api/dashboard')).json();
    const id = (n) => d.devices.find((x) => x.name === n).id;
    const pp = d.rack.passive.find((x) => x.kind === 'patch').id;
    await fetch('/api/admin/cables', { method: 'PUT', headers: H, body: JSON.stringify({ cables: [
      { a: { item: id('edge'), port: 'rj1' }, b: { item: id('core-switch'), port: 'rj1' }, color: 'blue', label: 'Uplink' },
      { a: { item: id('core-switch'), port: 'rj3' }, b: { item: pp, port: 'pp3' }, color: 'yellow', label: 'Office' },
      { a: { item: id('core-switch'), port: 'rj5' }, b: { item: pp, port: 'pp5' }, color: 'yellow', label: 'Living room' },
      { a: { item: id('core-switch'), port: 'rj7' }, b: { item: pp, port: 'pp9' }, color: 'green', label: 'Hallway AP' },
      { a: { item: id('edge'), port: 'sfp10' }, b: { item: id('core-switch'), port: 'sfp25' }, color: 'red', label: '10G' },
    ] }) });
    // check-ins, a weekly maintenance window, the status page, a push channel and a webhook
    await fetch('/api/admin/checkins', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Nightly NAS backup', everyMin: 1440, graceMin: 120, deviceId: id('vault') }) });
    const ck2 = await (await fetch('/api/admin/checkins', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Certificate renewal', everyMin: 10080, graceMin: 1440 }) })).json();
    await fetch(ck2.checkin.path);
    await fetch('/api/admin/maintenance', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Proxmox updates', targets: { all: false, devices: [id('atlas')], services: [], checkins: [] }, schedule: { kind: 'weekly', days: [0], start: '03:00', minutes: 90 } }) });
    const cfg2 = await (await fetch('/api/admin/config')).json();
    await fetch('/api/admin/settings', { method: 'PUT', headers: H, body: JSON.stringify({ dashboard: { ...cfg2.settings.dashboard, statusPage: { enabled: true, title: 'Lab status' }, linkUrl: 'https://lookout.home.arpa:8443' } }) });
    await fetch('/api/admin/alerts/channels', { method: 'POST', headers: H, body: JSON.stringify({ type: 'push', name: 'Phones' }) });
    await fetch('/api/admin/alerts/channels', { method: 'POST', headers: H, body: JSON.stringify({ type: 'ntfy', name: 'ntfy', url: 'https://ntfy.sh', topic: 'homelab-x7k2p9q4m3', auth: 'none' }) });
    // a Docker host, and a device reached through the switch
    await fetch('/api/admin/devices', { method: 'POST', headers: H, body: JSON.stringify({ name: 'apps', kind: 'server', location: 'none', connections: [{ type: 'docker', address: '127.0.0.1:18471' }], parent: id('core-switch') }) });
  }, SVG);
  // a new public IP, so Home shows the notice
  await fetch('https://127.0.0.1:18443/__wan?ip=203.0.113.99').catch(() => {});
  await sleep(14000);

  await p.goto(B + '/'); await p.reload(); await sleep(3500);
  await shot('home', () => full('home'));
  await shot('home-top', () => top('home-top', 760));
  await shot('snooze', async () => {
    await p.click('.need-wrap:has(.need.critical) .snooze'); await sleep(300);
    await p.screenshot({ path: `${OUT}/snooze.png`, clip: { x: 0, y: 120, width: 1280, height: 330 } });
    await p.keyboard.press('Escape');
  });
  await shot('net-card', () => el('net-card', '.big.net'));
  await shot('power-drawer', async () => {
    await p.click('.power-tile'); await sleep(1800);
    await top('power-drawer');
    await p.keyboard.press('Escape'); await sleep(500);
  });
  await shot('device-drawer', async () => {
    await p.click('#devices .dtile:has-text("atlas")'); await sleep(1800);
    await top('device-drawer');
    await p.keyboard.press('Escape'); await sleep(500);
  });
  await shot('search', async () => {
    await p.keyboard.press('Control+k'); await sleep(400);
    await p.keyboard.type('vault'); await sleep(700);
    await top('search', 600);
    await p.keyboard.press('Escape'); await sleep(300);
  });
  await shot('look', async () => {
    await p.click('.avatar-button'); await p.click('.user-menu [data-act="look"]'); await sleep(500);
    await top('look', 700);
    await p.keyboard.press('Escape'); await sleep(300);
  });
  await shot('customize-home', async () => {
    await p.click('#customize'); await sleep(800);
    await top('customize-home', 760);
    const cancel = p.locator('button:has-text("Cancel")');
    if (await cancel.count()) await cancel.first().click(); else await p.reload();
    await sleep(800);
  });

  // rack with cables and the side panel, then patch mode
  await p.goto(B + '/#rack'); await p.reload(); await sleep(3000);
  await shot('rack', async () => {
    const t = p.locator('button.cable-toggle:has-text("Cables")');
    if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
    await sleep(800);
    await top('rack');
  });
  await shot('rack-cables', async () => {
    const fig = await p.$('.rack-figure'); const bb = await fig.boundingBox();
    await p.screenshot({ path: `${OUT}/rack-cables.png`, clip: { x: bb.x, y: bb.y, width: bb.width, height: bb.height * 0.36 } });
  });
  await shot('patch', async () => {
    await p.click('button:has-text("Patch")'); await sleep(600);
    await p.locator('.cable-layer .cable >> nth=1').dispatchEvent('click'); await sleep(600);
    const card = await p.$('.rack-card'); const bb = await card.boundingBox();
    await p.screenshot({ path: `${OUT}/patch.png`, clip: { x: bb.x, y: bb.y, width: bb.width, height: 520 } });
    await p.click('button:has-text("Done")'); await sleep(400);
  });

  for (const [name, url, wait] of [['services', '/services', 2500], ['energy', '/energy', 2500], ['updates', '/updates', 2500], ['log', '/log', 2000]]) {
    await p.goto(B + url); await sleep(wait);
    await shot(name, () => full(name));
  }
  await p.goto(B + '/docs'); await sleep(1500);
  await shot('docs', async () => {
    await p.click('text=atlas'); await sleep(1500);
    await full('docs');
  });

  // incidents: acknowledge the PSU problem first, so the list shows who did
  await p.evaluate(async () => {
    const { csrf } = await (await fetch('/api/session')).json();
    const x = (await (await fetch('/api/admin/incidents')).json()).incidents.find((i) => i.open && /PS2/.test(i.title));
    if (x) await fetch(`/api/admin/incidents/${x.id}/ack`, { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
  });
  await p.goto(B + '/report'); await sleep(2500);
  await shot('report', () => full('report'));
  await p.goto(B + '/log#incidents'); await sleep(2000);
  await shot('incidents', () => top('incidents', 620));
  await p.goto(B + '/log#history'); await p.reload(); await sleep(2000); // only the hash changed: load it again
  await shot('config-history', () => top('config-history', 700));

  // VMs and containers
  await p.goto(B + '/vms'); await sleep(2500);
  await shot('vms', () => top('vms'));
  await shot('vm-drawer', async () => {
    await p.click('.vm-row >> nth=0').catch(() => p.click('tbody tr >> nth=0')); await sleep(1800);
    await top('vm-drawer');
    await p.keyboard.press('Escape'); await sleep(400);
  });
  await shot('containers', async () => {
    await p.click('#vm-view button:has-text("Containers")'); await sleep(1500);
    await top('containers', 700);
  });

  // the public status page
  const anon = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const sp = await anon.newPage();
  await sp.goto(B + '/status'); await sleep(2000);
  await shot('status', () => sp.screenshot({ path: `${OUT}/status.png`, clip: { x: 0, y: 0, width: 1280, height: 760 } }));

  // admin tabs
  for (const tab of ['devices', 'services', 'alerts', 'schedules', 'dashboard', 'look', 'power', 'backups', 'security', 'system']) {
    await p.goto(`${B}/admin#${tab}`); await p.reload(); await sleep(2000);
    await shot(`admin-${tab}`, () => top(`admin-${tab}`));
  }
  await p.goto(`${B}/admin#devices`); await p.reload(); await sleep(1800);
  await shot('catalog', async () => {
    await p.click('#device-new'); await sleep(900);
    await p.click('dialog[open] button:has-text("UniFi")').catch(() => {}); await sleep(600);
    await top('catalog');
    await p.keyboard.press('Escape'); await sleep(400);
  });
  await shot('device-edit', async () => {
    await p.click('.device-row:has-text("atlas")'); await sleep(1200);
    const ed = await p.$('#device-editor'); await ed.scrollIntoViewIfNeeded(); await sleep(300);
    await ed.screenshot({ path: `${OUT}/device-edit.png` });
  });
  await p.goto(`${B}/admin#services`); await p.reload(); await sleep(1800);
  await shot('service-edit', async () => {
    await p.click('.svc-row:has-text("Jellyfin") button:has-text("Edit")'); await sleep(1200);
    const ed = await p.$('#svc-editor'); await ed.scrollIntoViewIfNeeded(); await sleep(300);
    await ed.screenshot({ path: `${OUT}/service-edit.png` });
  });
  await p.goto(`${B}/admin#look`); await p.reload(); await sleep(1800);
  await shot('appearance', () => el('appearance', '#appearance-card'));
  await shot('device-alerts', async () => {
    await p.goto(`${B}/admin#devices`); await p.reload(); await sleep(1500);
    await p.click('.device-row:has-text("vault")'); await sleep(1000);
    await p.fill('input[name=alertPct]', '85');
    await (await p.$('.dev-alerts')).screenshot({ path: `${OUT}/device-alerts.png` });
    await p.click('#device-cancel');
  });
  await shot('push-editor', async () => {
    await p.goto(`${B}/admin#alerts`); await p.reload(); await sleep(1800);
    await p.click('#al-channels .svc-row:has-text("Phones") button:has-text("Edit")'); await sleep(800);
    await (await p.$('#al-editor')).screenshot({ path: `${OUT}/push-editor.png` });
  });

  // light theme
  const light = await b.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const q = await light.newPage();
  await q.goto(B + '/login'); await q.fill('#username', 'admin'); await q.fill('#password', 'correct horse battery'); await q.click('button[type=submit]'); await q.waitForURL(B + '/');
  await sleep(3000);
  await shot('home-light', () => q.screenshot({ path: `${OUT}/home-light.png`, clip: { x: 0, y: 0, width: 1280, height: 760 } }));

  // wall
  const wall = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const w = await wall.newPage();
  await w.goto(B + '/login'); await w.fill('#username', 'admin'); await w.fill('#password', 'correct horse battery'); await w.click('button[type=submit]'); await w.waitForURL(B + '/');
  await w.goto(B + '/wall'); await sleep(6000);
  await shot('wall', () => w.screenshot({ path: `${OUT}/wall.png` }));
  await shot('wall-customize', async () => {
    await w.mouse.move(1700, 60); await sleep(300);
    await w.click('#wall-customize'); await sleep(900);
    await w.screenshot({ path: `${OUT}/wall-customize.png` });
  });

  // phone
  const phone = await b.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
  const m = await phone.newPage();
  await m.goto(B + '/login'); await m.fill('#username', 'admin'); await m.fill('#password', 'correct horse battery'); await m.click('button[type=submit]'); await m.waitForURL(B + '/');
  await sleep(3000);
  await shot('phone-home', () => m.screenshot({ path: `${OUT}/phone-home.png` }));
  await shot('phone-more', async () => {
    await m.click('.tabbar button:has-text("More")'); await sleep(700);
    await m.screenshot({ path: `${OUT}/phone-more.png` });
    await m.keyboard.press('Escape');
  });
  await m.goto(B + '/services'); await sleep(2500);
  await shot('phone-services', () => m.screenshot({ path: `${OUT}/phone-services.png` }));

  console.log('done:', done.length, done.join(' '));
  console.log('errors:', errs.join(' | ') || 'none');
  await b.close();
  process.exit(0); // the Docker mock would keep it running
})();
