'use strict';
// Find devices: a scan of a network recognises what answers, from one look at each page (no logins),
// and says what is already added. Runs with DISCOVER_LOOPBACK=1 and test ports standing in for the
// real ones (DISCOVER_PORTS, DISCOVER_ROLES), served by the mocks below.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
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
const page = (title, extra = {}) => (q, res) => {
  if (extra[q.url]) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(extra[q.url]));
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`);
};
const json = (map) => (q, res) => (map[q.url] ? res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(map[q.url])) : res.writeHead(404).end('not found'));
const cdir = process.env.MOCK_CERT_DIR;
const servers = [
  http.createServer(page('Proxmox Virtual Environment')).listen(18481, '127.0.0.1'),
  http.createServer(page('Grafana')).listen(18482, '127.0.0.1'),
  net.createServer((s) => s.on('data', (d) => /LIST UPS/.test(d) && s.end('BEGIN LIST UPS\nUPS eaton "Eaton 5E"\nEND LIST UPS\n'))).listen(18483, '127.0.0.1'),
  http.createServer(json({ '/version': { ApiVersion: '1.47', Version: '27.3.1' } })).listen(18484, '127.0.0.1'),
  http.createServer(json({ '/shelly': { type: 'SHPLG-S', mac: 'A4CF12345678', model: 'Plug S' } })).listen(18485, '127.0.0.1'),
  http.createServer(json({ '/System/Info/Public': { ProductName: 'Jellyfin Server', ServerName: 'media', Version: '10.10.3' } })).listen(18486, '127.0.0.1'),
  https.createServer({ key: fs.readFileSync(path.join(cdir, 'key.pem')), cert: fs.readFileSync(path.join(cdir, 'cert.pem')) }, json({ '/redfish/v1': { RedfishVersion: '1.17.0', Vendor: 'Dell' } })).listen(18487, '127.0.0.1'),
  http.createServer(page('HP LaserJet')).listen(18488, '127.0.0.1'),
];

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  let r = await req('GET', '/api/admin/discover');
  ok(r.status === 200 && Array.isArray(r.json.defaults) && !r.json.running, `ready, suggesting this server's own networks (${r.json.defaults.join(', ') || 'none here'})`);
  r = await req('POST', '/api/admin/discover', { networks: '8.8.8.0/24' });
  ok(r.status === 400 && /private/.test(r.json.error), 'only private networks');
  r = await req('POST', '/api/admin/discover', { networks: '10.0.0.0/20' });
  ok(r.status === 400 && /\/22/.test(r.json.error), 'at most 1024 addresses');
  r = await req('POST', '/api/admin/discover', { networks: 'nonsense' });
  ok(r.status === 400, 'a range must look like one');

  // already there: a Grafana card
  await req('POST', '/api/admin/services', { name: 'Grafana', group: 'Monitoring', icon: { kind: 'letter' }, connection: { url: 'http://127.0.0.1:18482', tlsMode: 'verify' }, integration: null });

  r = await req('POST', '/api/admin/discover', { networks: '127.0.0.1/32' });
  ok(r.status === 202 && r.json.total === 1, 'a scan starts');
  r = await req('POST', '/api/admin/discover', { networks: '127.0.0.1/32' });
  ok(r.status === 400 && /already running/.test(r.json.error), 'one scan at a time');
  let d;
  for (let i = 0; i < 60; i++) {
    d = (await req('GET', '/api/admin/discover')).json;
    if (!d.running) break;
    await sleep(500);
  }
  ok(!d.running && d.done === 1 && d.found.length === 1, 'the scan finishes');
  const f = d.found[0];
  const by = (port) => f.what.find((w) => w.port === port);
  ok(f.ports.join() === '18481,18482,18483,18484,18485,18486,18487,18488', `the open ports (${f.ports.join(', ')}); a closed one is left out`);
  ok(by(18481)?.kind === 'device' && by(18481).type === 'proxmox' && by(18481).address === '127.0.0.1:18481', 'Proxmox, as a device connection');
  ok(by(18482)?.kind === 'service' && by(18482).type === 'grafana' && by(18482).url === 'http://127.0.0.1:18482', 'Grafana, as a service card');
  ok(by(18483)?.type === 'nut' && by(18483).ups === 'eaton' && /eaton/.test(by(18483).label), 'a NUT server, with its UPS name');
  ok(by(18484)?.type === 'docker' && /27\.3\.1/.test(by(18484).label), 'a Docker API (through a socket proxy)');
  ok(by(18485)?.type === 'shelly' && /Plug S/.test(by(18485).label), 'a Shelly plug');
  ok(by(18486)?.type === 'jellyfin' && by(18486).name === 'media', 'Jellyfin, with its own name');
  ok(by(18487)?.type === 'idrac' && /Dell/.test(by(18487).label) && by(18487).url.startsWith('https://'), 'a Redfish controller over TLS (self-signed)');
  ok(by(18488)?.kind === 'other' && /HP LaserJet/.test(by(18488).label), 'an unknown web page, by its title');
  ok(f.known.services.some((x) => x.name === 'Grafana' && x.port === 18482), 'what is already added is marked');
  const log = (await req('GET', '/api/admin/events')).json.events || [];
  ok(log.some((e) => /Network scan of 127\.0\.0\.1\/32: 1 address answered/.test(e.text)), 'the Log has the scan');

  for (const s of servers) s.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL DISCOVERY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
