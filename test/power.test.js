'use strict';
// Smart plugs (Shelly Gen 1 and 2+, Tasmota, a Home Assistant sensor) and where each device's power
// is read from: one source per device, so nothing is counted twice.
const http = require('node:http');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(400);
  }
}

// --- mock plugs ---
const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
const servers = [
  // Shelly Plus Plug S (Gen 2), no login
  http.createServer((q, res) => {
    if (q.url === '/shelly') return json(res, 200, { name: null, id: 'shellyplusplugs-aa', model: 'SNPL-00112EU', gen: 2, app: 'PlugS' });
    if (q.url === '/rpc/Switch.GetStatus?id=0') return json(res, 200, { id: 0, output: true, apower: 87.4, voltage: 231.2, current: 0.41, aenergy: { total: 12345.6 } });
    json(res, 404, {});
  }).listen(18461, '127.0.0.1'),
  // Shelly Plug S (Gen 1) with a password
  http.createServer((q, res) => {
    if (q.url === '/shelly') return json(res, 200, { type: 'SHPLG-S', mac: 'AABBCC', auth: true });
    if (q.headers.authorization !== `Basic ${Buffer.from('admin:plugpass').toString('base64')}`) return res.writeHead(401).end('401 Unauthorized');
    if (q.url === '/status') return json(res, 200, { relays: [{ ison: true }], meters: [{ power: 12.5, total: 6000 }] });
    json(res, 404, {});
  }).listen(18462, '127.0.0.1'),
  // Tasmota with a web password
  http.createServer((q, res) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname !== '/cm') return json(res, 404, {});
    if (u.searchParams.get('password') !== 'tasmotapw') return json(res, 200, { WARNING: 'Need user=<username>&password=<password>' });
    json(res, 200, { Status: { DeviceName: 'NAS plug' }, StatusSTS: { POWER: 'ON' }, StatusSNS: { ENERGY: { Power: 33, Total: 4.5, Voltage: 230, Current: 0.15 } } });
  }).listen(18463, '127.0.0.1'),
  // Home Assistant
  http.createServer((q, res) => {
    if (q.headers.authorization !== 'Bearer ha-token-123') return json(res, 401, { message: 'Unauthorized' });
    if (q.url === '/api/states/sensor.udm_power') return json(res, 200, { state: '0.0285', attributes: { unit_of_measurement: 'kW', friendly_name: 'UDM plug power' } });
    if (q.url === '/api/states/sensor.udm_temperature') return json(res, 200, { state: '41', attributes: { unit_of_measurement: '°C' } });
    if (q.url === '/api/states/sensor.gone') return json(res, 200, { state: 'unavailable', attributes: { unit_of_measurement: 'W' } });
    json(res, 404, { message: 'Entity not found.' });
  }).listen(18464, '127.0.0.1'),
];

