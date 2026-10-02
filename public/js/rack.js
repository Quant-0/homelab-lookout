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

  // --- faceplate parts ---

  const led = (cls, title) => el('span', { class: `led ${cls || 'off'}`, title });

  function ports(device, fallbackCount) {
    const list = device?.ports?.length ? device.ports : Array.from({ length: fallbackCount }, (_, i) => ({ idx: i + 1, up: false, poeW: null, sfp: false, speed: null }));
    const rj = list.filter((p) => !p.sfp);
    const sfp = list.filter((p) => p.sfp);
    const port = (p) => {
      const cls = ['port', p.up ? 'up' : 'down', p.poeW > 0 ? 'poe' : '', p.uplink ? 'uplink' : '', p.sfp ? 'sfp' : ''].filter(Boolean).join(' ');
      const speed = p.speed ? (p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`) : '';
      const title = [`${p.name || `Port ${p.idx}`}`, p.up ? speed || 'up' : 'down', p.poeW > 0 ? `PoE ${fmt.n(p.poeW, 1)} W` : '', p.uplink ? 'uplink' : ''].filter(Boolean).join(' · ');
      return el('span', { class: cls, title });
    };
    // Two rows like a real switch: odd ports on top, even below
    const top = rj.filter((_, i) => i % 2 === 0);
    const bottom = rj.filter((_, i) => i % 2 === 1);
    return el('div', { class: 'fp-ports' },
      el('div', { class: 'port-grid' }, el('div', { class: 'port-row' }, top.map(port)), el('div', { class: 'port-row' }, bottom.map(port))),
      sfp.length ? el('div', { class: 'port-grid sfp' }, el('div', { class: 'port-row' }, sfp.map(port))) : null);
  }

  function bays(count, disks, vertical) {
    return el('div', { class: `fp-bays${vertical ? ' vertical' : ''}` }, Array.from({ length: count }, (_, i) => {
      const d = disks?.[i];
      if (!d) return el('span', { class: 'bay', title: disks ? 'Empty bay' : null });
      const st = ['Critical', 'Failing'].includes(d.health) || d.status === 'Crashed' ? 'critical' : d.health === 'Warning' ? 'warning' : 'good';
      return el('span', { class: `bay filled ${st}`, title: `${d.id} · ${d.model || ''} · ${d.temp ?? '–'} °C · ${d.health || d.status || ''}` });
    }));
  }

  function faceBody(item, info) {
    const h = item.height;
    switch (item.kind) {
      case 'switch':
      case 'gateway':
        return ports(info.ud, item.kind === 'gateway' ? 10 : 24);
      case 'nas': {
        const disks = info.syno?.disks;
        return bays(Math.max(disks?.length || 4, 2), disks, h >= 2);
      }
      case 'server':
      case 'storage':
        return bays(h >= 2 ? 12 : 8, null, false);
      case 'patch-panel':
        return el('div', { class: 'fp-holes' }, Array.from({ length: 24 * h }, () => el('span')));
      case 'pdu':
        return el('div', { class: 'fp-outlets' }, Array.from({ length: 8 }, () => el('span')));
      case 'blank':
      case 'shelf':
        return el('div', { class: 'fp-vent' });
      default:
        return el('div', { class: 'fp-fill' });
    }
  }

  function wattsText(info, item) {
    if (info.measuredW !== null) return `${fmt.n(info.measuredW)} W`;
    const parts = [];
    if (item.estimateW > 0) parts.push(`~${fmt.n(item.estimateW)} W`);
    if (info.poeW > 0) parts.push(`PoE ${fmt.n(info.poeW, 1)} W`);
    return parts.join(' + ');
  }

  function faceplate(item, data, opts) {
    const info = itemInfo(item, data);
    const passive = ['patch-panel', 'shelf', 'blank'].includes(item.kind);
    const node = el('div', {
      class: `rack-item kind-${item.kind} h${item.height}${info.status ? ` st-${info.status}` : ''}`,
      role: 'button',
      tabindex: '0',
      'data-id': item.id,
      'aria-label': `${item.name}, ${item.height} U${info.status ? `, status ${info.status}` : ''}`,
      title: [item.name, info.sub, wattsText(info, item)].filter(Boolean).join(' · '),
    },
    el('span', { class: 'ear' }),
    el('div', { class: 'face' },
      el('div', { class: 'fp-label' }, el('strong', { text: item.name }), info.sub && item.height > 1 ? el('span', { text: info.sub }) : null),
      faceBody(item, info),
      passive ? null : el('div', { class: 'fp-meta' },
        el('span', { class: 'fp-watts num', text: wattsText(info, item) }),
        info.idrac ? led(info.idrac.powerState === 'On' ? 'good' : 'off', `Power ${info.idrac.powerState || 'unknown'}`) : null,
        led(info.status || (item.links?.length ? 'off' : ''), info.status ? `Status: ${info.status}` : 'Not monitored'))),
    el('span', { class: 'ear' }));
    const activate = () => opts.onSelect && opts.onSelect(item, info);
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), activate()));
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

  // opts: { uPx, onSelect(item, info), editable, onMove(item, u), onEmpty(u) }
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
      if (opts.editable) enableDrag(node, it, rack, u, rowOf, opts);
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
  function enableDrag(node, item, rack, u, rowOf, opts) {
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
        const free = !rack.items.some((o) => o !== item && inRack(o) && cand <= o.u + o.height - 1 && o.u <= cand + item.height - 1);
        node.classList.toggle('blocked', !free);
        if (free) target = cand;
        node.style.top = `${startTop + dy}px`;
      };
      const onUp = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onUp);
        node.removeEventListener('pointercancel', onUp);
        node.classList.remove('dragging', 'blocked');
        if (moved && target !== item.u) opts.onMove(item, target);
        else node.style.top = `${startTop}px`;
        if (moved) node.addEventListener('click', (ce) => ce.stopImmediatePropagation(), { once: true, capture: true });
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }

  return { render, resolve, itemInfo, linkStatus, inRack, KIND_LABELS };
})();
