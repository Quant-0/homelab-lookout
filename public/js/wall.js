'use strict';
// Wall display: one screen for a tablet or TV, read from across the room. What needs you is shown
// one problem at a time (8 s each), with power, the internet, the rack and the services around it.
// Same data and access as the Home page; tapping something opens it there.

const { el, svg, fmt } = HD;
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const ISSUE_ICONS = { critical: 'octagon-alert', warning: 'triangle-alert', serious: 'triangle-alert' };

let data = null;
let services = null;
let history = {};
let spotIndex = 0;
let spotTimer = null;
let refreshTimer = null;

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
function areaChart(points) {
  if (!points || points.length < 2) return el('p', { class: 'small muted', text: 'Collecting history…' });
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const vs = points.map((p) => p[1]);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const pad = (hi - lo) * 0.25 || 1;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(2)},${y(v).toFixed(2)}`).join('');
  return svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('path', { class: 'c-area', d: `${line}L100,100L0,100Z` }),
    svg('path', { class: 'c-line', d: line }));
}

function trio(items) {
  return el('div', { class: 'trio' }, items.filter(Boolean).map(([label, v, unit]) => el('div', null, el('span', { text: label }), el('b', null, v, unit ? el('small', { text: unit }) : null))));
}

// --- header ---
function renderHead(d) {
  const list = d.attention || [];
  const crit = list.filter((a) => a.severity === 'critical').length;
  const warn = list.length - crit;
  $('orb').className = `orb ${crit ? 'critical' : warn ? 'warning' : ''}`;
  $('headline').textContent = list.length
    ? [crit ? `${crit} ${crit === 1 ? 'fault' : 'faults'}` : null, warn ? `${warn} to watch` : null].filter(Boolean).join(', ')
    : 'All systems normal';
  document.title = `${$('headline').textContent} · ${d.title}`;
  const guests = d.vms?.home === false ? [] : (d.proxmox || []).flatMap((h) => h.data?.guests || []);
  const seen = new Set();
  const vms = guests.filter((g) => !seen.has(`${g.node}:${g.vmid}`) && seen.add(`${g.node}:${g.vmid}`));
  $('wall-sub').textContent = [
    d.title,
    `updated ${fmt.ago(d.generatedAt)}`,
    vms.length ? `${vms.filter((g) => g.status === 'running').length} of ${vms.length} VMs running` : null,
    d.updates?.available ? `${d.updates.available} update${d.updates.available === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
}

