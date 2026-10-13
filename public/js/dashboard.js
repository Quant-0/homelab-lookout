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

// The words every name in a list starts with ("System Board Fan1A", "System Board Fan2A" -> "Fan1A", "Fan2A")
function shortNames(names) {
  if (names.length < 2) return names;
  const words = names.map((n) => String(n).split(/\s+/));
  let k = 0;
  while (words.every((w) => w.length > k + 1 && w[k] === words[0][k])) k++;
  return words.map((w) => w.slice(k).join(' '));
}
// Sensor names without what the heading already says ("System Board Inlet Temp" -> "Inlet")
const sensorName = (name) => String(name).replace(/^System Board\s+/i, '').replace(/\s+Temp(erature)?$/i, '') || name;

function fanNode(key, fan, label = fan.name) {
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
  n.name.textContent = label;
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
// A device: one status, a few key numbers and what is wrong. The drawer shows the full
// sections; facts that never change (service tag, firmware, cores…) live on the Docs sheet.

let attention = []; // what needs attention, from the server (worst first)

// Everything the tile and the drawer need about a device, from its connections
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
  const snmpH = host('snmp');
  const nutH = host('nut');
  const omadaH = host('omada');
  const pingH = host('ping');
  const plugH = host('shelly') || host('tasmota') || host('hass');
  const dockerH = host('docker') || host('portainer');
  const omadaMac = conn('omada')?.mac || null;
  const linkHost = dev.unifi && (d.unifi || []).find((h) => h.id === dev.unifi.hostId);
  const ud = linkHost?.data?.devices?.find((x) => x.mac === dev.unifi.mac) || null;
  const om = omadaH?.data || null;
  return {
    idracH, idrac: idracH?.data, pveH, node, guests: pveH?.data?.guests?.filter((g) => !node || g.node === node.name) || [],
    tnH, tn: tnH?.data, synoH, syno: synoH?.data, uniH, health: uniH?.data?.health, linkHost, ud,
    snmpH, snmp: snmpH?.data, nutH, ups: snmpH?.data?.ups || nutH?.data?.ups || null, upsH: snmpH?.data?.ups ? snmpH : nutH?.data?.ups ? nutH : null,
    omadaH, om, omd: omadaMac && om ? om.devices.find((x) => x.mac === omadaMac) || null : null, omadaMac,
    pingH, ping: pingH?.ok === false ? null : pingH?.data || null,
    plugH, plug: plugH?.data || null,
    dockerH, docker: dockerH?.data || null,
    hosts: [idracH, pveH, tnH, synoH, uniH, snmpH, nutH, omadaH, pingH, plugH, dockerH].filter(Boolean),
    showVms: d.vms?.host !== false,
  };
}

function deviceState(dev, ctx, issues) {
  if (!ctx.hosts.length && !dev.unifi) return ['Not monitored', ''];
  // Offline when every part we can see is down: connections, the Proxmox node, the UniFi or Omada device
  const parts = [
    ...ctx.hosts.filter((h) => (h !== ctx.pveH || !ctx.node) && (h !== ctx.omadaH || !ctx.omadaMac)).map((h) => (h.ok === null ? null : h.ok)),
    ...(ctx.node ? [ctx.node.status === 'online'] : []),
    ...(dev.unifi && ctx.linkHost?.data ? [Boolean(ctx.ud?.online)] : []),
    ...(ctx.omadaMac && ctx.om ? [Boolean(ctx.omd?.online)] : []),
  ].filter((x) => x !== null);
  if (parts.length && parts.every((x) => !x)) return ['Offline', 'critical'];
  if (issues.some((a) => a.severity === 'critical')) return ['Fault', 'critical'];
  if (issues.some((a) => a.severity === 'warning')) return ['Warning', 'warning'];
  if (!parts.length) return ['Waiting', ''];
  return ['OK', 'good'];
}

// Up to four numbers that answer "how is it doing?": { v, u (unit), l (label), f (0–1 for a bar), tone }
function keyMetrics(dev, ctx, max = 4) {
  const out = [];
  const add = (v, u, l, f = null, tone = '') => {
    if (v !== null && v !== undefined && v !== '' && out.length < max) out.push({ v: String(v), u, l, f, tone });
  };
  const share = (a, b) => (b ? a / b : null);
  const pctOf = (f) => (f == null ? null : fmt.n(f * 100));
  const load = (f) => (f >= 0.9 ? 'critical' : f >= 0.8 ? 'warning' : '');
  const hl = ctx.health;
  if (hl) {
    add(hl.wan ? (hl.wan.status === 'ok' ? 'Up' : 'Down') : null, '', 'Internet', null, hl.wan && hl.wan.status !== 'ok' ? 'critical' : '');
    add(hl.internet?.latencyMs != null ? fmt.n(hl.internet.latencyMs) : null, 'ms', 'Latency');
    add(hl.internet?.rxMbps != null ? `${fmt.n(hl.internet.rxMbps, hl.internet.rxMbps < 10 ? 1 : 0)}/${fmt.n(hl.internet.txMbps ?? 0, (hl.internet.txMbps ?? 0) < 10 ? 1 : 0)}` : null, 'Mbps', 'Traffic ↓/↑');
    add(hl.internet?.downMbps != null ? `${fmt.n(hl.internet.downMbps)}/${fmt.n(hl.internet.upMbps)}` : null, 'Mbps', 'Speed test');
    add(hl.clients != null ? fmt.n(hl.clients) : null, '', 'Clients');
  }
  if (ctx.idrac) {
    const t = ctx.idrac.temps;
    const inlet = t.find((x) => /inlet/i.test(x.name));
    add(ctx.idrac.watts != null ? fmt.n(ctx.idrac.watts) : null, 'W', 'Power');
    if (inlet) add(fmt.n(inlet.celsius), '°C', 'Inlet', null, inlet.warn && inlet.celsius >= inlet.warn ? 'warning' : '');
    else if (t.length) add(fmt.n(Math.max(...t.map((x) => x.celsius))), '°C', 'Hottest');
  }
  // a smart plug: the power, unless Redfish already measures it
  if (ctx.plug && !ctx.idrac) add(fmt.n(ctx.plug.watts, ctx.plug.watts < 10 ? 1 : 0), 'W', 'Power');
  if (ctx.ups) {
    const u = ctx.ups;
    add(u.charge != null ? fmt.n(u.charge) : null, '%', 'Battery', u.charge != null ? u.charge / 100 : null, u.lowBattery ? 'critical' : u.onBattery ? 'warning' : '');
    add(u.runtimeMin != null ? fmt.n(u.runtimeMin) : null, 'min', 'Runtime');
    add(u.loadPct != null ? fmt.n(u.loadPct) : null, '%', 'Load', u.loadPct != null ? u.loadPct / 100 : null, load((u.loadPct || 0) / 100));
    add(u.outputW != null ? fmt.n(u.outputW) : null, 'W', 'Output');
  }
  if (ctx.node?.status === 'online') {
    add(pctOf(ctx.node.cpu), '%', 'CPU', ctx.node.cpu, load(ctx.node.cpu));
    const mem = share(ctx.node.mem, ctx.node.maxmem);
    add(pctOf(mem), '%', 'Memory', mem, load(mem));
    if (!ctx.idrac && ctx.showVms) add(`${ctx.guests.filter((g) => g.status === 'running').length}/${ctx.guests.length}`, '', 'VMs running');
  }
  if (ctx.tn) {
    for (const p of ctx.tn.pools.slice(0, 3)) {
      const f = share(p.allocated, p.size);
      add(pctOf(f), '%', p.name, f, p.healthy ? load(f) : 'critical');
    }
    add(fmt.n(ctx.tn.alerts.length), '', 'Alerts', null, ctx.tn.alerts.length ? 'warning' : '');
  }
  if (ctx.syno) {
    const sy = ctx.syno.system;
    add(sy.temp != null ? fmt.n(sy.temp) : null, '°C', 'Temperature');
    const v = ctx.syno.volumes[0];
    const vf = v ? share(v.used, v.size) : null;
    add(pctOf(vf), '%', v ? v.name.replace('/', '') : 'Volume', vf, load(vf || 0));
    const mf = share(sy.memUsed, sy.memTotal);
    add(pctOf(mf), '%', 'Memory', mf, load(mf || 0));
    add(fmt.n(ctx.syno.disks.length), '', 'Disks');
  }
  if (ctx.snmp && !ctx.ups) {
    const sn = ctx.snmp;
    const ports = sn.ports.filter((p) => p.enabled);
    if (ports.length) add(`${ports.filter((p) => p.up).length}/${ports.length}`, '', 'Ports up', ports.filter((p) => p.up).length / ports.length);
    const bps = sn.ports.reduce((a, p) => a + (p.inBps || 0) + (p.outBps || 0), 0);
    if (sn.ports.some((p) => p.inBps != null)) add(fmt.n(bps / 1e6, bps < 1e7 ? 1 : 0), 'Mbit/s', 'Traffic');
    add(pctOf(sn.system.cpu), '%', 'CPU', sn.system.cpu, load(sn.system.cpu || 0));
    const v = sn.volumes[0];
    const vf = v ? share(v.used, v.size) : null;
    add(pctOf(vf), '%', v ? v.name : 'Storage', vf, load(vf || 0));
    const mf = share(sn.system.memUsed, sn.system.memTotal);
    add(pctOf(mf), '%', 'Memory', mf, load(mf || 0));
  }
  if (ctx.omd) {
    add(ctx.omd.online ? 'Online' : ctx.omd.state, '', 'Status', null, ctx.omd.online ? '' : 'critical');
    add(ctx.omd.clients != null ? fmt.n(ctx.omd.clients) : null, '', 'Clients');
    add(pctOf(ctx.omd.cpu), '%', 'CPU', ctx.omd.cpu, load(ctx.omd.cpu || 0));
    add(pctOf(ctx.omd.mem), '%', 'Memory', ctx.omd.mem, load(ctx.omd.mem || 0));
  } else if (ctx.om && !ctx.omadaMac) {
    add(`${ctx.om.devices.filter((x) => x.online).length}/${ctx.om.devices.length}`, '', 'Devices online');
    add(fmt.n(ctx.om.devices.reduce((a, x) => a + (x.clients || 0), 0)), '', 'Clients');
  }
  const ud = ctx.ud;
  if (ud && (ud.type === 'camera' || ud.type === 'nvr')) {
    add(ud.online ? 'Online' : ud.state, '', 'Status', null, ud.online ? '' : 'critical');
    if (ud.type === 'camera') add(ud.online ? (ud.recording ? 'Yes' : 'No') : null, '', 'Recording', null, ud.online && !ud.recording ? 'warning' : '');
    if (ud.lastMotion) add(sinceText(ud.lastMotion), '', 'Last motion');
  } else if (ud?.online && !hl) {
    if (ud.ports.length) add(`${ud.ports.filter((p) => p.up).length}/${ud.ports.length}`, '', 'Ports up', ud.ports.filter((p) => p.up).length / ud.ports.length);
    if (ud.poe) add(`${fmt.n(ud.poe.usedW)}${ud.poe.budgetW ? `/${fmt.n(ud.poe.budgetW)}` : ''}`, 'W', 'PoE', ud.poe.budgetW ? ud.poe.usedW / ud.poe.budgetW : null);
    add(ud.clients != null ? fmt.n(ud.clients) : null, '', 'Clients');
    const temps = ud.temps.map((x) => x.value);
    add(temps.length ? fmt.n(Math.max(...temps)) : null, '°C', 'Temperature');
    add(ud.cpu != null ? pctOf(ud.cpu) : null, '%', 'CPU', ud.cpu, load(ud.cpu || 0));
  }
  if (ctx.docker) {
    const all = ctx.docker.containers.filter((c) => !c.ignore);
    const run = all.filter((c) => c.state === 'running').length;
    const bad = all.some((c) => c.health === 'unhealthy' || c.state === 'restarting');
    add(`${run}/${all.length}`, '', 'Containers running', all.length ? run / all.length : null, bad ? 'warning' : '');
  }
  if (ctx.ping) {
    if (!out.length) add('Online', '', 'Status');
    add(fmt.n(ctx.ping.ms, ctx.ping.ms < 10 ? 1 : 0), 'ms', 'Ping', null, ctx.ping.loss ? 'warning' : '');
  }
  if (!out.length && dev.estimateW) add(`~${fmt.n(dev.estimateW)}`, 'W', 'Estimated');
  return out;
}

