'use strict';
// Wall display: one screen for a tablet or TV, read from across the room. A layout is a grid of
// panels (Needs you one problem at a time, power, the internet, the rack, climate, a clock, a graph,
// a note …) with the services along the bottom. Each screen can have its own layout:
// /wall?layout=kitchen (plain /wall is the default one). Customize, signed in, makes the wall
// itself editable: drag a panel to move it, drag its corner to resize it, its gear for its options.
// Same data and access as the Home page; tapping something opens it there.

const { el, svg, fmt } = HD;
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ISSUE_ICONS = { critical: 'octagon-alert', warning: 'triangle-alert', serious: 'triangle-alert' };
const SLUG = (/^[a-z0-9][a-z0-9-]{0,29}$/.exec(new URLSearchParams(location.search).get('layout') || '') || ['default'])[0];

let data = null;
let services = null;
let history = {}; // "range|key" -> points
let spotIndex = 0;
let spotTimer = null;
let refreshTimer = null;
let edit = null; // while customizing: { layout (the draft, shown live), slug, dirty }
const panelNodes = new Map(); // uid -> its section, kept between renders

const TYPES = {
  spot: ['Needs you', 'triangle-alert'], list: ['All problems', 'list'], power: ['Power now', 'zap'], net: ['Internet', 'globe'], rack: ['Rack', 'server'],
  devices: ['Devices', 'server'], claude: ['Claude', 'sparkles'], climate: ['Climate', 'thermometer'],
  clock: ['Clock', 'clock'], device: ['A device', 'server'], service: ['A service', 'globe'], graph: ['A graph', 'chart-column'], note: ['A note', 'file-text'],
};
const SINGLE = ['spot', 'list', 'power', 'net', 'rack', 'devices', 'claude', 'climate'];
// a panel there can only be one of keeps the id it always had (links and tests use them)
const IDS = { spot: 'spot', list: 'list', power: 'power', net: 'net', rack: 'rack', devices: 'devs', claude: 'claude', climate: 'climate' };
// the panels a new install starts with (as the server's defaultWallLayout)
const FACTORY = [
  { uid: 'spot', type: 'spot', w: 1, h: 1, title: null, opts: { seconds: 8 } },
  { uid: 'power', type: 'power', w: 1, h: 1, title: null, opts: { range: '24h', show: ['chart', 'today', 'month', 'price'] } },
  { uid: 'rack', type: 'rack', w: 1, h: 2, title: null, opts: { cables: false } },
  { uid: 'list', type: 'list', w: 1, h: 1, title: null, opts: {} },
  { uid: 'net', type: 'net', w: 1, h: 1, title: null, opts: { range: '24h', show: ['chart', 'now', 'clients', 'wifi'] } },
];
const DEFAULT = { slug: 'default', name: 'Default', cols: 3, rows: 0, scale: 100, gap: 'normal', top: { logo: true, clock: true, vmCount: true }, services: { show: true, list: null }, panels: [] };
const layout = () => edit?.layout || data?.walls?.find((l) => l.slug === SLUG) || data?.wall || DEFAULT;

async function getJson(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) {
    location.href = '/login?next=wall';
    throw new Error('Login required');
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function sinceText(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(h / 24)} d`;
}

// An area chart that fills its box; the line keeps its width when the box is stretched
let chartSeq = 0;
function areaChart(points, points2 = null, zero = false) {
  if (!points || points.length < 2) return el('p', { class: 'small muted', text: 'Collecting history…' });
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  const vs2 = points2?.length > 1 ? points2.map((p) => p[1]) : [];
  let lo = Math.min(...vs, ...vs2);
  let hi = Math.max(...vs, ...vs2);
  const pad = (hi - lo) * 0.25 || 1;
  lo = zero ? 0 : Math.max(0, lo - pad);
  hi += pad;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  // a smooth line, each step leaving and arriving level, over an area that fades out downwards
  const smooth = (list) => list.map(([px, py], i) => {
    if (!i) return `M${px.toFixed(2)},${py.toFixed(2)}`;
    const mx = ((list[i - 1][0] + px) / 2).toFixed(2);
    return `C${mx},${list[i - 1][1].toFixed(2)} ${mx},${py.toFixed(2)} ${px.toFixed(2)},${py.toFixed(2)}`;
  }).join('');
  const line = smooth(points.map(([t, v]) => [x(t), y(v)]));
  const line2 = vs2.length ? smooth(points2.filter(([t]) => t >= t0).map(([t, v]) => [x(t), y(v)])) : null;
  const id = `wg${++chartSeq}`;
  const stops = [svg('stop', { offset: 0 }), svg('stop', { offset: 1 })];
  stops.forEach((st, i) => { st.style.stopColor = 'var(--line-c, var(--accent))'; st.style.stopOpacity = i ? '0' : '0.35'; });
  const area = svg('path', { class: 'c-area', d: `${line}L100,100L0,100Z` });
  area.style.fill = `url(#${id})`;
  return svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('defs', null, svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, ...stops)),
    area, svg('path', { class: 'c-glow', d: line }), svg('path', { class: 'c-line', d: line }),
    line2 ? svg('path', { class: 'c-line2', d: line2 }) : null);
}

function trio(items) {
  return el('div', { class: 'trio' }, items.filter(Boolean).map(([label, v, unit]) => el('div', null, el('span', { text: label }), el('b', null, v, unit ? el('small', { text: unit }) : null))));
}
// a panel's label row: its own title (or the usual one; none when blanked), with something on the right
function head(p, right = null) {
  if (p.title === '') return null;
  const [name, icon] = TYPES[p.type];
  return el('div', { class: 'lbl' }, HD.icon(icon), p.title || name, right !== null ? el('span', { class: 'r' }, right) : null);
}
const hist = (range, key) => history[`${range}|${key}`];

