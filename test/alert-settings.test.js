'use strict';
// Alert settings on one device or service: limits of its own (instead of the ones under Alerts)
// and muting (problems still show; no messages). Uses the Proxmox mock, whose storage is 93-95 %
// full, and a webhook to see what is sent. Runs with OFFLINE_GRACE_S=0.
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
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}
const sent = [];
const hook = http.createServer((q, res) => {
  let b = '';
  q.on('data', (c) => (b += c));
  q.on('end', () => {
    sent.push(...JSON.parse(b).alerts);
    res.writeHead(200).end('{}');
  });
}).listen(18478, '127.0.0.1');
const sentAbout = (re) => sent.filter((a) => a.event === 'fired' && re.test(a.title));

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const cfg = (await req('GET', '/api/admin/config')).json;
  ok(cfg.alertLimits?.pct === 90 && cfg.alertLimits.diskC === 55 && cfg.alertLimits.otherC === 80, 'Admin gets the general limits (shown greyed on a device)');
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, refreshSeconds: 10 } });
  const ch = (await req('POST', '/api/admin/alerts/channels', { type: 'webhook', name: 'hook', secret: 'http://127.0.0.1:18478/x' })).json.channel;
  const rules = (await req('GET', '/api/admin/alerts')).json.rules;
  for (const k of Object.keys(rules)) rules[k] = { ...rules[k], enabled: ['space', 'service', 'offline'].includes(k), delay: 0, channels: [ch.id] };
  await req('PUT', '/api/admin/alerts', { rules, settings: { resolved: false, repeatHours: 0 } });

  const conn = { type: 'proxmox', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } };
  const base = { name: 'orion', kind: 'server', location: 'none', estimateW: null };
  let r = await req('POST', '/api/admin/devices', { ...base, connections: [conn], alerts: { spacePct: 30 } });
  ok(r.status === 400 && /Full at/.test(r.json.error), `a limit is checked (${r.json?.error})`);
  r = await req('POST', '/api/admin/devices', { ...base, connections: [conn], alerts: { mute: false, spacePct: '', diskC: null } });
  const orion = r.json.device;
  ok(r.status === 201 && orion.alerts === null, 'all empty: nothing stored');
  const space = async () => (await req('GET', '/api/dashboard')).json.attention.filter((a) => a.type === 'space' && a.deviceId === orion.id);

  // the general 90 %: three things are too full, and messages go out
  ok((await until(async () => (await space()).length === 3)), 'at the general 90 %: three are too full');
  ok(await until(() => sentAbout(/orion: .* full/).length === 3, 15000), 'and three messages are sent');

  // its own 99 %: none
  const conns = (await req('GET', '/api/admin/config')).json.hosts.filter((h) => h.deviceId === orion.id).map((h) => ({ id: h.id, type: h.type, address: h.address, username: h.username, tlsMode: h.tlsMode, fingerprint: h.fingerprint, options: h.options }));
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { ...base, connections: conns, alerts: { mute: false, spacePct: 99, diskC: 60, otherC: null } });
  ok(r.status === 200 && r.json.device.alerts.spacePct === 99 && r.json.device.alerts.diskC === 60 && r.json.device.alerts.otherC === null, 'its own limits are saved');
  ok(await until(async () => (await space()).length === 0), 'at its own 99 %: nothing is too full');
  ok(await until(async () => !(await req('GET', '/api/admin/alerts')).json.active.some((a) => /orion/.test(a.title))), 'and the alerts clear');
  ok(/"spacePct":99/.test((await req('GET', '/api/dashboard')).text), 'the device details know its limits');

  // its own 50 % and muted: the problems show, but nothing is sent
  const before = sent.length;
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { ...base, connections: conns, alerts: { mute: true, spacePct: 50 } });
  const muted = await until(async () => {
    const a = await space();
    return a.length >= 3 && a.every((x) => x.muted) && a;
  });
  ok(muted, 'muted: the problems still show on Home, marked muted');
  await sleep(12000);
  ok(sent.length === before, `and no message is sent (${sent.length - before})`);
  const waiting = (await req('GET', '/api/admin/alerts')).json.active.filter((a) => /orion/.test(a.title));
  ok(!waiting.length, `nothing waits to be sent either (${waiting.map((a) => a.title)})`);

  // a service on the muted device is muted too; a muted service on its own
  const svc = (await req('POST', '/api/admin/services', { name: 'Jellyfin', group: 'Media', icon: { kind: 'letter' }, connection: null, integration: null, deviceId: orion.id, monitor: { type: 'ping', host: '192.0.2.51' } })).json.service;
  const plex = (await req('POST', '/api/admin/services', { name: 'Plex', group: 'Media', icon: { kind: 'letter' }, connection: null, integration: null, deviceId: null, muted: true, monitor: { type: 'ping', host: '192.0.2.52' } })).json.service;
  const down = await until(async () => {
    const a = (await req('GET', '/api/dashboard')).json.attention.filter((x) => x.serviceId === svc.id || x.serviceId === plex.id);
    return a.length === 2 && a;
  });
  ok(down && down.every((x) => x.muted), 'a service on a muted device, and a muted service: shown, marked muted');
  await sleep(11000);
  ok(!sentAbout(/Jellyfin|Plex/).length, 'neither sends a message');
  ok(plex.muted === true && (await req('GET', '/api/admin/services')).json.services.find((x) => x.id === plex.id).muted === true, 'the service keeps the setting');

  // unmuted: the messages go out
  r = await req('PUT', `/api/admin/devices/${orion.id}`, { ...base, connections: conns, alerts: { mute: false, spacePct: 50 } });
  ok(await until(() => sentAbout(/orion: .* full/).length >= 6 && sentAbout(/Jellyfin/).length === 1, 20000), 'unmuted, the device and its service alert again');
  ok(!sentAbout(/Plex/).length, 'the muted service stays quiet');

  hook.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL ALERT SETTINGS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
