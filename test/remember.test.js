'use strict';
// "Remember this device for viewing" and the installable app: a remembered device reads the
// dashboard views, Docs and Updates, never changes anything, survives restarts (only a hash is
// stored), and is signed out by log-out, Admin, a new password or its 30 days running out.
// Manifest, service worker, offline screen and icons are public and say nothing about the lab.
// test/run.js calls seed() on the data directory before the server starts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SEED = { ok: 'seeded-valid-token-0123456789abcdefghijklmn', expired: 'seeded-expired-token-0123456789abcdefghij', oldpw: 'seeded-oldpw-token-0123456789abcdefghijklm', other: 'seeded-other-user-0123456789abcdefghijklm' };
function seed(dir) {
  const admin = JSON.parse(fs.readFileSync(path.join(dir, 'admin.json'), 'utf8'));
  const now = Date.now();
  const rec = (token, id, extra) => ({ id, hash: hash(token), user: 'admin', pw: admin.changedAt, name: 'Safari on iPhone', created: now - 86400e3, lastSeen: now - 3600e3, lastIp: '10.0.0.9', expires: now + 86400e3, secure: false, ...extra });
  fs.writeFileSync(path.join(dir, 'remembered.json'), JSON.stringify({ devices: [
    rec(SEED.ok, '00000000000000a1'),
    rec(SEED.expired, '00000000000000a2', { expires: now - 1000 }),
    rec(SEED.oldpw, '00000000000000a3', { pw: admin.changedAt - 1 }),
    rec(SEED.other, '00000000000000a4', { user: 'mallory' }),
  ] }), { mode: 0o600 });
}
module.exports = { seed };

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const DATA = process.env.DATA_DIR;
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

