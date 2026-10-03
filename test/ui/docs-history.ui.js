'use strict';
// Docs page history in the browser: versions list, highlighted changes, "As it was", restore,
// and Recently deleted.
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
  page.on('dialog', (d) => d.accept());
  await page.goto(B + '/login?next=docs');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/docs');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const call = (method, p, body) => page.evaluate(async ([c, method, p, body]) => (await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify(body) })).json(), [csrf, method, p, body]);
  const { page: pg } = await call('POST', '/api/docs/pages', { title: 'Update Proxmox', body: '# Steps\n\n1. Migrate the VMs\n2. apt update\n3. apt dist-upgrade\n4. Reboot', group: 'pages' });
  await call('PUT', `/api/docs/pages/${pg.id}`, { title: 'Update Proxmox', body: '# Steps\n\n1. Migrate the VMs\n2. apt update\n3. apt full-upgrade\n4. Reboot\n5. Check the cluster' });
  await page.goto(`${B}/docs#page/${pg.id}`);
  await page.reload();
  await page.waitForSelector('.docs-toolbar a:has-text("History")');

  await page.click('.docs-toolbar a:has-text("History")');
  await page.waitForSelector('.history-list li');
  const items = await page.$$eval('.history-item strong', (n) => n.map((x) => x.textContent));
  check(items.length === 2 && items[0] === 'Current version', `versions listed, newest first (${items.join(' | ')})`);
  await page.waitForSelector('.diff');
  const added = await page.$$eval('.diff-line.add .diff-text', (n) => n.map((x) => x.textContent));
  const removed = await page.$$eval('.diff-line.del .diff-text', (n) => n.map((x) => x.textContent));
  check(added.includes('3. apt full-upgrade') && added.includes('5. Check the cluster') && removed.includes('3. apt dist-upgrade'), `changes highlighted (+${added.length} −${removed.length})`);
  check(await page.locator('.diff-line.add .sr-only').first().textContent() === 'Added: ', 'added and removed lines are named for screen readers');
  const order = await page.$$eval('.diff-line', (n) => n.map((x) => x.className.includes('del') ? '-' : x.className.includes('add') ? '+' : ' ').join(''));
  check(order.indexOf('-') < order.indexOf('+'), `the old line comes before the new one (${order})`);
  check(!/null/.test(await page.textContent('#docs-nav')), 'nothing stray in the menu');
  await page.screenshot({ path: `${S}/docs-history.png`, fullPage: true });
  await page.click('.history-head button:has-text("As it was")');
  check(/apt dist-upgrade/.test(await page.textContent('.history-body')) && await page.locator('.history-body ol li').count() === 4, '"As it was" shows the old page rendered');
  await page.click('button:has-text("Restore this version")');
  await page.waitForFunction((id) => location.hash === `#page/${id}`, pg.id);
  await page.waitForSelector('.docs-content .md');
  check(/apt dist-upgrade/.test(await page.textContent('.docs-content')) && !/Check the cluster/.test(await page.textContent('.docs-content')), 'restored: the old text is back');
  await page.click('.docs-toolbar a:has-text("History")');
  await page.waitForSelector('.history-item');
  check(/Restored from version 1/.test(await page.textContent('.history-list')) && await page.locator('.history-item').count() === 3, 'the restore shows up as a version of its own');

  // delete and bring back
  await page.goto(`${B}/docs#page/${pg.id}`);
  await page.click('.docs-toolbar button:has-text("Edit")');
  await page.click('button:has-text("Delete page")');
  await page.waitForSelector('#docs-nav a:has-text("Recently deleted (1)")');
  check(!(await page.textContent('#docs-nav')).includes('Update Proxmox'), 'deleted page leaves the menu; "Recently deleted (1)" appears');
  await page.click('#docs-nav a:has-text("Recently deleted")');
  await page.waitForSelector('.deleted-list li');
  check(/3 versions/.test(await page.textContent('.deleted-list')), 'Recently deleted shows it with its versions');
  await page.screenshot({ path: `${S}/docs-deleted.png` });
  await page.click('.deleted-list button:has-text("Restore")');
  await page.waitForFunction((id) => location.hash === `#page/${id}`, pg.id);
  check((await page.textContent('#docs-nav')).includes('Update Proxmox') && !(await page.textContent('#docs-nav')).includes('Recently deleted'), 'restored into the menu; the deleted list is empty again');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${B}/docs#history/${pg.id}`);
  await page.waitForSelector('.history-body');
  check(/No changes in the text/.test(await page.textContent('.history-body')), 'a version with the same text says so');
  await page.locator('.history-item').nth(2).click(); // version 2, the one with "Check the cluster"
  await page.waitForSelector('.diff');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'history works on a phone without sideways scrolling');

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL DOCS HISTORY UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
