'use strict';
// Containers: a Docker host through a socket proxy, and a Portainer environment. State, health,
// restarts and CPU/memory are read; a container's environment (often passwords) never leaves.
const http = require('node:http');
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
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}

// --- a Docker API like the one behind a socket proxy (CONTAINERS=1, read only) ---
const SECRET_ENV = 'DB_PASSWORD=supersecret-in-env';
const C = [
  { id: 'a1', name: 'web', state: 'running', status: 'Up 2 hours (healthy)', health: 'healthy', restarts: 0, policy: 'unless-stopped' },
  { id: 'b2', name: 'db', state: 'running', status: 'Up 2 hours (unhealthy)', health: 'unhealthy', restarts: 1, policy: 'always' },
  { id: 'c3', name: 'flappy', state: 'restarting', status: 'Restarting (1) 5 seconds ago', restarts: 12, policy: 'always' },
  { id: 'd4', name: 'crashed', state: 'exited', status: 'Exited (1) 3 minutes ago', exitCode: 1, policy: 'always' },
  { id: 'e5', name: 'stopped-by-hand', state: 'exited', status: 'Exited (143) 1 hour ago', exitCode: 143, policy: 'unless-stopped' },
  { id: 'f6', name: 'oneshot', state: 'exited', status: 'Exited (0) 1 day ago', exitCode: 0, policy: 'no' },
  { id: 'g7', name: 'ignored', state: 'restarting', status: 'Restarting (2) 1 second ago', restarts: 40, policy: 'always', ignore: true },
];
let cpuTotal = 0;
let sysTotal = 0;
function dockerApi(prefix = '') {
  return (q, res) => {
    const json = (code, o) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));
    const u = q.url.startsWith(prefix) ? q.url.slice(prefix.length) : null;
    if (u === null) return json(404, { message: 'no' });
    if (u === '/version') return json(200, { Version: '27.3.1', Os: 'linux' });
    if (u === '/containers/json?all=1') return json(200, C.map((c) => ({ Id: `${c.id}`.padEnd(64, '0'), Names: [`/${c.name}`], Image: `lab/${c.name}:latest`, State: c.state, Status: c.status, Created: 1790000000, Labels: { 'com.docker.compose.project': 'lab', 'com.docker.compose.service': c.name, ...(c.ignore ? { 'lookout.ignore': 'true' } : {}) } })));
    const m = /^\/containers\/([0-9a-z]+)\/(json|stats\?stream=false&one-shot=true)$/.exec(u);
    const c = m && C.find((x) => `${x.id}`.padEnd(64, '0') === m[1]);
    if (!c) return json(404, { message: 'No such container' });
    if (m[2] === 'json') return json(200, { State: { Status: c.state, ExitCode: c.exitCode ?? 0, OOMKilled: false, StartedAt: new Date(Date.now() - 7200e3).toISOString(), ...(c.health ? { Health: { Status: c.health } } : {}) }, RestartCount: c.restarts ?? 0, HostConfig: { RestartPolicy: { Name: c.policy } }, Config: { Env: [SECRET_ENV, 'PATH=/usr/bin'] } });
    cpuTotal += 5e8;
    sysTotal += 2e9;
    return json(200, { cpu_stats: { cpu_usage: { total_usage: cpuTotal }, system_cpu_usage: sysTotal, online_cpus: 4 }, memory_stats: { usage: 300e6, limit: 2e9, stats: { inactive_file: 100e6 } } });
  };
}
const servers = [
  http.createServer(dockerApi()).listen(18471, '127.0.0.1'),
  // a socket proxy without CONTAINERS=1
  http.createServer((q, res) => res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden')).listen(18472, '127.0.0.1'),
  // Portainer: environments, and the Docker API of environment 2 behind the access token
  http.createServer((q, res) => {
    if (q.headers['x-api-key'] !== 'ptr_token_123') return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"Unauthorized"}');
    if (q.url === '/api/endpoints') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{ Id: 2, Name: 'skadi' }]));
    return dockerApi('/api/endpoints/2/docker')(q, res);
  }).listen(18473, '127.0.0.1'),
];

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, refreshSeconds: 10 } });

  // --- testing the connections ---
  let r = await req('POST', '/api/admin/test-connection', { type: 'docker', address: '127.0.0.1:18471' });
  ok(r.json?.ok && r.json.info === '2 of 7 containers running · Docker 27.3.1', `Docker through the socket proxy (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'docker', address: '127.0.0.1:18472' });
  ok(r.json?.ok === false && /CONTAINERS=1/.test(r.json.error), `a proxy without container access says what to set (${r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'portainer', address: 'http://127.0.0.1:18473', secret: 'wrong' });
  ok(r.json?.ok === false && /refused the access token/.test(r.json.error), 'Portainer: a wrong token');
  r = await req('POST', '/api/admin/test-connection', { type: 'portainer', address: 'http://127.0.0.1:18473', secret: 'ptr_token_123' });
  ok(r.json?.ok && r.json.info === 'skadi: 2 of 7 containers running', `Portainer, its first environment (${r.json?.info || r.json?.error})`);
  r = await req('POST', '/api/admin/test-connection', { type: 'portainer', address: 'http://127.0.0.1:18473', username: '2', secret: 'ptr_token_123' });
  ok(r.json?.ok, 'Portainer, environment 2 by its ID');
  r = await req('POST', '/api/admin/test-connection', { type: 'portainer', address: 'http://127.0.0.1:18473', username: 'two', secret: 'ptr_token_123' });
  ok(r.status === 400 && /Environment ID/.test(r.json.error), 'the environment ID is a number');

  // --- a Docker host ---
  const dev = (await req('POST', '/api/admin/devices', { name: 'skadi', kind: 'server', location: 'none', connections: [{ type: 'docker', address: '127.0.0.1:18471' }] })).json.device;
  const host = (await req('GET', '/api/admin/config')).json.hosts.find((h) => h.deviceId === dev.id);
  // CPU needs two readings: wait for the second poll
  const d = await until(async () => {
    const x = (await req('GET', '/api/dashboard')).json;
    return x.docker?.[0]?.data?.containers?.find((c) => c.name === 'web')?.cpu != null && x;
  }, 40000);
  const list = d?.docker?.[0]?.data?.containers || [];
  const web = list.find((c) => c.name === 'web');
  ok(list.length === 7 && web && web.state === 'running' && web.health === 'healthy' && web.policy === 'unless-stopped' && web.project === 'lab', `the containers with state, health and restart policy (${list.length})`);
  ok(web && web.cpu === 1 && web.cpus === 4 && web.memUsed === 200e6 && web.memLimit === 2e9, `CPU like docker stats (100 % = one core: ${web?.cpu}) and memory without the file cache`);
  ok(!JSON.stringify(d).includes('supersecret') && !(await req('GET', '/api/vms')).text.includes('supersecret'), 'the environment from inspect never leaves the server');

  const att = d.attention.filter((a) => a.deviceId === dev.id).map((a) => `${a.severity}:${a.text}`);
  ok(att.includes('critical:flappy keeps restarting') && att.includes('critical:crashed stopped') && att.includes('warning:db is unhealthy'), `problems: restarting, crashed, unhealthy (${att.join(' | ')})`);
  ok(!att.some((t) => /stopped-by-hand|oneshot|ignored|web/.test(t)), 'no alert for one stopped by hand, a finished job, an ignored one or a healthy one');

  const vms = (await req('GET', '/api/vms')).json;
  ok(vms.containers.length === 7 && vms.containers[0].hostName === 'skadi' && vms.containerHosts[0].ip === '127.0.0.1' && vms.proxmox === false, 'the VMs page gets the containers, also without Proxmox');
  await sleep(500);
  const h = (await req('GET', `/api/history?keys=ctr:${host.id}:web:cpu,ctr:${host.id}:web:mem`)).json.series;
  ok(h[`ctr:${host.id}:web:cpu`]?.at(-1)?.[1] === 100 && h[`ctr:${host.id}:web:mem`]?.at(-1)?.[1] === 200, 'CPU and memory per container are kept as history');

  // --- Portainer on another device ---
  const dev2 = (await req('POST', '/api/admin/devices', { name: 'fenrir', kind: 'server', location: 'none', connections: [{ type: 'portainer', address: 'http://127.0.0.1:18473', username: '2', secret: 'ptr_token_123' }] })).json.device;
  const p = await until(async () => (await req('GET', '/api/dashboard')).json.portainer?.[0]?.data?.containers?.length === 7);
  ok(p, 'a Portainer environment reads the same containers');
  ok(!(await req('GET', '/api/admin/config')).text.includes('ptr_token_123'), 'the access token is not shown');

  // --- removing the device removes its containers ---
  await req('DELETE', `/api/admin/devices/${dev.id}`);
  await req('DELETE', `/api/admin/devices/${dev2.id}`);
  const after = (await req('GET', '/api/vms')).json;
  ok(!after.containers?.length && !(await req('GET', '/api/dashboard')).json.attention.some((a) => /flappy|crashed/.test(a.text)), 'deleting the hosts removes their containers and problems');

  for (const s of servers) s.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL DOCKER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
