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

function cardBody(svc) {
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
    // one row; the unit is set smaller so "912 Mbit/s" fits a quarter of a card
    body.push(el('div', { class: 'svc-stats' }, svc.stats.map((st) => {
      const text = HD.statValue(st);
      const m = /^(.*\d)\s+(\D+)$/.exec(text);
      return el('div', { class: 'svc-stat', title: `${st.label}: ${text}` },
        el('span', { class: 'v num' }, m ? m[1] : text, m ? el('small', { text: m[2] }) : null),
        el('span', { class: 'l', text: st.label }));
    })));
  }
  if (svc.error) body.push(el('p', { class: 'svc-error small', text: `${svc.integration}: ${svc.error}` }));
  if (svc.device) body.push(el('div', { class: 'svc-device small muted', text: `on ${svc.device}` }));
  return body;
}

function card(svc) {
  if (editing) {
    const node = el('div', { class: 'svc-card card editable', tabindex: '0', role: 'listitem', 'data-id': svc.id, 'aria-label': `${svc.name}: drag, or use the arrow keys to move` },
      cardBody(svc),
      el('button', { type: 'button', class: 'svc-hide', title: `Hide ${svc.name}`, 'aria-label': `Hide ${svc.name}`, text: '×', onclick: () => hideCard(node, svc) }));
    node.addEventListener('pointerdown', (e) => startDrag(e, node, 'card'));
    node.addEventListener('keydown', (e) => keyMoveCard(e, node));
    cards.set(svc.id, svc);
    return node;
  }
  // Links open in a new tab without leaking this page (noopener, no referrer)
  return svc.href
    ? el('a', { class: 'svc-card card', href: svc.href, target: '_blank', rel: 'noopener noreferrer' }, cardBody(svc))
    : el('div', { class: 'svc-card card' }, cardBody(svc));
}

function setCols(grid, n) {
  grid.classList.toggle('fixed-cols', n > 0);
  if (n > 0) grid.style.setProperty('--cols', String(n));
  else grid.style.removeProperty('--cols');
}

function groupSection(g) {
  const isVms = g.key === VMS;
  const grid = isVms ? vmsGrid(g.vms) : el('div', { class: 'svc-grid', role: editing ? 'list' : null }, (g.services || []).map(card));
  setCols(grid, g.columns);
  let title;
  if (!editing) {
    title = el('h2', null, g.name, isVms ? el('span', { class: 'count', text: ` ${g.vms.items.filter((x) => x.status === 'running').length} of ${g.vms.items.length} running` }) : null);
  } else {
    const cols = el('select', { class: 'cols-select', 'aria-label': `Columns for ${g.name}` },
      el('option', { value: '0', text: 'Columns: auto' }), [1, 2, 3, 4, 5, 6].map((n) => el('option', { value: String(n), text: `${n} column${n === 1 ? '' : 's'}` })));
    cols.value = String(g.columns || 0);
    cols.addEventListener('change', () => setCols(grid, Number(cols.value)));
    const grip = el('button', { type: 'button', class: 'group-grip', title: 'Drag to move the group', 'aria-label': `Move group ${g.name}: drag, or use the up and down arrow keys`, text: '⋮⋮' });
    grip.addEventListener('pointerdown', (e) => startDrag(e, grip.closest('section'), 'group'));
    grip.addEventListener('keydown', (e) => keyMoveGroup(e, grip));
    title = el('div', { class: 'svc-group-edit' }, grip,
      isVms ? el('h2', { text: g.name }) : el('input', { class: 'group-name', value: g.name, maxlength: '32', 'aria-label': 'Group name' }),
      cols);
  }
  return el('section', { class: `svc-group${editing ? ' editing' : ''}`, id: isVms ? 'vms' : null, 'data-key': g.key },
    title,
    isVms ? g.vms.notes.map((n) => el('p', { class: 'banner', text: n })) : null,
    grid);
}

function render(d) {
  document.title = `Services · ${d.title}`;
  HD.shell({ active: 'services', title: d.title, admin: d.loggedIn, viewer: d.viewer });
  $('nav').replaceChildren(...(d.loggedIn
    ? [HD.iconButton('sliders-horizontal', 'Customize', { id: 'customize', disabled: Boolean(editing), onclick: startEdit }),
      HD.iconButton('pencil', 'Edit services', { href: '/admin#services' })]
    : []));
  renderEditBar();
  cards.clear();
  if (!d.groups.length) {
    $('groups').replaceChildren(el('p', { class: 'empty' }, 'No services yet. ', d.loggedIn ? el('a', { href: '/admin#services', text: 'Add them in Admin → Services' }) : ''));
    return;
  }
  $('groups').replaceChildren(...d.groups.map(groupSection));
  fitLabels();
}

