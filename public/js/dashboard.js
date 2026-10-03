'use strict';

const { el, svg, fmt, status, statusClass } = HD;
const $ = (id) => document.getElementById(id);

let lastData = null;
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Fans: real fan icons whose rotation speed is proportional to RPM.
// Nodes are kept across refreshes so the spin continues smoothly; the speed is
// adjusted with Web Animations playbackRate instead of restarting the animation.

const RPM_PER_VISUAL_RPS = 6000; // 6000 rpm => 1 visual rotation per second
const fanNodes = new Map();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const BLADE = 'M32 25C27 19 28 10 36 6c7 3 7 13 0 21z';

function fanNode(key, fan) {
  let n = fanNodes.get(key);
  if (!n) {
    const rotor = svg('g', { class: 'rotor' }, [0, 72, 144, 216, 288].map((a) => svg('path', { d: BLADE, transform: `rotate(${a} 32 32)` })));
    const icon = svg(
      'svg',
      { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      svg('circle', { class: 'frame-inner', cx: 32, cy: 32, r: 29 }),
      rotor,
      svg('circle', { class: 'frame', cx: 32, cy: 32, r: 29 }),
      svg('circle', { class: 'hub', cx: 32, cy: 32, r: 7 })
    );
    n = { rotor, rpm: el('div', { class: 'rpm' }), name: el('div', { class: 'name' }), state: el('div'), anim: null };
    n.root = el('div', { class: 'fan' }, icon, n.rpm, n.name, n.state);
    fanNodes.set(key, n);
  }
  n.seen = true;
  const bad = fan.health && statusClass(fan.health) !== 'good';
  n.root.className = bad ? 'fan bad' : 'fan';
  n.root.title = `${fan.name}: ${fan.rpm != null ? fmt.n(fan.rpm) + ' rpm' : fan.percent != null ? fmt.n(fan.percent) + ' %' : 'no reading'}`;
  n.rpm.textContent = fan.rpm != null ? `${fmt.n(fan.rpm)} rpm` : fan.percent != null ? `${fmt.n(fan.percent)} %` : '–';
  n.name.textContent = fan.name;
  n.state.replaceChildren(bad ? status(fan.health) : '');

  const rpm = fan.rpm != null ? fan.rpm : fan.percent != null ? fan.percent * 150 : 0;
  const rps = Math.max(0, rpm) / RPM_PER_VISUAL_RPS;
  if (reduceMotion.matches || rps === 0) {
    if (n.anim) n.anim.pause();
  } else {
    if (!n.anim) {
      n.anim = n.rotor.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
      n.anim.playbackRate = rps;
    } else {
      n.anim.updatePlaybackRate(rps);
      n.anim.play();
    }
  }
  return n.root;
}

function pruneFans() {
  for (const [k, n] of fanNodes) {
    if (!n.seen) {
      if (n.anim) n.anim.cancel();
      fanNodes.delete(k);
    } else n.seen = false;
  }
}

// ---------------------------------------------------------------------------
// Common card pieces

function meter(fraction, cls = '') {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const bar = el('div');
  bar.style.width = `${(f * 100).toFixed(1)}%`;
  return el('div', { class: `meter ${cls}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(f * 100) }, bar);
}

function usageClass(f) {
  return f >= 0.9 ? 'critical' : f >= 0.8 ? 'warning' : '';
}

// One monitoring connection, shown as a section of its device's card.
function hostCard(type, h, sub, statusNode, bodyFn) {
  return { type, h, sub, statusNode, bodyFn };
}

// A connection's full view, shown under Details. The card itself carries the one status.
function sectionNode(sec) {
  const h = sec.h;
  const node = el('section', { class: 'device-section' }, el('h4', { class: 'section-title', text: sec.title || sec.type }));
  if (h.error) node.append(el('p', { class: 'banner', role: 'alert' }, h.error, h.data ? ` · showing data from ${fmt.ago(h.lastOkAt)}` : ''));
  if (h.ok === null && !h.data) node.append(el('p', { class: 'empty', text: 'Waiting for first update…' }));
  if (h.data) node.append(el('div', { class: `body${h.error ? ' stale' : ''}` }, sec.bodyFn(h.data)));
  return node;
}

// ---------------------------------------------------------------------------
// Device cards: one status, a few key numbers and what is wrong. Details opens the full
// sections; facts that never change (service tag, firmware, cores…) live on the Docs sheet.

let attention = []; // what needs attention, from the server (worst first)
const deviceStates = new Map(); // device id -> state label, for the summary counts
const expanded = new Set(); // device ids (and 'power') with details open, remembered per browser
try {
  for (const id of JSON.parse(localStorage.getItem('hd.expanded') || '[]')) expanded.add(id);
} catch {
  /* only a convenience */
}
function storeExpanded() {
  try {
    localStorage.setItem('hd.expanded', JSON.stringify([...expanded]));
  } catch {
    /* only a convenience */
  }
}

// Everything the card needs about a device, from its connections
function deviceContext(dev, d) {
  const conn = (type) => dev.connections.find((c) => c.type === type);
  const host = (type) => conn(type) && (d[type] || []).find((h) => h.id === conn(type).id);
  const idracH = host('idrac');
  const pveH = host('proxmox');
  const pveNode = conn('proxmox')?.node;
  const nodes = pveH?.data?.nodes || [];
  const node = pveNode ? nodes.find((n) => n.name === pveNode) : nodes.length === 1 ? nodes[0] : null;
  const tnH = host('truenas');
  const synoH = host('synology');
  const uniH = host('unifi');
  const linkHost = dev.unifi && (d.unifi || []).find((h) => h.id === dev.unifi.hostId);
  const ud = linkHost?.data?.devices?.find((x) => x.mac === dev.unifi.mac) || null;
  return {
    idracH, idrac: idracH?.data, pveH, node, guests: pveH?.data?.guests?.filter((g) => !node || g.node === node.name) || [],
    tnH, tn: tnH?.data, synoH, syno: synoH?.data, uniH, health: uniH?.data?.health, linkHost, ud,
    hosts: [idracH, pveH, tnH, synoH, uniH].filter(Boolean),
  };
}

function deviceState(dev, ctx, issues) {
  if (!ctx.hosts.length && !dev.unifi) return ['Not monitored', ''];
  // Offline when every part we can see is down: connections, the Proxmox node, the UniFi device
  const parts = [
    ...ctx.hosts.filter((h) => h !== ctx.pveH || !ctx.node).map((h) => (h.ok === null ? null : h.ok)),
    ...(ctx.node ? [ctx.node.status === 'online'] : []),
    ...(dev.unifi && ctx.linkHost?.data ? [Boolean(ctx.ud?.online)] : []),
  ].filter((x) => x !== null);
  if (parts.length && parts.every((x) => !x)) return ['Offline', 'critical'];
  if (issues.some((a) => a.severity === 'critical')) return ['Problem', 'critical'];
  if (issues.some((a) => a.severity === 'warning')) return ['Warning', 'warning'];
  if (!parts.length) return ['Waiting', ''];
  return ['OK', 'good'];
}

// Up to four numbers that answer "how is it doing?"
function keyMetrics(dev, ctx) {
  const out = [];
  const add = (v, l) => {
    if (v !== null && v !== undefined && v !== '' && out.length < 4) out.push([v, l]);
  };
  const pct = (a, b) => (b ? fmt.pct(a / b) : null);
  const hl = ctx.health;
  if (hl) {
    add(hl.wan ? (hl.wan.status === 'ok' ? 'Up' : 'Down') : null, 'Internet');
    add(hl.internet?.latencyMs != null ? `${hl.internet.latencyMs} ms` : null, 'Latency');
    add(hl.internet?.downMbps != null ? `${fmt.n(hl.internet.downMbps)}/${fmt.n(hl.internet.upMbps)}` : null, 'Mbps ↓/↑');
    add(hl.clients != null ? String(hl.clients) : null, 'Clients');
  }
  if (ctx.idrac) {
    const t = ctx.idrac.temps;
    const inlet = t.find((x) => /inlet/i.test(x.name));
    add(ctx.idrac.watts != null ? `${fmt.n(ctx.idrac.watts)} W` : null, 'Power');
    if (inlet) add(`${fmt.n(inlet.celsius)} °C`, 'Inlet');
    else if (t.length) add(`${fmt.n(Math.max(...t.map((x) => x.celsius)))} °C`, 'Hottest');
  }
  if (ctx.node?.status === 'online') {
    add(fmt.pct(ctx.node.cpu), 'CPU');
    add(pct(ctx.node.mem, ctx.node.maxmem), 'Memory');
    if (!ctx.idrac) add(`${ctx.guests.filter((g) => g.status === 'running').length} of ${ctx.guests.length}`, 'VMs running');
  }
  if (ctx.tn) {
    for (const p of ctx.tn.pools.slice(0, 3)) add(pct(p.allocated, p.size), p.name);
    add(String(ctx.tn.alerts.length), 'Alerts');
  }
  if (ctx.syno) {
    const s = ctx.syno.system;
    add(s.temp != null ? `${s.temp} °C` : null, 'Temperature');
    const v = ctx.syno.volumes[0];
    add(v ? pct(v.used, v.size) : null, v ? v.name.replace('/', '') : 'Volume');
    add(pct(s.memUsed, s.memTotal), 'Memory');
    add(String(ctx.syno.disks.length), 'Disks');
  }
  const ud = ctx.ud;
  if (ud?.online && !hl) {
    if (ud.ports.length) add(`${ud.ports.filter((p) => p.up).length} of ${ud.ports.length}`, 'Ports up');
    if (ud.poe) add(`${fmt.n(ud.poe.usedW)}${ud.poe.budgetW ? `/${fmt.n(ud.poe.budgetW)}` : ''} W`, 'PoE');
    add(ud.clients != null ? String(ud.clients) : null, 'Clients');
    const temps = ud.temps.map((x) => x.value);
    add(temps.length ? `${fmt.n(Math.max(...temps))} °C` : null, 'Temperature');
    add(ud.cpu != null ? fmt.pct(ud.cpu) : null, 'CPU');
  }
  if (!out.length && dev.estimateW) add(`~${fmt.n(dev.estimateW)} W`, 'Estimated');
  return out;
}

// The one history graph on the card
function mainSpark(ctx) {
  if (ctx.idrac) return [`idrac:${ctx.idracH.id}:watts`, 'Power', ' W'];
  if (ctx.node) return [`pve:${ctx.pveH.id}:${ctx.node.name}:cpu`, 'CPU', ' %'];
  if (ctx.syno) return [`syno:${ctx.synoH.id}:temp`, 'Temperature', ' °C'];
  if (ctx.tn) return [`nas:${ctx.tnH.id}:load`, 'Load (1 min)', '', 2];
  if (ctx.ud && !ctx.health) {
    const k = `unifi:${ctx.linkHost.id}:${ctx.ud.mac}`;
    return ctx.ud.poe ? [`${k}:poe`, 'PoE draw', ' W', 1] : [`${k}:clients`, 'Clients', ''];
  }
  return null;
}

function issueLine(a) {
  return el('li', { class: a.severity, title: a.detail ? `${a.text} · ${a.detail}` : a.text },
    el('span', { class: `led ${a.severity}`, 'aria-hidden': 'true' }),
    el('span', { class: 'txt', text: a.text }),
    a.type === 'offline' && a.detail ? el('span', { class: 'why', text: a.detail }) : null);
}

function deviceCard(dev, sections, d) {
  const ctx = deviceContext(dev, d);
  const issues = attention.filter((a) => a.deviceId === dev.id);
  const [stateText, stateCls] = deviceState(dev, ctx, issues);
  deviceStates.set(dev.id, stateText);
  const model = ctx.idrac?.model || ctx.syno?.system?.model || ctx.ud?.model || (ctx.tn ? ctx.tn.system.version || 'TrueNAS' : '') || (ctx.node ? `Proxmox node ${ctx.node.name}` : '');
  const metrics = keyMetrics(dev, ctx);
  const spark = mainSpark(ctx);
  const open = expanded.has(dev.id);
  const widget = `device:${dev.id}`;
  const details = el('div', { class: 'card-details', id: `details-${dev.id}`, hidden: !open }, sections.map((x) => sectionNode(x)));
  const toggle = el('button', { type: 'button', class: 'link-button details-toggle', 'aria-expanded': String(open), 'aria-controls': `details-${dev.id}`, text: open ? 'Hide details' : 'Details' });
  toggle.addEventListener('click', () => {
    const now = details.hidden;
    details.hidden = !now;
    toggle.setAttribute('aria-expanded', String(now));
    toggle.textContent = now ? 'Hide details' : 'Details';
    if (now) expanded.add(dev.id);
    else expanded.delete(dev.id);
    storeExpanded();
    if (now) {
      board.grow(widget);
      HD.fillSparks().then(() => board.grow(widget));
    } else board.shrink(widget);
  });
  const fans = ctx.idrac?.fans || [];
  const badFans = fans.filter((f) => (f.health && statusClass(f.health) !== 'good') || f.rpm === 0).length;
  const update = ctx.ud?.upgradable || ctx.syno?.system?.upgradeAvailable;
  return el('article', { class: `card device-card${stateCls ? ` st-${stateCls}` : ''}` },
    el('div', { class: 'card-head' },
      el('div', { class: 'title' },
        el('div', { class: 'card-type', text: Rack.KIND_LABELS[dev.kind] || dev.kind }),
        el('h3', { text: dev.name }),
        model ? el('div', { class: 'sub', text: model }) : null),
      status(stateText, stateCls)),
    metrics.length ? el('div', { class: 'dc-metrics' }, metrics.map(([v, l]) => el('div', null, el('span', { class: 'v num', text: v }), el('span', { class: 'l', text: l })))) : null,
    spark ? sparks([spark]) : null,
    issues.length ? el('ul', { class: 'dc-issues' }, issues.map(issueLine)) : null,
    el('div', { class: 'dc-foot' },
      el('div', { class: 'dc-foot-left' },
        fans.length ? el('span', { class: 'fans mini', role: 'img', 'aria-label': `${fans.length} fans${badFans ? `, ${badFans} not OK` : ', all OK'}` }, fans.map((f, i) => fanNode(`mini|${dev.id}|${i}`, f))) : null,
        update ? el('span', { class: 'small muted', text: 'Update available' }) : null),
      el('div', { class: 'dc-links' },
        d.loggedIn ? el('a', { href: `/docs#server/${dev.id}`, text: 'Sheet' }) : null,
        sections.length ? toggle : null)),
    details);
}