function metricNode(m) {
  let bar = null;
  if (m.f != null) {
    const fill = el('i');
    fill.style.width = `${(Math.max(0, Math.min(1, m.f)) * 100).toFixed(1)}%`;
    bar = el('span', { class: 'bar', 'aria-hidden': 'true' }, fill);
  }
  return el('div', { class: `metric${m.tone ? ` ${m.tone}` : ''}` },
    el('span', { class: 'l', text: m.l }),
    el('span', { class: 'v num' }, m.v, m.u ? el('small', { text: m.u === '%' ? '%' : ` ${m.u}` }) : null),
    bar);
}

const KIND_ICONS = Rack.KIND_ICONS;
const ISSUE_ICONS = { critical: 'octagon-alert', warning: 'triangle-alert', serious: 'triangle-alert' };

// The one history graph that says most about the device
function mainSpark(ctx) {
  if (ctx.idrac) return [`idrac:${ctx.idracH.id}:watts`, 'Power', ' W'];
  if (ctx.plug) return [`plug:${ctx.plugH.id}:watts`, 'Power', ' W', 1];
  if (ctx.ups) return [`ups:${ctx.upsH.id}:load`, 'UPS load', ' %'];
  if (ctx.node) return [`pve:${ctx.pveH.id}:${ctx.node.name}:cpu`, 'CPU', ' %'];
  if (ctx.syno) return [`syno:${ctx.synoH.id}:temp`, 'Temperature', ' °C'];
  if (ctx.tn) return [`nas:${ctx.tnH.id}:load`, 'Load (1 min)', '', 2];
  if (ctx.snmp) return ctx.snmp.ports.some((p) => p.inBps != null) ? [`snmp:${ctx.snmpH.id}:traffic`, 'Traffic', ' Mbit/s', 1] : [`snmp:${ctx.snmpH.id}:cpu`, 'CPU', ' %'];
  if (ctx.omd) return [`omada:${ctx.omadaH.id}:${ctx.omd.mac}:clients`, 'Clients', ''];
  if (ctx.ud && !ctx.health) {
    const k = `unifi:${ctx.linkHost.id}:${ctx.ud.mac}`;
    return ctx.ud.poe ? [`${k}:poe`, 'PoE draw', ' W', 1] : [`${k}:clients`, 'Clients', ''];
  }
  if (ctx.pingH) return [`ping:${ctx.pingH.id}:ms`, 'Ping', ' ms', 1];
  return null;
}

// Values a device doesn't report are left out instead of shown as "–"
function kv(pairs) {
  return el('div', { class: 'kv' }, pairs.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '–').map(([k, v]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }))));
}

// History graphs: [key, label, unit, decimals, more sparkSlot options] (null entries are skipped)
function sparks(list) {
  const cells = list.filter(Boolean).map(([key, label, unit, decimals = 0, more = {}]) => HD.sparkSlot(key, { label, unit, decimals, ...more }));
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
          return el('div', { class: 'meter-row', title: [t.name, t.warn && `Warning at ${t.warn} °C`, t.crit && `Critical at ${t.crit} °C`].filter(Boolean).join(' · ') },
            el('span', { class: 'label', text: sensorName(t.name) }),
            meter(t.celsius / scale, cls),
            el('span', { class: 'value', text: `${fmt.n(t.celsius)} °C${cls ? ' ⚠' : ''}` }));
        })));
      }
      if (d.fans.length) {
        parts.push(el('h4', { text: 'Fans' }));
        const labels = shortNames(d.fans.map((f) => f.name));
        parts.push(el('div', { class: 'fans' }, d.fans.map((f, i) => fanNode(`${h.id}|${f.name}|${i}`, f, labels[i]))));
      }
      return parts;
    });
    return [h.id, { ...card, title: 'Hardware · iDRAC' }];
  });
}

// ---------------------------------------------------------------------------
// Proxmox

// What the owner chose to show about VMs and containers (Admin → Dashboard)
const VM_DEFAULTS = { home: true, services: true, host: true, rack: true, stopped: true, cpu: true, ram: true, uptime: true, homeNumbers: false };

function guestNumbers(g, vs) {
  if (g.status !== 'running') return [];
  return [
    vs.cpu && g.cpu != null ? `CPU ${fmt.pct(g.cpu, 1)}` : null,
    vs.ram && g.mem != null ? `${fmt.bytes(g.mem)} RAM` : null,
    vs.uptime && g.uptime ? `up ${fmt.uptime(g.uptime)}` : null,
  ].filter(Boolean);
}

// A guest's fullest disk: a container's root disk, or the fullest filesystem the guest agent reports
function guestDisk(g) {
  if (g.disk != null && g.maxdisk) return { used: g.disk, size: g.maxdisk, mount: '/' };
  const fs = g.agent?.fs || [];
  return fs.length ? fs.reduce((a, f) => (f.used / f.size > a.used / a.size ? f : a)) : null;
}
const bitsText = (bps) => (bps == null ? '–' : bps * 8 >= 1e6 ? `${fmt.n((bps * 8) / 1e6, 1)} Mbit/s` : `${fmt.n((bps * 8) / 1e3, 0)} kbit/s`);

// Opened from a guest's row: traffic and disk graphs, its filesystems and addresses
function guestDetail(g, hostId) {
  const k = `pveg:${hostId}:${g.vmid}`;
  const fsRows = (g.agent?.fs || (g.disk != null ? [{ mount: '/', used: g.disk, size: g.maxdisk }] : [])).map((f) => {
    const fr = f.size ? f.used / f.size : 0;
    return el('div', { class: 'meter-row' },
      el('span', { class: 'label', text: f.mount, title: f.type || '' }),
      el('div', null, meter(fr, usageClass(fr)), el('div', { class: 'small muted num', text: `${fmt.bytes(f.used)} of ${fmt.bytes(f.size)} used` })),
      el('span', { class: 'value', text: fmt.pct(fr) }));
  });
  return el('div', { class: 'guest-detail' },
    sparks([
      [`${k}:rx`, 'Network', ' Mbit/s', 1, { key2: `${k}:tx`, names: ['in', 'out'], legend: ['In', 'Out'], zero: true }],
      [`${k}:read`, 'Disk activity', ' MB/s', 1, { key2: `${k}:write`, names: ['read', 'write'], legend: ['Read', 'Write'], zero: true }],
    ]),
    fsRows.length ? fsRows : null,
    g.type === 'qemu' && g.agent && !g.agent.running
      ? el('p', { class: 'small muted', text: 'Install the QEMU guest agent in this VM (apt install qemu-guest-agent) and switch it on under Options in Proxmox to see its disks and addresses.' })
      : null,
    kv([
      ['Address', g.agent?.ips?.join(', ') || null],
      ['Operating system', g.agent?.os || null],
      ['Network now', g.rxBps != null ? `${bitsText(g.rxBps)} in · ${bitsText(g.txBps)} out` : null],
    ]));
}

function guestTable(guests, vs, hostId) {
  const shown = guests.filter((g) => vs.stopped || g.status === 'running');
  if (!shown.length) return el('p', { class: 'small muted', text: guests.length ? 'No running VMs or containers' : 'No VMs or containers' });
  const cols = [['cpu', 'CPU'], ['ram', 'Memory'], ['disk', 'Disk'], ['uptime', 'Uptime']].filter(([k]) => (k === 'disk' ? shown.some(guestDisk) : vs[k]));
  const span = 3 + cols.length;
  return el('div', { class: 'table-wrap' }, el('table', { class: 'guest-table' },
    el('thead', null, el('tr', null, ['Name', 'Type', 'Status'].map((t) => el('th', { text: t })), cols.map(([, t]) => el('th', { class: 'r', text: t })))),
    el('tbody', null, [...shown].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || String(a.name).localeCompare(String(b.name))).map((g) => {
      const on = g.status === 'running';
      const memF = g.maxmem ? g.mem / g.maxmem : null;
      const dk = on ? guestDisk(g) : null;
      const dkF = dk?.size ? dk.used / dk.size : null;
      const val = {
        cpu: on ? `${fmt.pct(g.cpu, 1)}${g.maxcpu ? ` of ${g.maxcpu}` : ''}` : '–',
        ram: on ? `${fmt.bytes(g.mem)}${memF != null ? ` (${fmt.pct(memF)})` : ''}` : '–',
        disk: dk ? `${fmt.pct(dkF)}${dk.mount !== '/' ? ` ${dk.mount}` : ''}` : '–',
        uptime: on ? fmt.uptime(g.uptime) : '–',
      };
      const row = el('tr', { class: [on ? 'guest-row' : 'muted'].join(' '), tabindex: on ? 0 : null, 'aria-expanded': on ? 'false' : null, title: on ? 'Show graphs and disks' : null },
        el('td', null, el('strong', { text: g.name || String(g.vmid) }), el('span', { class: 'small muted num', text: ` ${g.vmid}` })),
        el('td', { text: g.type === 'lxc' ? 'Container' : 'VM' }),
        el('td', null, el('span', { class: `dot ${on ? 'good' : 'off'}` }), ` ${g.status}`),
        cols.map(([k]) => el('td', { class: `r num${k === 'disk' && dkF != null ? ` ${usageClass(dkF)}` : ''}`, text: val[k] })));
      if (!on) return row;
      const toggle = () => {
        const open = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', String(!open));
        if (open) row.nextElementSibling?.classList.contains('guest-more') && row.nextElementSibling.remove();
        else {
          row.after(el('tr', { class: 'guest-more' }, el('td', { colspan: span }, guestDetail(g, hostId))));
          HD.fillSparks();
        }
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()));
      return row;
    }))));
}

