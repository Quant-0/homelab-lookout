'use strict';
// Updates: Proxmox packages, TrueNAS and its apps, UniFi firmware and the apps' update APIs.
// Admin only, read-only, rate-limited "Check now", no secrets in the results.
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const M = 'http://127.0.0.1:18090';
const KEY = 'svc-key-123';
const SECRETS = [KEY, 'calvin', '11111111-2222-3333-4444-555555555555', '1-abcdefKEY', 'unifipass'];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf && !anon ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);

(async () => {
  let r = await req('GET', '/api/updates', undefined, { anon: true });
  ok(r.status === 401, 'updates need login');
  r = await req('GET', '/updates', undefined, { anon: true });
  ok(r.status === 303 && /next=updates/.test(r.headers.get('location')), 'the page sends you to log in');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  const c = (type, extra) => ({ type, address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, ...extra });
  const titan = (await req('POST', '/api/admin/devices', { name: 'titan', kind: 'server', location: 'none', connections: [c('idrac', { username: 'root', secret: 'calvin' }), c('proxmox', { username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } })] })).json.device;
  const nas = (await req('POST', '/api/admin/devices', { name: 'truenas', kind: 'storage', location: 'none', connections: [c('truenas', { username: 'truenas_admin', secret: '1-abcdefKEY' })] })).json.device;
  await req('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'none', connections: [c('unifi', { username: 'viewer', secret: 'unifipass' })] });
  const services = [['Sonarr', 'sonarr', 'sonarr'], ['Radarr', 'radarr', 'radarr'], ['Lidarr', 'lidarr', 'lidarr'], ['Prowlarr', 'prowlarr', 'prowlarr'], ['Seerr', 'overseerr', 'overseerr'],
    ['Pi-hole', 'pihole', 'pihole'], ['Pi-hole 5', 'pihole', 'pihole5'], ['Paperless', 'paperless', 'paperless'], ['authentik', 'authentik', 'authentik'], ['Portainer', 'portainer', 'portainer', { env: '' }],
    ['Home Assistant', 'homeassistant', 'homeassistant'], ['Tautulli', 'tautulli', 'tautulli'], ['Plex', 'plex', 'plex'], ['AdGuard', 'adguard', 'adguard', {}, 'admin'], ['Broken Sonarr', 'sonarr', 'sonarr', {}, '', 'wrong-key']];
  const ids = {};
  for (const [name, type, prefix, options = {}, username = '', secret = KEY] of services) {
    r = await req('POST', '/api/admin/services', { name, group: 'Apps', connection: { url: `${M}/${prefix}` }, integration: { type, username, options }, secret });
    ids[name] = r.json.service?.id;
  }
  await sleep(2500); // first polls (UniFi firmware comes from them)

  r = await req('POST', '/api/admin/updates/check', {});
  ok(r.status === 200 && r.json.checkedAt > Date.now() - 60000, 'check now runs the checks');
  noSecrets(r.text, 'updates');
  const rows = r.json.rows;
  const row = (name, part) => rows.find((x) => x.name === name && (!part || x.part === part));
  const pve = row('titan', 'Proxmox node pve1');
  ok(pve?.available && pve.count === 2 && pve.detail === '2 Proxmox packages' && pve.current === 'Proxmox VE 8.2.4' && pve.latest === 'Proxmox VE 8.2.7' && pve.list.some((p) => p.name === 'proxmox-kernel-6.8' && p.latest === '6.8.12-1'), `Proxmox, read-only: 2 packages, ${pve?.current} → ${pve?.latest}`);
  const tn = row('truenas', 'TrueNAS');
  ok(tn?.available && tn.latest === '26.04.1' && tn.current === 'TrueNAS-26.04.0', `TrueNAS: ${tn?.current} → ${tn?.latest}`);
  const apps = row('truenas', 'TrueNAS apps');
  ok(apps?.available && apps.count === 1 && apps.list[0].name === 'jellyfin' && apps.list[0].latest === '10.10.6', 'TrueNAS apps: jellyfin can be updated');
  const udm = rows.find((x) => x.part === 'UniFi firmware' && x.current === '4.1.13');
  ok(udm?.available && udm.latest === '4.1.22', `UniFi firmware: ${udm?.current} → ${udm?.latest}`);
  ok(rows.some((x) => x.part === 'UniFi firmware' && !x.available), 'UniFi devices without an update are listed as up to date');
  const expect = { Sonarr: ['4.0.10.2544', '4.0.11.2680', true], Radarr: [null, null, false], Lidarr: [null, null, false], Prowlarr: ['1.27.0.4852', '1.28.2.4885', true], Seerr: ['2.1.0', null, true],
    'Pi-hole': [null, 'Core v6.0.5', true], 'Pi-hole 5': [null, 'FTL v5.25.2', true], Paperless: [null, null, false], authentik: [null, null, false], Portainer: ['2.21.4', '2.27.1', true],
    'Home Assistant': ['2026.9.3', '2026.10.0', true], Tautulli: [null, null, false], Plex: [null, '1.41.3.9314-a0bfb8370', true], AdGuard: ['v0.107.54', 'v0.107.55', true] };
  for (const [name, [cur, latest, avail]] of Object.entries(expect)) {
    const x = row(name);
    ok(x && !x.error && x.available === avail && (cur === null || x.current === cur) && (latest === null || x.latest === latest), `${name}: ${x?.error || `${x?.current ?? '?'} → ${x?.latest ?? '?'} (${x?.available ? 'update' : 'up to date'})`}`);
  }
  ok(row('Home Assistant').list?.[0]?.name === 'Home Assistant Core', 'Home Assistant lists which parts can be updated');
  ok(/^https:\/\/github\.com\/Sonarr/.test(row('Sonarr').url) && row('AdGuard').url.includes('v0.107.55'), 'release notes links');
  ok(/HTTP 401/.test(row('Broken Sonarr')?.error || ''), `errors are shown, not hidden: ${row('Broken Sonarr')?.error}`);
  ok(rows[0].available && rows.findIndex((x) => !x.available) > rows.findLastIndex((x) => x.available), 'updates first');
  ok(r.json.available === rows.filter((x) => x.available).length && /at 04:00/.test(r.json.nextCheck), `${r.json.available} can be updated; next check ${r.json.nextCheck}`);

  r = await req('POST', '/api/admin/updates/check', {});
  ok(r.status === 429 && /less than a minute/.test(r.json.error), 'Check now is limited to once a minute');
  r = await req('POST', '/api/admin/updates/check', {}, { anon: true });
  ok(r.status === 401, 'checking needs login');

  // the Overview
  r = await req('GET', '/api/dashboard');
  ok(r.json.updates?.available === rows.filter((x) => x.available).length && r.json.updates.devices.includes(titan.id) && r.json.updates.devices.includes(nas.id), 'Overview gets the count and which devices have updates');
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: true } });
  r = await req('GET', '/api/dashboard', undefined, { anon: true });
  ok(r.status === 200 && !('updates' in r.json) && !r.text.includes('4.1.22'), 'a public dashboard says nothing about updates or versions to visitors');
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: false } });

  // stored, and removed services drop out
  const file = fs.readFileSync(path.join(process.env.DATA_DIR, 'updates.json'), 'utf8');
  ok(JSON.parse(file).items.length > 10, 'results kept in updates.json');
  noSecrets(file, 'updates.json');
  await req('DELETE', `/api/admin/services/${ids['Broken Sonarr']}`);
  r = await req('GET', '/api/updates');
  ok(!r.json.rows.some((x) => x.name === 'Broken Sonarr'), 'a removed service drops out of the list');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UPDATE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