// Values a device doesn't report are left out instead of shown as "–"
function kv(pairs) {
  return el('div', { class: 'kv' }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '–').map(([k, v]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }))));
}

// History graphs: [key, label, unit, decimals] (null entries are skipped)
function sparks(list) {
  const cells = list.filter(Boolean).map(([key, label, unit, decimals = 0]) => HD.sparkSlot(key, { label, unit, decimals }));
  return cells.length ? el('div', { class: 'sparks', hidden: true }, cells) : null;
}

// ---------------------------------------------------------------------------
// iDRAC

function renderIdrac(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? [d.model, d.serviceTag && `Service tag ${d.serviceTag}`].filter(Boolean).join(' · ') : '';
    const st = d ? status(d.health || 'unknown') : status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const card = hostCard('iDRAC', h, sub, st, (d) => {
      const parts = [sparks([
        [`idrac:${h.id}:watts`, 'Power draw', ' W'],
        d.temps.some((t) => /inlet/i.test(t.name)) ? [`idrac:${h.id}:inlet`, 'Inlet temperature', ' °C'] : null,
        d.temps.length ? [`idrac:${h.id}:tmax`, 'Hottest sensor', ' °C'] : null,
      ])];
      if (d.psus.length) {
        parts.push(el('h4', { text: 'Power supplies' }));
        parts.push(el('div', { class: 'psus' }, d.psus.map((p) => el('div', { class: 'psu' },
          el('div', { class: 'name', text: p.name }),
          status(p.state === 'Absent' ? 'Absent' : p.health || p.state || 'unknown'),
          el('div', { class: 'muted small num', text: [
            p.inputWatts != null ? `${fmt.n(p.inputWatts)} W in` : null,
            p.capacityWatts != null ? `${fmt.n(p.capacityWatts)} W max` : null,
            p.voltage != null ? `${fmt.n(p.voltage)} V` : null,
          ].filter(Boolean).join(' · ') || ' ' })
        ))));
      }
      if (d.temps.length) {
        parts.push(el('h4', { text: 'Temperatures' }));
        parts.push(el('div', null, d.temps.map((t) => {
          const scale = t.crit || t.warn * 1.15 || 100;
          const cls = t.crit && t.celsius >= t.crit ? 'critical' : t.warn && t.celsius >= t.warn ? 'warning' : '';
          return el('div', { class: 'meter-row', title: [t.warn && `Warning at ${t.warn} °C`, t.crit && `Critical at ${t.crit} °C`].filter(Boolean).join(', ') || null },
            el('span', { class: 'label', text: t.name }),
            meter(t.celsius / scale, cls),
            el('span', { class: 'value', text: `${fmt.n(t.celsius)} °C${cls ? ' ⚠' : ''}` }));
        })));
      }
      if (d.fans.length) {
        parts.push(el('h4', { text: 'Fans' }));
        parts.push(el('div', { class: 'fans' }, d.fans.map((f, i) => fanNode(`${h.id}|${f.name}|${i}`, f))));
      }
      return parts;
    });
    return [h.id, { ...card, title: 'Hardware · iDRAC' }];
  });
}

