'use strict';
// The public status page: each service with a status check, whether it's up now, and its uptime
// over the last 90 days. Refreshes every minute. Nothing here needs a login.

const { el } = HD;
const $ = (id) => document.getElementById(id);
const DAY = 86400e3;

const STATE = {
  up: ['Operational', 'good'],
  down: ['Down', 'critical'],
  maintenance: ['Maintenance', 'info'],
  unknown: ['No data yet', ''],
};

// 100 % stays short; anything less shows two decimals, so 99.95 % isn't rounded up to 100 %
const pct = (v) => (v == null ? '–' : v >= 0.99995 ? '100 %' : `${(Math.floor(v * 10000) / 100).toFixed(2)} %`);
const when = (t, opts = {}) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...opts });
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// 90 days as bars, oldest first; a day without readings stays grey
function bars(days, now) {
  const slots = Array(90).fill(null);
  for (const [t, v] of days) {
    const i = 89 - Math.floor((now - t) / DAY);
    if (i >= 0 && i < 90) slots[i] = slots[i] == null ? v : Math.min(slots[i], v);
  }
  return el('div', { class: 'st-bars', role: 'img', 'aria-label': 'Uptime per day, the last 90 days' }, slots.map((v, i) => {
    const day = new Date(now - (89 - i) * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const cls = v == null ? '' : v >= 0.999 ? 'good' : v >= 0.95 ? 'warning' : 'critical';
    return el('span', { class: cls, title: `${day}: ${v == null ? 'no data' : `${pct(v)} up`}` });
  }));
}

function serviceRow(s, now) {
  const [label, tone] = STATE[s.state] || STATE.unknown;
  const u = s.uptime;
  return el('li', { class: 'st-row' },
    el('div', { class: 'st-line' },
      el('strong', { class: 'st-name', text: s.name }),
      el('span', { class: 'st-uptime num', title: `24 h ${pct(u.d1)} · 7 days ${pct(u.d7)} · 30 days ${pct(u.d30)} · 90 days ${pct(u.d90)}`, text: u.d30 == null ? '' : `${pct(u.d30)} in 30 days` }),
      el('span', { class: `st-state ${tone}` }, el('span', { class: `led ${tone}` }), label)),
    bars(s.days, now));
}

function render(d) {
  document.title = d.title;
  $('st-title').textContent = d.title;
  const down = d.groups.flatMap((g) => g.services).filter((s) => s.state === 'down');
  const [text, tone] = {
    up: ['All services are operational', 'good'],
    down: [`${down.length === 1 ? `${down[0].name} is` : `${down.length} services are`} down`, 'critical'],
    maintenance: ['Planned maintenance in progress', 'info'],
    unknown: ['Waiting for the first checks', ''],
  }[d.overall];
  $('st-overall').className = `status-overall card ${tone}`;
  $('st-overall').replaceChildren(el('span', { class: `led ${tone}` }), el('span', { text }));
  $('st-maint').replaceChildren(...d.maintenance.map((w) => el('p', { class: `st-notice${w.active ? ' on' : ''}` },
    el('strong', { text: w.active ? 'Maintenance now: ' : 'Planned maintenance: ' }), w.name,
    w.active ? ` · until ${clock(w.until)}` : ` · ${when(w.next.start)} – ${clock(w.next.end)}`)));
  const now = Date.now();
  $('st-groups').replaceChildren(...(d.groups.length
    ? d.groups.map((g) => el('section', { class: 'card st-group' },
      el('h2', { text: g.name }),
      el('ul', null, g.services.map((s) => serviceRow(s, now))),
      el('div', { class: 'st-axis small muted' }, el('span', { class: 'ax-90', text: '90 days ago' }), el('span', { class: 'ax-30', text: '30 days ago' }), el('span', { text: 'Today' }))))
    : [el('p', { class: 'empty', text: 'No services are checked yet.' })]));
  $('st-foot').textContent = `Updated ${clock(d.generatedAt)} · refreshes every minute`;
}

async function refresh() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'The status page is switched off.' : `HTTP ${r.status}`);
    render(await r.json());
  } catch (e) {
    $('st-foot').textContent = `Couldn't update: ${e.message}`;
  }
}

refresh();
setInterval(refresh, 60e3);