function tick() {
  const now = new Date();
  $('clock-time').textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('clock-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (data) $('wall-sub').textContent = $('wall-sub').textContent.replace(/updated [^·]+/, `updated ${fmt.ago(data.generatedAt)} `).replace(/ {2}/g, ' ');
}

// --- what needs you, one at a time ---
function renderSpot() {
  const list = data.attention || [];
  const box = $('spot');
  clearTimeout(spotTimer);
  if (!list.length) {
    box.className = 'w spot';
    box.onclick = null;
    box.replaceChildren(el('div', { class: 'lbl' }, HD.icon('circle-check'), 'Needs you'),
      el('div', { class: 'fade' }, el('h2', { text: 'Nothing needs you' }), el('p', { text: 'Every device and service answers, and nothing is near a limit.' })));
    return;
  }
  spotIndex %= list.length;
  const a = list[spotIndex];
  box.className = `w spot ${a.severity}`;
  box.onclick = () => (location.href = a.deviceId ? `/#device-${a.deviceId}` : a.serviceId ? '/services' : '/');
  box.replaceChildren(
    el('div', { class: 'lbl' }, HD.icon('triangle-alert'), 'Needs you', el('span', { class: 'r', text: `${spotIndex + 1} / ${list.length}` })),
    el('div', { class: 'fade' },
      el('div', { class: 'spot-who' }, HD.icon(ISSUE_ICONS[a.severity] || 'info'), [a.subject, a.since ? `since ${new Date(a.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : null].filter(Boolean).join(' · ')),
      el('h2', { text: a.text }),
      a.detail ? el('p', { text: a.detail.length > 220 ? `${a.detail.slice(0, 220)}…` : a.detail }) : null),
    list.length > 1 ? el('div', { class: 'prog' }, list.map((_, k) => el('i', { class: k < spotIndex ? 'done' : k === spotIndex ? 'now' : null }))) : null);
  document.querySelectorAll('#probs li').forEach((li, k) => li.classList.toggle('on', k === spotIndex));
  if (list.length > 1 && !box.matches(':hover')) spotTimer = setTimeout(() => {
    spotIndex = (spotIndex + 1) % list.length;
    renderSpot();
  }, 8000);
}

function renderList() {
  const list = data.attention || [];
  $('list-h').replaceChildren(HD.icon('list'), 'All problems', el('span', { class: 'r', text: String(list.length) }));
  $('probs').replaceChildren(...(list.length
    ? list.map((a, k) => el('li', { onclick: () => { spotIndex = k; renderSpot(); } },
      el('span', { class: `dot ${a.severity === 'critical' ? 'critical' : 'warning'}` }),
      el('b', null, a.subject ? `${a.subject} ` : '', el('span', { text: a.text })),
      el('time', { text: a.since ? `${sinceText(a.since)}` : '' })))
    : [el('li', null, el('span', { class: 'dot good' }), el('b', { text: 'No problems' }), el('time'))]));
}

// --- power ---
function renderPower() {
  const p = data.power;
  const u = p.usage;
  const box = $('power');
  box.onclick = () => (location.href = '/energy');
  box.replaceChildren(
    el('div', { class: 'lbl' }, HD.icon('zap'), 'Power now', el('span', { class: 'r', text: [p.measured.total != null ? `${fmt.n(p.measured.total)} W measured` : null, p.estimatedW > 0 ? `${fmt.n(p.estimatedW)} W estimated` : null].filter(Boolean).join(' · ') })),
    el('div', { class: 'huge' }, p.watts != null ? fmt.n(p.watts) : '–', el('small', { text: 'W' })),
    el('div', { class: 'wall-chart' }, areaChart(history['power:total'])),
    trio([['Today', fmt.n(u.today.cost, 2), 'kr'], ['This month', fmt.n(u.month.cost, 0), 'kr'], p.priceNow ? ['Price now', fmt.n(p.priceNow.total, 1), 'øre'] : null]));
}

// --- the internet, or how the lab is doing when there is no UniFi console ---
function gateway(d) {
  const uh = (d.unifi || []).find((h) => h.data?.health);
  if (!uh) return null;
  const gw = uh.data.devices.find((x) => ['udm', 'ugw', 'uxg'].includes(x.type));
  return { uh, gw, key: gw ? `unifi:${uh.id}:${gw.mac}:clients` : null };
}

function renderNet() {
  const box = $('net');
  const g = gateway(data);
  box.onclick = () => (location.href = '/');
  if (g) {
    const hl = g.uh.data.health;
    const up = !hl.wan || hl.wan.status === 'ok';
    box.replaceChildren(
      el('div', { class: 'lbl' }, HD.icon('globe'), 'Internet', el('span', { class: 'r', text: g.gw?.model || 'UniFi' })),
      el('div', { class: `huge${up ? '' : ' down'}` }, up ? 'Up' : 'Down', hl.internet?.latencyMs != null ? el('small', { text: `${fmt.n(hl.internet.latencyMs)} ms` }) : null),
      el('div', { class: 'wall-chart' }, g.key ? areaChart(history[g.key]) : null),
      trio([
        hl.internet?.downMbps != null ? ['Tested', `${fmt.n(hl.internet.downMbps)}/${fmt.n(hl.internet.upMbps)}`, 'Mbps'] : null,
        hl.clients != null ? ['Clients', fmt.n(hl.clients)] : null,
        hl.wifiClients != null ? ['Wi-Fi', fmt.n(hl.wifiClients)] : null,
      ]));
    return;
  }
  const s = data.services;
  const monitored = data.devices.filter((x) => x.connections.length || x.unifi);
  const down = new Set((data.attention || []).filter((a) => a.type === 'offline' && a.deviceId).map((a) => a.deviceId));
  box.replaceChildren(
    el('div', { class: 'lbl' }, HD.icon('server'), 'Devices'),
    el('div', { class: 'huge' }, `${monitored.length - down.size}/${monitored.length}`, el('small', { text: 'online' })),
    el('div', { class: 'wall-chart' }),
    trio([s?.up + s?.down ? ['Services up', `${s.up}/${s.up + s.down}`] : null, data.updates?.available ? ['Updates', String(data.updates.available)] : null]));
}

// --- the rack, as large as the column allows ---
let rackMode = null;
function renderRack() {
  const rack = data.rack;
  const box = $('wall-rack');
  const section = box.closest('.rack');
  section.hidden = !rack?.enabled || !rack.items.length;
  if (section.hidden) return;
  const inner = el('div', { class: 'rack-view' });
  const draw = () => {
    Rack.render(inner, rack, data, { onSelect: (item) => (location.href = `/#device-${item.id}`) });
    fitRack();
  };
  if (!rackMode) rackMode = Rack.modeToggle(draw);
  $('rack-h').replaceChildren(HD.icon('server'), 'Rack', rackMode);
  box.replaceChildren(inner);
  draw();
}

// Draws the rack at the column's width, then narrows it until it fits the column's height
function fitRack() {
  const box = $('wall-rack');
  const inner = box.firstElementChild;
  if (!inner) return;
  inner.style.width = '';
  const avail = box.clientHeight;
  const h = inner.scrollHeight;
  if (avail > 0 && h > avail) inner.style.width = `${Math.max(160, Math.floor((box.clientWidth * avail) / h))}px`;
}

// --- services ---
function renderServices() {
  // the same choice as Home (Admin → Dashboard); the wall keeps its own tile look
  const mode = data?.homeServices || 'tiles';
  const all = (services?.groups || []).flatMap((g) => g.services || []).filter((s) => s.onHome !== false);
  const box = $('svc');
  const down = all.filter((s) => s.check && !s.check.up);
  box.hidden = mode === 'off' || !all.length || (mode === 'down' && !down.length);
  if (box.hidden) return box.replaceChildren();
  const list = (mode === 'down' ? down : [...down, ...all.filter((s) => !down.includes(s))]).slice(0, 10);
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
  $('wall-tools').replaceChildren(
    el('a', { class: 'button icon-button', href: '/', title: 'Home', 'aria-label': 'Home' }, HD.icon('house')),
    el('button', { type: 'button', class: 'icon-button', title: 'Search', 'aria-label': 'Search', onclick: HD.openSearch }, HD.icon('search')),
    el('button', { type: 'button', class: 'icon-button', title: 'Look on this device', 'aria-label': 'Look on this device', onclick: (e) => HD.openLook(e.currentTarget) }, HD.icon('palette')),
    full);
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

function render() {
  renderHead(data);
  renderList();
  renderSpot();
  renderPower();
  renderNet();
  renderRack();
  renderServices();
}

async function refresh() {
  clearTimeout(refreshTimer);
  let delay = 30;
  try {
    const [d, s] = await Promise.all([getJson('/api/dashboard'), getJson('/api/services').catch(() => null)]);
    data = d;
    services = s;
    delay = d.refreshSeconds;
    const keys = ['power:total', gateway(d)?.key].filter(Boolean);
    try {
      history = (await getJson(`/api/history?range=24h&points=120&keys=${encodeURIComponent(keys.join(','))}`)).series || {};
    } catch {
      /* the charts wait for the next round */
    }
    $('global-error').classList.add('hidden');
    render();
  } catch (e) {
    $('global-error').textContent = `Could not load the dashboard: ${e.message}. Trying again…`;
    $('global-error').classList.remove('hidden');
  }
  refreshTimer = setTimeout(refresh, Math.max(10, delay) * 1000);
}

$('spot').addEventListener('pointerleave', () => data && renderSpot());
$('spot').addEventListener('pointerenter', () => clearTimeout(spotTimer));
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
  resizeTimer = setTimeout(fitRack, 150);
});
reduceMotion.addEventListener('change', () => data && render());
renderTools();
tick();
setInterval(tick, 1000);
refresh();