// ---------------------------------------------------------------------------
// Proxmox

function renderProxmox(hosts, nodeFor = () => null) {
  return hosts.map((h0) => {
    const node = nodeFor(h0.id);
    const h = h0.data && node
      ? { ...h0, data: { ...h0.data, nodes: h0.data.nodes.filter((n) => n.name === node), guests: h0.data.guests.filter((g) => g.node === node) } }
      : h0;
    const d = h.data;
    const running = d ? d.guests.filter((g) => g.status === 'running').length : 0;
    const sub = d ? `${d.nodes.length} node${d.nodes.length === 1 ? '' : 's'} · ${d.guests.length} guests (${running} running)` : '';
    const st = d ? status(d.nodes.every((n) => n.status === 'online') ? 'online' : 'degraded') : status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const card = hostCard('Proxmox', h, sub, st, (d) => {
      const nodeRows = d.nodes.map((n) => {
        const memF = n.maxmem ? n.mem / n.maxmem : 0;
        const diskF = n.maxdisk ? n.disk / n.maxdisk : 0;
        return el('tr', null,
          el('td', { text: n.name }),
          el('td', null, status(n.status)),
          el('td', null, meter(n.cpu, usageClass(n.cpu || 0)), el('span', { class: 'small muted num', text: `${fmt.pct(n.cpu)} of ${n.maxcpu ?? '?'} CPU` })),
          el('td', null, meter(memF, usageClass(memF)), el('span', { class: 'small muted num', text: `${fmt.bytes(n.mem)} / ${fmt.bytes(n.maxmem)}` })),
          el('td', null, meter(diskF, usageClass(diskF)), el('span', { class: 'small muted num', text: `${fmt.bytes(n.disk)} / ${fmt.bytes(n.maxdisk)}` })),
          el('td', { class: 'r', text: n.status === 'online' ? fmt.uptime(n.uptime) : '–' }));
      });
      const up = d.guests.filter((g) => g.status === 'running').length;
      return [
        el('h4', { text: 'Nodes' }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Node', 'Status', 'CPU', 'Memory', 'Root disk'].map((t) => el('th', { text: t })), el('th', { class: 'r', text: 'Uptime' }))),
          el('tbody', null, nodeRows))),
        d.nodes.filter((n) => n.status === 'online').map((n) => sparks([
          [`pve:${h0.id}:${n.name}:cpu`, d.nodes.length > 1 ? `${n.name} CPU` : 'CPU', ' %'],
          [`pve:${h0.id}:${n.name}:mem`, d.nodes.length > 1 ? `${n.name} memory` : 'Memory', ' %'],
        ])),
        el('p', { class: 'small muted' }, `${d.guests.length} VMs & containers, ${up} running · `, el('a', { href: '/services#vms', text: 'see Services' })),
      ];
    });
    return [h.id, { ...card, title: `Proxmox · ${node ? `node ${node}` : h.name}` }];
  });
}