// A word too long for its box ("Processing" in a narrow card) is set a little smaller, down to
// 9 px, instead of being cut off
function fitLabels() {
  for (const l of document.querySelectorAll('.svc-stat .l')) {
    l.style.fontSize = '';
    let size = parseFloat(getComputedStyle(l).fontSize);
    while (l.scrollWidth > l.clientWidth + 0.5 && size > 9) {
      size -= 0.5;
      l.style.fontSize = `${size}px`;
    }
  }
}
document.fonts?.ready.then(fitLabels); // measured again once the font has loaded
let fitTimer = null;
addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitLabels, 150);
});

// --- Proxmox VMs and containers ---

function vmCard(g, show = { cpu: true, ram: true, uptime: true }) {
  const running = g.status === 'running';
  const memF = g.maxmem ? g.mem / g.maxmem : null;
  return el('div', { class: `svc-card card vm-card${running ? '' : ' stopped'}` },
    el('div', { class: 'svc-head' },
      el('span', { class: `vm-type ${g.type}`, text: g.type === 'lxc' ? 'CT' : 'VM', title: g.type === 'lxc' ? 'Container' : 'Virtual machine' }),
      el('div', { class: 'svc-title' },
        el('strong', { text: g.name }),
        el('span', { class: 'small muted num', text: `${g.vmid} · ${g.node}` })),
      el('span', { class: 'svc-status', title: g.status }, el('span', { class: `led ${running ? 'good' : 'off'}` }), running ? null : el('span', { class: 'small muted', text: g.status }))),
    running && (show.cpu || show.ram || show.uptime) ? el('div', { class: 'vm-stats small muted num' },
      // CPU and memory as bars that warm up when nearly full
      show.cpu ? vmBar('CPU', g.cpu, `${fmt.pct(g.cpu, 1)}${g.maxcpu ? ` of ${g.maxcpu}` : ''}`) : null,
      show.ram ? vmBar('RAM', memF, `${fmt.bytes(g.mem)}${memF != null ? ` (${fmt.pct(memF)})` : ''}`) : null,
      show.uptime ? el('span', { class: 'vm-up', text: `Up ${fmt.uptime(g.uptime)}` }) : null) : null);
}

function vmBar(label, f, text) {
  const bar = el('i', { class: f >= 0.9 ? 'hot' : null });
  bar.style.setProperty('--w', `${Math.max(2, Math.min(1, f || 0) * 100).toFixed(1)}%`);
  return el('span', { class: 'vm-bar', title: `${label} ${text}` }, el('span', { text: label }), bar, el('span', { class: 'v', text }));
}

function vmsGrid(vms) {
  const shown = vms.items.filter((g) => vms.showStopped || g.status === 'running');
  return shown.length
    ? el('div', { class: 'svc-grid vm-grid' }, shown.map((g) => vmCard(g, vms.show)))
    : el('div', { class: 'svc-grid vm-grid' }, el('p', { class: 'empty', text: vms.items.length ? 'No running guests' : 'No VMs or containers' }));
}

// ---------------------------------------------------------------------------
// Customize: drag cards between groups and groups up and down, hide cards, columns per group.
// The page itself is the draft; Save reads the order back from it.

const VMS = '@vms';
let editing = null; // { hidden: [service cards] } while customizing
const cards = new Map(); // id -> service card data shown in edit mode

function announce(text) {
  $('announce').textContent = text;
}

function startEdit() {
  editing = { hidden: [...(last.hidden || [])] };
  clearTimeout(timer);
  render(last);
  announce('Customizing. Drag cards or groups, or focus one and use the arrow keys.');
}

function stopEdit() {
  editing = null;
  render(last);
  refresh();
}

