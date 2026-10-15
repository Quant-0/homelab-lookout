'use strict';
// The setup page in a browser: on a server without an admin, the code from the log makes the
// admin account and opens Admin; on a phone the form fits.
const fs = require('node:fs');
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const code = (/setup code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(fs.readFileSync(process.env.SERVER_LOG, 'utf8')) || [])[1];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/');
  await page.waitForURL(B + '/setup');
  check(true, 'opening the dashboard leads to the setup page');
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), 'it fits a phone');
  await page.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/setup-phone.png` });

  await page.fill('#code', 'WRONG-CODE1');
  await page.fill('#password', 'correct horse battery');
  await page.fill('#password2', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.locator('#setup-error', { hasText: 'Wrong setup code' }).waitFor();
  check(true, 'a wrong code is shown');

  await page.fill('#password2', 'something else entirely');
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  check(/do not match/.test(await page.textContent('#setup-error')), 'different passwords are caught in the page');

  await page.fill('#password2', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/admin');
  check(true, 'the right code makes the admin and opens Admin');
  await page.goto(B + '/setup');
  await page.waitForURL(/\/(login|)$/);
  check(!page.url().endsWith('/setup'), 'the setup page is gone afterwards');

  await browser.close();
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
