'use strict';
// Sign-in that lasts, and confirming the password for a risky change (STEP_UP_S=3)
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  check(/Keep me signed in/.test(await page.textContent('#login-form')), 'the sign-in form offers "Keep me signed in"');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.check('#keep');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const cookie = (await ctx.cookies()).find((c) => c.name === 'hd_session');
  check(cookie && cookie.expires * 1000 > Date.now() + 29 * 86400e3 && cookie.httpOnly && cookie.sameSite === 'Strict', 'a 30-day cookie, HttpOnly, SameSite=Strict');

  // Admin → System lists this browser
  await page.goto(B + '/admin#system');
  await page.waitForSelector('#sessions table');
  check(/this browser/.test(await page.textContent('#sessions')) && /Kept signed in/.test(await page.textContent('#sessions')), 'Signed-in browsers lists this one, kept signed in');

  // a risky change after the step-up time: the password is asked for, then the change is made
  await page.waitForTimeout(3500);
  await page.goto(B + '/admin#alerts');
  await page.waitForSelector('#tab-alerts:not([hidden]) table.rules');
  await page.selectOption('#al-add', 'ntfy');
  const ed = page.locator('#al-editor');
  await ed.locator('label:has-text("Name") input').fill('Phone');
  await ed.locator('button:has-text("Random topic name")').click();
  await ed.locator('button:has-text("Save channel")').click();
  await page.waitForSelector('dialog.confirm-dialog[open]');
  check(true, 'saving a new alert channel asks for the password');
  await page.fill('dialog.confirm-dialog input[type=password]', 'not it');
  await page.click('dialog.confirm-dialog button[type=submit]');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('dialog.confirm-dialog .msg')?.textContent || ''));
  check(true, 'a wrong password says so and keeps the dialog open');
  await page.screenshot({ path: `${S}/stepup.png` });
  await page.fill('dialog.confirm-dialog input[type=password]', 'correct horse battery');
  await page.click('dialog.confirm-dialog button[type=submit]');
  await page.waitForSelector('dialog.confirm-dialog', { state: 'detached' });
  await page.waitForFunction(() => /Phone/.test(document.getElementById('al-channels').textContent));
  check(true, 'with the password the channel is saved, without saving again');

  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL SESSION UI TESTS PASSED');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
