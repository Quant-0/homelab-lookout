'use strict';
// Passkeys in a real browser (Chrome's virtual authenticator, with "Face ID" that always says yes):
// add one in Admin, sign in with it, and confirm a risky change with it. On localhost, which
// browsers allow without https. Runs with STEP_UP_S=3.
const { chromium } = require('playwright');
const B = 'http://localhost:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  await page.goto(B + '/login');
  check(await page.isHidden('#passkey'), 'no passkey button before there is a passkey');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  await page.evaluate(async () => {
    const s = await (await fetch('/api/session')).json();
    const c = await (await fetch('/api/admin/config')).json();
    await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ dashboard: { ...c.settings.dashboard, linkUrl: 'http://localhost:18080' } }) });
  });

  // add one
  await page.goto(B + '/admin#security');
  await page.waitForSelector('#passkey-add:not([hidden])');
  page.once('dialog', (d) => d.accept('Test laptop'));
  await page.click('#passkey-add');
  await page.waitForFunction(() => /Test laptop/.test(document.getElementById('passkeys').textContent));
  check(true, 'Add a passkey: the browser makes one and it is listed');

  // sign out, sign in with it
  await page.evaluate(() => HD.logout());
  await page.waitForURL(/\/login/);
  await page.waitForSelector('#passkey:not([hidden])');
  await page.click('#passkey');
  await page.waitForURL(B + '/');
  check(true, 'Sign in with a passkey');
  await page.goto(B + '/admin#security');
  await page.waitForSelector('#passkeys table');
  check(!/Never/.test(await page.textContent('#passkeys')), 'last used is filled in');

  // a risky change after the step-up time: the dialog offers the passkey
  await sleep(3500);
  const done = page.evaluate(() => HD.api('POST', '/api/admin/alerts/channels', { type: 'push', name: 'Phones' }).then(() => 'ok', (e) => e.message));
  await page.waitForSelector('dialog.confirm-dialog[open] button:has-text("Use a passkey")');
  await page.click('dialog.confirm-dialog button:has-text("Use a passkey")');
  check(await done === 'ok', 'a risky change is confirmed with the passkey');

  // on another address (127.0.0.1): only a pointer to where passkeys work
  const p2 = await ctx.newPage();
  await p2.goto('http://127.0.0.1:18080/login');
  await p2.waitForSelector('#passkey-elsewhere:not([hidden])');
  check(/localhost:18080/.test(await p2.textContent('#passkey-elsewhere')) && await p2.isHidden('#passkey'), 'on another address it points to where passkeys work');

  await browser.close();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL PASSKEY UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
