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

const STATUS_RANK = { '': 0, good: 1, warning: 2, serious: 3, critical: 4 };
const statusOf = (node) => ['critical', 'serious', 'warning', 'good'].find((c) => node?.classList.contains(c)) || '';

function sectionNode(sec, titled) {
  const h = sec.h;
  const node = el('section', { class: 'device-section' });
  if (titled) node.append(el('div', { class: 'section-head' }, el('h4', { text: sec.title || sec.type }), sec.statusNode));
  if (h.error) node.append(el('p', { class: 'banner', role: 'alert' }, h.error, h.data ? ` · showing data from ${fmt.ago(h.lastOkAt)}` : ''));
  if (h.ok === null && !h.data) node.append(el('p', { class: 'empty', text: 'Waiting for first update…' }));
  if (h.data) node.append(el('div', { class: `body${h.error ? ' stale' : ''}` }, sec.bodyFn(h.data)));
  return node;
}

// A device card: name, type and worst status, then one section per connection.
function deviceCard(dev, sections) {
  const worst = sections.reduce((a, x) => (STATUS_RANK[statusOf(x.statusNode)] > STATUS_RANK[statusOf(a)] ? x.statusNode : a), null);
  const single = sections.length === 1;
  const head = single ? sections[0].statusNode : worst ? status(statusOf(worst) === 'good' ? 'OK' : statusOf(worst) === 'critical' ? 'Problems' : 'Warnings', statusOf(worst)) : null;
  const sub = sections.map((x) => x.sub).find(Boolean) || '';
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'title' }, el('div', { class: 'card-type', text: Rack.KIND_LABELS[dev.kind] || dev.kind }), el('h3', { text: dev.name }), sub ? el('div', { class: 'sub', text: sub }) : null),
      head),
    sections.map((x) => sectionNode(x, !single)));
}

function kv(pairs) {
  return el('div', { class: 'kv' }, pairs.map(([k, v]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }))));
}

// History graphs: [key, label, unit, decimals] (null entries are skipped)
function sparks(list) {
  const cells = list.filter(Boolean).map(([key, label, unit, decimals = 0]) => HD.sparkSlot(key, { label, unit, decimals }));
  return cells.length ? el('div', { class: 'sparks' }, cells) : null;
}

// ---------------------------------------------------------------------------
// iDRAC

