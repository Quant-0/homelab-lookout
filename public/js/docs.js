'use strict';
// Documentation: server sheets (automatic facts + your notes), network plan, switch ports,
// topology diagram (from UniFi) and free Markdown pages. Always behind login.

const { el, svg, fmt, api } = HD;
const $ = (id) => document.getElementById(id);
const KIND = Rack.KIND_LABELS;

let D = null; // { docs, auto }
let dirty = false;

const ipNum = (ip) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip || '').split('/')[0]);
  return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : Infinity;
};
// "192.168.1.1/24" (gateway/prefix, as UniFi reports it) -> "192.168.1.0/24"
const cidrNetwork = (cidr) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr || '');
  if (!m || +m[5] > 32) return cidr;
  const ip = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  const net = (ip & (+m[5] ? (~0 << (32 - +m[5])) >>> 0 : 0)) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${m[5]}`;
};
const placement = (d) => (d.location === 'rack' ? (d.height > 1 ? `U${d.u}–U${d.u + d.height - 1}` : `U${d.u}`) : d.location === 'outside' ? 'Outside the rack' : 'Not placed');
const when = (ms) => (ms ? `Last edited ${fmt.time(ms)}` : '');
const unifiDevices = () => D.auto.unifi.flatMap((u) => u.devices);
const unifiClients = () => D.auto.unifi.flatMap((u) => u.clients);
const deviceByIp = (ip) => D.auto.devices.find((d) => d.ips.includes(ip));
const toolbar = (...items) => el('div', { class: 'docs-toolbar' }, items);

async function load() {
  try {
    D = await api('GET', '/api/docs');
    renderNav();
    route();
  } catch (e) {
    $('global-error').textContent = `Could not load the documentation: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
}

function link(hash, text, sub) {
  const active = location.hash === hash || (hash === '#' && !location.hash);
  return el('a', { href: hash, class: active ? 'active' : null, 'aria-current': active ? 'page' : null }, el('span', { text }), sub ? el('span', { class: 'small muted', text: sub }) : null);
}

function renderNav() {
  const servers = [...D.auto.devices].sort((a, b) => (a.location === 'rack' ? -a.u : 1000) - (b.location === 'rack' ? -b.u : 1000) || a.name.localeCompare(b.name));
  const folders = new Map();
  for (const p of [...D.docs.pages].sort((a, b) => a.title.localeCompare(b.title))) {
    const f = p.folder || 'Pages';
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f).push(p);
  }
  $('docs-nav').replaceChildren(
    link('#', 'Overview'),
    el('h4', { text: 'Servers & devices' }),
    ...servers.map((d) => link(`#server/${d.id}`, d.name, KIND[d.kind])),
    el('h4', { text: 'Network' }),
    link('#network', 'Network plan'),
    link('#ports', 'Switch ports'),
    link('#topology', 'Topology'),
    ...[...folders].flatMap(([f, pages]) => [el('h4', { text: f }), ...pages.map((p) => link(`#page/${p.id}`, p.title))]),
    el('div', { class: 'form-actions' }, el('a', { class: 'button primary', href: '#new-page', text: 'New page' })));
}

function route() {
  if (!D) return;
  dirty = false;
  const [view, id] = location.hash.slice(1).split('/');
  renderNav();
  const views = { server: () => serverView(id), network: networkView, ports: portsView, topology: topologyView, page: () => pageView(id), 'new-page': () => pageEdit(null) };
  (views[view] || overview)();
  window.scrollTo(0, 0);
}

function show(...nodes) {
  $('docs-content').replaceChildren(...nodes.flat().filter(Boolean));
}

function factsTable(rows) {
  const list = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
  return list.length
    ? el('table', { class: 'facts' }, el('tbody', null, list.map(([k, v]) => el('tr', null, el('th', { text: k }), el('td', null, Array.isArray(v) ? v.join(', ') : v)))))
    : null;
}

// --- Overview ---

