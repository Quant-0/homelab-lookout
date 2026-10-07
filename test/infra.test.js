'use strict';
// Service cards for infrastructure: TrueNAS, Synology, UniFi and a UPS, with the numbers of a device
// the dashboard already reads or with the card's own login; PeaNUT; Tailscale for the whole tailnet.
const net = require('node:net');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const M = 'http://127.0.0.1:18090';
const KEY = 'svc-key-123';
const SECRETS = [KEY, '1-abcdefKEY', 'unifipass', 'DSMSID'];
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
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const got = (r) => Object.fromEntries((r.json?.stats || []).map((s) => [s.label, s.value]));

// A tiny upsd with one UPS, "rackups"
const nut = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'LIST VAR rackups') sock.write('BEGIN LIST VAR rackups\nVAR rackups ups.status "OL"\nVAR rackups battery.charge "97"\nVAR rackups battery.runtime "2400"\nVAR rackups ups.load "18"\nEND LIST VAR rackups\n');
      else sock.write('ERR UNKNOWN-UPS\n');
    }
  });
});

(async () => {
  await new Promise((r) => nut.listen(18467, '127.0.0.1', r));
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const pin = { tlsMode: 'pin', fingerprint: FP };
  let r = await req('POST', '/api/admin/devices', { name: 'tank', kind: 'storage', location: 'rack', u: 10, height: 2, connections: [{ type: 'truenas', address: '127.0.0.1:18443', username: 'truenas_admin', secret: '1-abcdefKEY', ...pin }] });
  await req('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', secret: 'unifipass', ...pin }] });
  await req('POST', '/api/admin/devices', { name: 'Pi UPS', kind: 'ups', location: 'outside', connections: [{ type: 'nut', address: '127.0.0.1:18467', username: 'rackups' }] });
  await sleep(2500);

  r = await req('GET', '/api/admin/services');
  const defs = r.json.integrations;
  const sources = r.json.sources;
  const src = (type) => sources.find((h) => h.type === type);
  ok(['truenas', 'synology', 'unifi', 'ups', 'peanut', 'tailscale'].every((k) => defs[k]?.group === 'Infrastructure') && defs.truenas.fromDevice.includes('truenas') && defs.ups.noUrl, 'six infrastructure integrations, with "numbers from a device" where it applies');
  ok(src('truenas')?.name === 'tank' && src('unifi')?.name === 'UDM Pro' && src('nut')?.name === 'Pi UPS', 'the devices a card can read from are listed by name');
  noSecrets(r.text, 'services admin list');

  // --- from a device: no URL, no secret ---
  const fromDev = (type, host) => ({ name: type, group: 'Infra', integration: { type, options: { device: host } } });
  r = await req('POST', '/api/admin/services/test', fromDev('truenas', src('truenas').id));
  let g = got(r);
  ok(!r.json.error && g['Unhealthy pools'] === 1 && g.Pools === 2 && typeof g.Used === 'number' && g.Alerts >= 1, `TrueNAS from the device: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', fromDev('unifi', src('unifi').id));
  g = got(r);
  ok(!r.json.error && g.WAN === 'Up' && g.Clients > 0 && typeof g['Devices offline'] === 'number' && /^\d+\/\d+$/.test(g['Cameras online']), `UniFi from the device: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', fromDev('ups', src('nut').id));
  g = got(r);
  ok(!r.json.error && g.Charge === 97 && g.Runtime === 40 && g.Load === 18 && g['Power from'] === 'Mains', `UPS from a NUT device: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', fromDev('ups', src('truenas').id));
  ok(r.status === 400 && /listed devices/.test(r.json.error), 'a device of the wrong kind is refused');
  r = await req('POST', '/api/admin/services', { ...fromDev('truenas', src('truenas').id), name: 'tank', secret: 'ignored-secret' });
  ok(r.status === 201 && r.json.service.integration.options.device === src('truenas').id && !r.json.service.hasSecret && !r.json.service.connection, 'saved from a device: no URL needed and no secret stored');
  const tankCard = r.json.service.id;

  // --- their own login ---
  const own = (type, url, username, secret, options = {}) => ({ name: type, group: 'Infra', connection: { url, ...pin }, integration: { type, username, options }, secret });
  r = await req('POST', '/api/admin/services/test', own('truenas', 'https://127.0.0.1:18443', 'truenas_admin', '1-abcdefKEY'));
  g = got(r);
  ok(!r.json.error && g.Pools === 2 && g['Unhealthy pools'] === 1, `TrueNAS with its own API key: ${r.json.error || JSON.stringify(g)}`);
  noSecrets(r.text, 'TrueNAS test');
  r = await req('POST', '/api/admin/services/test', own('truenas', 'http://127.0.0.1:18443', 'truenas_admin', '1-abcdefKEY'));
  ok(/https/.test(r.json.error || ''), `TrueNAS refuses plain http (an API key sent over http gets revoked): ${r.json.error}`);
  r = await req('POST', '/api/admin/services/test', own('unifi', 'https://127.0.0.1:18443', 'viewer', 'unifipass'));
  g = got(r);
  ok(!r.json.error && g.WAN === 'Up' && g.Clients > 0, `UniFi with its own login: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', { ...own('synology', `${M}/synology`, 'dsmview', KEY), connection: { url: `${M}/synology` } });
  g = got(r);
  ok(!r.json.error && g['Volume used'] === 25 && g.CPU === 11 && g.Memory === 42 && g.Uptime === 361815 && g.Temperature === '41 °C' && g['Disk warnings'] === 1, `Synology through DSM: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', { ...own('synology', `${M}/synology`, 'dsmview', 'wrong'), connection: { url: `${M}/synology` } });
  ok(/Wrong user name or password/.test(r.json.error), `DSM wrong password: ${r.json.error}`);
  r = await req('POST', '/api/admin/services/test', { name: 'ups', integration: { type: 'ups', options: { address: '127.0.0.1:18467', ups: 'rackups' } } });
  g = got(r);
  ok(!r.json.error && g.Charge === 97, `UPS from a NUT server directly: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', { name: 'ups', integration: { type: 'ups', options: { address: '127.0.0.1:18467', ups: 'other' } } });
  ok(/No UPS called/.test(r.json.error), `unknown UPS name: ${r.json.error}`);
  r = await req('POST', '/api/admin/services', { name: 'ups', integration: { type: 'ups', options: { address: 'not an address!', ups: 'x' } } });
  ok(r.status === 400, 'a bad NUT address is refused');

  // --- PeaNUT, and what a UPS on battery says ---
  r = await req('POST', '/api/admin/services', { name: 'Office UPS', group: 'Infra', connection: { url: `${M}/peanut` }, integration: { type: 'peanut', options: { ups: 'rackups' } } });
  ok(r.status === 201, 'PeaNUT card saved (no login)');
  const peanut = r.json.service.id;

  // --- Tailscale: the whole tailnet ---
  r = await req('POST', '/api/admin/services/test', { name: 'Tailscale', integration: { type: 'tailscale', options: {} }, secret: KEY });
  g = got(r);
  ok(!r.json.error && g.Online === 3 && g.Devices === 4 && g['Expiring keys'] === 2 && g.Updates === 1 && g.Offline === 1, `Tailscale: ${r.json.error || JSON.stringify(g)}`);
  r = await req('POST', '/api/admin/services/test', { name: 'Tailscale', integration: { type: 'tailscale', options: {} }, secret: 'tskey-bad-1234' });
  ok(/token is wrong or expired/.test(r.json.error), `Tailscale wrong token: ${r.json.error}`);
  r = await req('POST', '/api/admin/services', { name: 'Tailscale', group: 'Infra', integration: { type: 'tailscale', options: {} }, secret: KEY });
  ok(r.status === 201 && r.json.service.hasSecret && !r.json.service.connection, 'Tailscale saved without a URL; the token is stored encrypted');
  noSecrets(r.text, 'Tailscale save');

  // --- on the dashboard: numbers on the cards, problems under "Needs you" ---
  await sleep(2500);
  r = await req('GET', '/api/services');
  const cards = r.json.groups.flatMap((x) => x.services || []);
  const card = (name) => cards.find((c) => c.name === name);
  ok(card('tank')?.stats?.map((x) => x.label).join() === 'Alerts,Unhealthy pools,Used' && card('tank').check === undefined, `the TrueNAS card shows its default numbers (${card('tank')?.stats?.map((x) => x.label)})`);
  ok(card('Tailscale')?.stats?.map((x) => x.label).join() === 'Online,Expiring keys,Updates', 'the Tailscale card shows online, expiring keys and updates');
  noSecrets(r.text, '/api/services');
  r = await req('GET', '/api/dashboard');
  const att = r.json.attention.filter((a) => a.serviceId);
  ok(att.some((a) => a.serviceId === peanut && a.severity === 'warning' && /UPS on battery/.test(a.text)), 'PeaNUT: a UPS on battery shows under "Needs you"');
  ok(att.some((a) => a.severity === 'critical' && /1 device key has expired/.test(a.text) && /phone/.test(a.detail)) && att.some((a) => a.severity === 'warning' && /expire within 14 days/.test(a.text) && /laptop/.test(a.detail)), 'Tailscale: expired and soon-expiring keys show under "Needs you"');

  // --- the device a card reads from is removed ---
  const cfg = (await req('GET', '/api/admin/config')).json;
  const tank = cfg.devices.find((d) => d.name === 'tank');
  const tankHost = src('truenas').id;
  r = await req('DELETE', `/api/admin/devices/${tank.id}`);
  ok(r.status === 200, 'the TrueNAS device is removed');
  r = await req('POST', '/api/admin/services/test', fromDev('truenas', tankHost));
  ok(r.status === 400 && /listed devices/.test(r.json.error), 'a card can no longer be pointed at it');
  ok((await req('GET', '/api/admin/services')).json.services.some((x) => x.id === tankCard), 'the card itself stays (it says the device was removed until you pick another)');

  nut.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INFRASTRUCTURE SERVICE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