function renderIdrac(hosts) {
  return hosts.map((h) => {
    const d = h.data;
    const sub = d ? [d.model, d.serviceTag && `Service tag ${d.serviceTag}`].filter(Boolean).join(' · ') : '';
    const st = d ? status(d.health || 'unknown') : status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const card = hostCard('iDRAC', h, sub, st, (d) => {
      const parts = [kv([
        ['Power draw', d.watts != null ? `${fmt.n(d.watts)} W` : '–'],
        ['Power state', d.powerState || '–'],
        ['PSUs', `${d.psus.length}`],
        ['Fans', `${d.fans.length}`],
      ]), sparks([
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

function renderProxmox(hosts, showStopped, nodeFor = () => null) {
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
      const guests = d.guests.filter((g) => showStopped || g.status === 'running');
      const guestRows = guests.map((g) => el('tr', null,
        el('td', { class: 'r', text: g.vmid }),
        el('td', { text: g.name }),
        el('td', { text: g.type === 'lxc' ? 'CT' : 'VM' }),
        el('td', { text: g.node }),
        el('td', null, status(g.status, g.status === 'stopped' ? '' : undefined)),
        el('td', { class: 'r', text: g.status === 'running' ? fmt.pct(g.cpu, 1) : '–' }),
        el('td', { class: 'r', text: g.status === 'running' ? `${fmt.bytes(g.mem)} / ${fmt.bytes(g.maxmem)}` : fmt.bytes(g.maxmem) }),
        el('td', { class: 'r', text: g.status === 'running' ? fmt.uptime(g.uptime) : '–' })));
      return [
        el('h4', { text: 'Nodes' }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Node', 'Status', 'CPU', 'Memory', 'Root disk'].map((t) => el('th', { text: t })), el('th', { class: 'r', text: 'Uptime' }))),
          el('tbody', null, nodeRows))),
        d.nodes.filter((n) => n.status === 'online').map((n) => sparks([
          [`pve:${h0.id}:${n.name}:cpu`, d.nodes.length > 1 ? `${n.name} CPU` : 'CPU', ' %'],
          [`pve:${h0.id}:${n.name}:mem`, d.nodes.length > 1 ? `${n.name} memory` : 'Memory', ' %'],
        ])),
        el('h4', { text: showStopped ? 'VMs & containers' : 'Running VMs & containers' }),
        guests.length
          ? el('div', { class: 'table-wrap' }, el('table', null,
            el('thead', null, el('tr', null, el('th', { class: 'r', text: 'ID' }), ['Name', 'Type', 'Node', 'Status'].map((t) => el('th', { text: t })), ['CPU', 'Memory', 'Uptime'].map((t) => el('th', { class: 'r', text: t })))),
            el('tbody', null, guestRows)))
          : el('p', { class: 'empty', text: 'No guests' }),
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
      const s = d.system;
      return [
        kv([
          ['Model', s.model || '–'],
          ['CPU cores', s.cores != null ? String(s.cores) : '–'],
          ['Memory', fmt.bytes(s.memory)],
          ['Uptime', fmt.uptime(s.uptime)],
          ['Load (1/5/15)', s.loadavg ? s.loadavg.map((l) => fmt.n(l, 2)).join(' / ') : '–'],
        ]),
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
            el('div', { text: a.text }))))
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
        kv([
          ['Temperature', s.temp != null ? `${s.temp} °C` : '–'],
          ['CPU', s.cpu != null ? fmt.pct(s.cpu) : '–'],
          ['Memory', memF != null ? `${fmt.pct(memF)} of ${fmt.bytes(s.memTotal)}` : '–'],
          ['Uptime', fmt.uptime(s.uptime)],
        ]),
        sparks([
          s.temp != null ? [`syno:${h.id}:temp`, 'Temperature', ' °C'] : null,
          s.cpu != null ? [`syno:${h.id}:cpu`, 'CPU', ' %'] : null,
          memF != null ? [`syno:${h.id}:mem`, 'Memory', ' %'] : null,
        ]),
        el('div', { class: 'status-line' },
          status(`System ${s.status || 'unknown'}`, s.status === 'Normal' ? 'good' : s.status ? 'critical' : ''),
          status(`Fans ${[s.systemFan, s.cpuFan].includes('Failed') ? 'failed' : s.systemFan ? 'normal' : 'unknown'}`, [s.systemFan, s.cpuFan].includes('Failed') ? 'critical' : s.systemFan ? 'good' : ''),
          status(`Power ${s.powerStatus || 'unknown'}`, s.powerStatus === 'Normal' ? 'good' : s.powerStatus ? 'critical' : ''),
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
    let st;
    if (d) {
      const offline = d.devices.filter((x) => !x.online).length;
      st = status(offline ? `${offline} offline` : 'All online', offline ? 'critical' : 'good');
    } else st = status(h.ok === false ? 'unreachable' : 'pending', h.ok === false ? 'critical' : '');
    const sub = d ? `${d.devices.length} device${d.devices.length === 1 ? '' : 's'}${d.health ? ` · ${d.health.clients} clients` : ''}` : '';
    const card = hostCard('UniFi', h, sub, st, (d) => {
      const hl = d.health;
      const parts = [];
      if (hl) {
        parts.push(kv([
          ['WAN', hl.wan ? `${hl.wan.status === 'ok' ? 'Up' : hl.wan.status}${hl.wan.ip ? ` · ${hl.wan.ip}` : ''}` : '–'],
          ['Internet latency', hl.internet?.latencyMs != null ? `${hl.internet.latencyMs} ms` : '–'],
          ['Speed test ↓/↑', hl.internet?.downMbps != null ? `${fmt.n(hl.internet.downMbps)} / ${fmt.n(hl.internet.upMbps)} Mbps` : '–'],
          ['Clients (Wi-Fi / wired)', `${hl.wifiClients ?? '–'} / ${hl.wiredClients ?? '–'}`],
        ]));
      }
      const maxTemp = (x) => (x.temps.length ? Math.max(...x.temps.map((t) => t.value)) : null);
      parts.push(el('h4', { text: 'Devices' }));
      parts.push(el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Device', 'Model', 'Status'].map((t) => el('th', { text: t })), ['CPU', 'Memory', 'Temp', 'Clients', 'PoE', 'Uptime'].map((t) => el('th', { class: 'r', text: t })))),
        el('tbody', null, d.devices.map((x) => el('tr', null,
          el('td', { text: x.name }),
          el('td', { class: 'small', text: x.model || '–' }),
          el('td', null, status(x.state, x.online ? 'good' : 'critical'), x.upgradable ? el('div', { class: 'small muted', text: 'Update available' }) : null),
          el('td', { class: 'r', text: x.cpu != null ? fmt.pct(x.cpu) : '–' }),
          el('td', { class: 'r', text: x.mem != null ? fmt.pct(x.mem) : '–' }),
          el('td', { class: 'r', text: maxTemp(x) != null ? `${fmt.n(maxTemp(x))} °C` : '–', title: x.temps.map((t) => `${t.name}: ${t.value} °C`).join(', ') || null }),
          el('td', { class: 'r', text: x.clients != null ? String(x.clients) : '–' }),
          el('td', { class: 'r', text: x.poe ? `${fmt.n(x.poe.usedW, 1)}${x.poe.budgetW ? ` / ${fmt.n(x.poe.budgetW)}` : ''} W` : '–' }),
          el('td', { class: 'r', text: x.online ? fmt.uptime(x.uptime) : '–' })))))));
      const poePorts = d.devices.flatMap((x) => x.ports.filter((p) => p.poeW > 0).map((p) => ({ dev: x.name, ...p })));
      if (poePorts.length) {
        parts.push(el('h4', { text: 'PoE consumers' }));
        parts.push(el('div', null, poePorts.map((p) => el('div', { class: 'meter-row' },
          el('span', { class: 'label', text: `${p.dev} · ${p.name}` }),
          meter(p.poeW / 30),
          el('span', { class: 'value', text: `${fmt.n(p.poeW, 1)} W` })))));
      }
      return parts;
    });
    return [h.id, { ...card, title: 'UniFi network' }];
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
      const up = x.ports.filter((p) => p.up).length;
      const parts = [kv([
        ['Uptime', x.online ? fmt.uptime(x.uptime) : '–'],
        ['CPU / memory', x.cpu != null ? `${fmt.pct(x.cpu)} / ${fmt.pct(x.mem)}` : '–'],
        ['Temperature', maxTemp(x) != null ? `${fmt.n(maxTemp(x))} °C` : '–'],
        ['Clients', x.clients != null ? String(x.clients) : '–'],
        ...(x.ports.length ? [['Ports up', `${up} of ${x.ports.length}`]] : []),
        ...(x.poe ? [['PoE', `${fmt.n(x.poe.usedW, 1)}${x.poe.budgetW ? ` of ${fmt.n(x.poe.budgetW)}` : ''} W`]] : []),
      ])];
      const k = `unifi:${consoleHost.id}:${x.mac}`;
      if (x.online) parts.push(sparks([
        x.cpu != null ? [`${k}:cpu`, 'CPU', ' %'] : null,
        maxTemp(x) != null ? [`${k}:temp`, 'Temperature', ' °C'] : null,
        x.clients != null ? [`${k}:clients`, 'Clients', ''] : null,
        x.poe ? [`${k}:poe`, 'PoE draw', ' W', 1] : null,
      ]));
      if (x.upgradable) parts.push(el('div', { class: 'status-line' }, status('Firmware update available', 'warning')));
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
    ...renderProxmox(d.proxmox, d.showStoppedGuests, (id) => nodeFor.get(id)),
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
        secs.splice(secs.findIndex((x) => x.title === 'UniFi network') + 1 || secs.length, 0, unifiDeviceSection(ud, host));
      }
      const wide = dev.connections.some((c) => c.type === 'proxmox' || c.type === 'unifi');
      return { id: `device:${dev.id}`, title: dev.name, w: wide ? 12 : 6, h: 18, node: deviceCard(dev, secs) };
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
  const title = el('div', { class: 'card-head' },
    el('div', { class: 'title' }, el('div', { class: 'card-type', text: 'Rack' }), el('h3', { text: `${rack.units} U` })),
    rack.items.length ? null : el('span', { class: 'small muted', text: 'Add equipment in Admin' }));
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

function renderDailyChart(days) {
  const wrap = el('div', { class: 'chart' });
  const tip = el('div', { class: 'tooltip hidden', role: 'status' });
  const draw = () => {
    const W = Math.max(wrap.clientWidth || 600, 280);
    const H = 170;
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

function tile(label, value, detail) {
  return el('div', { class: 'tile' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), detail ? el('div', { class: 'detail', text: detail }) : null);
}

function renderPowerSummary(p, idracCount) {
  const plan = p.plan === 'norgespris' ? 'Norgespris' : `Spot price ${p.area}`;
  const pn = p.priceNow;
  const est = p.estimate;
  const u = p.usage;
  const m = p.measured;
  const breakdown = [
    m.idrac != null ? `iDRAC ${fmt.n(m.idrac)} W` : null,
    m.poe != null ? `PoE ${fmt.n(m.poe, 1)} W` : null,
    p.estimatedW > 0 ? `estimated ${fmt.n(p.estimatedW)} W${p.includeEstimates ? '' : ' (not in cost)'}` : null,
  ].filter(Boolean).join(' · ');
  const left = el('div', { class: 'hero' },
    el('div', { class: 'label', text: p.includeEstimates && p.estimatedW > 0 ? 'Current draw (measured + estimated)' : 'Current draw (measured)' }),
    el('div', { class: 'value' }, p.watts != null ? fmt.n(p.watts) : '–', el('small', { text: 'W' })),
    el('div', { class: 'muted small', text: breakdown || (idracCount ? '' : 'Add an iDRAC host to measure power') }),
    el('div', { class: 'muted small', text: `${plan}${p.vat ? ' · incl. VAT' : ''}` }),
    p.watts != null ? sparks([['power:total', 'Measured draw', ' W']]) : null);
  const tiles = el('div', { class: 'tiles' },
    tile('Price now', pn ? `${fmt.n(pn.total, 1)} øre/kWh` : '–', pn ? `Energy ${fmt.n(pn.energy, 1)} + grid ${fmt.n(pn.grid, 1)} (${pn.period})` : p.plan === 'spot' ? 'Spot price unavailable' : ''),
    tile('Estimated per day', est ? fmt.kr(est.day) : '–', est ? `${fmt.n(est.kwhDay, 1)} kWh at current draw` : ''),
    tile('Estimated per month', est ? fmt.kr(est.month, 0) : '–', est ? `${fmt.n(est.kwhDay * 30.4375, 0)} kWh` : ''),
    tile('Estimated per year', est ? fmt.kr(est.year, 0) : '–', est ? `${fmt.n(est.kwhDay * 365, 0)} kWh` : ''),
    tile('Logged today', `${fmt.n(u.today.kwh, 2)} kWh`, fmt.kr(u.today.cost)),
    tile('Logged this month', `${fmt.n(u.month.kwh, 1)} kWh`, fmt.kr(u.month.cost)),
    tile('Logged this year', `${fmt.n(u.year.kwh, 0)} kWh`, fmt.kr(u.year.cost, 0)));
  const notes = [];
  if (p.fixed.monthlyKr > 0)
    notes.push(p.fixed.included ? `Costs include fixed fees of ${fmt.kr(p.fixed.monthlyKr, 0)}/month.` : `Fixed fees (${fmt.kr(p.fixed.monthlyKr, 0)}/month) are not included.`);
  notes.push('Estimates use today’s prices and the current draw; logged values integrate actual readings.');
  return el('article', { class: 'card' },
    el('div', { class: 'card-type', text: 'Power & cost' }),
    el('div', { class: 'power-grid' }, left, tiles),
    el('p', { class: 'hint', text: notes.join(' ') }));
}

function renderPowerChart(p) {
  const u = p.usage;
  const notes = [];
  if (u.since) notes.push(`Logging since ${fmt.time(u.since)}.`);
  if (u.year.unpricedKwh > 0.01) notes.push(`${fmt.n(u.year.unpricedKwh, 2)} kWh this year was logged while no price was available and is not included in cost.`);
  return el('article', { class: 'card' },
    el('div', { class: 'card-type', text: 'Daily energy use, last 30 days (kWh)' }),
    renderDailyChart(u.days),
    el('details', { class: 'table-view' },
      el('summary', { text: 'Show as table' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Date' }), el('th', { class: 'r', text: 'kWh' }), el('th', { class: 'r', text: 'Cost' }))),
        el('tbody', null, u.days.slice().reverse().map((d) => el('tr', null, el('td', { text: d.date }), el('td', { class: 'r', text: fmt.n(d.kwh, 2) }), el('td', { class: 'r', text: fmt.kr(d.cost) }))))))),
    notes.length ? el('p', { class: 'hint', text: notes.join(' ') }) : null);
}

// ---------------------------------------------------------------------------
// Board & customize mode

const board = new GridLayout.Board($('grid'), { onEditChange: () => renderEditBar() });
let layoutLoaded = false;

function renderNav(d) {
  $('view-tabs').replaceChildren(...HD.viewTabs('overview', d.loggedIn));
  if (!$('range').firstChild) $('range').append(HD.rangeTabs());
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
  const defs = [
    { id: 'power-summary', title: 'Power & cost', w: 12, h: 8, node: renderPowerSummary(d.power, d.idrac.length) },
    { id: 'power-chart', title: 'Energy use, 30 days', w: 12, h: 9, node: renderPowerChart(d.power) },
    ...renderDevices(d),
  ];
  board.render(defs);
  HD.fillSparks();
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
