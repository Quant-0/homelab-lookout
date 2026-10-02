'use strict';
// Rack view: draws rack equipment as front panels with live data from the dashboard payload.
// Shared by the dashboard (read-only, click to jump to a widget) and the admin editor (drag to move).

const Rack = (() => {
  const { el, fmt, statusClass } = HD;
  const RANK = { '': 0, good: 1, warning: 2, critical: 3 };
  const worst = (list) => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), '');

  const KIND_LABELS = {
    server: 'Server',
    storage: 'Storage server',
    nas: 'NAS',
    switch: 'Switch',
    gateway: 'Gateway / router',
    'patch-panel': 'Patch panel',
    shelf: 'Shelf',
    pdu: 'PDU',
    ups: 'UPS',
    blank: 'Blanking panel',
    ap: 'Access point',
    other: 'Other',
  };

  // Find the monitored data behind each link of an item.
  function resolve(item, data) {
    const out = [];
    for (const link of item.links || []) {
      if (link.startsWith('host:')) {
        const id = link.slice(5);
        for (const type of ['idrac', 'proxmox', 'truenas', 'synology']) {
          const host = (data?.[type] || []).find((x) => x.id === id);
          if (host) out.push({ type, host, widget: `${type}:${id}` });
        }
      } else if (link.startsWith('pve:')) {
        const [, hostId, ...node] = link.split(':');
        const host = (data?.proxmox || []).find((x) => x.id === hostId);
        out.push({ type: 'pve-node', host, node: host?.data?.nodes?.find((n) => n.name === node.join(':')), widget: `proxmox:${hostId}` });
      } else if (link.startsWith('unifi:')) {
        const [, hostId, ...mac] = link.split(':');
        const host = (data?.unifi || []).find((x) => x.id === hostId);
        const device = host?.data?.devices?.find((d) => d.mac === mac.join(':'));
        out.push({ type: 'unifi', host, device, widget: `unifi:${hostId}` });
      }
    }
    return out;
  }

  const inRack = (it) => (it.location ? it.location === 'rack' : it.u !== null);
  const outside = (it) => (it.location ? it.location === 'outside' : it.u === null); // 'none' = not placed: not shown

  function linkStatus(l) {
    if (!l.host) return 'critical';
    if (l.host.ok === false && !l.host.data) return 'critical';
    const d = l.host.data;
    if (!d) return '';
    switch (l.type) {
      case 'idrac':
        return statusClass(d.health) || (d.health ? 'warning' : '');
      case 'proxmox':
        return d.nodes.every((n) => n.status === 'online') ? 'good' : 'warning';
      case 'truenas':
        return d.pools.some((p) => !p.healthy) ? 'critical' : d.alerts.some((a) => a.level === 'WARNING') ? 'warning' : 'good';
      case 'synology': {
        const s = d.system;
        if (s.status === 'Failed' || d.disks.some((x) => ['Critical', 'Failing'].includes(x.health) || x.status === 'Crashed')) return 'critical';
        if (d.disks.some((x) => x.health === 'Warning') || d.pools.some((p) => !p.healthy) || s.systemFan === 'Failed') return 'warning';
        return 'good';
      }
      case 'pve-node':
        return !l.node ? 'critical' : l.node.status === 'online' ? 'good' : 'critical';
      case 'unifi':
        return !l.device ? 'critical' : l.device.online ? 'good' : 'critical';
      default:
        return '';
    }
  }

  function itemInfo(item, data) {
    const links = resolve(item, data);
    const idrac = links.find((l) => l.type === 'idrac')?.host?.data;
    const syno = links.find((l) => l.type === 'synology')?.host?.data;
    const ud = links.find((l) => l.type === 'unifi')?.device;
    let measuredW = null;
    if (idrac && typeof idrac.watts === 'number') measuredW = idrac.watts;
    const poeW = ud?.poe ? ud.poe.usedW : null;
    const sub = idrac?.model || syno?.system?.model || ud?.model || (item.links?.length ? '' : KIND_LABELS[item.kind]);
    return { links, status: worst(links.map(linkStatus)), measuredW, poeW, idrac, syno, ud, sub };
  }

  // --- Fronts: drawn after the real hardware, with live data where there is some ---

  const FRONT_LABELS = {
    auto: 'Automatic',
    dell13: 'Dell PowerEdge, 13th gen (R630, R730)',
    dell14: 'Dell PowerEdge, 14th gen or newer (R640, R740)',
    'udm-pro': 'UniFi Dream Machine Pro',
    'usw-24-poe': 'UniFi Switch 24 PoE',
    'unifi-switch': 'UniFi switch',
    'synology-rs': 'Synology RackStation',
    'synology-ds': 'Synology DiskStation (desktop, on a shelf)',
    server: 'Generic server',
    switch: 'Generic switch',
    plain: 'Plain front',
  };
  const DRIVE_LABELS = { auto: 'Automatic', none: 'No drive bays', '4x3.5': '4 × 3.5″', '8x3.5': '8 × 3.5″', '12x3.5': '12 × 3.5″', '8x2.5': '8 × 2.5″', '10x2.5': '10 × 2.5″', '16x2.5': '16 × 2.5″', '24x2.5': '24 × 2.5″' };
  const DRIVES = { '4x3.5': [4, 1, 'lff'], '8x3.5': [4, 2, 'lff'], '12x3.5': [4, 3, 'lff'], '8x2.5': [8, 1, 'sff'], '10x2.5': [10, 1, 'sff'], '16x2.5': [16, 1, 'sff'], '24x2.5': [24, 1, 'sff'] };
  const PASSIVE_LABELS = { blank: 'Blank panel', vented: 'Vented panel', brush: 'Brush panel', cable: 'Cable management', patch: 'Patch panel', shelf: 'Shelf' };
  const WITH_DRIVES = new Set(['dell13', 'dell14', 'server']);

  // What the device reports decides the look, unless chosen in Admin
  function autoFront(item, info) {
    const dell = /\bR(\d)(\d)0(xd)?\b/i.exec(info.idrac?.model || '');
    if (dell) {
      const gen = 10 + Number(dell[2]); // R730 → 13th gen, R740 → 14th
      const oneU = item.height === 1 || dell[1] === '6' || dell[1] === '4';
      const drives = dell[3] ? (oneU ? '10x2.5' : '12x3.5') : oneU ? (gen >= 14 ? '10x2.5' : '8x2.5') : '8x3.5';
      return { model: gen >= 14 ? 'dell14' : 'dell13', drives };
    }
    const um = String(info.ud?.model || '');
    if (/^UDM-?PRO/i.test(um)) return { model: 'udm-pro' };
    if (/^(USL24P|US24P|USW-?24-?POE)/i.test(um)) return { model: 'usw-24-poe' };
    if (info.ud && /^(US|USW|USL|USM)/i.test(um)) return { model: 'unifi-switch' };
    const sm = String(info.syno?.system?.model || '');
    if (/^RS/i.test(sm)) return { model: 'synology-rs' };
    if (/^DS/i.test(sm)) return { model: 'synology-ds' };
    if (['server', 'storage', 'nas'].includes(item.kind)) return { model: 'server', drives: item.height >= 2 ? '8x3.5' : item.kind === 'nas' ? '4x3.5' : '8x2.5' };
    if (item.kind === 'switch' || item.kind === 'gateway') return { model: info.ud ? 'unifi-switch' : 'switch' };
    return { model: 'plain' };
  }

  function frontOf(item, info) {
    const auto = autoFront(item, info);
    const model = item.front?.model && item.front.model !== 'auto' ? item.front.model : auto.model;
    let drives = item.front?.drives && item.front.drives !== 'auto' ? item.front.drives : null;
    if (!drives) drives = model === auto.model && auto.drives ? auto.drives : WITH_DRIVES.has(model) ? (item.height >= 2 ? '8x3.5' : '8x2.5') : 'none';
    return { model, drives, auto };
  }

  const led = (cls, title) => el('span', { class: `led ${cls || 'off'}`, title });
  const statusLed = (info, item) => led(info.status || (item.links?.length ? 'off' : ''), info.status ? `Status: ${info.status}` : 'Not monitored');
  const tag = (item) => el('span', { class: 'fp-tag', text: item.name });

  function driveBays(layout, on) {
    const spec = DRIVES[layout];
    if (!spec) return el('div', { class: 'fp-fill' });
    const [cols, rows, size] = spec;
    const box = el('div', { class: `drives ${size}` }, Array.from({ length: cols * rows }, () => el('span', { class: `drive${on ? ' on' : ''}` }, el('i'))));
    box.style.setProperty('--cols', String(cols));
    box.style.setProperty('--rows', String(rows));
    return box;
  }

  function portNode(p) {
    const cls = ['port', p.up ? 'up' : 'down', p.poeW > 0 ? 'poe' : '', p.uplink ? 'uplink' : '', p.sfp ? 'sfp' : ''].filter(Boolean).join(' ');
    const speed = p.speed ? (p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`) : '';
    const title = [`${p.name || `Port ${p.idx}`}`, p.up ? speed || 'up' : 'down', p.poeW > 0 ? `PoE ${fmt.n(p.poeW, 1)} W` : '', p.uplink ? 'uplink' : ''].filter(Boolean).join(' · ');
    return el('span', { class: cls, title });
  }

  // Live ports when the device reports them, otherwise the model's port count (all dark)
  function portList(ud, rjCount, sfpCount) {
    if (ud?.ports?.length) return { rj: ud.ports.filter((p) => !p.sfp), sfp: ud.ports.filter((p) => p.sfp) };
    const fill = (n, sfp, start) => Array.from({ length: n }, (_, i) => ({ idx: start + i, up: false, sfp }));
    return { rj: fill(rjCount, false, 1), sfp: fill(sfpCount, true, rjCount + 1) };
  }

  // Two rows like a real switch (odd ports on top), in blocks of `block` columns
  function portBlocks(list, block) {
    const blocks = [];
    for (let c = 0; c * 2 < list.length; c += block) {
      const slice = list.slice(c * 2, (c + block) * 2);
      blocks.push(el('div', { class: 'port-block' },
        el('div', { class: 'port-row' }, slice.filter((_, i) => i % 2 === 0).map(portNode)),
        el('div', { class: 'port-row' }, slice.filter((_, i) => i % 2 === 1).map(portNode))));
    }
    return el('div', { class: 'port-blocks' }, blocks);
  }
  const sfpRow = (sfp) => (sfp.length ? el('div', { class: 'port-block sfp' }, el('div', { class: 'port-row' }, sfp.map(portNode))) : null);
  const uScreen = (ud) => el('span', { class: 'u-screen', title: ud ? `${ud.clients ?? 0} clients` : null }, ud?.online ? el('span', { class: 'num', text: String(ud.clients ?? '') }) : null);

  function dell(item, info, fr, gen) {
    const d = info.idrac;
    const on = d ? d.powerState === 'On' : false;
    const w = wattsText(info, item);
    // 14th gen: the left ear lights up per area; we know power supplies, temperatures and fans
    const tempBad = (d?.temps || []).some((t) => t.warn && t.celsius >= t.warn) || (d?.fans || []).some((f) => ['Critical', 'Warning'].includes(f.health));
    const powerBad = (d?.psus || []).some((p) => p.state !== 'Absent' && p.health && p.health !== 'OK');
    const icon = (bad, title) => el('i', { class: bad ? 'bad' : '', title });
    const left = el('div', { class: 'dell-ear' },
      gen >= 14
        ? el('span', { class: 'dell-icons' }, icon(false, 'Drives'), icon(tempBad, tempBad ? 'Temperature or fan warning' : 'Temperature'), icon(powerBad, powerBad ? 'Power supply fault' : 'Power'), icon(false, 'Memory'), icon(false, 'PCIe'))
        : el('span', { class: `dell-lcd num${info.status === 'critical' || info.status === 'warning' ? ' fault' : ''}`, text: on ? w : '' }),
      el('span', { class: `dell-id ${info.status || ''}`, title: `Health: ${d?.health || 'unknown'}` }));
    const right = el('div', { class: 'dell-ear' },
      el('span', { class: `dell-power${on ? ' on' : ''}`, title: `Power ${d?.powerState || 'unknown'}` }),
      el('span', { class: 'usb' }), el('span', { class: 'vga' }));
    return [left, el('div', { class: 'fp-body' }, driveBays(fr.drives, on), tag(item), gen >= 14 && w ? el('span', { class: 'fp-watts num', text: w }) : null), right];
  }

  function udmPro(item, info) {
    const { rj, sfp } = portList(info.ud, 9, 2);
    return [
      uScreen(info.ud),
      portBlocks(rj.slice(0, 8), 4),
      el('div', { class: 'port-block wan', title: 'WAN' }, el('div', { class: 'port-row' }, rj.slice(8).map(portNode))),
      el('div', { class: 'port-block sfp stack' }, sfp.map((p) => el('div', { class: 'port-row' }, portNode(p)))),
      el('span', { class: 'u-bay', title: 'Drive bay' }, tag(item)),
      statusLed(info, item),
    ];
  }

  function unifiSwitch(item, info, rjCount, sfpCount) {
    const { rj, sfp } = portList(info.ud, rjCount, sfpCount);
    return [uScreen(info.ud), portBlocks(rj, 6), sfpRow(sfp), el('span', { class: 'fp-side' }, tag(item), statusLed(info, item))];
  }

  function synoBays(count, disks, cols, size = 'lff') {
    const box = el('div', { class: `drives ${size} syno` }, Array.from({ length: count }, (_, i) => {
      const d = disks?.[i];
      if (!d) return el('span', { class: 'drive empty', title: disks ? 'Empty bay' : null }, el('i'));
      const st = ['Critical', 'Failing'].includes(d.health) || d.status === 'Crashed' ? 'critical' : d.health === 'Warning' ? 'warning' : 'good';
      return el('span', { class: `drive on ${st}`, title: `${d.id} · ${d.model || ''} · ${d.temp ?? '–'} °C · ${d.health || d.status || ''}` }, el('i'));
    }));
    box.style.setProperty('--cols', String(cols));
    box.style.setProperty('--rows', String(Math.ceil(count / cols)));
    return box;
  }

  function synologyRs(item, info) {
    const disks = info.syno?.disks;
    const count = Math.max(disks?.length || 0, item.height >= 2 ? 12 : 4);
    return [el('span', { class: 'fp-side' }, statusLed(info, item)), el('div', { class: 'fp-body' }, synoBays(count, disks, 4), tag(item))];
  }

  // A desktop DiskStation standing on a shelf: drawn as a box, bays standing up
  function synologyDs(item, info) {
    const disks = info.syno?.disks;
    const count = Math.max(disks?.length || 0, 4);
    return [el('div', { class: 'ds-box' },
      el('span', { class: 'ds-panel' }, statusLed(info, item), el('span', { class: 'dell-power on' })),
      el('div', { class: 'fp-body' }, synoBays(count, disks, count, 'sff'), tag(item)))];
  }

  function genericServer(item, info, fr) {
    const on = info.idrac ? info.idrac.powerState === 'On' : Boolean(item.links?.length);
    const w = wattsText(info, item);
    return [el('span', { class: 'fp-side' }, statusLed(info, item)), el('div', { class: 'fp-body' }, driveBays(fr.drives, on), tag(item), w ? el('span', { class: 'fp-watts num', text: w }) : null), el('span', { class: 'fp-side' }, el('span', { class: `dell-power${on ? ' on' : ''}` }))];
  }

  function genericSwitch(item, info) {
    const { rj, sfp } = portList(info.ud, item.kind === 'gateway' ? 8 : 24, item.kind === 'gateway' ? 0 : 2);
    return [el('span', { class: 'fp-side' }, tag(item), statusLed(info, item)), portBlocks(rj, 6), sfpRow(sfp)];
  }

  function plainFront(item, info) {
    const w = wattsText(info, item);
    return [el('div', { class: 'fp-label' }, el('strong', { text: item.name }), info.sub && item.height > 1 ? el('span', { text: info.sub }) : null),
      item.kind === 'pdu' ? el('div', { class: 'fp-outlets' }, Array.from({ length: 8 }, () => el('span'))) : el('div', { class: 'fp-fill' }),
      el('div', { class: 'fp-meta' }, w ? el('span', { class: 'fp-watts num', text: w }) : null, statusLed(info, item))];
  }

  const FRONTS = {
    dell13: (item, info, fr) => dell(item, info, fr, 13),
    dell14: (item, info, fr) => dell(item, info, fr, 14),
    'udm-pro': udmPro,
    'usw-24-poe': (item, info) => unifiSwitch(item, info, 24, 2),
    'unifi-switch': (item, info) => unifiSwitch(item, info, item.kind === 'gateway' ? 8 : 24, item.kind === 'gateway' ? 1 : 2),
    'synology-rs': synologyRs,
    'synology-ds': synologyDs,
    server: genericServer,
    switch: genericSwitch,
    plain: plainFront,
  };

  function wattsText(info, item) {
    if (info.measuredW !== null) return `${fmt.n(info.measuredW)} W`;
    const parts = [];
    if (item.estimateW > 0) parts.push(`~${fmt.n(item.estimateW)} W`);
    if (info.poeW > 0) parts.push(`PoE ${fmt.n(info.poeW, 1)} W`);
    return parts.join(' + ');
  }

  const ear = () => el('span', { class: 'ear' });

  function faceplate(item, data, opts) {
    const info = itemInfo(item, data);
    const fr = frontOf(item, info);
    const node = el('div', {
      class: `rack-item front-${fr.model} kind-${item.kind} h${item.height}${info.status ? ` st-${info.status}` : ''}`,
      role: 'button',
      tabindex: '0',
      'data-id': item.id,
      'aria-label': `${item.name}, ${item.height} U${info.status ? `, status ${info.status}` : ''}`,
      title: [item.name, info.sub, wattsText(info, item)].filter(Boolean).join(' · '),
    }, ear(), el('div', { class: 'face' }, FRONTS[fr.model](item, info, fr)), ear());
    const activate = () => opts.onSelect && opts.onSelect(item, info);
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), activate()));
    return node;
  }

  // --- Passive items: blanks, patch panels, shelves… (no name, not monitored) ---

  function patchPorts(p) {
    const rows = p.ports > 24 ? 2 : 1;
    const groups = p.ports / rows / 6;
    return el('div', { class: 'patch' }, Array.from({ length: rows }, () => el('div', { class: 'patch-row' },
      Array.from({ length: groups }, () => el('div', { class: 'patch-group' }, el('span', { class: 'patch-label' }), el('span', { class: 'patch-jacks' }, Array.from({ length: 6 }, () => el('i'))))))));
  }

  function passiveFace(p, opts) {
    const label = PASSIVE_LABELS[p.kind];
    const inner = {
      blank: () => null,
      vented: () => el('span', { class: 'vent' }),
      brush: () => el('span', { class: 'brush' }),
      cable: () => el('span', { class: 'rings' }, Array.from({ length: 5 }, () => el('i'))),
      patch: () => patchPorts(p),
      shelf: () => el('span', { class: 'lip' }),
    }[p.kind]();
    const node = el('div', {
      class: `rack-item passive p-${p.kind} h${p.height}`,
      'data-id': p.id,
      title: `${label}${p.kind === 'patch' ? `, ${p.ports} ports` : ''} · ${p.height} U`,
      ...(opts.editable ? { role: 'button', tabindex: '0', 'aria-label': `${label}, ${p.height} U at U${p.u}` } : { 'aria-hidden': 'true' }),
    }, ear(), el('div', { class: 'face' }, inner), ear());
    if (opts.editable && opts.onSelectPassive) {
      node.addEventListener('click', () => opts.onSelectPassive(p));
      node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), opts.onSelectPassive(p)));
    }
    return node;
  }

  function offRackCard(item, data, opts) {
    const info = itemInfo(item, data);
    const ud = info.ud;
    const detail = ud
      ? [ud.online ? 'Online' : 'Offline', ud.clients != null ? `${ud.clients} clients` : '', info.poeW == null && item.estimateW ? `~${item.estimateW} W` : ''].filter(Boolean).join(' · ')
      : wattsText(info, item);
    const node = el('div', { class: `offrack-item${info.status ? ` st-${info.status}` : ''}${opts.selectedId === item.id ? ' selected' : ''}`, role: 'button', tabindex: '0', 'data-id': item.id },
      el('span', { class: `device-icon kind-${item.kind}`, 'aria-hidden': 'true' }),
      el('div', null, el('strong', { text: item.name }), el('div', { class: 'small muted', text: detail || KIND_LABELS[item.kind] })),
      led(info.status || 'off', info.status || 'Not monitored'));
    node.addEventListener('click', () => opts.onSelect && opts.onSelect(item, info));
    return node;
  }

  // opts: { uPx, onSelect(item, info), editable, onMove(item, u), onEmpty(u), onSelectPassive(p), onMovePassive(p, u) }
  function render(container, rack, data, opts = {}) {
    const u = opts.uPx || 30;
    const units = rack.units;
    const top = rack.numbering === 'top';
    const rowOf = (n) => (top ? n - 1 : units - n); // row index from the top for unit n
    const slots = el('div', { class: 'rack-slots' });
    slots.style.height = `${units * u}px`;
    slots.style.setProperty('--u', `${u}px`);
    const rails = (side) => el('div', { class: `rack-rail ${side}` }, Array.from({ length: units }, (_, i) => {
      const n = top ? i + 1 : units - i;
      return el('span', { text: String(n) });
    }));
    for (const it of rack.items.filter(inRack)) {
      const node = faceplate(it, data, opts);
      if (opts.selectedId === it.id) node.classList.add('selected');
      const firstRow = Math.min(rowOf(it.u), rowOf(it.u + it.height - 1));
      node.style.top = `${firstRow * u}px`;
      node.style.height = `${it.height * u}px`;
      if (opts.editable) enableDrag(node, it, rack, u, rowOf, opts.onMove);
      slots.append(node);
    }
    for (const p of rack.passive || []) {
      const node = passiveFace(p, opts);
      if (opts.selectedId === p.id) node.classList.add('selected');
      node.style.top = `${Math.min(rowOf(p.u), rowOf(p.u + p.height - 1)) * u}px`;
      node.style.height = `${p.height * u}px`;
      if (opts.editable && opts.onMovePassive) enableDrag(node, p, rack, u, rowOf, opts.onMovePassive);
      slots.append(node);
    }
    if (opts.editable && opts.onEmpty) {
      slots.addEventListener('dblclick', (e) => {
        if (e.target !== slots) return;
        const row = Math.floor((e.clientY - slots.getBoundingClientRect().top) / u);
        opts.onEmpty(top ? row + 1 : units - row);
      });
    }
    const frame = el('div', { class: 'rack-frame' }, rails('left'), slots, rails('right'));
    frame.style.setProperty('--u', `${u}px`);
    const off = rack.items.filter(outside);
    container.replaceChildren(...[
      el('div', { class: 'rack-top' }),
      frame,
      el('div', { class: 'rack-bottom' }),
      off.length ? el('div', { class: 'offrack' }, el('div', { class: 'card-type', text: 'Outside the rack' }), off.map((it) => offRackCard(it, data, opts))) : null,
    ].filter(Boolean)); // replaceChildren would turn null into the text "null"
  }

  // Admin: drag an item up/down; it snaps to units and only lands on free space.
  function enableDrag(node, item, rack, u, rowOf, onMoved) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY;
      const startTop = parseFloat(node.style.top);
      let target = item.u;
      let moved = false;
      node.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        node.classList.add('dragging');
        const rows = Math.round(dy / u);
        const step = rack.numbering === 'top' ? rows : -rows;
        const cand = Math.min(Math.max(item.u + step, 1), rack.units - item.height + 1);
        const others = [...rack.items.filter(inRack), ...(rack.passive || [])].filter((o) => o.id !== item.id);
        const free = !others.some((o) => cand <= o.u + o.height - 1 && o.u <= cand + item.height - 1);
        node.classList.toggle('blocked', !free);
        if (free) target = cand;
        node.style.top = `${startTop + dy}px`;
      };
      const onUp = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        node.classList.remove('dragging', 'blocked');
        if (moved && target !== item.u) onMoved(item, target);
        else node.style.top = `${startTop}px`;
        if (moved) node.addEventListener('click', (ce) => ce.stopImmediatePropagation(), { once: true, capture: true });
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }

  return { render, resolve, itemInfo, linkStatus, inRack, frontOf, KIND_LABELS, FRONT_LABELS, DRIVE_LABELS, PASSIVE_LABELS, WITH_DRIVES };
})();
