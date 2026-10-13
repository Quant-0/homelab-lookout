'use strict';
// Stronger checks: a web page with a path, a word it must contain, a JSON value and success-only
// status codes; and a DNS lookup on a chosen server, with an expected address.
const http = require('node:http');
const dgram = require('node:dgram');
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
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

// a web app: a page, a JSON health endpoint, and a login page that answers 401
const web = http.createServer((q, res) => {
  if (q.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Jellyfin</title><p>Welcome</p>');
  if (q.url === '/health') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', data: { health: 'degraded', disks: [{ state: 'online' }] } }));
  if (q.url === '/secure') return res.writeHead(401).end('login');
  res.writeHead(404).end('nope');
}).listen(18474, '127.0.0.1');

// a DNS server: lab.test is 10.1.2.3, anything else does not exist
const dns = dgram.createSocket('udp4');
dns.on('message', (msg, rinfo) => {
  let i = 12;
  const labels = [];
  while (msg[i]) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
  const qEnd = i + 5;
  const name = labels.join('.').toLowerCase();
  const type = msg.readUInt16BE(i + 1);
  const found = name === 'lab.test' && type === 1;
  const head = Buffer.from([msg[0], msg[1], 0x81, found ? 0x80 : name === 'lab.test' ? 0x80 : 0x83, 0, 1, 0, found ? 1 : 0, 0, 0, 0, 0]);
  const answer = found ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 1, 2, 3]) : Buffer.alloc(0);
  dns.send(Buffer.concat([head, msg.subarray(12, qEnd), answer]), rinfo.port, rinfo.address);
});
dns.bind(18475, '127.0.0.1');

const svc = (extra) => ({ name: 'App', group: 'Checks', icon: { kind: 'letter' }, integration: null, connection: { url: 'http://127.0.0.1:18474' }, ...extra });
const test = async (extra) => (await req('POST', '/api/admin/services/test', svc(extra))).json?.check;

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- a web page: more than "it answers" ---
  let c = await test({ monitor: { type: 'http', contains: 'Jellyfin' } });
  ok(c?.up === true && c.code === 200, 'the page contains the word');
  c = await test({ monitor: { type: 'http', contains: 'Plex' } });
  ok(c?.up === false && c.error === 'The answer doesn\'t contain "Plex"', `a missing word is down: ${c?.error}`);
  c = await test({ monitor: { type: 'http', path: '/health', jsonPath: 'status', jsonEquals: 'ok' } });
  ok(c?.up === true, 'a JSON value that matches');
  c = await test({ monitor: { type: 'http', path: '/health', jsonPath: 'data.health', jsonEquals: 'green' } });
  ok(c?.up === false && c.error === 'data.health is degraded, expected green', `a JSON value that doesn't: ${c?.error}`);
  c = await test({ monitor: { type: 'http', path: '/health', jsonPath: 'data.disks[0].state', jsonEquals: '' } });
  ok(c?.up === true, 'a path into a list; "equals" empty = it only has to be there');
  c = await test({ monitor: { type: 'http', path: '/health', jsonPath: 'data.missing' } });
  ok(c?.up === false && /No data.missing/.test(c.error), 'a value that isn\'t there');
  c = await test({ monitor: { type: 'http', path: '/secure' } });
  ok(c?.up === true && c.code === 401, 'by default a login page (401) counts as up');
  c = await test({ monitor: { type: 'http', path: '/secure', okStatus: 'success' } });
  ok(c?.up === false && c.code === 401, '"only success": a 401 is down');
  for (const [what, monitor] of [['a path without /', { type: 'http', path: 'health' }], ['a broken JSON path', { type: 'http', jsonPath: 'a..b' }]]) {
    const r = await req('POST', '/api/admin/services', svc({ monitor }));
    ok(r.status === 400, `refused: ${what}`);
  }
  let r = await req('POST', '/api/admin/services', svc({ connection: null, monitor: { type: 'http', contains: 'x' } }));
  ok(r.status === 400 && /needs the connection URL/.test(r.json.error), 'a web page check needs the URL');
  r = await req('POST', '/api/admin/services', svc({ monitor: { type: 'http', path: '/health', jsonPath: 'status', jsonEquals: 'ok', okStatus: 'success' } }));
  ok(r.status === 201 && r.json.service.monitor.jsonPath === 'status', 'saved with its checks');
  r = await req('POST', '/api/admin/services', svc({ name: 'Plain', monitor: { type: 'http', path: '', contains: '', jsonPath: '', okStatus: 'any' } }));
  ok(r.status === 201 && r.json.service.monitor === null, 'nothing extra: the plain check, as before');

  // --- DNS ---
  const dnsSvc = (monitor) => ({ name: 'Pi-hole', group: 'Checks', icon: { kind: 'letter' }, integration: null, connection: null, monitor });
  c = (await req('POST', '/api/admin/services/test', dnsSvc({ type: 'dns', server: '127.0.0.1:18475', name: 'lab.test' }))).json?.check;
  ok(c?.up === true && c.via === 'dns' && c.answer?.[0] === '10.1.2.3' && typeof c.ms === 'number', `a name that resolves (${c?.answer})`);
  c = (await req('POST', '/api/admin/services/test', dnsSvc({ type: 'dns', server: '127.0.0.1:18475', name: 'lab.test', expect: '10.9.9.9' }))).json?.check;
  ok(c?.up === false && c.error === 'lab.test is 10.1.2.3, expected 10.9.9.9', `the wrong address: ${c?.error}`);
  c = (await req('POST', '/api/admin/services/test', dnsSvc({ type: 'dns', server: '127.0.0.1:18475', name: 'nothing.test' }))).json?.check;
  ok(c?.up === false && /No such name|No address/.test(c.error), `a name that doesn't exist: ${c?.error}`);
  c = (await req('POST', '/api/admin/services/test', dnsSvc({ type: 'dns', server: '127.0.0.1:18476', name: 'lab.test' }))).json?.check;
  ok(c?.up === false && /did not answer|refused|failed/.test(c.error), `a server that doesn't answer: ${c?.error}`);
  for (const [what, monitor] of [['a host name as server', { type: 'dns', server: 'pihole.lan', name: 'x.test' }], ['a bad name', { type: 'dns', server: '127.0.0.1', name: 'a b' }], ['a bad expected address', { type: 'dns', server: '127.0.0.1', name: 'x.test', expect: 'pihole' }]]) {
    r = await req('POST', '/api/admin/services', dnsSvc(monitor));
    ok(r.status === 400, `refused: ${what}`);
  }
  r = await req('POST', '/api/admin/services', dnsSvc({ type: 'dns', server: '127.0.0.1:18475', name: 'lab.test', expect: '10.1.2.3' }));
  ok(r.status === 201 && r.json.service.monitor.type === 'dns', 'a DNS check is saved (no URL needed)');

  web.close();
  dns.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL CHECK TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
