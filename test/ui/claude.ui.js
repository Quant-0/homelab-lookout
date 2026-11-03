'use strict';
// Claude on Home and the wall: the tile, its drawer, choosing what it shows with Customize, the
// wall panel's styles and the ticker, and the Admin card (CLAUDE_STATUS_URL points at the mock)
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
  check(await page.locator('#claude-sec').isHidden(), 'no Claude tile before anything is set up');

  // a reporter, from the Admin card
  await page.goto(B + '/admin#claude');
  await page.waitForSelector('#claude-card');
  await page.click('#claude-new');
  await page.fill('#claude-editor input:not([type=checkbox])', 'workstation');
  await page.check('#claude-editor label:has-text("Plan limits") input');
  await page.click('#claude-editor button:has-text("Create and show the install command")');
  await page.waitForSelector('#claude-editor pre');
  const install = await page.textContent('#claude-editor pre');
  check(/\/claude\/install\.sh \| sh -s -- --id [0-9a-f-]{36} --token \S{43}/.test(install), 'Add reporter shows the install command with its token');
  check(/workstation/.test(await page.textContent('#claude-list')) && /never yet/.test(await page.textContent('#claude-list')), 'the reporter is listed, not reporting yet');
  const [, id, token] = /--id (\S+) --token (\S+)/.exec(install);
  const hour = new Date().toISOString().slice(0, 13);
  await page.request.post(`${B}/claude/report`, { headers: { Authorization: `Bearer ${id}.${token}` }, data: { reporter: '1.0.0', hostname: 'ws', hours: { [hour]: { s: 2, a: 45, m: { 'claude-opus-5-5': [1000, 200000, 12000000, 0, 300000, 40] } } }, limits: { plan: 'max', fiveHour: { pct: 42, resetsAt: new Date(Date.now() + 7200e3).toISOString() }, sevenDay: { pct: 93, resetsAt: new Date(Date.now() + 3 * 864e5).toISOString() }, breakdown: [{ key: 'claude_code', name: 'Claude Code', pct: 80 }, { key: 'chat', name: 'Chats', pct: 20 }] } } });
  await page.check('#claude-form input[name=statusEnabled]');
  await page.click('#claude-form button[type=submit]');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('claude-msg').textContent));
  check(true, 'the status page is switched on');

  // Home
  await page.goto(B + '/');
  await page.waitForSelector('.claude-tile');
  await page.waitForFunction(() => /Operational/.test(document.querySelector('.claude-tile').textContent));
  const tile = await page.textContent('.claude-tile');
  check(/12\.5M\s*tokens today/.test(tile) && /\$\d/.test(tile), `the tile shows today's tokens and cost (${tile.slice(0, 80)})`);
  check(/Max plan limits/.test(tile) && /42 %/.test(tile) && /93 %/.test(tile) && (await page.locator('.claude-tile .cl-meter.critical').count()) === 1, 'the plan limits, the weekly one in red at 93 %');
  check((await page.locator('.claude-tile .cl-bars > span').count()) === 7, 'a bar for each of the last 7 days');
  await page.screenshot({ path: `${S}/claude-home.png` });
  await page.click('.claude-tile');
  await page.waitForSelector('.claude-card');
  const det = await page.textContent('.claude-card');
  check(/Claude Code/.test(det) && /workstation/.test(det) && /Opus 5\.5/.test(det) && /45 min active/.test(det) && /claude\.ai/.test(det), `the drawer has Claude Code, the machine, the models, active time and the status components (${det.replace(/\s+/g, ' ').slice(0, 600)})`);
  await page.screenshot({ path: `${S}/claude-drawer.png` });
  await page.keyboard.press('Escape');

  // Customize: no cost on the tile
  await page.click('#customize');
  await page.waitForSelector('.cl-edit');
  await page.uncheck('.cl-edit input[name=claude-cost]');
  check(!/\$\d/.test(await page.textContent('.claude-tile .big-facts')), 'unticking Cost takes it off the tile at once');
  await page.click('#edit-bar button.primary');
  await page.waitForSelector('.cl-edit', { state: 'detached' });
  await page.reload();
  await page.waitForSelector('.claude-tile');
  check(!/\$\d/.test(await page.textContent('.claude-tile')), 'and it stays off after Save and a reload');

  // plan limits only: the tile shows the limits, the week by product and the status, no tokens
  const cs = (await (await page.request.get(`${B}/api/session`)).json()).csrf;
  await page.request.put(`${B}/api/admin/claude/reporters/${id}`, { data: { name: 'workstation', usage: false, limits: true }, headers: { 'X-CSRF-Token': cs } });
  await page.reload();
  await page.waitForSelector('.claude-tile .cl-split');
  const lim = await page.textContent('.claude-tile');
  check(/42\s*% of the 5-hour limit/.test(lim) && /Claude Code 80 %/.test(lim) && /Chats 20 %/.test(lim) && !/tokens/.test(lim) && !/\$/.test(lim) && (await page.locator('.claude-tile .cl-bars').count()) === 0, 'limits only: the 5-hour limit as the number, the bars, the week by product, no tokens or cost');
  await page.screenshot({ path: `${S}/claude-limits-only.png` });
  await page.request.put(`${B}/api/admin/claude/reporters/${id}`, { data: { name: 'workstation', usage: true, limits: true }, headers: { 'X-CSRF-Token': cs } });
  await page.request.post(`${B}/claude/report`, { headers: { Authorization: `Bearer ${id}.${token}` }, data: { reporter: '1.1.0', hostname: 'ws', hours: { [hour]: { s: 2, a: 45, m: { 'claude-opus-5-5': [1000, 200000, 12000000, 0, 300000, 40] } } }, limits: { plan: 'max', fiveHour: { pct: 42, resetsAt: new Date(Date.now() + 7200e3).toISOString() }, sevenDay: { pct: 93, resetsAt: new Date(Date.now() + 3 * 864e5).toISOString() } } } });

  // the wall: a panel in each style, and the ticker
  const csrf = (await (await page.request.get(`${B}/api/session`)).json()).csrf;
  const wall = (await (await page.request.get(`${B}/api/dashboard`)).json()).wall;
  const setWall = (style) => page.request.put(`${B}/api/admin/wall`, { data: { ...wall, hidden: [], claude: { style, stats: ['tokens', 'cost', 'limits', 'status'] } }, headers: { 'X-CSRF-Token': csrf } });
  await setWall('rings');
  await page.goto(B + '/wall');
  await page.waitForSelector('#claude .cl-ring');
  check((await page.locator('#claude .cl-ring').count()) === 2 && !/null/.test(await page.textContent('#claude')), 'Limit rings: two rings, 5 hours and the week');
  await page.screenshot({ path: `${S}/claude-wall-rings.png` });
  await setWall('tile');
  await page.reload();
  await page.waitForSelector('#claude .huge');
  await page.screenshot({ path: `${S}/claude-wall-tile.png` });
  check(/12\.5M/.test(await page.textContent('#claude')) && (await page.locator('#claude .cl-meter').count()) === 2 && !/null/.test(await page.textContent('#claude')), 'Full tile: the number, the bars and the limits');
  await setWall('ticker');
  await page.reload();
  await page.waitForSelector('#claude-ticker:not([hidden])');
  check(await page.locator('#claude').isHidden() && /12\.5M tokens today/.test(await page.textContent('#claude-ticker')) && /42 % 5 hours/.test(await page.textContent('#claude-ticker')), 'Ticker line: one row above the services instead of a panel');
  await page.screenshot({ path: `${S}/claude-wall-ticker.png` });
  // the wall's Customize has the Claude panel's style
  await page.click('#wall-customize');
  await page.waitForSelector('select[name=claude-style]');
  await page.selectOption('select[name=claude-style]', 'number');
  await page.waitForSelector('#claude:not([hidden]) .huge');
  check(await page.locator('#claude-ticker').isHidden(), 'choosing Big number in Customize previews it at once');
  await page.click('.wall-edit button.primary');
  await page.waitForSelector('.wall-edit', { state: 'detached' });
  const saved = (await (await page.request.get(`${B}/api/dashboard`)).json()).wall.claude.style;
  check(saved === 'number', 'and Save keeps it');
  await page.click('#claude');
  await page.waitForSelector('.claude-card');
  check(true, 'tapping the wall panel opens the Claude details on Home');

  // a phone: no sideways scrolling
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState() });
  const pp = await phone.newPage();
  await pp.goto(B + '/');
  await pp.waitForSelector('.claude-tile');
  check(await pp.evaluate(() => document.documentElement.scrollWidth <= 390), 'the tile fits a phone');

  console.log(problems.length ? `\n${problems.length} PROBLEM(S)\n${problems.join('\n')}` : '\nUI OK: no console/CSP errors\nALL CLAUDE UI TESTS PASSED');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
