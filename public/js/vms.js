'use strict';
// VMs and containers from every Proxmox connection: what runs, how busy and full it is, its address,
// and when it was last backed up. A row opens the details: graphs, filesystems and backups.

const { el, fmt } = HD;
const $ = (id) => document.getElementById(id);
let last = null;
let lastAt = null;
let timer = null;
let loadedOnce = false;
let filter = 'all'; // all | running | stopped | backup (containers: all | running | stopped | problems)
let view = location.hash === '#containers' || location.hash.startsWith('#c:') ? 'containers' : 'vms';
let openKind = 'vm'; // what the open drawer shows: a VM or a container
let node = '';
let openKey = null; // the VM whose details are open

const DAY = 86400e3;
const running = (g) => g.status === 'running';
const share = (a, b) => (b ? a / b : null);
const tone = (f) => (f == null ? '' : f >= 0.9 ? 'critical' : f >= 0.8 ? 'warning' : '');
const bits = (bps) => (bps == null ? '–' : bps * 8 >= 1e6 ? `${fmt.n((bps * 8) / 1e6, 1)} Mbit/s` : `${fmt.n((bps * 8) / 1e3, 0)} kbit/s`);

// Backed up within the limit, too long ago, none found, or not read yet
function backupState(g, days) {
  if (g.backup === undefined) return { cls: '', text: '…', title: 'Not read yet (every 5 minutes)' };
  if (g.backup === null) return { cls: '', text: '–', title: 'The backups could not be read from Proxmox' };
  if (!g.backup.last) return { cls: 'none', text: 'None', title: 'No backup found on the storages Proxmox lists' };
  // a VM in a backup job may be as old as the job's interval plus a day; others the limit in Admin
  const limit = g.backup.job ? g.backup.job.every + 1 : days;
  const age = (Date.now() - g.backup.last) / DAY;
  return { cls: age >= limit ? 'old' : 'ok', text: fmt.ago(g.backup.last), title: `${new Date(g.backup.last).toLocaleString('en-GB')} on ${g.backup.storage}` };
}

// "monthly (every 31 days)", "sat 02:00 (every 7 days)"
const jobText = (j) => `${j.schedule || 'scheduled'} (every ${j.every} day${j.every === 1 ? '' : 's'})`;

function bar(f, text) {
  const i = el('i');
  i.style.width = `${(Math.max(0, Math.min(1, f || 0)) * 100).toFixed(1)}%`;
  return el('span', { class: `vbar ${tone(f)}` }, el('span', { class: 'vbar-track', 'aria-hidden': 'true' }, i), el('span', { class: 'num', text }));
}

function matches(g, q) {
  if (node && g.node !== node) return false;
  if (filter === 'running' && !running(g)) return false;
  if (filter === 'stopped' && running(g)) return false;
  if (filter === 'backup' && backupState(g, last.backupDays).cls !== 'old' && backupState(g, last.backupDays).cls !== 'none') return false;
  if (!q) return true;
  return [g.name, g.vmid, g.node, g.agent?.os, ...(g.agent?.ips || [])].join(' ').toLowerCase().includes(q);
}

function row(g) {
  const on = running(g);
  const memF = share(g.mem, g.maxmem);
  const dF = g.disk ? share(g.disk.used, g.disk.size) : null;
  const b = backupState(g, last.backupDays);
  const r = el('button', { type: 'button', class: `vm-row${on ? '' : ' stopped'}`, 'data-key': g.key, onclick: () => openVm(g.key) },
    el('span', { class: 'vm-name' },
      el('span', { class: `vm-type ${g.type}`, text: g.type === 'lxc' ? 'CT' : 'VM', title: g.type === 'lxc' ? 'Container' : 'Virtual machine' }),
      el('span', { class: 'vm-title' }, el('strong', { text: g.name }), el('small', { class: 'muted num', text: [g.vmid, g.node, g.agent?.ips?.[0]].filter(Boolean).join(' · ') }))),
    el('span', { class: 'vm-status' }, el('span', { class: `led ${on ? 'good' : 'off'}` }), g.status),
    el('span', { class: 'vm-cell', 'data-l': 'CPU' }, on ? bar(g.cpu, `${fmt.pct(g.cpu, 1)}`) : '–'),
    el('span', { class: 'vm-cell', 'data-l': 'Memory' }, on ? bar(memF, fmt.bytes(g.mem)) : '–'),
    el('span', { class: 'vm-cell', 'data-l': 'Disk' }, on && dF != null ? bar(dF, `${fmt.pct(dF)}${g.disk.mount !== '/' ? ` ${g.disk.mount}` : ''}`) : '–'),
    el('span', { class: 'vm-cell num', 'data-l': 'Network' }, on && g.rxBps != null ? `↓ ${bits(g.rxBps)}  ↑ ${bits(g.txBps)}` : '–'),
    el('span', { class: `vm-cell vm-backup ${b.cls}`, 'data-l': 'Last backup', title: b.title, text: b.text }));
  return r;
}

