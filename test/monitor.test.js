'use strict';
// Ping and TCP status checks, a "Ping" connection for devices without an API, and certificate expiry.
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
    await sleep(500);
  }
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- devices: a Ping connection ---
  let r = await req('POST', '/api/admin/test-connection', { type: 'ping', address: '127.0.0.1' });
  ok(r.json?.ok === true && /^replies in [\d.]+ ms$/.test(r.json.info), `ping test answers (${r.json?.info || r.json?.error || r.status})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'ping', address: '127.0.0.1:80' });
  ok(r.status === 400 && /without a port/.test(r.json?.error), 'a ping address with a port is refused');
  r = await req('POST', '/api/admin/test-connection', { type: 'ping', address: '-c 1 127.0.0.1' });
  ok(r.status === 400, 'an address that looks like an option is refused');
  r = await req('POST', '/api/admin/test-connection', { type: 'ping', address: '192.0.2.1' });
  ok(r.json?.ok === false && /No reply to ping/.test(r.json.error), `no reply is reported (${r.json?.error})`);
  r = await req('POST', '/api/admin/fingerprint', { type: 'ping', address: '127.0.0.1' });
  ok(r.status === 400, 'ping has no certificate to fetch');

  r = await req('POST', '/api/admin/devices', { name: 'printer', kind: 'other', location: 'outside', connections: [{ type: 'ping', address: '127.0.0.1', username: 'ignored', secret: 'ignored' }] });
  ok(r.status === 201, `a device with only a ping connection (${r.json?.error || ''})`);
  const printer = r.json.device;
  const conn = (await req('GET', '/api/admin/config')).json.hosts.find((h) => h.deviceId === printer.id);
  ok(conn?.type === 'ping' && conn.address === '127.0.0.1' && conn.username === '' && !conn.hasSecret, 'it stores no user name and no secret');
  const pinged = await until(async () => (await req('GET', '/api/dashboard')).json.ping?.find((h) => h.id === conn.id && h.ok));
  ok(pinged && typeof pinged.data.ms === 'number' && pinged.data.loss === 0, 'the dashboard shows the response time');

  r = await req('POST', '/api/admin/devices', { name: 'gone', kind: 'other', location: 'outside', connections: [{ type: 'ping', address: '192.0.2.1' }] });
  const gone = r.json.device;
  const offline = await until(async () => (await req('GET', '/api/dashboard')).json.attention.find((a) => a.deviceId === gone.id), 20000);
  ok(offline && offline.text === 'gone is not answering ping' && offline.severity === 'critical', `a host that stops answering is offline (${offline?.text})`);

  // --- services: ping, TCP port and web page with certificate expiry ---
  const svc = (name, extra) => ({ name, group: 'Checks', description: '', href: '', onHome: true, icon: { kind: 'letter' }, connection: null, integration: null, ...extra });
  r = await req('POST', '/api/admin/services/test', svc('p', { monitor: { type: 'ping', host: '127.0.0.1' } }));
  ok(r.json?.check?.up === true && r.json.check.via === 'ping' && typeof r.json.check.ms === 'number', 'a service checked with ping');
  r = await req('POST', '/api/admin/services/test', svc('t', { monitor: { type: 'tcp', host: '127.0.0.1', port: 18080 } }));
  ok(r.json?.check?.up === true && r.json.check.via === 'tcp' && r.json.check.port === 18080, 'a service checked on a TCP port');
  r = await req('POST', '/api/admin/services/test', svc('t', { monitor: { type: 'tcp', host: '127.0.0.1', port: 1 } }));
  ok(r.json?.check?.up === false && r.json.check.via === 'tcp' && r.json.check.error, `a closed port is down (${r.json?.check?.error})`);
  for (const [what, monitor] of [['a port out of range', { type: 'tcp', host: '127.0.0.1', port: 70000 }], ['a host with a path', { type: 'ping', host: '127.0.0.1/x' }], ['no host', { type: 'ping', host: '' }]]) {
    r = await req('POST', '/api/admin/services', svc('bad', { monitor }));
    ok(r.status === 400, `refused: ${what}`);
  }

  r = await req('POST', '/api/admin/services', svc('SSH box', { monitor: { type: 'tcp', host: '127.0.0.1', port: 18080 } }));
  ok(r.status === 201 && r.json.service.monitor?.type === 'tcp', 'a service with only a status check is saved');
  const ssh = r.json.service;
  const card = await until(async () => {
    const s = (await req('GET', '/api/services')).json;
    return s.groups.flatMap((g) => g.services || g.items || []).find((x) => x.id === ssh.id && x.check);
  });
  ok(card?.check?.up === true, 'the Services page shows it as up');

  // the device mock's certificate is valid for 7 days: a warning two weeks before
  r = await req('POST', '/api/admin/services', svc('Web', { connection: { url: 'https://127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP } }));
  ok(r.status === 201, 'an https service');
  const web = r.json.service;
  const cert = await until(async () => (await req('GET', '/api/dashboard')).json.attention.find((a) => a.serviceId === web.id && /certificate/.test(a.text)), 20000);
  ok(cert && cert.severity === 'warning' && cert.subject === 'Web' && /^certificate expires in [67] days$/.test(cert.text) && /^Valid until \d{4}-\d\d-\d\d$/.test(cert.detail), `an expiring certificate is a warning (${cert?.text})`);
  r = await req('POST', '/api/admin/services/test', svc('Web', { connection: { url: 'https://127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP } }));
  ok(typeof r.json?.check?.cert === 'number' && r.json.check.cert > Date.now(), 'the check tells when the certificate expires');

  // switching back to the web page check removes the status check
  r = await req('PUT', `/api/admin/services/${ssh.id}`, { ...svc('SSH box'), monitor: null });
  ok(r.status === 200 && r.json.service.monitor === null, 'the status check can be removed again');

  const hist = (await req('GET', `/api/history?keys=ping:${conn.id}:ms,svc:${ssh.id}:ms`)).json.series;
  ok(Array.isArray(hist[`ping:${conn.id}:ms`]) && hist[`ping:${conn.id}:ms`].length > 0, 'ping response times are kept as history');

  console.log(failures ? `\n${failures} FAILED` : '\nALL MONITOR TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
