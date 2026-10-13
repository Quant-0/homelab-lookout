'use strict';
// Device model: devices with connections, pre-save testing, UniFi discovery, placement, power.
const https = require('node:https');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const SECRETS = ['calvin', '11111111-2222-3333-4444-555555555555', 'authpass123', 'privpass123', 'unifipass', 'SECRETJWT', '1-abcdefKEY'];
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = () => new Promise((res) => https.get({ host: '127.0.0.1', port: 18443, path: '/__stats', rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }));
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);
const cfg = async () => (await req('GET', '/api/admin/config')).json;
const idrac = { type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP };
const pve = { type: 'proxmox', address: '127.0.0.1:18443', username: 'root@pam!dash', tlsMode: 'pin', fingerprint: FP, options: { node: '' } };

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const hostsBefore = (await cfg()).hosts.length;

  // --- test before saving ---
  let r = await req('POST', '/api/admin/test-connection', { ...idrac, secret: 'calvin' });
  ok(r.json.ok && /R730xd/.test(r.json.info), `test an unsaved iDRAC connection: ${r.json.info || r.json.error}`);
  r = await req('POST', '/api/admin/test-connection', { ...pve, secret: '11111111-2222-3333-4444-555555555555' });
  ok(r.json.ok && JSON.stringify(r.json.nodes) === '["pve1","pve2"]', `Proxmox test lists the nodes (${r.json.nodes})`);
  r = await req('POST', '/api/admin/test-connection', { ...idrac, secret: 'wrong' });
  ok(r.json.ok === false && /401/.test(r.json.error), `wrong password reported: ${r.json.error}`);
  noSecrets(r.text, 'failed test response');
  r = await req('POST', '/api/admin/test-connection', { ...idrac });
  ok(r.status === 400 && /Enter the/.test(r.json.error), 'testing a new connection needs the secret');
  ok((await cfg()).hosts.length === hostsBefore, 'testing does not store anything');

  // --- one device, two connections ---
  r = await req('POST', '/api/admin/devices', { name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2, connections: [
    { ...idrac, secret: 'calvin' }, { ...pve, secret: '11111111-2222-3333-4444-555555555555' }] });
  ok(r.status === 201 && r.json.device.name === 'Orion', 'device with iDRAC + Proxmox created in one step');
  noSecrets(r.text, 'create device response');
  const orion = r.json.device;
  let c = await cfg();
  const odinHosts = c.hosts.filter((h) => h.deviceId === orion.id);
  ok(odinHosts.length === 2 && odinHosts.every((h) => h.hasSecret && !('secret' in h)), 'both connections stored, secrets write-only');
  noSecrets(JSON.stringify(c), 'admin config');
  r = await req('POST', '/api/admin/devices', { name: 'Twice', kind: 'server', location: 'none', connections: [{ ...idrac, secret: 'x' }, { ...idrac, secret: 'y' }] });
  ok(r.status === 400 && /one connection of each type/.test(r.json.error), 'two connections of the same type rejected');
  r = await req('POST', '/api/admin/devices', { name: 'Clash', kind: 'server', location: 'rack', u: 11, height: 1 });
  ok(r.status === 400 && /overlaps Orion/.test(r.json.error), `overlapping placement rejected: ${r.json.error}`);

  // test an existing connection without retyping the secret
  const idracHost = odinHosts.find((h) => h.type === 'idrac');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: idracHost.id });
  ok(r.json.ok, 'saved connection can be tested without retyping the secret');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: idracHost.id, address: '127.0.0.2:18443' });
  ok(r.status === 400 && /changed/.test(r.json.error), 'changed address + stored secret is not tested (secret never sent elsewhere)');

  await sleep(1500);
  r = await req('GET', '/api/dashboard');
  noSecrets(r.text, 'dashboard data');
  let dev = r.json.devices.find((x) => x.id === orion.id);
  ok(dev && dev.connections.map((x) => x.type).sort().join() === 'idrac,proxmox', 'dashboard: Orion has iDRAC + Proxmox');
  ok(!dev.links.some((l) => l.startsWith('pve:')), 'two nodes and no name match: no node chosen automatically');
  ok(!r.text.includes('127.0.0.1:18443') && !r.text.includes('root@pam'), 'dashboard data has no addresses/user names');

  // choose the node; edit without retyping secrets keeps them
  const conns = c.hosts.filter((h) => h.deviceId === orion.id).map((h) => ({ id: h.id, type: h.type, address: h.address, username: h.username, tlsMode: h.tlsMode, fingerprint: h.fingerprint, options: h.type === 'proxmox' ? { node: 'pve1' } : h.options }));
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { name: 'Orion (R730)', kind: 'server', location: 'rack', u: 10, height: 2, connections: conns });
  ok(r.status === 200 && r.json.device.name === 'Orion (R730)' && !r.json.notes.length, 'rename + choose node; secrets kept');
  await sleep(1200);
  dev = (await req('GET', '/api/dashboard')).json.devices.find((x) => x.id === orion.id);
  ok(dev.links.some((l) => /^pve:.*:pve1$/.test(l)) && dev.connections.find((x) => x.type === 'proxmox').node === 'pve1', 'device now represents node pve1');
  c = await cfg();
  ok(c.hosts.filter((h) => h.deviceId === orion.id).every((h) => h.hasSecret), 'still has both secrets');

  // identity change without secret -> that secret deleted, with a note
  const changed = conns.map((x) => (x.type === 'idrac' ? { ...x, address: '127.0.0.2:18443' } : x));
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { name: 'Orion (R730)', kind: 'server', location: 'rack', u: 10, height: 2, connections: changed });
  ok(r.json.notes.length === 1 && /iDRAC/.test(r.json.notes[0]), `address change deletes only that secret: ${r.json.notes[0]}`);
  c = await cfg();
  ok(c.hosts.find((h) => h.id === idracHost.id).hasSecret === false && c.hosts.find((h) => h.deviceId === orion.id && h.type === 'proxmox').hasSecret, 'iDRAC secret gone, Proxmox secret kept');
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { name: 'Orion (R730)', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ ...conns.find((x) => x.type === 'idrac'), secret: 'calvin' }] });
  c = await cfg();
  ok(c.hosts.filter((h) => h.deviceId === orion.id).map((h) => h.type).join() === 'idrac', 'removing a connection from the device deletes it');
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { name: 'Orion (R730)', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ id: '00000000-0000-0000-0000-000000000000', type: 'idrac' }] });
  ok(r.status === 400 && /Unknown connection/.test(r.json.error), 'connection ids of other devices rejected');

  // --- UniFi: devices appear automatically ---
  r = await req('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'rack', u: 24, height: 1, connections: [
    { type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', tlsMode: 'pin', fingerprint: FP, secret: 'unifipass' }] });
  ok(r.status === 201, 'UDM Pro device with UniFi connection');
  const udmId = r.json.device.id;
  await sleep(2000);
  c = await cfg();
  const udm = c.devices.find((d) => d.id === udmId);
  const sw = c.devices.find((d) => d.discovered && d.kind === 'switch');
  const ap = c.devices.find((d) => d.discovered && d.kind === 'ap');
  ok(udm.unifi && udm.unifi.mac === '74:ac:b9:dd:ee:ff' && udm.estimateW === 25, 'the console itself (UDM Pro) is the gateway it reports; estimate pre-filled');
  ok(sw && sw.name === 'USW-24-POE Rack' && sw.location === 'none' && sw.estimateW === 20, 'switch appeared automatically (not placed, ~20 W)');
  ok(ap && ap.location === 'outside' && ap.estimateW === null, 'access point appeared outside the rack (PoE, no estimate)');
  r = await req('PUT', `/api/admin/devices/${sw.id}/placement`, { location: 'rack', u: 24, height: 1 });
  ok(r.status === 400 && /overlaps UDM Pro/.test(r.json.error), 'placing on an occupied U rejected');
  r = await req('PUT', `/api/admin/devices/${sw.id}/placement`, { location: 'rack', u: 22, height: 1 });
  ok(r.status === 200 && r.json.device.u === 22, 'switch placed at U22');
  r = await req('PUT', `/api/admin/devices/${sw.id}`, { name: 'Core switch', kind: 'switch', location: 'rack', u: 22, height: 1, estimateW: 20 });
  ok(r.status === 200 && r.json.device.name === 'Core switch', 'discovered device renamed');
  r = await req('POST', `/api/admin/hosts/${c.hosts.find((h) => h.type === 'unifi').id}/test`, {});
  await sleep(300);
  c = await cfg();
  ok(c.devices.find((d) => d.id === sw.id).name === 'Core switch' && c.devices.filter((d) => d.discovered).length === 4, 'rename survives the next UniFi update; no duplicates (switch, AP and two cameras)');
  r = await req('DELETE', `/api/admin/devices/${ap.id}`);
  ok(r.json.hidden === true, 'deleting a discovered device hides it');
  await req('POST', `/api/admin/hosts/${c.hosts.find((h) => h.type === 'unifi').id}/test`, {});
  c = await cfg();
  ok(c.devices.filter((d) => d.discovered).length === 4 && c.devices.find((d) => d.id === ap.id).hidden, 'hidden device is not re-created');
  r = await req('GET', '/api/dashboard');
  ok(!r.json.devices.some((d) => d.id === ap.id), 'hidden device not on the dashboard');
  r = await req('PUT', `/api/admin/devices/${ap.id}`, { name: ap.name, kind: 'ap', location: 'outside', height: 1, estimateW: null, hidden: false });
  ok(r.status === 200 && r.json.device.hidden === false, 'shown again');

  // --- power ---
  r = await req('GET', '/api/dashboard');
  const p = r.json.power;
  ok(Math.abs(p.measured.poe - 14.05) < 0.01, `PoE measured (${p.measured.poe} W)`);
  ok(p.estimatedW === 45, `estimates: UDM 25 + switch 20 = ${p.estimatedW} W (Orion has an iDRAC, so not estimated)`);

  // --- rack settings ---
  r = await req('PUT', '/api/admin/rack', { enabled: true, units: 20, numbering: 'bottom' });
  ok(r.status === 400 && /move it before shrinking/.test(r.json.error), 'cannot shrink the rack below a device');
  r = await req('PUT', '/api/admin/rack', { enabled: true, units: 24, numbering: 'top' });
  ok(r.status === 200 && r.json.rack.numbering === 'top', 'rack settings saved');

  // --- delete device -> its connections go too ---
  const before = (await cfg()).hosts.length;
  r = await req('DELETE', `/api/admin/devices/${orion.id}`);
  c = await cfg();
  ok(r.status === 200 && c.hosts.length === before - 1 && !c.devices.some((d) => d.id === orion.id), 'deleting a device deletes its connections');
  noSecrets(JSON.stringify(c), 'admin config at the end');

  // two connections to the same Proxmox cluster: each VM is listed once on the Services page
  await req('POST', '/api/admin/devices', { name: 'Second node', kind: 'server', location: 'none', connections: [{ ...pve, options: { node: 'pve2' }, secret: '11111111-2222-3333-4444-555555555555' }] });
  await sleep(1500);
  r = await req('GET', '/api/vms');
  const vmids = r.json.items.map((g) => `${g.node}/${g.vmid}`);
  ok(vmids.length > 0 && new Set(vmids).size === vmids.length, `VMs listed once across connections (${vmids.join(', ')})`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DEVICE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
