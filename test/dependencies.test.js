'use strict';
// Dependencies: a device "reached through" another (chosen, or UniFi's uplink). When that one is
// down, what is behind it is grouped under it and sends no alert of its own.
// Runs with OFFLINE_GRACE_S=0 and CHECKIN_MINUTE_MS=1000.
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
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}
const dev = async (name, address, extra = {}) => (await req('POST', '/api/admin/devices', { name, kind: 'server', location: 'outside', connections: address ? [{ type: 'ping', address }] : [], ...extra })).json.device;
const put = (d, extra) => req('PUT', `/api/admin/devices/${d.id}`, { name: d.name, kind: d.kind, location: 'outside', estimateW: null, ...extra });

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // a switch that is down, a server behind it (down too), one behind it that still answers
  const sw = await dev('core-switch', '192.0.2.10');
  const s1 = await dev('atlas', '192.0.2.11', { parent: sw.id });
  const s2 = await dev('vault', '127.0.0.1', { parent: sw.id });
  ok(sw && s1 && s2, 'a switch and two servers reached through it');
  const svc = (await req('POST', '/api/admin/services', { name: 'Jellyfin', group: 'Media', icon: { kind: 'letter' }, connection: null, integration: null, deviceId: s1.id, monitor: { type: 'ping', host: '192.0.2.12' } })).json.service;
  const ck = (await req('POST', '/api/admin/checkins', { name: 'atlas backup', everyMin: 60, graceMin: 60, deviceId: s1.id })).json.checkin;

  // loops are refused
  let r = await put(sw, { parent: s1.id });
  ok(r.status === 400 && /itself reached through/.test(r.json.error), `no loops: ${r.json?.error}`);
  r = await put(sw, { parent: sw.id });
  ok(r.status === 400, 'a device is not reached through itself');

  // the switch goes down first; then the backup on the server behind it fails too
  await until(async () => (await req('GET', '/api/dashboard')).json.attention.some((x) => x.deviceId === sw.id));
  await fetch(`${BASE}${ck.path}/fail`);
  const att = await until(async () => {
    const a = (await req('GET', '/api/dashboard')).json.attention;
    return a.some((x) => x.deviceId === sw.id) && a.some((x) => x.serviceId === svc.id) && a.some((x) => x.type === 'checkin') && a;
  });
  const root = att.find((a) => a.deviceId === sw.id && a.type === 'offline');
  const behindS1 = att.find((a) => a.deviceId === s1.id && a.type === 'offline');
  const behindSvc = att.find((a) => a.serviceId === svc.id);
  const behindCk = att.find((a) => a.type === 'checkin');
  ok(root && !root.behind && root.behindCount === 3, `the switch is the cause, with 3 behind it (${root?.behindCount})`);
  ok(behindS1?.behind?.name === 'core-switch' && behindSvc?.behind?.name === 'core-switch' && behindCk?.behind?.name === 'core-switch', 'the server, the service on it and its check-in are behind the switch');
  ok(!att.some((a) => a.deviceId === s2.id), 'a server behind it that still answers has no problem');

  await sleep(1500);
  const active = (await req('GET', '/api/admin/alerts')).json.active;
  const sent = active.filter((a) => a.title.startsWith('core-switch') || a.title.startsWith('atlas') || /Jellyfin/.test(a.title));
  ok(sent.length === 1 && sent[0].title.startsWith('core-switch') && /also unreachable: atlas, Jellyfin, atlas backup/.test(sent[0].detail), `one alert, naming what is behind it (${sent.map((a) => `${a.title} — ${a.detail}`).join(' | ')})`);

  const devices = (await req('GET', '/api/dashboard')).json.devices;
  ok(devices.find((d) => d.id === s1.id).reachedThrough === sw.id && devices.find((d) => d.id === s1.id).parent === sw.id, 'the device says what it is reached through');

  // "nothing": then it is its own problem again
  await put(s1, { parent: 'none' });
  const own = await until(async () => (await req('GET', '/api/dashboard')).json.attention.find((a) => a.deviceId === s1.id && a.type === 'offline' && !a.behind));
  ok(own, 'set to "nothing", the server is a problem of its own');
  await put(s1, { parent: sw.id });

  // --- automatic: the uplink UniFi reports (the U7 Pro hangs off the USW) ---
  await req('POST', '/api/admin/devices', { name: 'UDM Pro', kind: 'gateway', location: 'none', connections: [{ type: 'unifi', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'viewer', secret: 'unifipass' }] });
  const ds = await until(async () => {
    const x = (await req('GET', '/api/dashboard')).json.devices;
    return x.some((d) => d.unifi?.mac === '24:5a:4c:11:22:33') && x;
  });
  const ap = ds?.find((d) => d.unifi?.mac === '24:5a:4c:11:22:33');
  const usw = ds?.find((d) => d.unifi?.mac === 'f4:e2:c6:aa:bb:cc');
  ok(ap && usw && ap.parent === null && ap.reachedThrough === usw.id, `automatic: the access point is reached through the switch UniFi names (${ap?.reachedThrough === usw?.id})`);

  // deleting the switch sends what was behind it back to automatic
  await req('DELETE', `/api/admin/devices/${sw.id}`);
  const after = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === s1.id);
  ok(after.parent === null, 'deleting a device clears "reached through" on the ones behind it');

  console.log(failures ? `\n${failures} FAILED` : '\nALL DEPENDENCY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