// Storage, ZFS, the node's disks and its last backup job: what Proxmox reads every 5 minutes
function pveStorage(d) {
  const out = [];
  const stRows = (d.storage || []).map((st) => {
    const f = st.size ? st.used / st.size : 0;
    return el('div', { class: 'meter-row' },
      el('span', { class: 'label', text: st.name, title: [st.type, st.node ? `node ${st.node}` : 'shared'].filter(Boolean).join(' · ') }),
      el('div', null, meter(f, usageClass(f)), el('div', { class: 'small muted num', text: `${fmt.bytes(st.used)} of ${fmt.bytes(st.size)} used${st.type ? ` · ${st.type}` : ''}` })),
      el('span', { class: 'value', text: fmt.pct(f) }));
  });
  if (stRows.length) out.push(el('h4', { text: 'Storage' }), stRows);
  const pools = d.nodes.flatMap((n) => (n.zfs || []).map((z) => ({ ...z, node: n.name })));
  if (pools.length) {
    out.push(el('h4', { text: 'ZFS pools' }), pools.map((z) => el('div', { class: 'meter-row' },
      el('span', { class: 'label', text: z.name }),
      el('div', null, status(z.health || 'unknown', z.health === 'ONLINE' ? 'good' : z.health === 'DEGRADED' ? 'warning' : 'critical'),
        el('span', { class: 'small muted num', text: ` ${fmt.bytes(z.alloc)} of ${fmt.bytes(z.size)}${z.frag != null ? ` · ${z.frag} % fragmented` : ''}` })),
      el('span', { class: 'value', text: z.size ? fmt.pct(z.alloc / z.size) : '' }))));
  }
  const disks = d.nodes.flatMap((n) => (n.disks || []).map((x) => ({ ...x, node: n.name })));
  if (disks.length) {
    const many = d.nodes.filter((n) => n.disks?.length).length > 1;
    out.push(el('h4', { text: 'Disks' }), el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['Disk', 'Model', 'Type', 'SMART'].map((t) => el('th', { text: t })), ['Size', 'Wear left'].map((t) => el('th', { class: 'r', text: t })))),
      el('tbody', null, disks.map((x) => {
        const bad = x.health && !['PASSED', 'OK', 'UNKNOWN'].includes(x.health.toUpperCase());
        return el('tr', null,
          el('td', { class: 'num', text: many ? `${x.node} ${x.dev}` : x.dev }),
          el('td', { text: x.model || '–' }),
          el('td', { text: x.kind ? x.kind.toUpperCase() : '–' }),
          el('td', null, status(x.health || 'unknown', bad ? 'critical' : x.health === 'UNKNOWN' || !x.health ? '' : 'good')),
          el('td', { class: 'r num', text: x.size ? fmt.bytes(x.size) : '–' }),
          el('td', { class: `r num${x.wearLeft != null && x.wearLeft <= 10 ? ' warning' : ''}`, text: x.wearLeft != null ? `${x.wearLeft} %` : '–' }));
      })))));
  }
  for (const b of d.backups || []) {
    out.push(el('p', { class: 'small' }, el('strong', { text: 'Last backup job' }), d.backups.length > 1 ? ` (${b.node})` : '', ': ',
      status(b.ok ? 'OK' : b.warnings ? 'Warnings' : 'Failed', b.ok ? 'good' : b.warnings ? 'warning' : 'critical'),
      ` ${fmt.ago(b.at)}${b.ok ? '' : ` · ${b.status}`}`));
  }
  for (const n of d.notes || []) out.push(el('p', { class: 'small muted', text: n }));
  return out;
}

function renderProxmox(hosts, nodeFor = () => null, vs = VM_DEFAULTS) {
  return hosts.map((h0) => {
    const node = nodeFor(h0.id);
    const h = h0.data && node
      ? { ...h0, data: { ...h0.data, nodes: h0.data.nodes.filter((n) => n.name === node), guests: h0.data.guests.filter((g) => g.node === node), storage: (h0.data.storage || []).filter((st) => !st.node || st.node === node), backups: (h0.data.backups || []).filter((b) => b.node === node) } }
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
        pveStorage(d),
        vs.host ? [el('h4', { text: `VMs and containers · ${up} of ${d.guests.length} running` }), guestTable(d.guests, vs, h0.id)] : null,
        vs.host ? el('p', { class: 'small muted' }, el('a', { href: '/vms', text: 'All VMs, with their disks and backups' })) : null,
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
      const pr = d.protect;
      return kv([
        ['Cameras', pr ? `${pr.online} of ${pr.cameras} online${pr.recording ? `, ${pr.recording} recording` : ''}` : null],
        ['Recordings', pr?.storage ? `${fmt.bytes(pr.storage.used)} of ${fmt.bytes(pr.storage.total)}` : null],
        ['Internet', hl.wan ? `${hl.wan.status === 'ok' ? 'Up' : hl.wan.status}${hl.wan.ip ? ` · ${hl.wan.ip}` : ''}` : null],
        ['Latency', hl.internet?.latencyMs != null ? `${hl.internet.latencyMs} ms` : null],
        ['Traffic now ↓/↑', hl.internet?.rxMbps != null ? `${fmt.n(hl.internet.rxMbps, 1)} / ${fmt.n(hl.internet.txMbps ?? 0, 1)} Mbps` : null],
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
        ['Recording', x.type === 'camera' && x.online ? (x.recording ? 'Yes' : 'No') : null],
        ['Last motion', x.lastMotion ? fmt.time(x.lastMotion) : null],
        ['Uptime', x.online ? fmt.uptime(x.uptime) : null],
        ['CPU / memory', x.cpu != null ? `${fmt.pct(x.cpu)} / ${fmt.pct(x.mem)}` : null],
        ['Firmware', x.version || null],
      ])];
      const k = `unifi:${consoleHost.id}:${x.mac}`;
      const wanNow = ['udm', 'ugw', 'uxg'].includes(x.type) && consoleHost.data?.health?.internet?.rxMbps != null;
      if (x.online) parts.push(sparks([
        wanNow ? [`unifi:${consoleHost.id}:wan:down`, 'Internet traffic', ' Mbps', 1, { key2: `unifi:${consoleHost.id}:wan:up`, names: ['↓', '↑'], legend: ['Download', 'Upload'], zero: true }] : null,
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
// ---------------------------------------------------------------------------
// Any SNMP device, a UPS through NUT, an Omada controller

function upsSection(u) {
  return [
    kv([
      ['Running on', u.onBattery ? 'Battery' : u.source || null],
      ['Battery', [u.charge != null ? `${fmt.n(u.charge)} %` : null, u.battery].filter(Boolean).join(' · ') || null],
      ['Runtime', u.runtimeMin != null ? `${fmt.n(u.runtimeMin)} min` : null],
      ['Load', u.loadPct != null ? `${fmt.n(u.loadPct)} %${u.outputW != null ? ` · ${fmt.n(u.outputW)} W` : ''}` : u.outputW != null ? `${fmt.n(u.outputW)} W` : null],
      ['Input', u.inputV != null ? `${fmt.n(u.inputV)} V` : null],
      ['Temperature', u.temp != null ? `${fmt.n(u.temp)} °C` : null],
    ]),
    u.lowBattery || u.onBattery || u.replaceBattery
      ? el('div', { class: 'status-line' },
        u.lowBattery ? status('Battery low', 'critical') : u.onBattery ? status('On battery', 'warning') : null,
        u.replaceBattery ? status('Replace the battery', 'warning') : null)
      : null,
  ];
}

const mbit = (bps) => (bps == null ? '–' : bps >= 1e9 ? `${fmt.n(bps / 1e9, 1)} Gbit/s` : bps >= 1e6 ? `${fmt.n(bps / 1e6, 1)} Mbit/s` : `${fmt.n(bps / 1e3, 0)} kbit/s`);

function renderSnmp(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? [d.system.name, d.ups ? [d.ups.maker, d.ups.model].filter(Boolean).join(' ') : null].filter(Boolean).join(' · ') : '';
    const card = hostCard('SNMP', h, sub, null, (d) => {
      const s = d.system;
      const parts = [
        sparks([
          d.ups ? [`ups:${h.id}:load`, 'UPS load', ' %'] : null,
          d.ups ? [`ups:${h.id}:charge`, 'Battery', ' %'] : null,
          d.ports.some((p) => p.inBps != null) ? [`snmp:${h.id}:traffic`, 'Traffic', ' Mbit/s', 1] : null,
          s.cpu != null ? [`snmp:${h.id}:cpu`, 'CPU', ' %'] : null,
        ]),
        d.ups ? upsSection(d.ups) : null,
        kv([
          ['Name', s.name],
          ['Uptime', s.uptime != null ? fmt.uptime(s.uptime) : null],
          ['CPU', s.cpu != null ? fmt.pct(s.cpu) : null],
          ['Memory', s.memTotal ? `${fmt.bytes(s.memUsed)} of ${fmt.bytes(s.memTotal)}` : null],
          ['Location', s.location],
        ]),
      ];
      if (d.ports.length) {
        const up = d.ports.filter((p) => p.up).length;
        parts.push(el('h4', { text: `Ports · ${up} of ${d.ports.length} up` }));
        parts.push(el('div', { class: 'ports', role: 'img', 'aria-label': `${up} of ${d.ports.length} ports up` }, d.ports.map((p) => el('span', {
          class: `port${p.up ? ' up' : ''}${p.enabled ? '' : ' off'}`,
          title: [p.name, p.alias, p.up ? `up${p.speedMbps ? ` at ${p.speedMbps >= 1000 ? `${p.speedMbps / 1000} G` : `${p.speedMbps} M`}` : ''}` : p.enabled ? 'down' : 'disabled', p.inBps != null ? `in ${mbit(p.inBps)}, out ${mbit(p.outBps)}` : null].filter(Boolean).join(' · '),
          text: String(p.idx).slice(-3),
        }))));
        const busy = d.ports.filter((p) => p.inBps != null && p.inBps + p.outBps > 0).sort((a, b) => b.inBps + b.outBps - a.inBps - a.outBps).slice(0, 5);
        if (busy.length) {
          parts.push(el('div', { class: 'table-wrap' }, el('table', null,
            el('thead', null, el('tr', null, el('th', { text: 'Busiest ports' }), el('th', { class: 'r', text: 'In' }), el('th', { class: 'r', text: 'Out' }))),
            el('tbody', null, busy.map((p) => el('tr', null, el('td', { text: p.alias ? `${p.name} · ${p.alias}` : p.name }), el('td', { class: 'r', text: mbit(p.inBps) }), el('td', { class: 'r', text: mbit(p.outBps) })))))));
        }
      }
      if (d.volumes.length) {
        parts.push(el('h4', { text: 'Storage' }));
        parts.push(d.volumes.map((v) => {
          const f = v.size ? v.used / v.size : 0;
          return el('div', { class: 'meter-row' }, el('span', { class: 'label', text: v.name }),
            el('div', null, meter(f, usageClass(f)), el('div', { class: 'small muted num', text: `${fmt.bytes(v.used)} of ${fmt.bytes(v.size)}` })),
            el('span', { class: 'value', text: fmt.pct(f) }));
        }));
      }
      return parts;
    });
    return [h.id, { ...card, title: d?.ups ? 'UPS · SNMP' : 'SNMP' }];
  });
}

function renderNut(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? [d.ups.maker, d.ups.model].filter(Boolean).join(' ') : '';
    const card = hostCard('NUT', h, sub, null, (d) => [
      sparks([[`ups:${h.id}:load`, 'Load', ' %'], [`ups:${h.id}:charge`, 'Battery', ' %'], d.ups.outputW != null ? [`ups:${h.id}:watts`, 'Output', ' W'] : null]),
      upsSection(d.ups),
    ]);
    return [h.id, { ...card, title: 'UPS · NUT' }];
  });
}

// Docker hosts and Portainer environments: one row per container
const CT_STATE = { running: 'good', restarting: 'critical', exited: '', created: '', paused: 'warning', dead: 'critical' };
function renderContainers(d) {
  return ['docker', 'portainer'].flatMap((type) => (d[type] || []).map((h) => {
    const x = h.data;
    const sub = x ? `${x.containers.filter((c) => c.state === 'running').length} of ${x.containers.length} running${x.engine?.version ? ` · Docker ${x.engine.version}` : x.engine?.environment ? ` · ${x.engine.environment}` : ''}` : '';
    const card = hostCard(type === 'docker' ? 'Docker' : 'Portainer', h, sub, null, (data) => [
      data.containers.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'guest-table' },
        el('thead', null, el('tr', null, ['Container', 'State'].map((t) => el('th', { text: t })), ['CPU', 'Memory', 'Restarts'].map((t) => el('th', { class: 'r', text: t })))),
        el('tbody', null, data.containers.map((c) => el('tr', { class: c.state === 'running' ? null : 'muted' },
          el('td', null, el('strong', { text: c.name }), el('div', { class: 'small muted', text: c.image })),
          el('td', null, el('span', { class: `dot ${c.health === 'unhealthy' ? 'critical' : CT_STATE[c.state] || 'off'}` }), ` ${c.state}${c.health ? ` · ${c.health}` : ''}`),
          el('td', { class: 'r num', text: c.cpu != null ? `${fmt.n(c.cpu * 100, 1)} %` : '–' }),
          el('td', { class: 'r num', text: c.memUsed != null ? fmt.bytes(c.memUsed) : '–' }),
          el('td', { class: `r num${c.recentRestarts >= 3 ? ' critical' : ''}`, text: c.restarts ?? '–' }))))))
        : el('p', { class: 'small muted', text: 'No containers.' }),
      el('p', { class: 'small muted' }, el('a', { href: '/vms#containers', text: 'All containers, with graphs' })),
    ]);
    return [h.id, { ...card, title: `Containers · ${type === 'docker' ? 'Docker' : 'Portainer'}` }];
  }));
}

