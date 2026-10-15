'use strict';
// The first admin account on the setup page, with the one-time code from the server's log. Runs on
// a server without an admin (test/run.js: noAdmin), which logs the code (SERVER_LOG).
const fs = require('node:fs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
async function req(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, location: r.headers.get('location') };
}
const PW = 'correct horse battery';

(async () => {
  const log = fs.readFileSync(process.env.SERVER_LOG, 'utf8');
  const code = (/setup code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(log) || [])[1];
  ok(code && /No admin account yet\. Open http:\/\/127\.0\.0\.1:18080\/setup/.test(log) && /node server\.js set-admin/.test(log), 'the log has the setup address, the code and the command-line way');

  let r = await req('GET', '/login');
  ok(r.status === 303 && r.location === '/setup', 'sign-in sends to the setup page');
  r = await req('GET', '/');
  ok(r.status === 303, 'and so does Home (through sign-in)');
  r = await req('GET', '/setup');
  ok(r.status === 200 && /Create the admin account/.test(r.text) && /journalctl -u homelab-dashboard/.test(r.text), 'the setup page says where the code is');
  r = await req('GET', '/static/js/setup.js');
  ok(r.status === 200, 'its script is public');
  r = await req('POST', '/api/setup', { code, username: 'admin', password: PW, password2: PW }, { Origin: 'http://evil.test' });
  ok(r.status === 403, 'from another site: refused');

  r = await req('POST', '/api/setup', { code: 'XXXXX-XXXXX', username: 'admin', password: PW, password2: PW });
  ok(r.status === 401 && /journalctl/.test(r.json.error), 'a wrong code is refused');
  r = await req('POST', '/api/setup', { code, username: 'ad min', password: PW, password2: PW });
  ok(r.status === 400 && /letters, digits/.test(r.json.error), 'a bad user name');
  r = await req('POST', '/api/setup', { code, username: 'admin', password: PW, password2: `${PW}x` });
  ok(r.status === 400 && /do not match/.test(r.json.error), 'passwords that differ');
  r = await req('POST', '/api/setup', { code: ` ${code.toLowerCase().replace('-', '')} `, username: 'admin', password: PW, password2: PW });
  ok(r.status === 200 && cookie, 'the code (any case, without the dash) makes the admin and signs in');
  r = await req('GET', '/api/admin/config');
  ok(r.status === 200 && r.json.user === 'admin' && r.json.runtime.install === 'service', 'signed in as the new admin (not in Docker)');
  const events = (await req('GET', '/api/admin/events')).json.events.map((e) => e.text);
  ok(events.some((t) => /^Admin account "admin" made on the setup page from 127\.0\.0\.1$/.test(t)) && events.some((t) => /^Wrong setup code from/.test(t)), 'the setup and the wrong code are in the Log');

  // gone once the admin exists, even with the right code
  const other = cookie;
  cookie = '';
  r = await req('POST', '/api/setup', { code, username: 'evil', password: PW, password2: PW });
  ok(r.status === 404, 'no second setup with the old code');
  r = await req('GET', '/setup');
  ok(r.status === 303 && r.location === '/login', '/setup sends to sign-in');
  r = await req('POST', '/api/login', { username: 'admin', password: PW });
  ok(r.status === 200, 'the admin signs in with the password');
  r = await req('POST', '/api/login', { username: 'evil', password: PW });
  ok(r.status === 401, 'nobody else');
  cookie = other;

  // wrong codes count towards the lockout like wrong passwords
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