// --- header ---
function renderHead(d) {
  const L = layout();
  const list = (d.attention || []).filter((a) => !a.snoozedUntil && !a.maintenance && !a.behind); // snoozed ones, maintenance and what's behind an outage stay off the wall
  const crit = list.filter((a) => a.severity === 'critical').length;
  const warn = list.length - crit;
  $('orb').className = `orb ${crit ? 'critical' : warn ? 'warning' : ''}`;
  $('headline').textContent = list.length
    ? [crit ? `${crit} ${crit === 1 ? 'fault' : 'faults'}` : null, warn ? `${warn} to watch` : null].filter(Boolean).join(', ')
    : 'All systems normal';
  document.title = `${$('headline').textContent} · ${d.title}`;
  const guests = d.vms?.home === false || !L.top.vmCount ? [] : (d.proxmox || []).flatMap((h) => h.data?.guests || []);
  const seen = new Set();
  const vms = guests.filter((g) => !seen.has(`${g.node}:${g.vmid}`) && seen.add(`${g.node}:${g.vmid}`));
  $('wall-sub').textContent = [
    L.top.logo === false ? d.title : null, // otherwise it stands beside the clock
    `updated ${fmt.ago(d.generatedAt)}`,
    vms.length ? `${vms.filter((g) => g.status === 'running').length} of ${vms.length} VMs running` : null,
    d.updates?.available ? `${d.updates.available} update${d.updates.available === 1 ? '' : 's'}` : null,
    ...(d.notices || []).map((n) => `${n.title}: ${n.detail}`), // until an admin closes it on Home
  ].filter(Boolean).join(' · ');
}