function renderEditBar() {
  const bar = $('edit-bar');
  bar.classList.toggle('hidden', !editing);
  if (!editing) return bar.replaceChildren();
  const show = el('select', { 'aria-label': 'Show a hidden service', disabled: !editing.hidden.length },
    el('option', { value: '', text: editing.hidden.length ? `Show hidden service (${editing.hidden.length})…` : 'No hidden services' }),
    editing.hidden.map((h) => el('option', { value: h.id, text: `${h.name} (${h.group})` })));
  show.addEventListener('change', () => show.value && unhide(show.value));
  const msg = el('span', { class: 'msg', role: 'status' });
  bar.replaceChildren(
    el('p', { class: 'hint', text: 'Drag services between groups and groups up or down. Keyboard: focus a service and use the arrow keys (up/down changes group).' }),
    show,
    el('button', { type: 'button', text: 'New group', onclick: newGroup }),
    el('button', { type: 'button', text: 'Cancel', onclick: stopEdit }),
    el('button', {
      type: 'button',
      class: 'primary',
      text: 'Save layout',
      onclick: async () => {
        try {
          last = await HD.api('PUT', '/api/admin/services/layout', collectLayout());
          lastAt = Date.now();
          stopEdit();
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      },
    }),
    msg);
}

function sections() {
  return [...$('groups').querySelectorAll('section.svc-group')];
}

function collectLayout() {
  return {
    groups: sections().map((sec) => ({
      key: sec.dataset.key === VMS ? VMS : sec.querySelector('.group-name').value.trim(),
      from: sec.dataset.key, // renamed groups take their hidden services along
      columns: Number(sec.querySelector('.cols-select')?.value || 0),
      services: [...sec.querySelectorAll('.svc-card[data-id]')].map((n) => n.dataset.id),
    })),
    hidden: editing.hidden.map((h) => h.id),
  };
}

function hideCard(node, svc) {
  const sec = node.closest('section');
  editing.hidden.push({ ...svc, group: sec.dataset.key });
  node.remove();
  renderEditBar();
  announce(`${svc.name} hidden`);
}

function unhide(id) {
  const svc = editing.hidden.find((h) => h.id === id);
  editing.hidden = editing.hidden.filter((h) => h.id !== id);
  let sec = sections().find((x) => x.dataset.key !== VMS && (x.querySelector('.group-name').value === svc.group || x.dataset.key === svc.group));
  if (!sec) {
    sec = groupSection({ key: svc.group, name: svc.group, columns: 0, services: [] });
    $('groups').append(sec);
  }
  const node = card(svc);
  sec.querySelector('.svc-grid').append(node);
  renderEditBar();
  node.focus();
  announce(`${svc.name} shown again in ${svc.group}`);
}

function newGroup() {
  const name = (prompt('Name of the new group') || '').trim();
  if (!name) return;
  const sec = groupSection({ key: name, name, columns: 0, services: [] });
  const vms = sections().find((x) => x.dataset.key === VMS);
  if (vms) vms.before(sec);
  else $('groups').append(sec);
  sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  announce(`Group ${name} added. Drag services into it.`);
}

// Where a card would land: the service group under the pointer (or the nearest one), and before
// the first card that comes after the pointer in reading order.
function cardTarget(x, y, placeholder) {
  const secs = sections().filter((s) => s.dataset.key !== VMS);
  let sec = secs.find((s) => {
    const r = s.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  });
  if (!sec) sec = secs.reduce((best, s) => (Math.abs(s.getBoundingClientRect().top - y) < Math.abs(best.getBoundingClientRect().top - y) ? s : best), secs[0]);
  const grid = sec.querySelector('.svc-grid');
  const before = [...grid.children].filter((c) => c !== placeholder).find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top || (y < r.bottom && x < r.left + r.width / 2);
  });
  return { grid, before: before || null };
}

function startDrag(e, node, kind) {
  if (kind === 'card' && e.target.closest('button, select, input')) return;
  HD.dragMove(e, node, {
    placeholderClass: kind === 'card' ? 'svc-placeholder' : 'group-placeholder',
    maxHeight: kind === 'group' ? 140 : 0,
    place: (x, y, ph) => {
      if (kind === 'card') {
        const { grid, before } = cardTarget(x, y, ph);
        if (before) grid.insertBefore(ph, before);
        else if (grid.lastElementChild !== ph) grid.append(ph);
      } else {
        const before = sections().find((s) => y < s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2);
        if (before) before.before(ph);
        else $('groups').append(ph);
      }
    },
    done: (n) => {
      const where = n.closest('section')?.querySelector('.group-name')?.value;
      announce(kind === 'card' ? `${cards.get(n.dataset.id)?.name} moved${where ? ` to ${where}` : ''}` : 'Group moved');
    },
  });
}

function keyMoveCard(e, node) {
  if (e.target !== node || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const name = cards.get(node.dataset.id)?.name;
  if (e.key === 'ArrowLeft' && node.previousElementSibling) node.previousElementSibling.before(node);
  else if (e.key === 'ArrowRight' && node.nextElementSibling) node.nextElementSibling.after(node);
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const secs = sections().filter((s) => s.dataset.key !== VMS);
    const i = secs.indexOf(node.closest('section'));
    const to = secs[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (!to) return;
    to.querySelector('.svc-grid').append(node);
    announce(`${name} moved to ${to.querySelector('.group-name').value}`);
  } else return;
  node.focus();
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') announce(`${name}: position ${[...node.parentElement.children].indexOf(node) + 1}`);
}

function keyMoveGroup(e, grip) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const sec = grip.closest('section');
  if (e.key === 'ArrowUp' && sec.previousElementSibling) sec.previousElementSibling.before(sec);
  else if (e.key === 'ArrowDown' && sec.nextElementSibling) sec.nextElementSibling.after(sec);
  grip.focus();
  announce(`Group moved to position ${sections().indexOf(sec) + 1}`);
}

let loadedOnce = false;
async function refresh() {
  clearTimeout(timer);
  // a tab in the background waits; it refreshes as soon as it is shown again
  if (document.hidden && loadedOnce) return;
  loadedOnce = true;
  let delay = 30;
  try {
    const r = await fetch('/api/services', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) {
      location.href = '/login?next=services';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (editing) return; // keep the draft; refreshing resumes after Save or Cancel
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

document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !editing && refresh());
window.addEventListener('beforeunload', (e) => {
  if (editing) e.preventDefault();
});
setInterval(tick, 5000);
refresh();
