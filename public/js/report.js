'use strict';
// The monthly report: uptime, problems, energy and storage for one month, against the month before.

const { el, fmt } = HD;
const $ = (id) => document.getElementById(id);
let period = /^#\d{4}-\d{2}$/.test(location.hash) ? location.hash.slice(1) : null;
let data = null;

const monthName = (p) => new Date(`${p}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const pct = (v) => (v == null ? '–' : `${v >= 99.995 ? '100' : v.toFixed(v >= 99.9 ? 2 : 1)} %`);
const mins = (m) => {
  if (m == null) return '–';
  if (m < 1) return 'none';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
};
// "↑ 2" / "↓ 0.4 pp": the change against last month, coloured by whether it is better
function delta(now, before, { better = 'lower', unit = '', digits = 0 } = {}) {
  if (now == null || before == null) return null;
  const d = now - before;
  if (Math.abs(d) < 10 ** -digits / 2) return el('span', { class: 'delta', text: 'same as last month' });
  const good = better === 'lower' ? d < 0 : d > 0;
  return el('span', { class: `delta ${good ? 'good' : 'bad'}`, text: `${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(digits)}${unit} vs last month` });
}
const tile = (label, value, sub, extra) => el('div', { class: 'tile' }, el('span', { class: 'tile-label', text: label }), el('strong', { class: 'tile-value num', text: value }), sub ? el('span', { class: 'small muted', text: sub }) : null, extra);
const upBar = (v) => el('span', { class: 'up-bar' }, el('i', { style: `width:${Math.max(0, Math.min(100, v ?? 0))}%`, class: v == null ? '' : v >= 99.9 ? 'good' : v >= 99 ? 'warning' : 'critical' }));
const table = (head, rows, empty) => (rows.length
  ? el('div', { class: 'table-wrap' }, el('table', { class: 'report-table' }, el('thead', null, el('tr', null, head.map((h) => el('th', { text: h })))), el('tbody', null, rows)))
  : el('p', { class: 'small muted', text: empty }));

async function load() {
  try {
    data = await HD.api('GET', `/api/report${period ? `?period=${period}` : ''}`);
  } catch (e) {
    $('global-error').textContent = e.message;
    $('global-error').classList.remove('hidden');
    return;
  }
  period = data.period;
  render();
}

function render() {
  const d = data;
  HD.shell({ active: 'report', title: d.title, admin: d.loggedIn, viewer: d.viewer });
  document.title = `${monthName(d.period)} · Monthly report`;
  const sel = $('rp-period');
  sel.replaceChildren(...d.periods.map((p) => el('option', { value: p, text: monthName(p) })));
  sel.value = d.period;
  const i = d.periods.indexOf(d.period);
  $('rp-prev').disabled = i >= d.periods.length - 1;
  $('rp-next').disabled = i <= 0;
  $('rp-partial').textContent = d.partial ? 'This month so far' : '';

  const s = d.summary;
  const e = d.energy;
  $('rp-tiles').replaceChildren(...[
    tile('Service uptime', pct(s.uptime), 'average of all services', delta(s.uptime, s.prevUptime, { better: 'higher', unit: ' pp', digits: 2 })),
    tile('Problems', String(s.incidents.total), `${s.incidents.critical} critical · ${s.incidents.acknowledged} acknowledged`, delta(s.incidents.total, s.prevIncidents.total)),
    tile('Time with problems', mins(s.incidents.minutes), s.incidents.meanClearMin != null ? `cleared in ${mins(s.incidents.meanClearMin)} on average` : 'none cleared yet', delta(s.incidents.minutes, s.prevIncidents.minutes, { unit: ' min' })),
    e ? tile('Energy', `${fmt.n(e.kwh, 0)} kWh`, `${fmt.kr(e.cost, 0)}`, e.previous?.kwh ? delta(e.kwh, e.previous.kwh, { unit: ' kWh' }) : null) : null].filter(Boolean));

  $('rp-services').replaceChildren(table(['Service', 'Uptime', '', 'Down', 'Problems'], d.services.map((x) => el('tr', null,
    el('td', null, el('strong', { text: x.name }), el('div', { class: 'small muted', text: x.group })),
    el('td', { class: 'num', text: pct(x.uptime) }), el('td', { class: 'bar-cell' }, upBar(x.uptime)),
    el('td', { class: 'num', text: x.uptime == null ? 'no readings' : mins(x.downMin) }), el('td', { class: 'num', text: String(x.incidents) }))), 'No services are checked yet: give a service a connection URL or a status check.'));
  $('rp-devices').replaceChildren(table(['Device', 'Uptime', '', 'Down', 'Problems'], d.devices.map((x) => el('tr', null,
    el('td', null, el('strong', { text: x.name })), el('td', { class: 'num', text: pct(x.uptime) }), el('td', { class: 'bar-cell' }, upBar(x.uptime)),
    el('td', { class: 'num', text: mins(x.downMin) }), el('td', { class: 'num', text: String(x.incidents) }))), 'No readings for this month yet.'));
  $('rp-incidents').replaceChildren(table(['Problem', 'Started', 'Lasted', ''], d.longest.map((x) => el('tr', null,
    el('td', null, x.subject ? el('strong', { text: `${x.subject}: ` }) : null, x.title),
    el('td', { class: 'num small', text: new Date(x.start).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }),
    el('td', { class: 'num', text: x.open ? (x.inMonthMin < 1 ? 'just started' : `${mins(x.inMonthMin)} so far`) : mins(Math.round(x.duration / 60e3)) }),
    el('td', { class: 'small muted', text: x.ack ? 'acknowledged' : '' }))), 'No problems this month.'));
  $('rp-storage').replaceChildren(table(['Storage', 'Now', 'This month', 'Growth', 'Full'], d.storage.map((x) => el('tr', null,
    el('td', null, el('strong', { text: x.label }), el('div', { class: 'small muted', text: `${x.device} · ${fmt.bytes(x.size)}` })),
    el('td', { class: 'num', text: `${Math.round(x.pct)} %` }),
    el('td', { class: 'num', text: x.change == null ? '–' : `${x.change > 0 ? '+' : ''}${x.change} pp` }),
    el('td', { class: 'num', text: x.forecast ? `${x.forecast.perMonth > 0 ? '+' : ''}${x.forecast.perMonth} pp a month` : 'needs a week of readings' }),
    el('td', { class: `num${x.forecast?.days != null && x.forecast.days <= 30 ? ' bad' : ''}`, text: x.forecast?.days != null ? `in about ${x.forecast.days} days` : x.forecast ? 'not growing' : '–' }))), 'No storage read yet.'));
}

$('rp-period').addEventListener('change', (ev) => go(ev.target.value));
$('rp-prev').addEventListener('click', () => go(data.periods[data.periods.indexOf(period) + 1]));
$('rp-next').addEventListener('click', () => go(data.periods[data.periods.indexOf(period) - 1]));
$('rp-print').addEventListener('click', () => window.print());
function go(p) {
  if (!p) return;
  period = p;
  history.replaceState(null, '', `#${p}`);
  load();
}

HD.shell({ active: 'report', admin: true });
load();
