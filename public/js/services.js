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
  return el('span', { class: 'svc-status', title, 'aria-label': c.up ? 'Up' : 'Down' },
    el('span', { class: `led ${c.up ? 'good' : 'critical'}` }),
    c.up ? null : el('span', { class: 'small muted', text: 'Down' }));
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
  const sections = d.groups.map((g) => el('section', { class: 'svc-group' },
    el('h2', { text: g.name }),
    el('div', { class: 'svc-grid' }, g.services.map(card))));
  if (d.vms) sections.push(vmsSection(d.vms));
  if (!sections.length) {
    $('groups').replaceChildren(el('p', { class: 'empty' }, 'No services yet. ', d.loggedIn ? el('a', { href: '/admin#services', text: 'Add them in Admin → Services' }) : ''));
    return;
  }
  $('groups').replaceChildren(...sections);
}

// Proxmox VMs and containers
function vmCard(g) {
  const running = g.status === 'running';
  const memF = g.maxmem ? g.mem / g.maxmem : null;
  return el('div', { class: `svc-card card vm-card${running ? '' : ' stopped'}` },
    el('div', { class: 'svc-head' },
      el('span', { class: `vm-type ${g.type}`, text: g.type === 'lxc' ? 'CT' : 'VM', title: g.type === 'lxc' ? 'Container' : 'Virtual machine' }),
      el('div', { class: 'svc-title' },
        el('strong', { text: g.name }),
        el('span', { class: 'small muted num', text: `${g.vmid} · ${g.node}` })),
      el('span', { class: 'svc-status', title: g.status }, el('span', { class: `led ${running ? 'good' : 'off'}` }), running ? null : el('span', { class: 'small muted', text: g.status }))),
    running ? el('div', { class: 'vm-stats small muted num' },
      el('span', { text: `CPU ${fmt.pct(g.cpu, 1)}${g.maxcpu ? ` of ${g.maxcpu}` : ''}` }),
      el('span', { text: `RAM ${fmt.bytes(g.mem)}${memF != null ? ` (${fmt.pct(memF)})` : ''}` }),
      el('span', { text: `Up ${fmt.uptime(g.uptime)}` })) : null);
}

function vmsSection(vms) {
  const shown = vms.items.filter((g) => vms.showStopped || g.status === 'running');
  const running = vms.items.filter((g) => g.status === 'running').length;
  return el('section', { class: 'svc-group', id: 'vms' },
    el('h2', null, 'Virtual machines & containers', el('span', { class: 'count', text: ` ${running} of ${vms.items.length} running` })),
    vms.notes.map((n) => el('p', { class: 'banner', text: n })),
    shown.length ? el('div', { class: 'svc-grid vm-grid' }, shown.map(vmCard)) : el('p', { class: 'empty', text: vms.items.length ? 'No running guests' : 'No VMs or containers' }));
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