// ---------------------------------------------------------------------------
// TrueNAS

function renderTruenas(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? [d.system.hostname, d.system.version].filter(Boolean).join(' · ') : '';
    let st;
    if (d) {
      const bad = d.pools.some((p) => !p.healthy) || d.alerts.some((a) => ['CRITICAL', 'ERROR', 'ALERT', 'EMERGENCY'].includes(a.level));
      const warn = d.alerts.some((a) => a.level === 'WARNING') || d.pools.some((p) => p.warning);
      st = status(bad ? 'Problems' : warn ? 'Warnings' : 'Healthy', bad ? 'critical' : warn ? 'warning' : 'good');
    } else st = status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const card = hostCard('TrueNAS', h, sub, st, (d) => {
      return [
        sparks([[`nas:${h.id}:load`, 'Load (1 min)', '', 2]]),
        el('h4', { text: 'Pools' }),
        d.pools.length
          ? el('div', null, d.pools.map((p) => {
            const f = p.size ? p.allocated / p.size : 0;
            return el('div', { class: 'meter-row' },
              el('span', { class: 'label', title: p.detail || null }, p.name),
              el('div', null, meter(f, usageClass(f)), el('div', { class: 'small muted num' }, status(p.healthy ? p.status : `${p.status} (unhealthy)`, p.healthy ? (p.warning ? 'warning' : 'good') : 'critical'), ` · ${fmt.bytes(p.allocated)} of ${fmt.bytes(p.size)} used`)),
              el('span', { class: 'value', text: fmt.pct(f) }));
          }))
          : el('p', { class: 'empty', text: 'No pools' }),
        el('h4', { text: `Active alerts (${d.alerts.length})` }),
        d.alerts.length
          ? el('ul', { class: 'alerts' }, d.alerts.map((a) => el('li', null,
            status(a.level, ['CRITICAL', 'ERROR', 'ALERT', 'EMERGENCY'].includes(a.level) ? 'critical' : a.level === 'WARNING' ? 'warning' : ''),
            ' ', el('span', { class: 'when', text: a.time ? fmt.time(a.time) : '' }),
            HD.clampText(a.text, 'alert-text'))))
          : el('p', { class: 'muted small' }, status('No active alerts', 'good')),
      ];
    });
    return [h.id, { ...card, title: 'TrueNAS' }];
  });
}


// ---------------------------------------------------------------------------
// Synology (SNMP)

