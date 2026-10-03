'use strict';
// Overview: "needs attention" line, compact device cards with Details, one power card, one set of
// status words, no placeholders, no sideways scrolling, and the folded rack on a phone.
const { chromium } = require('playwright');
const S = process.env.SCREENSHOT_DIR || require('node:os').tmpdir();
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
const WORDS = ['OK', 'Warning', 'Problem', 'Offline', 'Waiting', 'Not monitored'];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf);
  const post = (p, body) => page.evaluate(async ([c, p, body]) => (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': c }, body: JSON.stringify(body) })).json(), [csrf, p, body]);
  const c = (type, extra) => ({ type, address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, ...extra });
  await post('/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [c('unifi', { username: 'viewer', secret: 'unifipass' })] });
  await post('/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 19, height: 2, connections: [c('idrac', { username: 'root', secret: 'calvin' }), c('proxmox', { username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } })] });
  await post('/api/admin/devices', { name: 'truenas', kind: 'storage', location: 'rack', u: 13, height: 2, connections: [c('truenas', { username: 'truenas_admin', secret: '1-abcdefKEY' })] });
  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForSelector('#attention .attn-list li');

  // needs attention
  const items = await page.$$eval('#attention .attn-list li', (n) => n.map((x) => x.textContent));
  check(items.some((t) => /titan.*PS2/.test(t)) && items.some((t) => /truenas.*pool fast/.test(t)), `attention lists the problems: ${items.slice(0, 3).join(' | ')}`);
  check(await page.locator('#attention.critical').count() === 1 && /Devices \d+ of \d+ online/.test(await page.textContent('#attention .attn-counts')), 'attention is red and shows the totals');
  const total = await page.evaluate(async () => (await (await fetch('/api/dashboard')).json()).attention.length);
  check(items.length === Math.min(total, 5) && (total <= 5 || new RegExp(`Show all ${total}`).test(await page.textContent('#attention'))), `at most five at first, then "Show all" (${total} in all)`);
  await page.locator('#attention .attn-link', { hasText: 'PS2' }).click();
  await page.waitForTimeout(600);
  check(await page.evaluate(() => document.querySelector('.widget.flash h3')?.textContent) === 'titan', 'clicking a problem jumps to its device');

  // compact cards
  const words = await page.$$eval('.device-card > .card-head .status', (n) => n.map((x) => x.textContent));
  check(words.length === 5 && words.every((w) => WORDS.includes(w)), `one status per card, from one vocabulary: ${words.join(', ')}`);
  const titan = page.locator('.device-card', { hasText: 'titan' });
  check(await titan.locator('.dc-metrics > div').count() === 4 && await titan.locator('.dc-issues li').count() >= 2, 'titan: four key numbers and its problems');
  check(await titan.locator('.fans.mini .fan').count() === 6, 'the spinning fans, small, on the card');
  check(await titan.locator('.card-details').isHidden() && !(await page.textContent('body')).includes('Collecting history'), 'details closed; no placeholders');
  const udm = (await page.textContent('.device-card:has(h3:text-is("UDM Pro"))'));
  check(!/USW-24-POE/.test(udm) && !/PoE consumers/i.test(udm), 'the console card no longer repeats its switches and access points');
  const w = page.locator('.widget[data-id^="device:"]', { has: page.locator('h3:text-is("titan")') });
  const h0 = (await w.boundingBox()).height;
  await titan.locator('.details-toggle').click();
  await page.waitForTimeout(500);
  const h1 = (await w.boundingBox()).height;
  check(await titan.locator('.card-details').isVisible() && h1 > h0 + 200, `Details opens the full sections and the card grows (${Math.round(h0)} → ${Math.round(h1)} px)`);
  check(await titan.locator('.card-details .section-title').allTextContents().then((t) => t.join()) === 'Hardware · iDRAC,Proxmox · node pve1' && await titan.locator('.card-details .fan').count() >= 6, 'details: iDRAC and Proxmox sections with the big fans');
  check(!/Service tag|Power state/.test(await titan.locator('.card-details').textContent()), 'fixed facts are left to the Docs sheet');
  await page.reload();
  await page.waitForSelector('.device-card');
  check(await page.locator('.device-card', { hasText: 'titan' }).locator('.card-details').isVisible(), 'open details are remembered after a reload');
  await page.locator('.device-card', { hasText: 'titan' }).locator('.details-toggle').click();
  await page.waitForTimeout(400);
  check(Math.abs((await w.boundingBox()).height - h0) < 30, 'closing gives the card its size back');
  check(await page.locator('.device-card a:text-is("Sheet")').count() === words.length, 'every card links to its Docs sheet');

  // one power card
  check(await page.locator('.widget[data-id="power-chart"]').count() === 0 && await page.locator('.power-card .dc-metrics > div').count() === 4, 'one power card with four numbers');
  check(await page.locator('.power-card .power-chart').count() === 0, 'no empty 30-day chart on a new install');
  await page.locator('.power-card .details-toggle').click();
  check(/Per year at this draw/.test(await page.textContent('.power-card .card-details')), 'yearly figures under Details');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at 1440 px');
  await page.screenshot({ path: `${S}/overview-new.png`, fullPage: true });

  // phone
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling on a phone');
  check(await page.locator('#rack-panel .rack-view').isHidden() && await page.isVisible('#rack-panel .rack-toggle'), 'the rack starts folded on a phone');
  const order = await page.evaluate(() => [document.getElementById('attention').getBoundingClientRect().top, document.querySelector('.power-card').getBoundingClientRect().top, document.getElementById('rack-panel').getBoundingClientRect().top]);
  check(order[0] < order[1] && order[1] < order[2], 'phone order: attention, power, cards, rack');
  await page.click('#rack-panel .rack-toggle');
  check(await page.locator('#rack-panel .rack-view').isVisible(), '"Show rack" opens it');
  await page.screenshot({ path: `${S}/overview-new-phone.png`, fullPage: true });

  await browser.close();
  for (const p of problems.filter((x) => x.startsWith('console') || x.startsWith('pageerror'))) console.log(`FAIL  ${p}`);
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL OVERVIEW UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})();
