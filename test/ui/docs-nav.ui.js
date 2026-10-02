'use strict';
// Docs menu: old page folders become groups, collapse (remembered), edit mode with drag and keys.
// The runner seeds the data directory with seed() below before the server starts.
const fs = require('node:fs');
const path = require('node:path');

const ORION = '11111111-1111-4111-8111-111111111111';
const LYNX = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const P2 = '44444444-4444-4444-8444-444444444444';
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ devices: [
    { id: ORION, name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2 },
    { id: LYNX, name: 'Lynx', kind: 'server', location: 'none', u: null, height: 1 },
  ] }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'docs.json'), JSON.stringify({ servers: {}, network: { networks: [], reservations: [], notes: '' }, pages: [
    { id: P1, title: 'Restore from backup', folder: 'Procedures', body: 'x', updatedAt: 1 },
    { id: P2, title: 'Shopping list', body: 'y', updatedAt: 1 },
  ] }), { mode: 0o600 });
}
module.exports = { seed };

async function run() {
  const { chromium } = require('playwright');
  const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
  const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
  const problems = [];
  const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Hardware'));
  await page.goto(B + '/login?next=docs');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForSelector('#docs-nav .nav-group');
  const groupNamed = async (name) => page.locator('.nav-group.editing').nth(await page.$$eval('.nav-group.editing', (gs, n) => gs.findIndex((g) => (g.querySelector('.group-name')?.value || g.querySelector('strong')?.textContent) === n), name));
  const menu = () => page.$$eval('#docs-nav .nav-group', (gs) => gs.map((g) => `${g.querySelector('.nav-group-name, .group-name, strong')?.value || g.querySelector('.nav-group-name, strong')?.textContent}:${[...g.querySelectorAll('.nav-group-items a span:first-child, .nav-edit-item[data-item] span:last-child')].map((x) => x.textContent).join('+')}`).join(' | '));
  check(await menu() === 'Servers & devices:Orion+Lynx | Network:Network plan+Switch ports+Topology | Procedures:Restore from backup | Pages:Shopping list', `old folders became groups: ${await menu()}`);

  // collapse, remembered after a reload; a group with the open page stays open
  await page.click('#docs-nav .nav-group[data-id="network"] .nav-group-toggle');
  check(await page.getAttribute('#docs-nav .nav-group[data-id="network"] .nav-group-toggle', 'aria-expanded') === 'false' && await page.isHidden('#nav-network'), 'Network collapsed');
  await page.reload();
  await page.waitForSelector('#docs-nav .nav-group');
  check(await page.isHidden('#nav-network'), 'still collapsed after reload');
  await page.goto(B + '/docs#ports');
  await page.waitForSelector('.docs-content h2');
  check(await page.isVisible('#nav-network'), 'opening one of its pages expands it');

  // edit: new group, drag Lynx into it, move Shopping list with the keyboard, move a group, rename
  await page.click('#nav-edit');
  await page.waitForSelector('.nav-group.editing');
  await page.click('#docs-nav button:has-text("New group")');
  const item = (t) => page.locator('.nav-edit-item', { hasText: t });
  const from = await item('Lynx').boundingBox();
  const target = await (await groupNamed('Hardware')).boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + 20, from.y + from.height / 2 + ((target.y + target.height / 2 - from.y - from.height / 2) * i) / 10);
  await page.mouse.up();
  check((await menu()).endsWith('Hardware:Lynx'), `Lynx dragged into the new group: ${await menu()}`);
  await item('Shopping list').focus();
  await page.keyboard.press('ArrowUp');
  check((await menu()).includes('Procedures:Restore from backup+Shopping list'), `arrow up past the top moves into the group above: ${await menu()}`);
  await page.locator('.nav-group.editing[data-id="network"] .group-grip').focus();
  await page.keyboard.press('ArrowUp');
  check((await menu()).startsWith('Network:'), 'Network moved to the top with the keyboard');
  await page.locator('.nav-group.editing[data-id="devices"] .group-name').fill('Servers');
  await page.screenshot({ path: `${S}/docs-nav-edit.png`, fullPage: true });
  await page.click('#docs-nav button:has-text("Save menu")');
  await page.waitForSelector('#nav-edit');
  await page.reload();
  await page.waitForSelector('#docs-nav .nav-group');
  check(await menu() === 'Network:Network plan+Switch ports+Topology | Servers:Orion | Procedures:Restore from backup+Shopping list | Hardware:Lynx', `saved: ${await menu()}`);

  // deleting a group sends its sheets back to the default group; the page editor offers the groups
  await page.click('#nav-edit');
  await (await groupNamed('Hardware')).locator('.nav-del').click();
  await page.click('#docs-nav button:has-text("Save menu")');
  await page.waitForSelector('#nav-edit');
  check((await menu()).includes('Servers:Orion+Lynx') && !(await menu()).includes('Hardware'), `deleted group: ${await menu()}`);
  await page.click('#docs-nav a:has-text("New page")');
  await page.waitForSelector('.docs-content select option', { state: 'attached' });
  const opts = await page.$$eval('.docs-content select option', (o) => o.map((x) => x.textContent));
  check(opts.join() === 'Servers,Procedures,Pages', `page editor lists the groups (${opts.join(', ')})`);
  await page.fill('input[placeholder="e.g. Restore from backup"]', 'Firmware updates');
  await page.locator('.docs-content select').selectOption({ label: 'Procedures' });
  await page.fill('.md-editor textarea', 'BIOS first');
  await page.click('button:has-text("Save")');
  await page.waitForFunction(() => location.hash.startsWith('#page/'));
  check((await page.textContent('#docs-nav .nav-group:has(.nav-group-name:text("Procedures"))')).includes('Firmware updates'), 'new page lands in the chosen group');
  await page.screenshot({ path: `${S}/docs-nav.png` });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL DOCS MENU UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
}

if (require.main === module) run();