// Smart plugs and Home Assistant power sensors
const PLUG_NAMES = { shelly: 'Shelly', tasmota: 'Tasmota', hass: 'Home Assistant' };
function renderPlugs(d) {
  return ['shelly', 'tasmota', 'hass'].flatMap((type) => (d[type] || []).map((h) => {
    const card = hostCard(PLUG_NAMES[type], h, h.data?.model || '', null, (x) => [
      sparks([[`plug:${h.id}:watts`, 'Power', ' W', 1]]),
      kv([
        ['Power now', `${fmt.n(x.watts, x.watts < 10 ? 1 : 0)} W`],
        ['Switch', x.on === true ? 'On' : x.on === false ? 'Off' : null],
        ['Voltage', x.voltage != null ? `${fmt.n(x.voltage, 0)} V` : null],
        ['Current', x.current != null ? `${fmt.n(x.current, 2)} A` : null],
        ['Measured in total', x.totalWh != null ? `${fmt.n(x.totalWh / 1000, 1)} kWh` : null],
      ]),
    ]);
    return [h.id, { ...card, title: `Power · ${PLUG_NAMES[type]}` }];
  }));
}

function renderPing(hosts) {
  return hosts.map((h) => {
    const card = hostCard('Ping', h, '', null, (d) => [
      sparks([[`ping:${h.id}:ms`, 'Response time', ' ms', 1]]),
      kv([['Response time', `${fmt.n(d.ms, d.ms < 10 ? 1 : 0)} ms`], ['Lost', `${d.loss} % of 3 pings`]]),
    ]);
    return [h.id, { ...card, title: 'Reachability · Ping' }];
  });
}

function renderOmada(hosts, macFor) {
  return hosts.map((h) => {
    const mac = macFor(h.id);
    const card = hostCard('Omada', h, '', null, (d) => {
      const one = mac ? d.devices.find((x) => x.mac === mac) : null;
      if (mac) {
        if (!one) return el('p', { class: 'small muted', text: 'Not reported by the Omada controller.' });
        return [
          sparks([[`omada:${h.id}:${one.mac}:clients`, 'Clients', ''], one.cpu != null ? [`omada:${h.id}:${one.mac}:cpu`, 'CPU', ' %'] : null]),
          kv([
            ['Status', one.state],
            ['Model', one.model],
            ['Uptime', one.online ? fmt.uptime(one.uptime) : null],
            ['CPU / memory', one.cpu != null ? `${fmt.pct(one.cpu)} / ${fmt.pct(one.mem)}` : null],
            ['Clients', one.clients != null ? fmt.n(one.clients) : null],
            ['PoE', one.poe ? `${fmt.n(one.poe.usedW, 1)} of ${fmt.n(one.poe.budgetW)} W` : null],
            ['Firmware', one.version ? `${one.version}${one.upgradable ? ' · update available' : ''}` : null],
          ]),
        ];
      }
      return el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Device', 'Model', 'Status'].map((t) => el('th', { text: t })), el('th', { class: 'r', text: 'Clients' }))),
        el('tbody', null, d.devices.map((x) => el('tr', null,
          el('td', { text: x.name }),
          el('td', { class: 'small', text: x.model || '–' }),
          el('td', null, status(x.state, x.online ? 'good' : 'critical')),
          el('td', { class: 'r', text: x.clients != null ? fmt.n(x.clients) : '–' }))))));
    });
    return [h.id, { ...card, title: mac ? 'Omada' : 'Omada controller' }];
  });
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

// ---------------------------------------------------------------------------
// Devices: a tile each, the full sections in the drawer

function deviceSections(d) {
  const nodeFor = new Map(d.devices.flatMap((dev) => dev.connections.filter((c) => c.node).map((c) => [c.id, c.node])));
  const macFor = new Map(d.devices.flatMap((dev) => dev.connections.filter((c) => c.mac).map((c) => [c.id, c.mac])));
  return new Map([
    ...renderIdrac(d.idrac),
    ...renderProxmox(d.proxmox, (id) => nodeFor.get(id), d.vms),
    ...renderTruenas(d.truenas),
    ...renderSynology(d.synology || []),
    ...renderUnifi(d.unifi || []),
    ...renderSnmp(d.snmp || []),
    ...renderNut(d.nut || []),
    ...renderOmada(d.omada || [], (id) => macFor.get(id)),
    ...renderPing(d.ping || []),
    ...renderPlugs(d),
    ...renderContainers(d),
  ]);
}

// One entry per monitored device: what the tile and the drawer show
function deviceInfos(d) {
  const sections = deviceSections(d);
  const consoles = new Map((d.unifi || []).map((h) => [h.id, h]));
  const order = { idrac: 0, shelly: 1, tasmota: 1, hass: 1, nut: 1, snmp: 1, synology: 1, truenas: 2, proxmox: 3, omada: 4, unifi: 5, docker: 6, portainer: 6, ping: 7 };
  return d.devices
    .filter((dev) => dev.connections.length || dev.unifi)
    .map((dev) => {
      const ctx = deviceContext(dev, d);
      const secs = [...dev.connections].sort((a, b) => order[a.type] - order[b.type]).map((c) => sections.get(c.id)).filter(Boolean);
      if (dev.unifi) {
        const host = consoles.get(dev.unifi.hostId);
        const ud = host?.data?.devices?.find((x) => x.mac === dev.unifi.mac);
        secs.splice(secs.findIndex((x) => x.title === 'Network · UniFi') + 1 || secs.length, 0, unifiDeviceSection(ud, host));
      }
      const issues = attention.filter((a) => a.deviceId === dev.id);
      const model = ctx.idrac?.model || ctx.syno?.system?.model || ctx.ud?.model || ctx.omd?.model || (ctx.ups ? [ctx.ups.maker, ctx.ups.model].filter(Boolean).join(' ') : '')
        || (ctx.tn ? ctx.tn.system.version || 'TrueNAS' : '') || (ctx.node ? `Proxmox node ${ctx.node.name}` : '') || ctx.snmp?.system?.name || '';
      const update = Boolean(ctx.ud?.upgradable || ctx.syno?.system?.upgradeAvailable || ctx.omd?.upgradable || d.updates?.devices?.includes(dev.id));
      const maint = maintOf(d, dev);
      return { id: dev.id, dev, ctx, secs, issues, state: maint ? ['Maintenance', 'info'] : deviceState(dev, ctx, issues), maint, model, update, metrics: keyMetrics(dev, ctx), spark: mainSpark(ctx) };
    });
}

const tileHidden = new Set(); // device ids hidden from Home (Customize)
let tileOrder = []; // device ids in the saved order

function placement(dev) {
  if (dev.location === 'rack' && Number.isInteger(dev.u)) return dev.height > 1 ? `Rack · U${dev.u}–${dev.u + dev.height - 1}` : `Rack · U${dev.u}`;
  return dev.location === 'outside' ? 'Outside the rack' : '';
}

function tileNode(info) {
  const { dev, state } = info;
  const [stateText, stateCls] = state;
  const worst = info.issues[0];
  const m = info.metrics[0];
  const line = worst ? worst.text : stateText === 'Offline' ? 'Not answering' : info.model || Rack.KIND_LABELS[dev.kind] || dev.kind;
  const art = Rack.deviceArt(dev, lastData);
  const t = el('button', { type: 'button', class: `dtile${stateCls ? ` ${stateCls}` : ''}${tileHidden.has(dev.id) ? ' is-hidden' : ''}`, 'data-id': dev.id, 'aria-label': `${dev.name}: ${stateText}${worst ? `, ${worst.text}` : ''}` },
    el('span', { class: `tile-art${art ? '' : ' no-art'}` }, art || el('span', { class: 'tile-icon', title: Rack.KIND_LABELS[dev.kind] || dev.kind }, HD.icon(KIND_ICONS[dev.kind] || 'box')), status(stateText, stateCls)),
    el('span', { class: 'tile-body' },
      el('span', { class: 'tile-name', text: dev.name }),
      m ? el('span', { class: 'tile-val' }, el('b', { text: m.v }), el('small', { text: m.u ? `${m.u === '%' ? '%' : m.u} ${m.l.toLowerCase()}` : m.l.toLowerCase() })) : null,
      el('span', { class: 'tile-state', text: line })));
  t.addEventListener('click', () => {
    if (editing) return;
    openDevice(info.id);
  });
  return t;
}