function tick() {
  const now = new Date();
  $('clock-time').textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('clock-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  for (const n of document.querySelectorAll('.w.clock-panel')) drawClock(n, n._panel);
  if (data) $('wall-sub').textContent = $('wall-sub').textContent.replace(/updated [^·]+/, `updated ${fmt.ago(data.generatedAt)} `).replace(/ {2}/g, ' ');
}

// --- the panels: each draws into its own section ---
const problems = () => (data.attention || []).filter((a) => !a.snoozedUntil && !a.maintenance && !a.behind);

// what needs you, one at a time
function drawSpot(box, p) {
  const list = problems();
  clearTimeout(spotTimer);
  if (!list.length) {
    box.className = 'w spot';
    box.onclick = null;
    box.replaceChildren(...[p.title === '' ? null : el('div', { class: 'lbl' }, HD.icon('circle-check'), p.title || 'Needs you'),
      el('div', { class: 'fade' }, el('h2', { text: 'Nothing needs you' }), el('p', { text: 'Every device and service answers, and nothing is near a limit.' }))].filter(Boolean));
    return;
  }
  spotIndex %= list.length;
  const a = list[spotIndex];
  box.className = `w spot ${a.severity}`;
  box.onclick = () => (location.href = a.deviceId ? `/#device-${a.deviceId}` : a.serviceId ? '/services' : '/');
  box.replaceChildren(...[
    head(p, `${spotIndex + 1} / ${list.length}`),
    el('div', { class: 'fade' },
      el('div', { class: 'spot-who' }, HD.icon(ISSUE_ICONS[a.severity] || 'info'), [a.subject, a.since ? `since ${new Date(a.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : null].filter(Boolean).join(' · ')),
      el('h2', { text: a.text }),
      a.detail ? el('p', { text: a.detail.length > 220 ? `${a.detail.slice(0, 220)}…` : a.detail }) : null),
    list.length > 1 ? el('div', { class: 'prog' }, list.map((_, k) => el('i', { class: k < spotIndex ? 'done' : k === spotIndex ? 'now' : null }))) : null].filter(Boolean));
  box.style.setProperty('--spot-s', `${p.opts.seconds}s`);
  document.querySelectorAll('.probs li').forEach((li, k) => li.classList.toggle('on', k === spotIndex));
  if (list.length > 1 && !box.matches(':hover') && !edit) spotTimer = setTimeout(() => {
    spotIndex = (spotIndex + 1) % list.length;
    drawSpot(box, p);
  }, p.opts.seconds * 1000);
}

function drawList(box, p) {
  const list = problems();
  const spot = document.querySelector('.w.spot');
  box.replaceChildren(...[head(p, String(list.length)), el('ul', { class: 'probs', id: 'probs' }, list.length
    ? list.map((a, k) => el('li', { onclick: () => { spotIndex = k; if (spot) drawSpot(spot, spot._panel); } },
      el('span', { class: `dot ${a.severity === 'critical' ? 'critical' : 'warning'}` }),
      el('b', null, a.subject ? `${a.subject} ` : '', el('span', { text: a.text })),
      el('time', { text: a.since ? `${sinceText(a.since)}` : '' })))
    : [el('li', null, el('span', { class: 'dot good' }), el('b', { text: 'No problems' }), el('time'))])].filter(Boolean));
}

function drawPower(box, p) {
  const pw = data.power;
  const u = pw.usage;
  const show = new Set(p.opts.show);
  box.onclick = () => (location.href = '/energy');
  box.replaceChildren(...[
    head(p, [pw.measured.total != null ? `${fmt.n(pw.measured.total)} W measured` : null, pw.estimatedW > 0 ? `${fmt.n(pw.estimatedW)} W estimated` : null].filter(Boolean).join(' · ')),
    el('div', { class: 'huge' }, pw.watts != null ? fmt.n(pw.watts) : '–', el('small', { text: 'W' })),
    el('div', { class: 'wall-chart' }, show.has('chart') ? areaChart(hist(p.opts.range, 'power:total')) : null),
    trio([show.has('today') ? ['Today', fmt.n(u.today.cost, 2), fmt.money()] : null, show.has('month') ? ['This month', fmt.n(u.month.cost, 0), fmt.money()] : null, show.has('price') && pw.priceNow ? ['Price now', fmt.priceValue(pw.priceNow.total), fmt.priceUnit()] : null])].filter(Boolean));
}

// the internet, or how the lab is doing when there is no UniFi console
function gateway(d) {
  const uh = (d.unifi || []).find((h) => h.data?.health);
  if (!uh) return null;
  const gw = uh.data.devices.find((x) => ['udm', 'ugw', 'uxg'].includes(x.type));
  // the traffic through it (download, with upload as a second line), else its clients
  if (uh.data.health.internet?.rxMbps != null) return { uh, gw, key: `unifi:${uh.id}:wan:down`, key2: `unifi:${uh.id}:wan:up` };
  return { uh, gw, key: gw ? `unifi:${uh.id}:${gw.mac}:clients` : null };
}

function drawNet(box, p) {
  const g = gateway(data);
  const show = new Set(p.opts.show);
  box.onclick = () => (location.href = '/');
  if (g) {
    const hl = g.uh.data.health;
    const up = !hl.wan || hl.wan.status === 'ok';
    box.replaceChildren(...[
      head(p, el('span', { class: 'r' }, data.carrierLogo ? el('img', { class: 'carrier-logo', src: data.carrierLogo, alt: '' }) : null, data.carrier || hl.wan?.isp || g.gw?.model || 'UniFi')),
      el('div', { class: `huge${up ? '' : ' down'}` }, up ? 'Up' : 'Down', hl.internet?.latencyMs != null ? el('small', { text: `${fmt.n(hl.internet.latencyMs)} ms` }) : null),
      el('div', { class: 'wall-chart' }, show.has('chart') && g.key ? areaChart(hist(p.opts.range, g.key), g.key2 ? hist(p.opts.range, g.key2) : null, Boolean(g.key2)) : null,
        show.has('chart') && g.key2 ? el('div', { class: 'spark-legend', 'aria-hidden': 'true' }, el('span', null, el('i'), 'Download'), el('span', null, el('i', { class: 'up' }), 'Upload')) : null),
      trio([
        show.has('now') ? (hl.internet?.rxMbps != null
          ? ['Now ↓/↑', `${fmt.n(hl.internet.rxMbps, hl.internet.rxMbps < 10 ? 1 : 0)}/${fmt.n(hl.internet.txMbps ?? 0, (hl.internet.txMbps ?? 0) < 10 ? 1 : 0)}`, 'Mbps']
          : hl.internet?.downMbps != null ? ['Tested', `${fmt.n(hl.internet.downMbps)}/${fmt.n(hl.internet.upMbps)}`, 'Mbps'] : null) : null,
        show.has('clients') && hl.clients != null ? ['Clients', fmt.n(hl.clients)] : null,
        show.has('wifi') && hl.wifiClients != null ? ['Wi-Fi', fmt.n(hl.wifiClients)] : null,
      ])].filter(Boolean));
    return;
  }
  const s = data.services;
  const monitored = data.devices.filter((x) => x.connections.length || x.unifi);
  const down = new Set((data.attention || []).filter((a) => a.type === 'offline' && a.deviceId).map((a) => a.deviceId));
  box.replaceChildren(...[
    p.title === '' ? null : el('div', { class: 'lbl' }, HD.icon('server'), p.title || 'Devices'),
    el('div', { class: 'huge' }, `${monitored.length - down.size}/${monitored.length}`, el('small', { text: 'online' })),
    el('div', { class: 'wall-chart' }),
    trio([s?.up + s?.down ? ['Services up', `${s.up}/${s.up + s.down}`] : null, data.updates?.available ? ['Updates', String(data.updates.available)] : null])].filter(Boolean));
}

// the rack, as large as the panel allows
let rackMode = null;
function drawRack(box, p) {
  const rack = data.rack;
  if (!rack?.enabled || !rack.items.length) return box.replaceChildren(...[head(p), el('p', { class: 'small muted', text: 'Nothing in the rack yet.' })].filter(Boolean));
  const inner = el('div', { class: 'rack-view' });
  const holder = el('div', { class: 'wall-rack', id: 'wall-rack' }, inner);
  const draw = () => {
    Rack.render(inner, rack, data, { onSelect: (item) => (location.href = `/#device-${item.id}`), cables: data.cables || [], cablesShow: Boolean(p.opts.cables) });
    fitRack(holder);
  };
  if (!rackMode) rackMode = Rack.modeToggle(() => document.querySelectorAll('.w.rack').forEach((n) => drawRack(n, n._panel)));
  box.replaceChildren(...[p.title === '' ? null : el('div', { class: 'lbl' }, HD.icon('server'), p.title || 'Rack', rackMode), holder].filter(Boolean));
  draw();
}

// Draws the rack at the panel's width, then narrows it until it fits the panel's height
function fitRack(box) {
  const inner = box.firstElementChild;
  if (!inner) return;
  inner.style.width = '';
  const avail = box.clientHeight;
  const h = inner.scrollHeight;
  if (avail > 0 && h > avail) inner.style.width = `${Math.max(160, Math.floor((box.clientWidth * avail) / h))}px`;
}

const STATE_WORDS = { good: 'OK', warning: 'Warning', critical: 'Problem' };
function deviceLine(dev) {
  const info = Rack.itemInfo(dev, data);
  const w = info.measuredW ?? info.poeW;
  return { info, line: [STATE_WORDS[info.status] || (dev.connections.length || dev.unifi ? 'Waiting' : 'Not monitored'), w != null ? `${fmt.n(w)} W` : info.vms || info.sub].filter(Boolean).join(' · ') };
}
function drawDevices(box, p) {
  const picked = p.opts.devices;
  const list = picked ? picked.map((id) => data.devices.find((x) => x.id === id)).filter(Boolean) : data.devices;
  box.replaceChildren(...[head(p, String(list.length)),
    el('div', { class: 'dev-grid' }, list.map((dev) => {
      const { info, line } = deviceLine(dev);
      return el('a', { class: `dev-tile ${info.status || ''}`, href: `/#device-${dev.id}` }, el('span', { class: `dot ${info.status || 'off'}` }), el('b', { text: dev.name }), el('span', { text: line }));
    }))].filter(Boolean));
}

// one device, large: its front, its state and its numbers
function drawDevice(box, p) {
  const dev = data.devices.find((x) => x.id === p.opts.deviceId);
  if (!dev) return box.replaceChildren(el('p', { class: 'small muted', text: 'This device is gone.' }));
  const { info, line } = deviceLine(dev);
  const art = Rack.deviceArt(dev, data);
  const temps = Climate && data.climate ? data.climate.sensors.filter((x) => x.deviceId === dev.id && x.temp !== null) : [];
  box.onclick = () => (location.href = `/#device-${dev.id}`);
  box.className = `w device-panel ${info.status || ''}`;
  box.replaceChildren(...[
    p.title === '' ? null : el('div', { class: 'lbl' }, el('span', { class: `dot ${info.status || 'off'}` }), p.title || dev.name, el('span', { class: 'r', text: STATE_WORDS[info.status] || '' })),
    art ? el('div', { class: 'dp-art' }, art) : el('div', { class: 'huge', text: STATE_WORDS[info.status] || '–' }),
    el('p', { class: 'dp-line', text: line }),
    trio([info.measuredW != null ? ['Power', fmt.n(info.measuredW), 'W'] : null, info.idrac?.inletC != null ? ['Inlet', fmt.n(info.idrac.inletC), '°C'] : null, temps[0] ? [temps[0].name, Climate.temp(temps[0].temp)] : null])].filter(Boolean));
}

// one service: up or down, its response time and its numbers
function drawService(box, p) {
  const s = (services?.groups || []).flatMap((g) => g.services || []).find((x) => x.id === p.opts.serviceId);
  if (!s) return box.replaceChildren(el('p', { class: 'small muted', text: services ? 'This service is gone.' : 'Loading…' }));
  const c = s.check;
  box.className = `w service-panel${c && !c.up ? ' down' : ''}`;
  box.onclick = s.href ? () => window.open(s.href, '_blank', 'noopener') : null;
  box.replaceChildren(...[
    p.title === '' ? null : el('div', { class: 'lbl' }, s.icon ? el('img', { class: 'lbl-img', src: s.icon, alt: '' }) : HD.icon('globe'), p.title || s.name, c ? el('span', { class: 'r' }, el('span', { class: `dot ${c.up ? 'good' : 'critical'}` }), c.up ? 'Up' : 'Down') : null),
    el('div', { class: `huge${c && !c.up ? ' down' : ''}` }, c ? (c.up ? (c.ms != null ? fmt.n(c.ms) : 'Up') : 'Down') : '–', c?.up && c.ms != null ? el('small', { text: 'ms' }) : null),
    el('div', { class: 'wall-chart' }),
    trio((s.stats || []).filter((x) => x.value !== null && x.value !== undefined && x.value !== '').slice(0, 3).map((x) => [x.label, HD.statValue(x)]))].filter(Boolean));
}

function drawClaude(box, p) {
  if (!data.claude) return box.replaceChildren(el('p', { class: 'small muted', text: 'Claude is not set up (Admin → Dashboard → Claude).' }));
  Claude.wallPanel(box, data.claude, p.opts);
}

function drawClimate(box, p) {
  if (!data.climate) return box.replaceChildren(el('p', { class: 'small muted', text: 'No climate sensors (Admin → Devices).' }));
  const picked = p.opts.sensors;
  const c = { ...data.climate, sensors: picked ? picked.map((k) => data.climate.sensors.find((x) => x.key === k)).filter(Boolean) : data.climate.sensors };
  if (!p.opts.humidity) c.sensors = c.sensors.map((x) => ({ ...x, humidity: null }));
  Climate.wallPanel(box, c);
  if (p.title !== null) box.firstElementChild?.replaceWith(...[head(p)].filter(Boolean));
}

function drawClock(box, p) {
  const now = new Date();
  box.replaceChildren(...[
    p.title ? el('div', { class: 'lbl' }, HD.icon('clock'), p.title) : null,
    el('div', { class: 'big-clock' }, now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(p.opts.seconds ? { second: '2-digit' } : {}) })),
    p.opts.date ? el('div', { class: 'big-date', text: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) }) : null].filter(Boolean));
}

// a graph of one value: the latest as the number, the chosen range as the area
function drawGraph(box, p) {
  const o = p.opts;
  const pts = hist(o.range, o.key);
  const last = pts?.length ? pts[pts.length - 1][1] : null;
  box.replaceChildren(...[
    p.title === '' ? null : el('div', { class: 'lbl' }, HD.icon('chart-column'), p.title || o.label || 'Graph', el('span', { class: 'r', text: { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[o.range] })),
    el('div', { class: 'huge' }, last !== null ? fmt.n(last, o.decimals) : '–', o.unit ? el('small', { text: o.unit }) : null),
    el('div', { class: 'wall-chart' }, areaChart(pts, o.key2 ? hist(o.range, o.key2) : null, Boolean(o.key2)))].filter(Boolean));
}

function drawNote(box, p) {
  box.className = `w note-panel size-${p.opts.size}`;
  box.replaceChildren(...[p.title ? el('div', { class: 'lbl' }, HD.icon('file-text'), p.title) : null, el('div', { class: 'note-text', text: p.opts.text || (edit ? 'Write the note in its options (the gear).' : '') })].filter(Boolean));
}

const DRAW = { spot: drawSpot, list: drawList, power: drawPower, net: drawNet, rack: drawRack, devices: drawDevices, claude: drawClaude, climate: drawClimate, clock: drawClock, device: drawDevice, service: drawService, graph: drawGraph, note: drawNote };

// --- services along the bottom ---
function renderServices() {
  // the same as Home (Admin → Dashboard), or the ones picked for this layout
  const L = layout();
  const picked = L.services.list;
  const mode = picked ? 'tiles' : data?.homeServices || 'tiles';
  const every = (services?.groups || []).flatMap((g) => g.services || []);
  const all = picked ? picked.map((id) => every.find((s) => s.id === id)).filter(Boolean) : every.filter((s) => s.onHome !== false);
  const box = $('svc');
  const down = all.filter((s) => s.check && !s.check.up);
  box.hidden = !L.services.show || mode === 'off' || !all.length || (mode === 'down' && !down.length);
  if (box.hidden) return box.replaceChildren();
  const list = (mode === 'down' ? down : picked ? all : [...down, ...all.filter((s) => !down.includes(s))]).slice(0, 10);
  box.replaceChildren(...list.map((s) => {
    const c = s.check;
    const st = s.stats?.find((x) => x.value !== null && x.value !== undefined && x.value !== '');
    const line = c && !c.up ? (c.code ? `Down · ${c.code}` : 'Down') : st ? `${HD.statValue(st)} ${st.label.toLowerCase()}` : s.description || '';
    return el(s.href ? 'a' : 'div', { class: `dtile${c && !c.up ? ' critical' : ''}`, href: s.href || null, target: s.href ? '_blank' : null, rel: s.href ? 'noopener noreferrer' : null },
      s.icon ? el('span', { class: 'tile-icon' }, el('img', { src: s.icon, alt: '' })) : HD.letterIcon(s.name, 'tile-icon letter'),
      el('span', { class: 'tile-text' }, el('span', { class: 'tile-name', text: s.name }), el('span', { class: 'tile-state', text: line })),
      el('span', { class: 'tile-top' }, c ? el('span', { class: `dot ${c.up ? 'good' : 'critical'}` }) : null));
  }));
}

// --- the grid: a section per panel, in order, each spanning its columns and rows ---
function renderGrid() {
  const L = layout();
  const wall = $('wall');
  wall.style.setProperty('--wall-scale', String(L.scale / 100));
  wall.dataset.gap = L.gap;
  const grid = $('wall-grid');
  grid.style.setProperty('--cols', String(L.cols));
  grid.style.gridTemplateRows = L.rows ? `repeat(${L.rows}, minmax(0, 1fr))` : '';
  grid.style.gridAutoRows = L.rows ? '0' : '';
  const keep = new Set(L.panels.map((p) => p.uid));
  for (const uid of [...panelNodes.keys()]) if (!keep.has(uid)) panelNodes.delete(uid);
  const nodes = L.panels.map((p) => {
    let n = panelNodes.get(p.uid);
    if (!n) {
      n = el('section', { class: `w ${p.type === 'clock' ? 'clock-panel' : p.type}`, id: IDS[p.type] || null });
      panelNodes.set(p.uid, n);
    }
    n._panel = p;
    n.dataset.uid = p.uid;
    n.style.gridColumn = `span ${Math.min(p.w, L.cols)}`;
    n.style.gridRow = `span ${p.h}`;
    return n;
  });
  grid.replaceChildren(...nodes);
  // the Claude panel as a ticker line goes above the services instead
  const claude = L.panels.find((p) => p.type === 'claude');
  const tick = $('claude-ticker');
  tick.hidden = !claude || !data.claude || claude.opts.style !== 'ticker';
  if (!tick.hidden) Claude.ticker(tick, data.claude, claude.opts);
  for (const n of nodes) {
    const p = n._panel;
    n.className = `w ${p.type === 'clock' ? 'clock-panel' : p.type}`; // not "clock": that is the top bar's
    n.hidden = p.type === 'claude' && !tick.hidden && !edit; // while customizing it stays, to reach its options
    n.setAttribute('aria-label', p.title || TYPES[p.type][0]);
    try {
      DRAW[p.type](n, p);
    } catch (e) {
      n.replaceChildren(el('p', { class: 'small muted', text: `Could not draw this panel: ${e.message}` }));
    }
    if (edit) addEditControls(n, p);
  }
  document.querySelector('.clock').hidden = !L.top.clock;
  $('wall-brand').hidden = L.top.logo === false;
  $('wall-title').textContent = data.title || '';
}

function render() {
  if (!data) return;
  renderHead(data);
  renderGrid();
  renderServices();
  $('wall').classList.toggle('editing', Boolean(edit));
  renderEditBar();
}

// --- Customize: the wall itself becomes the editor ---
function changed() {
  edit.dirty = true;
  render();
  fetchHistory().then(render);
}

function startEdit() {
  const L = layout();
  edit = { layout: structuredClone(L), slug: L.slug, dirty: false };
  render();
}

function stopEdit() {
  edit = null;
  render();
}

// on each panel: drag to move, the corner to resize, its options, remove it
function addEditControls(n, p) {
  const L = edit.layout;
  const bar = el('div', { class: 'w-edit' },
    el('span', { class: 'w-grip', title: 'Drag to move' }, HD.icon('grip-vertical'), p.title || TYPES[p.type][0]),
    el('span', { class: 'w-size', text: `${p.w}×${p.h}` }),
    el('button', { type: 'button', class: 'icon-button', title: 'Options', 'aria-label': `Options for ${p.title || TYPES[p.type][0]}`, onclick: (e) => { e.stopPropagation(); openPanelOptions(p); } }, HD.icon('sliders-horizontal')),
    el('button', { type: 'button', class: 'icon-button', title: 'Remove', 'aria-label': `Remove ${p.title || TYPES[p.type][0]}`, onclick: (e) => { e.stopPropagation(); L.panels = L.panels.filter((x) => x !== p); changed(); } }, HD.icon('x')));
  const corner = el('span', { class: 'w-resize', title: 'Drag to resize', 'aria-hidden': 'true' });
  n.append(bar, corner);
  n.onclick = null;
  // move: the panel goes before or after the one under the pointer
  bar.querySelector('.w-grip').addEventListener('pointerdown', (e) => {
    HD.dragMove(e, n, {
      placeholderClass: 'w-slot',
      place: (x, y, ph) => {
        ph.style.gridColumn = n.style.gridColumn;
        ph.style.gridRow = n.style.gridRow;
        const over = [...$('wall-grid').children].find((c) => c !== ph && (() => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; })());
        if (!over) return;
        const r = over.getBoundingClientRect();
        if (x < r.left + r.width / 2) over.before(ph);
        else over.after(ph);
      },
      done: () => {
        const order = [...$('wall-grid').children].map((c) => c.dataset.uid);
        L.panels.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
        changed();
      },
    });
  });
  // resize: whole columns and rows, from the panel's top left corner to the pointer
  corner.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = $('wall-grid');
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const colW = (grid.clientWidth - gap * (L.cols - 1)) / L.cols;
    const rowH = n.getBoundingClientRect().height / p.h;
    const r0 = n.getBoundingClientRect();
    const move = (ev) => {
      const w = Math.max(1, Math.min(L.cols, Math.round((ev.clientX - r0.left + gap) / (colW + gap))));
      const h = Math.max(1, Math.min(4, Math.round((ev.clientY - r0.top + gap) / (rowH + gap))));
      if (w === p.w && h === p.h) return;
      p.w = w;
      p.h = h;
      n.style.gridColumn = `span ${w}`;
      n.style.gridRow = `span ${h}`;
      n.querySelector('.w-size').textContent = `${w}×${h}`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      changed();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// the bar at the top while customizing: the layout, the grid, text size, top bar, services, adding panels
function renderEditBar() {
  const bar = $('wall-edit');
  bar.hidden = !edit;
  if (!edit) return bar.replaceChildren();
  const L = edit.layout;
  const msg = el('span', { class: 'msg', role: 'status' });
  const sel = (label, value, options, onChange) => {
    const s = el('select', { 'aria-label': label }, options.map(([v, t]) => el('option', { value: String(v), text: t })));
    s.value = String(value);
    s.addEventListener('change', () => onChange(s.value));
    return el('label', { class: 'we-field' }, el('span', { text: label }), s);
  };
  const check = (label, on, onChange) => {
    const c = el('input', { type: 'checkbox', checked: on });
    c.addEventListener('change', () => onChange(c.checked));
    return el('label', { class: 'check' }, c, ` ${label}`);
  };
  const layouts = [...(data.walls || [])];
  if (!layouts.some((l) => l.slug === L.slug)) layouts.push(L); // a new one, not saved yet
  const addable = Object.keys(TYPES).filter((t) => !SINGLE.includes(t) || !L.panels.some((p) => p.type === t));
  const scale = el('input', { type: 'range', min: 70, max: 160, step: 5, value: L.scale, 'aria-label': 'Text size' });
  scale.addEventListener('input', () => {
    L.scale = Number(scale.value);
    $('wall').style.setProperty('--wall-scale', String(L.scale / 100));
    scaleOut.textContent = `${L.scale} %`;
    edit.dirty = true;
  });
  const scaleOut = el('span', { class: 'small num', text: `${L.scale} %` });
  bar.replaceChildren(
    el('div', { class: 'we-row' },
      sel('Layout', edit.slug, [...layouts.map((l) => [l.slug, l.name]), ['__new', 'New layout…']], async (v) => {
        if (v === '__new') {
          const name = prompt('A name for the new layout (for example Kitchen tablet):');
          if (!name) return render();
          const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'wall';
          edit = { layout: { ...structuredClone(L), slug, name }, slug, dirty: true };
          return render();
        }
        if (edit.dirty && !confirm('Leave this layout without saving the changes?')) return render();
        location.href = v === 'default' ? '/wall' : `/wall?layout=${encodeURIComponent(v)}`;
      }),
      el('label', { class: 'we-field' }, el('span', { text: 'Name' }), (() => { const i = el('input', { value: L.name, maxlength: 40 }); i.addEventListener('input', () => { L.name = i.value; edit.dirty = true; }); return i; })()),
      sel('Columns', L.cols, [2, 3, 4, 5, 6].map((c) => [c, String(c)]), (v) => { L.cols = Number(v); for (const p of L.panels) p.w = Math.min(p.w, L.cols); changed(); }),
      sel('Rows', L.rows, [[0, 'Automatic'], ...[1, 2, 3, 4, 5, 6, 8].map((r) => [r, String(r)])], (v) => { L.rows = Number(v); changed(); }),
      el('label', { class: 'we-field' }, el('span', { text: 'Text size' }), el('span', { class: 'we-range' }, scale, scaleOut)),
      sel('Space', L.gap, [['tight', 'Tight'], ['normal', 'Normal'], ['roomy', 'Roomy']], (v) => { L.gap = v; changed(); }),
      sel('Add a panel', '', [['', 'Add a panel…'], ...addable.map((t) => [t, TYPES[t][0]])], (t) => {
        if (!t) return;
        const p = { uid: `${t}-${Math.random().toString(36).slice(2, 8)}`, type: t, w: ['devices', 'graph'].includes(t) ? 2 : 1, h: 1, title: null, opts: {} };
        L.panels.push(p);
        changed();
        if (['device', 'service', 'graph', 'note'].includes(t)) openPanelOptions(p);
      })),
    el('div', { class: 'we-row' },
      check('Logo and title', L.top.logo, (v) => { L.top.logo = v; changed(); }),
      check('Clock', L.top.clock, (v) => { L.top.clock = v; changed(); }),
      check('VMs running', L.top.vmCount, (v) => { L.top.vmCount = v; changed(); }),
      check('Services along the bottom', L.services.show, (v) => { L.services.show = v; changed(); }),
      L.services.show ? el('button', { type: 'button', class: 'small', text: L.services.list ? `${L.services.list.length} services picked` : 'Services as on Home', onclick: openServicePicker }) : null,
      el('span', { class: 'we-spacer' }),
      L.slug !== 'default' ? el('a', { class: 'small', href: `/wall?layout=${L.slug}`, text: `This screen's address: /wall?layout=${L.slug}` }) : el('span', { class: 'small muted', text: 'Plain /wall shows this one' }),
      el('button', { type: 'button', class: 'primary', text: 'Save', onclick: async () => {
        try {
          const r = await HD.api('PUT', '/api/admin/wall', L);
          data.walls = r.walls;
          data.wall = r.wall;
          const slug = r.layout.slug;
          edit = null;
          if (slug !== SLUG) location.href = slug === 'default' ? '/wall' : `/wall?layout=${slug}`;
          else render();
        } catch (e) {
          msg.textContent = e.message;
        }
      } }),
      el('button', { type: 'button', text: 'Cancel', onclick: () => { if (!edit.dirty || confirm('Throw away the changes?')) stopEdit(); } }),
      el('button', { type: 'button', class: 'ghost', text: 'Default', onclick: () => { if (!confirm('Start this layout again from the panels a new wall has?')) return; Object.assign(L, { cols: 3, rows: 0, scale: 100, gap: 'normal', top: { logo: true, clock: true, vmCount: true }, services: { show: true, list: null }, panels: structuredClone(FACTORY) }); changed(); } }),
      L.slug !== 'default' && layouts.some((l) => l.slug === L.slug) ? el('button', { type: 'button', class: 'danger', text: 'Delete layout', onclick: async () => {
        if (!confirm(`Delete the layout ${L.name}? Screens that open it get the default.`)) return;
        await HD.api('DELETE', `/api/admin/wall/${L.slug}`);
        location.href = '/wall';
      } }) : null,
      msg));
}

function pickList(items, chosen, onChange) {
  return el('div', { class: 'wall-picks' }, items.map((x) => {
    const cb = el('input', { type: 'checkbox', checked: chosen.includes(x.id) });
    cb.addEventListener('change', () => onChange(x.id, cb.checked));
    return el('label', { class: 'check' }, cb, ` ${x.name}`);
  }));
}

function openServicePicker() {
  const L = edit.layout;
  const items = (services?.groups || []).flatMap((g) => g.services || []).map((x) => ({ id: x.id, name: x.name }));
  const body = el('div', { class: 'wall-edit' });
  const draw = () => body.replaceChildren(
    el('p', { class: 'hint', text: 'The same as Home, or the ones you pick (up to 10 show).' }),
    (() => {
      const s = el('select', null, el('option', { value: 'home', text: 'The same as Home' }), el('option', { value: 'pick', text: 'The ones I pick' }));
      s.value = L.services.list ? 'pick' : 'home';
      s.addEventListener('change', () => { L.services.list = s.value === 'pick' ? items.map((x) => x.id) : null; draw(); changed(); });
      return s;
    })(),
    L.services.list ? pickList(items, L.services.list, (id, on) => { L.services.list = on ? [...L.services.list, id] : L.services.list.filter((x) => x !== id); changed(); }) : null);
  draw();
  HD.drawer('Services along the bottom', body);
}

// a panel's own options, in a drawer; changes show at once
let seriesCache = null;
async function openPanelOptions(p) {
  const body = el('div', { class: 'wall-edit' });
  const update = () => changed();
  const field = (label, input, hint) => el('label', { class: 'we-opt' }, el('span', { text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  const select = (value, options, onChange) => {
    const s = el('select', null, options.map(([v, t]) => el('option', { value: String(v), text: t })));
    s.value = String(value ?? '');
    s.addEventListener('change', () => { onChange(s.value); update(); });
    return s;
  };
  const checks = (all, chosen, onChange) => el('div', { class: 'wall-picks' }, all.map(([k, t]) => {
    const c = el('input', { type: 'checkbox', checked: chosen.includes(k) });
    c.addEventListener('change', () => { onChange(c.checked ? all.map(([x]) => x).filter((x) => x === k || chosen.includes(x)) : chosen.filter((x) => x !== k)); update(); });
    return el('label', { class: 'check' }, c, ` ${t}`);
  }));
  const titleMode = select(p.title === null ? 'usual' : p.title === '' ? 'none' : 'own', [['usual', 'The usual title'], ['own', 'My own title'], ['none', 'No title']], (v) => {
    p.title = v === 'usual' ? null : v === 'none' ? '' : p.title || TYPES[p.type][0];
    draw();
  });
  const titleText = el('input', { value: p.title || '', maxlength: 40 });
  titleText.addEventListener('input', () => { p.title = titleText.value; edit.dirty = true; });
  titleText.addEventListener('change', update);
  const o = p.opts;
  const range = () => field('Time span', select(o.range || '24h', [['24h', 'The last 24 hours'], ['7d', 'The last 7 days'], ['30d', 'The last 30 days']], (v) => (o.range = v)));
  const draw = async () => {
    const own = [];
    if (p.type === 'spot') own.push(field('Each problem shows for (seconds)', (() => { const i = el('input', { type: 'number', min: 4, max: 60, value: o.seconds ?? 8 }); i.addEventListener('change', () => { o.seconds = Number(i.value); update(); }); return i; })()));
    if (p.type === 'power') own.push(range(), field('Show', checks([['chart', 'The graph'], ['today', 'Cost today'], ['month', 'Cost this month'], ['price', 'Price now']], o.show || ['chart', 'today', 'month', 'price'], (v) => (o.show = v))));
    if (p.type === 'net') own.push(range(), field('Show', checks([['chart', 'The graph'], ['now', 'Traffic now'], ['clients', 'Clients'], ['wifi', 'Wi-Fi clients']], o.show || ['chart', 'now', 'clients', 'wifi'], (v) => (o.show = v))));
    if (p.type === 'rack') own.push(field('Patch cables', checks([['cables', 'Draw the patch cables']], o.cables ? ['cables'] : [], (v) => (o.cables = v.includes('cables')))));
    if (p.type === 'devices') own.push(field('Devices', select(o.devices ? 'pick' : 'all', [['all', 'Every device'], ['pick', 'The ones I pick']], (v) => { o.devices = v === 'pick' ? data.devices.map((d) => d.id) : null; draw(); })),
      o.devices ? pickList(data.devices.map((d) => ({ id: d.id, name: d.name })), o.devices, (id, on) => { o.devices = on ? [...o.devices, id] : o.devices.filter((x) => x !== id); update(); }) : null);
    if (p.type === 'claude') own.push(field('Style', select(o.style || 'number', Object.entries(Claude.STYLE_NAMES), (v) => (o.style = v)), 'Limit rings need plan limits; the ticker is a thin line above the services.'),
      field('Shows', checks(Object.entries(Claude.STAT_NAMES), o.stats || ['tokens', 'limits', 'status'], (v) => (o.stats = v))));
    if (p.type === 'climate') {
      const all = (data.climate?.sensors || []).map((x) => ({ id: x.key, name: [x.room, x.name].filter(Boolean).join(' · ') }));
      own.push(field('Sensors', select(o.sensors ? 'pick' : 'all', [['all', 'Every sensor'], ['pick', 'The ones I pick']], (v) => { o.sensors = v === 'pick' ? all.map((x) => x.id) : null; draw(); })),
        o.sensors ? pickList(all, o.sensors, (id, on) => { o.sensors = on ? [...o.sensors, id] : o.sensors.filter((x) => x !== id); update(); }) : null,
        field('Humidity', checks([['h', 'Show the humidity']], o.humidity === false ? [] : ['h'], (v) => (o.humidity = v.includes('h')))));
    }
    if (p.type === 'clock') own.push(field('Show', checks([['date', 'The date'], ['seconds', 'Seconds']], [o.date !== false ? 'date' : null, o.seconds ? 'seconds' : null].filter(Boolean), (v) => { o.date = v.includes('date'); o.seconds = v.includes('seconds'); })));
    if (p.type === 'device') own.push(field('Device', select(o.deviceId || '', [['', 'Choose…'], ...data.devices.map((d) => [d.id, d.name])], (v) => (o.deviceId = v || undefined))));
    if (p.type === 'service') own.push(field('Service', select(o.serviceId || '', [['', 'Choose…'], ...(services?.groups || []).flatMap((g) => g.services || []).map((s) => [s.id, s.name])], (v) => (o.serviceId = v || undefined))));
    if (p.type === 'graph') {
      seriesCache ||= (await HD.api('GET', '/api/admin/wall/series')).series;
      own.push(field('Value', select(o.key || '', [['', 'Choose…'], ...seriesCache.map((s) => [s.key, `${s.label} (${s.unit})`])], (v) => {
        const s = seriesCache.find((x) => x.key === v);
        Object.assign(o, s ? { key: s.key, key2: s.key2 || null, unit: s.unit, decimals: s.decimals, label: s.label } : { key: undefined });
      })), range());
    }
    if (p.type === 'note') {
      const t = el('textarea', { rows: 6, maxlength: 1000, text: o.text || '' });
      t.value = o.text || '';
      t.addEventListener('input', () => { o.text = t.value; edit.dirty = true; });
      t.addEventListener('change', update);
      own.push(field('Text', t, 'Plain text: Wi-Fi for guests, who to call, a reminder…'), field('Text size', select(o.size || 'normal', [['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']], (v) => (o.size = v))));
    }
    body.replaceChildren(...[ // replaceChildren would turn null into the text "null"
      field('Title', titleMode), p.title !== null && p.title !== '' ? field('Its title', titleText) : null,
      field('Size', el('span', { class: 'small', text: `${p.w} column${p.w === 1 ? '' : 's'} × ${p.h} row${p.h === 1 ? '' : 's'}: drag the panel's lower right corner to change it` })),
      ...own].filter(Boolean));
  };
  await draw();
  HD.drawer(`${TYPES[p.type][0]}: options`, body);
}

function renderTools() {
  const full = el('button', { type: 'button', class: 'icon-button', title: 'Full screen', 'aria-label': 'Full screen', onclick: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* not allowed here */
    }
    keepAwake();
  } }, HD.icon('maximize'));
  $('wall-tools').replaceChildren(...[ // replaceChildren would turn null into the text "null"
    el('a', { class: 'button icon-button', href: '/', title: 'Home', 'aria-label': 'Home' }, HD.icon('house')),
    el('button', { type: 'button', class: 'icon-button', title: 'Search', 'aria-label': 'Search', onclick: HD.openSearch }, HD.icon('search')),
    el('button', { type: 'button', class: 'icon-button', title: 'Look on this device', 'aria-label': 'Look on this device', onclick: (e) => HD.openLook(e.currentTarget) }, HD.icon('palette')),
    data?.loggedIn ? el('button', { type: 'button', class: 'icon-button', id: 'wall-customize', title: 'Customize the wall', 'aria-label': 'Customize the wall', onclick: () => (edit ? null : startEdit()) }, HD.icon('sliders-horizontal')) : null,
    full].filter(Boolean));
}

// A wall screen shouldn't go dark; asked for when someone taps, if the browser allows it
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* fine: the screen's own settings apply */
  }
}

// the history every panel needs, by range
async function fetchHistory() {
  if (!data) return;
  const want = new Map(); // range -> Set(keys)
  const add = (range, key) => key && (want.get(range) || want.set(range, new Set()).get(range)).add(key);
  const g = gateway(data);
  for (const p of layout().panels) {
    if (p.type === 'power' && p.opts.show?.includes('chart')) add(p.opts.range, 'power:total');
    if (p.type === 'net' && g) {
      add(p.opts.range, g.key);
      add(p.opts.range, g.key2);
    }
    if (p.type === 'graph') {
      add(p.opts.range, p.opts.key);
      add(p.opts.range, p.opts.key2);
    }
  }
  const next = {};
  await Promise.all([...want].map(async ([range, keys]) => {
    try {
      const r = await getJson(`/api/history?range=${range}&points=120&keys=${encodeURIComponent([...keys].join(','))}`);
      for (const [k, v] of Object.entries(r.series || {})) next[`${range}|${k}`] = v;
    } catch {
      /* the charts wait for the next round */
    }
  }));
  history = next;
}

async function refresh() {
  clearTimeout(refreshTimer);
  let delay = 30;
  try {
    const [d, s] = await Promise.all([getJson('/api/dashboard'), getJson('/api/services').catch(() => null)]);
    data = d;
    fmt.setCurrency(d.power?.currency);
    data.rack.items = d.devices; // the server sends the devices once
    services = s;
    delay = d.refreshSeconds;
    await fetchHistory();
    $('global-error').classList.add('hidden');
    if (!$('wall-customize') && d.loggedIn) renderTools();
    // while dragging or resizing, the next round waits
    if (!document.querySelector('.drag-ghost')) render();
  } catch (e) {
    $('global-error').textContent = `Could not load the dashboard: ${e.message}. Trying again…`;
    $('global-error').classList.remove('hidden');
  }
  refreshTimer = setTimeout(refresh, Math.max(10, delay) * 1000);
}

document.addEventListener('pointerover', (e) => {
  if (e.target.closest?.('.w.spot')) clearTimeout(spotTimer);
});
document.addEventListener('pointerout', (e) => {
  const s = e.target.closest?.('.w.spot');
  if (s && !s.contains(e.relatedTarget) && data) drawSpot(s, s._panel);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh();
    if (wakeLock === null && document.fullscreenElement) keepAwake();
  }
});
document.addEventListener('pointerdown', keepAwake, { once: true });
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
    e.preventDefault();
    HD.openSearch();
  }
});
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.querySelectorAll('.wall-rack').forEach(fitRack), 150);
});
addEventListener('beforeunload', (e) => {
  if (edit?.dirty) e.preventDefault();
});
reduceMotion.addEventListener('change', () => data && render());
renderTools();
tick();
setInterval(tick, 1000);
refresh();

// The buttons by the clock fade out when nobody is using the screen (and so does the mouse
// pointer), and come back on a touch, a mouse move or a key; not while one of them is in use.
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (edit || document.querySelector('dialog[open]') || $('wall-tools').contains(document.activeElement)) return wake();
    document.body.classList.add('idle');
  }, 4000);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'focusin']) addEventListener(ev, wake, { passive: true });
wake();
