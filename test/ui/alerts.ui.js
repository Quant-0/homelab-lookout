'use strict';
// Admin → Alerts: channel editor per type, routing table, save, no secrets in the page.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const TOKEN = '123456789:AAHsecretTelegramToken_abcdefghij';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  await page.goto(B + '/admin#alerts');
  await page.waitForSelector('#tab-alerts:not([hidden]) table.rules');
  check(await page.locator('#al-rules-table tbody tr').count() === 11, 'routing table lists the 11 kinds of alert');
  check(/Add a channel first/.test(await page.textContent('#al-rules-table')), 'hint to add a channel first');
  check(/Nothing wrong right now/.test(await page.textContent('#al-active')), 'no active alerts');

  // ntfy: random topic, auth switch shows the token field, http warning
  await page.selectOption('#al-add', 'ntfy');
  const ed = page.locator('#al-editor');
  await ed.locator('label:has-text("Name") input').fill('Phone');
  await ed.locator('button:has-text("Random topic name")').click();
  const topic = await ed.locator('label:has-text("Topic") input').inputValue();
  check(/^homelab-[a-z0-9]{12,20}$/.test(topic), `random topic generated (${topic})`);
  check(await ed.locator('input[type=password]').count() === 0, 'no token field without login');
  await ed.locator('label:has-text("Login") select').selectOption('token');
  check(await ed.locator('label:has-text("Access token") input[type=password]').count() === 1, 'token field appears for token login');
  await ed.locator('label:has-text("Server") input').fill('http://192.168.1.5');
  check(/sent unencrypted/.test(await ed.textContent()), 'warning for a token over http://');
  await ed.locator('label:has-text("Login") select').selectOption('none');
  await ed.locator('label:has-text("Server") input').fill('https://ntfy.sh');
  await ed.locator('button:has-text("Save channel")').click();
  await page.waitForSelector('#al-channels .svc-row');

  // Telegram
  await page.selectOption('#al-add', 'telegram');
  await ed.locator('label:has-text("Bot token") input').fill(TOKEN);
  await ed.locator('label:has-text("Chat ID") input').fill('42');
  await ed.screenshot({ path: `${S}/alerts-editor.png` });
  await ed.locator('button:has-text("Save channel")').click();
  await page.waitForFunction(() => document.querySelectorAll('#al-channels .svc-row').length === 2);
  check(!(await page.content()).includes('AAHsecret'), 'bot token is not in the page after saving');
  await page.locator('#al-channels .svc-row', { hasText: 'Telegram' }).locator('button:has-text("Edit")').click();
  check(await ed.locator('label:has-text("Bot token") input').inputValue() === '' && /Stored/.test(await ed.locator('label:has-text("Bot token") input').getAttribute('placeholder')), 'editing shows "Stored", never the token');
  await ed.locator('button:has-text("Close")').click();

  // routing: two channel columns, untick Telegram for "Service down", save, reload
  const heads = await page.$$eval('#al-rules-table thead th', (t) => t.map((x) => x.textContent));
  check(heads.includes('Phone') && heads.includes('Telegram'), `a column per channel (${heads.join(', ')})`);
  const svcTg = page.getByLabel('Send “Service down” to Telegram');
  check(await svcTg.isChecked(), 'new channels get every enabled alert');
  await svcTg.uncheck();
  await page.getByLabel('Service down: minutes to wait').fill('2');
  await page.locator('#al-rules select[name=repeatHours]').selectOption('4');
  await page.click('#al-rules button[type=submit]');
  await page.waitForSelector('#al-rules-msg.ok');
  await page.reload();
  await page.waitForSelector('#tab-alerts:not([hidden]) table.rules');
  check(!(await page.getByLabel('Send “Service down” to Telegram').isChecked()) && await page.getByLabel('Send “Hardware fault” to Telegram').isChecked(), 'routing saved per alert and channel');
  check(await page.getByLabel('Service down: minutes to wait').inputValue() === '2' && await page.locator('#al-rules select[name=repeatHours]').inputValue() === '4', 'wait time and reminder saved');
  await page.screenshot({ path: `${S}/alerts-tab.png`, fullPage: true });

  // e-mail fields follow the encryption choice
  await page.selectOption('#al-add', 'email');
  check(await ed.locator('label:has-text("Port") input').inputValue() === '587', 'STARTTLS defaults to port 587');
  await ed.locator('label:has-text("Encryption") select').selectOption('none');
  check(await ed.locator('label:has-text("Port") input').inputValue() === '25' && await ed.locator('input[type=password]').count() === 0, 'no login fields without encryption');
  await ed.locator('button:has-text("Close")').click();

  const dark = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', storageState: await ctx.storageState() })).newPage();
  await dark.goto(B + '/admin#alerts');
  await dark.waitForSelector('#tab-alerts:not([hidden]) table.rules');
  check(await dark.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page-wide horizontal scroll on a phone (the table scrolls inside its box)');
  await dark.screenshot({ path: `${S}/alerts-mobile-dark.png`, fullPage: true });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL ALERTS UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
