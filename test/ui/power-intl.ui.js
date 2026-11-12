'use strict';
// Admin → Power & cost outside Norway: another country, a currency, prices by time of day, a grid
// fee; the fields that belong to each choice; then Home and the wall in that currency
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
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');

  await page.goto(B + '/admin#power');
  await page.waitForSelector('#power-form select[name=plan]');
  const f = '#power-form';
  check(await page.locator(`${f} #intl-box`).isHidden() && await page.locator(`${f} input[name=markupOre]`).isVisible(), 'a Norwegian plan: the Norwegian fields, nothing for other countries');
  await page.selectOption(`${f} select[name=plan]`, 'intl');
  check(await page.locator(`${f} #intl-box`).isVisible() && await page.locator(`${f} input[name=markupOre]`).isHidden() && await page.locator(`${f} input[name=dayOre]`).isHidden(), 'another country: its fields instead of the Norwegian ones');
  await page.selectOption(`${f} select[name=currency]`, 'EUR');
  await page.selectOption(`${f} select[name=source]`, 'entsoe');
  check(await page.locator(`${f} select[name=entsoeZone]`).isVisible() && await page.locator(`${f} input[name=entsoeKey]`).isVisible() && await page.locator(`${f} input[name=fixedPrice]`).isHidden(), 'ENTSO-E: a zone and a key');
  await page.selectOption(`${f} select[name=source]`, 'tou');
  await page.fill(`${f} input[name=vatPct]`, '21');
  await page.check(`${f} input[name=enteredInclVat]`);
  await page.click('#tou-energy button:has-text("Add a period")');
  await page.locator('#tou-energy .tou-row').first().locator('input[type=number]').fill('0.35');
  await page.fill('#tou-energy .tou-other input', '0.18');
  await page.selectOption(`${f} select[name=gridMode]`, 'fixed');
  await page.fill(`${f} input[name=gridPrice]`, '0.07');
  const preview = await page.textContent('#price-preview');
  check(/Peak 0\.4200 EUR/.test(preview) && /other times 0\.2500 EUR/.test(preview), `the preview adds the grid fee to each period (${preview.slice(0, 90)})`);
  check(/EUR/.test(await page.textContent(`${f} .cur-month`)), 'monthly fees are in the currency chosen');
  await page.screenshot({ path: `${S}/power-intl-admin.png`, fullPage: true });
  await page.click(`${f} button[type=submit]`);
  await page.waitForFunction(() => /Saved/.test(document.getElementById('power-msg').textContent));
  const saved = (await (await page.request.get(`${B}/api/admin/config`)).json()).settings.power;
  check(saved.plan === 'intl' && saved.intl.source === 'tou' && saved.intl.tou.periods.length === 1 && saved.intl.tou.periods[0].price === 0.35 && saved.intl.grid.price === 0.07, 'saved as entered');

  // Home and the wall in euro
  await page.goto(B + '/');
  await page.waitForSelector('.power-tile');
  const tile = await page.textContent('.power-tile');
  check(/€0\.00/.test(tile) && /c\s*per kWh now/.test(tile) && !/kr|øre/.test(tile), `the power card in euro and cents (${tile.replace(/\s+/g, ' ').slice(0, 90)})`);
  await page.click('.power-tile');
  await page.waitForSelector('.power-card');
  check(/Price by time of day/.test(await page.textContent('.power-card')), 'the details name the price');
  await page.keyboard.press('Escape');
  await page.goto(B + '/wall');
  await page.waitForSelector('#power .trio');
  check(/c\/kWh/.test(await page.textContent('#power')) && !/øre/.test(await page.textContent('#power')), 'the wall too');

  // Dashboard tab: the time zone
  await page.goto(B + '/admin#dashboard');
  await page.waitForSelector('#dash-form select[name=timeZone] option', { state: 'attached' });
  check(await page.inputValue('#dash-form select[name=timeZone]') === 'Europe/Oslo' && (await page.locator('#dash-form select[name=timeZone] option').count()) > 100, 'the time zone list, Oslo chosen');

  console.log(problems.length ? `\n${problems.length} PROBLEM(S)\n${problems.join('\n')}` : '\nUI OK: no console/CSP errors\nALL INTERNATIONAL POWER UI TESTS PASSED');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
