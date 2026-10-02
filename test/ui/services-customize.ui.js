'use strict';
// Services → Customize: drag a card to another group, keyboard moves, hide, columns, drag a group.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept('Later'));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  for (const [name, group] of [['A1', 'Alpha'], ['A2', 'Alpha'], ['B1', 'Beta'], ['B2', 'Beta']]) {
    await page.evaluate(async ([c, name, group]) => fetch('/api/admin/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify({ name, group, href: `https://${name.toLowerCase()}.example.lan` }) }), [csrf, name, group]);
  }
  await page.goto(B + '/services');
  await page.waitForSelector('.svc-card');
  const layout = () => page.$$eval('section.svc-group', (secs) => secs.map((s) => `${s.dataset.key}:${[...s.querySelectorAll('.svc-card strong')].map((x) => x.textContent).join('+')}`).join(' | '));
  check(await layout() === 'Alpha:A1+A2 | Beta:B1+B2', `start: ${await layout()}`);

  await page.click('#customize');
  await page.waitForSelector('#edit-bar:not(.hidden)');
  check(await page.locator('section.svc-group.editing').count() === 2 && await page.locator('.svc-card.editable a').count() === 0, 'customize mode: groups editable, cards are not links');

  // mouse: drag B1 in front of A1
  const card = (n) => page.locator('.svc-card.editable', { hasText: n });
  const from = await card('B1').boundingBox();
  const to = await card('A1').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + from.width / 2 + ((to.x + 10 - from.x - from.width / 2) * i) / 12, from.y + from.height / 2 + ((to.y + to.height / 2 - from.y - from.height / 2) * i) / 12);
  check(await page.locator('.svc-placeholder').count() === 1 && await page.locator('.drag-ghost').count() === 1, 'dragging shows a placeholder');
  await page.screenshot({ path: `${S}/services-customize-drag.png` });
  await page.mouse.up();
  check(await layout() === 'Alpha:B1+A1+A2 | Beta:B2', `B1 dragged into Alpha: ${await layout()}`);

  // keyboard: A2 down to Beta, then left within Beta
  await card('A2').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  check(await layout() === 'Alpha:B1+A1 | Beta:A2+B2', `arrow keys move A2 to Beta and to the front: ${await layout()}`);
  check(/A2 position 1|A2: position 1/.test(await page.textContent('#announce')), 'moves are announced');

  // hide B2, 2 columns for Alpha, drag Beta above Alpha
  await card('B2').locator('.svc-hide').click();
  check(!(await layout()).includes('B2') && /Show hidden service \(1\)/.test(await page.textContent('#edit-bar')), 'B2 hidden');
  await page.locator('section[data-key="Alpha"] .cols-select').selectOption('2');
  const grip = await page.locator('section[data-key="Beta"] .group-grip').boundingBox();
  const alpha = await page.locator('section[data-key="Alpha"]').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(grip.x + grip.width / 2, grip.y + ((alpha.y + 5 - grip.y) * i) / 10);
  await page.mouse.up();
  check((await layout()).startsWith('Beta:'), `Beta dragged above Alpha: ${await layout()}`);
  await page.locator('section[data-key="Beta"] .group-name').fill('Bravo');
  await page.screenshot({ path: `${S}/services-customize.png`, fullPage: true });

  await page.click('#edit-bar button:has-text("Save layout")');
  await page.waitForFunction(() => document.getElementById('edit-bar').classList.contains('hidden') || document.querySelector('#edit-bar .msg.error'));
  check(await page.locator('#edit-bar .msg.error').count() === 0, `layout saved ${await page.locator('#edit-bar .msg').textContent().catch(() => '')}`);
  await page.reload();
  await page.waitForSelector('.svc-card');
  check(await layout() === 'Bravo:A2 | Alpha:B1+A1', `saved and reloaded: ${await layout()}`);
  check(await page.locator('section[data-key="Alpha"] .svc-grid.fixed-cols').count() === 1, 'Alpha uses 2 columns');
  check(await page.locator('.svc-card a, a.svc-card').count() === 3, 'cards are links again');

  // show the hidden one again, then cancel: nothing changes
  await page.click('#customize');
  await page.locator('#edit-bar select').selectOption({ label: 'B2 (Bravo)' });
  check((await layout()).includes('Bravo:A2+B2'), 'hidden service follows the renamed group and can be shown again');
  await page.click('#edit-bar button:has-text("Cancel")');
  check(!(await layout()).includes('B2'), 'Cancel discards the change');

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL CUSTOMIZE UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