function overview() {
  const a = D.auto;
  show(
    el('h2', { text: 'Homelab documentation' }),
    el('p', { class: 'muted', text: 'Server sheets and the switch/topology views are filled in automatically from your devices and UniFi. Add your own notes on each sheet, keep the network plan up to date, and write pages for procedures and how-tos.' }),
    el('div', { class: 'tiles' },
      [['Devices', a.devices.length, '#'], ['Networks', D.docs.network.networks.length, '#network'], ['IP reservations', D.docs.network.reservations.length, '#network'],
        ['Pages', D.docs.pages.length, '#'], ['UniFi clients', unifiClients().length, '#network']].map(([label, n, href]) =>
        el('a', { class: 'tile', href }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: String(n) })))),
    el('p', { class: 'hint', text: 'Do not store passwords here. Link to your password manager instead (e.g. Vaultwarden).' }));
}

// --- Server sheet ---

function switchPortOf(dev) {
  for (const c of unifiClients()) {
    if (!c.wired || !dev.ips.includes(c.ip) || !c.swMac) continue;
    const sw = unifiDevices().find((u) => u.mac === c.swMac);
    return `${sw ? sw.name : c.swMac} · port ${c.swPort}`;
  }
  const ud = dev.unifiMac && unifiDevices().find((u) => u.mac === dev.unifiMac);
  if (ud?.uplinkMac) {
    const up = unifiDevices().find((u) => u.mac === ud.uplinkMac);
    return `${up ? up.name : ud.uplinkMac}${ud.uplinkPort ? ` · port ${ud.uplinkPort}` : ''}`;
  }
  return null;
}

function serverView(id) {
  const dev = D.auto.devices.find((d) => d.id === id);
  if (!dev) return show(el('p', { class: 'empty', text: 'Device not found.' }));
  const doc = D.docs.servers[id] || {};
  const yours = factsTable([
    ['Role', doc.role], ['Operating system', doc.os], ['Location', doc.location], ['Purchased', doc.purchased], ['Warranty until', doc.warranty],
    ...(doc.custom || []).map((f) => [f.label, f.value]),
  ]);
  show(
    toolbar(el('h2', { text: dev.name }), el('span', { class: 'spacer' }), el('button', { type: 'button', text: 'Edit notes', onclick: () => serverEdit(dev, doc) })),
    el('p', { class: 'muted', text: [KIND[dev.kind], placement(dev), dev.model].filter(Boolean).join(' · ') }),
    el('h3', { text: 'Facts (automatic)' }),
    factsTable([
      ['Model', dev.model], ['Service tag / serial', dev.serviceTag], ['Host name', dev.hostName], ['Firmware / version', dev.firmware],
      ['CPU', dev.cpu], ['Memory', dev.memory ? fmt.bytes(dev.memory) : null], ['Power supplies', dev.psus], ['Rack position', placement(dev)],
      ['Estimated power', dev.estimateW ? `${dev.estimateW} W` : null], ['Switch port', switchPortOf(dev)], ['UniFi MAC', dev.unifiMac],
      ['Disks', dev.disks], ['Storage pools', dev.pools],
    ]) || el('p', { class: 'small muted', text: 'No automatic facts yet. Add connections to this device in Admin → Devices.' }),
    dev.connections.length ? [el('h3', { text: 'Management' }), el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Interface' }), el('th', { text: 'Address' }))),
      el('tbody', null, dev.connections.map((c) => el('tr', null, el('td', { text: c.label }), el('td', { class: 'num', text: c.address }))))))] : null,
    dev.vms.length ? [el('h3', { text: `VMs and containers (${dev.vms.length})` }), el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { class: 'r', text: 'ID' }), ['Name', 'Type', 'Status'].map((t) => el('th', { text: t })), ['vCPU', 'Memory'].map((t) => el('th', { class: 'r', text: t })))),
      el('tbody', null, dev.vms.map((g) => el('tr', null, el('td', { class: 'r', text: g.vmid }), el('td', { text: g.name }), el('td', { text: g.type === 'lxc' ? 'Container' : 'VM' }),
        el('td', { text: g.status }), el('td', { class: 'r', text: g.maxcpu ?? '–' }), el('td', { class: 'r', text: fmt.bytes(g.maxmem) }))))))] : null,
    dev.services.length ? [el('h3', { text: 'Services' }), el('ul', null, dev.services.map((s) => el('li', null, s.href ? el('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer', text: s.name }) : s.name)))] : null,
    el('h3', { text: 'Your notes' }),
    yours,
    doc.notes ? MD.render(doc.notes) : null,
    !yours && !doc.notes ? el('p', { class: 'small muted', text: 'Nothing yet. Use “Edit notes” for role, OS, warranty, and anything else worth knowing.' }) : null,
    el('p', { class: 'hint', text: when(doc.updatedAt) }));
}