// The drawer: everything about one device. Re-drawn on refresh while open.
let drawerFor = null; // { id, box, close }
function deviceDetail(info) {
  const { dev, state } = info;
  const [stateText, stateCls] = state;
  const d = lastData;
  const signed = d.loggedIn || d.viewer;
  const art = Rack.deviceArt(dev, d);
  return el('article', { class: 'detail' },
    art ? el('div', { class: `d-art${stateCls === 'critical' ? ' critical' : ''}` }, art) : null,
    el('header', { class: 'd-head' },
      art ? null : el('span', { class: 'tile-icon' }, HD.icon(KIND_ICONS[dev.kind] || 'box')),
      el('div', { class: 't' }, el('h2', { text: dev.name }), el('p', { text: [Rack.KIND_LABELS[dev.kind] || dev.kind, info.model, placement(dev)].filter(Boolean).join(' · ') })),
      status(stateText, stateCls)),
    info.issues.map((a) => el('div', { class: `callout ${a.severity}` }, el('b', { text: a.text }), a.detail ? HD.clampText(a.detail) : null, a.since ? el('span', { class: 'small muted', text: sinceText(a.since) === 'just now' ? 'Just now' : `For ${sinceText(a.since)}` }) : null)),
    info.metrics.length ? el('div', { class: 'metrics' }, keyMetrics(dev, info.ctx, 8).map(metricNode)) : null,
    el('div', { class: 'sect-head' }, HD.rangeTabs()),
    info.secs.map((x) => sectionNode(x)),
    signed || info.update ? el('div', { class: 'detail-actions' },
      signed ? el('a', { class: 'button', href: `/docs#server/${dev.id}` }, HD.icon('file-text'), 'Server sheet') : null,
      info.update ? el(signed ? 'a' : 'span', { class: 'button', href: signed ? '/updates' : null }, HD.icon('circle-arrow-up'), 'Update available') : null,
      d.loggedIn ? el('a', { class: 'button ghost', href: '/admin#devices' }, HD.icon('pencil'), 'Edit in Admin') : null) : null);
}

function openDevice(id) {
  const info = infos.find((x) => x.id === id);
  if (!info) return;
  const box = el('div', null, deviceDetail(info));
  const { close } = HD.drawer(info.dev.name, box, { onClose: () => (drawerFor = null) });
  drawerFor = { id, box, close };
  HD.fillSparks();
}

function refreshDrawer() {
  if (!drawerFor) return;
  if (drawerFor.id === 'power') {
    drawerFor.box.replaceChildren(powerDetail(lastData.power));
    return;
  }
  const info = infos.find((x) => x.id === drawerFor.id);
  if (!info) return drawerFor.close();
  const scroller = drawerFor.box.parentElement;
  const top = scroller?.scrollTop || 0;
  drawerFor.box.replaceChildren(deviceDetail(info));
  if (scroller) scroller.scrollTop = top;
}

