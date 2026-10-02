'use strict';
// Services page: Homepage-style cards with status and integration numbers.

const { el, fmt } = HD;
const $ = (id) => document.getElementById(id);
let last = null;
let lastAt = null;
let timer = null;

function statusBadge(svc) {
  if (svc.check === undefined) return null; // no connection URL: link only
  if (!svc.check) return el('span', { class: 'svc-status', title: 'Waiting for the first check' }, el('span', { class: 'led off' }));
  const c = svc.check;
  const title = c.up ? `Up · HTTP ${c.code} · ${c.ms} ms` : `Down${c.error ? ` · ${c.error}` : c.code ? ` · HTTP ${c.code}` : ''}`;
  return el('span', { class: 'svc-status', title },
    el('span', { class: `led ${c.up ? 'good' : 'critical'}` }),
    el('span', { class: 'small muted num', text: c.up ? `${c.ms} ms` : 'Down' }));
}

function card(svc) {
  const icon = svc.icon ? el('img', { class: 'svc-icon', src: svc.icon, alt: '' }) : HD.letterIcon(svc.name);
  const body = [
    el('div', { class: 'svc-head' },
      icon,
      el('div', { class: 'svc-title' },
        el('strong', { text: svc.name }),
        svc.description ? el('span', { class: 'small muted', text: svc.description }) : null),
      statusBadge(svc)),
  ];
  if (svc.stats?.length) {
    body.push(el('div', { class: 'svc-stats' }, svc.stats.map((st) => el('div', { class: 'svc-stat' },
      el('span', { class: 'v num', text: HD.statValue(st) }),
      el('span', { class: 'l', text: st.label })))));
  }
  if (svc.error) body.push(el('p', { class: 'svc-error small', text: `${svc.integration}: ${svc.error}` }));
  if (svc.device) body.push(el('div', { class: 'svc-device small muted', text: `on ${svc.device}` }));
  // Links open in a new tab without leaking this page (noopener, no referrer)
  return svc.href
    ? el('a', { class: 'svc-card card', href: svc.href, target: '_blank', rel: 'noopener noreferrer' }, body)
    : el('div', { class: 'svc-card card' }, body);
}

function render(d) {
  document.title = `Services · ${d.title}`;
  $('title').textContent = d.title;
  $('view-tabs').replaceChildren(...HD.viewTabs('services', d.loggedIn));
  $('nav').replaceChildren(...(d.loggedIn
    ? [el('a', { class: 'button', href: '/admin#services', text: 'Edit services' }), el('button', { type: 'button', text: 'Log out', onclick: HD.logout })]
    : [el('a', { class: 'button', href: '/login?next=services', text: 'Log in' })]));
  if (!d.groups.length) {
    $('groups').replaceChildren(el('p', { class: 'empty' }, 'No services yet. ', d.loggedIn ? el('a', { href: '/admin#services', text: 'Add them in Admin → Services' }) : ''));
    return;
  }
  $('groups').replaceChildren(...d.groups.map((g) => el('section', { class: 'svc-group' },
    el('h2', { text: g.name }),
    el('div', { class: 'svc-grid' }, g.services.map(card)))));
}

async function refresh() {
  clearTimeout(timer);
  let delay = 30;
  try {
    const r = await fetch('/api/services', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) {
      location.href = '/login?next=services';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    last = await r.json();
    lastAt = Date.now();
    delay = last.refreshSeconds;
    $('global-error').classList.add('hidden');
    render(last);
  } catch (e) {
    $('global-error').textContent = `Could not load services: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
  tick();
  timer = setTimeout(refresh, Math.max(10, delay) * 1000);
}

function tick() {
  $('updated').textContent = lastAt ? `Updated ${fmt.ago(lastAt)}` : '';
}

document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
setInterval(tick, 5000);
refresh();
