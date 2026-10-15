'use strict';
// The Linux agent: the real shell script reports to the dashboard (its config and state in a temp
// folder instead of /etc and /var/lib), the panel's settings come back in the answer, and the data
// shows on the device, in alerts and in Updates. Also: tokens, junk in a report, uninstalling, and
// an agent inside a Proxmox VM.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const SCRIPT = path.join(__dirname, '..', 'public', 'agent', 'lookout-agent.sh');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body, headers = {}) {
  const h = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers };
  const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
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
// the agent, run like the timer would, with its own config file
function agent(dir, cmd) {
  try {
    return { ok: true, out: execFileSync('sh', [SCRIPT, cmd], { env: { ...process.env, LOOKOUT_AGENT_CONF: path.join(dir, 'agent.conf'), LOOKOUT_AGENT_STATE: dir }, encoding: 'utf8', timeout: 60000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
const send = (id, token, report) => fetch(`${BASE}/agent/report`, { method: 'POST', headers: { Authorization: `Bearer ${id}.${token}`, 'Content-Type': 'application/json', Accept: 'text/plain' }, body: JSON.stringify(report) });

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, refreshSeconds: 10 } });

  // --- on the panel ---
  let r = await req('POST', '/api/admin/agents', { name: 'pi', attach: 'new', watch: 'nginx; rm -rf /', interval: 30 });
  ok(r.status === 400 && /systemd unit name/.test(r.json.error), 'a service to watch must look like a unit name');
  r = await req('POST', '/api/admin/agents', { name: 'pi', attach: 'new', watch: 'no-such-unit.service', interval: 30, updates: true });
  ok(r.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(r.json.token), 'an agent is made, with a token shown once');
  const { id } = r.json.agent;
  const token = r.json.token;
  const cmd = r.json.commands;
  ok(cmd.install.includes(`/agent/install.sh | sudo sh -s -- --id ${id} --token ${token}`) && cmd.uninstall === 'sudo lookout-agent uninstall' && cmd.update === 'sudo lookout-agent update', 'the commands to install, update and remove it');
  let list = (await req('GET', '/api/admin/agents')).json;
  const mine = list.agents.find((a) => a.id === id);
  ok(mine && mine.never && !JSON.stringify(list).includes(token) && !JSON.stringify(list).includes('tokenHash'), 'listed, not reporting yet; the token is never shown again');
  ok((await req('GET', '/api/dashboard')).json.devices.some((d) => d.name === 'pi'), '"A new device" makes the device');

  // --- the scripts the machine downloads ---
  const inst = await fetch(`${BASE}/agent/install.sh`).then((x) => x.text());
  ok(inst.startsWith('#!/bin/sh') && inst.includes(`URL="${BASE}"`) && !inst.includes(token), 'the installer, with this dashboard\'s address (and no secrets)');
  const script = await fetch(`${BASE}/agent/lookout-agent.sh`).then((x) => x.text());
  ok(script === fs.readFileSync(SCRIPT, 'utf8'), 'the agent itself');

  // --- the real script reports ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-agent-'));
  fs.writeFileSync(path.join(dir, 'agent.conf'), `URL=${BASE}\nID=${id}\nTOKEN=${token}\nCA=\nINTERVAL=30\nWATCH="also-missing.service"\nUPDATES=yes\n`);
  let out = agent(dir, 'test');
  ok(out.ok && /Sent/.test(out.out) && /interval=30/.test(out.out) && /watch=no-such-unit\.service/.test(out.out) && /latest=\d/.test(out.out), `the agent sends, and gets the panel's settings back (${out.out.trim().replace(/\n\s*/g, ' | ')})`);
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')).mem.total > 0, 'what it sent is valid JSON');
  await sleep(1200);
  out = agent(dir, 'run');
  ok(out.ok, 'run: within the interval it waits');
  out = agent(dir, 'test');
  const dev = await until(async () => (await req('GET', '/api/dashboard')).json.devices.find((d) => d.name === 'pi' && d.lookout?.[0]?.cpu));
  const a = dev?.lookout?.[0];
  ok(a?.ok && a.mem.total > 0 && a.mem.used > 0 && a.cpu.cores > 0 && a.cpu.load.length === 3 && a.fs.some((f) => f.mount === '/') && a.os, `the device shows it: ${a?.os}, ${a?.cpu?.cores} cores, ${a?.fs?.length} filesystems`);
  ok(a.watched.some((w) => w.unit === 'no-such-unit.service') && a.watched.some((w) => w.unit === 'also-missing.service'), 'services to watch from the panel and from the machine');
  const att = await until(async () => (await req('GET', '/api/dashboard')).json.attention.filter((x) => x.subject === 'pi'));
  ok(att.some((x) => x.text === 'no-such-unit.service is not running' && x.severity === 'critical'), `a watched service that isn't running is a problem (${att.map((x) => x.text).join(' | ')})`);
  const st = agent(dir, 'status');
  ok(/Last report: \d+ s ago/.test(st.out) && /Watching: no-such-unit\.service also-missing\.service/.test(st.out), 'lookout-agent status');
  const upd = (await req('GET', '/api/updates')).json;
  ok(!a.updates || upd.rows.some((x) => x.source === 'agent' && x.name === 'pi'), 'pending updates go to Updates');

  // --- the panel's settings change ---
  r = await req('PUT', `/api/admin/agents/${id}`, { name: 'pi', attach: `device:${dev.id}`, watch: '', interval: 120, updates: false });
  out = agent(dir, 'test');
  ok(/interval=120/.test(out.out) && /updates=no/.test(out.out) && /watch=\n/.test(`${out.out}\n`), 'a change on the panel reaches the agent with its next report');

  // --- what the dashboard refuses ---
  r = await send(id, 'x'.repeat(43), { agent: '1' });
  ok(r.status === 401, 'a wrong token is refused');
  r = await send(id, token, { agent: '9'.repeat(100), hostname: 'h\u0000ost', os: 'x'.repeat(5000), mem: { total: -5, available: 'a lot' }, fs: [{ mount: '/', size: 100, used: 50, inodes: 9999 }, ...Array(100).fill({ mount: '/x', size: 1, used: 1 })], failed: ['ok.service', '../evil;rm'], cpu: { cores: 4, usage: 500, load: [1, 2, 3, 4, 5] }, extra: 'ignored' });
  ok(r.status === 200, 'a report with junk in it is taken, cleaned');
  const dirty = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === dev.id).lookout[0];
  ok(dirty.version.length <= 20 && dirty.os.length <= 80 && dirty.mem.total === null && dirty.fs.length === 30 && dirty.fs[0].inodes === null && dirty.failed.join() === 'ok.service' && dirty.cpu.usage === null && dirty.cpu.load.length === 3, 'every field checked: lengths, numbers, unit names, list sizes');

  // --- a new token, and uninstalling ---
  r = await req('POST', `/api/admin/agents/${id}/token`, {});
  const token2 = r.json.token;
  ok(r.status === 200 && token2 !== token && r.json.commands.install.includes(token2), 'a new token, with a new install command');
  ok((await send(id, token, { agent: '1' })).status === 401 && (await send(id, token2, { agent: '1' })).status === 200, 'the old token stops working');
  r = await fetch(`${BASE}/agent/bye`, { method: 'POST', headers: { Authorization: `Bearer ${id}.${token2}` } });
  list = (await req('GET', '/api/admin/agents')).json;
  ok(r.status === 200 && list.agents.find((x) => x.id === id).removedAt, '"lookout-agent uninstall" tells the panel');

  // --- inside a Proxmox VM ---
  await req('POST', '/api/admin/devices', { name: 'orion', kind: 'server', location: 'none', connections: [{ type: 'proxmox', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } }] });
  const guest = await until(async () => (await req('GET', '/api/admin/agents')).json.guests.find((g) => g.vmid === 100));
  ok(guest && /on orion/.test(`on ${guest.server}`), `the VMs to choose from (${guest?.name} ${guest?.vmid})`);
  r = await req('POST', '/api/admin/agents', { name: 'truenas', attach: guest.attach, interval: 60 });
  const vmAgent = r.json;
  await send(vmAgent.agent.id, vmAgent.token, { agent: '1.0.0', os: 'Debian GNU/Linux 12', mem: { total: 32e9, available: 24e9, cache: 20e9, swapTotal: 0, swapUsed: 0 }, cpu: { cores: 8, usage: 12, load: [0.5, 0.4, 0.3] }, fs: [{ mount: '/', size: 100e9, used: 97e9 }], failed: ['smbd.service'], updates: { count: 5, security: 2, reboot: true, packages: [{ name: 'openssl', version: '3.0.15', security: true }] } });
  const vm = await until(async () => (await req('GET', '/api/vms')).json.items.find((g) => g.vmid === 100 && g.lookout?.ok));
  ok(vm && vm.lookout.mem.used === 8e9 && vm.lookout.name === 'truenas', 'the VM on the VMs page carries what its agent says (8 GB really used, not what Proxmox counts)');
  const vatt = await until(async () => {
    const x = (await req('GET', '/api/dashboard')).json.attention.filter((y) => y.subject === 'truenas');
    return x.length >= 4 && x;
  });
  ok(vatt && ['smbd.service failed', '2 security updates waiting', 'needs a reboot', '/ is 97 % full'].every((t) => vatt.some((x) => x.text === t)), `problems named after the VM: ${vatt?.map((x) => x.text).join(' | ')}`);
  ok((await req('GET', '/api/updates')).json.rows.some((x) => x.source === 'agent' && x.name === 'truenas' && x.available && /2 security · reboot needed/.test(x.detail) && x.list[0].name === 'openssl (security)'), 'its updates in Updates, with the package list');

  // --- removing it on the panel ---
  await req('DELETE', `/api/admin/agents/${vmAgent.agent.id}`);
  ok((await send(vmAgent.agent.id, vmAgent.token, { agent: '1' })).status === 401, 'a removed agent can no longer report');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} FAILED` : '\nALL AGENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