function renderSynology(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    let st;
    if (d) {
      const crit = d.system.status === 'Failed' || d.disks.some((x) => ['Critical', 'Failing'].includes(x.health) || x.status === 'Crashed') || d.pools.some((p) => /Crashed/.test(p.status));
      const warn = d.disks.some((x) => x.health === 'Warning') || d.pools.some((p) => !p.healthy) || [d.system.systemFan, d.system.cpuFan, d.system.powerStatus].includes('Failed');
      st = status(crit ? 'Problems' : warn ? 'Warnings' : 'Healthy', crit ? 'critical' : warn ? 'warning' : 'good');
    } else st = status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const sub = d ? [d.system.model, d.system.version].filter(Boolean).join(' · ') : '';
    const card = hostCard('Synology', h, sub, st, (d) => {
      const s = d.system;
      const memF = s.memTotal ? s.memUsed / s.memTotal : null;
      const diskClass = (x) => (['Critical', 'Failing'].includes(x.health) || x.status === 'Crashed' ? 'critical' : x.health === 'Warning' ? 'warning' : 'good');
      return [
        sparks([
          s.temp != null ? [`syno:${h.id}:temp`, 'Temperature', ' °C'] : null,
          s.cpu != null ? [`syno:${h.id}:cpu`, 'CPU', ' %'] : null,
          memF != null ? [`syno:${h.id}:mem`, 'Memory', ' %'] : null,
        ]),
        el('div', { class: 'status-line' },
          ...[['System', s.status], ['Fans', [s.systemFan, s.cpuFan].includes('Failed') ? 'Failed' : s.systemFan], ['Power', s.powerStatus]].map(([label, v]) => status(`${label} ${v === 'Failed' ? 'failed' : v ? 'OK' : 'unknown'}`, v === 'Failed' ? 'critical' : v ? 'good' : '')),
          s.upgradeAvailable ? status('DSM update available', 'warning') : null),
        d.volumes.length ? el('h4', { text: 'Volumes' }) : null,
        d.volumes.map((v) => {
          const f = v.size ? v.used / v.size : 0;
          return el('div', { class: 'meter-row' },
            el('span', { class: 'label', text: v.name.replace('/', '') }),
            el('div', null, meter(f, usageClass(f)), el('div', { class: 'small muted num', text: `${fmt.bytes(v.used)} of ${fmt.bytes(v.size)} used` })),
            el('span', { class: 'value', text: fmt.pct(f) }));
        }),
        d.pools.length ? el('h4', { text: 'Storage pools' }) : null,
        d.pools.map((p) => el('div', { class: 'meter-row' },
          el('span', { class: 'label', text: p.name }),
          el('div', null, status(p.status, p.healthy ? 'good' : /Crashed/.test(p.status) ? 'critical' : 'warning')),
          el('span', { class: 'value small', text: p.size ? fmt.bytes(p.size) : '' }))),
        el('h4', { text: 'Disks' }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Disk', 'Model', 'Health'].map((t) => el('th', { text: t })), el('th', { class: 'r', text: 'Temp' }))),
          el('tbody', null, d.disks.map((x) => el('tr', null,
            el('td', { text: x.id }),
            el('td', { class: 'small', text: x.model || '–' }),
            el('td', null, status(x.health || x.status || 'unknown', diskClass(x))),
            el('td', { class: 'r', text: x.temp != null ? `${x.temp} °C` : '–' })))))),
      ];
    });
    return [h.id, { ...card, title: 'Synology DSM' }];
  });
}

// ---------------------------------------------------------------------------
// UniFi

function renderUnifi(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? `${d.devices.length} device${d.devices.length === 1 ? '' : 's'}${d.health ? ` · ${d.health.clients} clients` : ''}` : '';
    const card = hostCard('UniFi', h, sub, null, (d) => {
      const hl = d.health;
      if (!hl) return el('p', { class: 'small muted', text: 'The console reports no network summary.' });
      return kv([
        ['Internet', hl.wan ? `${hl.wan.status === 'ok' ? 'Up' : hl.wan.status}${hl.wan.ip ? ` · ${hl.wan.ip}` : ''}` : null],
        ['Latency', hl.internet?.latencyMs != null ? `${hl.internet.latencyMs} ms` : null],
        ['Speed test ↓/↑', hl.internet?.downMbps != null ? `${fmt.n(hl.internet.downMbps)} / ${fmt.n(hl.internet.upMbps)} Mbps` : null],
        ['Clients Wi-Fi / wired', `${hl.wifiClients ?? '–'} / ${hl.wiredClients ?? '–'}`],
      ]);
    });
    return [h.id, { ...card, title: 'Network · UniFi' }];
  });
}

// A single UniFi device (gateway, switch or access point) reported by a console
function unifiDeviceSection(ud, consoleHost) {
  const h = { ok: consoleHost?.ok ?? null, error: consoleHost?.error || (consoleHost?.data && !ud ? 'Not reported by the UniFi console' : null), lastOkAt: consoleHost?.lastOkAt, data: ud || null };
  const st = ud ? status(ud.state, ud.online ? 'good' : 'critical') : status(consoleHost?.ok === false ? 'unreachable' : 'pending', consoleHost?.ok === false ? 'critical' : '');
  const maxTemp = (x) => (x.temps.length ? Math.max(...x.temps.map((t) => t.value)) : null);
  return {
    type: 'UniFi',
    title: `UniFi · ${ud?.model || 'device'}`,
    h,
    sub: ud ? [ud.model, ud.version && `firmware ${ud.version}`].filter(Boolean).join(' · ') : '',
    statusNode: st,
    bodyFn: (x) => {
      const parts = [kv([
        ['Uptime', x.online ? fmt.uptime(x.uptime) : null],
        ['CPU / memory', x.cpu != null ? `${fmt.pct(x.cpu)} / ${fmt.pct(x.mem)}` : null],
        ['Firmware', x.version || null],
      ])];
      const k = `unifi:${consoleHost.id}:${x.mac}`;
      if (x.online) parts.push(sparks([
        x.cpu != null ? [`${k}:cpu`, 'CPU', ' %'] : null,
        maxTemp(x) != null ? [`${k}:temp`, 'Temperature', ' °C'] : null,
        x.clients != null ? [`${k}:clients`, 'Clients', ''] : null,
        x.poe ? [`${k}:poe`, 'PoE draw', ' W', 1] : null,
      ]));
      const poe = x.ports.filter((p) => p.poeW > 0);
      if (poe.length) {
        parts.push(el('h4', { text: 'PoE consumers' }));
        parts.push(el('div', null, poe.map((p) => el('div', { class: 'meter-row' },
          el('span', { class: 'label', text: p.name }), meter(p.poeW / 30), el('span', { class: 'value', text: `${fmt.n(p.poeW, 1)} W` })))));
      }
      if (x.radios.length) {
        const bands = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };
        parts.push(el('h4', { text: 'Radios' }));
        parts.push(el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, el('th', { text: 'Band' }), ['Channel', 'Clients', 'Satisfaction'].map((t) => el('th', { class: 'r', text: t })))),
          el('tbody', null, x.radios.map((r) => el('tr', null,
            el('td', { text: bands[r.radio] || r.radio }),
            el('td', { class: 'r', text: r.channel ?? '–' }),
            el('td', { class: 'r', text: r.clients ?? '–' }),
            el('td', { class: 'r', text: r.satisfaction != null ? `${r.satisfaction} %` : '–' })))))));
      }
      return parts;
    },
  };
}

