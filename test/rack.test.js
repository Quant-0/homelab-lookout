'use strict';
// Rack: passive items (blank/vented/brush/patch panels, cable management, shelves), conversion of the
// old panel "devices", overlap checks against devices, and the per-device front setting.
// test/run.js calls seed() on the data directory before the server starts.
const fs = require('node:fs');
const path = require('node:path');

const BLANK = 'aaaaaaaa-0000-4000-8000-000000000001';
const PATCH = 'aaaaaaaa-0000-4000-8000-000000000002';
const SHELF = 'aaaaaaaa-0000-4000-8000-000000000003';
const ORION = 'aaaaaaaa-0000-4000-8000-000000000004';
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    rack: { enabled: true, units: 24, numbering: 'bottom' },
    devices: [
      { id: BLANK, name: 'Blank 1', kind: 'blank', location: 'rack', u: 1, height: 1 },
      { id: PATCH, name: 'Patch A', kind: 'patch-panel', location: 'rack', u: 2, height: 1 },
      { id: SHELF, name: 'Shelf (spare)', kind: 'shelf', location: 'none', u: null, height: 1 },
      { id: ORION, name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2 },
    ],
  }), { mode: 0o600 });
}
module.exports = { seed };

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
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

async function run() {
  let r = await req('POST', '/api/admin/rack/passive', { kind: 'blank', u: 5 });
  ok(r.status === 401, 'adding a panel needs login');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- old panel devices became passive items ---
  let c = (await req('GET', '/api/admin/config')).json;
  ok(c.rack.passive.length === 2 && c.rack.passive.find((x) => x.id === BLANK)?.kind === 'blank' && c.rack.passive.find((x) => x.id === PATCH)?.ports === 24, 'blank and patch panel in the rack became passive items (same place)');
  ok(!c.devices.some((d) => d.id === BLANK || d.id === PATCH) && c.devices.some((d) => d.id === SHELF), 'they are no longer devices; an unplaced shelf stays a device');
  r = await req('GET', '/api/docs');
  ok(!r.json.auto.devices.some((d) => d.id === BLANK || d.id === PATCH), 'passive items are not in the docs');
  r = await req('GET', '/api/dashboard');
  ok(r.json.rack.passive.length === 2 && !r.json.rack.items.some((d) => d.id === BLANK) && !JSON.stringify(r.json.rack.passive).includes('Blank 1'), 'dashboard: passive items without names');

  // --- add, move, validate ---
  r = await req('POST', '/api/admin/rack/passive', { kind: 'vented', u: 3, height: 2 });
  ok(r.status === 201 && r.json.item.kind === 'vented' && r.json.item.height === 2, 'vented panel added (2 U)');
  const vented = r.json.item;
  r = await req('POST', '/api/admin/rack/passive', { kind: 'brush', u: 11 });
  ok(r.status === 400 && /overlaps Orion/.test(r.json.error), `panel over a device rejected: ${r.json.error}`);
  r = await req('POST', '/api/admin/devices', { name: 'Lynx', kind: 'server', location: 'rack', u: 4, height: 1 });
  ok(r.status === 400 && /overlaps the vented panel at U3/.test(r.json.error), `device over a panel rejected: ${r.json.error}`);
  r = await req('POST', '/api/admin/rack/passive', { kind: 'patch', u: 6, ports: 48, height: 2 });
  ok(r.status === 201 && r.json.item.ports === 48, '48-port patch panel');
  r = await req('POST', '/api/admin/rack/passive', { kind: 'sticker', u: 8 });
  ok(r.status === 400 && /Invalid panel type/.test(r.json.error), 'unknown panel type rejected');
  r = await req('POST', '/api/admin/rack/passive', { kind: 'blank', u: 24, height: 2 });
  ok(r.status === 400 && /does not fit/.test(r.json.error), 'panel past the top rejected');
  r = await req('POST', '/api/admin/rack/passive', { kind: 'blank', u: 8, height: 9 });
  ok(r.status === 400 && /1–4 U/.test(r.json.error), 'height limited to 4 U');
  r = await req('PUT', `/api/admin/rack/passive/${vented.id}`, { u: 20 });
  ok(r.status === 200 && r.json.item.u === 20 && r.json.item.kind === 'vented', 'panel moved');
  r = await req('PUT', `/api/admin/rack/passive/${vented.id}`, { kind: 'shelf' });
  ok(r.status === 200 && r.json.item.kind === 'shelf' && !('ports' in r.json.item), 'panel type changed');
  r = await req('PUT', '/api/admin/rack', { enabled: true, units: 18, numbering: 'bottom' });
  ok(r.status === 400 && /shelf sits at U21/.test(r.json.error), `rack can't shrink below a panel: ${r.json.error}`);
  r = await req('PUT', '/api/admin/rack', { enabled: true, units: 30, numbering: 'top' });
  c = (await req('GET', '/api/admin/config')).json;
  ok(r.status === 200 && c.rack.units === 30 && c.rack.passive.length === 4, 'rack settings keep the panels');
  r = await req('DELETE', `/api/admin/rack/passive/${vented.id}`);
  ok(r.status === 200 && !(await req('GET', '/api/admin/config')).json.rack.passive.some((x) => x.id === vented.id), 'panel removed');

  // --- front of a device ---
  const orion = c.devices.find((d) => d.id === ORION);
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, front: { model: 'dell14', drives: '16x2.5' } });
  ok(r.status === 200 && r.json.device.front.model === 'dell14' && r.json.device.front.drives === '16x2.5', 'front set: Dell 14th gen, 16 × 2.5″');
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, front: { model: '<script>', drives: '99x9' } });
  ok(r.json.device.front.model === 'auto' && r.json.device.front.drives === 'auto', 'unknown front values fall back to automatic');
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, front: { model: 'dell13', drives: '8x3.5' } });
  r = await req('PUT', `/api/admin/devices/${ORION}`, { name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2 });
  ok(r.json.device.front.model === 'dell13', 'saving without front keeps it');
  r = await req('GET', '/api/dashboard');
  ok(r.json.devices.find((d) => d.id === ORION).front.drives === '8x3.5', 'front is in the dashboard data');

  // UniFi models from the catalog: "u-<id>", nothing else
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, front: { model: 'u-usw-pro-max-24-poe', drives: 'auto' }, model: { brand: 'UniFi', name: 'Switch Pro Max 24 PoE' } });
  ok(r.status === 200 && r.json.device.front.model === 'u-usw-pro-max-24-poe' && r.json.device.model.name === 'Switch Pro Max 24 PoE', 'UniFi front and model saved');
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, front: { model: 'u-"><img src=x>', drives: 'auto' } });
  ok(r.status === 200 && r.json.device.front.model === 'auto', 'a made-up UniFi front falls back to automatic');
  r = await req('PUT', `/api/admin/devices/${ORION}`, { ...orion, kind: 'camera' });
  ok(r.status === 200 && r.json.device.kind === 'camera', 'cameras are a device type');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL RACK TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) run();
