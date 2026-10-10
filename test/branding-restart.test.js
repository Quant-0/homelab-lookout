'use strict';
// After a restart (every update restarts the server) the uploaded logos are still the ones in use.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

(async () => {
  let cookie = '';
  const r0 = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
  const cfg = await (await fetch(`${BASE}/api/admin/config`, { headers: { Cookie: cookie } })).json();
  const { logo } = cfg.settings.appearance;
  const { carrierLogo } = cfg.settings.dashboard;
  ok(logo.kind === 'file' && /^[0-9a-f]{32}$/.test(logo.id || ''), `the uploaded logo is still chosen after a restart (${JSON.stringify(logo)})`);
  ok(carrierLogo.kind === 'file' && carrierLogo.id === logo.id, `and the provider logo (${JSON.stringify(carrierLogo)})`);
  const r = await fetch(`${BASE}/logo`);
  ok(r.headers.get('content-type') === 'image/png', `/logo serves the uploaded image, not the default (${r.headers.get('content-type')})`);
  const d = await (await fetch(`${BASE}/api/dashboard`, { headers: { Cookie: cookie } })).json();
  ok(d.carrierLogo === `/media/icon/${logo.id}`, 'Home gets the uploaded provider logo');
  console.log(failures ? `\n${failures} FAILED` : '\nALL RESTART TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