function serverEdit(dev, doc) {
  const f = { role: doc.role || '', os: doc.os || '', location: doc.location || '', purchased: doc.purchased || '', warranty: doc.warranty || '', notes: doc.notes || '' };
  const custom = (doc.custom || []).map((x) => ({ ...x }));
  const input = (key, label, attrs = {}) => {
    const n = el('input', { value: f[key], ...attrs });
    n.addEventListener('input', () => {
      f[key] = n.value;
      dirty = true;
    });
    return el('label', null, el('span', { text: label }), n);
  };
  const customBox = el('div', { class: 'kv-edit' });
  const drawCustom = () => customBox.replaceChildren(...custom.map((c, i) => {
    const k = el('input', { value: c.label, placeholder: 'Field (e.g. BIOS version)' });
    const v = el('input', { value: c.value, placeholder: 'Value' });
    k.addEventListener('input', () => (c.label = k.value));
    v.addEventListener('input', () => (c.value = v.value));
    return el('div', { class: 'kv-row' }, k, v, el('button', { type: 'button', text: 'Remove', onclick: () => { custom.splice(i, 1); drawCustom(); } }));
  }), el('button', { type: 'button', text: 'Add field', onclick: () => { custom.push({ label: '', value: '' }); drawCustom(); } }));
  drawCustom();
  const notes = el('textarea', { class: 'md-input', rows: 14, value: f.notes, placeholder: 'Markdown: setup notes, quirks, links…' });
  notes.addEventListener('input', () => {
    f.notes = notes.value;
    dirty = true;
  });
  const msg = el('span', { class: 'msg', role: 'status' });
  show(
    toolbar(el('h2', { text: `${dev.name}: notes` })),
    el('div', { class: 'form-grid' }, input('role', 'Role', { placeholder: 'e.g. Proxmox host' }), input('os', 'Operating system', { placeholder: 'e.g. Proxmox VE 8.2' }),
      input('location', 'Location', { placeholder: 'e.g. Rack, U10' }), input('purchased', 'Purchased', { type: 'date' }), input('warranty', 'Warranty until', { type: 'date' })),
    el('h4', { text: 'More fields' }), customBox,
    el('h4', { text: 'Notes' }), notes,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: 'Save', onclick: async () => {
        try {
          const r = await api('PUT', `/api/docs/servers/${dev.id}`, { ...f, custom });
          D.docs.servers[dev.id] = r.server;
          dirty = false;
          serverView(dev.id);
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Cancel', onclick: () => (!dirty || confirm('Discard your changes?')) && serverView(dev.id) }),
      msg));
}

// --- Network plan ---

function editableTable(rows, columns, { deviceSelect = false } = {}) {
  const box = el('div', { class: 'table-wrap' });
  const draw = () => box.replaceChildren(el('table', { class: 'edit-table' },
    el('thead', null, el('tr', null, columns.map(([, label]) => el('th', { text: label })), deviceSelect ? el('th', { text: 'Device' }) : null, el('th'))),
    el('tbody', null, rows.map((r, i) => el('tr', null,
      columns.map(([key, , ph]) => {
        const n = el('input', { value: r[key] || '', placeholder: ph || '' });
        n.addEventListener('input', () => {
          r[key] = n.value;
          dirty = true;
        });
        return el('td', null, n);
      }),
      deviceSelect ? el('td', null, (() => {
        const s = el('select', null, el('option', { value: '', text: '–' }), D.auto.devices.map((d) => el('option', { value: d.id, text: d.name })));
        s.value = r.deviceId || '';
        s.addEventListener('change', () => (r.deviceId = s.value || null));
        return s;
      })()) : null,
      el('td', null, el('button', { type: 'button', text: '×', 'aria-label': 'Remove row', onclick: () => { rows.splice(i, 1); dirty = true; draw(); } })))))),
  el('button', { type: 'button', text: 'Add row', onclick: () => { rows.push({}); draw(); } }));
  draw();
  return box;
}

function clientsTable() {
  const clients = unifiClients();
  if (!clients.length) return el('p', { class: 'small muted', text: 'No UniFi client data (add a UniFi connection on the device that runs your console).' });
  const filter = el('input', { type: 'search', placeholder: 'Filter by name, IP or MAC…', class: 'docs-filter' });
  const body = el('tbody');
  const via = (c) => {
    const dev = unifiDevices().find((u) => u.mac === (c.wired ? c.swMac : c.apMac));
    return c.wired ? `${dev ? dev.name : 'switch'}${c.swPort ? ` · port ${c.swPort}` : ''}` : `Wi-Fi · ${dev ? dev.name : 'AP'}`;
  };
  const draw = () => {
    const q = filter.value.toLowerCase();
    body.replaceChildren(...clients
      .filter((c) => !q || [c.name, c.ip, c.mac].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => ipNum(a.ip) - ipNum(b.ip))
      .map((c) => {
        const own = deviceByIp(c.ip);
        return el('tr', null,
          el('td', null, own ? el('a', { href: `#server/${own.id}`, text: c.name || own.name }) : c.name || '–'),
          el('td', { class: 'num', text: c.ip || '–' }), el('td', { class: 'num small', text: c.mac }),
          el('td', { text: c.network || '–' }), el('td', { class: 'small', text: via(c) }), el('td', { class: 'num small', text: c.fixedIp ? 'Fixed' : '' }));
      }));
  };
  filter.addEventListener('input', draw);
  draw();
  return [filter, el('div', { class: 'table-wrap' }, el('table', null,
    el('thead', null, el('tr', null, ['Name', 'IP', 'MAC', 'Network', 'Connected via', ''].map((t) => el('th', { text: t })))), body))];
}

function networkView() {
  const n = D.docs.network;
  const nets = n.networks.length ? n.networks : [];
  const res = [...n.reservations].sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  const unifiNets = D.auto.unifi.flatMap((u) => u.networks);
  show(
    toolbar(el('h2', { text: 'Network plan' }), el('span', { class: 'spacer' }), el('button', { type: 'button', text: 'Edit', onclick: networkEdit })),
    el('h3', { text: 'Networks' }),
    nets.length
      ? el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Name', 'VLAN', 'Subnet', 'Gateway', 'DHCP range', 'Purpose'].map((t) => el('th', { text: t })))),
        el('tbody', null, nets.map((r) => el('tr', null, ['name', 'vlan', 'subnet', 'gateway', 'dhcp', 'purpose'].map((k) => el('td', { class: ['subnet', 'gateway', 'vlan'].includes(k) ? 'num' : null, text: r[k] || '–' })))))))
      : el('p', { class: 'small muted', text: unifiNets.length ? `None documented yet. UniFi reports ${unifiNets.length} network(s): use Edit → “Import from UniFi”.` : 'None documented yet.' }),
    el('h3', { text: 'IP reservations' }),
    res.length
      ? el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['IP', 'Name', 'MAC', 'Device', 'Notes'].map((t) => el('th', { text: t })))),
        el('tbody', null, res.map((r) => {
          const dev = D.auto.devices.find((d) => d.id === r.deviceId);
          return el('tr', null, el('td', { class: 'num', text: r.ip }), el('td', { text: r.name || '–' }), el('td', { class: 'num small', text: r.mac || '' }),
            el('td', null, dev ? el('a', { href: `#server/${dev.id}`, text: dev.name }) : '–'), el('td', { class: 'small', text: r.notes || '' }));
        }))))
      : el('p', { class: 'small muted', text: 'None documented yet.' }),
    n.notes ? [el('h3', { text: 'Notes' }), MD.render(n.notes)] : null,
    el('h3', { text: 'Clients seen by UniFi (live)' }),
    clientsTable(),
    el('p', { class: 'hint', text: when(n.updatedAt) }));
}