async function call(method, p, { cookie = '', body, csrf, headers = {} } = {}) {
  const r = await fetch(BASE + p, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const cookies = Object.fromEntries(r.headers.getSetCookie().map((c) => [c.split('=')[0], c]));
  return { status: r.status, json, text, buf, headers: r.headers, cookies };
}
const value = (c) => (c ? c.split(';')[0] : '');

// Signs in; returns { session, device } cookie strings ("name=value")
async function login(remember, ua = ANDROID, cookie = '') {
  const r = await call('POST', '/api/login', { body: { username: 'admin', password: PW, remember }, headers: { 'User-Agent': ua }, cookie });
  return { status: r.status, json: r.json, session: value(r.cookies.hd_session), device: value(r.cookies.hd_device), raw: r.cookies.hd_device };
}
let PW = 'correct horse battery';

async function run() {
  // --- seeded devices: only the valid one survives the restart ---
  const seeded = (t) => call('GET', '/api/dashboard', { cookie: `hd_device=${t}` });
  let r = await seeded(SEED.ok);
  ok(r.status === 200 && r.json.viewer === true && r.json.loggedIn === false, 'a device remembered before the restart still reads the dashboard');
  ok((await seeded(SEED.expired)).status === 401, 'expired: refused');
  ok((await seeded(SEED.oldpw)).status === 401, 'remembered under an earlier password: refused');
  ok((await seeded(SEED.other)).status === 401, 'remembered for another user: refused');
  ok((await seeded('made-up-token')).status === 401, 'an unknown token: refused');
  ok((await call('GET', '/api/dashboard')).status === 401, 'without anything: still login required');

  // --- signing in with "remember" ---
  const a = await login(true);
  ok(a.status === 200 && a.json.remembered === true && a.session && a.device, 'sign-in with "remember" sets a session and a device cookie');
  ok(/HttpOnly/.test(a.raw) && /SameSite=Strict/.test(a.raw) && /Max-Age=2592000/.test(a.raw), 'device cookie: HttpOnly, SameSite=Strict, 30 days');
  const token = a.device.split('=')[1];
  const file = fs.readFileSync(path.join(DATA, 'remembered.json'), 'utf8');
  ok(!file.includes(token) && file.includes(hash(token)), 'only a hash of the token is stored');
  ok((fs.statSync(path.join(DATA, 'remembered.json')).mode & 0o777) === 0o600, 'the file is 0600');
  const b = await login(false);
  ok(b.status === 200 && !b.device && b.json.remembered === false, 'without the box: no device cookie');

  // --- what a remembered device may do ---
  const dev = a.device;
  r = await call('GET', '/api/session', { cookie: dev });
  ok(r.status === 200 && r.json.readOnly === true && r.json.csrf, 'session: read-only');
  const vcsrf = r.json.csrf;
  for (const p of ['/', '/services', '/energy', '/docs', '/updates', '/login']) {
    r = await call('GET', p, { cookie: dev });
    ok(r.status === 200, `page ${p}: shown`);
  }
  r = await call('GET', '/admin', { cookie: dev });
  ok(r.status === 303 && /\/login\?next=admin$/.test(r.headers.get('location')), 'Admin asks for the password');
  ok((await call('GET', '/static/js/docs.js', { cookie: dev })).status === 200 && (await call('GET', '/static/js/admin.js', { cookie: dev })).status === 401, 'scripts: docs yes, admin no');
  r = await call('GET', '/api/docs', { cookie: dev });
  ok(r.status === 200 && r.json.readOnly === true, 'docs: readable, marked read-only');
  r = await call('GET', '/api/updates', { cookie: dev });
  ok(r.status === 200 && r.json.readOnly === true, 'updates: readable, marked read-only');
  const refused = [['GET', '/api/admin/config'], ['GET', '/api/admin/remembered'], ['GET', '/api/docs/deleted'], ['PUT', '/api/admin/settings', {}], ['POST', '/api/docs/pages', { title: 'x', body: 'y' }],
    ['POST', '/api/admin/updates/check', {}], ['POST', '/api/admin/password', { current: PW, password: 'another long password' }], ['DELETE', '/api/admin/remembered']];
  for (const [m, p, body] of refused) {
    r = await call(m, p, { cookie: dev, body, csrf: vcsrf });
    ok(r.status === 401 && /password/.test(r.json?.error || ''), `${m} ${p}: refused (“${r.json?.error}”)`);
  }
  r = await call('GET', '/api/dashboard', { cookie: dev });
  ok(r.json.viewer === true && !Object.hasOwn(r.json, 'hash'), 'dashboard data for the device');

  // --- Admin: list and sign out ---
  const full = (await login(false)).session;
  const fcsrf = (await call('GET', '/api/session', { cookie: full })).json.csrf;
  r = await call('GET', '/api/admin/remembered', { cookie: full });
  const mine = r.json.devices.find((d) => d.name === 'Chrome on Android');
  ok(r.status === 200 && r.json.devices.length === 2 && mine && mine.lastIp && mine.expires > Date.now() + 29 * 86400e3, `listed: ${r.json.devices.map((d) => d.name).join(', ')}`);
  ok(!r.text.includes(hash(token)) && !r.text.includes('"hash"'), 'the list never shows hashes');
  r = await call('GET', '/api/admin/remembered', { cookie: `${full}; ${dev}` });
  ok(r.json.devices.find((d) => d.id === mine.id).current === true, 'the list marks this device');
  r = await call('DELETE', `/api/admin/remembered/${mine.id}`, { cookie: full, csrf: fcsrf });
  ok(r.status === 200 && (await call('GET', '/api/dashboard', { cookie: dev })).status === 401, 'signed out from Admin: the device must sign in again');
  ok((await call('DELETE', '/api/admin/remembered/ffffffffffffffff', { cookie: full, csrf: fcsrf })).status === 404, 'unknown device: 404');

  // --- log out forgets the device: from the device itself, and from a full session on it ---
  let c = await login(true);
  const ccsrf = (await call('GET', '/api/session', { cookie: c.device })).json.csrf;
  ok((await call('POST', '/api/logout', { cookie: c.device, body: {} })).status === 403, 'log out needs the CSRF token');
  r = await call('POST', '/api/logout', { cookie: c.device, body: {}, csrf: ccsrf });
  ok(r.status === 200 && /Max-Age=0/.test(r.cookies.hd_device || '') && (await call('GET', '/api/dashboard', { cookie: c.device })).status === 401, 'log out on the device forgets it');
  c = await login(true);
  const both = `${c.session}; ${c.device}`;
  const bcsrf = (await call('GET', '/api/session', { cookie: both })).json.csrf;
  await call('POST', '/api/logout', { cookie: both, body: {}, csrf: bcsrf });
  ok((await call('GET', '/api/dashboard', { cookie: c.device })).status === 401 && (await call('GET', '/api/session', { cookie: c.session })).status === 401, 'log out of a full session also forgets the device');

  // signing in again on a remembered device keeps it (no second entry)
  c = await login(true);
  const again = await login(true, ANDROID, c.device);
  ok(again.json.remembered === true && !again.device, 'already remembered: kept, no new token');

  // --- a new password signs out every other device, keeps this one ---
  const other = await login(true, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  const here = `${c.session}; ${c.device}`;
  const hcsrf = (await call('GET', '/api/session', { cookie: here })).json.csrf;
  r = await call('POST', '/api/admin/password', { cookie: here, csrf: hcsrf, body: { current: PW, password: 'a brand new passphrase' } });
  PW = 'a brand new passphrase';
  ok(r.status === 200, 'password changed');
  ok((await call('GET', '/api/dashboard', { cookie: c.device })).status === 200, 'this device stays remembered');
  ok((await call('GET', '/api/dashboard', { cookie: other.device })).status === 401 && (await call('GET', '/api/dashboard', { cookie: `hd_device=${SEED.ok}` })).status === 401, 'every other device is signed out');
  const admin = JSON.parse(fs.readFileSync(path.join(DATA, 'admin.json'), 'utf8'));
  const kept = JSON.parse(fs.readFileSync(path.join(DATA, 'remembered.json'), 'utf8')).devices;
  ok(kept.length === 1 && kept[0].pw === admin.changedAt, 'the kept device belongs to the new password (so it survives a restart)');

  // at most 20 per account; the least recently used go first
  let newest = null;
  for (let i = 0; i < 21; i++) newest = await login(true);
  r = await call('GET', '/api/admin/remembered', { cookie: c.session });
  ok(r.json.devices.length === 20 && (await call('GET', '/api/dashboard', { cookie: c.device })).status === 401, `at most 20 remembered devices (${r.json.devices.length}); the oldest went`);

  // --- the installable app ---
  const scsrf = (await call('GET', '/api/session', { cookie: c.session })).json.csrf;
  const dash = (await call('GET', '/api/admin/config', { cookie: c.session })).json.settings.dashboard;
  await call('PUT', '/api/admin/settings', { cookie: c.session, csrf: scsrf, body: { dashboard: { ...dash, title: 'Ola sin lab' } } });
  r = await call('GET', '/manifest.webmanifest');
  ok(r.status === 200 && /^application\/manifest\+json/.test(r.headers.get('content-type')) && r.json.name === 'Homelab' && r.json.start_url === '/' && r.json.display === 'standalone', 'manifest: public, and without a login it says only "Homelab"');
  ok(r.json.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') && r.json.icons.some((i) => i.sizes === '192x192'), 'manifest icons: 192, 512 and maskable');
  r = await call('GET', '/manifest.webmanifest', { cookie: newest.device });
  ok(r.json.name === 'Ola sin lab' && r.json.short_name === 'Ola sin lab', 'signed in (or remembered): the dashboard title');
  for (const icon of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png']) {
    r = await call('GET', `/static/icons/${icon}`);
    ok(r.status === 200 && r.headers.get('content-type') === 'image/png' && r.buf.subarray(1, 4).toString() === 'PNG', `${icon}: public PNG`);
  }
  r = await call('GET', '/sw.js');
  ok(r.status === 200 && /javascript/.test(r.headers.get('content-type')) && r.text.includes("'/offline'") && !/api\//.test(r.text.replace(/\/\/.*$/gm, '')), 'service worker: public, never touches the API');
  r = await call('GET', '/offline');
  ok(r.status === 200 && r.text.includes("Can't reach the dashboard") && !r.text.includes('Ola sin lab'), 'offline screen: public, no data');
  ok((await call('GET', '/static/js/offline.js')).status === 200, 'offline script: public');
  const csp = r.headers.get('content-security-policy');
  ok(/manifest-src 'self'/.test(csp) && /worker-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp), 'CSP allows our own manifest and worker, still no inline scripts');
  r = await call('GET', '/login');
  ok(r.text.includes('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">') && /<meta name="theme-color"/.test(r.text) && r.text.includes('apple-touch-icon'), 'pages link the manifest, theme colour and iPhone icon');
  ok((await call('GET', '/api/dashboard')).status === 401, 'and the dashboard itself is still private');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL REMEMBER/APP TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) run();
