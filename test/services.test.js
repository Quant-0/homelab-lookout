'use strict';
// Services (26 integrations against mocks), icons, and documentation.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const M = 'http://127.0.0.1:18090';
const KEY = 'svc-key-123';
const FP = process.env.MOCK_FP;
const SECRETS = [KEY, 'PPPOE-SECRET-PW', 'IPSEC-SECRET-PSK', 'unifipass', 'calvin'];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, extra = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, text: buf.toString('latin1'), headers: r.headers };
}
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [type, path prefix, username, options, expected stats (label=value)]
const CASES = [
  ['jellyfin', 'jellyfin', '', {}, { Movies: 812, Series: 97, Episodes: 4211, Streaming: 2 }],
  ['emby', 'emby', '', {}, { Movies: 812, Streaming: 2 }],
  ['plex', 'plex', '', {}, { Streams: 1, Movies: 640, 'TV shows': 55, Libraries: 3 }],
  ['tautulli', 'tautulli', '', {}, { Streams: 2, Transcoding: 1, Bandwidth: 24500000 }],
  ['sonarr', 'sonarr', '', {}, { Series: 42, Wanted: 17, Queued: 3 }],
  ['radarr', 'radarr', '', {}, { Movies: 3, 'On disk': 2, Wanted: 1, Queued: 0 }],
  ['lidarr', 'lidarr', '', {}, { Artists: 2, Wanted: 9, Queued: 1 }],
  ['prowlarr', 'prowlarr', '', {}, { Indexers: 2, Grabs: 15, Queries: 420, Failed: 3 }],
  ['bazarr', 'bazarr', '', {}, { 'Missing episodes': 12, 'Missing movies': 4 }],
  ['overseerr', 'overseerr', '', {}, { Pending: 2, Approved: 30, Available: 25 }],
  ['qbittorrent', 'qbittorrent', 'admin', {}, { Download: 5242880, Upload: 1048576, Leeching: 2, Seeding: 2 }],
  ['qbittorrent', 'qbittorrent5', 'admin', {}, { Download: 5242880, Leeching: 2, Seeding: 2 }],
  ['transmission', 'transmission', 'admin', {}, { Download: 2000000, Active: 4, Torrents: 20 }],
  ['sabnzbd', 'sabnzbd', '', {}, { Speed: 1049088, Queue: 3, 'Time left': '0:12:30' }],
  ['pihole', 'pihole', '', {}, { Queries: 54000, 'On blocklist': 210000 }],
  ['pihole', 'pihole5', '', {}, { Queries: 900, 'On blocklist': 100000 }],
  ['adguard', 'adguard', 'admin', {}, { Queries: 20000, Blocked: 3000, 'Block rate': 15, Latency: 12.3 }],
  ['npm', 'npm', 'admin@example.com', {}, { Enabled: 2, Disabled: 1, Total: 3 }],
  ['traefik', 'traefik', '', {}, { Routers: 14, Services: 12, Middleware: 5, Errors: 1 }],
  ['homeassistant', 'homeassistant', '', {}, { 'People home': 1, 'Lights on': 1, 'Switches on': 1, Entities: 8 }],
  ['nextcloud', 'nextcloud', '', {}, { 'Active users (24 h)': 3, Files: 123456, 'CPU load': 0.42 }],
  ['immich', 'immich', '', {}, { Photos: 30000, Videos: 1200, Users: 2 }],
  ['paperless', 'paperless', '', {}, { Documents: 1500, Inbox: 7 }],
  ['uptimekuma', 'uptimekuma', '', { slug: 'homelab' }, { Up: 2, Down: 1 }],
  ['grafana', 'grafana', '', {}, { Dashboards: 12, 'Data sources': 3, 'Alert rules': 4 }],
  ['portainer', 'portainer', '', { env: '' }, { Running: 2, Stopped: 1, Total: 3 }],
  ['speedtest', 'speedtest', '', {}, { Download: 912, Upload: 487, Ping: 7.4 }],
  ['prometheus', 'prometheus', '', {}, { 'Targets up': 2, Down: 1 }],
  ['authentik', 'authentik', '', {}, { Users: 5, 'Logins (24 h)': 14, 'Failed (24 h)': 2 }],
  ['customapi', 'custom', '', { path: '/stats', header: 'X-Token', fields: 'Users = data.users\nState = data.nested.up\nMissing = data.nope' }, { Users: 7, State: 'yes', Missing: null }],
];

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  // devices for the docs part: Orion (iDRAC) and the UDM Pro (UniFi console)
  await req('POST', '/api/admin/devices', { name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  await req('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', tlsMode: 'pin', fingerprint: FP, secret: 'unifipass' }] });
  const defs = (await req('GET', '/api/admin/services')).json.integrations;
  ok(Object.keys(defs).length === 34, `34 integrations offered (${Object.keys(defs).length})`);

  // --- every integration, tested before saving ---
  for (const [type, prefix, username, options, expect] of CASES) {
    const body = { name: type, group: 'Test', connection: { url: `${M}/${prefix}` }, integration: { type, username, options }, secret: defs[type].secret ? KEY : '' };
    const r = await req('POST', '/api/admin/services/test', body);
    const got = Object.fromEntries((r.json?.stats || []).map((s) => [s.label, s.value]));
    const bad = Object.entries(expect).filter(([k, v]) => (typeof v === 'number' ? Math.abs((got[k] ?? NaN) - v) > 0.01 : got[k] !== v));
    ok(r.status === 200 && !r.json.error && !bad.length, `${type}${prefix !== type ? ` (${prefix})` : ''}: ${r.json?.error || JSON.stringify(got)}`);
    noSecrets(r.text, `${type} test response`);
  }
  r = await req('POST', '/api/admin/services/test', { name: 'x', connection: { url: `${M}/sonarr` }, integration: { type: 'sonarr', options: {} }, secret: 'wrong' });
  ok(/401/.test(r.json.error), `wrong API key reported: ${r.json.error}`);
  r = await req('POST', '/api/admin/services/test', { name: 'x', connection: { url: 'http://127.0.0.1:1' }, integration: null });
  ok(r.json.check && r.json.check.up === false, `unreachable service is down: ${r.json.check?.error}`);

  // --- validation ---
  r = await req('POST', '/api/admin/services', { name: 'Evil', href: 'javascript:alert(1)' });
  ok(r.status === 400 && /http/.test(r.json.error), 'javascript: links rejected');
  r = await req('POST', '/api/admin/services', { name: 'Creds', connection: { url: 'http://user:pw@10.0.0.1' } });
  ok(r.status === 400 && /credential/.test(r.json.error), 'credentials in URL rejected');
  r = await req('POST', '/api/admin/services', { name: 'NoUrl', integration: { type: 'sonarr' } });
  ok(r.status === 400 && /connection URL/.test(r.json.error), 'integration without URL rejected');
  r = await req('POST', '/api/admin/services', { name: 'Kuma', connection: { url: `${M}/uptimekuma` }, integration: { type: 'uptimekuma', options: {} } });
  ok(r.status === 400 && /slug/i.test(r.json.error), 'required option enforced');

  // --- save, poll, show ---
  r = await req('POST', '/api/admin/services', { name: 'Jellyfin', group: 'Media', description: 'Movies', href: 'https://jellyfin.example.lan', connection: { url: `${M}/jellyfin` }, integration: { type: 'jellyfin', options: {} }, secret: KEY });
  ok(r.status === 201 && r.json.service.hasSecret && r.json.service.secret === undefined, 'service saved, secret write-only');
  const jf = r.json.service;
  noSecrets(r.text, 'save response');
  r = await req('POST', '/api/admin/services', { name: 'Pi-hole', group: 'Network', connection: { url: `${M}/pihole` }, integration: { type: 'pihole', options: {} }, secret: KEY });
  const ph = r.json.service;
  r = await req('POST', '/api/admin/services', { name: 'Wiki', group: 'Media', href: 'https://wiki.example.lan' });
  ok(r.status === 201, 'link-only service saved');
  await sleep(1500);
  r = await req('GET', '/api/services');
  noSecrets(r.text, 'services API');
  ok(!r.text.includes('127.0.0.1:18090'), 'services API does not expose connection URLs');
  const media = r.json.groups.find((g) => g.name === 'Media');
  const jfOut = media.services.find((s) => s.name === 'Jellyfin');
  ok(jfOut.check.up && jfOut.stats.map((x) => x.label).join() === 'Movies,Series,Streaming' && jfOut.href === 'https://jellyfin.example.lan/', `Jellyfin card: up, the default numbers (${jfOut.stats.map((x) => x.label)}), link`);
  // choose the numbers yourself
  const jfAdmin = (await req('GET', '/api/admin/services')).json.services.find((x) => x.name === 'Jellyfin');
  ok(jfAdmin.result.labels.join() === 'Movies,Series,Episodes,Streaming', 'admin sees which numbers the service reports');
  const jfBody = { ...jfAdmin, integration: { ...jfAdmin.integration, fields: ['Episodes', 'Streaming'] } };
  r = await req('PUT', `/api/admin/services/${jfAdmin.id}`, jfBody);
  ok(r.status === 200 && r.json.service.integration.fields.join() === 'Episodes,Streaming', 'numbers chosen per service');
  await sleep(1200); // polled again after saving
  r = await req('GET', '/api/services');
  ok(r.json.groups.find((g) => g.name === 'Media').services.find((x) => x.name === 'Jellyfin').stats.map((x) => x.label).join() === 'Episodes,Streaming', 'the card shows the chosen numbers');
  r = await req('PUT', `/api/admin/services/${jfAdmin.id}`, { ...jfBody, integration: { ...jfBody.integration, fields: ['A', 'B', 'C', 'D', 'E'] } });
  ok(r.status === 400 && /at most 4/.test(r.json.error), 'at most four numbers');
  r = await req('PUT', `/api/admin/services/${jfAdmin.id}`, { ...jfBody, integration: { ...jfBody.integration, fields: [] } });
  ok(r.status === 200 && !r.json.service.integration.fields, 'back to the defaults');
  ok(media.services.find((s) => s.name === 'Wiki').check === undefined, 'link-only card has no status check');
  r = await req('GET', '/api/admin/services');
  noSecrets(r.text, 'admin services');
  // edit without retyping keeps the secret; URL change without secret deletes it
  r = await req('PUT', `/api/admin/services/${jf.id}`, { ...jf, name: 'Jellyfin TV', secret: '' });
  ok(r.json.service.hasSecret && !r.json.note, 'rename keeps the secret');
  r = await req('POST', '/api/admin/services/test', { ...jf, id: jf.id, secret: '' });
  ok(!r.json.error && r.json.stats?.length === 4, 'saved service tests without retyping the key');
  r = await req('PUT', `/api/admin/services/${jf.id}`, { ...jf, connection: { url: `${M}/plex` }, secret: '' });
  ok(r.json.service.hasSecret === false && /deleted/.test(r.json.note), 'URL change deletes the stored secret');
  // Pi-hole v6 sessions are reused (v6 limits sessions)
  const before = (await (await fetch(`${M}/__stats`)).json()).piholeLogins;
  for (let i = 0; i < 3; i++) await req('PUT', `/api/admin/services/${ph.id}`, { ...ph, secret: '' });
  await sleep(800);
  r = await req('POST', '/api/admin/services/test', { ...ph, id: ph.id, secret: '' });
  ok((await (await fetch(`${M}/__stats`)).json()).piholeLogins - before <= 4, 'Pi-hole logins are not repeated on every poll');
  r = await req('PUT', '/api/admin/services/order', { ids: [ph.id, jf.id] });
  ok(r.status === 200, 'order saved');

  // --- icons ---
  r = await req('GET', '/api/admin/icons/search?q=jellyf');
  ok(r.json.names?.includes('jellyfin'), `icon search (${(r.json.names || []).slice(0, 4).join(', ')})`);
  r = await req('GET', '/api/admin/icons/preview/jellyfin');
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'icon preview served from this server');
  r = await req('GET', '/api/admin/icons/preview/..%2f..%2fetc%2fpasswd');
  ok(r.status === 404, 'preview rejects odd names');
  r = await req('POST', '/api/admin/icons/library', { name: 'jellyfin' });
  ok(r.status === 201 && /^[0-9a-f]{32}$/.test(r.json.icon.id), 'library icon downloaded and stored');
  const iconId = r.json.icon.id;
  r = await req('POST', '/api/admin/icons/library', { name: 'jellyfin' });
  ok(r.json.icon.id === iconId, 'same library icon reused');
  r = await req('POST', '/api/admin/icons/library', { name: 'definitely-not-an-icon-xyz' });
  ok(r.status === 400, 'unknown icon rejected');
  await req('PUT', `/api/admin/services/${jf.id}`, { ...jf, icon: { kind: 'file', id: iconId }, secret: KEY });
  r = await req('GET', `/media/icon/${iconId}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'icon served');

  // --- documentation ---
  r = await req('GET', '/api/docs');
  ok(r.status === 200 && r.json.docs.pages.length === 0, 'docs readable when logged in');
  const auto = r.json.auto;
  noSecrets(r.text, 'docs (incl. UniFi network configs)');
  ok(auto.unifi[0]?.networks.length === 3 && !auto.unifi[0].networks.some((n) => n.purpose === 'wan'), 'UniFi networks imported, WAN left out');
  ok(auto.unifi[0].clients.length === 3 && auto.unifi[0].clients[0].swPort === 7, 'UniFi clients with switch ports');
  const orion = auto.devices.find((d) => d.ips.includes('127.0.0.1') && d.connections.some((c) => c.type === 'idrac'));
  ok(orion && orion.model === 'PowerEdge R730xd' && orion.serviceTag === 'ABC1234', 'server sheet facts from the iDRAC');
  r = await req('PUT', `/api/docs/servers/${orion.id}`, { role: 'Proxmox host', os: 'Proxmox VE 8', notes: '# Setup\n<script>alert(1)</script>', custom: [{ label: 'BIOS', value: '2.19' }] });
  ok(r.status === 200 && r.json.server.custom[0].value === '2.19', 'server notes saved');
  r = await req('PUT', '/api/docs/network', { networks: [{ name: 'LAN', subnet: '192.168.1.0/24' }], reservations: [{ ip: '192.168.1.80', name: 'orion', deviceId: orion.id }], notes: 'x' });
  ok(r.status === 200 && r.json.network.reservations[0].deviceId === orion.id, 'network plan saved');
  r = await req('POST', '/api/docs/pages', { title: 'Restore from backup', body: '1. Stop VM\n2. Restore' });
  ok(r.status === 201 && r.json.nav.groups.find((g) => g.id === 'pages').items.includes(`page:${r.json.page.id}`), 'page created, in the Pages group');
  const page = r.json.page;
  // menu groups
  r = await req('GET', '/api/docs');
  ok(r.json.docs.nav.groups.map((g) => g.id).join() === 'devices,network,pages', 'default menu: Servers & devices, Network, Pages');
  r = await req('PUT', '/api/docs/nav', { groups: [{ id: 'new-1', name: 'Procedures', items: [`page:${page.id}`, `page:${page.id}`, 'evil:x'] }, { id: 'devices', name: 'Servers', items: [`server:${orion.id}`] }] });
  const proc = r.json.nav?.groups[0];
  ok(r.status === 200 && /^[0-9a-f-]{36}$/.test(proc.id) && proc.items.join() === `page:${page.id}`, 'new group gets a real id; duplicates and unknown items dropped');
  ok(r.json.nav.groups.map((g) => g.id).slice(1).join() === 'devices,network,pages' && r.json.nav.groups[1].name === 'Servers', 'renamed group kept; Network and Pages added back');
  r = await req('PUT', '/api/docs/nav', { groups: [{ id: 'devices', name: 'A', items: [] }, { id: 'devices', name: 'B', items: [] }] });
  ok(r.status === 400, 'duplicate group ids rejected');
  r = await req('PUT', '/api/docs/nav', { groups: [{ id: '../x', name: 'A', items: [] }] });
  ok(r.status === 400, 'invalid group id rejected');
  r = await req('PUT', `/api/docs/pages/${page.id}`, { title: 'Restore', body: 'updated', group: 'pages' });
  ok(r.json.page.title === 'Restore' && r.json.nav.groups.find((g) => g.id === 'pages').items.includes(`page:${page.id}`) && !r.json.nav.groups.find((g) => g.id === proc.id).items.length, 'page updated and moved to another group');
  r = await req('POST', '/api/docs/pages', { title: '', body: 'x' });
  ok(r.status === 400, 'page without title rejected');

  // the older "show stopped VMs" setting still counts; unknown keys are dropped
  r = await req('PUT', '/api/admin/settings', { dashboard: { title: 'Homelab', refreshSeconds: 30, showStoppedGuests: false, vms: { cpu: false, bogus: 1 } } });
  ok(r.status === 200 && r.json.settings.dashboard.vms.stopped === false && r.json.settings.dashboard.vms.cpu === false && !('bogus' in r.json.settings.dashboard.vms) && r.json.settings.dashboard.homeServices === 'tiles', 'older settings: stopped VMs off carried over, defaults for the rest');

  // docs stay private even with a public dashboard
  const settings = (await req('GET', '/api/admin/config')).json.settings;
  await req('PUT', '/api/admin/settings', { dashboard: { ...settings.dashboard, public: true } });
  const saved = cookie;
  cookie = '';
  r = await req('GET', '/api/services');
  ok(r.status === 200, 'public dashboard: services visible without login');
  r = await req('GET', '/api/dashboard');
  ok(r.status === 200 && !r.text.includes('203.0.113.45') && r.json.unifi[0].data.devices.every((d) => !('ip' in d)), 'public dashboard: no WAN or LAN addresses from UniFi');
  noSecrets(r.text, 'public services');
  r = await req('GET', '/api/docs');
  ok(r.status === 401, 'public dashboard: docs still need login');
  r = await req('GET', '/docs');
  ok(r.status === 303 && /next=docs/.test(r.headers.get('location')), 'docs page redirects to login');
  r = await req('GET', '/static/js/docs.js');
  ok(r.status === 401, 'docs script not served without login');
  r = await req('GET', `/media/icon/${iconId}`);
  ok(r.status === 200, 'icons follow the dashboard visibility');
  cookie = saved;
  await req('PUT', '/api/admin/settings', { dashboard: { ...settings.dashboard, public: false } });
  cookie = '';
  r = await req('GET', '/api/services');
  ok(r.status === 401, 'private dashboard: services need login');
  cookie = saved;

  // --- Customize: group order, columns, moving and hiding services ---
  let sv = (await req('GET', '/api/services')).json;
  const anId = sv.groups.find((g) => g.services?.length).services[0].id;
  const all = sv.groups.filter((g) => g.services).map((g) => ({ key: g.key, columns: 0, services: g.services.map((x) => x.id) }));
  const moved = { key: 'Favourites', columns: 2, services: [anId] };
  const rest = all.map((g) => ({ ...g, services: g.services.filter((id) => id !== anId) }));
  const others = rest.flatMap((g) => g.services);
  const hideId = others[0];
  r = await req('PUT', '/api/admin/services/layout', { groups: [moved, ...rest.reverse()], hidden: [hideId] });
  ok(r.status === 200 && r.json.groups[0].key === 'Favourites' && r.json.groups[0].columns === 2 && r.json.groups[0].services[0].id === anId, 'layout saved: new first group with 2 columns');
  ok(r.json.hidden.some((h) => h.id === hideId) && !r.json.groups.some((g) => g.services?.some((x) => x.id === hideId)), 'hidden service left out of the page (listed for the admin)');
  sv = (await req('GET', '/api/services')).json;
  ok(sv.groups[0].key === 'Favourites' && sv.groups[0].columns === 2 && sv.groups.map((g) => g.key).join() === ['Favourites', ...rest.map((g) => g.key)].filter((k) => sv.groups.some((g) => g.key === k)).join(), `group order kept on the next load (${sv.groups.map((g) => g.key).join(', ')})`);
  const beforeBad = JSON.stringify((await req('GET', '/api/services')).json.groups.map((g) => [g.key, g.services?.map((x) => x.id)]));
  r = await req('PUT', '/api/admin/services/layout', { groups: [{ key: 'Moved', services: [anId] }, { key: 'A' }, { key: 'A' }] });
  ok(r.status === 400 && /twice/.test(r.json.error), 'duplicate group names rejected');
  ok(JSON.stringify((await req('GET', '/api/services')).json.groups.map((g) => [g.key, g.services?.map((x) => x.id)])) === beforeBad, 'a rejected layout changes nothing');
  r = await req('PUT', '/api/admin/services/layout', { groups: [{ key: '@evil', services: [] }] });
  ok(r.status === 400 && /cannot start with @/.test(r.json.error), 'reserved group names rejected');
  r = await req('PUT', '/api/admin/services/layout', { groups: [{ key: 'X', columns: 9 }] });
  ok(r.status === 400 && /Columns/.test(r.json.error), 'column count validated');
  r = await req('PUT', '/api/admin/services/layout', { groups: [moved, ...rest], hidden: [] });
  ok(r.status === 200 && !r.json.hidden.length, 'service shown again');
  cookie = '';
  r = await req('PUT', '/api/admin/services/layout', { groups: [] });
  ok(r.status === 401, 'layout needs login');
  cookie = saved;

  r = await req('DELETE', `/api/docs/pages/${page.id}`);
  ok(r.status === 200 && !(await req('GET', '/api/docs')).json.docs.nav.groups.some((g) => g.items?.includes(`page:${page.id}`)), 'page deleted, and removed from the menu');
  r = await req('DELETE', `/api/admin/services/${jf.id}`);
  ok(r.status === 200, 'service deleted');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SERVICES/DOCS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
var r;
