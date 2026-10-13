'use strict';
// Hardening: a backup file is checked like Admin input when restored, and what answers without a
// sign-in is limited per address. Runs with OPEN_LIMIT_PER_MIN=8.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const PASS = 'backup passphrase 123';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { raw, anon, headers: extra = {} } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, buf, headers: r.headers };
}
// the backup format: magic (8), salt (16), IV (12), tag (16), then gzip'ed JSON under AES-256-GCM
const keyOf = (salt) => crypto.scryptSync(PASS, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(buf.subarray(8, 24)), buf.subarray(24, 36));
  d.setAAD(buf.subarray(0, 8));
  d.setAuthTag(buf.subarray(36, 52));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(52)), d.final()])));
}
function encrypt(bundle, magic) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(salt), iv);
  c.setAAD(magic);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(bundle)))), c.final()]);
  return Buffer.concat([magic, salt, iv, c.getAuthTag(), body]);
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- a backup file someone tampered with ---
  const dev = (await req('POST', '/api/admin/devices', { name: 'pi', kind: 'other', location: 'outside', connections: [{ type: 'ping', address: '127.0.0.1' }] })).json.device;
  await req('POST', '/api/admin/backup/destinations', { type: 'folder', name: 'NAS', folder: 'lookout' });
  const file = (await req('POST', '/api/admin/backup/download', { passphrase: PASS })).buf;
  const bundle = decrypt(file);
  const U = () => crypto.randomUUID();
  bundle.config.backup.destinations.push(
    { id: U(), type: 'rsync', name: 'evil', host: 'nas', port: 22, user: '--rsh=touch /tmp/pwned', path: '/x' },
    { id: U(), type: 'rsync', name: 'evil2', host: '-oProxyCommand=id', port: 22, user: 'backup', path: '/x' },
    { id: U(), type: 'folder', name: 'escape', folder: '../../../etc' },
    { id: U(), type: 'rsync', name: 'evil3', host: 'nas', port: '22 -oProxyCommand=id', user: 'backup', path: '/x' },
  );
  bundle.config.hosts.push(
    { id: U(), type: 'ping', name: 'x', address: '-c 99999 127.0.0.1', deviceId: dev.id },
    { id: U(), type: 'idrac', name: 'y', address: 'evil host with spaces', username: 'root', tlsMode: 'verify', deviceId: dev.id },
  );
  const r = await req('POST', '/api/admin/backup/restore', undefined, { raw: encrypt(bundle, file.subarray(0, 8)), headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(PASS) } });
  ok(r.status === 200, `the tampered backup restores (${r.json?.error || ''})`);
  const dests = (await req('GET', '/api/admin/backup')).json?.destinations || [];
  ok(dests.length === 1 && dests[0].name === 'NAS' && dests[0].folder === 'lookout', `only the valid backup destination comes back (${dests.map((x) => x.name).join(', ')})`);
  const hosts = (await req('GET', '/api/admin/config')).json.hosts;
  ok(hosts.length === 1 && hosts[0].address === '127.0.0.1', `only the valid connection comes back (${hosts.map((h) => h.address).join(', ')})`);

  // --- what answers without a sign-in is limited per address ---
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, statusPage: { enabled: true, title: '' } } });
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await req('GET', '/api/status', undefined, { anon: true })).status);
  ok(codes.slice(0, 8).every((c) => c === 200) && codes.slice(8).every((c) => c === 429), `the status page: 8 a minute, then 429 (${codes.join(' ')})`);
  const lim = await req('GET', '/ping/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', undefined, { anon: true });
  ok(lim.status === 429 && Number(lim.headers.get('retry-after')) > 0, 'check-ins share the limit, with Retry-After');
  ok((await req('GET', '/api/dashboard')).status === 200, 'the signed-in app is not limited');

  console.log(failures ? `\n${failures} FAILED` : '\nALL HARDENING TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
