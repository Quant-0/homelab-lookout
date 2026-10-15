'use strict';
// Log → History in a browser: the changes made in Admin, undoing one (and the question when it was
// changed again since), going back to a point, and the layout on a phone.
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
  const call = (method, p, body) => page.evaluate(async ([method, p, body]) => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, [method, p, body]);
  const devices = async () => (await call('GET', '/api/admin/config')).devices.map((d) => d.name);

  const atlas = (await call('POST', '/api/admin/devices', { name: 'atlas', kind: 'server', location: 'outside', connections: [{ type: 'ping', address: '192.0.2.41' }] })).device;
  await call('PUT', `/api/admin/devices/${atlas.id}`, { name: 'atlas-2', kind: 'server', location: 'outside' });
  await call('DELETE', `/api/admin/devices/${atlas.id}`);

  await page.goto(B + '/log#history');
  const entry = (text) => page.locator('.log-entry.ver', { hasText: text }).first();
  await entry('Device removed').waitFor();
  check(await page.locator('#log-view button[aria-pressed=true]').textContent() === 'History', 'the History view opens from its link');
  check((await page.textContent('.page-title')) === 'Configuration history', 'with its own title');
  check(await page.locator('.log-filters').isHidden(), 'the log filters are hidden here');
  check(/Device atlas-2\s+changed: Name: atlas → atlas-2/.test(await entry('Device updated').textContent()), 'a change shows before → after');
  check(await entry('Device removed').locator('button', { hasText: 'Go back to here' }).count() === 0, 'the newest version has no "go back to here"');

  // undo the deletion: one question, then the device is back
  page.once('dialog', (d) => d.accept());
  await entry('Device removed').locator('button', { hasText: 'Undo' }).click();
  await page.locator('#ver-msg .msg.ok').waitFor();
  check((await devices()).includes('atlas-2'), 'Undo brings the device back');
  await entry('Undid a change').waitFor();
  check(await entry('Undid a change').locator('.log-cat .icon').count() === 1, 'the undo is listed as a version of its own');

  // the rename, after it was renamed again: a second question names what changed since
  await call('PUT', `/api/admin/devices/${atlas.id}`, { name: 'atlas-3', kind: 'server', location: 'outside' });
  await page.reload();
  await entry('Device updated: atlas-2').waitFor();
  const asked = [];
  const answer = (d) => {
    asked.push(d.message());
    asked.length === 1 ? d.accept() : d.dismiss();
  };
  page.on('dialog', answer);
  await entry('Device updated: atlas-2').locator('button', { hasText: 'Undo' }).click();
  await page.waitForTimeout(800);
  page.off('dialog', answer);
  check(asked.length === 2 && /Device atlas-3.* changed again since/.test(asked[1]) && /Device updated: atlas-3/.test(asked[1]), `it asks again, naming the later change (${(asked[1] || '').split('\n')[0]})`);
  check((await devices()).includes('atlas-3'), 'saying no changes nothing');

  // go back to right after the device was added
  page.once('dialog', (d) => d.accept());
  await entry('Device added: atlas').locator('button', { hasText: 'Go back to here' }).click();
  await page.locator('#ver-msg .msg.ok', { hasText: 'back as it was' }).waitFor();
  check((await devices()).includes('atlas'), 'Go back to here puts the name from then back');
  check(/Configuration restored/.test(await page.locator('.log-entry.ver').first().textContent()), 'and is listed at the top');

  // on a phone: nothing wider than the screen
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await page.locator('.log-entry.ver').first().waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!wide, 'fits a phone screen');
  const box = await page.locator('.log-entry.ver').first().locator('.ver-actions button').first().boundingBox();
  check(box && box.x + box.width <= 390, 'the buttons stay on screen');
  await page.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/config-history-phone.png` });

  await browser.close();
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
