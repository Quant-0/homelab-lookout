'use strict';
// The change log: everything that changed (settings, devices, services, problems, the network,
// docs, sign-ins), newest first, by day, with a filter, a search and a CSV download.

const { el, api } = HD;
const $ = (id) => document.getElementById(id);

const CAT_LABELS = { settings: 'Settings', devices: 'Devices', services: 'Services', alerts: 'Problems & alerts', network: 'Network', docs: 'Docs', 'sign-in': 'Sign-ins', system: 'System' };
const CAT_ICONS = { settings: 'sliders-horizontal', devices: 'server', services: 'layout-grid', alerts: 'triangle-alert', network: 'globe', docs: 'book-open', 'sign-in': 'key-round', system: 'settings' };
let cat = '';
let q = '';
let shown = [];
let more = false;
let loading = 0;

const dayKey = (t) => new Date(t).toLocaleDateString('en-CA');
function dayName(t) {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 864e5);
  const k = dayKey(t);
  if (k === today) return 'Today';
  if (k === yesterday) return 'Yesterday';
  return new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function query(before) {
  const p = new URLSearchParams();
  if (cat) p.set('cat', cat);
  if (q) p.set('q', q);
  if (before) p.set('before', String(before));
  return p.toString();
}

async function load(older = false) {
  const run = ++loading;
  try {
    const d = await api('GET', `/api/admin/events?${query(older && shown.length ? shown[shown.length - 1].t : 0)}`);
    if (run !== loading) return; // a newer filter is on its way
    HD.shell({ active: 'log', title: d.title, admin: true });
    shown = older ? [...shown, ...d.events] : d.events;
    more = d.more;
    render(d);
    $('global-error').classList.add('hidden');
  } catch (e) {
    $('global-error').textContent = `Could not load the log: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
}

function entry(e) {
  const long = e.detail && e.detail.length > 160;
  const detail = e.detail ? el('div', { class: `log-detail${long ? ' clamped' : ''}`, text: e.detail.replace(/; /g, '\n') }) : null;
  return el('li', { class: `log-entry cat-${e.cat}` },
    el('time', { class: 'num', datetime: new Date(e.t).toISOString(), text: new Date(e.t).toLocaleTimeString('en-GB') }),
    el('span', { class: 'log-cat', title: CAT_LABELS[e.cat] || e.cat }, HD.icon(CAT_ICONS[e.cat] || 'info')),
    el('div', { class: 'log-body' },
      el('div', { class: 'log-text' }, el('span', { text: e.text }), e.by ? el('span', { class: 'log-by', text: e.by }) : null),
      detail,
      long ? el('button', { type: 'button', class: 'link-button', text: 'Show all', onclick: (ev) => {
        const open = detail.classList.toggle('clamped') === false;
        ev.target.textContent = open ? 'Show less' : 'Show all';
      } }) : null));
}

function render(d) {
  $('log-cats').replaceChildren(...[['', 'All'], ...d.categories.map((c) => [c, CAT_LABELS[c] || c])].map(([k, label]) => el('button', {
    type: 'button',
    class: 'log-chip',
    'aria-pressed': String(cat === k),
    onclick: () => {
      cat = k;
      load();
    },
  }, k ? HD.icon(CAT_ICONS[k]) : null, label)));
  const days = new Map();
  for (const e of shown) {
    const k = dayKey(e.t);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  $('log-days').replaceChildren(...(shown.length
    ? [...days].map(([, list]) => el('section', { class: 'log-day' }, el('h2', { text: dayName(list[0].t) }), el('ol', { class: 'log-entries' }, list.map(entry))))
    : [el('p', { class: 'muted log-empty', text: cat || q ? 'Nothing matches this filter.' : 'Nothing has been logged yet.' })]));
  $('log-more').hidden = !more;
  $('log-csv').href = `/api/admin/events.csv?${query()}`;
  $('log-foot').textContent = `Every change, problem and sign-in is kept for ${d.keepDays} days (${d.total.toLocaleString('en-GB')} entries now) and is included in backups. Times are this device's local time; the CSV uses UTC.`;
}

// --- Incidents: each problem from start to end, with who acknowledged it ---

let view = location.hash === '#incidents' ? 'incidents' : 'log';
let incOpenOnly = false;
const dur = (ms) => {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
};
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function renderView() {
  $('log-view').replaceChildren(...[['log', 'Changes'], ['incidents', 'Incidents']].map(([k, t]) => el('button', {
    type: 'button', text: t, 'aria-pressed': String(view === k),
    onclick: () => {
      view = k;
      history.replaceState(null, '', k === 'incidents' ? '#incidents' : location.pathname);
      renderView();
      if (k === 'incidents') loadIncidents();
    },
  })));
  const inc = view === 'incidents';
  $('inc-card').classList.toggle('hidden', !inc);
  for (const sel of ['.log-filters', '.log-list:not(#inc-card)', '#log-foot', '#log-csv']) for (const n of document.querySelectorAll(sel)) n.classList.toggle('hidden', inc);
  document.querySelector('.page-title').textContent = inc ? 'Incidents' : 'Log';
}

let incData = null;
async function loadIncidents() {
  try {
    incData = await api('GET', '/api/admin/incidents');
    renderIncidents();
  } catch (e) {
    $('inc-days').replaceChildren(el('p', { class: 'msg error', text: e.message }));
  }
}

function incEntry(x) {
  const tags = [x.behind ? `behind ${x.behind}` : null, x.maintenance ? 'in maintenance' : null].filter(Boolean);
  return el('li', { class: `log-entry inc ${x.severity}${x.open ? ' open' : ''}${x.behind || x.maintenance ? ' quiet' : ''}` },
    el('time', { class: 'num', text: clock(x.start) }),
    el('span', { class: `inc-dot dot ${x.open ? x.severity : 'off'}`, title: x.severity }),
    el('div', { class: 'log-body' },
      el('div', { class: 'log-text' }, el('span', null, x.subject ? el('strong', { text: `${x.subject}: ` }) : null, x.title)),
      el('div', { class: 'small muted' }, [
        x.open ? `Ongoing, for ${dur(x.duration)}` : `Lasted ${dur(x.duration)}, cleared ${clock(x.end)}${new Date(x.end).toDateString() !== new Date(x.start).toDateString() ? ` on ${new Date(x.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}`,
        x.ack ? `acknowledged ${x.ack.via === 'link' ? 'from the alert message' : `by ${x.ack.by}`} at ${clock(x.ack.at)}` : null,
        ...tags,
      ].filter(Boolean).join(' · '))),
    x.open && !x.ack ? el('button', { type: 'button', class: 'small', text: 'Acknowledge', onclick: async () => {
      try {
        await api('POST', `/api/admin/incidents/${x.id}/ack`);
      } finally {
        loadIncidents();
      }
    } }) : null);
}

function renderIncidents() {
  const list = incData.incidents.filter((x) => !incOpenOnly || x.open);
  const month = incData.incidents.filter((x) => x.start > Date.now() - 30 * 864e5 && !x.behind && !x.maintenance);
  const open = incData.incidents.filter((x) => x.open).length;
  $('inc-summary').replaceChildren(
    el('span', { class: `pill ${open ? 'critical' : 'good'}` }, el('strong', { text: String(open) }), ' open'),
    el('span', { class: 'pill' }, el('strong', { text: String(month.length) }), ' in the last 30 days'),
    el('span', { class: 'pill' }, el('strong', { text: dur(month.reduce((a, x) => a + x.duration, 0)) }), ' of problems in 30 days'),
    el('label', { class: 'check small' }, (() => {
      const cb = el('input', { type: 'checkbox', checked: incOpenOnly });
      cb.addEventListener('change', () => {
        incOpenOnly = cb.checked;
        renderIncidents();
      });
      return cb;
    })(), ' Open only'));
  const days = new Map();
  for (const x of list) {
    const k = dayKey(x.start);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(x);
  }
  $('inc-days').replaceChildren(...(list.length
    ? [...days].map(([, xs]) => el('section', { class: 'log-day' }, el('h2', { text: dayName(xs[0].start) }), el('ol', { class: 'log-entries' }, xs.map(incEntry))))
    : [el('p', { class: 'muted log-empty', text: incOpenOnly ? 'Nothing is open.' : 'No incidents yet.' })]),
  el('p', { class: 'hint', text: `Each problem from when it appeared to when it cleared, kept for ${incData.keepDays} days. Those behind another outage or in maintenance are muted and left out of the totals.` }));
}

let timer = null;
$('log-q').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    q = e.target.value.trim();
    load();
  }, 250);
});
$('log-more').addEventListener('click', () => load(true));

HD.shell({ active: 'log', admin: true });
renderView();
load();
if (view === 'incidents') loadIncidents();
// new entries every 30 s, while the top of the list is in view and no older pages are open
setInterval(() => {
  if (!document.hidden && window.scrollY < 200 && shown.length <= 200) load();
  if (!document.hidden && view === 'incidents') loadIncidents();
}, 30000);