// One widget per device, with a section per connection (iDRAC, Proxmox, ...).
function renderDevices(d) {
  const nodeFor = new Map(d.devices.flatMap((dev) => dev.connections.filter((c) => c.node).map((c) => [c.id, c.node])));
  const sections = new Map([
    ...renderIdrac(d.idrac),
    ...renderProxmox(d.proxmox, (id) => nodeFor.get(id)),
    ...renderTruenas(d.truenas),
    ...renderSynology(d.synology || []),
    ...renderUnifi(d.unifi || []),
  ]);
  const consoles = new Map((d.unifi || []).map((h) => [h.id, h]));
  const order = { idrac: 0, synology: 1, truenas: 2, proxmox: 3, unifi: 5 };
  return d.devices
    .filter((dev) => dev.connections.length || dev.unifi)
    .map((dev) => {
      const secs = [...dev.connections]
        .sort((a, b) => order[a.type] - order[b.type])
        .map((c) => sections.get(c.id))
        .filter(Boolean);
      if (dev.unifi) {
        const host = consoles.get(dev.unifi.hostId);
        const ud = host?.data?.devices?.find((x) => x.mac === dev.unifi.mac);
        secs.splice(secs.findIndex((x) => x.title === 'Network · UniFi') + 1 || secs.length, 0, unifiDeviceSection(ud, host));
      }
      return { id: `device:${dev.id}`, title: dev.name, w: 6, h: 9, node: deviceCard(dev, secs, d) };
    });
}

// ---------------------------------------------------------------------------
// Rack panel

let rackObserver = null;
let rackDraw = null;
let rackResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rackResizeTimer);
  rackResizeTimer = setTimeout(() => rackDraw && rackDraw(), 150); // window height changes don't resize the panel width
});

function renderRackPanel(d) {
  const panel = $('rack-panel');
  const rack = d.rack;
  const enabled = rack && rack.enabled;
  $('dash').classList.toggle('no-rack', !enabled);
  if (!enabled) return panel.replaceChildren();
  const inner = el('div', { class: 'rack-view' });
  // On narrow screens the rack comes after everything else, so it starts folded
  let open = false;
  try {
    open = localStorage.getItem('hd.rackOpen') === '1';
  } catch {
    /* only a convenience */
  }
  panel.classList.toggle('collapsed', !open);
  const toggle = el('button', { type: 'button', class: 'rack-toggle', 'aria-expanded': String(open), text: open ? 'Hide rack' : 'Show rack' });
  toggle.addEventListener('click', () => {
    const now = panel.classList.toggle('collapsed') === false;
    toggle.setAttribute('aria-expanded', String(now));
    toggle.textContent = now ? 'Hide rack' : 'Show rack';
    try {
      localStorage.setItem('hd.rackOpen', now ? '1' : '0');
    } catch {
      /* only a convenience */
    }
  });
  const title = el('div', { class: 'card-head' },
    el('div', { class: 'title' }, el('div', { class: 'card-type', text: 'Rack' }), el('h3', { text: `${rack.units} U` })),
    rack.items.length ? toggle : el('span', { class: 'small muted', text: 'Add equipment in Admin' }));
  panel.replaceChildren(title, inner);
  const opts = (u) => ({ uPx: u, onSelect: (item) => jumpToWidget(`device:${item.id}`) });
  const draw = () => {
    const faceWidth = Math.max(160, inner.clientWidth - 60);
    let u = Math.round(Math.max(18, Math.min(faceWidth / 9, 46)));
    Rack.render(inner, rack, d, opts(u));
    // Side-by-side layout: shrink units until the whole panel (heading, frame, off-rack list) fits the screen
    if (window.matchMedia('(min-width: 1101px)').matches) {
      const maxH = parseFloat(getComputedStyle(panel).maxHeight) || window.innerHeight - 92;
      const overhead = panel.scrollHeight - rack.units * u;
      const fit = Math.floor((maxH - overhead) / rack.units);
      if (fit < u) {
        u = Math.max(18, fit);
        Rack.render(inner, rack, d, opts(u));
      }
    }
  };
  rackDraw = draw;
  draw();
  if (rackObserver) rackObserver.disconnect();
  let lastW = inner.clientWidth;
  rackObserver = new ResizeObserver(() => {
    if (inner.clientWidth !== lastW) {
      lastW = inner.clientWidth;
      draw();
    }
  });
  rackObserver.observe(inner);
}

function jumpToWidget(id) {
  const wg = id && board.widgets.get(id);
  if (!wg) return;
  wg.el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
  wg.el.classList.remove('flash');
  void wg.el.offsetWidth;
  wg.el.classList.add('flash');
}

// ---------------------------------------------------------------------------
// Power & cost

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  const b = y + h;
  return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
}

let chartObserver = null;