function render(d) {
  HD.shell({ active: 'vms', title: d.title, admin: d.loggedIn, viewer: d.viewer });
  const hasCt = (d.containerHosts || []).length > 0;
  if (!d.proxmox && hasCt) view = 'containers';
  $('vm-view').hidden = !(d.proxmox && hasCt);
  $('vm-view').replaceChildren(...[['vms', `VMs (${d.items.length})`], ['containers', `Containers (${(d.containers || []).length})`]].map(([k, t]) => el('button', {
    type: 'button', text: t, 'aria-pressed': String(view === k),
    onclick: () => {
      if (view === k) return;
      view = k;
      filter = 'all';
      history.replaceState(null, '', k === 'containers' ? '#containers' : location.pathname);
      render(last);
    },
  })));
  document.querySelector('.page-title').textContent = view === 'containers' ? 'Containers' : 'VMs and containers';
  $('vm-q').placeholder = view === 'containers' ? 'Search by name, image, host or compose project' : 'Search by name, ID, address or OS';
  if (view === 'containers') return renderContainers(d);
  if (!d.proxmox) {
    $('vm-summary').replaceChildren();
    $('vm-list').replaceChildren(el('p', { class: 'empty', text: d.loggedIn ? 'No Proxmox connection yet. Add one to a server in Admin → Devices.' : 'No Proxmox connection.' }));
    return;
  }
  const items = d.items;
  const on = items.filter(running).length;
  const behind = items.filter((g) => backupState(g, d.backupDays).cls === 'old').length;
  const none = items.filter((g) => backupState(g, d.backupDays).cls === 'none').length;
  $('vm-summary').replaceChildren(...[
    el('span', { class: 'pill good' }, el('span', { class: 'dot good' }), el('strong', { text: String(on) }), ' running'),
    items.length - on ? el('span', { class: 'pill' }, el('strong', { text: String(items.length - on) }), ' stopped') : null,
    behind ? el('span', { class: 'pill warning' }, el('strong', { text: String(behind) }), ' backup overdue') : null,
    none ? el('span', { class: 'pill' }, el('strong', { text: String(none) }), ' without a backup') : null,
  ].filter(Boolean));
  // filters: all, running, stopped, and the ones whose backup needs a look
  $('vm-filter').replaceChildren(...[['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped'], ['backup', 'Backup']].map(([k, t]) => el('button', {
    type: 'button', text: t, 'aria-pressed': String(filter === k), title: k === 'backup' ? 'Without a backup, or older than the limit' : null,
    onclick: () => { filter = k; render(last); },
  })));
  const nodes = [...new Set(items.map((g) => g.node))].sort();
  const sel = $('vm-node');
  sel.hidden = nodes.length < 2;
  sel.replaceChildren(el('option', { value: '', text: 'All nodes' }), ...nodes.map((n) => el('option', { value: n, text: n })));
  sel.value = node;
  const q = $('vm-q').value.trim().toLowerCase();
  const shown = items.filter((g) => matches(g, q)).sort((a, b) => (running(a) ? 0 : 1) - (running(b) ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
  $('vm-list').replaceChildren(
    el('div', { class: 'vm-head', 'aria-hidden': 'true' }, ['Name', 'Status', 'CPU', 'Memory', 'Disk', 'Network', 'Last backup'].map((t) => el('span', { text: t }))),
    ...(shown.length ? shown.map(row) : [el('p', { class: 'empty', text: items.length ? 'Nothing matches.' : 'No VMs or containers.' })]));
  // where backups were looked for, so "None" can be checked against Proxmox
  const st = d.backupStorages || [];
  $('vm-notes').replaceChildren(
    ...(d.notes || []).map((n) => el('p', { class: 'hint', text: n })),
    st.length ? el('p', { class: 'hint' }, el('strong', { text: 'Backups looked for on: ' }),
      st.map((x) => (x.name ? `${x.name}${nodes.length > 1 ? ` (${x.node})` : ''}: ${x.error || (x.hidden ? 'files not visible to the read-only token, times read from the backup job\'s log' : `${x.count} backup${x.count === 1 ? '' : 's'}`)}` : `${x.node}: ${x.error}`)).join(' · ')) : '');
  if (openKey) (openKind === 'ct' ? fillContainerDrawer : fillDrawer)();
}

// --- containers (Docker hosts and Portainer environments) ---

const ctRunning = (c) => c.state === 'running';
const ctProblem = (c) => !c.ignore && (c.state === 'restarting' || c.recentRestarts >= 3 || c.health === 'unhealthy'
  || (c.state === 'exited' && c.policy && c.policy !== 'no' && (c.oom || (c.exitCode && ![137, 143].includes(c.exitCode)))));
const CT_DOT = { running: 'good', restarting: 'critical', paused: 'warning', dead: 'critical' };

function ctMatches(c, q) {
  if (filter === 'running' && !ctRunning(c)) return false;
  if (filter === 'stopped' && ctRunning(c)) return false;
  if (filter === 'problems' && !ctProblem(c)) return false;
  if (!q) return true;
  return [c.name, c.image, c.hostName, c.project, c.service].join(' ').toLowerCase().includes(q);
}

function ctRow(c) {
  const on = ctRunning(c);
  const memF = c.memLimit && c.memUsed != null ? c.memUsed / c.memLimit : null;
  return el('button', { type: 'button', class: `vm-row ct-row${on ? '' : ' stopped'}`, 'data-key': c.key, onclick: () => openContainer(c.key) },
    el('span', { class: 'vm-name' },
      el('span', { class: 'vm-type ct', text: 'CT', title: 'Container' }),
      el('span', { class: 'vm-title' }, el('strong', { text: c.name }), el('small', { class: 'muted', text: [c.image, c.project && c.project !== c.name ? c.project : null].filter(Boolean).join(' · ') }))),
    el('span', { class: 'vm-status' }, el('span', { class: `led ${c.health === 'unhealthy' ? 'critical' : CT_DOT[c.state] || 'off'}` }), `${c.state}${c.health ? ` · ${c.health}` : ''}`),
    el('span', { class: 'vm-cell', 'data-l': 'CPU' }, on && c.cpu != null ? bar(c.cpus ? c.cpu / c.cpus : c.cpu, `${fmt.n(c.cpu * 100, 1)} %`) : '–'),
    el('span', { class: 'vm-cell', 'data-l': 'Memory' }, on && c.memUsed != null ? bar(memF, fmt.bytes(c.memUsed)) : '–'),
    el('span', { class: `vm-cell num${c.recentRestarts >= 3 ? ' ct-bad' : ''}`, 'data-l': 'Restarts', text: c.restarts != null ? `${c.restarts}${c.recentRestarts ? ` (${c.recentRestarts} lately)` : ''}` : '–' }),
    el('span', { class: 'vm-cell', 'data-l': 'Host', text: c.hostName }),
    el('span', { class: 'vm-cell small muted', 'data-l': 'Status', text: c.status }));
}

function renderContainers(d) {
  const list = d.containers || [];
  const on = list.filter(ctRunning).length;
  const bad = list.filter(ctProblem).length;
  $('vm-summary').replaceChildren(...[
    el('span', { class: 'pill good' }, el('span', { class: 'dot good' }), el('strong', { text: String(on) }), ' running'),
    list.length - on ? el('span', { class: 'pill' }, el('strong', { text: String(list.length - on) }), ' stopped') : null,
    bad ? el('span', { class: 'pill critical' }, el('strong', { text: String(bad) }), bad === 1 ? ' problem' : ' problems') : null,
  ].filter(Boolean));
  $('vm-filter').replaceChildren(...[['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped'], ['problems', 'Problems']].map(([k, t]) => el('button', {
    type: 'button', text: t, 'aria-pressed': String(filter === k), onclick: () => { filter = k; render(last); },
  })));
  $('vm-node').hidden = true;
  const q = $('vm-q').value.trim().toLowerCase();
  const shown = list.filter((c) => ctMatches(c, q)).sort((a, b) => (ctProblem(b) ? 1 : 0) - (ctProblem(a) ? 1 : 0) || (ctRunning(a) ? 0 : 1) - (ctRunning(b) ? 0 : 1) || a.name.localeCompare(b.name));
  $('vm-list').replaceChildren(
    el('div', { class: 'vm-head ct-head', 'aria-hidden': 'true' }, ['Container', 'State', 'CPU', 'Memory', 'Restarts', 'Host', 'Status'].map((t) => el('span', { text: t }))),
    ...(shown.length ? shown.map(ctRow) : [el('p', { class: 'empty', text: list.length ? 'Nothing matches.' : 'No containers.' })]));
  $('vm-notes').replaceChildren(...(d.containerHosts || []).filter((h) => h.error).map((h) => el('p', { class: 'hint', text: `${h.name}: ${h.error}` })),
    el('p', { class: 'hint', text: 'A container labelled lookout.ignore=true is listed but never alerted.' }));
  if (openKey) (openKind === 'ct' ? fillContainerDrawer : fillDrawer)();
}

function openContainer(key) {
  openKey = key;
  openKind = 'ct';
  drawerBox = el('div', { class: 'vm-detail' });
  const c = last.containers.find((x) => x.key === key);
  HD.drawer(c ? c.name : 'Container', drawerBox, {
    onClose: () => {
      openKey = null;
      openKind = 'vm';
      drawerBox = null;
      history.replaceState(null, '', view === 'containers' ? '#containers' : location.pathname);
    },
  });
  history.replaceState(null, '', `#c:${encodeURIComponent(key)}`);
  fillContainerDrawer();
}

function fillContainerDrawer() {
  const c = last?.containers?.find((x) => x.key === openKey);
  if (!drawerBox) return;
  if (!c) return drawerBox.replaceChildren(el('p', { class: 'empty', text: 'This container is no longer reported.' }));
  const on = ctRunning(c);
  const k = `ctr:${c.host}:${c.name}`;
  const kv = (pairs) => el('div', { class: 'kv' }, pairs.filter(([, v]) => v != null && v !== '').map(([a, v]) => el('div', null, el('div', { class: 'k', text: a }), el('div', { class: 'v', text: v }))));
  const problem = c.state === 'restarting' || c.recentRestarts >= 3 ? `Keeps restarting: ${c.recentRestarts || 0} restarts in 15 minutes`
    : c.health === 'unhealthy' ? 'Its own health check fails'
      : c.state === 'exited' && c.oom ? 'It ran out of memory' : null;
  drawerBox.replaceChildren(...[
    el('div', { class: 'vm-detail-head' },
      el('span', { class: 'vm-type ct', text: 'CT' }),
      el('div', null, el('h3', { text: c.name }), el('p', { class: 'muted small', text: `${c.image} · on ${c.hostName}` })),
      HD.status(c.health === 'unhealthy' ? 'unhealthy' : c.state, c.health === 'unhealthy' || c.state === 'restarting' ? 'critical' : on ? 'good' : '')),
    problem ? el('p', { class: 'banner', role: 'alert', text: problem }) : null,
    kv([
      ['Status', c.status],
      ['Health check', c.health || 'none'],
      ['Restarts', c.restarts != null ? String(c.restarts) : null],
      ['Restart policy', c.policy],
      ['Last exit code', !on && c.exitCode != null ? String(c.exitCode) : null],
      ['Started', c.startedAt && on ? new Date(c.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null],
      ['Compose', c.project ? `${c.project}${c.service ? ` / ${c.service}` : ''}` : null],
      ['Host', `${c.hostName}${c.hostIp ? ` (${c.hostIp})` : ''}`],
      ['Alerts', c.ignore ? 'Off (lookout.ignore=true)' : null],
    ]),
    on ? [el('div', { class: 'sect-head' }, el('h4', { text: 'History' }), HD.rangeTabs()),
      el('div', { class: 'sparks' }, HD.sparkSlot(`${k}:cpu`, { label: 'CPU (100 % = one core)', unit: ' %', decimals: 1 }), HD.sparkSlot(`${k}:mem`, { label: 'Memory', unit: ' MB', decimals: 0 }))] : null,
  ].flat().filter(Boolean));
  HD.fillSparks();
}

// --- details ---

let drawerBox = null;

function openVm(key) {
  openKey = key;
  openKind = 'vm';
  drawerBox = el('div', { class: 'vm-detail' });
  const g = last.items.find((x) => x.key === key);
  HD.drawer(g ? g.name : 'VM', drawerBox, {
    onClose: () => {
      openKey = null;
      drawerBox = null;
      if (location.hash) history.replaceState(null, '', location.pathname);
    },
  });
  history.replaceState(null, '', `#${encodeURIComponent(key)}`);
  fillDrawer();
}

function fillDrawer() {
  const g = last?.items.find((x) => x.key === openKey);
  if (!drawerBox) return;
  if (!g) return drawerBox.replaceChildren(el('p', { class: 'empty', text: 'This VM is no longer reported by Proxmox.' }));
  const on = running(g);
  const k = `pveg:${g.host}:${g.vmid}`;
  const b = backupState(g, last.backupDays);
  const kv = (pairs) => el('div', { class: 'kv' }, pairs.filter(([, v]) => v != null && v !== '').map(([a, v]) => el('div', null, el('div', { class: 'k', text: a }), el('div', { class: 'v', text: v }))));
  const fs = (g.agent?.fs || (g.disk ? [{ mount: g.disk.mount, used: g.disk.used, size: g.disk.size }] : [])).map((f) => {
    const fr = share(f.used, f.size);
    return el('div', { class: 'meter-row' },
      el('span', { class: 'label', text: f.mount, title: f.type || '' }),
      el('div', null, bar(fr, ''), el('div', { class: 'small muted num', text: `${fmt.bytes(f.used)} of ${fmt.bytes(f.size)} used` })),
      el('span', { class: 'value', text: fmt.pct(fr) }));
  });
  const sp = (key, label, unit, dec, more = {}) => HD.sparkSlot(key, { label, unit, decimals: dec, ...more });
  drawerBox.replaceChildren(...[
    el('div', { class: 'vm-detail-head' },
      el('span', { class: `vm-type ${g.type}`, text: g.type === 'lxc' ? 'CT' : 'VM' }),
      el('div', null, el('h3', { text: g.name }), el('p', { class: 'muted small', text: `${g.type === 'lxc' ? 'Container' : 'Virtual machine'} ${g.vmid} on ${g.node}${g.hostName && g.hostName !== g.node ? ` (${g.hostName})` : ''}` })),
      HD.status(g.status, on ? 'good' : '')),
    kv([
      ['Operating system', g.agent?.os],
      ['Addresses', g.agent?.ips?.join(', ')],
      ['vCPU', g.maxcpu ? String(g.maxcpu) : null],
      ['Memory', g.maxmem ? fmt.bytes(g.maxmem) : null],
      ['Disk size', g.maxdisk ? fmt.bytes(g.maxdisk) : null],
      ['Uptime', on ? fmt.uptime(g.uptime) : null],
      ['Guest agent', g.type === 'qemu' && on ? (g.agent?.running ? 'Running' : g.agent ? 'Not answering' : '…') : null],
    ]),
    // containers on this VM: a Docker host at one of its addresses
    (() => {
      const mine = (last.containers || []).filter((c) => c.hostIp && (g.agent?.ips || []).includes(c.hostIp));
      return mine.length ? [el('h4', { text: `Containers · ${mine.filter(ctRunning).length} of ${mine.length} running` }),
        el('div', { class: 'ct-chips' }, mine.map((c) => el('button', { type: 'button', class: `ct-chip${ctProblem(c) ? ' bad' : ''}`, onclick: () => openContainer(c.key) },
          el('span', { class: `led ${c.health === 'unhealthy' ? 'critical' : CT_DOT[c.state] || 'off'}` }), c.name)))] : null;
    })(),
    el('div', { class: 'sect-head' }, el('h4', { text: 'History' }), HD.rangeTabs()),
    el('div', { class: 'sparks' },
      sp(`${k}:cpu`, 'CPU', ' %', 1),
      sp(`${k}:mem`, 'Memory', ' %', 0),
      sp(`${k}:rx`, 'Network', ' Mbit/s', 1, { key2: `${k}:tx`, names: ['in', 'out'], legend: ['In', 'Out'], zero: true }),
      sp(`${k}:read`, 'Disk activity', ' MB/s', 1, { key2: `${k}:write`, names: ['read', 'write'], legend: ['Read', 'Write'], zero: true })),
    fs.length ? [el('h4', { text: 'Disks' }), fs] : null,
    g.type === 'qemu' && g.agent && !g.agent.running
      ? el('p', { class: 'small muted', text: 'To see the disks and addresses inside this VM: apt install qemu-guest-agent in the VM, then switch on QEMU Guest Agent under Options in Proxmox.' })
      : null,
    el('h4', { text: 'Backups' }),
    g.backup === undefined ? el('p', { class: 'small muted', text: 'Read every 5 minutes; not read yet.' })
      : g.backup === null ? el('p', { class: 'small muted', text: 'Proxmox did not list its backup storages, so the backups could not be read.' })
      : !g.backup.last ? el('p', { class: `small vm-backup none`, text: 'No backup found on the storages Proxmox lists (including Proxmox Backup Server).' })
        : kv([
          ['Newest', `${new Date(g.backup.last).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (${fmt.ago(g.backup.last)})`],
          ['Storage', g.backup.storage],
          ['Backups kept', g.backup.count ? String(g.backup.count) : null],
          ['Last attempt', g.backup.failedAt && g.backup.failedAt > g.backup.last ? `Failed ${fmt.ago(g.backup.failedAt)}` : null],
          ['Read from', g.backup.fromLog && !g.backup.count ? 'The backup job\'s log (the files are hidden from a read-only token)' : null],
          ['Size', g.backup.size ? fmt.bytes(g.backup.size) : null],
          ['Verified', g.backup.verified ? (g.backup.verified === 'ok' ? 'OK' : g.backup.verified) : null],
        ]),
    g.backup ? kv([
      ['Backup job', g.backup.job ? `${jobText(g.backup.job)}${g.backup.job.storage ? ` to ${g.backup.job.storage}` : ''}` : 'In no backup job'],
      ['Next run', g.backup.job?.nextRun ? new Date(g.backup.job.nextRun).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null],
      ['Overdue after', g.backup.last ? `${g.backup.job ? g.backup.job.every + 1 : last.backupDays} days without a new backup` : null],
    ]) : null,
    g.proxmoxUrl ? el('div', { class: 'detail-actions' }, el('a', { class: 'button', href: g.proxmoxUrl, target: '_blank', rel: 'noopener' }, HD.icon('external-link'), ' Open in Proxmox')) : null,
  ].flat(2).filter(Boolean));
  HD.fillSparks();
}

async function refresh() {
  clearTimeout(timer);
  if (document.hidden && loadedOnce) return;
  loadedOnce = true;
  let delay = 30;
  try {
    const r = await fetch('/api/vms', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) {
      location.href = '/login?next=vms';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    last = await r.json();
    lastAt = Date.now();
    delay = last.refreshSeconds;
    $('global-error').classList.add('hidden');
    render(last);
    // a link to one VM (from search or Home) opens it
    const want = decodeURIComponent(location.hash.slice(1));
    if (want.startsWith('c:') && !openKey && last.containers?.some((c) => c.key === want.slice(2))) openContainer(want.slice(2));
    else if (want && !openKey && last.items.some((g) => g.key === want)) openVm(want);
  } catch (e) {
    $('global-error').textContent = `Could not load the VMs: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
  tick();
  timer = setTimeout(refresh, Math.max(10, delay) * 1000);
}

function tick() {
  $('updated').textContent = lastAt ? `Updated ${fmt.ago(lastAt)}` : '';
}

$('vm-q').addEventListener('input', () => last && render(last));
$('vm-node').addEventListener('change', (e) => {
  node = e.target.value;
  render(last);
});
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
setInterval(tick, 5000);
refresh();
