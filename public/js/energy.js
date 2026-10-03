'use strict';
// Energy report: a month (by day) or a year (by month) from the hourly log, per device where it
// was logged, with CSV downloads. The period is kept in the address (#2026-10 or #2026).

const { el, svg, fmt } = HD;
const $ = (id) => document.getElementById(id);
let state = null;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodName = (p) => (p.length === 4 ? p : `${MONTHS[Number(p.slice(5)) - 1]} ${p.slice(0, 4)}`);
const shortKey = (key) => (key.length === 10 ? String(Number(key.slice(8))) : MONTHS[Number(key.slice(5)) - 1].slice(0, 3));
const current = () => location.hash.slice(1) || null;

function shift(period, dir) {
  if (period.length === 4) return String(Number(period) + dir);
  let [y, m] = period.split('-').map(Number);
  m += dir;
  if (m === 0) [y, m] = [y - 1, 12];
  if (m === 13) [y, m] = [y + 1, 1];
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Bars drawn to one scale, a few gridlines, value and cost on hover or tap
function barChart(rows) {
  const wrap = el('div', { class: 'chart energy-chart' });
  const tip = el('div', { class: 'tooltip hidden', role: 'status' });
  const draw = () => {
    const W = Math.max(wrap.clientWidth || 600, 280);
    const H = 190;
    const padL = 44;
    const padB = 22;
    const padT = 10;
    const plotH = H - padB - padT;
    const max = Math.max(0, ...rows.map((r) => r.kwh));
    const raw = max / 3 || 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const top = step * 3;
    const y = (v) => padT + plotH - (v / top) * plotH;
    const band = (W - padL) / rows.length;
    const bw = Math.max(2, Math.min(28, band - 3));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Energy use in kWh, ${rows.length} ${rows[0]?.key.length === 10 ? 'days' : 'months'}; see the table for the values` });
    for (let i = 0; i <= 3; i++) {
      s.append(svg('line', { class: 'gridline', x1: padL, x2: W, y1: y(step * i), y2: y(step * i) }));
      s.append(svg('text', { class: 'axis-label', x: padL - 8, y: y(step * i) + 4, 'text-anchor': 'end' }, fmt.n(step * i, step < 1 ? 1 : 0)));
    }
    const labelEvery = rows.length > 16 ? 5 : 1;
    rows.forEach((r, i) => {
      const cx = padL + band * i + band / 2;
      const h = Math.max(0, y(0) - y(r.kwh));
      const bar = svg('rect', { class: `bar${r.future ? ' future' : ''}`, x: cx - bw / 2, y: y(r.kwh), width: bw, height: h, rx: Math.min(3, bw / 2) });
      const hit = svg('rect', { class: 'hit', x: padL + band * i, y: padT, width: band, height: plotH });
      const show = () => {
        bar.classList.add('active');
        tip.replaceChildren(el('strong', { text: r.key }), r.future ? 'Not yet' : `${fmt.n(r.kwh, 2)} kWh · ${fmt.kr(r.cost)}${r.avgPrice != null ? ` · ${fmt.n(r.avgPrice, 1)} øre/kWh` : ''}`);
        tip.classList.remove('hidden');
        tip.style.left = `${Math.min(Math.max(cx - tip.offsetWidth / 2, 0), W - tip.offsetWidth)}px`;
        tip.style.top = `${Math.max(y(r.kwh) - tip.offsetHeight - 8, 0)}px`;
      };
      const hide = () => {
        bar.classList.remove('active');
        tip.classList.add('hidden');
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('click', show);
      s.append(bar, hit);
      if (i % labelEvery === 0 || i === rows.length - 1) s.append(svg('text', { class: 'axis-label', x: cx, y: H - 6, 'text-anchor': 'middle' }, shortKey(r.key)));
    });
    wrap.replaceChildren(s, tip);
  };
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

function change(now, before) {
  if (!before || before.kwh < 0.001 || now.kwh < 0.001) return null;
  const pct = ((now.kwh - before.kwh) / before.kwh) * 100;
  return `${pct >= 0 ? '+' : '−'}${fmt.n(Math.abs(pct), 0)} % vs ${periodName(state.previous.period)}`;
}

function render(r) {
  state = r;
  document.title = `Energy · ${r.title}`;
  $('title').textContent = r.title;
  $('view-tabs').replaceChildren(...HD.viewTabs('overview', r.loggedIn || r.viewer));
  $('nav').replaceChildren(...(r.loggedIn
    ? [el('a', { class: 'button', href: '/admin#power', text: 'Prices' }), el('button', { type: 'button', text: 'Log out', onclick: HD.logout })]
    : r.viewer ? HD.viewerNav() : [el('a', { class: 'button', href: '/login?next=energy', text: 'Log in' })]));
  const isYear = r.kind === 'year';
  $('en-month').setAttribute('aria-pressed', String(!isYear));
  $('en-year').setAttribute('aria-pressed', String(isYear));
  const options = isYear ? r.periods.years : r.periods.months;
  $('en-period').replaceChildren(...[...new Set([r.period, ...options])].sort().reverse().map((p) => el('option', { value: p, text: periodName(p) })));
  $('en-period').value = r.period;

  // downloads: per day always, per month for a year; Norwegian Excel and standard CSV
  const dl = (by, format, label) => el('a', { class: 'button', href: `/api/energy/export?period=${r.period}&by=${by}&format=${format}`, download: '', text: label });
  $('en-downloads').replaceChildren(
    el('span', { class: 'small muted', text: 'Download' }),
    dl('day', 'no', 'Per day · Excel (NO)'), dl('day', 'std', 'Per day · CSV'),
    ...(isYear ? [dl('month', 'no', 'Per month · Excel (NO)'), dl('month', 'std', 'Per month · CSV')] : []));

  const t = r.totals;
  const tile = (label, value, unit, detail) => el('div', { class: 'tile' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value num' }, value, unit && value !== '–' ? el('small', { text: ` ${unit}` }) : ''),
    detail ? el('div', { class: 'detail', text: detail }) : '');
  $('en-tiles').replaceChildren(
    tile('Used', fmt.n(t.kwh, t.kwh < 10 ? 2 : 1), 'kWh', change(t, r.previous.totals)),
    tile('Cost', fmt.n(t.cost, t.cost < 100 ? 2 : 0), 'kr', r.previous.totals.kwh > 0.001 ? `${fmt.kr(r.previous.totals.cost, 0)} in ${periodName(r.previous.period)}` : ''),
    tile('Average price', t.avgPrice != null ? fmt.n(t.avgPrice, 1) : '–', 'øre/kWh', 'Energy and grid'));

  $('en-chart-title').textContent = isYear ? `Per month, ${r.period} (kWh)` : `Per day, ${periodName(r.period)} (kWh)`;
  const logged = r.rows.filter((x) => !x.future);
  $('en-chart').replaceChildren(
    t.kwh > 0 ? barChart(r.rows) : el('p', { class: 'empty', text: 'Nothing logged in this period.' }),
    el('details', { class: 'table-view' }, el('summary', { text: 'Show as table' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: isYear ? 'Month' : 'Date' }), ['kWh', 'Cost', 'øre/kWh'].map((h) => el('th', { class: 'r', text: h })))),
        el('tbody', null, logged.slice().reverse().map((x) => el('tr', null, el('td', { text: x.key }), el('td', { class: 'r num', text: fmt.n(x.kwh, 2) }), el('td', { class: 'r num', text: fmt.kr(x.cost) }), el('td', { class: 'r num', text: x.avgPrice != null ? fmt.n(x.avgPrice, 1) : '–' }))))))));

  // per device, largest first; shares of everything measured and estimated in the period
  const all = r.devices.reduce((a, d) => a + d.kwh + d.estKwh, 0);
  $('en-devices-card').hidden = !r.devices.length && !r.loggedIn;
  $('en-devices').replaceChildren(r.devices.length
    ? el('div', { class: 'energy-devices' }, r.devices.map((d) => {
      const kwh = d.kwh + d.estKwh;
      const bar = el('div');
      bar.style.width = `${all ? ((kwh / all) * 100).toFixed(1) : 0}%`;
      return el('div', { class: 'meter-row energy-device' },
        el('span', { class: 'label', title: d.name, text: d.name }),
        el('div', null, el('div', { class: 'meter' }, bar),
          el('div', { class: 'small muted num', text: [d.kwh > 0 ? `${fmt.n(d.kwh, 2)} kWh measured` : null, d.estKwh > 0 ? `${fmt.n(d.estKwh, 2)} kWh estimated${r.includeEstimates ? '' : ' (not in cost)'}` : null].filter(Boolean).join(' · ') })),
        el('span', { class: 'value num', text: fmt.kr(d.cost + (r.includeEstimates ? d.estCost : 0), 0) }));
    }))
    : el('p', { class: 'small muted', text: 'Per-device figures are logged from now on; this period only has the total.' }));

  const notes = [];
  if (r.devicesSince && r.devicesSince > Date.parse(`${r.period.length === 4 ? `${r.period}-01` : r.period}-01T00:00:00`)) notes.push(`Per device since ${fmt.time(r.devicesSince)}; earlier days only have the total.`);
  if (!r.includeEstimates) notes.push('Estimated draw is not in the totals (Admin → Power & cost).');
  if (r.fixedIncluded) notes.push('Costs include the fixed monthly fees, spread over the logged hours.');
  if (t.unpricedKwh > 0.01) notes.push(`${fmt.n(t.unpricedKwh, 2)} kWh was logged while no price was available and has no cost.`);
  if (r.loggedSince) notes.push(`Logging since ${fmt.time(r.loggedSince)}.`);
  $('en-notes').textContent = notes.join(' ');
}

async function load() {
  try {
    const p = current();
    const r = await HD.api('GET', `/api/energy/report${p ? `?period=${encodeURIComponent(p)}` : ''}`);
    $('global-error').classList.add('hidden');
    render(r);
  } catch (e) {
    if (e.status === 401) location.href = '/login?next=energy';
    $('global-error').textContent = `Could not load the report: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
}

const go = (p) => {
  location.hash = p;
};
$('en-prev').addEventListener('click', () => state && go(shift(state.period, -1)));
$('en-next').addEventListener('click', () => state && go(shift(state.period, 1)));
$('en-period').addEventListener('change', (e) => go(e.target.value));
$('en-month').addEventListener('click', () => state?.kind === 'year' && go(state.periods.months.find((m) => m.startsWith(state.period)) || `${state.period}-01`));
$('en-year').addEventListener('click', () => state?.kind === 'month' && go(state.period.slice(0, 4)));
window.addEventListener('hashchange', load);
load();