function sinceText(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(h / 24)} d`;
}

// ---------------------------------------------------------------------------
// Power & cost

function forecastOf(p) {
  const est = p.estimate;
  if (!est) return null;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsed = now.getDate() - 1 + (now.getHours() * 60 + now.getMinutes()) / 1440;
  return p.usage.month.cost + est.day * (daysInMonth - elapsed);
}

function powerTile(p) {
  const pn = p.priceNow;
  const u = p.usage;
  const b = el('button', { type: 'button', class: `big power-tile${p.watts == null ? ' empty-spark' : ''}`, 'aria-label': 'Power and cost' },
    el('span', { class: 'big-head' }, HD.icon('zap'), 'Power', el('span', { class: 'go' }, 'Details', HD.icon('arrow-right'))),
    el('span', { class: 'big-num' }, p.watts != null ? fmt.n(p.watts) : '–', el('small', { text: 'W' })),
    el('span', { class: 'big-facts' },
      el('span', null, el('strong', { text: fmt.kr(u.today.cost) }), ' today'),
      el('span', null, el('strong', { text: fmt.kr(u.month.cost, 0) }), ' this month'),
      pn ? el('span', null, el('strong', { text: `${fmt.n(pn.total, 1)} øre` }), ' per kWh now') : null),
    p.watts != null ? el('span', { class: 'big-spark' }, HD.sparkSlot('power:total', { label: 'Measured draw', unit: ' W', range: '24h' })) : el('span', { class: 'small muted', text: 'Add a server with Redfish, a smart plug, or a UniFi switch with PoE to measure power.' }));
  b.addEventListener('click', openPower);
  return b;
}

function openPower() {
  const box = el('div', null, powerDetail(lastData.power));
  const { close } = HD.drawer('Power & cost', box, { onClose: () => (drawerFor = null) });
  drawerFor = { id: 'power', box, close };
  HD.fillSparks();
}

function powerDetail(p) {
  const pn = p.priceNow;
  const est = p.estimate;
  const u = p.usage;
  const m = p.measured;
  const forecast = forecastOf(p);
  const plan = p.plan === 'norgespris' ? 'Norgespris' : `Spot ${p.area}`;
  const loggedDays = u.days.filter((x) => x.kwh > 0).length;
  const breakdown = [
    m.idrac != null ? `servers ${fmt.n(m.idrac)} W` : null,
    m.poe != null ? `PoE ${fmt.n(m.poe, 1)} W` : null,
    p.estimatedW > 0 ? `estimated ${fmt.n(p.estimatedW)} W${p.includeEstimates ? '' : ' (not in cost)'}` : null,
  ].filter(Boolean).join(' · ');
  const notes = [];
  if (p.fixed.monthlyKr > 0) notes.push(p.fixed.included ? `Costs include fixed fees of ${fmt.kr(p.fixed.monthlyKr, 0)}/month.` : `Fixed fees (${fmt.kr(p.fixed.monthlyKr, 0)}/month) are not included.`);
  if (u.since) notes.push(`Logging since ${fmt.time(u.since)}.`);
  if (u.year.unpricedKwh > 0.01) notes.push(`${fmt.n(u.year.unpricedKwh, 2)} kWh this year was logged without a price and is not in the cost.`);
  const tile = (label, v, unit, sub) => el('div', { class: 'ptile' }, el('span', { class: 'l', text: label }), el('span', { class: 'v num' }, v, unit ? el('small', { text: ` ${unit}` }) : null), sub ? el('span', { class: 'sub', text: sub }) : null);
  const kr = (v, d) => (v == null ? '–' : fmt.n(v, d));
  return el('article', { class: 'detail power-card' },
    el('header', { class: 'd-head' },
      el('span', { class: 'tile-icon' }, HD.icon('zap')),
      el('div', { class: 't' }, el('h2', { text: 'Power & cost' }), el('p', { text: `${plan}${pn ? ` · ${fmt.n(pn.total, 1)} øre/kWh now` : ''}${p.vat ? ' · incl. VAT' : ''}` }))),
    el('div', { class: 'big-num' }, p.watts != null ? fmt.n(p.watts) : '–', el('small', { text: `W ${p.includeEstimates && p.estimatedW > 0 ? 'measured + estimated' : 'measured now'}` })),
    el('div', { class: 'sect-head' }, HD.rangeTabs()),
    p.watts != null ? sparks([['power:total', 'Measured draw', ' W']]) : null,
    el('div', { class: 'power-tiles' },
      tile('Today', kr(u.today.cost, 2), 'kr', `${fmt.n(u.today.kwh, 1)} kWh`),
      tile('This month', kr(u.month.cost, 0), 'kr', `${fmt.n(u.month.kwh, 0)} kWh`),
      forecast != null ? tile('Month forecast', kr(forecast, 0), 'kr', 'at this draw') : null,
      est ? tile('Per day', fmt.n(est.kwhDay, 1), 'kWh', `${fmt.kr(est.day, 0)} a day`) : null),
    loggedDays >= 2 ? el('div', { class: 'power-chart' }, el('div', { class: 'chart-title', text: 'Daily use, last 30 days (kWh)' }), renderDailyChart(u.days, 130)) : null,
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
    notes.length ? el('p', { class: 'hint', text: notes.join(' ') }) : null,
    el('div', { class: 'detail-actions' }, el('a', { class: 'button primary', href: '/energy' }, HD.icon('chart-column'), 'Energy report')));
}

// The internet provider: set in Admin, else what the UniFi console reports
const carrierOf = (d, hl) => d.carrier || hl?.wan?.isp || null;

// Download and upload right now, as a share of the console's last speed test ("142 of 684 Mbps");
// a console that doesn't report traffic shows the speed test itself
const mbpsText = (v) => fmt.n(v, v < 10 ? 1 : 0);
function speedBars(net) {
  if (!net) return null;
  const now = net.rxMbps != null;
  if (!now && net.downMbps == null) return null;
  const rows = now ? [['Download', net.rxMbps, net.downMbps], ['Upload', net.txMbps, net.upMbps]] : [['Download', net.downMbps, null], ['Upload', net.upMbps, null]];
  const scale = now ? null : Math.max(1000, net.downMbps, net.upMbps);
  return el('span', { class: 'speed', title: now ? (net.downMbps != null ? 'Traffic now, against the console\u2019s last speed test' : 'Traffic now') : 'The console\u2019s last speed test' },
    ...rows.map(([l, v, cap]) => {
      const bar = el('i');
      const of = now ? cap || Math.max(100, net.rxMbps, net.txMbps || 0) : scale;
      bar.style.setProperty('--w', `${Math.min(100, ((v || 0) / of) * 100).toFixed(1)}%`);
      return el('span', null, el('span', { text: l }), bar, el('strong', { class: 'num' }, `${mbpsText(v || 0)}`, el('small', { text: now && cap ? ` of ${fmt.n(cap)} Mbps` : ' Mbps' })));
    }));
}

// The internet, from the UniFi gateway (or an Omada gateway)
function internetTile(d) {
  const uh = (d.unifi || []).find((h) => h.data?.health);
  if (uh) {
    const hl = uh.data.health;
    const up = !hl.wan || hl.wan.status === 'ok';
    const gw = uh.data.devices.find((x) => ['udm', 'ugw', 'uxg'].includes(x.type));
    const owner = d.devices.find((dev) => dev.connections.some((c) => c.id === uh.id));
    const b = el('button', { type: 'button', class: `big net${gw ? '' : ' empty-spark'}`, 'aria-label': 'Internet' },
      el('span', { class: 'big-head' }, HD.icon('globe'), 'Internet',
        carrierOf(d, hl) ? el('span', { class: 'carrier' }, d.carrierLogo ? el('img', { class: 'carrier-logo', src: d.carrierLogo, alt: '' }) : null, el('span', { text: carrierOf(d, hl) })) : null,
        owner ? el('span', { class: 'go' }, owner.name, HD.icon('arrow-right')) : null),
      el('span', { class: `big-num${up ? '' : ' down'}` }, up ? 'Up' : 'Down', hl.internet?.latencyMs != null ? el('small', { text: `${fmt.n(hl.internet.latencyMs)} ms` }) : null),
      speedBars(hl.internet),
      el('span', { class: 'big-facts' },
        hl.clients != null ? el('span', null, el('strong', { text: fmt.n(hl.clients) }), ' clients') : null,
        hl.wifiClients != null ? el('span', null, el('strong', { text: fmt.n(hl.wifiClients) }), ' on Wi-Fi') : null,
        hl.wiredClients != null ? el('span', null, el('strong', { text: fmt.n(hl.wiredClients) }), ' wired') : null,
        hl.wan?.ip ? el('span', { class: 'public-ip' }, el('strong', { class: 'num', text: hl.wan.ip }), ' public IP') : null),
      hl.internet?.rxMbps != null
        ? el('span', { class: 'big-spark' }, HD.sparkSlot(`unifi:${uh.id}:wan:down`, { key2: `unifi:${uh.id}:wan:up`, names: ['↓', '↑'], legend: ['Download', 'Upload'], label: 'Internet traffic', unit: ' Mbps', decimals: 1, zero: true, range: '24h' }))
        : gw ? el('span', { class: 'big-spark' }, HD.sparkSlot(`unifi:${uh.id}:${gw.mac}:clients`, { label: 'Clients', unit: '', range: '24h' })) : null);
    if (owner) b.addEventListener('click', () => openDevice(owner.id));
    return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Home

let infos = [];
let servicesData = null;
let servicesAt = 0;

async function loadServices() {
  if (servicesData && Date.now() - servicesAt < 25000) return servicesData;
  try {
    const r = await fetch('/api/services', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) {
      servicesData = await r.json();
      servicesAt = Date.now();
    }
  } catch {
    /* the section is left out */
  }
  return servicesData;
}

function pill(cls, children, attrs) {
  return el(attrs.href ? 'a' : 'button', { class: `pill${cls ? ` ${cls}` : ''}`, ...(attrs.href ? {} : { type: 'button' }), ...attrs }, children);
}

// Snoozed warnings stay off the top of Home (the device still shows them)
const awake = (d) => (d.attention || []).filter((a) => !a.snoozedUntil && !a.maintenance);
const snoozedOnes = (d) => (d.attention || []).filter((a) => a.snoozedUntil && !a.maintenance);
// Problems on something in a maintenance window: listed, muted, and not counted as faults
const inMaintenance = (d) => (d.attention || []).filter((a) => a.maintenance);
const maintOf = (d, dev) => (d.maintenance || []).find((w) => w.all || w.devices.includes(dev.id)) || null;
let showSnoozed = false;

function renderSummary(d) {
  const list = awake(d);
  const zz = snoozedOnes(d).length;
  const crit = list.filter((a) => a.severity === 'critical').length;
  const warn = list.length - crit;
  const online = infos.filter((x) => !['Offline', 'Waiting'].includes(x.state[0])).length;
  const toNeeds = () => $('needs-sec').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  const say = list.length
    ? (crit && warn ? 'Everything else is running normally' : list.length === 1 ? 'Everything else is running normally' : 'The rest is running normally')
    : infos.length ? `${online} of ${infos.length} devices online` : '';
  $('summary').replaceChildren(...[
    crit ? pill('critical', [el('span', { class: 'dot critical' }), el('strong', { text: String(crit) }), crit === 1 ? ' fault' : ' faults'], { onclick: toNeeds }) : null,
    warn ? pill('warning', [el('span', { class: 'dot warning' }), el('strong', { text: String(warn) }), ' to watch'], { onclick: toNeeds }) : null,
    !list.length && (infos.length || d.services?.total) ? pill('good', [el('span', { class: 'dot good' }), 'All normal'], { onclick: toNeeds }) : null,
    (d.maintenance || []).length ? pill('maint', [HD.icon('settings'), d.maintenance.length === 1 ? `Maintenance until ${clockText(d.maintenance[0].until)}` : `${d.maintenance.length} maintenance windows`], { onclick: toNeeds }) : null,
    zz ? pill('snoozed', [HD.icon('clock'), el('strong', { text: String(zz) }), ' snoozed'], { onclick: () => { showSnoozed = true; renderNeeds(d); toNeeds(); } }) : null,
    say ? el('span', { class: 'summary-say', text: say }) : null,
  ].filter(Boolean));
}

function renderNeeds(d) {
  if (document.querySelector('.snooze-menu:not([hidden])')) return; // not while a snooze menu is open
  const list = awake(d);
  const zz = snoozedOnes(d);
  const box = $('needs');
  $('needs-count').textContent = list.length ? String(list.length) : '';
  $('needs-sec').hidden = !list.length && !zz.length && !(d.notices || []).length && !infos.length && !d.services?.total; // the empty hint says it already
  const snoozeLine = zz.length ? el('div', { class: 'snoozed-line' },
    HD.icon('clock'), `${zz.length} snoozed`,
    el('button', { type: 'button', class: 'link-button', 'aria-expanded': String(showSnoozed), text: showSnoozed ? 'Hide' : 'Show', onclick: () => { showSnoozed = !showSnoozed; renderNeeds(d); } })) : null;
  const rows = [...(d.notices || []).map((n) => noticeRow(n, d)), ...(d.maintenance || []).map((w) => maintRow(w, d)), ...list.map((a) => needRow(a, d)), ...inMaintenance(d).map((a) => needRow(a, d)), ...(showSnoozed ? zz.map((a) => needRow(a, d)) : [])];
  if (!list.length) {
    box.className = rows.length ? 'needs' : '';
    const head = infos.length || d.services?.total
      ? el('div', { class: 'all-good' }, el('span', { class: 'need-icon' }, HD.icon('circle-check')), el('div', null, el('b', { text: 'All systems normal' }), el('span', { text: zz.length ? 'Nothing else needs you right now.' : 'Nothing needs you right now.' })))
      : el('p', { class: 'muted', text: 'Nothing is monitored yet.' });
    return box.replaceChildren(...[head, ...rows, snoozeLine].filter(Boolean));
  }
  box.className = 'needs';
  box.replaceChildren(...rows, snoozeLine || '');
}

// A notice (the public IP changed): not a problem, shown until an admin closes it (for everyone)
function noticeRow(n, d) {
  const row = el('div', { class: 'need info', title: `${n.title} · ${n.detail}` },
    el('span', { class: 'need-icon' }, HD.icon(n.kind === 'ip' ? 'globe' : 'info')),
    el('span', { class: 'need-text' }, el('b', { text: n.title }), el('span', { class: 'why num', text: n.detail })),
    el('time', { text: sinceText(n.at) === 'just now' ? 'just now' : sinceText(n.at) }));
  if (!d.loggedIn) return row;
  const close = el('button', {
    type: 'button', class: 'snooze', title: 'Close (stays in the Log)', 'aria-label': `Close: ${n.title}`,
    onclick: async () => {
      try {
        await HD.api('DELETE', `/api/admin/notices/${n.id}`);
        d.notices = d.notices.filter((x) => x !== n);
        renderNeeds(d);
      } catch (e) {
        box.append(el('span', { class: 'snooze-error', role: 'alert', text: e.message }));
      }
    },
  }, HD.icon('x'));
  const box = el('div', { class: 'snooze-box' }, close);
  return el('div', { class: 'need-wrap' }, row, box);
}

const clockText = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// A maintenance window that is on now
function maintRow(w, d) {
  const held = inMaintenance(d).filter((a) => a.maintenance.name === w.name).length;
  return el('div', { class: 'need info', title: `${w.name} · until ${untilText(w.until)}` },
    el('span', { class: 'need-icon' }, HD.icon('settings')),
    el('span', { class: 'need-text' }, el('b', { text: `Maintenance: ${w.name}` }),
      el('span', { class: 'why', text: `${w.all ? 'Everything' : [w.devices.length && `${w.devices.length} device${w.devices.length === 1 ? '' : 's'}`, w.services.length && `${w.services.length} service${w.services.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ') || 'Check-ins'}: no alerts are sent${held ? ` · ${held} problem${held === 1 ? '' : 's'} below` : ''}` })),
    el('time', { text: `until ${clockText(w.until)}` }));
}

const untilText = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function needRow(a, d) {
  const attrs = { class: `need ${a.severity}${a.snoozedUntil || a.maintenance ? ' snoozed' : ''}`, title: [a.subject, a.text, a.detail].filter(Boolean).join(' · ') };
  const inner = [
    el('span', { class: 'need-icon' }, HD.icon(ISSUE_ICONS[a.severity] || 'info')),
    el('span', { class: 'need-text' }, el('span', { class: 'sr-only', text: a.severity === 'critical' ? 'Problem:' : 'Warning:' }),
      el('b', null, a.subject ? el('span', { class: 'who', text: `${a.subject}: ` }) : null, a.text), a.detail ? el('span', { class: 'why', text: a.detail }) : null),
    a.maintenance ? el('time', { text: 'Maintenance' }) : a.snoozedUntil ? el('time', { text: `Snoozed until ${untilText(a.snoozedUntil)}` }) : a.since ? el('time', { text: sinceText(a.since) === 'just now' ? 'just now' : sinceText(a.since) }) : null,
  ];
  let row;
  if (a.deviceId && infos.some((x) => x.id === a.deviceId)) row = el('button', { type: 'button', ...attrs, onclick: () => openDevice(a.deviceId) }, inner);
  else if (a.serviceId) row = el('a', { href: '/services', ...attrs }, inner);
  else row = el('div', attrs, inner);
  if (!d.loggedIn || !a.key || a.maintenance) return row;
  return el('div', { class: 'need-wrap' }, row, snoozeControl(a, d));
}

