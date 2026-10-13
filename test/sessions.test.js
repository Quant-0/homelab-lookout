'use strict';
// Sign-in that lasts: sessions saved across restarts (as hashes only), "keep me signed in",
// confirming the password for risky changes (step-up), and signing browsers out.
// Runs with STEP_UP_S=2; test/sessions-restart.test.js continues on the same data after a restart.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const STATE = path.join(os.tmpdir(), 'hd-sessions-test.json');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const c = { cookie: '', csrf: '' };
  c.req = async (method, p, body, extra = {}) => {
    const headers = { ...(c.cookie ? { Cookie: c.cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && c.csrf ? { 'X-CSRF-Token': c.csrf } : {}), ...extra };
    const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc && /hd_session=/.test(sc)) c.cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, json, setCookie: sc, buf };
  };
  c.login = async (extra = {}, password = 'correct horse battery') => {
    const r = await c.req('POST', '/api/login', { username: 'admin', password, ...extra });
    c.csrf = (await c.req('GET', '/api/session')).json?.csrf;
    return r;
  };
  return c;
}

(async () => {
  // --- the two kinds of sign-in ---
  const a = client();
  let r = await a.login({ keep: true });
  ok(r.status === 200 && /Max-Age=2592000/.test(r.setCookie) && /HttpOnly/.test(r.setCookie) && /SameSite=Strict/.test(r.setCookie), 'keep me signed in: a 30-day cookie, HttpOnly, SameSite=Strict');
  const b = client();
  r = await b.login();
  ok(/Max-Age=43200/.test(r.setCookie), 'a normal sign-in: 12 hours');

  // --- saved as hashes only ---
  const file = fs.readFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), 'utf8');
  const tokens = [a.cookie, b.cookie].map((c) => c.split('=')[1]);
  ok(!tokens.some((t) => file.includes(t)) && JSON.parse(file).sessions.length === 2, 'sessions.json has both sessions, but not their tokens');
  ok((fs.statSync(path.join(process.env.DATA_DIR, 'sessions.json')).mode & 0o077) === 0, 'sessions.json is private (0600)');

  // --- the list of signed-in browsers ---
  let list = (await a.req('GET', '/api/admin/sessions')).json.sessions;
  const me = list.find((x) => x.current);
  ok(list.length === 2 && me?.keep === true && list.some((x) => !x.current && x.keep === false), 'Admin lists both, marking this one and which is kept');
  ok(!JSON.stringify(list).includes(a.cookie.split('=')[1]) && list.every((x) => /^[0-9a-f]{16}$/.test(x.id)), 'the list has public ids only');

  // --- step-up: risky changes need the password typed in the last few seconds (STEP_UP_S=2) ---
  r = await a.req('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'x', url: 'https://ntfy.sh', topic: 'homelab-test-x', auth: 'none', tlsMode: 'verify' });
  ok(r.status === 201, 'right after signing in, a risky change goes through');
  await sleep(2500);
  r = await a.req('POST', '/api/admin/backup/download', { passphrase: 'backup passphrase 123' });
  ok(r.status === 403 && r.json?.reauth === true, 'later: downloading a backup asks for the password');
  r = await a.req('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'y', url: 'https://ntfy.sh', topic: 'homelab-test-y', auth: 'none', tlsMode: 'verify' });
  ok(r.status === 403 && r.json?.reauth === true, '…and adding an alert channel');
  const cfg = (await a.req('GET', '/api/admin/config')).json.settings.dashboard;
  r = await a.req('PUT', '/api/admin/settings', { dashboard: { ...cfg, public: true } });
  ok(r.status === 403 && r.json?.reauth === true, '…and making the dashboard public');
  r = await a.req('PUT', '/api/admin/settings', { dashboard: { ...cfg, title: 'Still fine' } });
  ok(r.status === 200, 'everyday changes do not ask');
  r = await a.req('POST', '/api/admin/devices', { name: 'pi', kind: 'other', location: 'outside' });
  ok(r.status === 201, '…adding a device does not either');

  r = await a.req('POST', '/api/reauth', { password: 'wrong' });
  ok(r.status === 403 && r.json?.error === 'Wrong password', 'a wrong password is refused (403, so the page stays)');
  r = await a.req('POST', '/api/reauth', { password: 'correct horse battery' });
  ok(r.status === 200 && r.json.until > Date.now(), 'the right one confirms it');
  r = await a.req('POST', '/api/admin/backup/download', { passphrase: 'backup passphrase 123' });
  ok(r.status === 200 && r.buf.length > 100, 'now the backup downloads');
  r = await a.req('POST', '/api/reauth', { password: 'correct horse battery' }, { 'X-CSRF-Token': 'nope' });
  ok(r.status === 403 && !r.json?.until, 'confirming needs the CSRF token too');
  const nobody = client();
  r = await nobody.req('POST', '/api/reauth', { password: 'correct horse battery' });
  ok(r.status === 401, 'and a session');

  // --- signing out ---
  const bId = list.find((x) => !x.current).id;
  r = await a.req('DELETE', `/api/admin/sessions/${bId}`);
  ok(r.status === 200 && (await b.req('GET', '/api/admin/config')).status === 401, 'signing out another browser ends its session');
  const c2 = client();
  await c2.login();
  const c3 = client();
  await c3.login();
  r = await a.req('DELETE', '/api/admin/sessions');
  ok(r.status === 200 && r.json.count === 2 && (await c2.req('GET', '/api/session')).status === 401 && (await a.req('GET', '/api/session')).status === 200, 'sign out everywhere else keeps this one');
  const log = (await a.req('GET', '/api/admin/events?cat=sign-in')).json.events.map((e) => e.text);
  ok(log.some((t) => /kept signed in for 30 days/.test(t)) && log.some((t) => /Wrong password when confirming/.test(t)) && log.some((t) => /Signed out 2 other browsers/.test(t)), 'it is all in the Log');

  // --- a new password: other sessions end, this one stays (also after the restart, next suite) ---
  const d = client();
  await d.login();
  r = await a.req('POST', '/api/admin/password', { current: 'correct horse battery', password: 'a whole new passphrase 42' });
  ok(r.status === 200 && (await d.req('GET', '/api/session')).status === 401 && (await a.req('GET', '/api/session')).status === 200, 'a new password ends the other sessions, not this one');
  fs.writeFileSync(STATE, JSON.stringify({ cookie: a.cookie }), { mode: 0o600 });

  console.log(failures ? `\n${failures} FAILED` : '\nALL SESSION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
