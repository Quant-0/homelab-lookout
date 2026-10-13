'use strict';
// Acknowledging in a browser: the link from an alert message (its form must pass the origin check),
// the Acknowledge item on Home, and Log → Incidents. Runs with OFFLINE_GRACE_S=0.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
// the token the server puts in the link (HMAC with a key derived from the server key)
function ackLink(id) {
  const key = Buffer.from(fs.readFileSync(path.join(process.env.DATA_DIR, 'secret.key'), 'utf8').trim(), 'hex');
  const k = Buffer.from(crypto.hkdfSync('sha256', key, '', 'homelab-lookout ack links', 32));
  return `${B}/ack/${id}?t=${crypto.createHmac('sha256', k).update(`ack:${id}`).digest('base64url').slice(0, 32)}`;
}
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  const call = (method, p, body) => page.evaluate(async ([method, p, body]) => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, [method, p, body]);
  const add = (name, address) => call('POST', '/api/admin/devices', { name, kind: 'server', location: 'outside', connections: [{ type: 'ping', address }] });
  const openOf = async (name) => {
    for (let i = 0; i < 60; i++) {
      const x = (await call('GET', '/api/admin/incidents')).incidents.find((y) => y.subject === name && y.open);
      if (x) return x;
      await page.waitForTimeout(500);
    }
    return null;
  };

  // --- the link in a message: opened in a new tab (no session needed), the button acknowledges ---
  await add('atlas', '192.0.2.31');
  const inc = await openOf('atlas');
  check(inc, 'an incident opens');
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(ackLink(inc.id));
  check(/Acknowledge this problem\?/.test(await tab.textContent('body')), 'the link asks first');
  await tab.click('button[type=submit]');
  await tab.waitForLoadState();
  const done = await tab.textContent('body');
  check(/Acknowledged/.test(done) && !/Cross-origin/.test(done), `the button acknowledges it (${done.trim().slice(0, 60)})`);

  // --- Home: the Acknowledge item ---
  await add('vault', '192.0.2.32');
  await openOf('vault');
  await page.goto(B + '/');
  const row = page.locator('.need-wrap', { hasText: 'vault' });
  await row.waitFor();
  check(/Acknowledged/.test(await page.locator('.need-wrap', { hasText: 'atlas' }).textContent()), 'Home shows atlas as acknowledged');
  await row.locator('button.snooze').click();
  await row.locator('button[role=menuitem]', { hasText: 'Acknowledge' }).click();
  await page.waitForFunction(() => /Acknowledged by/.test([...document.querySelectorAll('.need-wrap')].find((n) => n.textContent.includes('vault'))?.textContent || ''));
  check((await call('GET', '/api/admin/incidents')).incidents.find((y) => y.subject === 'vault')?.ack?.by === 'admin', 'Acknowledge on Home, by the signed-in user');

  // --- Log → Incidents ---
  await page.goto(B + '/log#incidents');
  await page.waitForSelector('#inc-days .log-entry');
  const list = await page.textContent('#inc-days');
  check(/acknowledged from the alert message/.test(list) && /acknowledged by admin/.test(list) && /Ongoing/.test(list), 'Log → Incidents lists both, with who acknowledged them');
  check(/2\s*open/.test(await page.textContent('#inc-summary')), 'and how many are open');
  await page.click('#log-view button:has-text("Changes")');
  check(await page.isVisible('#log-days') && !(await page.isVisible('#inc-card')), 'Changes goes back to the log');

  await browser.close();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL INCIDENT UI TESTS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
