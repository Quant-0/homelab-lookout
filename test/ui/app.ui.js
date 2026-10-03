'use strict';
// The installable app on a phone: sign in with "Remember this device", lose the session, keep
// reading (view only, no edit controls), re-enter the password for Admin, see the device in
// Admin → System; installable per Chrome; offline screen when the server can't be reached.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
let offline = false; // failed requests are expected while offline
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' });
  const page = await context.newPage();
  page.on('console', (m) => !offline && (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(B + '/login');
  check(await page.isVisible('#remember') && !(await page.isVisible('#reauth')), 'login offers "Remember this device for viewing"');
  await page.screenshot({ path: `${S}/app-login.png` });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.check('#remember');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const names = (await context.cookies()).map((c) => c.name);
  check(names.includes('hd_session') && names.includes('hd_device'), 'session and device cookies set');

  // the app can be installed (Chrome's own check) and the service worker runs
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  check(installabilityErrors.length === 0, `Chrome: installable (${installabilityErrors.map((e) => e.errorId).join(', ') || 'no errors'})`);
  const m = await cdp.send('Page.getAppManifest');
  check(!m.errors.length && /"name":"Homelab"/.test(m.data.replace(/\s/g, '')), `manifest parses without errors${m.errors.length ? `: ${m.errors.map((e) => e.message).join('; ')}` : ''}`);

  // two hours later: the session is gone, the device is still remembered
  await context.clearCookies({ name: 'hd_session' });
  await page.reload();
  await page.waitForSelector('#nav button:text-is("Log out")');
  const nav = await page.$$eval('#nav > *', (n) => n.map((x) => x.textContent));
  check(nav.join(',') === 'Admin,Log out', `view only: nav is ${nav.join(', ')} (no Customize)`);
  const tabs = await page.$$eval('#view-tabs a', (n) => n.map((x) => x.textContent));
  check(tabs.includes('Docs') && tabs.includes('Updates'), 'Docs and Updates are readable');
  await page.goto(B + '/docs#network');
  await page.waitForSelector('.docs-toolbar h2:text-is("Network plan")');
  check(await page.locator('.docs-toolbar button:text-is("Edit")').count() === 0 && await page.locator('#docs-nav a:text-is("New page")').count() === 0 && await page.locator('#nav-edit').count() === 0, 'Docs: no Edit, New page or Edit menu');
  await page.goto(B + '/docs#new-page');
  await page.waitForSelector('#docs-content');
  check(await page.locator('#docs-content h2:text-is("New page")').count() === 0, 'Docs: #new-page shows the overview instead');
  await page.goto(B + '/updates');
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('upd-summary').textContent));
  check(!(await page.isVisible('#upd-check')), 'Updates: no "Check now"');

  // Admin asks for the password; the device stays remembered
  await page.goto(B + '/');
  await page.click('#nav a:text-is("Admin")');
  await page.waitForURL(/\/login\?next=admin$/);
  await page.waitForSelector('#reauth:not([hidden])');
  check(!(await page.isVisible('#remember')), 'the password page explains why and hides the box');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/admin');
  await page.click('#tabbtn-system');
  await page.waitForSelector('#remembered tbody tr');
  const row = await page.textContent('#remembered tbody tr');
  check(/Chrome on Android/.test(row) && /this device/.test(row) && /from 127\.0\.0\.1/.test(row), `Admin → System lists it: ${row.replace(/\s+/g, ' ').trim()}`);
  check(await page.isVisible('#app-card') && /Add to Home Screen/.test(await page.textContent('#app-card')), 'install instructions in Admin → System');
  await page.locator('#app-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${S}/app-admin.png`, fullPage: false });

  // offline: the app shows its own screen, and comes back by itself
  await page.goto(B + '/services');
  await page.waitForSelector('#groups');
  offline = true;
  await context.setOffline(true);
  await page.goto(B + '/services').catch(() => {});
  await page.waitForSelector('text=Can\'t reach the dashboard');
  check(await page.isVisible('#retry'), 'offline: the app shows its offline screen');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'offline screen fits the phone');
  await page.screenshot({ path: `${S}/app-offline.png` });
  const cached = await page.evaluate(async () => (await (await caches.open('hd-shell-1')).keys()).map((r) => new URL(r.url).pathname).sort());
  check(cached.join(',') === '/offline,/static/css/style.css,/static/favicon.svg,/static/js/offline.js', `only the app shell is stored on the device (${cached.join(', ')})`);
  await page.click('#retry');
  await page.waitForFunction(() => /Still no answer/.test(document.getElementById('offline-msg').textContent));
  check(true, '"Try again" while offline says so');
  await context.setOffline(false);
  offline = false;
  await page.click('#retry');
  await page.waitForSelector('#groups', { timeout: 10000 });
  check(page.url() === `${B}/services`, 'back online: "Try again" opens the page');

  // log out forgets the device
  await page.click('#nav button:text-is("Log out")');
  await page.waitForURL(B + '/login');
  check(!(await context.cookies()).some((c) => c.name === 'hd_device' && c.value), 'log out removes the device cookie');
  await page.goto(B + '/');
  check(page.url() === `${B}/login`, 'and the dashboard asks for the password again');

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL APP UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
