'use strict';
// Updates: what can be updated across devices and apps, from the nightly check and the live polls.

const { el, fmt } = HD;
const $ = (id) => document.getElementById(id);
let checkedHere = 0;
let lastData = null;

function versions(r) {
  if (r.available) {
    if (r.current && r.latest) return el('span', { class: 'upd-versions num' }, r.current, el('span', { class: 'arrow', 'aria-label': 'to', text: ' → ' }), el('strong', { text: r.latest }));
    if (r.latest) return el('span', { class: 'upd-versions num' }, el('strong', { text: r.latest }), ' available');
    return el('span', { class: 'upd-versions' }, r.current ? `${r.current} · ` : '', el('strong', { text: 'new version available' }));
  }
  return el('span', { class: 'upd-versions num muted', text: r.current || '' });
}

function row(r) {
  return el('li', { class: `upd-row${r.available ? ' available' : ''}${r.error ? ' failed' : ''}` },
    el('span', { class: `led ${r.error ? 'warning' : r.available ? 'info' : 'good'}`, 'aria-hidden': 'true' }),
    el('div', { class: 'upd-main' },
      el('div', { class: 'upd-name' }, el('strong', { text: r.name || r.part }), r.name && r.name !== r.part ? el('span', { class: 'muted', text: r.part }) : null),
      r.error ? el('span', { class: 'small msg error', text: r.error }) : versions(r),
      r.detail ? el('span', { class: 'small muted', text: r.detail }) : null,
      r.list?.length ? el('details', { class: 'upd-list' },
        el('summary', { text: r.source === 'proxmox' ? `Show the ${r.list.length} package${r.list.length === 1 ? '' : 's'}` : `Show ${r.list.length}` }),
        el('div', { class: 'table-wrap' }, el('table', null,
          el('thead', null, el('tr', null, ['Name', 'Installed', 'New'].map((t) => el('th', { text: t })))),
          el('tbody', null, r.list.map((x) => el('tr', null, el('td', { text: x.name }), el('td', { class: 'num', text: x.current || '–' }), el('td', { class: 'num', text: x.latest || '–' }))))))) : null),
    r.url ? el('a', { class: 'small upd-notes', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: 'Release notes ↗' }) : null);
}

function section(title, rows, open = true) {
  if (!rows.length) return null;
  const list = el('ul', { class: 'upd-rows' }, rows.map(row));
  return open
    ? el('section', { class: 'card upd-section' }, el('h3', { text: `${title} (${rows.length})` }), list)
    : el('details', { class: 'card upd-section' }, el('summary', null, el('h3', { text: `${title} (${rows.length})` })), list);
}

function render(d) {
  const failed = d.rows.filter((r) => r.error);
  const fresh = d.rows.filter((r) => !r.error);
  const avail = fresh.filter((r) => r.available);
  const ok = fresh.filter((r) => !r.available);
  $('upd-summary').textContent = [
    d.rows.length ? (avail.length ? `${avail.length} of ${d.rows.length} can be updated` : `All ${d.rows.length} up to date`) : 'Nothing to check yet',
    d.checkedAt ? `checked ${fmt.time(d.checkedAt)}` : 'not checked yet',
    `next check ${d.nextCheck}`,
  ].join(' · ');
  const recent = Date.now() - checkedHere < 60000; // the server allows one check a minute
  $('upd-check').disabled = d.running || recent;
  $('upd-check').textContent = d.running ? 'Checking…' : 'Check now';
  $('upd-check').title = recent ? 'Checked just now; you can check again in a minute' : '';
  $('upd-check').hidden = Boolean(d.readOnly); // a remembered device only reads
  $('upd-lists').replaceChildren(...[
    section('Can be updated', avail),
    section("Couldn't check", failed),
    section('Up to date', ok, !avail.length && !failed.length),
  ].filter(Boolean));
  if (!d.rows.length) $('upd-lists').replaceChildren(el('p', { class: 'empty', text: 'Add devices or services with a connection, and they are checked here.' }));
}

async function load() {
  try {
    const d = await HD.api('GET', '/api/updates');
    HD.shell({ active: 'updates', title: d.title, admin: !d.readOnly, viewer: Boolean(d.readOnly), updates: d.rows.filter((r) => !r.error && r.available).length });
    render(d);
    if (d.running) setTimeout(load, 3000);
  } catch (e) {
    $('global-error').textContent = `Could not load updates: ${e.message}`;
    $('global-error').classList.remove('hidden');
  }
}

$('upd-check').addEventListener('click', async () => {
  const b = $('upd-check');
  b.disabled = true;
  b.textContent = 'Checking…';
  $('upd-msg').textContent = '';
  try {
    checkedHere = Date.now();
    lastData = await HD.api('POST', '/api/admin/updates/check', {});
    render(lastData);
    $('upd-msg').textContent = 'Checked';
    $('upd-msg').className = 'msg ok';
    setTimeout(() => lastData && render(lastData), 60500);
  } catch (e) {
    $('upd-msg').textContent = e.message;
    $('upd-msg').className = 'msg error';
    b.disabled = false;
    b.textContent = 'Check now';
  }
});

HD.shell({ active: 'updates', admin: true });
load();
