'use strict';
// Rack view, drawn to scale: 19" equipment is 482.6 mm wide and one unit (U) is 44.45 mm, so every
// front keeps its real proportions at any size. Two looks:
// - realistic: fronts modelled on the real hardware, with live LEDs (drives from the iDRAC's drive
//   inventory, switch ports with link and PoE, power), names beside the rack instead of on the fronts;
// - schematic: flat blocks with icon, name, status and one number.
// Shared by the dashboard (click to jump to a device) and the admin editor (drag to move).

const Rack = (() => {
  const { el, svg: S, fmt, statusClass } = HD;
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
    camera: 'Camera',
    other: 'Other',
  };
  const KIND_ICONS = { server: 'server', storage: 'database', nas: 'hard-drive', switch: 'network', gateway: 'router', ap: 'wifi', camera: 'cctv', pdu: 'plug', ups: 'battery-charging', 'patch-panel': 'cable', shelf: 'layers', blank: 'square-stack', other: 'box' };

  // Find the monitored data behind each link of an item.
  function resolve(item, data) {
    const out = [];
    for (const link of item.links || []) {
      if (link.startsWith('host:')) {
        const id = link.slice(5);
        for (const type of ['idrac', 'proxmox', 'truenas', 'synology', 'snmp', 'nut', 'omada']) {
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
      case 'snmp':
      case 'nut':
        return d.ups?.lowBattery ? 'critical' : d.ups?.onBattery ? 'warning' : 'good';
      case 'omada':
        return 'good';
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
    const sub = idrac?.model || syno?.system?.model || ud?.model || item.model?.name || (item.links?.length ? '' : KIND_LABELS[item.kind]);
    // what the alerts say about the device counts too (a failed power supply, a full volume…)
    const alerts = (data?.attention || []).filter((a) => a.deviceId === item.id);
    const alerted = alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : '';
    return { links, status: worst([...links.map(linkStatus), alerted]), measuredW, poeW, idrac, syno, ud, sub };
  }

  // --- Which front: what the device reports decides, unless chosen in Admin ---

  const FRONT_LABELS = {
    auto: 'Automatic',
    dell13: 'Dell PowerEdge, 13th gen (R630, R730)',
    dell14: 'Dell PowerEdge, 14th gen or newer (R640, R740)',
    hpe: 'HPE ProLiant (DL360, DL380)',
    lenovo: 'Lenovo ThinkSystem (SR630, SR650)',
    supermicro: 'Supermicro',
    'udm-pro': 'UniFi Dream Machine Pro',
    'usw-24-poe': 'UniFi Switch 24 PoE',
    'unifi-switch': 'UniFi switch',
    'synology-rs': 'Synology RackStation',
    'synology-ds': 'Synology DiskStation (desktop, on a shelf)',
    server: 'Generic server',
    switch: 'Generic switch',
    plain: 'Plain front',
  };
  if (typeof UNIFI_MODELS !== 'undefined') for (const m of UNIFI_MODELS) if (!FRONT_LABELS[m.front]) FRONT_LABELS[m.front] = `UniFi ${m.name}`;
  const DRIVE_LABELS = { auto: 'Automatic', none: 'No drive bays', '4x3.5': '4 × 3.5″', '8x3.5': '8 × 3.5″', '12x3.5': '12 × 3.5″', '8x2.5': '8 × 2.5″', '10x2.5': '10 × 2.5″', '16x2.5': '16 × 2.5″', '24x2.5': '24 × 2.5″' };
  const DRIVES = { '4x3.5': [4, 1, 'lff'], '8x3.5': [4, 2, 'lff'], '12x3.5': [4, 3, 'lff'], '8x2.5': [8, 1, 'sff'], '10x2.5': [10, 1, 'sff'], '16x2.5': [16, 1, 'sff'], '24x2.5': [24, 1, 'sff'] };
  const PASSIVE_LABELS = { blank: 'Blank panel', vented: 'Vented panel', brush: 'Brush panel', cable: 'Cable management', patch: 'Patch panel', shelf: 'Shelf' };
  const WITH_DRIVES = new Set(['dell13', 'dell14', 'hpe', 'lenovo', 'supermicro', 'server']);

  // The bay layout that holds the drives the iDRAC reports (the highest bay number decides)
  function layoutForDrives(drives, oneU) {
    const bays = Math.max(...drives.map((x) => x.bay)) + 1;
    const sizes = drives.map((x) => x.size).filter(Boolean);
    const small = sizes.length ? sizes.filter((x) => x === '2.5').length > sizes.length / 2 : null;
    const options = small === false || (small === null && !oneU)
      ? (oneU ? ['4x3.5'] : ['8x3.5', '12x3.5'])
      : (oneU ? ['8x2.5', '10x2.5'] : ['8x2.5', '16x2.5', '24x2.5']);
    return options.find((k) => DRIVES[k][0] * DRIVES[k][1] >= bays) || options[options.length - 1];
  }

  function autoFront(item, info) {
    const dell = /\bR(\d)(\d)0(xd)?\b/i.exec(info.idrac?.model || '');
    if (dell) {
      const gen = 10 + Number(dell[2]); // R730 → 13th gen, R740 → 14th
      const oneU = item.height === 1 || dell[1] === '6' || dell[1] === '4';
      const drives = info.idrac?.drives?.length
        ? layoutForDrives(info.idrac.drives, oneU)
        : dell[3] ? (oneU ? '10x2.5' : '12x3.5') : oneU ? (gen >= 14 ? '10x2.5' : '8x2.5') : '8x3.5';
      return { model: gen >= 14 ? 'dell14' : 'dell13', drives };
    }
    const rf = `${info.idrac?.model || ''} ${item.model?.brand || ''} ${item.model?.name || ''}`;
    const oneU = item.height === 1;
    const drivesFor = (fallback) => (info.idrac?.drives?.length ? layoutForDrives(info.idrac.drives, oneU) : fallback);
    if (/ProLiant|HPE/i.test(rf)) return { model: 'hpe', drives: drivesFor(oneU ? '8x2.5' : '8x3.5') };
    if (/ThinkSystem|Lenovo/i.test(rf)) return { model: 'lenovo', drives: drivesFor(oneU ? '10x2.5' : '12x3.5') };
    if (/Supermicro|SYS-\d/i.test(rf)) return { model: 'supermicro', drives: drivesFor(oneU ? '4x3.5' : '8x3.5') };
    const um = String(info.ud?.model || '');
    const known = unifiOf({ ...item, front: null }, info);
    if (known) return { model: known.front };
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

  function wattsText(info, item) {
    if (info.measuredW !== null) return `${fmt.n(info.measuredW)} W`;
    const parts = [];
    if (item.estimateW > 0) parts.push(`~${fmt.n(item.estimateW)} W`);
    if (info.poeW > 0) parts.push(`PoE ${fmt.n(info.poeW, 1)} W`);
    return parts.join(' + ');
  }

  // --- Drawing (all sizes in millimetres) ---

  const W = 482.6; // 19" panel
  const U = 44.45; // one unit
  const FRAME = { left: 34, right: 10, top: 14, bottom: 14 }; // around the panel area; U numbers on the left
  const GREEN = '#3ee07a';
  const AMBER = '#ffb02e';
  const BLUE = '#4a90ff';
  const RED = '#ff5a3c';
  const OFF = '#2c2f34';

  const r = (x, y, w, h, fill, a = {}) => S('rect', { x, y, width: w, height: h, fill, ...a });
  const c = (cx, cy, rad, fill, a = {}) => S('circle', { cx, cy, r: rad, fill, ...a });
  const g = (a, ...kids) => S('g', a, ...kids);
  const tip = (text) => S('title', null, text);
  // a lit LED gets a soft halo
  const led = (cx, cy, rad, color, lit = true) => g(null, lit ? c(cx, cy, rad * 2.6, color, { opacity: 0.22 }) : null, c(cx, cy, rad, lit ? color : OFF));

  let seq = 0;
  // Patterns shared by all fronts of one rack (perforation, slots, honeycomb, metal)
  function defs(id) {
    return S('defs', null,
      S('linearGradient', { id: id('silver'), x1: 0, y1: 0, x2: 0, y2: 1 }, S('stop', { offset: 0, 'stop-color': '#f3f4f6' }), S('stop', { offset: 1, 'stop-color': '#cdd1d7' })),
      S('linearGradient', { id: id('black'), x1: 0, y1: 0, x2: 0, y2: 1 }, S('stop', { offset: 0, 'stop-color': '#25282d' }), S('stop', { offset: 1, 'stop-color': '#16181b' })),
      S('pattern', { id: id('holes'), width: 3.2, height: 3.2, patternUnits: 'userSpaceOnUse' }, c(1.6, 1.6, 0.85, '#050506')),
      S('pattern', { id: id('slots'), width: 2.4, height: 40, patternUnits: 'userSpaceOnUse' }, r(0, 0, 1.15, 40, '#0b0c0e')),
      S('pattern', { id: id('slots-h'), width: 40, height: 2.2, patternUnits: 'userSpaceOnUse' }, r(0, 0, 40, 1.05, '#0b0c0e')),
      S('pattern', { id: id('hex'), width: 3, height: 5.2, patternUnits: 'userSpaceOnUse' }, c(1.5, 1.3, 0.9, '#0a0b0d'), c(0, 3.9, 0.9, '#0a0b0d'), c(3, 3.9, 0.9, '#0a0b0d')),
      S('pattern', { id: id('hex-light'), width: 3, height: 5.2, patternUnits: 'userSpaceOnUse' }, c(1.5, 1.3, 0.85, '#9da3ab'), c(0, 3.9, 0.85, '#9da3ab'), c(3, 3.9, 0.85, '#9da3ab')),
      S('pattern', { id: id('bristle'), width: 1.1, height: 20, patternUnits: 'userSpaceOnUse' }, r(0, 0, 0.45, 20, '#2e3136')));
  }

  // The rack: body, posts with three square holes per U (EIA-310) and the unit numbers
  function frameSvg(units, top, H, id) {
    const s = S('svg', { class: 'rack-frame', viewBox: `${-FRAME.left} ${-FRAME.top} ${W + FRAME.left + FRAME.right} ${H + FRAME.top + FRAME.bottom}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      defs(id),
      r(-12, -FRAME.top, W + 12 + FRAME.right, H + FRAME.top + FRAME.bottom, null, { class: 'rk-body', rx: 6 }),
      r(0, 0, W, H, null, { class: 'rk-void' }));
    for (const x0 of [0, W - 16]) {
      s.append(r(x0, 0, 16, H, null, { class: 'rk-rail' }));
      const holes = g({ class: 'rk-holes' });
      for (let i = 0; i < units; i++) for (const off of [6.35, 22.225, 38.1]) holes.append(r(x0 + 4.6, (i + 1) * U - off - 3.4, 6.8, 6.8, null, { rx: 0.6 }));
      s.append(holes);
    }
    for (let i = 0; i < units; i++) {
      s.append(S('text', { class: 'rk-num', x: -15, y: i * U + U / 2 + 5.4, 'text-anchor': 'end', 'font-size': 15.5 }, String(top ? i + 1 : units - i)));
      if (i) s.append(S('line', { class: 'rk-tick', x1: -5, x2: 0, y1: i * U, y2: i * U }));
    }
    return s;
  }

  // Ears with one screw per unit (switches, panels)
  function ears(h, fill, units) {
    const out = [r(0.4, 0.6, 19, h - 1.2, fill, { rx: 1.6 }), r(W - 19.4, 0.6, 19, h - 1.2, fill, { rx: 1.6 })];
    for (let i = 0; i < units; i++) {
      for (const x of [9.6, W - 9.6]) out.push(c(x, i * U + U / 2, 2.7, '#3a3d42'), c(x, i * U + U / 2, 1.6, '#16181a'));
    }
    return out;
  }

  // --- Drive bays: 3.5" lie flat; 2.5" stand up in 2U and lie flat in 1U ---

  function bayGrid(layout, units, area) {
    const spec = DRIVES[layout];
    if (!spec) return null;
    const count = spec[0] * spec[1];
    let cols;
    let rows;
    let cw;
    let ch;
    let orient = 'flat';
    if (spec[2] === 'lff') [cols, rows, cw, ch] = [spec[0], spec[1], 101.6, 26.4];
    else if (units >= 2) [cols, rows, cw, ch, orient] = [count, 1, 15.6, 70, 'stand'];
    else [cols, rows, cw, ch] = [Math.ceil(count / 2), 2, 70, 15.6];
    const gap = 1.4;
    const groupGap = orient === 'stand' && count >= 16 ? 8 : 0;
    const groups = groupGap ? Math.ceil(cols / 8) : 1;
    let totalW = cols * cw + (cols - 1) * gap + (groups - 1) * groupGap;
    if (totalW > area.w) {
      cw *= (area.w - (cols - 1) * gap - (groups - 1) * groupGap) / (cols * cw);
      totalW = area.w;
    }
    let totalH = rows * ch + (rows - 1) * gap;
    if (totalH > area.h) {
      ch = (area.h - (rows - 1) * gap) / rows;
      totalH = area.h;
    }
    return { count, cols, rows, cw, ch, gap, groupGap, orient, lff: spec[2] === 'lff', x0: area.x + (area.w - totalW) / 2, y0: area.y + area.h - totalH, totalW, totalH };
  }

  function bayPos(gr, i) {
    const col = i % gr.cols;
    const row = Math.floor(i / gr.cols);
    return [gr.x0 + col * (gr.cw + gr.gap) + (gr.groupGap ? Math.floor(col / 8) * gr.groupGap : 0), gr.y0 + row * (gr.ch + gr.gap)];
  }

  function driveTitle(bay, d) {
    if (!d) return `Bay ${bay}: empty`;
    const size = d.capacityBytes ? `${fmt.n(d.capacityBytes / 1e12, d.capacityBytes >= 1e12 ? 1 : 2)} TB` : '';
    return [`Bay ${bay}`, d.model, size, d.mediaType, d.failurePredicted ? 'predicted to fail' : d.health].filter(Boolean).join(' · ');
  }

  // One carrier (or a blank where the iDRAC reports no drive). Dell 13th gen: grey release button
  // and slotted front; 14th gen: slimmer latch and a honeycomb front.
  function carrier(x, y, gr, opts, id) {
    const { w = gr.cw, h = gr.ch, on, drive, empty, gen, bay } = opts;
    const stand = gr.orient === 'stand';
    if (empty) {
      return g({ class: 'drive empty', transform: `translate(${x} ${y})` }, tip(driveTitle(bay, null)),
        r(0, 0, w, h, '#141619', { rx: 0.9, stroke: '#0a0b0c', 'stroke-width': 0.5 }),
        stand ? r(w / 2 - 0.9, 5, 1.8, h - 10, '#0d0e10', { rx: 0.9 }) : r(5, h / 2 - 0.9, w - 10, 1.8, '#0d0e10', { rx: 0.9 }));
    }
    const st = drive ? (drive.health === 'Critical' ? 'critical' : drive.health === 'Warning' || drive.failurePredicted ? 'warning' : 'good') : '';
    const lit = on;
    const statusColor = st === 'critical' ? RED : st === 'warning' ? AMBER : GREEN;
    const body = gen >= 14 ? '#1d2024' : '#212428';
    const vent = `url(#${id(gen >= 14 ? 'hex' : stand ? 'slots-h' : 'slots')})`;
    const parts = [r(0, 0, w, h, body, { rx: 0.9, stroke: '#0a0b0c', 'stroke-width': 0.5 })];
    if (stand) {
      parts.push(r(2, 8, w - 4, h * 0.56, vent, { rx: 0.6 }),
        r(2.4, h - 15.5, w - 4.8, 12.5, gen >= 14 ? '#8b929a' : '#737a83', { rx: 1.4 }),
        led(w * 0.3, 3.8, 1, GREEN, lit), led(w * 0.7, 3.8, 1, statusColor, lit || st === 'critical'));
    } else {
      const latchW = Math.min(14, w * 0.15);
      parts.push(r(1.4, 1.4, latchW, h - 2.8, '#2c3035', { rx: 0.8 }),
        gen >= 14 ? r(1.4 + latchW / 2 - 2, 3, 4, h - 6, '#8b929a', { rx: 1.2 }) : r(3, h / 2 - h * 0.17, latchW - 3.2, h * 0.34, '#737a83', { rx: 1.4 }),
        r(latchW + 4, 3.2, w - latchW - 11, h - 6.4, vent, { rx: 0.6 }),
        led(w - 3.5, h * 0.3, Math.min(1.05, h * 0.06), GREEN, lit), led(w - 3.5, h * 0.7, Math.min(1.05, h * 0.06), statusColor, lit || st === 'critical'));
    }
    return g({ class: `drive${lit ? ' on' : ''}${st ? ` ${st}` : ''}`, transform: `translate(${x} ${y})` }, tip(driveTitle(bay, drive)), ...parts);
  }

  // The drive area: bays from the layout; drives from the iDRAC fill their bays, the rest are blanks
  function driveArea(area, layout, units, on, info, gen, id) {
    const gr = bayGrid(layout, units, area);
    if (!gr) return [r(area.x, area.y, area.w, area.h, `url(#${id('holes')})`, { opacity: 0.8 })];
    const out = [];
    const known = Array.isArray(info.idrac?.drives) && info.idrac.drives.length > 0;
    const byBay = new Map((info.idrac?.drives || []).map((d) => [d.bay, d]));
    // what's left above the drives is perforated, like the real chassis
    if (gr.y0 - area.y > 6) out.push(r(area.x + 2, area.y + 1.5, area.w - 4, gr.y0 - area.y - 4, `url(#${id('holes')})`, { rx: 1 }));
    for (let i = 0; i < gr.count; i++) {
      const [x, y] = bayPos(gr, i);
      out.push(carrier(x, y, gr, { on, gen, bay: i, drive: byBay.get(i), empty: known && !byBay.has(i) }, id));
    }
    return out;
  }

  // --- Fronts ---

  function dell(item, info, fr, h, id, gen) {
    const d = info.idrac;
    const on = d ? d.powerState === 'On' : false;
    const oneU = item.height === 1;
    const fault = info.status === 'critical' || info.status === 'warning';
    const out = [r(0, 0.5, W, h - 1, `url(#${id('black')})`, { rx: 2.4 }), r(2, 0.5, W - 4, 1, '#3a3e44')];
    // control panels on the ears
    out.push(r(0.6, 1.2, 23, h - 2.4, '#202327', { rx: 2 }), r(W - 23.6, 1.2, 23, h - 2.4, '#202327', { rx: 2 }));
    if (gen >= 14) {
      // status icons (drive, temperature, electrical, memory, PCIe) light amber on a fault
      const tempBad = (d?.temps || []).some((t) => t.warn && t.celsius >= t.warn) || (d?.fans || []).some((f) => ['Critical', 'Warning'].includes(f.health));
      const powerBad = (d?.psus || []).some((p) => p.state !== 'Absent' && p.health && p.health !== 'OK');
      const driveBad = (d?.drives || []).some((x) => x.health !== 'OK' || x.failurePredicted);
      const icons = [['Drives', driveBad], ['Temperature', tempBad], ['Electrical', powerBad], ['Memory', false], ['PCIe', false]];
      const step = oneU ? 6.6 : 7.4;
      icons.forEach(([name, bad], i) => out.push(g({ class: `dell-icon${bad ? ' bad' : ''}` }, tip(`${name}${bad ? ': fault' : ''}`), r(4, 5 + i * step, 6, step - 2.4, bad ? AMBER : '#30343a', { rx: 0.8 }))));
      out.push(g({ class: `dell-id ${info.status || ''}` }, tip(`Health: ${d?.health || 'unknown'}`), led(16.5, oneU ? 9 : 12, 2.6, fault ? AMBER : BLUE, on)));
    } else {
      // 13th gen: the LCD (blue, amber on a fault) with its buttons
      const w = on ? wattsText(info, item) : '';
      out.push(r(2.6, oneU ? 4 : 6, 18, oneU ? 10 : 12, !on ? '#0d1116' : fault ? '#e39a12' : '#2f6fd0', { rx: 1, class: `dell-lcd${fault ? ' fault' : ''}` }));
      if (w) out.push(S('text', { x: 11.6, y: oneU ? 10.8 : 13.8, 'text-anchor': 'middle', class: 'lcd-text', 'font-size': 5.4, fill: fault ? '#1b1300' : '#eaf3ff' }, w.replace(' ', '')));
      for (const x of [6.8, 11.6, 16.4]) out.push(c(x, oneU ? 19 : 23.5, 1.5, '#3a3e44'));
      if (!oneU) out.push(c(11.6, 33, 3, '#2b2f35', { stroke: '#4a4f56', 'stroke-width': 0.6 }));
    }
    // right: power button, USB, iDRAC Direct, VGA
    out.push(g({ class: `dell-power${on ? ' on' : ''}` }, tip(`Power ${d?.powerState || 'unknown'}`),
      on ? c(W - 11.6, 9, 6.5, GREEN, { opacity: 0.18 }) : null,
      c(W - 11.6, 9, 3.8, '#17191c', { stroke: on ? GREEN : '#4a4f56', 'stroke-width': 1.3 })));
    if (gen >= 14) out.push(r(W - 14.6, 16, 6, 2.6, '#0b0c0d', { rx: 0.6, stroke: '#545a62', 'stroke-width': 0.4 }));
    out.push(r(W - 17.1, gen >= 14 ? 21 : 17, 11, 4.2, '#0b0c0d', { stroke: '#5a6068', 'stroke-width': 0.5 }));
    if (!oneU) {
      if (gen < 14) out.push(r(W - 17.1, 23, 11, 4.2, '#0b0c0d', { stroke: '#5a6068', 'stroke-width': 0.5 }));
      out.push(S('path', { d: `M${W - 18.6} 31h14l-1.8 6h-10.4z`, fill: '#284a7c' }));
    }
    const area = { x: 27, y: 3, w: W - 54, h: h - 6 };
    out.push(...driveArea(area, fr.drives, item.height, on, info, gen, id));
    return out;
  }

  // RJ45 jack with link (green) and PoE (amber) LEDs; the bottom row is upside down
  function jack(x, y, p, flip) {
    const speed = p.speed ? (p.speed >= 1000 ? `${p.speed / 1000} Gbps` : `${p.speed} Mbps`) : '';
    const title = [`${p.name || `Port ${p.idx}`}`, p.up ? speed || 'up' : 'down', p.poeW > 0 ? `PoE ${fmt.n(p.poeW, 1)} W` : '', p.uplink ? 'uplink' : ''].filter(Boolean).join(' · ');
    const ly = flip ? 9.2 : 0.4;
    return g({ class: ['port', p.up ? 'up' : 'down', p.poeW > 0 ? 'poe' : '', p.uplink ? 'uplink' : ''].filter(Boolean).join(' '), transform: `translate(${x} ${y})` }, tip(title),
      r(0, 0, 12.4, 10.4, '#0c0d0f', { rx: 0.7, stroke: p.uplink ? BLUE : '#000', 'stroke-width': 0.5 }),
      r(4, flip ? -1.2 : 9.6, 4.4, 2, '#0c0d0f'),
      r(2, flip ? 6.2 : 2.2, 8.4, 2, '#24272c'),
      r(0.9, ly, 2.6, 0.9, p.up ? GREEN : '#2a2d31'),
      r(8.9, ly, 2.6, 0.9, p.poeW > 0 ? AMBER : '#2a2d31'));
  }

  function sfp(x, y, p) {
    return g({ class: `port sfp ${p.up ? 'up' : 'down'}`, transform: `translate(${x} ${y})` }, tip(`${p.name || `SFP ${p.idx}`} · ${p.up ? 'up' : 'down'}`),
      r(0, 0, 14.4, 9, '#3a3e44', { rx: 0.6 }), r(1.4, 1.4, 11.6, 6.2, '#0c0d0f', { rx: 0.4 }), r(0.6, -1.6, 2.4, 0.9, p.up ? GREEN : '#2a2d31'));
  }

  // Live ports when the device reports them, otherwise the model's port count (all dark)
  function portList(ud, rjCount, sfpCount) {
    if (ud?.ports?.length) return { rj: ud.ports.filter((p) => !p.sfp), sfp: ud.ports.filter((p) => p.sfp) };
    const fill = (n, isSfp, start) => Array.from({ length: n }, (_, i) => ({ idx: start + i, up: false, sfp: isSfp }));
    return { rj: fill(rjCount, false, 1), sfp: fill(sfpCount, true, rjCount + 1) };
  }

  // Two rows like a real switch (odd ports on top), in blocks of `block` columns
  function jackBlocks(list, x, y, block) {
    const out = [];
    const cols = Math.ceil(list.length / 2);
    for (let col = 0; col < cols; col++) {
      const bx = x + col * 13.9 + Math.floor(col / block) * 6;
      if (list[col * 2]) out.push(jack(bx, y, list[col * 2], false));
      if (list[col * 2 + 1]) out.push(jack(bx, y + 12.6, list[col * 2 + 1], true));
    }
    return { nodes: out, width: cols * 13.9 - 1.5 + Math.floor((cols - 1) / block) * 6 };
  }

  // UniFi touchscreen: the client count, like the real one shows status
  function uScreen(x, y, w, h, ud) {
    return g({ class: 'u-screen' }, tip(ud ? `${ud.clients ?? 0} clients` : 'Display'),
      r(x, y, w, h, '#05070b', { rx: 2, stroke: '#9aa0a8', 'stroke-width': 0.6 }),
      ud?.online ? S('text', { x: x + w / 2, y: y + h / 2 + 1.5, 'text-anchor': 'middle', fill: '#cfe6ff', class: 'screen-num', 'font-size': 9 }, String(ud.clients ?? '')) : null,
      ud?.online ? S('text', { x: x + w / 2, y: y + h / 2 + 7.4, 'text-anchor': 'middle', fill: '#7d9cc4', class: 'screen-sub', 'font-size': 3.6 }, 'clients') : null);
  }

  function unifiChassis(h, units, id, dark = false) {
    const fill = dark ? `url(#${id('black')})` : `url(#${id('silver')})`;
    return [...ears(h, dark ? '#2a2d32' : '#c9cdd2', units), r(19.6, 0.4, W - 39.2, h - 0.8, fill, { rx: 1.6, stroke: dark ? '#0b0c0e' : '#9aa0a8', 'stroke-width': 0.5 })];
  }

  function statusDot(x, y, info, item) {
    const st = info.status;
    return g({ class: `led-status ${st || 'off'}` }, tip(st ? `Status: ${st}` : item.links?.length ? 'Status: unknown' : 'Not monitored'), led(x, y, 1.5, st === 'critical' ? RED : st === 'warning' ? AMBER : st === 'good' ? '#9fd0ff' : OFF, Boolean(st)));
  }

  function udmPro(item, info, fr, h, id) {
    const { rj, sfp: sfps } = portList(info.ud, 9, 2);
    const y0 = (h - 23.2) / 2;
    const lan = jackBlocks(rj.slice(0, 8), 58, y0, 4);
    const out = [...unifiChassis(h, item.height, id), uScreen(26, 6.5, 24, h - 13, info.ud), ...lan.nodes];
    const wanX = 58 + lan.width + 5;
    if (rj[8]) out.push(jack(wanX, y0, rj[8], false));
    sfps.slice(0, 2).forEach((p, i) => out.push(sfp(wanX + 17, y0 + 1 + i * 12.6, p)));
    // the 3.5" drive bay behind a perforated door
    out.push(g({ class: 'u-bay' }, tip('Drive bay'), r(236, 5, 214, h - 10, '#c3c8ce', { rx: 1.4, stroke: '#9aa0a8', 'stroke-width': 0.5 }),
      r(244, 8, 198, h - 16, `url(#${id('hex-light')})`), r(238.5, h / 2 - 5, 3, 10, '#8a9098', { rx: 1 })));
    out.push(statusDot(456, h / 2, info, item));
    return out;
  }

  function unifiSwitch(item, info, fr, h, id, rjCount, sfpCount, dark = false) {
    const { rj, sfp: sfps } = portList(info.ud, rjCount, sfpCount);
    const y0 = (h - 23.2) / 2;
    const out = [...unifiChassis(h, item.height, id, dark)];
    if (!dark) out.push(uScreen(26, 6.5, 24, h - 13, info.ud));
    const start = dark ? 30 : 64;
    const blocks = jackBlocks(rj, start, y0, 6);
    out.push(...blocks.nodes);
    const sx = start + blocks.width + 10;
    sfps.forEach((p, i) => out.push(sfp(sx + Math.floor(i / 2) * 17, y0 + 1 + (i % 2) * 12.6, p)));
    out.push(statusDot(456, h / 2, info, item));
    return out;
  }

  // --- Any UniFi model, from its build in models.js: screen, jacks, SFP cages, bays, outlets ---

  // the small status display of Standard and Enterprise switches
  function lcm(x, y, w, hh, ud) {
    return g({ class: 'u-lcm' }, tip(ud ? `${ud.clients ?? 0} clients` : 'Display'),
      r(x, y, w, hh, '#05070b', { rx: 1.4, stroke: '#9aa0a8', 'stroke-width': 0.5 }),
      ud?.online ? r(x + 2.5, y + hh / 2 - 0.6, w - 5, 1.2, '#4f8dff', { rx: 0.6, opacity: 0.8 }) : null);
  }

  // a 3.5" tray: silver with a handle and two LEDs
  function uBay(x, y, w, hh, n, on) {
    return g({ class: 'u-bay' }, tip(`Drive bay ${n}`),
      r(x, y, w, hh, '#c3c8ce', { rx: 1.2, stroke: '#9aa0a8', 'stroke-width': 0.5 }),
      r(x + 3, y + 2.5, w - 6, hh - 5, '#b4b9c0', { opacity: 0.9 }),
      r(x + w / 2 - 6, y + hh - 4.2, 12, 2, '#8a9098', { rx: 1 }),
      led(x + w - 4, y + 3.5, 0.9, GREEN, on));
  }

  function outlet(x, y, s) {
    return g(null, r(x, y, s, s, '#15171a', { rx: s * 0.22, stroke: '#7b8189', 'stroke-width': 0.5 }),
      c(x + s * 0.32, y + s * 0.5, s * 0.1, '#050506'), c(x + s * 0.68, y + s * 0.5, s * 0.1, '#050506'));
  }

  function unifiFace(item, info, fr, h, id, m) {
    if (m.form !== 'rack') return onShelf(item, info, h, m);
    const out = [...unifiChassis(h, item.height, id)];
    const mid = h / 2;
    let x;
    if (m.screen === 'touch') {
      out.push(uScreen(26, mid - Math.min(31.5, h - 13) / 2, 24, Math.min(31.5, h - 13), info.ud));
      x = 58;
    } else if (m.screen === 'lcm') {
      out.push(lcm(26, mid - 7, 16, 14, info.ud));
      x = 50;
    } else x = 30;
    const right = W - 30;
    const on = Boolean(info.ud?.online) || Boolean(item.links?.length);
    if (m.ups) {
      out.push(r(x + 6, 6, right - x - 60, h - 12, `url(#${id('hex-light')})`, { rx: 1.5 }));
      out.push(c(right - 22, mid, 5.5, '#d7dbe0', { stroke: '#9aa0a8', 'stroke-width': 0.6 }), led(right - 22, mid, 1.4, on ? '#9fd0ff' : OFF, on));
    } else if (m.outlets) {
      const rows = Math.max(1, Math.min(m.outlets <= 16 ? 1 : 3, item.height + 1));
      const cols = Math.ceil(m.outlets / rows);
      const s = Math.min(15, (h - 8 - (rows - 1) * 3) / rows, (right - x - 4) / cols - 3);
      const gap = (right - x - cols * s) / Math.max(1, cols);
      for (let i = 0; i < m.outlets; i++) out.push(outlet(x + (i % cols) * (s + gap), mid - (rows * s + (rows - 1) * 3) / 2 + Math.floor(i / cols) * (s + 3), s));
    } else {
      // jacks, then the WAN jack, then SFP cages
      const { rj, sfp: sfps } = portList(info.ud, (m.rj || 0) + (m.wan || 0), m.sfp || 0);
      const y0 = mid - 11.6;
      let px = x;
      if (m.rj) {
        const lan = jackBlocks(rj.slice(0, m.rj), px, y0, m.type === 'gateway' ? 4 : 6);
        out.push(...lan.nodes);
        px += lan.width + 6;
      }
      if (m.wan) {
        rj.slice(m.rj, m.rj + m.wan).forEach((p, i) => out.push(jack(px, y0 + (i % 2) * 12.6, p, i % 2 === 1)));
        px += 17;
      }
      if (sfps.length) {
        const cols = Math.ceil(sfps.length / 2);
        const room = (m.bays ? 236 : right) - px;
        const pitch = Math.min(17, room / cols);
        sfps.forEach((p, i) => out.push(sfp(px + Math.floor(i / 2) * pitch, y0 + 1 + (i % 2) * 12.6, p)));
        px += cols * pitch + 6;
      }
      if (m.bays) {
        // network gear with drive bays (UDM SE, Pro Max): on the right; recorders: across the front
        const nvr = m.type === 'nvr' || m.type === 'other';
        const bx = nvr ? Math.max(px, x + 6) : 236;
        const rows = nvr ? Math.max(1, Math.ceil(m.bays / 8)) : 1;
        const cols = Math.ceil(m.bays / rows);
        const bw = (right - bx - (cols - 1) * 2) / cols;
        const bh = (h - 10 - (rows - 1) * 2) / rows;
        for (let i = 0; i < m.bays; i++) out.push(uBay(bx + (i % cols) * (bw + 2), 5 + Math.floor(i / cols) * (bh + 2), bw, bh, i + 1, on));
      }
    }
    out.push(statusDot(456, mid, info, item));
    return out;
  }

  // A desktop UniFi device placed in the rack stands on a shelf: its shape, at the bottom
  function onShelf(item, info, h, m) {
    const sh = SHAPES[m.shape] || SHAPES['gateway-small'];
    const s = Math.min(1, (h - 2) / sh.h);
    const g0 = g({ transform: `translate(${(W - sh.w * s) / 2} ${h - sh.h * s - 0.5}) scale(${s})` }, ...sh.draw(statusColor(info)));
    return [g0];
  }

  const statusColor = (info) => (info.status === 'critical' ? RED : info.status === 'warning' ? AMBER : info.status === 'good' ? '#9fd0ff' : '#c9d6e4');

  // --- Shapes of devices that aren't rack-mounted, in millimetres (front or below view) ---
  const WHITE = '#f3f4f6';
  const EDGE = '#c8ccd2';
  const SHAPES = {
    'ap-square': { w: 206, h: 206, draw: (st) => [r(0, 0, 206, 206, WHITE, { rx: 34, stroke: EDGE, 'stroke-width': 2 }), r(14, 14, 178, 178, 'none', { rx: 26, stroke: '#e3e6ea', 'stroke-width': 2 }), c(103, 103, 30, 'none', { stroke: st, 'stroke-width': 3.5, opacity: 0.9 }), c(103, 103, 5, '#b9bec5')] },
    'ap-round': { w: 160, h: 160, draw: (st) => [c(80, 80, 79, WHITE, { stroke: EDGE, 'stroke-width': 2 }), c(80, 80, 62, 'none', { stroke: '#e3e6ea', 'stroke-width': 2 }), c(80, 80, 13, 'none', { stroke: st, 'stroke-width': 4 })] },
    'ap-wall': { w: 120, h: 190, draw: (st) => [r(0, 0, 120, 190, WHITE, { rx: 18, stroke: EDGE, 'stroke-width': 2 }), r(40, 160, 40, 4, st, { rx: 2 })] },
    'in-wall': { w: 86, h: 150, draw: (st) => [r(0, 0, 86, 150, WHITE, { rx: 10, stroke: EDGE, 'stroke-width': 2 }), r(33, 18, 20, 3, st, { rx: 1.5 }), ...[0, 1, 2, 3].map((i) => r(9 + i * 18, 122, 14, 12, '#16181b', { rx: 1.5 }))] },
    mesh: { w: 46, h: 180, draw: (st) => [r(0, 0, 46, 180, WHITE, { rx: 23, stroke: EDGE, 'stroke-width': 2 }), c(23, 26, 4, st)] },
    outdoor: { w: 110, h: 240, draw: (st) => [r(0, 0, 110, 240, WHITE, { rx: 22, stroke: EDGE, 'stroke-width': 2 }), ...[0, 1, 2, 3].map((i) => r(20, 40 + i * 40, 70, 2, '#e1e4e8')), c(55, 214, 4, st)] },
    cylinder: { w: 110, h: 184, draw: (st) => [r(0, 10, 110, 174, WHITE, { rx: 30, stroke: EDGE, 'stroke-width': 2 }), S('ellipse', { cx: 55, cy: 14, rx: 50, ry: 10, fill: '#fbfbfc', stroke: EDGE, 'stroke-width': 1.5 }), r(34, 60, 42, 26, '#05070b', { rx: 4 }), c(55, 160, 3, st)] },
    'gateway-small': { w: 141, h: 34, draw: (st) => [r(0, 0, 141, 34, WHITE, { rx: 8, stroke: EDGE, 'stroke-width': 1.5 }), r(10, 8, 24, 18, '#05070b', { rx: 2.5 }), ...[0, 1, 2, 3, 4].map((i) => r(46 + i * 16, 10, 12, 13, '#16181b', { rx: 1.2 })), c(130, 17, 2.4, st)] },
    'gateway-max': { w: 100, h: 132, draw: (st) => [r(0, 0, 100, 132, WHITE, { rx: 12, stroke: EDGE, 'stroke-width': 1.8 }), r(26, 22, 48, 30, '#05070b', { rx: 4 }), r(30, 112, 40, 3, st, { rx: 1.5 })] },
    cube: { w: 100, h: 100, draw: (st) => [r(0, 0, 100, 100, WHITE, { rx: 16, stroke: EDGE, 'stroke-width': 1.8 }), r(24, 26, 52, 32, '#05070b', { rx: 4 }), c(50, 82, 3, st)] },
    'dream-wall': { w: 290, h: 470, draw: (st) => [r(0, 0, 290, 470, WHITE, { rx: 20, stroke: EDGE, 'stroke-width': 2 }), r(95, 50, 100, 70, '#05070b', { rx: 6 }), ...Array.from({ length: 12 }, (_, i) => r(55 + (i % 6) * 31, 380 + Math.floor(i / 6) * 30, 24, 22, '#16181b', { rx: 2 })), c(145, 440, 4, st)] },
    'switch-desk': { w: 200, h: 34, draw: (st) => [r(0, 0, 200, 34, WHITE, { rx: 6, stroke: EDGE, 'stroke-width': 1.5 }), ...Array.from({ length: 8 }, (_, i) => r(14 + i * 20, 10, 15, 14, '#16181b', { rx: 1.2 })), c(186, 17, 2.4, st)] },
    'switch-small': { w: 120, h: 32, draw: (st) => [r(0, 0, 120, 32, WHITE, { rx: 8, stroke: EDGE, 'stroke-width': 1.5 }), ...Array.from({ length: 5 }, (_, i) => r(12 + i * 18, 9, 14, 14, '#16181b', { rx: 1.2 })), c(108, 16, 2.4, st)] },
    'flex-mini': { w: 86, h: 22, draw: (st) => [r(0, 0, 86, 22, WHITE, { rx: 5, stroke: EDGE, 'stroke-width': 1.2 }), ...Array.from({ length: 5 }, (_, i) => r(6 + i * 14, 5, 11, 11, '#16181b', { rx: 1 })), c(80, 11, 1.8, st)] },
    'cam-bullet': { w: 190, h: 120, draw: (st) => [r(20, 20, 150, 56, WHITE, { rx: 28, stroke: EDGE, 'stroke-width': 1.8 }), c(150, 48, 20, '#0b0c0e'), c(150, 48, 9, '#26303d'), r(80, 76, 30, 26, '#e7e9ec', { stroke: EDGE }), r(55, 100, 80, 14, WHITE, { rx: 6, stroke: EDGE }), c(40, 48, 3, st)] },
    'cam-turret': { w: 130, h: 120, draw: (st) => [r(10, 86, 110, 28, WHITE, { rx: 12, stroke: EDGE, 'stroke-width': 1.8 }), c(65, 58, 46, WHITE, { stroke: EDGE, 'stroke-width': 1.8 }), c(65, 58, 22, '#0b0c0e'), c(65, 58, 9, '#26303d'), c(65, 99, 3, st)] },
    'cam-dome': { w: 140, h: 80, draw: (st) => [r(0, 56, 140, 22, WHITE, { rx: 10, stroke: EDGE, 'stroke-width': 1.8 }), S('path', { d: 'M18 58a52 52 0 0 1 104 0z', fill: '#1b1d21', stroke: EDGE, 'stroke-width': 1.5 }), c(70, 38, 10, '#26303d'), c(70, 67, 2.6, st)] },
    'cam-flex': { w: 80, h: 100, draw: (st) => [r(10, 0, 60, 64, WHITE, { rx: 14, stroke: EDGE, 'stroke-width': 1.8 }), c(40, 30, 15, '#0b0c0e'), c(40, 30, 6, '#26303d'), r(32, 64, 16, 22, '#e7e9ec', { stroke: EDGE }), r(14, 86, 52, 12, WHITE, { rx: 5, stroke: EDGE }), c(40, 54, 2.2, st)] },
    doorbell: { w: 50, h: 140, draw: (st) => [r(0, 0, 50, 140, '#1b1d21', { rx: 25, stroke: '#3a3d42', 'stroke-width': 1.8 }), c(25, 32, 12, '#0b0c0e', { stroke: '#3a3d42' }), c(25, 32, 5, '#26303d'), c(25, 108, 11, 'none', { stroke: st, 'stroke-width': 2.5 })] },
    'ups-tower': { w: 150, h: 230, draw: (st) => [r(0, 0, 150, 230, WHITE, { rx: 12, stroke: EDGE, 'stroke-width': 2 }), r(45, 30, 60, 40, '#05070b', { rx: 4 }), ...Array.from({ length: 6 }, (_, i) => r(30, 100 + i * 18, 90, 3, '#e1e4e8')), c(75, 205, 6, 'none', { stroke: st, 'stroke-width': 2.4 })] },
    plug: { w: 70, h: 70, draw: (st) => [r(0, 0, 70, 70, WHITE, { rx: 14, stroke: EDGE, 'stroke-width': 1.8 }), c(35, 35, 20, '#e7e9ec'), c(27, 35, 3.2, '#16181b'), c(43, 35, 3.2, '#16181b'), c(58, 12, 2.4, st)] },
    'cloud-key': { w: 120, h: 34, draw: (st) => [r(0, 0, 120, 34, WHITE, { rx: 6, stroke: EDGE, 'stroke-width': 1.5 }), r(10, 7, 30, 20, '#05070b', { rx: 2.5 }), c(108, 17, 2.4, st)] },
  };

  // The shape of a device that isn't in the rack (for the cards beside it and the catalog)
  function productShape(m, info = {}) {
    const sh = SHAPES[m?.shape];
    if (!sh) return null;
    const pad = 4;
    return S('svg', { class: `product-shape shape-${m.shape}`, viewBox: `${-pad} ${-pad} ${sh.w + pad * 2} ${sh.h + pad * 2}`, role: 'img', 'aria-label': m.name },
      ...sh.draw(statusColor(info)));
  }

  // The UniFi model an item is: the front chosen in Admin, the model the console reports, or its name
  function unifiOf(item, info) {
    const f = item.front?.model;
    if (f && f !== 'auto' && typeof UNIFI_BY_FRONT !== 'undefined') return UNIFI_BY_FRONT.get(f) || null;
    if (typeof unifiModelFor === 'undefined') return null;
    if (info?.ud) return unifiModelFor(info.ud.model, info.ud.name);
    if (/unifi|ubiquiti/i.test(item.model?.brand || '')) return unifiModelFor(null, item.model.name);
    return null;
  }

  function synologyDs(item, info, fr, h) {
    // a DiskStation stands on a shelf: drawn at its real size (199 × 166 mm), shrunk only if it doesn't fit
    const s = Math.min(1, (h - 1) / 166);
    const dw = 199 * s;
    const dh = 166 * s;
    const x0 = (W - dw) / 2;
    const y0 = h - dh - 0.5;
    const disks = info.syno?.disks || [];
    const online = Boolean(info.syno);
    const out = [r(x0, y0, dw, dh, '#1b1c1f', { rx: 6 * s, stroke: '#0a0a0b', 'stroke-width': 0.6 }), r(x0 + 4 * s, y0 + 0.6, dw - 8 * s, 1.2 * s, '#34373c')];
    // left panel: status, LAN and disk LEDs, USB and the power button
    const lx = x0 + 15 * s;
    const ledsY = [18, 28, 38, 52, 62, 72, 82];
    const diskSt = (i) => {
      const d = disks[i];
      if (!d) return null;
      return ['Critical', 'Failing'].includes(d.health) || d.status === 'Crashed' ? RED : d.health === 'Warning' ? AMBER : GREEN;
    };
    out.push(led(lx, y0 + ledsY[0] * s, 1.6 * s, info.status === 'critical' ? AMBER : GREEN, online));
    out.push(led(lx, y0 + ledsY[1] * s, 1.6 * s, GREEN, online), led(lx, y0 + ledsY[2] * s, 1.6 * s, GREEN, false));
    for (let i = 0; i < 4; i++) out.push(led(lx, y0 + ledsY[3 + i] * s, 1.6 * s, diskSt(i) || GREEN, Boolean(diskSt(i))));
    out.push(r(lx - 4.5 * s, y0 + 112 * s, 9 * s, 4 * s, '#0b0c0d', { stroke: '#4a4f56', 'stroke-width': 0.4 }));
    out.push(c(lx, y0 + 140 * s, 5 * s, '#17181b', { stroke: online ? BLUE : '#4a4f56', 'stroke-width': 1.1 }));
    // four trays standing up
    const tx = x0 + 32 * s;
    const tw = (dw - 40 * s - 3 * 3 * s) / 4;
    for (let i = 0; i < 4; i++) {
      const d = disks[i];
      const st = d ? (['Critical', 'Failing'].includes(d.health) || d.status === 'Crashed' ? 'critical' : d.health === 'Warning' ? 'warning' : 'good') : '';
      out.push(g({ class: `drive${d ? ` on ${st}` : ''}`, transform: `translate(${tx + i * (tw + 3 * s)} ${y0 + 8 * s})` },
        tip(d ? `${d.id} · ${d.model || ''} · ${d.temp ?? '–'} °C · ${d.health || d.status || ''}` : `Bay ${i + 1}`),
        r(0, 0, tw, dh - 16 * s, '#141517', { rx: 1.5 * s, stroke: '#0a0a0b', 'stroke-width': 0.5 }),
        r(tw * 0.18, 8 * s, tw * 0.64, dh - 40 * s, '#1d1f22', { rx: 1 * s }),
        r(tw * 0.25, dh - 28 * s, tw * 0.5, 7 * s, '#2c2f34', { rx: 1.5 * s })));
    }
    return out;
  }

  function synologyRs(item, info, fr, h, id) {
    const disks = info.syno?.disks;
    const out = [...ears(h, '#24272b', item.height), r(19.6, 0.4, W - 39.2, h - 0.8, `url(#${id('black')})`, { rx: 1.4 })];
    out.push(statusDot(30, 10, info, item));
    const count = Math.max(disks?.length || 0, item.height >= 2 ? 12 : 4);
    const layout = count > 4 ? '12x3.5' : '4x3.5';
    const gr = bayGrid(layout, item.height, { x: 42, y: 3, w: W - 90, h: h - 6 });
    for (let i = 0; i < gr.count; i++) {
      const [x, y] = bayPos(gr, i);
      const d = disks?.[i];
      const st = d ? (['Critical', 'Failing'].includes(d.health) || d.status === 'Crashed' ? 'critical' : d.health === 'Warning' ? 'warning' : 'good') : '';
      out.push(g({ class: `drive${d ? ` on ${st}` : ' empty'}`, transform: `translate(${x} ${y})` }, tip(d ? `${d.id} · ${d.model || ''} · ${d.health || ''}` : 'Empty bay'),
        r(0, 0, gr.cw, gr.ch, '#1b1d20', { rx: 0.9, stroke: '#0a0b0c', 'stroke-width': 0.5 }),
        r(gr.cw * 0.2, 3, gr.cw * 0.74, gr.ch - 6, `url(#${id('slots')})`),
        d ? led(5, gr.ch / 2, 1, st === 'critical' ? RED : st === 'warning' ? AMBER : GREEN) : null));
    }
    return out;
  }

  function genericServer(item, info, fr, h, id) {
    const on = info.idrac ? info.idrac.powerState === 'On' : Boolean(item.links?.length);
    const out = [...ears(h, '#24272b', item.height), r(19.6, 0.4, W - 39.2, h - 0.8, `url(#${id('black')})`, { rx: 1.6 })];
    out.push(statusDot(30, 9, info, item));
    out.push(g({ class: `dell-power${on ? ' on' : ''}` }, c(W - 30, 9, 3.6, '#17191c', { stroke: on ? GREEN : '#4a4f56', 'stroke-width': 1.2 })));
    out.push(...driveArea({ x: 40, y: 3, w: W - 80, h: h - 6 }, fr.drives, item.height, on, info, 13, id));
    return out;
  }

  // Other brands' servers: the same drive cage with each brand's own ears and colour
  function brandServer(item, info, fr, h, id, brand) {
    const on = info.idrac ? info.idrac.powerState === 'On' : Boolean(item.links?.length);
    const look = {
      hpe: { ear: '#3a3f46', body: `url(#${id('black')})`, mark: '#01a982' }, // HPE green
      lenovo: { ear: '#1c1d20', body: `url(#${id('black')})`, mark: '#e2231a' }, // Lenovo red
      supermicro: { ear: '#2a2d32', body: `url(#${id('black')})`, mark: '#2d6fd4' },
    }[brand];
    const out = [...ears(h, look.ear, item.height), r(19.6, 0.4, W - 39.2, h - 0.8, look.body, { rx: 1.6 })];
    out.push(r(4, h / 2 - (h > U ? 14 : 8), 11.6, h > U ? 28 : 16, look.mark, { rx: 1.4, opacity: 0.9 }));
    out.push(statusDot(30, 9, info, item));
    out.push(g({ class: `dell-power${on ? ' on' : ''}` }, c(W - 30, 9, 3.6, '#17191c', { stroke: on ? GREEN : '#4a4f56', 'stroke-width': 1.2 })));
    out.push(...driveArea({ x: 40, y: 3, w: W - 80, h: h - 6 }, fr.drives, item.height, on, info, 14, id));
    return out;
  }

  function plainFront(item, info, fr, h, id) {
    const out = [...ears(h, '#24272b', item.height), r(19.6, 0.4, W - 39.2, h - 0.8, `url(#${id('black')})`, { rx: 1.6 })];
    if (item.kind === 'pdu') {
      for (let i = 0; i < 8; i++) out.push(r(80 + i * 42, h / 2 - 8, 26, 16, '#0c0d0f', { rx: 3, stroke: '#45494f', 'stroke-width': 0.6 }), r(86 + i * 42, h / 2 - 3, 4, 6, '#2a2d31'), r(96 + i * 42, h / 2 - 3, 4, 6, '#2a2d31'));
    } else if (item.kind === 'ups') {
      out.push(r(40, 8, 44, 18, '#0f1d14', { rx: 1.5, stroke: '#3a3e44', 'stroke-width': 0.6 }));
      for (let i = 0; i < 3; i++) out.push(c(100 + i * 12, 17, 3, '#3a3e44'));
      out.push(r(150, 6, W - 190, h - 12, `url(#${id('holes')})`, { rx: 1 }));
    } else out.push(r(60, 6, W - 120, h - 12, `url(#${id('holes')})`, { rx: 1, opacity: 0.9 }));
    out.push(statusDot(36, h / 2, info, item));
    return out;
  }

  const FACES = {
    dell13: (item, info, fr, h, id) => dell(item, info, fr, h, id, 13),
    dell14: (item, info, fr, h, id) => dell(item, info, fr, h, id, 14),
    hpe: (item, info, fr, h, id) => brandServer(item, info, fr, h, id, 'hpe'),
    lenovo: (item, info, fr, h, id) => brandServer(item, info, fr, h, id, 'lenovo'),
    supermicro: (item, info, fr, h, id) => brandServer(item, info, fr, h, id, 'supermicro'),
    'udm-pro': udmPro,
    'usw-24-poe': (item, info, fr, h, id) => unifiSwitch(item, info, fr, h, id, 24, 2),
    'unifi-switch': (item, info, fr, h, id) => unifiSwitch(item, info, fr, h, id, item.kind === 'gateway' ? 8 : 24, item.kind === 'gateway' ? 1 : 2),
    'synology-rs': synologyRs,
    'synology-ds': synologyDs,
    server: genericServer,
    switch: (item, info, fr, h, id) => unifiSwitch(item, info, fr, h, id, item.kind === 'gateway' ? 8 : 24, item.kind === 'gateway' ? 0 : 2, true),
    plain: plainFront,
  };

  // --- Passive items: blanks, patch panels, shelves… (no name, not monitored) ---

  function passiveFace(p, h, id) {
    const panel = (fill = `url(#${id('black')})`) => [r(0, 0.5, W, h - 1, fill, { rx: 1.4, stroke: '#08090a', 'stroke-width': 0.5 }), r(2, 0.5, W - 4, 0.8, '#30343a')];
    const screws = () => {
      const out = [];
      for (let i = 0; i < p.height; i++) for (const x of [9.6, W - 9.6]) out.push(c(x, i * U + U / 2, 2.6, '#33363b'), c(x, i * U + U / 2, 1.5, '#121315'));
      return out;
    };
    switch (p.kind) {
      case 'vented':
        return [...panel(), r(26, 5, W - 52, h - 10, `url(#${id('holes')})`), ...screws()];
      case 'brush':
        return [...panel(), r(30, h / 2 - 7, W - 60, 14, '#060607', { rx: 3 }), r(31, h / 2 - 6, W - 62, 12, `url(#${id('bristle')})`), ...screws()];
      case 'cable': {
        const out = [...panel('#1b1d21'), ...screws()];
        // D-rings: loops open at the bottom where the cables go in
        const rw = 40;
        const y1 = 4;
        const y2 = h - 4;
        for (let i = 0; i < 5; i++) {
          const x = 45 + i * ((W - 90 - rw) / 4);
          out.push(S('path', { d: `M${x + rw / 2 - 7} ${y2}H${x + 6}a6 6 0 0 1-6-6V${y1 + 6}a6 6 0 0 1 6-6H${x + rw - 6}a6 6 0 0 1 6 6V${y2 - 6}a6 6 0 0 1-6 6H${x + rw / 2 + 7}`, fill: 'none', stroke: '#4a4f56', 'stroke-width': 2.6, 'stroke-linecap': 'round' }));
        }
        return out;
      }
      case 'patch': {
        const out = [...panel(), ...screws()];
        const rows = p.ports > 24 ? 2 : 1;
        const perRow = p.ports / rows;
        const groups = perRow / 6;
        const gw = 6 * 11.4 + 5 * 1.5;
        const total = groups * gw + (groups - 1) * 8;
        const x0 = (W - total) / 2;
        const rowH = rows === 2 ? 17 : 22;
        const y0 = (h - rows * rowH) / 2;
        for (let rI = 0; rI < rows; rI++) {
          for (let gI = 0; gI < groups; gI++) {
            const gx = x0 + gI * (gw + 8);
            const gy = y0 + rI * rowH;
            out.push(r(gx, gy, gw, 3.4, '#e8e6dc', { rx: 0.6, opacity: 0.85 }));
            for (let j = 0; j < 6; j++) out.push(g({ class: 'jack' }, r(gx + j * 12.9, gy + 5.2, 11.4, rows === 2 ? 10 : 11.5, '#050607', { rx: 0.6, stroke: '#3a3e45', 'stroke-width': 0.5 })));
          }
        }
        return out;
      }
      case 'shelf':
        // a 1U shelf shows its front lip; whatever stands on it starts in the unit above
        return [r(0.4, 0.6, 18, h - 1.2, '#2a2d32', { rx: 1.4 }), r(W - 18.4, 0.6, 18, h - 1.2, '#2a2d32', { rx: 1.4 }),
          r(14, h * 0.3, W - 28, h * 0.7 - 0.6, '#30343a', { rx: 1.2 }), r(14, h * 0.3, W - 28, 1.6, '#5a6068'), r(40, h * 0.45, W - 80, h * 0.35, `url(#${id('slots')})`, { opacity: 0.7 }), ...screws()];
      default: // blank
        return [...panel(), r(26, h / 2 - 0.4, W - 52, 0.8, '#0d0e10'), ...screws()];
    }
  }

  // --- The rack ---

  const MODE_KEY = 'hd.rackMode';
  function getMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'schematic' ? 'schematic' : 'realistic';
    } catch {
      return 'realistic';
    }
  }

  // "Realistic | Schematic", remembered per browser
  function modeToggle(onChange) {
    const mode = getMode();
    const box = el('div', { class: 'range-tabs rack-mode', role: 'group', 'aria-label': 'Rack view' });
    for (const [k, label, ic] of [['realistic', 'Realistic', 'server'], ['schematic', 'Schematic', 'rows-3']]) {
      box.append(el('button', {
        type: 'button',
        'aria-pressed': String(k === mode),
        title: `${label} view`,
        onclick: () => {
          try {
            localStorage.setItem(MODE_KEY, k);
          } catch {
            /* only a convenience */
          }
          for (const b of box.children) b.setAttribute('aria-pressed', String(b === box.children[k === 'realistic' ? 0 : 1]));
          onChange(k);
        },
      }, HD.icon(ic), el('span', { text: label })));
    }
    return box;
  }

  const pct = (v) => `${(v * 100).toFixed(4)}%`;

  function activate(node, fn) {
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), fn()));
  }

  function realisticItem(item, info, id, opts) {
    const fr = frontOf(item, info);
    const h = item.height * U;
    const um = fr.model.startsWith('u-') && typeof UNIFI_BY_FRONT !== 'undefined' ? UNIFI_BY_FRONT.get(fr.model) : null;
    const draw = um ? (...a) => unifiFace(...a, um) : FACES[fr.model] || FACES.plain;
    const face = S('svg', { class: 'face', viewBox: `0 0 ${W} ${h}`, preserveAspectRatio: um && um.form !== 'rack' ? 'xMidYMax meet' : 'none', 'aria-hidden': 'true' }, draw(item, info, fr, h, id));
    const node = el('div', {
      class: `rack-item front-${fr.model} kind-${item.kind} h${item.height}${info.status ? ` st-${info.status}` : ''}`,
      role: 'button',
      tabindex: '0',
      'data-id': item.id,
      'aria-label': `${item.name}, ${item.height} U${info.status ? `, status ${info.status}` : ''}`,
      title: [item.name, info.sub, wattsText(info, item)].filter(Boolean).join(' · '),
    }, face);
    activate(node, () => opts.onSelect && opts.onSelect(item, info));
    return node;
  }

  function schematicItem(item, info, opts) {
    const w = wattsText(info, item);
    const ud = info.ud;
    const metric = w || (ud?.online && ud.clients != null ? `${ud.clients} clients` : '');
    const state = info.status ? { good: 'OK', warning: 'Warning', critical: 'Problem' }[info.status] : item.links?.length ? 'Unknown' : 'Not monitored';
    const node = el('div', {
      class: `rack-item sch kind-${item.kind} h${item.height}${info.status ? ` st-${info.status}` : ''}`,
      role: 'button',
      tabindex: '0',
      'data-id': item.id,
      'aria-label': `${item.name}, ${item.height} U, ${state}`,
      title: [item.name, info.sub, w].filter(Boolean).join(' · '),
    },
    el('span', { class: 'sch-icon' }, HD.icon(KIND_ICONS[item.kind] || 'box')),
    el('span', { class: 'sch-text' }, el('strong', { text: item.name }), item.height > 1 && info.sub ? el('small', { text: info.sub }) : null),
    metric ? el('span', { class: 'sch-metric num', text: metric }) : null,
    el('span', { class: `sch-dot ${info.status || ''}`, title: state }));
    activate(node, () => opts.onSelect && opts.onSelect(item, info));
    return node;
  }

  function passiveItem(p, id, mode, opts) {
    const label = PASSIVE_LABELS[p.kind];
    const h = p.height * U;
    const node = el('div', {
      class: `rack-item passive p-${p.kind} h${p.height}${mode === 'schematic' ? ' sch' : ''}`,
      'data-id': p.id,
      'data-label': `${label}${p.kind === 'patch' ? ` · ${p.ports}` : ''}`,
      title: `${label}${p.kind === 'patch' ? `, ${p.ports} ports` : ''} · ${p.height} U`,
      ...(opts.editable ? { role: 'button', tabindex: '0', 'aria-label': `${label}, ${p.height} U at U${p.u}` } : { 'aria-hidden': 'true' }),
    }, mode === 'schematic' ? null : S('svg', { class: 'face', viewBox: `0 0 ${W} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, passiveFace(p, h, id)));
    if (opts.editable && opts.onSelectPassive) activate(node, () => opts.onSelectPassive(p));
    return node;
  }

  // Names beside the rack, level with their device
  function labelNode(item, info, centerPct, opts) {
    const w = wattsText(info, item);
    const node = el('button', { type: 'button', class: `rack-label h${item.height}${opts.selectedId === item.id ? ' selected' : ''}`, tabindex: '-1', 'data-id': item.id, title: [item.name, info.sub, w].filter(Boolean).join(' · ') },
      el('span', { class: `dot ${info.status || ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'rl-text' }, el('strong', { text: item.name }), item.height > 1 ? el('small', { text: [info.sub, w].filter(Boolean).join(' · ') }) : null));
    node.style.top = pct(centerPct);
    node.addEventListener('click', () => opts.onSelect && opts.onSelect(item, info));
    return node;
  }

  function offRackCard(item, data, opts) {
    const info = itemInfo(item, data);
    const ud = info.ud;
    const detail = ud
      ? [ud.online ? 'Online' : 'Offline', ud.clients != null ? `${ud.clients} clients` : '', info.poeW == null && item.estimateW ? `~${item.estimateW} W` : ''].filter(Boolean).join(' · ')
      : wattsText(info, item);
    const shape = productShape(unifiOf(item, info), info);
    const node = el('div', { class: `offrack-item${info.status ? ` st-${info.status}` : ''}${opts.selectedId === item.id ? ' selected' : ''}`, role: 'button', tabindex: '0', 'data-id': item.id },
      shape ? el('span', { class: 'offrack-shape', 'aria-hidden': 'true' }, shape) : el('span', { class: `dc-icon kind-${item.kind}`, 'aria-hidden': 'true' }, HD.icon(KIND_ICONS[item.kind] || 'box')),
      el('div', null, el('strong', { text: item.name }), el('div', { class: 'small muted', text: detail || KIND_LABELS[item.kind] })),
      el('span', { class: `led ${info.status || ''}`, title: info.status || 'Not monitored' }));
    activate(node, () => opts.onSelect && opts.onSelect(item, info));
    return node;
  }

  // opts: { mode, onSelect(item, info), editable, selectedId, onMove(item, u), onEmpty(u), onSelectPassive(p), onMovePassive(p, u) }
  function render(container, rack, data, opts = {}) {
    const mode = opts.mode || getMode();
    const units = rack.units;
    const top = rack.numbering === 'top';
    const H = units * U;
    const VBW = W + FRAME.left + FRAME.right;
    const VBH = H + FRAME.top + FRAME.bottom;
    const rowOf = (n) => (top ? n - 1 : units - n); // row from the top for unit n
    const firstRow = (it) => Math.min(rowOf(it.u), rowOf(it.u + it.height - 1));
    const n = ++seq;
    const id = (name) => `rk${n}-${name}`;
    const figure = el('div', { class: 'rack-figure' });
    figure.style.aspectRatio = `${VBW} / ${VBH}`;
    const bay = el('div', { class: 'rack-bay' });
    Object.assign(bay.style, { left: pct(FRAME.left / VBW), width: pct(W / VBW), top: pct(FRAME.top / VBH), height: pct(H / VBH) });
    figure.append(frameSvg(units, top, H, id), bay);
    const labels = el('div', { class: 'rack-labels' });
    const placeItem = (node, it) => {
      node.style.top = pct(firstRow(it) / units);
      node.style.height = pct(it.height / units);
      if (opts.selectedId === it.id) node.classList.add('selected');
    };
    for (const it of rack.items.filter(inRack)) {
      const info = itemInfo(it, data);
      const node = mode === 'schematic' ? schematicItem(it, info, opts) : realisticItem(it, info, id, opts);
      placeItem(node, it);
      if (opts.editable) enableDrag(node, it, rack, bay, rowOf, opts.onMove);
      bay.append(node);
      if (mode !== 'schematic') labels.append(labelNode(it, info, (FRAME.top + (firstRow(it) + it.height / 2) * U) / VBH, opts));
    }
    for (const p of rack.passive || []) {
      const node = passiveItem(p, id, mode, opts);
      placeItem(node, p);
      if (opts.editable && opts.onMovePassive) enableDrag(node, p, rack, bay, rowOf, opts.onMovePassive);
      bay.append(node);
    }
    if (opts.editable && opts.onEmpty) {
      bay.addEventListener('dblclick', (e) => {
        if (e.target !== bay) return;
        const b = bay.getBoundingClientRect();
        const row = Math.min(units - 1, Math.max(0, Math.floor(((e.clientY - b.top) / b.height) * units)));
        opts.onEmpty(top ? row + 1 : units - row);
      });
    }
    const off = rack.items.filter(outside);
    container.replaceChildren(...[
      el('div', { class: `rack2 ${mode}` }, figure, mode === 'schematic' ? null : labels),
      off.length ? el('div', { class: 'offrack' }, el('div', { class: 'card-type', text: 'Outside the rack' }), off.map((it) => offRackCard(it, data, opts))) : null,
    ].filter(Boolean)); // replaceChildren would turn null into the text "null"
  }

  // Admin: drag an item up/down; it snaps to units and only lands on free space.
  function enableDrag(node, item, rack, bay, rowOf, onMoved) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const startY = e.clientY;
      const uPx = bay.getBoundingClientRect().height / rack.units;
      const startTop = node.offsetTop;
      const restore = node.style.top;
      let target = item.u;
      let moved = false;
      node.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        if (Math.abs(dy) > 3) moved = true;
        if (!moved) return;
        node.classList.add('dragging');
        const rows = Math.round(dy / uPx);
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
        else node.style.top = restore;
        if (moved) node.addEventListener('click', (ce) => ce.stopImmediatePropagation(), { once: true, capture: true });
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    });
  }

  return { render, modeToggle, resolve, itemInfo, linkStatus, inRack, frontOf, productShape, unifiOf, SHAPES, KIND_LABELS, KIND_ICONS, FRONT_LABELS, DRIVE_LABELS, PASSIVE_LABELS, WITH_DRIVES };
})();
