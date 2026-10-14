'use strict';
// Behind a reverse proxy: X-Forwarded-For / -Proto are believed only from a proxy that is listed,
// so the visitor's own address drives the sign-in lockout and the log, and nobody can fake one.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, headers = {}, keepCookie = true) {
  const h = { ...(cookie && keepCookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf && keepCookie ? { 'X-CSRF-Token': csrf } : {}), ...headers };
  const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && keepCookie) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, setCookie: sc };
}
const login = (pw, ip, extra = {}) => req('POST', '/api/login', { username: 'admin', password: pw }, { 'X-Forwarded-For': ip, ...extra }, false);

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // no proxy listed: the headers are ignored, and the page says so
  let a = (await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': '203.0.113.5', 'X-Forwarded-Proto': 'https' })).json;
  ok(a.clientIp === '127.0.0.1' && !a.viaProxy && !a.https && /not listed as a reverse proxy/.test(a.warnings.join()), 'an unlisted proxy is not believed, and the check says so');
  ok(a.target.host && (a.target.http || a.target.https), 'the instructions know where to point the proxy');

  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  let r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, trustedProxies: 'nonsense' } });
  ok(r.status === 400, 'not an address: refused');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, trustedProxies: '10.0.0.0/8' } });
  ok(r.status === 400 && /16/.test(r.json.error), 'a range wider than /16: refused');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, trustedProxies: '127.0.0.1, 10.9.0.0/24' } });
  ok(r.status === 200 && r.json.settings.dashboard.trustedProxies.join() === '127.0.0.1,10.9.0.0/24', 'proxies are saved');

  // listed: the visitor's address and https come through (a session made over http is not valid over https)
  a = await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': '203.0.113.5', 'X-Forwarded-Proto': 'https' });
  ok(a.status === 401, 'a session made over plain http does not carry over to https through the proxy');
  const https = { 'X-Forwarded-For': '203.0.113.5', 'X-Forwarded-Proto': 'https' };
  const sc = (await login('correct horse battery', '203.0.113.5', { 'X-Forwarded-Proto': 'https' })).setCookie.split(';')[0];
  const csrf2 = (await (await fetch(BASE + '/api/session', { headers: { Cookie: sc, ...https } })).json()).csrf;
  a = await (await fetch(BASE + '/api/admin/access', { headers: { Cookie: sc, ...https } })).json();
  ok(a.clientIp === '203.0.113.5' && a.viaProxy && a.https && !a.warnings.length && csrf2, `signed in through the proxy: the visitor is seen (${a.clientIp}), over https`);
  a = (await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': '198.51.100.1, 10.9.0.4' })).json;
  ok(a.clientIp === '198.51.100.1', 'a chain of listed proxies is walked back to the visitor');
  a = (await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': '1.1.1.1, 198.51.100.7' })).json;
  ok(a.clientIp === '198.51.100.7', 'an address the visitor added in front is ignored (only the proxy\'s own entry counts)');
  a = (await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': 'garbage' })).json;
  ok(a.clientIp === '127.0.0.1', 'nonsense in the header: the proxy\'s own address');
  a = (await req('GET', '/api/admin/access')).json;
  ok(/sends no X-Forwarded-For/.test(a.warnings.join()), 'a listed proxy that sends no header is pointed out');
  r = await login('correct horse battery', '203.0.113.9', { 'X-Forwarded-Proto': 'https' });
  ok(r.status === 200 && /__Host-hd_session=.*Secure/.test(r.setCookie || ''), 'https through the proxy: the sign-in cookie is secure');

  // the lockout is per visitor, not per proxy
  for (let i = 0; i < 5; i++) await login('wrong password!', '198.51.100.20');
  r = await login('correct horse battery', '198.51.100.20');
  ok(r.status === 429, 'five wrong passwords lock that visitor out');
  r = await login('correct horse battery', '198.51.100.21');
  ok(r.status === 200, 'another visitor behind the same proxy can still sign in');
  const log = (await req('GET', '/api/admin/events')).json.events || [];
  ok(log.some((e) => /Failed sign-in from 198\.51\.100\.20/.test(e.text)), 'the log has the visitor\'s address');

  // no longer listed: back to ignoring the header
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, trustedProxies: [] } });
  a = (await req('GET', '/api/admin/access', undefined, { 'X-Forwarded-For': '203.0.113.5' })).json;
  ok(a.clientIp === '127.0.0.1', 'removed: the header is ignored again');

  console.log(failures ? `\n${failures} FAILED` : '\nALL PROXY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