const power = async () => (await req('GET', '/api/dashboard')).json.power;

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- the plug types ---
  let r = await req('POST', '/api/admin/test-connection', { type: 'shelly', address: '127.0.0.1:18461' });
  ok(r.json?.ok && r.json.info === 'SNPL-00112EU · 87.4 W', `Shelly Gen 2 (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'shelly', address: '127.0.0.1:18462' });
  ok(r.json?.ok === false && /asks for a password/.test(r.json.error), `Shelly Gen 1 with a login, no password: ${r.json?.error}`);
  r = await req('POST', '/api/admin/test-connection', { type: 'shelly', address: '127.0.0.1:18462', username: 'admin', secret: 'wrong' });
  ok(r.json?.ok === false && /refused the password/.test(r.json.error), 'Shelly: a wrong password is refused');
  r = await req('POST', '/api/admin/test-connection', { type: 'shelly', address: '127.0.0.1:18462', username: 'admin', secret: 'plugpass' });
  ok(r.json?.ok && r.json.info === 'SHPLG-S · 12.5 W', `Shelly Gen 1 with its password (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'tasmota', address: '127.0.0.1:18463' });
  ok(r.json?.ok === false && /web password/.test(r.json.error), 'Tasmota asks for its web password');
  r = await req('POST', '/api/admin/test-connection', { type: 'tasmota', address: '127.0.0.1:18463', username: 'admin', secret: 'tasmotapw' });
  ok(r.json?.ok && r.json.info === 'NAS plug · 33 W', `Tasmota (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'hass', address: 'http://127.0.0.1:18464', username: 'sensor.udm_power', secret: 'ha-token-123' });
  ok(r.json?.ok && r.json.info === 'UDM plug power · 28.5 W', `Home Assistant, kW to W (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'hass', address: 'http://127.0.0.1:18464', username: 'sensor.udm_temperature', secret: 'ha-token-123' });
  ok(r.json?.ok === false && /not a power sensor/.test(r.json.error), 'Home Assistant: only a power sensor will do');
  r = await req('POST', '/api/admin/test-connection', { type: 'hass', address: 'http://127.0.0.1:18464', username: 'sensor.gone', secret: 'ha-token-123' });
  ok(r.json?.ok === false && /is unavailable/.test(r.json.error), 'Home Assistant: an unavailable sensor says so');
  r = await req('POST', '/api/admin/test-connection', { type: 'hass', address: 'http://127.0.0.1:18464', username: 'sensor.udm_power', secret: 'bad' });
  ok(r.json?.ok === false && /refused the token/.test(r.json.error), 'Home Assistant: a wrong token');
  r = await req('POST', '/api/admin/test-connection', { type: 'hass', address: 'http://127.0.0.1:18464', username: 'not an entity', secret: 'ha-token-123' });
  ok(r.status === 400 && /Entity ID/.test(r.json.error), 'Home Assistant: the entity ID is checked');

  // --- one device on a plug ---
  const nas = (await req('POST', '/api/admin/devices', { name: 'nas', kind: 'nas', location: 'outside', connections: [{ type: 'tasmota', address: '127.0.0.1:18463', username: 'admin', secret: 'tasmotapw' }] })).json.device;
  ok(nas?.id, 'a device with a Tasmota plug');
  let p = await until(async () => { const x = await power(); return x.measured.plug === 33 && x; });
  ok(p && p.measured.total === 33 && p.measured.idrac === null, `its power counts as measured (${JSON.stringify(p?.measured)})`);
  const cfg = (await req('GET', '/api/admin/config')).json;
  ok(!JSON.stringify(cfg.hosts).includes('tasmotapw'), 'the plug password is not shown');

  // --- a server with both Redfish and a plug: counted once ---
  const c = (type, extra) => ({ type, address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, ...extra });
  const titan = (await req('POST', '/api/admin/devices', { name: 'titan', kind: 'server', location: 'outside', connections: [c('idrac', { username: 'root', secret: 'calvin' }), { type: 'shelly', address: '127.0.0.1:18461' }] })).json.device;
  p = await until(async () => { const x = await power(); return x.measured.idrac !== null && x; });
  const idracW = p.measured.idrac;
  ok(idracW > 0 && p.measured.plug === 33 && p.measured.total === idracW + 33, `automatic: Redfish for the server, not its plug too (${JSON.stringify(p.measured)})`);
  let dev = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === titan.id);
  ok(dev.powerSource === 'auto' && dev.powerFrom === 'idrac', 'the device says where its power comes from');

  const put = (d, extra) => req('PUT', `/api/admin/devices/${d.id}`, { name: d.name, kind: d.kind, location: 'outside', estimateW: d.estimateW ?? null, ...extra });
  r = await put(titan, { powerSource: 'plug' });
  ok(r.status === 200, 'choose the smart plug instead');
  p = await power();
  ok(p.measured.idrac === null && p.measured.plug === 33 + 87.4 && Math.abs(p.measured.total - 120.4) < 0.01, `now the plug is counted and Redfish is not (${JSON.stringify(p.measured)})`);
  r = await put(titan, { powerSource: 'none' });
  p = await power();
  ok(p.measured.idrac === null && p.measured.plug === 33, 'not counted at all');
  r = await put(titan, { powerSource: 'sun' });
  ok(r.status === 400, 'an unknown source is refused');
  r = await put(titan, { estimateW: 300, powerSource: 'estimate' });
  p = await power();
  ok(p.estimatedW === 300 && p.measured.idrac === null, 'or its estimate');
  r = await req('PUT', `/api/admin/devices/${titan.id}`, { name: 'titan', kind: 'server', location: 'outside', estimateW: 300, hidden: false });
  dev = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === titan.id);
  ok(dev.powerSource === 'estimate', 'saving without the field keeps the choice');

  // a choice that no longer exists falls back to automatic
  r = await put(nas, { powerSource: 'idrac' });
  dev = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === nas.id);
  ok(dev.powerSource === 'idrac' && dev.powerFrom === 'plug', 'Redfish chosen but missing: the plug is used');

  // --- history and the drawer ---
  const conn = cfg.hosts.find((h) => h.deviceId === nas.id);
  await sleep(1200);
  const h = (await req('GET', `/api/history?keys=plug:${conn.id}:watts`)).json.series[`plug:${conn.id}:watts`];
  ok(Array.isArray(h) && h.length >= 1 && h.at(-1)[1] === 33, 'plug power is kept as history');
  const d = (await req('GET', '/api/dashboard')).json;
  ok(d.tasmota?.[0]?.data?.watts === 33 && d.tasmota[0].data.on === true && d.tasmota[0].data.totalWh === 4500, 'the dashboard gets the plug reading');

  for (const s of servers) s.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL POWER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
