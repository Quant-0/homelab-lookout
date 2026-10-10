'use strict';
// Patch cables in the rack: port to port between devices and patch panels, with a colour and a label.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
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
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  let r = await req('POST', '/api/admin/devices', { name: 'gw', kind: 'gateway', location: 'rack', u: 12, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', secret: 'unifipass', tlsMode: 'pin', fingerprint: FP }] });
  const gw = r.json.device;
  r = await req('POST', '/api/admin/devices', { name: 'box', kind: 'server', location: 'outside' });
  const outside = r.json.device;
  r = await req('POST', '/api/admin/rack/passive', { kind: 'patch', u: 11, height: 1, ports: 24 });
  ok(r.status === 201, `a patch panel at U11 (${r.json?.error || ''})`);
  const pp = r.json.item;

  r = await req('PUT', '/api/admin/cables', { cables: [{ a: { item: gw.id, port: 'rj1' }, b: { item: pp.id, port: 'pp1' }, color: 'yellow', label: ' uplink ' }] });
  ok(r.status === 200 && r.json.cables.length === 1 && r.json.cables[0].color === 'yellow' && r.json.cables[0].label === 'uplink', 'a cable from a gateway port to a patch panel port');
  const one = r.json.cables[0];
  let d = (await req('GET', '/api/dashboard')).json;
  ok(d.cables.length === 1 && d.cables[0].id === one.id, 'the dashboard gets the cables');
  ok(d.wall.cables === false, 'the wall shows no cables until switched on');

  for (const [what, list] of [
    ['a port used twice', [one, { a: { item: gw.id, port: 'rj1' }, b: { item: pp.id, port: 'pp2' } }]],
    ['a port to itself', [{ a: { item: gw.id, port: 'rj2' }, b: { item: gw.id, port: 'rj2' } }]],
    ['a device outside the rack', [{ a: { item: outside.id, port: 'rj1' }, b: { item: pp.id, port: 'pp3' } }]],
    ['an unknown port name', [{ a: { item: gw.id, port: 'x<1>' }, b: { item: pp.id, port: 'pp3' } }]],
  ]) {
    r = await req('PUT', '/api/admin/cables', { cables: list });
    ok(r.status === 400, `refused: ${what}`);
  }
  r = await req('PUT', '/api/admin/cables', { cables: [{ ...one, color: 'hotpink' }] });
  ok(r.status === 200 && r.json.cables[0].color === 'blue', 'an unknown colour becomes blue');

  const ev = (await req('GET', '/api/admin/events?cat=devices')).json.events;
  ok(ev.some((e) => /^Patch cable added: gw Port 1 → Patch panel U11 port 1$/.test(e.text) || /^Patch cable added: gw port 1 → Patch panel U11 port 1$/.test(e.text)) && ev.some((e) => /^Patch cable changed/.test(e.text)), 'adding and changing cables is in the log');

  // a removed panel takes its cables with it
  await req('DELETE', `/api/admin/rack/passive/${pp.id}`);
  d = (await req('GET', '/api/dashboard')).json;
  ok(d.cables.length === 0, 'removing the patch panel removes its cables');

  const saved = cookie;
  cookie = '';
  r = await req('PUT', '/api/admin/cables', { cables: [] });
  ok(r.status === 401 || r.status === 403, 'only an admin can patch');
  cookie = saved;

  console.log(failures ? `\n${failures} FAILED` : '\nALL CABLE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
