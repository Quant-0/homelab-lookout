'use strict';
// Every page and Admin tab, on a fresh install with nothing set up: no text on screen may be a
// stray "null", "undefined", "NaN" or "[object Object]" (Element.replaceChildren writes a null
// out as text, unlike the pages' own el() helper).
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://127.0.0.1:18080';
const problems = [];
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };
const PAGES = ['/', '/#rack', '/services', '/vms', '/energy', '/report', '/log', '/log#incidents', '/log#history', '/updates', '/docs', '/wall',
  ...['devices', 'services', 'alerts', 'schedules', 'dashboard', 'look', 'power', 'backups', 'security', 'system'].map((t) => `/admin#${t}`)];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(B + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL(B + '/');
  for (const p of PAGES) {
    await page.goto(B + p);
    if (p.includes('#')) await page.reload(); // a hash-only change doesn't load the page
    await page.waitForTimeout(1500);
    const bad = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent.trim();
        const el = n.parentElement;
        if (!el || el.closest('script, style, [hidden], code, pre') || !el.getClientRects().length) continue;
        if (/^(null|undefined|NaN|\[object Object\])$/.test(t) || /\b(undefined|NaN)\b/.test(t)) out.push(`${el.tagName.toLowerCase()}.${el.className}: "${t.slice(0, 60)}"`);
      }
      return out;
    });
    check(!bad.length, `${p}: no stray null/undefined/NaN${bad.length ? ` (${bad.slice(0, 3).join('; ')})` : ''}`);
  }
  await browser.close();
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
