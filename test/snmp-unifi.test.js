'use strict';
// Synology (real net-snmp agent), UniFi (mock console), rack and power tests.
const https = require('node:https');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const SECRETS = ['authpass123', 'privpass123', 'unifipass', 'SECRETJWT'];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const stats = () => new Promise((res) => https.get({ host: '127.0.0.1', port: 18443, path: '/__stats', rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }));
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- Synology over SNMPv3 ---
  let r = await req('POST', '/api/admin/fingerprint', { type: 'synology', address: '127.0.0.1:16161' });
  ok(r.status === 200 && /^([0-9A-F]{2}:){4,}/.test(r.json.engineId), `engine ID discovery: ${r.json.engineId}`);
  const engineId = r.json.engineId;
  const syn = { type: 'synology', name: 'DS418', address: '127.0.0.1:16161', username: 'dashuser', fingerprint: engineId, options: { snmpAuth: 'sha' } };
  r = await req('POST', '/api/admin/hosts', { ...syn, secret: 'authpass123' });
  ok(r.status === 400 && /both/.test(r.json.error), 'only one SNMP password rejected');
  r = await req('POST', '/api/admin/hosts', { ...syn, secret: 'short', secret2: 'short2' });
  ok(r.status === 400 && /8 characters/.test(r.json.error), 'short SNMP passwords rejected');
  r = await req('POST', '/api/admin/hosts', { ...syn, fingerprint: '', secret: 'authpass123', secret2: 'privpass123' });
  ok(r.status === 400 && /engine ID/.test(r.json.error), 'missing engine ID rejected');
  r = await req('POST', '/api/admin/hosts', { ...syn, secret: 'authpass123', secret2: 'privpass123' });
  ok(r.status === 201 && r.json.host.hasSecret && r.json.host.options.snmpAuth === 'sha', 'Synology host added');
  noSecrets(r.text, 'add Synology response');
  const synId = r.json.host.id;
  r = await req('POST', `/api/admin/hosts/${synId}/test`, {});
  ok(r.json.ok === true, `Synology test via SNMPv3 ${r.json.error || ''}`);

  // --- UniFi ---
  const uni = { type: 'unifi', name: 'UDM Pro', address: '127.0.0.1:18443', username: 'viewer', tlsMode: 'pin', fingerprint: FP };
  r = await req('POST', '/api/admin/hosts', { ...uni, secret: 'unifipass' });
  ok(r.status === 201, 'UniFi host added');
  const uniId = r.json.host.id;
  r = await req('POST', `/api/admin/hosts/${uniId}/test`, {});
  ok(r.json.ok === true, `UniFi test ${r.json.error || ''}`);
  r = await req('POST', '/api/admin/hosts', { ...uni, name: 'Wrong', secret: 'badpass' });
  const badId = r.json.host.id;
  await new Promise((res) => setTimeout(res, 800));
  const before = (await stats()).unifiLogins;
  r = await req('POST', `/api/admin/hosts/${badId}/test`, {});
  ok(r.json.ok === false && /Next login attempt in 1[45] min/.test(r.json.error), `wrong UniFi password backs off: ${r.json.error}`);
  ok((await stats()).unifiLogins === before, 'no new login attempt during backoff (protects against account lockout)');
  await req('DELETE', `/api/admin/hosts/${badId}`);

  // session reuse: several polls, one login
  const l0 = (await stats()).unifiLogins;
  for (let i = 0; i < 3; i++) await req('POST', `/api/admin/hosts/${uniId}/test`, {});
  ok((await stats()).unifiLogins === l0, 'UniFi session reused (no login per poll)');

  r = await req('GET', '/api/dashboard');
  noSecrets(r.text, 'dashboard API');
  const d = r.json;
  const s = d.synology[0]?.data;
  ok(s && s.system.model === 'DS418' && s.system.temp === 41 && s.disks.length === 4, 'Synology system + disks in dashboard');
  ok(s && s.disks[2].health === 'Warning' && s.pools[0].name === 'Storage Pool 1' && s.pools[0].healthy, 'disk health + storage pool parsed');
  const u = d.unifi[0]?.data;
  ok(u && u.devices.length === 3 && u.devices[0].type === 'udm' && u.health.clients === 37, 'UniFi devices + health');
  const sw = u.devices.find((x) => x.type === 'usw');
  ok(sw.poe && Math.abs(sw.poe.usedW - 14.05) < 0.01 && sw.poe.budgetW === 95, `switch PoE ${sw.poe && sw.poe.usedW} W of ${sw.poe && sw.poe.budgetW}`);
  ok(u.devices[0].temps.length === 3 && u.devices[0].fanLevel === 30, 'UDM Pro temperatures + fan');
  ok(Math.abs(d.power.measured.poe - 14.05) < 0.01, `PoE counted as measured power (${d.power.measured.poe})`);
  r = await req('GET', '/api/admin/config');
  noSecrets(r.text, 'admin config');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SYNOLOGY/UNIFI TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