function renderDailyChart(days, H = 170) {
  const wrap = el('div', { class: 'chart' });
  wrap.style.minHeight = `${H}px`;
  const tip = el('div', { class: 'tooltip hidden', role: 'status' });
  const draw = () => {
    const W = Math.max(wrap.clientWidth || 600, 280);
    const padL = 44;
    const padB = 22;
    const padT = 8;
    const plotH = H - padB - padT;
    const max = Math.max(0, ...days.map((d) => d.kwh));
    const step = niceStep(max / 3);
    const top = step * 3;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const band = (W - padL) / days.length;
    const bw = Math.max(2, Math.min(24, band - 2));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Daily energy use over the last 30 days in kWh' });
    for (let i = 0; i <= 3; i++) {
      const v = step * i;
      s.append(svg('line', { class: 'gridline', x1: padL, x2: W, y1: y(v), y2: y(v) }));
      s.append(svg('text', { class: 'axis-label', x: padL - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmt.n(v, Number.isInteger(step) ? 0 : step < 0.1 ? 2 : 1)));
    }
    days.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const bar = svg('path', { class: 'bar', d: barPath(cx - bw / 2, y(d.kwh), bw, y(0) - y(d.kwh), 4) });
      const hit = svg('rect', { class: 'hit', x: padL + band * i, y: padT, width: band, height: plotH });
      const show = () => {
        bar.classList.add('active');
        tip.replaceChildren(
          el('strong', { text: new Date(d.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) }),
          `${fmt.n(d.kwh, 2)} kWh · ${fmt.kr(d.cost)}`,
          d.unpricedKwh > 0.01 ? el('div', { class: 'muted', text: `${fmt.n(d.unpricedKwh, 2)} kWh without price data` }) : ''
        );
        tip.classList.remove('hidden');
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(cx - tw / 2, 0), W - tw)}px`;
        tip.style.top = `${Math.max(y(d.kwh) - tip.offsetHeight - 8, 0)}px`;
      };
      const hide = () => {
        bar.classList.remove('active');
        tip.classList.add('hidden');
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('click', show);
      s.append(hit, bar);
      if ((i % 7 === 0 && days.length - 1 - i >= 3) || i === days.length - 1) {
        s.append(svg('text', { class: 'axis-label', x: cx, y: H - 6, 'text-anchor': 'middle' },
          new Date(d.date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
      }
    });
    wrap.replaceChildren(s, tip);
  };
  if (chartObserver) chartObserver.disconnect();
  chartObserver = new ResizeObserver(() => draw());
  chartObserver.observe(wrap);
  return wrap;
}

// One card: the draw now with its graph, then what it costs. The 30-day chart appears once there
// are two days to compare; yearly figures and the price breakdown sit under Details.
function renderPower(p) {
  const pn = p.priceNow;
  const est = p.estimate;
  const u = p.usage;
  const m = p.measured;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsed = now.getDate() - 1 + (now.getHours() * 60 + now.getMinutes()) / 1440;
  const forecast = est ? u.month.cost + est.day * (daysInMonth - elapsed) : null;
  const plan = p.plan === 'norgespris' ? 'Norgespris' : `Spot ${p.area}`;
  const loggedDays = u.days.filter((x) => x.kwh > 0).length;
  const open = expanded.has('power');
  const breakdown = [
    m.idrac != null ? `iDRAC ${fmt.n(m.idrac)} W` : null,
    m.poe != null ? `PoE ${fmt.n(m.poe, 1)} W` : null,
    p.estimatedW > 0 ? `estimated ${fmt.n(p.estimatedW)} W${p.includeEstimates ? '' : ' (not in cost)'}` : null,
  ].filter(Boolean).join(' · ');
  const notes = [];
  if (p.fixed.monthlyKr > 0) notes.push(p.fixed.included ? `Costs include fixed fees of ${fmt.kr(p.fixed.monthlyKr, 0)}/month.` : `Fixed fees (${fmt.kr(p.fixed.monthlyKr, 0)}/month) are not included.`);
  if (u.since) notes.push(`Logging since ${fmt.time(u.since)}.`);
  if (u.year.unpricedKwh > 0.01) notes.push(`${fmt.n(u.year.unpricedKwh, 2)} kWh this year was logged without a price and is not in the cost.`);
  const details = el('div', { class: 'card-details', id: 'details-power', hidden: !open },
    kv([
      ['Price now', pn ? `${fmt.n(pn.energy, 1)} energy + ${fmt.n(pn.grid, 1)} grid (${pn.period})` : null],
      ['Draw', breakdown || null],
      ['Logged this year', `${fmt.n(u.year.kwh, 0)} kWh · ${fmt.kr(u.year.cost, 0)}`],
      ['Per year at this draw', est ? `${fmt.n(est.kwhDay * 365, 0)} kWh · ${fmt.kr(est.year, 0)}` : null],
    ]),
    el('details', { class: 'table-view' },
      el('summary', { text: 'Last 30 days as a table' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Date' }), el('th', { class: 'r', text: 'kWh' }), el('th', { class: 'r', text: 'Cost' }))),
        el('tbody', null, u.days.slice().reverse().map((x) => el('tr', null, el('td', { text: x.date }), el('td', { class: 'r', text: fmt.n(x.kwh, 2) }), el('td', { class: 'r', text: fmt.kr(x.cost) }))))))),
    notes.length ? el('p', { class: 'hint', text: notes.join(' ') }) : null);
  const toggle = el('button', { type: 'button', class: 'link-button details-toggle', 'aria-expanded': String(open), 'aria-controls': 'details-power', text: open ? 'Hide details' : 'Details' });
  toggle.addEventListener('click', () => {
    const show = details.hidden;
    details.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    toggle.textContent = show ? 'Hide details' : 'Details';
    if (show) expanded.add('power');
    else expanded.delete('power');
    storeExpanded();
    if (show) board.grow('power-summary');
    else board.shrink('power-summary');
  });
  const metric = (v, l) => el('div', null, el('span', { class: 'v num', text: v }), el('span', { class: 'l', text: l }));
  return el('article', { class: 'card power-card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'title' }, el('div', { class: 'card-type', text: 'Power & cost' }), el('div', { class: 'sub', text: `${plan}${pn ? ` · ${fmt.n(pn.total, 1)} øre/kWh now` : ''}${p.vat ? ' · incl. VAT' : ''}` })),
      HD.rangeTabs()),
    el('div', { class: 'power-now' },
      el('div', { class: 'hero' }, el('div', { class: 'value' }, p.watts != null ? fmt.n(p.watts) : '–', el('small', { text: 'W' })),
        el('div', { class: 'label', text: p.includeEstimates && p.estimatedW > 0 ? 'measured + estimated' : 'measured' })),
      p.watts != null ? sparks([['power:total', 'Measured draw', ' W']]) : el('p', { class: 'muted small', text: 'Add an iDRAC or a UniFi switch with PoE to measure power.' })),
    el('div', { class: 'dc-metrics' },
      metric(fmt.kr(u.today.cost), `Today · ${fmt.n(u.today.kwh, 1)} kWh`),
      metric(fmt.kr(u.month.cost, 0), 'This month'),
      forecast != null ? metric(fmt.kr(forecast, 0), 'Month forecast') : null,
      est ? metric(`${fmt.n(est.kwhDay, 1)} kWh`, 'Per day at this draw') : null),
    loggedDays >= 2 ? el('div', { class: 'power-chart' }, el('div', { class: 'small muted', text: 'Daily use, last 30 days (kWh)' }), renderDailyChart(u.days, 110)) : null,
    el('div', { class: 'dc-foot' }, el('div'), el('div', { class: 'dc-links' }, toggle)),
    details);
}

// "Needs attention": the alert engine's current findings, worst first, with the totals
function renderAttention(d) {
  const box = $('attention');
  const list = d.attention || [];
  const monitored = d.devices.filter((dev) => dev.connections.length || dev.unifi);
  const online = monitored.filter((dev) => !['Offline', 'Waiting'].includes(deviceStates.get(dev.id))).length;
  const sv = d.services;
  const counts = [
    monitored.length ? `Devices ${online} of ${monitored.length} online` : null,
    sv?.up + sv?.down ? `Services ${sv.up} of ${sv.up + sv.down} up` : null,
    d.power.watts != null ? `${fmt.n(d.power.watts)} W · ${fmt.kr(d.power.usage.today.cost)} today` : null,
  ].filter(Boolean);
  if (!monitored.length && !sv?.total) return box.replaceChildren();
  const worst = list.some((a) => a.severity === 'critical') ? 'critical' : list.length ? 'warning' : 'good';
  box.className = `attention ${worst}`;
  const item = (a) => {
    const text = [a.subject ? el('strong', { text: a.subject }) : null, el('span', { class: 'attn-text', text: a.text })];
    const target = a.deviceId
      ? el('button', { type: 'button', class: 'attn-link', onclick: () => jumpToWidget(`device:${a.deviceId}`) }, text)
      : a.serviceId ? el('a', { class: 'attn-link', href: '/services' }, text) : el('span', null, text);
    return el('li', { title: [a.subject, a.text, a.detail].filter(Boolean).join(' · ') }, el('span', { class: `led ${a.severity}`, 'aria-hidden': 'true' }), el('span', { class: 'sr-only', text: a.severity === 'critical' ? 'Problem:' : 'Warning:' }), target);
  };
  const shown = attentionOpen ? list : list.slice(0, 5);
  box.replaceChildren(
    el('div', { class: 'attn-main' },
      list.length
        ? el('ul', { class: 'attn-list', 'aria-label': 'Needs attention' }, shown.map(item))
        : el('p', { class: 'attn-ok' }, el('span', { class: 'led good', 'aria-hidden': 'true' }), 'Everything is OK'),
      list.length > 5 ? el('button', { type: 'button', class: 'link-button', text: attentionOpen ? 'Show fewer' : `Show all ${list.length}`, onclick: () => { attentionOpen = !attentionOpen; renderAttention(d); } }) : null),
    el('div', { class: 'attn-counts num' }, counts.map((c) => el('span', { text: c }))));
}
let attentionOpen = false;

// ---------------------------------------------------------------------------
// Board & customize mode

const board = new GridLayout.Board($('grid'), { onEditChange: () => renderEditBar() });
let layoutLoaded = false;

function renderNav(d) {
  $('view-tabs').replaceChildren(...HD.viewTabs('overview', d.loggedIn));
  const items = [];
  if (d.loggedIn) {
    items.push(el('button', { type: 'button', id: 'customize', text: 'Customize', disabled: board.editing, onclick: () => board.startEdit() }));
    items.push(el('a', { class: 'button', href: '/admin', text: 'Admin' }), el('button', { type: 'button', text: 'Log out', onclick: HD.logout }));
  } else items.push(el('a', { class: 'button', href: '/login', text: 'Log in' }));
  $('nav').replaceChildren(...items);
}

function renderEditBar() {
  const bar = $('edit-bar');
  bar.classList.toggle('hidden', !board.editing);
  if (lastData) renderNav(lastData);
  if (!board.editing) return bar.replaceChildren();
  const hidden = board.hiddenWidgets();
  const add = el('select', { 'aria-label': 'Show hidden widget', disabled: hidden.length === 0 },
    el('option', { value: '', text: hidden.length ? `Show hidden widget (${hidden.length})…` : 'No hidden widgets' }),
    hidden.map((d) => el('option', { value: d.id, text: d.title })));
  add.addEventListener('change', () => add.value && board.show(add.value));
  const msg = el('span', { class: 'msg', role: 'status' });
  bar.replaceChildren(
    el('p', { class: 'hint', text: 'Drag widgets to move them, drag the corner to resize. Keyboard: Tab to a widget, arrows move, Shift + arrows resize.' }),
    add,
    el('button', { type: 'button', text: 'Reset to default', onclick: () => confirm('Reset the layout to the default arrangement?') && board.reset() }),
    el('button', { type: 'button', text: 'Cancel', onclick: () => board.stopEdit(true) }),
    el('button', {
      type: 'button',
      class: 'primary',
      text: 'Save layout',
      onclick: async () => {
        try {
          await HD.api('PUT', '/api/admin/layout', board.snapshot());
          board.stopEdit(false);
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      },
    }),
    msg);
}

function render(d) {
  document.title = d.title;
  $('title').textContent = d.title;
  if (!layoutLoaded) {
    board.load(d.layout);
    layoutLoaded = true;
  }
  renderNav(d);
  attention = d.attention || [];
  deviceStates.clear();
  const defs = [
    { id: 'power-summary', title: 'Power & cost', w: 12, h: 8, node: renderPower(d.power) },
    ...renderDevices(d),
  ];
  board.render(defs);
  renderAttention(d);
  HD.fillSparks().then(() => board.remeasure());
  renderRackPanel(d);
  pruneFans();
  const noHosts = ['idrac', 'proxmox', 'truenas', 'synology', 'unifi'].every((k) => !(d[k] || []).length);
  $('empty-hint').classList.toggle('hidden', !noHosts);
  $('empty-hint').replaceChildren('No hosts configured yet. ', d.loggedIn ? el('a', { href: '/admin', text: 'Add hosts in Admin' }) : '');
}

function tickUpdated() {
  $('updated').textContent = lastData ? `Updated ${fmt.ago(lastData.generatedAt)}` : '';
}

async function refresh() {
  clearTimeout(refreshTimer);
  let delay = 30;
  try {
    const r = await fetch('/api/dashboard', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lastData = await r.json();
    delay = lastData.refreshSeconds;
    $('global-error').classList.add('hidden');
    render(lastData);
  } catch (e) {
    $('global-error').textContent = `Could not load dashboard data: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
  tickUpdated();
  refreshTimer = setTimeout(refresh, Math.max(10, delay) * 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
window.addEventListener('beforeunload', (e) => {
  if (board.editing) e.preventDefault();
});
reduceMotion.addEventListener('change', () => lastData && render(lastData));
setInterval(tickUpdated, 5000);
refresh();
