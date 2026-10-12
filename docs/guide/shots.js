// Screenshots of the example lab for the user guide
const { chromium, devices } = require('playwright');
const OUT = process.argv[2];
const SVG = process.argv[3];
const B = 'http://127.0.0.1:18080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = [];

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
    await p.click('.look-button'); await sleep(500);
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

  // admin tabs
  for (const tab of ['devices', 'services', 'alerts', 'power', 'dashboard', 'system']) {
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
  await p.goto(`${B}/admin#dashboard`); await p.reload(); await sleep(1800);
  await shot('appearance', () => el('appearance', '#appearance-card'));

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
})();
