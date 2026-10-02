'use strict';
// End-to-end checks against a running server (127.0.0.1:18080) and the mock (127.0.0.1:18443).
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const DATA = process.env.DATA_DIR;
const FP = process.env.MOCK_FP;
const SECRETS = ['calvin', '11111111-2222-3333-4444-555555555555', '1-abcdefKEY'];
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

let cookie = '';
let csrf = '';
async function req(method, p, body, extra = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const mockStats = () => new Promise((res) => https.get({ host: '127.0.0.1', port: 18443, path: '/__stats', rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noSecrets = (text, where) => ok(!SECRETS.some((s) => text.includes(s)), `no secret in ${where}`);

(async () => {
  // Unauthenticated access
  let r = await req('GET', '/');
  ok(r.status === 303 && r.headers.get('location') === '/login', 'dashboard redirects to login');
  ok((r.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'CSP header present');
  r = await req('GET', '/admin'); ok(r.status === 303, 'admin redirects to login');
  r = await req('GET', '/api/dashboard'); ok(r.status === 401, 'dashboard API needs login');
  r = await req('GET', '/api/admin/config'); ok(r.status === 401, 'admin API needs login');
  r = await req('GET', '/static/js/admin.js'); ok(r.status === 401, 'admin.js not served unauthenticated');
  r = await req('GET', '/static/js/login.js'); ok(r.status === 200, 'login.js public');
  const base = new URL(BASE);
  const st = await new Promise((res) => require('node:http').get({ host: base.hostname, port: base.port, path: '/', headers: { Host: `evil.example:${base.port}` } }, (x) => { x.resume(); res(x.statusCode); }));
  ok(st === 421, 'foreign Host header rejected (DNS rebinding)');
  r = await req('GET', '/static/../server.js'); ok(r.status === 404 || r.status === 303, 'path traversal not served');

  // Login + rate limit
  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong-password-1' }, { Origin: 'http://evil.example' });
  ok(r.status === 403, 'cross-origin login blocked');
  r = await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  ok(r.status === 200, 'login works');
  const setCookie = r.headers.get('set-cookie') || '';
  ok(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), 'session cookie HttpOnly + SameSite=Strict');
  r = await req('GET', '/api/session'); csrf = r.json.csrf; ok(Boolean(csrf), 'got CSRF token');

  // CSRF
  const saved = csrf; csrf = '';
  r = await req('PUT', '/api/admin/settings', {}); ok(r.status === 403, 'write without CSRF token rejected');
  csrf = 'x'.repeat(saved.length);
  r = await req('PUT', '/api/admin/settings', {}); ok(r.status === 403, 'write with wrong CSRF token rejected');
  csrf = saved;
  r = await req('POST', '/api/admin/hosts', { type: 'idrac' }, { 'Sec-Fetch-Site': 'cross-site' }); ok(r.status === 403, 'Sec-Fetch-Site cross-site rejected');

  // Fingerprint fetch (sends nothing)
  let before = (await mockStats()).requests;
  r = await req('POST', '/api/admin/fingerprint', { type: 'idrac', address: '127.0.0.1:18443' });
  ok(r.status === 200 && r.json.fingerprint === FP, `fingerprint endpoint returns ${r.json && r.json.fingerprint}`);
  ok(r.json.caTrusted === false, 'self-signed reported as not CA trusted');
  ok((await mockStats()).requests === before + 1, 'fingerprint fetch sent no HTTP request (only __stats counted)');

  // Add hosts
  r = await req('POST', '/api/admin/hosts', { type: 'idrac', name: 'R730', address: 'https://127.0.0.1:18443/', username: 'root', secret: 'calvin', tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 201 && r.json.host.hasSecret === true && !('secret' in r.json.host), 'iDRAC added, secret not echoed');
  const idrac = r.json.host;
  noSecrets(r.text, 'add-host response');
  r = await req('POST', '/api/admin/hosts', { type: 'proxmox', name: 'PVE', address: '127.0.0.1:18443', username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 201, 'Proxmox added');
  r = await req('POST', '/api/admin/hosts', { type: 'truenas', name: 'NAS', address: '127.0.0.1:18443', username: 'truenas_admin', secret: '1-abcdefKEY', tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 201, 'TrueNAS added');
  const nas = r.json.host;
  r = await req('POST', '/api/admin/hosts', { type: 'idrac', name: 'Bad', address: '127.0.0.1:18443', username: 'root', secret: 'calvin', tlsMode: 'verify' });
  const verifyHost = r.json.host;
  r = await req('POST', '/api/admin/hosts', { type: 'proxmox', name: 'x', address: '127.0.0.1', username: 'root', secret: 'y' });
  ok(r.status === 400 && /token ID/.test(r.json.error), 'invalid proxmox token id rejected');
  r = await req('POST', '/api/admin/hosts', { type: 'idrac', name: 'x', address: '127.0.0.1/evil', username: 'root' });
  ok(r.status === 400, 'address with path rejected');

  // Test buttons
  r = await req('POST', `/api/admin/hosts/${idrac.id}/test`, {}); ok(r.json.ok === true, `iDRAC test ${r.json.error || ''}`);
  r = await req('POST', `/api/admin/hosts/${nas.id}/test`, {}); ok(r.json.ok === true, `TrueNAS test ${r.json.error || ''}`);
  before = (await mockStats()).requests;
  r = await req('POST', `/api/admin/hosts/${verifyHost.id}/test`, {});
  ok(r.json.ok === false && /Self-signed/i.test(r.json.error), `CA verify mode fails on self-signed: ${r.json.error}`);
  ok((await mockStats()).requests === before + 1, 'nothing sent when CA verification fails');

  // Wrong pin: nothing sent
  const wrongFp = 'AA:' + FP.slice(3);
  r = await req('PUT', `/api/admin/hosts/${verifyHost.id}`, { name: 'Bad', address: '127.0.0.1:18443', username: 'root', secret: 'calvin', tlsMode: 'pin', fingerprint: wrongFp });
  before = (await mockStats());
  r = await req('POST', `/api/admin/hosts/${verifyHost.id}/test`, {});
  const after = await mockStats();
  ok(r.json.ok === false && /fingerprint mismatch/i.test(r.json.error), `pin mismatch detected: ${r.json.error}`);
  ok(after.requests === before.requests + 1 && after.seenAuth.length === before.seenAuth.length, 'no request/credentials sent on pin mismatch');

  await sleep(1500);
  r = await req('GET', '/api/dashboard');
  ok(r.status === 200, 'dashboard data');
  noSecrets(r.text, 'dashboard API');
  ok(!r.text.includes('127.0.0.1:18443') && !r.text.includes('root@pam'), 'dashboard API exposes no addresses/usernames');
  const d = r.json;
  const i0 = d.idrac.find((h) => h.name === 'R730');
  ok(i0 && i0.ok && i0.data.watts > 200 && i0.data.fans.length === 6 && i0.data.temps.length === 3, 'iDRAC data collected');
  const p0 = d.proxmox[0];
  ok(p0 && p0.ok && p0.data.nodes.length === 2 && p0.data.guests.length === 3, 'Proxmox data collected (template filtered)');
  const t0 = d.truenas[0];
  ok(t0 && t0.ok && t0.data.pools.length === 2 && t0.data.alerts.length === 2 && t0.data.alerts.some((a) => a.text.length === 1000), `TrueNAS data collected ${t0 && t0.error ? t0.error : ''}`);

  r = await req('GET', '/api/admin/config');
  noSecrets(r.text, 'admin config API');
  ok(r.json.hosts.every((h) => !('secret' in h)), 'admin config has no secret field');

  // Editing identity without secret deletes it
  r = await req('PUT', `/api/admin/hosts/${idrac.id}`, { name: 'R730', address: '127.0.0.2:18443', username: 'root', tlsMode: 'pin', fingerprint: FP });
  ok(r.json.host.hasSecret === false && /deleted/.test(r.json.note), 'address change without secret deletes stored secret');
  r = await req('PUT', `/api/admin/hosts/${nas.id}`, { name: 'NAS renamed', address: '127.0.0.1:18443', username: 'truenas_admin', tlsMode: 'pin', fingerprint: FP });
  ok(r.json.host.hasSecret === true, 'rename keeps secret');

  // Static files / HTML contain no secrets
  for (const p of ['/', '/admin', '/static/js/admin.js', '/static/js/dashboard.js', '/static/js/common.js']) noSecrets((await req('GET', p)).text, p);

  // At rest
  const cfg = fs.readFileSync(path.join(DATA, 'config.json'), 'utf8');
  noSecrets(cfg, 'config.json on disk');
  ok(/"secret": "v1\./.test(cfg), 'secrets stored as AES-GCM ciphertext');
  const mode = (f) => (fs.statSync(path.join(DATA, f)).mode & 0o777).toString(8);
  ok(mode('.') === '700' && mode('config.json') === '600' && mode('secret.key') === '600' && mode('admin.json') === '600', `permissions dir=${mode('.')} config=${mode('config.json')} key=${mode('secret.key')}`);

  // Settings validation
  r = await req('GET', '/api/admin/config');
  const s = r.json.settings;
  s.power.grid.dayOre = 45.5; s.power.grid.nightOre = 35.5;
  r = await req('PUT', '/api/admin/settings', s); ok(r.status === 200, 'settings saved');
  s.dashboard.refreshSeconds = 1;
  r = await req('PUT', '/api/admin/settings', s); ok(r.status === 400, 'refresh < 10 s rejected');

  // Logout invalidates session
  r = await req('POST', '/api/logout', {}); ok(r.status === 200, 'logout');
  r = await req('GET', '/api/admin/config'); ok(r.status === 401, 'session gone after logout');

  // Rate limiting
  let last;
  for (let i = 0; i < 6; i++) last = await req('POST', '/api/login', { username: 'admin', password: 'bad' + i });
  ok(last.status === 429, `login rate limited after repeated failures (got ${last.status})`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
