'use strict';
// Homelab Lookout's own update in a browser: the row on the Updates page (logo, versions, how to
// update, what's new), and the version and the on/off switch in Admin → Server.
const fs = require('node:fs');
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
(async () => {
  fs.writeFileSync(process.env.LOOKOUT_VERSION_FILE, `${'a'.repeat(40)}\n2026-10-01T10:00:00Z\n1.1.0\n`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');

  await page.goto(B + '/updates');
  await page.click('#upd-check');
  const row = page.locator('.upd-row', { hasText: 'Homelab Lookout' });
  await row.waitFor();
  const text = await row.textContent();
  check(/1\.1\.0 \(aaaaaaa\)\s*→\s*v1\.2\.0/.test(text), `the row shows 1.1.0 → v1.2.0 (${text.replace(/\s+/g, ' ').slice(0, 80)})`);
  check(/3 changes since this version/.test(text) && /git pull/.test(text), 'with the number of changes and how to update');
  check(await row.locator('img[src="/logo"]').count() === 1, 'and the dashboard\'s logo');
  check(await page.locator('.upd-section', { hasText: 'Can be updated' }).locator('.upd-row', { hasText: 'Homelab Lookout' }).count() === 1, 'under "Can be updated"');
  await row.locator('summary', { hasText: "What's new in v1.2.0" }).click();
  check(/Metrics for Prometheus/.test(await row.locator('.upd-notes-text').textContent()), "What's new opens the release notes");
  await row.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/lookout-update-row.png` });

  await page.goto(B + '/admin#system');
  await page.reload();
  const rt = page.locator('#runtime');
  await rt.locator('text=1.1.0 · aaaaaaa').waitFor();
  check(true, 'Admin → Server shows the version');
  const box = rt.locator('input[type=checkbox]');
  check(await box.isChecked(), 'the update check is on');
  await box.uncheck();
  await rt.locator('#runtime-msg', { hasText: 'GitHub is not asked' }).waitFor();
  const saved = await page.evaluate(async () => (await (await fetch('/api/admin/config')).json()).settings.dashboard.lookoutUpdates);
  check(saved === false, 'switching it off is saved');
  await page.goto(B + '/updates');
  await page.waitForTimeout(1500);
  check(await page.locator('.upd-row', { hasText: 'Homelab Lookout' }).count() === 0, 'and the row is gone');

  await browser.close();
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