function networkEdit() {
  const n = structuredClone(D.docs.network);
  const notes = el('textarea', { class: 'md-input', rows: 8, value: n.notes || '', placeholder: 'Markdown: DNS, firewall rules, VPN, ISP details…' });
  notes.addEventListener('input', () => {
    n.notes = notes.value;
    dirty = true;
  });
  const netBox = el('div');
  const resBox = el('div');
  const drawTables = () => {
    netBox.replaceChildren(editableTable(n.networks, [['name', 'Name', 'LAN'], ['vlan', 'VLAN', '1'], ['subnet', 'Subnet', '192.168.1.0/24'], ['gateway', 'Gateway', '192.168.1.1'], ['dhcp', 'DHCP range'], ['purpose', 'Purpose']]));
    resBox.replaceChildren(editableTable(n.reservations, [['ip', 'IP', '192.168.1.80'], ['name', 'Name'], ['mac', 'MAC'], ['notes', 'Notes']], { deviceSelect: true }));
  };
  drawTables();
  const importNets = () => {
    for (const u of D.auto.unifi.flatMap((x) => x.networks)) {
      if (n.networks.some((r) => r.name === u.name)) continue;
      n.networks.push({ name: u.name, vlan: u.vlan, subnet: cidrNetwork(u.subnet), gateway: u.subnet.split('/')[0], dhcp: u.dhcp, purpose: u.purpose + (u.domain ? ` · ${u.domain}` : '') });
    }
    dirty = true;
    drawTables();
  };
  const importFixed = () => {
    for (const c of unifiClients().filter((x) => x.fixedIp)) {
      if (n.reservations.some((r) => r.ip === c.fixedIp)) continue;
      n.reservations.push({ ip: c.fixedIp, name: c.name, mac: c.mac, notes: '', deviceId: deviceByIp(c.fixedIp)?.id || null });
    }
    dirty = true;
    drawTables();
  };
  const msg = el('span', { class: 'msg', role: 'status' });
  show(
    toolbar(el('h2', { text: 'Network plan: edit' })),
    el('h3', { text: 'Networks' }),
    D.auto.unifi.length ? el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Import networks from UniFi', onclick: importNets })) : null,
    netBox,
    el('h3', { text: 'IP reservations' }),
    D.auto.unifi.length ? el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Import fixed IPs from UniFi', onclick: importFixed })) : null,
    resBox,
    el('h3', { text: 'Notes' }), notes,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: 'Save', onclick: async () => {
        try {
          const r = await api('PUT', '/api/docs/network', n);
          D.docs.network = r.network;
          dirty = false;
          networkView();
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Cancel', onclick: () => (!dirty || confirm('Discard your changes?')) && networkView() }),
      msg));
}

// --- Switch ports ---

function portsView() {
  const devs = unifiDevices().filter((d) => d.ports?.length);
  if (!devs.length) return show(el('h2', { text: 'Switch ports' }), el('p', { class: 'empty', text: 'No UniFi switches or gateways reported yet.' }));
  const clients = unifiClients();
  show(el('h2', { text: 'Switch ports' }), el('p', { class: 'muted', text: 'Live from UniFi: what is connected to each port. Devices you have documented are linked.' }),
    devs.map((sw) => [
      el('h3', { text: `${sw.name}${sw.model ? ` (${sw.model})` : ''}` }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { class: 'r', text: 'Port' }), ['Name', 'Link', 'PoE', 'Connected'].map((t) => el('th', { text: t })))),
        el('tbody', null, sw.ports.map((p) => {
          const downstream = unifiDevices().filter((u) => u.uplinkMac === sw.mac && u.uplinkPort === p.idx).map((u) => el('strong', { text: u.name }));
          const wired = clients.filter((c) => c.wired && c.swMac === sw.mac && c.swPort === p.idx).map((c) => {
            const own = deviceByIp(c.ip);
            return own ? el('a', { href: `#server/${own.id}`, text: own.name }) : el('span', { text: c.name || c.ip || c.mac });
          });
          const connected = [...downstream, ...wired];
          return el('tr', { class: p.up ? null : 'muted' },
            el('td', { class: 'r num', text: p.idx }), el('td', { text: p.name }),
            el('td', null, p.up ? HD.status(p.speed ? (p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`) : 'Up', 'good') : HD.status('Down', '')),
            el('td', { class: 'num', text: p.poeW > 0 ? `${fmt.n(p.poeW, 1)} W` : '' }),
            el('td', null, connected.length ? connected.flatMap((n, i) => (i ? [', ', n] : [n])) : p.uplink ? 'Uplink' : ''));
        }))))]));
}

// --- Topology diagram (drawn from UniFi uplinks + wired clients) ---

function topologyView() {
  const showAll = el('input', { type: 'checkbox' });
  const holder = el('div', { class: 'topology' });
  const draw = () => holder.replaceChildren(topologySvg(showAll.checked));
  showAll.addEventListener('change', draw);
  show(el('h2', { text: 'Topology' }),
    el('p', { class: 'muted', text: 'Drawn automatically from UniFi: which device is connected to which port. Click a documented device to open its sheet.' }),
    el('label', { class: 'check' }, showAll, ' Show all wired clients (not only documented devices)'),
    holder);
  draw();
}

function topologySvg(allClients) {
  const devs = unifiDevices();
  if (!devs.length) return el('p', { class: 'empty', text: 'No UniFi data yet.' });
  const nodes = new Map();
  const node = (id, label, sub, kind, extra = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, sub, kind, children: [], ...extra });
    return nodes.get(id);
  };
  const root = node('internet', 'Internet', '', 'internet');
  for (const d of devs) {
    const own = D.auto.devices.find((x) => x.unifiMac === d.mac);
    node(d.mac, d.name, [d.model, d.ip].filter(Boolean).join(' · '), d.type, { own, online: d.online });
  }
  for (const d of devs) {
    const n = nodes.get(d.mac);
    const parent = d.uplinkMac && nodes.get(d.uplinkMac);
    if (parent) {
      n.port = d.uplinkPort;
      parent.children.push(n);
    } else if (['udm', 'ugw', 'uxg'].includes(d.type)) root.children.push(n);
    else (devs.find((g) => ['udm', 'ugw', 'uxg'].includes(g.type)) ? nodes.get(devs.find((g) => ['udm', 'ugw', 'uxg'].includes(g.type)).mac) : root).children.push(n);
  }
  for (const c of unifiClients().filter((x) => x.wired && x.swMac && nodes.has(x.swMac))) {
    const own = deviceByIp(c.ip);
    if (!own && !allClients) continue;
    const n = node(`c:${c.mac}`, own ? own.name : c.name || c.ip || c.mac, c.ip, own ? own.kind : 'client', { own, port: c.swPort, online: true });
    nodes.get(c.swMac).children.push(n);
  }
  for (const n of nodes.values()) n.children.sort((a, b) => (a.port ?? 99) - (b.port ?? 99));
  // Tidy-ish tree layout: leaves side by side, parents centred over their children
  const W = 168;
  const H = 46;
  const GX = 18;
  const GY = 56;
  let nextX = 0;
  let maxDepth = 0;
  const place = (n, depth) => {
    n.y = depth * (H + GY);
    maxDepth = Math.max(maxDepth, depth);
    if (!n.children.length) {
      n.x = nextX;
      nextX += W + GX;
    } else {
      n.children.forEach((c) => place(c, depth + 1));
      n.x = (n.children[0].x + n.children[n.children.length - 1].x) / 2;
    }
  };
  place(root, 0);
  const width = Math.max(nextX - GX, W) + 2;
  const height = (maxDepth + 1) * (H + GY) - GY + 2;
  const out = svg('svg', { viewBox: `-1 -1 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Network topology' });
  const edges = svg('g', { class: 'topo-edges' });
  const boxes = svg('g');
  for (const n of nodes.values()) {
    if (n.y === undefined) continue;
    for (const c of n.children) {
      const x1 = n.x + W / 2;
      const y1 = n.y + H;
      const x2 = c.x + W / 2;
      const y2 = c.y;
      const ym = y1 + GY / 2;
      edges.append(svg('path', { d: `M${x1},${y1}V${ym}H${x2}V${y2}` }));
      if (c.port) edges.append(svg('text', { class: 'topo-port', x: x2 + 4, y: y2 - 6 }, `port ${c.port}`));
    }
    const g = svg('g', { class: `topo-node kind-${n.kind}${n.own ? ' own' : ''}${n.online === false ? ' offline' : ''}`, transform: `translate(${n.x},${n.y})` },
      svg('rect', { width: W, height: H, rx: 8 }),
      svg('text', { class: 'topo-label', x: 10, y: 19 }, n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label),
      svg('text', { class: 'topo-sub', x: 10, y: 35 }, (n.sub || '').slice(0, 28)));
    if (n.own) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'link');
      const go = () => (location.hash = `#server/${n.own.id}`);
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    }
    boxes.append(g);
  }
  out.append(edges, boxes);
  return out;
}

// --- Pages ---

function pageView(id) {
  const page = D.docs.pages.find((p) => p.id === id);
  if (!page) return show(el('p', { class: 'empty', text: 'Page not found.' }));
  show(
    toolbar(el('h2', { text: page.title }), el('span', { class: 'spacer' }), el('button', { type: 'button', text: 'Edit', onclick: () => pageEdit(page) })),
    page.folder ? el('p', { class: 'small muted', text: page.folder }) : null,
    MD.render(page.body),
    el('p', { class: 'hint', text: when(page.updatedAt) }));
}

function pageEdit(page) {
  const draft = { title: page?.title || '', folder: page?.folder || '', body: page?.body || '' };
  const folders = [...new Set(D.docs.pages.map((p) => p.folder).filter(Boolean))];
  const preview = el('div', { class: 'md-preview' });
  const title = el('input', { value: draft.title, placeholder: 'e.g. Restore from backup', required: true });
  const folder = el('input', { value: draft.folder, placeholder: 'e.g. Procedures', list: 'folder-list' });
  const body = el('textarea', { class: 'md-input', rows: 22, value: draft.body, placeholder: '# Heading\n\nSteps, commands in ```code```, - lists, | tables |…' });
  const update = () => {
    Object.assign(draft, { title: title.value, folder: folder.value, body: body.value });
    preview.replaceChildren(MD.render(draft.body));
    dirty = true;
  };
  [title, folder, body].forEach((n) => n.addEventListener('input', update));
  preview.replaceChildren(MD.render(draft.body));
  const msg = el('span', { class: 'msg', role: 'status' });
  show(
    toolbar(el('h2', { text: page ? `Edit: ${page.title}` : 'New page' })),
    el('div', { class: 'form-grid two' }, el('label', null, el('span', { text: 'Title' }), title), el('label', null, el('span', { text: 'Folder' }), folder)),
    el('datalist', { id: 'folder-list' }, folders.map((f) => el('option', { value: f }))),
    el('div', { class: 'md-editor' }, el('label', null, el('span', { text: 'Markdown' }), body), el('div', null, el('span', { class: 'small muted', text: 'Preview' }), preview)),
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: 'Save', onclick: async () => {
        try {
          const r = page ? await api('PUT', `/api/docs/pages/${page.id}`, draft) : await api('POST', '/api/docs/pages', draft);
          D.docs.pages = [...D.docs.pages.filter((p) => p.id !== r.page.id), r.page];
          dirty = false;
          location.hash = `#page/${r.page.id}`;
          route();
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Cancel', onclick: () => (!dirty || confirm('Discard your changes?')) && (page ? pageView(page.id) : (location.hash = '#')) }),
      page ? el('button', { type: 'button', class: 'danger', text: 'Delete page', onclick: async () => {
        if (!confirm(`Delete “${page.title}”?`)) return;
        await api('DELETE', `/api/docs/pages/${page.id}`);
        D.docs.pages = D.docs.pages.filter((p) => p.id !== page.id);
        dirty = false;
        location.hash = '#';
        route();
      } }) : null,
      msg));
  title.focus();
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => dirty && e.preventDefault());
$('view-tabs').replaceChildren(...HD.viewTabs('docs', true));
$('logout').addEventListener('click', HD.logout);
load();
