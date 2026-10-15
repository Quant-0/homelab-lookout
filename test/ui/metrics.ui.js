'use strict';
// Admin → Server → Metrics in a browser: making a token (shown once, with the Prometheus and Home
// Assistant setup), reading /metrics with it, changing and removing it, and the card on a phone.
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');

  await page.goto(B + '/admin#metrics');
  const card = page.locator('#metrics-card');
  await card.locator('text=No tokens yet').waitFor();
  check(await card.isVisible(), 'the #metrics link opens the card on the Server tab');

  await card.locator('input[name=name]').fill('Prometheus');
  await card.locator('input[name=allow]').fill('127.0.0.1');
  await card.locator('#metrics-submit').click();
  await card.locator('.metrics-new').waitFor();
  const blocks = await card.locator('.metrics-new pre').allTextContents();
  const secret = blocks[0];
  check(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(secret), 'the new token is shown');
  check(blocks[1].includes('job_name: homelab-lookout') && blocks[1].includes(secret), 'with a Prometheus config holding it');
  check(blocks[2].includes('/metrics.json') && blocks[2].includes('lookout_metrics'), 'and Home Assistant sensors');
  check(/From 127\.0\.0\.1/.test(await card.locator('.metrics-tokens').textContent()), 'the token is listed with its address');

  const scrape = await page.evaluate(async (s) => {
    const r = await fetch('/metrics', { headers: { Authorization: `Bearer ${s}` }, credentials: 'omit' });
    return { status: r.status, text: await r.text() };
  }, secret);
  check(scrape.status === 200 && /lookout_info\{/.test(scrape.text), 'the token reads /metrics');

  await card.locator('button', { hasText: 'Done' }).click();
  await page.reload();
  await card.locator('.metrics-tokens').waitFor();
  check(/Last read .* from 127\.0\.0\.1/.test(await card.locator('.metrics-tokens').textContent()), 'and shows when it was last read');
  check(!(await card.textContent()).includes(secret), 'the token is not shown again');

  // change its addresses
  await card.locator('button', { hasText: 'Change' }).click();
  check((await card.locator('#metrics-form-title').textContent()) === 'Change Prometheus', 'Change fills the form');
  await card.locator('input[name=allow]').fill('192.0.2.30, 127.0.0.1');
  await card.locator('#metrics-submit').click();
  await card.locator('text=From 192.0.2.30, 127.0.0.1').waitFor();
  check(true, 'the new addresses are saved');

  // on a phone
  await page.setViewportSize({ width: 390, height: 800 });
  await card.locator('input[name=name]').fill('Home Assistant');
  await card.locator('input[name=allow]').fill('127.0.0.1');
  await card.locator('#metrics-submit').click();
  await card.locator('.metrics-new').waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!wide, 'fits a phone, snippets scroll inside their boxes');
  await card.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/metrics-card-phone.png` });
  await page.setViewportSize({ width: 1280, height: 900 });

  // remove
  page.once('dialog', (d) => d.accept());
  await card.locator('.metrics-tokens li', { hasText: 'Prometheus' }).locator('button', { hasText: 'Remove' }).click();
  await page.waitForFunction(() => !document.querySelector('#metrics-list').textContent.includes('Prometheus'));
  const after = await page.evaluate(async (s) => (await fetch('/metrics', { headers: { Authorization: `Bearer ${s}` }, credentials: 'omit' })).status, secret);
  check(after === 401, 'a removed token stops working');

  await browser.close();
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
