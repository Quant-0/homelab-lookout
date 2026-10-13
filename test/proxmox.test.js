'use strict';
// More from Proxmox: storage, ZFS, SMART, backup jobs, container disks, traffic, and inside VMs
// through the QEMU guest agent.
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

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const cfg = (await req('GET', '/api/admin/config')).json;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, refreshSeconds: 10 } });

  const orion = (await req('POST', '/api/admin/devices', { name: 'orion', kind: 'server', location: 'none', connections: [
    { type: 'proxmox', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'root@pam!dash', secret: '11111111-2222-3333-4444-555555555555', options: { node: 'pve1' } },
  ] })).json.device;
  ok(orion?.id, 'a Proxmox node');

  // the details come in the background after a poll; traffic needs two polls
  const pve = await until(async () => {
    const h = (await req('GET', '/api/dashboard')).json.proxmox?.[0];
    return h?.data?.nodes?.[0]?.disks && h.data.guests.find((g) => g.vmid === 100)?.rxBps != null ? h : null;
  }, 40000);
  ok(pve, 'details and traffic arrive');
  const d = pve?.data || { nodes: [], guests: [], storage: [], backups: [] };

  ok(JSON.stringify(d.storage.map((s) => s.name)) === '["nas","local","local-zfs"]' && d.storage.find((s) => s.name === 'nas').node === null, `storage, a shared one listed once (${d.storage.map((s) => s.name)})`);
  const n1 = d.nodes.find((n) => n.name === 'pve1');
  ok(n1.disks?.length === 3 && n1.disks[0].wearLeft === 8 && n1.disks[1].wearLeft === null && n1.disks[1].health === 'FAILED', 'node disks with SMART health and wear');
  ok(n1.zfs?.map((z) => `${z.name}:${z.health}`).join() === 'rpool:ONLINE,tank:DEGRADED', 'ZFS pools with their health');
  ok(d.backups.length === 1 && d.backups[0].node === 'pve1' && !d.backups[0].ok && d.backups[0].status === 'job errors', 'the last backup job per node');

  const ct = d.guests.find((g) => g.vmid === 101);
  const vm = d.guests.find((g) => g.vmid === 100);
  const off = d.guests.find((g) => g.vmid === 102);
  ok(ct.disk === 7.6e9 && ct.maxdisk === 8e9 && vm.disk === null, "a container's root disk; a VM's is unknown to Proxmox");
  ok(Math.abs(vm.rxBps - 1.25e6) < 2e5 && Math.abs(vm.txBps - 0.25e6) < 1e5 && vm.readBps > 0, `traffic per second from the counters (${Math.round(vm.rxBps)} B/s in)`);
  ok(off.rxBps === null && off.agent === null, 'a stopped VM has neither');
  ok(vm.agent?.running === true && vm.agent.fs.map((f) => f.mount).join() === '/,/srv/data', `guest agent filesystems, without tmpfs and /boot/efi (${vm.agent?.fs?.map((f) => f.mount)})`);
  ok(vm.agent.ips.join() === '192.168.1.50' && vm.agent.os === 'Debian GNU/Linux 12 (bookworm)', 'guest agent addresses and OS');

  const att = (await req('GET', '/api/dashboard')).json.attention;
  const has = (re, sev) => att.some((a) => re.test(`${a.subject}: ${a.text}`) && (!sev || a.severity === sev));
  ok(has(/^orion: docker's disk is 95 % full$/, 'warning'), 'a full container disk');
  ok(has(/^orion: truenas \/srv\/data is 94 % full$/, 'warning'), 'a full filesystem inside a VM');
  ok(has(/^orion: storage nas is 93 % full$/, 'warning') && !has(/storage local is/), 'a full Proxmox storage');
  ok(has(/^orion: ZFS pool tank is degraded$/, 'warning'), 'a degraded ZFS pool');
  ok(has(/^orion: disk \/dev\/sda failed its SMART check$/, 'critical'), 'a disk that failed SMART');
  ok(has(/^orion: SSD \/dev\/nvme0n1 is worn out \(8 % left\)$/, 'warning'), 'a worn-out SSD');
  ok(has(/^orion: Proxmox backup failed$/, 'critical'), 'a failed backup job');

  const svc = (await req('GET', '/api/services')).json;
  const card = (await req('GET', '/api/vms')).json.items.find((g) => g.vmid === 100);
  ok(card?.disk?.mount === '/srv/data' && card.agent.ips[0] === '192.168.1.50' && /^https:\/\/127\.0\.0\.1:18443\/#v1:0:=qemu%2F100$/.test(card.proxmoxUrl), 'the VMs page has its fullest disk, address and a link into Proxmox');
  ok(!svc.groups.some((g) => g.key === '@vms') && svc.vmCount === 3, 'the Services page has no VM group any more');
  // the newest backup of each VM, from the backup storages (a PBS one shared by every node)
  const b100 = card.backup;
  const b101 = (await req('GET', '/api/vms')).json.items.find((g) => g.vmid === 101).backup;
  const b102 = (await req('GET', '/api/vms')).json.items.find((g) => g.vmid === 102).backup;
  ok(b100?.count === 3 && b100.storage === 'pbs' && b100.verified === 'ok' && Date.now() - b100.last < 2 * 86400e3, `backups per VM (${JSON.stringify(b100)})`);
  // VM 102's files aren't listed (as for a read-only token); its backup job's log says when and where
  ok(b102?.fromLog === true && b102.storage === 'nfs-dump' && Math.abs(Date.now() - 90000e3 - b102.last) < 120e3 && b102.failedAt > b102.last, `a backup read from the job log, with the newer failed attempt (${JSON.stringify(b102)})`);
  const att2 = (await req('GET', '/api/dashboard')).json.attention;
  ok(att2.some((a) => /^docker last backed up 10 days ago$/.test(a.text) && a.severity === 'warning' && /its backup job runs every 7 days$/.test(a.detail)) && !att2.some((a) => /truenas last backed up|win11 last backed up/.test(a.text)), 'overdue against its job (weekly: after 8 days); one never backed up is not alerted');
  ok(b100.job?.every === 1 && b100.job.schedule === '02:00' && b100.job.nextRun > Date.now() && b102.job === null, `each VM's backup job and how often it runs (${JSON.stringify(b100.job)})`);
  const where = (await req('GET', '/api/vms')).json.backupStorages;
  ok(where.map((x) => `${x.name}:${x.count}`).join() === 'pbs:3,local:1', `it says where it looked for backups (${JSON.stringify(where)})`);

  const docs = (await req('GET', '/api/docs')).json;
  const sheet = docs.auto.devices.find((x) => x.id === orion.id);
  ok(sheet && sheet.vms.find((g) => g.vmid === 100)?.os === 'Debian GNU/Linux 12 (bookworm)' && sheet.pools.includes('tank: DEGRADED (ZFS)') && sheet.disks.some((x) => x.startsWith('/dev/sda: WDC WD40EFRX')), 'the Docs sheet lists VM addresses, ZFS pools and disks');

  const h = (await req('GET', `/api/history?keys=pveg:${pve.id}:100:rx,pveg:${pve.id}:100:write`)).json.series;
  ok(h[`pveg:${pve.id}:100:rx`]?.length > 0 && h[`pveg:${pve.id}:100:write`]?.length > 0, 'guest traffic is kept as history');

  // a Proxmox card on the Services page, from the connection above
  const srcs = (await req('GET', '/api/admin/services')).json.sources;
  const src = srcs.find((x) => x.type === 'proxmox');
  ok(src?.web === 'https://127.0.0.1:18443', `the card suggests the Proxmox web address (${src?.web})`);
  let r = await req('POST', '/api/admin/services', { name: 'Proxmox', group: 'Infrastructure', href: src.web, icon: { kind: 'letter' }, connection: null, integration: { type: 'proxmox', options: { device: src.id } } });
  ok(r.status === 201, `a Proxmox card without its own login (${r.json?.error || ''})`);
  const pcard2 = await until(async () => (await req('GET', '/api/services')).json.groups.flatMap((g) => g.services || g.items || []).find((x) => x.name === 'Proxmox' && x.stats));
  ok(pcard2 && pcard2.href === 'https://127.0.0.1:18443/' && pcard2.stats.map((x) => x.label).join() === 'VMs running,CPU,Memory' && pcard2.stats[0].value === '2/3', `its numbers and link (${JSON.stringify(pcard2?.stats)})`);

  // a public dashboard shows the numbers, not the addresses, OS or serial numbers
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, refreshSeconds: 10, public: true } });
  const saved = cookie;
  cookie = '';
  const pub = (await req('GET', '/api/dashboard')).json.proxmox[0].data;
  const pvm = pub.guests.find((g) => g.vmid === 100);
  ok(pvm.agent.fs.length === 2 && pvm.agent.ips.length === 0 && pvm.agent.os === null && pub.nodes[0].disks.every((x) => !('serial' in x)), 'visitors see no VM addresses, OS or disk serials');
  const pcard = (await req('GET', '/api/vms')).json.items.find((g) => g.vmid === 100);
  ok(pcard && pcard.agent.ips.length === 0 && pcard.agent.os === null && pcard.proxmoxUrl === null, '…nor on the VMs page, and no links into Proxmox');
  cookie = saved;

  console.log(failures ? `\n${failures} FAILED` : '\nALL PROXMOX TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