// Snooze for 1 day or 1 week, for everyone (admin only); a snoozed one can be shown again
function snoozeControl(a, d) {
  let box = null;
  const send = async (days) => {
    for (const m of document.querySelectorAll('.snooze-menu')) m.hidden = true;
    try {
      await HD.api('POST', '/api/admin/snooze', { key: a.key, days });
      a.snoozedUntil = days ? Date.now() + days * 864e5 : null;
      renderSummary(d);
      renderNeeds(d);
    } catch (e) {
      box?.append(el('span', { class: 'snooze-error', role: 'alert', text: e.message }));
    }
  };
  if (a.snoozedUntil) {
    box = el('div', { class: 'snooze-box' }, el('button', { type: 'button', class: 'snooze', title: 'Show it again', 'aria-label': `Show again: ${a.subject || ''} ${a.text}`, onclick: () => send(0) }, HD.icon('bell')));
    return box;
  }
  const menu = el('div', { class: 'snooze-menu', role: 'menu', hidden: true },
    el('button', { type: 'button', role: 'menuitem', text: 'Snooze 1 day', onclick: () => send(1) }),
    el('button', { type: 'button', role: 'menuitem', text: 'Snooze 1 week', onclick: () => send(7) }));
  const close = (e) => {
    if (e && (e.target.closest?.('.snooze-box') === box)) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', close);
    document.removeEventListener('keydown', esc);
  };
  const esc = (e) => e.key === 'Escape' && (close(), btn.focus());
  const btn = el('button', {
    type: 'button', class: 'snooze', title: 'Snooze', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Snooze ${a.subject || ''} ${a.text}`,
    onclick: () => {
      if (!menu.hidden) return close();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      menu.querySelector('button').focus();
      document.addEventListener('pointerdown', close);
      document.addEventListener('keydown', esc);
    },
  }, HD.icon('clock'));
  box = el('div', { class: 'snooze-box' }, btn, menu);
  return box;
}

function orderedInfos() {
  const pos = new Map(tileOrder.map((id, i) => [id, i]));
  const rackPos = (x) => (x.dev.location === 'rack' && Number.isInteger(x.dev.u) ? -x.dev.u : 1000);
  return [...infos].sort((a, b) => (pos.get(a.id) ?? 1e6) - (pos.get(b.id) ?? 1e6) || rackPos(a) - rackPos(b) || a.dev.name.localeCompare(b.dev.name));
}

function renderDevices() {
  const shown = orderedInfos().filter((x) => editing || !tileHidden.has(x.id));
  const rack = shown.filter((x) => x.dev.location === 'rack');
  const other = shown.filter((x) => x.dev.location !== 'rack');
  $('devices-count').textContent = infos.length ? String(infos.length) : '';
  const group = (label, list, key) => (list.length ? [el('div', { class: 'place', text: label }), el('div', { class: 'dtiles', 'data-group': key }, list.map((x) => {
    const t = tileNode(x);
    if (editing) {
      const hidden = tileHidden.has(x.id);
      t.append(el('span', {
        class: 'icon-button tile-hide',
        role: 'button',
        tabindex: 0,
        title: hidden ? 'Show on Home' : 'Hide from Home',
        'aria-label': hidden ? `Show ${x.dev.name}` : `Hide ${x.dev.name}`,
        onclick: (e) => {
          e.stopPropagation();
          if (tileHidden.has(x.id)) tileHidden.delete(x.id);
          else tileHidden.add(x.id);
          renderDevices();
        },
      }, HD.icon(hidden ? 'eye-off' : 'eye')));
      t.addEventListener('pointerdown', (e) => !e.target.closest('.tile-hide') && dragTile(e, t));
    }
    return t;
  }))] : []);
  $('devices').replaceChildren(...group('In the rack', rack, 'rack'), ...group(rack.length ? 'Elsewhere' : 'Devices', other, 'other'));
  $('devices-sec').hidden = !infos.length;
}

function serviceRow(s) {
  const c = s.check;
  const down = c && !c.up;
  const iconBox = s.icon ? el('span', { class: 'svc-row-icon' }, el('img', { src: s.icon, alt: '' })) : HD.letterIcon(s.name, 'svc-row-icon letter');
  return el(s.href ? 'a' : 'div', { class: `svc-line${down ? ' critical' : ''}`, href: s.href || null, target: s.href ? '_blank' : null, rel: s.href ? 'noopener noreferrer' : null },
    iconBox,
    el('span', { class: 'svc-line-name', text: s.name }),
    down ? el('span', { class: 'svc-line-why', text: c.error || (c.code ? `HTTP ${c.code}` : 'Down') }) : null,
    c ? el('span', { class: `dot ${c.up ? 'good' : 'critical'}`, title: c.up ? 'Up' : 'Down' }) : null);
}

function serviceTile(s) {
  const c = s.check;
  const down = c && !c.up;
  const st = s.stats?.find((x) => x.value !== null && x.value !== undefined && x.value !== '');
  const iconBox = s.icon ? el('span', { class: 'tile-icon' }, el('img', { src: s.icon, alt: '' })) : HD.letterIcon(s.name, 'tile-icon letter');
  const line = down ? (c.error || (c.code ? `Down · HTTP ${c.code}` : 'Down')) : st ? `${HD.statValue(st)} ${st.label.toLowerCase()}` : s.description || s.device || '';
  const t = el(s.href ? 'a' : 'div', { class: `dtile${down ? ' critical' : ''}`, href: s.href || null, target: s.href ? '_blank' : null, rel: s.href ? 'noopener noreferrer' : null },
    el('span', { class: 'tile-top' }, iconBox, c ? el('span', { class: `dot ${c.up ? 'good' : 'critical'}`, title: c.up ? 'Up' : 'Down' }) : null),
    el('span', { class: 'tile-name', text: s.name }),
    el('span', { class: 'tile-state', text: line }));
  return t;
}

// Admin → Dashboard: tiles, a compact list, only the ones that are down, or off
function renderServicesSec(svc, mode = 'tiles') {
  const all = (svc?.groups || []).flatMap((g) => g.services || []).filter((s) => s.onHome !== false);
  const down = all.filter((s) => s.check && !s.check.up);
  const sec = $('services-sec');
  sec.hidden = mode === 'off' || mode === 'line' || !all.length || (mode === 'down' && !down.length);
  if (sec.hidden) return;
  const checked = all.filter((s) => s.check);
  $('services-count').textContent = mode === 'down' ? `${down.length} down` : checked.length ? `${checked.length - down.length} of ${checked.length} up` : String(all.length);
  const box = $('services');
  if (mode === 'compact' || mode === 'down') {
    box.className = 'svc-lines';
    box.replaceChildren(...(mode === 'down' ? down : [...down, ...all.filter((s) => !down.includes(s))]).map(serviceRow));
    return;
  }
  box.className = 'dtiles small';
  box.replaceChildren(...[...down, ...all.filter((s) => !down.includes(s))].slice(0, 12).map(serviceTile));
}

// The rest in one quiet line: services, VMs and updates, each a link to its page
function renderFoot(d) {
  const vs = d.vms || VM_DEFAULTS;
  const all = (servicesData?.groups || []).flatMap((g) => g.services || []).filter((s) => s.onHome !== false);
  const checked = all.filter((s) => s.check);
  const down = checked.filter((s) => !s.check.up).length;
  const seen = new Set();
  const guests = (d.proxmox || []).flatMap((h) => h.data?.guests || []).filter((g) => !seen.has(`${g.node}:${g.vmid}`) && seen.add(`${g.node}:${g.vmid}`)).filter((g) => vs.stopped || g.status === 'running');
  const running = guests.filter((g) => g.status === 'running').length;
  const item = (href, ok, text) => el('a', { href }, el('span', { class: `dot ${ok ? 'good' : 'critical'}` }), text);
  const items = [
    d.homeServices === 'line' && all.length ? item('/services', !down, checked.length ? `${checked.length - down} of ${checked.length} services up` : `${all.length} services`) : null,
    vs.home && !vs.homeNumbers && guests.length ? item('/vms', running === guests.length || !vs.stopped, `${running} of ${guests.length} VMs running`) : null,
    d.updates?.available && (d.loggedIn || d.viewer) ? el('a', { href: '/updates' }, HD.icon('circle-arrow-up'), `${d.updates.available} ${d.updates.available === 1 ? 'update' : 'updates'} available`) : null,
  ].filter(Boolean);
  $('home-foot').hidden = !items.length;
  $('home-foot').replaceChildren(...items);
}

function renderVms(d) {
  const vs = d.vms || VM_DEFAULTS;
  const sec = $('vms-sec');
  const groups = [];
  for (const h of vs.home && vs.homeNumbers ? d.proxmox || [] : []) { // otherwise one line at the bottom
    for (const node of [...new Set((h.data?.guests || []).map((g) => g.node))]) {
      if (groups.some((g) => g.node === node)) continue;
      const guests = h.data.guests.filter((g) => g.node === node && (vs.stopped || g.status === 'running'));
      if (guests.length) groups.push({ node, guests });
    }
  }
  sec.hidden = !groups.length;
  if (!groups.length) return;
  const all = groups.flatMap((g) => g.guests);
  $('vms-count').textContent = `${all.filter((g) => g.status === 'running').length} of ${all.length} running`;
  $('vms-more').hidden = false;
  const chip = (x) => {
    const on = x.status === 'running';
    const nums = vs.homeNumbers ? guestNumbers(x, vs) : [];
    return el('span', { class: `chip${on ? '' : ' off'}${nums.length ? ' with-nums' : ''}`, title: [x.name, x.status, ...guestNumbers(x, vs)].filter(Boolean).join(' · ') },
      el('span', { class: `dot ${on ? 'good' : 'off'}` }), x.name || String(x.vmid), nums.length ? el('span', { class: 'chip-nums num', text: nums.join(' · ') }) : null);
  };
  $('vms').replaceChildren(...groups.map((g) => el('a', { class: 'dtile wide', href: '/vms' },
    el('span', { class: 'tile-top' }, el('span', { class: 'tile-icon' }, HD.icon('monitor')), el('span', { class: 'small muted', text: `${g.guests.filter((x) => x.status === 'running').length} of ${g.guests.length} running` })),
    el('span', { class: 'tile-name', text: `On ${g.node}` }),
    el('span', { class: 'chips' }, g.guests.slice(0, 40).map(chip)))));
}

// ---------------------------------------------------------------------------
// The rack

// On a wide screen the chosen device's details stand beside the rack; on smaller ones they open in
// the drawer, as from Home
let rackSel = null;
const rackWide = matchMedia('(min-width: 1100px)');
rackWide.addEventListener('change', () => lastData && currentView() === 'rack' && render(lastData));

// Patching in the rack (signed in): pick two ports; a cable picked shows its colour, label and Remove
let cableEdit = false;
const cableState = { pending: null, color: 'blue', selected: null, error: null };
const sameEnd = (x, y) => x && y && x.item === y.item && x.port === y.port;
const CABLE_NAMES = { blue: 'Blue', yellow: 'Yellow', red: 'Red', green: 'Green', white: 'White', black: 'Black', orange: 'Orange', purple: 'Purple', grey: 'Grey' };

function cableBar(d, save) {
  const sel = cableState.selected && d.cables.find((c) => sameEnd(c.a, cableState.selected.a));
  const swatches = (current, onPick) => el('span', { class: 'cable-swatches', role: 'group', 'aria-label': 'Cable colour' }, Object.entries(Rack.CABLE_HEX).map(([k, hex]) => {
    const b = el('button', { type: 'button', title: CABLE_NAMES[k], 'aria-label': CABLE_NAMES[k], 'aria-pressed': String(current === k), onclick: () => onPick(k) });
    b.style.setProperty('--c', hex);
    return b;
  }));
  if (sel) {
    const label = el('input', { type: 'text', id: 'cable-label', maxlength: 40, placeholder: 'Label (optional)', value: sel.label || '', 'aria-label': 'Cable label' });
    const commit = () => {
      if ((sel.label || '') === label.value.trim()) return;
      label.blur();
      save(d.cables.map((c) => (c === sel ? { ...c, label: label.value.trim() } : c)));
    };
    label.addEventListener('keydown', (e) => e.key === 'Enter' && commit());
    label.addEventListener('blur', commit);
    return el('div', { class: 'cable-bar' },
      el('span', { class: 'hint-text', text: 'This cable:' }),
      swatches(sel.color, (k) => {
        cableState.color = k;
        save(d.cables.map((c) => (c === sel ? { ...c, color: k } : c)));
      }),
      label,
      el('button', { type: 'button', class: 'danger', onclick: () => {
        cableState.selected = null;
        save(d.cables.filter((c) => c !== sel));
      } }, HD.icon('trash'), 'Remove'),
      el('button', { type: 'button', class: 'ghost', text: 'New cable', onclick: () => {
        cableState.selected = null;
        renderRackView(d);
      } }));
  }
  return el('div', { class: 'cable-bar' },
    el('span', { class: 'hint-text', text: cableState.error || (cableState.pending ? 'Now click the port at the other end (or the same port to cancel).' : 'Click a port, then the port it connects to. Click a cable to change or remove it.') }),
    swatches(cableState.color, (k) => {
      cableState.color = k;
      renderRackView(d);
    }));
}

function renderRackView(d) {
  const rack = d.rack;
  const box = $('rack-view');
  if (!rack?.enabled) return box.replaceChildren(el('p', { class: 'empty', text: 'The rack is turned off in Admin.' }));
  const inner = el('div', { class: 'rack-view' });
  const inRack = rack.items.filter(Rack.inRack).length;
  const placed = infos.filter((x) => x.dev.location === 'rack' || x.dev.location === 'outside');
  if (!placed.some((x) => x.id === rackSel)) rackSel = (placed.find((x) => x.state[1] === 'critical') || placed.find((x) => x.dev.location === 'rack') || placed[0])?.id || null;
  const side = rackWide.matches ? infos.find((x) => x.id === rackSel) : null;
  const pick = (id) => {
    if (!rackWide.matches) return openDevice(id);
    rackSel = id;
    renderRackView(lastData);
    HD.fillSparks();
  };
  if (document.activeElement?.matches?.('.cable-bar input')) return; // not while the label is being typed
  if (!d.loggedIn) cableEdit = false;
  const cables = d.cables || [];
  const saveCables = async (list) => {
    try {
      const r = await HD.api('PUT', '/api/admin/cables', { cables: list });
      d.cables = r.cables;
      cableState.selected = cableState.selected ? r.cables.find((c) => sameEnd(c.a, cableState.selected.a)) || null : null;
    } catch (e) {
      cableState.error = e.message;
    }
    renderRackView(d);
  };
  const draw = () => Rack.render(inner, rack, d, {
    onSelect: (item) => pick(item.id),
    selectedId: side ? rackSel : null,
    mode: cableEdit ? 'realistic' : undefined, // the schematic has no ports to patch
    cables,
    cablesShow: Rack.cablesShown(),
    cableEdit,
    cableState,
    onCablesChange: (list) => {
      cableState.selected = list[list.length - 1];
      saveCables(list);
    },
    onCableSelect: (c) => {
      cableState.selected = c;
      cableState.pending = null;
      renderRackView(d);
    },
  });
  const tools = rack.items.length ? el('span', { class: 'rack-head-tools' },
    cableEdit ? null : Rack.modeToggle(() => renderRackView(d)),
    cables.length && !cableEdit ? Rack.cablesToggle(draw) : null,
    d.loggedIn ? el('button', { type: 'button', class: `cable-toggle${cableEdit ? ' primary' : ''}`, 'aria-pressed': String(cableEdit), title: 'Add, recolour or remove patch cables', onclick: () => {
      cableEdit = !cableEdit;
      Object.assign(cableState, { pending: null, selected: null, error: null });
      renderRackView(d);
    } }, HD.icon(cableEdit ? 'check' : 'pencil'), el('span', { text: cableEdit ? 'Done' : 'Patch' })) : null) : el('span', { class: 'small muted', text: 'Add equipment in Admin' });
  box.replaceChildren(el('div', { class: `rack-page${side ? ' with-detail' : ''}` },
    el('div', { class: 'card rack-card' },
      el('div', { class: 'rack-head' }, el('span', { class: 'muted', text: `${rack.units} U, ${inRack} device${inRack === 1 ? '' : 's'}` }), tools),
      cableEdit ? cableBar(d, saveCables) : null,
      inner),
    side ? el('aside', { class: 'card rack-detail', 'aria-label': `${side.dev.name} details` }, deviceDetail(side)) : null));
  draw();
}

// ---------------------------------------------------------------------------
// Customize: drag tiles into another order, hide the ones you don't need on Home

let editing = false;
let savedLayout = null;

function loadLayout(layout) {
  tileHidden.clear();
  tileOrder = [];
  if (!layout) return;
  for (const id of layout.hidden || []) if (id.startsWith('device:')) tileHidden.add(id.slice(7));
  const items = [...(layout.items || [])];
  if (layout.v !== 3) items.sort((a, b) => a.y - b.y || a.x - b.x); // the old grid: top to bottom, left to right
  tileOrder = items.map((i) => i.id).filter((id) => id.startsWith('device:')).map((id) => id.slice(7));
}

function startEdit() {
  editing = true;
  savedLayout = { order: [...tileOrder], hidden: new Set(tileHidden) };
  tileOrder = orderedInfos().map((x) => x.id);
  render(lastData);
}

function stopEdit(cancel) {
  if (cancel && savedLayout) {
    tileOrder = savedLayout.order;
    tileHidden.clear();
    for (const id of savedLayout.hidden) tileHidden.add(id);
  }
  editing = false;
  render(lastData);
}

function renderEditBar() {
  const bar = $('edit-bar');
  bar.hidden = !editing;
  if (!editing) return bar.replaceChildren();
  const msg = el('span', { class: 'msg', role: 'status' });
  bar.replaceChildren(
    el('p', { class: 'hint', text: 'Drag tiles to change their order. The eye hides a tile from Home (it stays in the rack and in search).' }),
    el('button', { type: 'button', text: 'Reset', onclick: () => { tileOrder = []; tileHidden.clear(); tileOrder = orderedInfos().map((x) => x.id); renderDevices(); } }),
    el('button', { type: 'button', text: 'Cancel', onclick: () => stopEdit(true) }),
    el('button', {
      type: 'button',
      class: 'primary',
      text: 'Save',
      onclick: async () => {
        try {
          await HD.api('PUT', '/api/admin/layout', { v: 3, items: tileOrder.map((id) => ({ id: `device:${id}` })), hidden: [...tileHidden].map((id) => `device:${id}`) });
          stopEdit(false);
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      },
    }),
    msg);
}

function dragTile(e, tile) {
  HD.dragMove(e, tile, {
    placeholderClass: 'tile-slot',
    place: (x, y, ph) => {
      const grid = ph.parentElement;
      const over = [...grid.children].find((c) => {
        if (c === ph) return false;
        const r = c.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!over) return;
      const r = over.getBoundingClientRect();
      if (x < r.left + r.width / 2) over.before(ph);
      else over.after(ph);
    },
    done: () => {
      const shown = [...document.querySelectorAll('#devices .dtile[data-id]')].map((t) => t.dataset.id);
      tileOrder = [...shown, ...tileOrder.filter((id) => !shown.includes(id))];
    },
  });
}

// ---------------------------------------------------------------------------
// Page

function currentView() {
  return location.hash === '#rack' ? 'rack' : 'home';
}

function renderHeader(d) {
  const view = currentView();
  HD.shell({ active: view === 'rack' ? 'rack' : 'overview', title: d.title, admin: d.loggedIn, viewer: d.viewer, updates: d.updates?.available || 0, rack: Boolean(d.rack?.enabled) });
  $('page-title').textContent = view === 'rack' ? 'Rack' : d.title;
  $('nav').replaceChildren(...[
    d.loggedIn && view === 'home' && infos.length ? HD.iconButton('sliders-horizontal', 'Customize', { id: 'customize', disabled: editing, onclick: startEdit }) : null,
    HD.iconButton('tv', 'Wall display', { href: '/wall', class: 'ghost' }),
  ].filter(Boolean));
}

function render(d) {
  document.title = currentView() === 'rack' ? `Rack · ${d.title}` : d.title;
  attention = d.attention || [];
  infos = deviceInfos(d);
  renderHeader(d);
  const view = currentView();
  $('view-home').hidden = view !== 'home';
  $('rack-view').hidden = view !== 'rack';
  $('view-home').classList.toggle('editing', editing);
  renderEditBar();
  renderSummary(d);
  renderNeeds(d);
  $('hero').replaceChildren(...[powerTile(d.power), internetTile(d)].filter(Boolean));
  renderDevices();
  renderServicesSec(servicesData, d.homeServices);
  renderVms(d);
  renderFoot(d);
  if (view === 'rack') renderRackView(d);
  refreshDrawer();
  HD.fillSparks();
  pruneFans();
  const noHosts = ['idrac', 'proxmox', 'truenas', 'synology', 'unifi', 'snmp', 'nut', 'omada', 'ping', 'shelly', 'tasmota', 'hass', 'docker', 'portainer'].every((k) => !(d[k] || []).length);
  $('empty-hint').classList.toggle('hidden', !noHosts);
  $('empty-hint').replaceChildren('Nothing is monitored yet. ', d.loggedIn ? el('a', { href: '/admin#devices', text: 'Add your first device in Admin' }) : '');
}

// Search results link to /#device-<id>; the rack is /#rack
function jumpToHash() {
  const m = /^#device-([0-9a-f-]{36})$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    openDevice(m[1]);
  }
}
window.addEventListener('hashchange', () => {
  if (lastData) render(lastData);
  jumpToHash();
  scrollTo(0, 0);
  if (lastData && Date.now() - lastData.generatedAt > 5000) refresh(); // the other view may need newer data
});

// tiles light up where the pointer is
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest?.('.dtile, .big');
  if (!t) return;
  const r = t.getBoundingClientRect();
  t.style.setProperty('--mx', `${e.clientX - r.left}px`);
  t.style.setProperty('--my', `${e.clientY - r.top}px`);
});

function tickUpdated() {
  $('updated').textContent = lastData ? `Updated ${fmt.ago(lastData.generatedAt)}` : '';
}

let layoutLoaded = false;
async function refresh() {
  clearTimeout(refreshTimer);
  // a tab in the background waits; it refreshes as soon as it is shown again
  if (document.hidden && lastData) return;
  let delay = 30;
  try {
    const [r] = await Promise.all([fetch('/api/dashboard', { credentials: 'same-origin', cache: 'no-store' }), loadServices()]);
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lastData = await r.json();
    lastData.rack.items = lastData.devices; // the server sends the devices once
    delay = lastData.refreshSeconds;
    if (!layoutLoaded) {
      loadLayout(lastData.layout);
      layoutLoaded = true;
    }
    $('global-error').classList.add('hidden');
    if (!editing || !document.querySelector('.drag-ghost')) render(lastData);
    jumpToHash();
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
  if (editing) e.preventDefault();
});
reduceMotion.addEventListener('change', () => lastData && render(lastData));
setInterval(tickUpdated, 5000);
refresh();
