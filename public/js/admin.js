'use strict';

const { api, el, status, fmt } = HD;
const $ = (id) => document.getElementById(id);

const TYPE_TEXT = {
  idrac: {
    username: 'Username',
    usernameHint: 'iDRAC user (a read-only account is enough)',
    secret: 'Password',
    address: 'iDRAC host or IP (default port 443)',
  },
  proxmox: {
    username: 'API token ID',
    usernameHint: 'Full token ID, e.g. root@pam!dashboard. The token needs the PVEAuditor role on /.',
    secret: 'Token secret',
    address: 'Proxmox host or IP (default port 8006)',
  },
  synology: {
    username: 'SNMPv3 user',
    usernameHint: 'In DSM: Control Panel → Terminal & SNMP → SNMP → SNMPv3 service. Use SHA + AES (privacy).',
    secret: 'Authentication password',
    address: 'Synology host or IP (SNMP, default UDP port 161)',
  },
  unifi: {
    username: 'Local account',
    usernameHint: 'A local UniFi OS user with the View Only role for Network, without MFA.',
    secret: 'Password',
    address: 'UniFi OS console host or IP (e.g. the UDM Pro, default port 443)',
  },
  truenas: {
    username: 'Username',
    usernameHint: 'Owner of the API key (e.g. truenas_admin). Leave empty only on versions before 25.04.',
    secret: 'API key',
    address: 'TrueNAS host or IP (default port 443). Connects via wss://…/api/current',
  },
};

let state = null;

function normFp(s) {
  return String(s || '').replace(/[\s:]/g, '').toUpperCase();
}

function showMsg(id, text, ok) {
  const m = $(id);
  m.textContent = text;
  m.className = `msg ${ok ? 'ok' : 'error'}`;
  if (ok) setTimeout(() => m.textContent === text && (m.textContent = ''), 4000);
}

async function load() {
  try {
    state = await api('GET', '/api/admin/config');
    $('whoami').textContent = `Signed in as ${state.user}`;
    $('device-kind').replaceChildren(...state.rackKinds.map((k) => el('option', { value: k, text: Rack.KIND_LABELS[k] || k })));
    fillPower(state.settings.power);
    fillDashboard(state.settings.dashboard);
    appearance = structuredClone(state.settings.appearance);
    renderAppearance();
    rackData = await api('GET', '/api/dashboard').catch(() => null);
    renderDevicesTab();
  } catch (e) {
    $('global-error').textContent = e.message;
    $('global-error').classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Settings

function fillPower(p) {
  const f = $('power-form').elements;
  f.plan.value = p.plan;
  f.area.value = p.area;
  f.vat.checked = p.vat;
  f.markupOre.value = p.markupOre;
  f.supportEnabled.checked = p.support.enabled;
  f.thresholdOre.value = p.support.thresholdOre;
  f.percent.value = p.support.percent;
  f.dayOre.value = p.grid.dayOre;
  f.nightOre.value = p.grid.nightOre;
  f.dayStartHour.value = p.grid.dayStartHour;
  f.dayEndHour.value = p.grid.dayEndHour;
  f.weekendNight.checked = p.grid.weekendNight;
  f.holidayNight.checked = p.grid.holidayNight;
  f.ratesInclVat.checked = p.grid.ratesInclVat;
  f.ratesInclFees.checked = p.grid.ratesInclFees;
  f.elavgiftOre.value = p.grid.elavgiftOre;
  f.enovaOre.value = p.grid.enovaOre;
  f.gridMonthlyKr.value = p.fixed.gridMonthlyKr;
  f.supplierMonthlyKr.value = p.fixed.supplierMonthlyKr;
  f.fixedInclude.checked = p.fixed.include;
  f.includeEstimates.checked = p.includeEstimates;
  updatePlanFields();
}

function powerBody() {
  const p = $('power-form').elements;
  return {
    plan: p.plan.value,
    area: p.area.value,
    vat: p.vat.checked,
    markupOre: Number(p.markupOre.value || 0),
    support: { enabled: p.supportEnabled.checked, thresholdOre: Number(p.thresholdOre.value), percent: Number(p.percent.value) },
    grid: {
      dayOre: Number(p.dayOre.value),
      nightOre: Number(p.nightOre.value),
      ratesInclVat: p.ratesInclVat.checked,
      ratesInclFees: p.ratesInclFees.checked,
      elavgiftOre: Number(p.elavgiftOre.value || 0),
      enovaOre: Number(p.enovaOre.value || 0),
      dayStartHour: Number(p.dayStartHour.value),
      dayEndHour: Number(p.dayEndHour.value),
      weekendNight: p.weekendNight.checked,
      holidayNight: p.holidayNight.checked,
    },
    fixed: {
      gridMonthlyKr: Number(p.gridMonthlyKr.value || 0),
      supplierMonthlyKr: Number(p.supplierMonthlyKr.value || 0),
      include: p.fixedInclude.checked,
    },
    includeEstimates: p.includeEstimates.checked,
  };
}

// Same formula as the server (gridRateAt / priceAt), shown so it can be compared with an invoice.
function updatePlanFields() {
  const f = $('power-form').elements;
  const spot = f.plan.value === 'spot';
  for (const n of document.querySelectorAll('#power-form .spot-only')) n.classList.toggle('hidden', !spot);
  for (const n of document.querySelectorAll('#power-form .fees-only')) n.classList.toggle('hidden', f.ratesInclFees.checked);
  const b = powerBody();
  const vat = b.vat ? 1.25 : 1;
  const grid = (rate) => {
    let ore = b.grid.ratesInclVat ? rate / 1.25 : rate;
    if (!b.grid.ratesInclFees) ore += b.grid.elavgiftOre + b.grid.enovaOre;
    return ore * vat;
  };
  const day = grid(b.grid.dayOre);
  const night = grid(b.grid.nightOre);
  const lines = [`Grid, effective${b.vat ? ' incl. VAT' : ''}: day ${fmt.n(day, 2)} øre/kWh · night/weekend ${fmt.n(night, 2)} øre/kWh`];
  if (b.plan === 'norgespris') {
    const energy = 40 * vat + b.markupOre;
    lines.push(`Energy (Norgespris): ${fmt.n(energy, 2)} øre/kWh → total day ${fmt.n(energy + day, 2)} · night ${fmt.n(energy + night, 2)} øre/kWh`);
  } else lines.push(`Energy: spot price${b.vat ? ' + VAT' : ''}${b.support.enabled ? ' − subsidy' : ''} + ${fmt.n(b.markupOre, 2)} øre markup (varies by hour)`);
  const fixed = b.fixed.gridMonthlyKr + b.fixed.supplierMonthlyKr;
  if (fixed) lines.push(`Fixed: ${fmt.kr(fixed)}/month (${b.fixed.include ? 'included in' : 'excluded from'} homelab cost)`);
  $('price-preview').replaceChildren(...lines.map((l) => el('div', { text: l })));
}

$('power-form').addEventListener('input', updatePlanFields);
$('power-form').addEventListener('change', updatePlanFields);
$('power-form').elements.area.addEventListener('change', (ev) => {
  // Households in Nord-Norge (NO4) are generally exempt from VAT on electricity.
  $('power-form').elements.vat.checked = ev.target.value !== 'NO4';
  updatePlanFields();
});

function fillDashboard(d) {
  const f = $('dash-form').elements;
  f.title.value = d.title;
  f.refreshSeconds.value = d.refreshSeconds;
  f.showStoppedGuests.checked = d.showStoppedGuests;
  f.public.checked = d.public;
}

async function saveSettings(msgId) {
  const d = $('dash-form').elements;
  const body = {
    dashboard: {
      title: d.title.value,
      refreshSeconds: Number(d.refreshSeconds.value),
      showStoppedGuests: d.showStoppedGuests.checked,
      public: d.public.checked,
    },
    power: powerBody(),
  };
  try {
    const r = await api('PUT', '/api/admin/settings', body);
    state.settings = r.settings;
    showMsg(msgId, 'Saved', true);
  } catch (e) {
    showMsg(msgId, e.message, false);
  }
}

$('power-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  saveSettings('power-msg');
});

$('dash-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if ($('dash-form').elements.public.checked && !state.settings.dashboard.public &&
      !confirm('Anyone who can reach this server will be able to view the dashboard without logging in. Continue?')) return;
  saveSettings('dash-msg');
});

$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  if (f.password.value !== f.password2.value) return showMsg('pw-msg', 'New passwords do not match', false);
  try {
    await api('POST', '/api/admin/password', { current: f.current.value, password: f.password.value });
    showMsg('pw-msg', 'Password changed. Other sessions have been signed out.', true);
  } catch (e) {
    showMsg('pw-msg', e.message, false);
  } finally {
    f.current.value = f.password.value = f.password2.value = '';
  }
});

// ---------------------------------------------------------------------------
// Devices: physical boxes with their monitoring connections, placed in the rack

let rackData = null; // dashboard data, for live faceplates and status LEDs
let draft = null; // device in the editor; typed secrets live here only until saved

const KIND_FOR_TYPE = { idrac: 'server', proxmox: 'server', truenas: 'storage', synology: 'nas', unifi: 'gateway' };
const deviceForm = () => $('device-form').elements;
const hostsOf = (dev) => state.hosts.filter((h) => h.deviceId === dev.id);
const placementText = (d) =>
  d.location === 'rack' ? (d.height > 1 ? `U${d.u}–U${d.u + d.height - 1}` : `U${d.u}`) : d.location === 'outside' ? 'Outside the rack' : 'Not placed';

async function refreshDevices() {
  [state, rackData] = await Promise.all([api('GET', '/api/admin/config'), api('GET', '/api/dashboard').catch(() => null)]);
  renderDevicesTab();
}

function fillRackSettings() {
  $('rack-enabled').checked = state.rack.enabled;
  $('rack-units').value = state.rack.units;
  $('rack-numbering').value = state.rack.numbering;
}

function freeU(height, exceptId) {
  for (let u = 1; u + height - 1 <= state.rack.units; u++) {
    if (!state.devices.some((o) => o.id !== exceptId && !o.hidden && o.location === 'rack' && o.u <= u + height - 1 && u <= o.u + o.height - 1)) return u;
  }
  return null;
}

function renderDevicesTab() {
  fillRackSettings();
  const rack = rackData?.rack || { ...state.rack, items: [] };
  Rack.render($('rack-preview'), rack, rackData, {
    uPx: 28,
    editable: true,
    selectedId: draft?.id,
    onSelect: (item) => openDevice(state.devices.find((d) => d.id === item.id)),
    onMove: (item, u) => moveDevice(item, u),
    onEmpty: (u) => openDevice(null, { location: 'rack', u }),
  });
  renderDeviceList();
}

async function moveDevice(item, u) {
  try {
    await api('PUT', `/api/admin/devices/${item.id}/placement`, { location: 'rack', u, height: item.height });
    showMsg('rack-msg', `${item.name} moved to U${u}`, true);
  } catch (e) {
    showMsg('rack-msg', e.message, false);
  }
  await refreshDevices();
}

function deviceRow(d) {
  const item = rackData?.devices?.find((x) => x.id === d.id) || { ...d, links: [] };
  const info = Rack.itemInfo(item, rackData);
  const conns = hostsOf(d);
  const errors = conns.filter((h) => h.status && !h.status.ok).length;
  const missing = conns.filter((h) => !h.hasSecret).length;
  const what = [...conns.map((h) => state.types[h.type].label), d.unifi && !conns.some((h) => h.type === 'unifi') ? 'found via UniFi' : null].filter(Boolean).join(' + ');
  const problems = [errors ? `${errors} with errors` : '', missing ? `${missing} without credentials` : ''].filter(Boolean).join(', ');
  return el('button', { type: 'button', class: `device-row${draft?.id === d.id ? ' selected' : ''}`, onclick: () => openDevice(d) },
    el('span', { class: `led ${info.status || 'off'}`, 'aria-hidden': 'true' }),
    el('span', { class: 'device-main' },
      el('strong', { text: d.name }),
      el('span', { class: 'small muted', text: [Rack.KIND_LABELS[d.kind], placementText(d), d.estimateW ? `~${d.estimateW} W` : ''].filter(Boolean).join(' · ') })),
    el('span', { class: `device-links small${problems ? ' has-problems' : ''}`, text: [what || 'Not monitored', problems].filter(Boolean).join(' · ') }));
}

function renderDeviceList() {
  const rows = [];
  const visible = state.devices.filter((d) => !d.hidden);
  const rackOrder = (d) => (state.rack.numbering === 'top' ? d.u : -d.u);
  for (const [loc, label] of [['rack', 'In the rack'], ['outside', 'Outside the rack'], ['none', 'Not placed']]) {
    const list = visible.filter((d) => d.location === loc).sort((a, b) => (loc === 'rack' ? rackOrder(a) - rackOrder(b) : a.name.localeCompare(b.name)));
    if (list.length) rows.push(el('h4', { text: `${label} (${list.length})` }), ...list.map(deviceRow));
  }
  const hidden = state.devices.filter((d) => d.hidden);
  if (hidden.length) {
    rows.push(el('h4', { text: `Hidden (${hidden.length})` }));
    for (const d of hidden) {
      rows.push(el('div', { class: 'source-row' },
        el('div', { class: 'device-main' }, el('strong', { text: d.name }), el('span', { class: 'small muted', text: 'Found through UniFi; hidden from the dashboard and rack' })),
        el('button', { type: 'button', text: 'Show again', onclick: () => setHidden(d, false) })));
    }
  }
  if (!state.devices.length) rows.push(el('p', { class: 'empty', text: 'No devices yet. Use “Add device” to add a server, NAS, switch… with its connections.' }));
  $('device-list').replaceChildren(...rows);
}

async function setHidden(d, hidden) {
  try {
    await api('PUT', `/api/admin/devices/${d.id}`, { name: d.name, kind: d.kind, location: d.location, u: d.u, height: d.height, estimateW: d.estimateW, hidden });
  } catch (e) {
    showMsg('rack-msg', e.message, false);
  }
  await refreshDevices();
}

function connFromHost(h) {
  return {
    id: h.id, type: h.type, address: h.address, username: h.username, tlsMode: h.tlsMode, fingerprint: h.fingerprint,
    options: { ...h.options }, secret: '', secret2: '', clearSecret: false, hasSecret: h.hasSecret, status: h.status, nodes: h.nodes || [],
    orig: { address: h.address, username: h.username, tlsMode: h.tlsMode, fingerprint: h.fingerprint },
  };
}

function newConn(type) {
  return {
    id: null, type, address: '', username: '', tlsMode: 'pin', fingerprint: '',
    options: type === 'synology' ? { snmpAuth: 'sha' } : type === 'proxmox' ? { node: '' } : {},
    secret: '', secret2: '', clearSecret: false, hasSecret: false, status: null, nodes: [], orig: null,
  };
}

function openDevice(dev, preset = {}) {
  draft = dev
    ? { ...structuredClone(dev), connections: hostsOf(dev).map(connFromHost) }
    : { id: null, name: '', kind: 'server', location: 'rack', u: null, height: 1, estimateW: null, discovered: false, unifi: null, connections: [], ...preset };
  if (!dev && draft.location === 'rack' && !draft.u) draft.u = freeU(draft.height);
  const f = deviceForm();
  f.name.value = draft.name;
  f.kind.value = draft.kind;
  f.location.value = draft.location;
  f.height.value = draft.height;
  f.u.value = draft.u ?? '';
  f.estimateW.value = draft.estimateW ?? '';
  $('device-editor-title').textContent = dev ? `Edit ${dev.name}` : 'Add device';
  $('device-origin').textContent = dev?.discovered
    ? `Found automatically through the UniFi console (${dev.unifi.mac}). Rename it, choose its type and where it sits.`
    : '';
  $('device-delete').hidden = !dev;
  $('device-delete').textContent = dev?.discovered ? 'Hide device' : 'Delete device';
  $('device-msg').textContent = !dev && draft.location === 'rack' && !draft.u ? 'The rack is full: choose a position, or another placement.' : '';
  $('device-msg').className = 'msg';
  $('device-editor').hidden = false;
  renderConnections();
  syncDraft();
  renderDevicesTab();
  $('device-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  f.name.focus();
}

function closeDevice() {
  draft = null; // typed secrets are dropped with the draft
  $('device-editor').hidden = true;
  renderDevicesTab();
}

function syncDraft() {
  if (!draft) return;
  const f = deviceForm();
  draft.name = f.name.value.trim();
  draft.kind = f.kind.value;
  draft.location = f.location.value || 'none';
  draft.height = Number(f.height.value) || 1;
  draft.u = f.u.value === '' ? null : Number(f.u.value);
  draft.estimateW = f.estimateW.value === '' ? null : Number(f.estimateW.value);
  for (const n of document.querySelectorAll('#device-form .rack-only')) n.classList.toggle('hidden', draft.location !== 'rack');
  const types = draft.connections.map((c) => c.type);
  $('device-est-hint').textContent = types.includes('idrac')
    ? 'Power is measured by the iDRAC; an estimate is ignored.'
    : draft.kind === 'ap' ? 'Usually powered by PoE, which is already measured at the switch: leave empty.'
      : draft.kind === 'switch' ? 'Base consumption of the switch itself; PoE delivered to other devices is measured separately.'
        : 'Typical draw (spec sheet or your own measurement). Counted only if enabled under Power & cost.';
  const free = Object.keys(state.types).filter((t) => !types.includes(t));
  $('conn-add').replaceChildren(
    el('option', { value: '', text: free.length ? 'Choose a type…' : 'All connection types added' }),
    ...free.map((t) => el('option', { value: t, text: state.types[t].label })));
  $('conn-add').disabled = !free.length;
}

function renderConnections() {
  $('conn-list').replaceChildren(...(draft.connections.length
    ? draft.connections.map(connCard)
    : [el('p', { class: 'small muted', text: draft.unifi ? 'Monitored through its UniFi console; no connection needed.' : 'No connections: the device is shown in the rack, but not monitored.' })]));
}

function connCard(c) {
  const t = TYPE_TEXT[c.type];
  const snmp = c.type === 'synology';
  const stored = c.hasSecret ? 'Stored (leave blank to keep)' : 'Not set';
  const result = el('div', { class: 'conn-result', role: 'status' });
  const warn = el('p', { class: 'banner hidden' });
  const field = (label, input, hint, cls) => el('label', { class: cls }, el('span', { text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  const input = (key, attrs = {}) => {
    const node = el('input', { value: c[key], spellcheck: 'false', autocomplete: 'off', ...attrs });
    node.addEventListener('input', () => {
      c[key] = node.value;
      updateWarning();
    });
    return node;
  };
  const select = (options, value, onChange) => {
    const node = el('select', null, options.map(([v, label]) => el('option', { value: v, text: label })));
    node.value = value;
    node.addEventListener('change', () => onChange(node.value));
    return node;
  };
  const fpInput = input('fingerprint', { placeholder: snmp ? '80:00:…' : 'AB:CD:…' });
  const fpField = field(snmp ? 'SNMP engine ID (pinned)' : 'SHA-256 fingerprint', fpInput, null, 'wide');
  fpField.classList.toggle('hidden', !snmp && c.tlsMode !== 'pin');

  function updateWarning() {
    const o = c.orig;
    const changed = o && c.hasSecret && !c.secret && !c.clearSecret
      ? [c.address.trim() !== o.address && 'address', c.username.trim() !== o.username && 'user name',
        (c.tlsMode !== o.tlsMode || normFp(c.fingerprint) !== normFp(o.fingerprint)) && (snmp ? 'engine ID' : 'certificate')].filter(Boolean)
      : [];
    warn.textContent = changed.length
      ? `You changed the ${changed.join(', ')}. Unless you enter the ${snmp ? 'SNMP passwords' : t.secret.toLowerCase()} again, the stored one will be deleted so it is never sent to a different host.`
      : '';
    warn.classList.toggle('hidden', !changed.length);
  }

  const statusNode = c.status
    ? c.status.ok ? status('OK', 'good') : status('Error', 'critical')
    : c.id ? status('Pending', '') : status('Not saved yet', '');
  const fields = [
    field('Address', input('address', { placeholder: 'host or IP[:port]' }), t.address),
    field(t.username, input('username'), t.usernameHint),
    field(t.secret, input('secret', { type: 'password', autocomplete: 'new-password', placeholder: stored }), c.hasSecret ? 'Write-only: the stored value is never shown.' : null),
  ];
  if (snmp) {
    fields.push(field('Privacy password (AES)', input('secret2', { type: 'password', autocomplete: 'new-password', placeholder: stored })));
    fields.push(field('Authentication protocol', select([['sha', 'SHA (SHA-1)'], ['sha256', 'SHA-256']], c.options.snmpAuth || 'sha', (v) => (c.options.snmpAuth = v))));
  } else {
    fields.push(field('TLS certificate check', select([['verify', 'Verify with trusted CAs'], ['pin', 'Pin SHA-256 fingerprint (self-signed)']], c.tlsMode, (v) => {
      c.tlsMode = v;
      fpField.classList.toggle('hidden', v !== 'pin');
      updateWarning();
    })));
  }
  if (c.type === 'proxmox') {
    const nodes = [...new Set([...(c.nodes || []), c.options.node].filter(Boolean))];
    fields.push(field('Node', select([['', 'Automatic (single node, or same name as the device)'], ...nodes.map((n) => [n, n])], c.options.node || '', (v) => (c.options.node = v)),
      'For a cluster: the node this device is. Press Test to list the nodes.'));
  }
  fields.push(fpField);
  if (c.hasSecret) {
    const clear = el('input', { type: 'checkbox', checked: c.clearSecret });
    clear.addEventListener('change', () => {
      c.clearSecret = clear.checked;
      updateWarning();
    });
    fields.push(el('label', { class: 'check wide' }, clear, ' Delete the stored secret'));
  }

  const card = el('div', { class: 'conn-card' },
    el('div', { class: 'conn-head' },
      el('strong', { text: state.types[c.type].label }),
      statusNode,
      el('span', { class: 'spacer' }),
      el('button', {
        type: 'button',
        class: 'danger',
        text: 'Remove',
        onclick: () => {
          draft.connections = draft.connections.filter((x) => x !== c);
          renderConnections();
          syncDraft();
        },
      })),
    c.status && !c.status.ok ? el('p', { class: 'small msg error', text: c.status.error }) : null,
    c.type === 'unifi' ? el('p', { class: 'hint', text: 'Switches and access points found through this console appear as their own devices automatically.' }) : null,
    el('div', { class: 'form-grid two' }, fields),
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', text: snmp ? 'Fetch engine ID' : 'Fetch certificate', onclick: () => fetchIdentity(c, fpInput, result) }),
      el('button', { type: 'button', text: 'Test', onclick: () => testConnection(c, result) }),
      el('span', { class: 'hint', text: snmp ? 'Fetching only does an unauthenticated SNMP discovery.' : 'Fetching only does a TLS handshake; nothing else is sent.' })),
    result,
    warn);
  updateWarning();
  return card;
}

async function fetchIdentity(c, fpInput, box) {
  box.replaceChildren('Connecting…');
  try {
    const r = await api('POST', '/api/admin/fingerprint', { type: c.type, address: c.address });
    const value = r.engineId || r.fingerprint;
    const use = el('button', {
      type: 'button',
      text: r.engineId ? 'Use this engine ID' : 'Use this fingerprint',
      onclick: () => {
        c.fingerprint = value;
        fpInput.value = value;
        if (!r.engineId) c.tlsMode = 'pin';
        renderConnections();
      },
    });
    box.replaceChildren(el('div', { class: 'fp-box' },
      el('div', null, el('strong', { text: r.engineId ? 'Engine ID: ' : 'SHA-256: ' }), el('code', { text: value })),
      r.engineId
        ? el('div', { text: `Agent uptime ${fmt.uptime(r.uptime)} · restarts ${r.boots}` })
        : el('div', { text: `${r.subject || '–'} · issued by ${r.issuer || '–'} · valid until ${r.validTo}${r.caTrusted ? ' · trusted by system CAs' : ' · self-signed'}` }),
      el('div', { class: 'hint', text: 'Only use it if this really is your device (compare with what the device shows, if you can).' }),
      el('div', { class: 'form-actions' }, use)));
  } catch (e) {
    box.replaceChildren(el('span', { class: 'msg error', text: e.message }));
  }
}

async function testConnection(c, box) {
  box.replaceChildren(el('span', { class: 'small muted', text: 'Testing…' }));
  try {
    const r = await api('POST', '/api/admin/test-connection', {
      id: c.id || undefined, type: c.type, address: c.address, username: c.username, tlsMode: c.tlsMode,
      fingerprint: c.fingerprint, options: c.options, secret: c.secret, secret2: c.secret2,
    });
    if (r.ok && r.nodes) {
      c.nodes = r.nodes;
      renderConnections(); // refresh the node list
      return;
    }
    box.replaceChildren(r.ok ? el('span', { class: 'msg ok', text: `Connected: ${r.info}` }) : el('span', { class: 'msg error', text: r.error }));
  } catch (e) {
    box.replaceChildren(el('span', { class: 'msg error', text: e.message }));
  }
}

$('conn-add').addEventListener('change', (e) => {
  const type = e.target.value;
  if (!type || !draft) return;
  if (!draft.connections.length && !draft.id && deviceForm().kind.value === 'server') deviceForm().kind.value = KIND_FOR_TYPE[type];
  draft.connections.push(newConn(type));
  renderConnections();
  syncDraft();
  $('conn-list').lastElementChild?.querySelector('input')?.focus();
});
// Fields of the device itself; connection cards and the "add connection" list handle their own events
// (a <select> fires `input` before `change`, and syncDraft rebuilds that list).
const ownField = (e) => !e.target.closest('.conn-card') && e.target.id !== 'conn-add';
$('device-form').addEventListener('input', (e) => ownField(e) && syncDraft());
$('device-form').addEventListener('change', (e) => ownField(e) && syncDraft());
$('device-new').addEventListener('click', () => openDevice(null));
$('device-cancel').addEventListener('click', closeDevice);

$('device-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  syncDraft();
  const d = draft;
  const body = {
    name: d.name, kind: d.kind, location: d.location, u: d.location === 'rack' ? d.u : null, height: d.height, estimateW: d.estimateW, hidden: false,
    connections: d.connections.map((c) => ({
      id: c.id || undefined, type: c.type, address: c.address, username: c.username, tlsMode: c.tlsMode, fingerprint: c.fingerprint,
      options: c.options, secret: c.secret, secret2: c.secret2, clearSecret: c.clearSecret,
    })),
  };
  $('device-save').disabled = true;
  try {
    const r = d.id ? await api('PUT', `/api/admin/devices/${d.id}`, body) : await api('POST', '/api/admin/devices', body);
    closeDevice();
    await refreshDevices();
    showMsg('rack-msg', `Saved ${body.name}`, true);
    if (r.notes?.length) alert(r.notes.join('\n'));
  } catch (e) {
    showMsg('device-msg', e.message, false);
  } finally {
    for (const c of body.connections) c.secret = c.secret2 = '';
    $('device-save').disabled = false;
  }
});

$('device-delete').addEventListener('click', async () => {
  if (!draft?.id) return;
  const n = draft.connections.length;
  const question = draft.discovered
    ? `Hide ${draft.name}? It is found through UniFi, so it is hidden instead of deleted. You can show it again later.`
    : `Delete ${draft.name}${n ? ` and its ${n} connection${n === 1 ? '' : 's'} (stored credentials are deleted)` : ''}?`;
  if (!confirm(question)) return;
  try {
    await api('DELETE', `/api/admin/devices/${draft.id}`);
    showMsg('rack-msg', draft.discovered ? `${draft.name} hidden` : `Deleted ${draft.name}`, true);
    closeDevice();
    await refreshDevices();
  } catch (e) {
    showMsg('device-msg', e.message, false);
  }
});

async function saveRackSettings(next, okText) {
  try {
    const r = await api('PUT', '/api/admin/rack', { ...state.rack, ...next });
    state.rack = r.rack;
    showMsg('rack-msg', okText, true);
  } catch (e) {
    showMsg('rack-msg', e.message, false);
  }
  await refreshDevices();
}
$('rack-enabled').addEventListener('change', (e) => saveRackSettings({ enabled: e.target.checked }, e.target.checked ? 'The rack is shown on the dashboard' : 'The rack is hidden'));
$('rack-units').addEventListener('change', (e) => {
  const units = Number(e.target.value);
  if (!(units >= 1 && units <= 60)) return fillRackSettings();
  saveRackSettings({ units }, `Rack size set to ${units} U`);
});
$('rack-numbering').addEventListener('change', (e) => saveRackSettings({ numbering: e.target.value }, 'Numbering changed'));

// ---------------------------------------------------------------------------
// Services (dashboard Services tab)

let svcState = null; // { services, integrations, devices, icons }
let svcDraft = null; // service in the editor; a typed secret lives here only until saved
const svcForm = () => $('svc-form').elements;

async function loadServices() {
  try {
    svcState = await api('GET', '/api/admin/services');
    renderServiceList();
  } catch (e) {
    showMsg('svc-list-msg', e.message, false);
  }
}

function serviceIcon(svc, cls = 'svc-icon') {
  return svc.icon?.kind === 'file' ? el('img', { class: cls, src: `/media/icon/${svc.icon.id}`, alt: '' }) : HD.letterIcon(svc.name || '?', `${cls} letter`);
}

function renderServiceList() {
  const list = svcState.services;
  const groups = [...new Set(list.map((x) => x.group))];
  $('svc-groups').replaceChildren(...groups.map((g) => el('option', { value: g })));
  if (!list.length) return $('svc-list').replaceChildren(el('p', { class: 'empty', text: 'No services yet. “Add service” to add Jellyfin, Pi-hole, Home Assistant…' }));
  $('svc-list').replaceChildren(...groups.flatMap((g) => [
    el('h4', { text: g }),
    ...list.filter((x) => x.group === g).map((svc) => {
      const r = svc.result;
      const st = !svc.connection ? HD.status('Link only', '')
        : !r?.check ? HD.status('Pending', '') : r.check.up ? HD.status(`Up · ${r.check.ms} ms`, 'good') : HD.status('Down', 'critical');
      const integ = svc.integration ? svcState.integrations[svc.integration.type]?.label : null;
      return el('div', { class: `svc-row${svcDraft?.id === svc.id ? ' selected' : ''}` },
        serviceIcon(svc),
        el('div', { class: 'device-main' },
          el('strong', { text: svc.name }),
          el('span', { class: 'small muted', text: [integ, svc.description].filter(Boolean).join(' · ') || 'Link' }),
          r?.error ? el('span', { class: 'small msg error', text: r.error }) : null),
        st,
        el('span', { class: 'svc-row-actions' },
          el('button', { type: 'button', text: '↑', 'aria-label': `Move ${svc.name} up`, onclick: () => moveService(svc, -1) }),
          el('button', { type: 'button', text: '↓', 'aria-label': `Move ${svc.name} down`, onclick: () => moveService(svc, 1) }),
          el('button', { type: 'button', text: 'Edit', onclick: () => openService(svc) })));
    }),
  ]));
}

async function moveService(svc, dir) {
  const list = svcState.services;
  const same = list.filter((x) => x.group === svc.group);
  const other = same[same.indexOf(svc) + dir];
  if (!other) return;
  const a = list.indexOf(svc);
  const b = list.indexOf(other);
  [list[a], list[b]] = [list[b], list[a]];
  renderServiceList();
  try {
    await api('PUT', '/api/admin/services/order', { ids: list.map((x) => x.id) });
  } catch (e) {
    showMsg('svc-list-msg', e.message, false);
  }
}

function openService(svc) {
  svcDraft = svc
    ? { ...structuredClone(svc), secret: '', clearSecret: false }
    : { id: null, name: '', group: '', description: '', href: '', deviceId: null, icon: { kind: 'letter' }, connection: null, integration: null, secret: '', clearSecret: false, hasSecret: false };
  const f = svcForm();
  f.name.value = svcDraft.name;
  f.group.value = svcDraft.group;
  f.description.value = svcDraft.description;
  f.href.value = svcDraft.href;
  $('svc-device').replaceChildren(el('option', { value: '', text: '–' }), ...svcState.devices.map((d) => el('option', { value: d.id, text: d.name })));
  f.deviceId.value = svcDraft.deviceId || '';
  f.url.value = svcDraft.connection?.url || '';
  f.tlsMode.value = svcDraft.connection?.tlsMode || 'verify';
  f.fingerprint.value = svcDraft.connection?.fingerprint || '';
  const defs = svcState.integrations;
  const byGroup = {};
  for (const [k, d] of Object.entries(defs)) (byGroup[d.group] ||= []).push([k, d]);
  $('svc-integration').replaceChildren(el('option', { value: '', text: 'None (status check only)' }),
    ...Object.entries(byGroup).map(([g, items]) => el('optgroup', { label: g }, items.map(([k, d]) => el('option', { value: k, text: d.label })))));
  f.integration.value = svcDraft.integration?.type || '';
  $('svc-editor-title').textContent = svc ? `Edit ${svc.name}` : 'Add service';
  $('svc-delete').hidden = !svc;
  $('svc-test-result').replaceChildren();
  $('svc-fp-result').classList.add('hidden');
  $('icon-results').replaceChildren();
  $('icon-search').value = '';
  $('svc-msg').textContent = '';
  renderIconPreview();
  renderIntegrationFields();
  syncService();
  $('svc-editor').hidden = false;
  renderServiceList();
  $('svc-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  f.name.focus();
}

function closeService() {
  svcDraft = null;
  $('svc-editor').hidden = true;
  renderServiceList();
}

function renderIconPreview() {
  $('svc-icon-preview').replaceChildren(serviceIcon({ ...svcDraft, name: svcForm().name.value || svcDraft.name }, 'svc-icon large'));
}

function renderIntegrationFields() {
  const type = svcForm().integration.value;
  const def = svcState.integrations[type];
  const box = $('svc-int-fields');
  if (!def) return box.replaceChildren();
  const integ = svcDraft.integration?.type === type ? svcDraft.integration : { type, username: '', options: {} };
  svcDraft.integration = integ;
  const fields = [];
  if (def.user) {
    const u = el('input', { value: integ.username || '', autocomplete: 'off', spellcheck: 'false' });
    u.addEventListener('input', () => (integ.username = u.value));
    fields.push(el('label', null, el('span', { text: def.user }), u));
  }
  if (def.secret) {
    const stored = svcDraft.hasSecret && svcDraft.id ? 'Stored (leave blank to keep)' : def.optionalSecret ? 'Optional' : 'Not set';
    const sec = el('input', { type: 'password', autocomplete: 'new-password', value: svcDraft.secret, placeholder: stored });
    sec.addEventListener('input', () => {
      svcDraft.secret = sec.value;
      syncService();
    });
    fields.push(el('label', null, el('span', { text: def.secret }), sec));
  }
  for (const o of def.options) {
    const input = o.multiline ? el('textarea', { rows: 4, value: integ.options?.[o.key] || '', placeholder: o.placeholder || '' }) : el('input', { value: integ.options?.[o.key] || '', placeholder: o.placeholder || '' });
    input.addEventListener('input', () => ((integ.options ||= {})[o.key] = input.value));
    fields.push(el('label', { class: o.multiline ? 'wide' : null }, el('span', { text: o.label }), input));
  }
  if (svcDraft.hasSecret && svcDraft.id) {
    const clear = el('input', { type: 'checkbox', checked: svcDraft.clearSecret });
    clear.addEventListener('change', () => (svcDraft.clearSecret = clear.checked));
    fields.push(el('label', { class: 'check wide' }, clear, ' Delete the stored secret'));
  }
  box.replaceChildren(...fields);
}

function syncService() {
  if (!svcDraft) return;
  const f = svcForm();
  const url = f.url.value.trim();
  const https = /^https:\/\//i.test(url);
  for (const n of document.querySelectorAll('#svc-form .https-only')) n.classList.toggle('hidden', !https);
  for (const n of document.querySelectorAll('#svc-form .pin-only')) n.classList.toggle('hidden', !https || f.tlsMode.value !== 'pin');
  const def = svcState.integrations[f.integration.value];
  const warn = $('svc-http-warning');
  const sendsSecret = def?.secret && (svcDraft.secret || svcDraft.hasSecret);
  warn.textContent = /^http:\/\//i.test(url) && sendsSecret
    ? 'This URL uses plain http://, so the key/password travels unencrypted over your network. Prefer https:// (e.g. through your reverse proxy) where you can.'
    : '';
  warn.classList.toggle('hidden', !warn.textContent);
}

function serviceBody() {
  const f = svcForm();
  const type = f.integration.value;
  return {
    id: svcDraft.id || undefined,
    name: f.name.value,
    group: f.group.value,
    description: f.description.value,
    href: f.href.value,
    deviceId: f.deviceId.value || null,
    icon: svcDraft.icon,
    connection: f.url.value.trim() ? { url: f.url.value.trim(), tlsMode: f.tlsMode.value, fingerprint: f.fingerprint.value } : null,
    integration: type ? { type, username: svcDraft.integration?.username || '', options: svcDraft.integration?.options || {} } : null,
    secret: svcDraft.secret,
    clearSecret: svcDraft.clearSecret,
  };
}

let iconSearchTimer = null;
$('icon-search').addEventListener('input', (e) => {
  clearTimeout(iconSearchTimer);
  const q = e.target.value.trim();
  iconSearchTimer = setTimeout(async () => {
    if (q.length < 2) return $('icon-results').replaceChildren();
    try {
      const { names } = await api('GET', `/api/admin/icons/search?q=${encodeURIComponent(q)}`);
      $('icon-results').replaceChildren(...(names.length ? names.map((n) => el('button', {
        type: 'button',
        class: 'icon-choice',
        title: n,
        onclick: () => pickLibraryIcon(n),
      }, el('img', { src: `/api/admin/icons/preview/${n}`, alt: '', loading: 'lazy' }), el('span', { text: n }))) : [el('span', { class: 'small muted', text: 'No icons found' })]));
    } catch (err) {
      $('icon-results').replaceChildren(el('span', { class: 'msg error', text: err.message }));
    }
  }, 250);
});

async function pickLibraryIcon(name) {
  try {
    const { icon } = await api('POST', '/api/admin/icons/library', { name });
    svcDraft.icon = { kind: 'file', id: icon.id };
    renderIconPreview();
    $('icon-results').replaceChildren();
    $('icon-search').value = '';
  } catch (e) {
    showMsg('svc-msg', e.message, false);
  }
}

$('icon-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { icon } = await HD.upload('/api/admin/icons', file);
    svcDraft.icon = { kind: 'file', id: icon.id };
    renderIconPreview();
  } catch (err) {
    showMsg('svc-msg', err.message, false);
  }
});
$('icon-letter').addEventListener('click', () => {
  svcDraft.icon = { kind: 'letter' };
  renderIconPreview();
});

$('svc-form').addEventListener('input', (e) => {
  if (e.target.name === 'name') renderIconPreview();
  if (e.target.id !== 'icon-search') syncService();
});
$('svc-form').addEventListener('change', syncService);
$('svc-integration').addEventListener('change', async () => {
  const type = svcForm().integration.value;
  renderIntegrationFields();
  syncService();
  const def = svcState.integrations[type];
  // Choosing an integration fills in the obvious bits: name, group and icon
  if (def && !svcForm().name.value) svcForm().name.value = def.label.split(' / ')[0];
  if (def && !svcForm().group.value) svcForm().group.value = def.group;
  if (def?.icon && svcDraft.icon.kind === 'letter') await pickLibraryIcon(def.icon).catch(() => {});
  renderIconPreview();
});

$('svc-fetch-fp').addEventListener('click', async () => {
  const box = $('svc-fp-result');
  box.classList.remove('hidden');
  box.replaceChildren('Connecting…');
  try {
    const u = new URL(svcForm().url.value.trim());
    const r = await api('POST', '/api/admin/fingerprint', { type: 'idrac', address: `${u.hostname}:${u.port || 443}` });
    box.replaceChildren(
      el('div', null, el('strong', { text: 'SHA-256: ' }), el('code', { text: r.fingerprint })),
      el('div', { text: `${r.subject || '–'} · issued by ${r.issuer || '–'}${r.caTrusted ? ' · trusted by system CAs' : ' · self-signed'}` }),
      el('div', { class: 'form-actions' }, el('button', {
        type: 'button',
        text: 'Use this fingerprint',
        onclick: () => {
          svcForm().tlsMode.value = 'pin';
          svcForm().fingerprint.value = r.fingerprint;
          syncService();
        },
      })));
  } catch (e) {
    box.replaceChildren(el('span', { class: 'msg error', text: e.message }));
  }
});

$('svc-test').addEventListener('click', async () => {
  const out = $('svc-test-result');
  out.replaceChildren(el('span', { class: 'small muted', text: 'Testing…' }));
  try {
    const r = await api('POST', '/api/admin/services/test', serviceBody());
    const parts = [];
    if (r.check) parts.push(r.check.up ? HD.status(`Up · HTTP ${r.check.code} · ${r.check.ms} ms`, 'good') : HD.status(`Down${r.check.error ? `: ${r.check.error}` : r.check.code ? ` (HTTP ${r.check.code})` : ''}`, 'critical'));
    if (r.stats) parts.push(el('span', { class: 'small' }, r.stats.map((st) => `${st.label}: ${HD.statValue(st)}`).join(' · ')));
    if (r.error) parts.push(el('span', { class: 'msg error', text: r.error }));
    out.replaceChildren(...(parts.length ? parts.flatMap((n) => [n, ' ']) : [el('span', { class: 'small muted', text: 'Nothing to test: add a connection URL.' })]));
  } catch (e) {
    out.replaceChildren(el('span', { class: 'msg error', text: e.message }));
  }
});

$('svc-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = serviceBody();
  $('svc-save').disabled = true;
  try {
    const r = svcDraft.id ? await api('PUT', `/api/admin/services/${svcDraft.id}`, body) : await api('POST', '/api/admin/services', body);
    closeService();
    await loadServices();
    showMsg('svc-list-msg', `Saved ${r.service.name}`, true);
    if (r.note) alert(r.note);
  } catch (e) {
    showMsg('svc-msg', e.message, false);
  } finally {
    body.secret = '';
    $('svc-save').disabled = false;
  }
});

$('svc-delete').addEventListener('click', async () => {
  if (!svcDraft?.id || !confirm(`Delete ${svcDraft.name}? Its stored credentials are deleted too.`)) return;
  try {
    await api('DELETE', `/api/admin/services/${svcDraft.id}`);
    closeService();
    await loadServices();
  } catch (e) {
    showMsg('svc-msg', e.message, false);
  }
});
$('svc-new').addEventListener('click', () => openService(null));
$('svc-cancel').addEventListener('click', closeService);

// ---------------------------------------------------------------------------
// Web server (HTTP/HTTPS, ports, certificate)

let web = null;

async function loadWeb() {
  try {
    web = await api('GET', '/api/admin/server');
    const f = $('web-form').elements;
    const s = web.settings;
    f.httpsEnabled.checked = s.https.enabled && Boolean(web.tls);
    f.httpsEnabled.disabled = !web.tls;
    f.httpsPort.value = s.https.port;
    f.httpEnabled.checked = s.http.enabled || !web.tls;
    f.httpPort.value = s.http.port;
    f.httpMode.value = web.tls ? s.http.mode : 'serve';
    renderCert();
    syncWeb();
  } catch (e) {
    showMsg('web-msg', e.message, false);
  }
}

function syncWeb() {
  const f = $('web-form').elements;
  f.httpsPort.disabled = !f.httpsEnabled.checked;
  f.httpPort.disabled = !f.httpEnabled.checked;
  f.httpMode.disabled = !f.httpEnabled.checked || !f.httpsEnabled.checked;
  if (!f.httpsEnabled.checked) f.httpMode.value = 'serve';
  const warn = $('web-warning');
  warn.textContent = !web?.tls
    ? 'No certificate is installed, so only HTTP is possible. Re-run the installer to create the local CA and certificate.'
    : f.httpEnabled.checked && f.httpMode.value === 'serve'
      ? 'HTTP serves the dashboard unencrypted: logins and data travel in plain text (fine inside a VPN, not elsewhere). Sessions are separate per protocol, so you log in separately on HTTP and HTTPS.'
      : '';
  warn.classList.toggle('hidden', !warn.textContent);
}

function renderCert() {
  const t = web.tls;
  if (!t) return $('web-cert').replaceChildren(el('p', { class: 'small muted', text: 'No certificate installed.' }));
  const days = Math.round((t.validTo - Date.now()) / 86400000);
  $('web-cert').replaceChildren(
    el('table', { class: 'facts' }, el('tbody', null,
      el('tr', null, el('th', { text: 'Names' }), el('td', { text: (t.names || '').replace(/IP Address:/g, '').replace(/DNS:/g, '') })),
      el('tr', null, el('th', { text: 'Valid until' }), el('td', null, `${fmt.time(t.validTo)} `, days < 30 ? HD.status(`${days} days left: re-run the installer to renew`, 'warning') : el('span', { class: 'small muted', text: `(${days} days)` }))),
      el('tr', null, el('th', { text: 'Local CA fingerprint' }), el('td', null, el('code', { class: 'small', text: t.caFingerprint || '–' }))))),
    t.caFingerprint ? el('div', { class: 'ca-help' },
      el('p', null, el('a', { class: 'button', href: '/ca.crt', download: 'homelab-dashboard-ca.crt', text: 'Download CA certificate' }),
        ' Import it once on each device, and check that the fingerprint matches the one above.'),
      el('details', null, el('summary', { text: 'How to import' }), el('ul', { class: 'small' },
        el('li', { text: 'iPhone/iPad: open the file → Settings → Profile Downloaded → Install; then Settings → General → About → Certificate Trust Settings → turn it on.' }),
        el('li', { text: 'Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.' }),
        el('li', { text: 'Windows: double-click → Install Certificate → Local Machine → "Trusted Root Certification Authorities".' }),
        el('li', { text: 'macOS: double-click → Keychain Access (System) → open the certificate → Trust → "Always Trust".' }),
        el('li', { text: 'Linux: copy to /usr/local/share/ca-certificates/ and run sudo update-ca-certificates (Firefox: Settings → Certificates → Import).' }),
        el('li', { text: 'The CA can only vouch for this server (its network and host names), so importing it does not let it impersonate other websites.' })))) : null);
}

$('web-form').addEventListener('change', syncWeb);
$('web-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = $('web-form').elements;
  const body = {
    https: { enabled: f.httpsEnabled.checked, port: Number(f.httpsPort.value) },
    http: { enabled: f.httpEnabled.checked, port: Number(f.httpPort.value), mode: f.httpMode.value },
  };
  try {
    const r = await api('PUT', '/api/admin/server', body);
    web = { ...web, ...r };
    // If this page's own address went away, continue on the new one
    const still = [r.urls.https, r.urls.http].some((u) => u && new URL(u).port === location.port && new URL(u).protocol === location.protocol);
    if (!still) {
      const next = r.urls.https || r.urls.http;
      showMsg('web-msg', `Saved. Moving to ${next} …`, true);
      setTimeout(() => (location.href = `${next.replace(/\/$/, '')}/admin#dashboard`), 1200);
      return;
    }
    showMsg('web-msg', `Saved: ${[r.urls.https, r.urls.http].filter(Boolean).join(' and ')}`, true);
  } catch (e) {
    showMsg('web-msg', e.message, false);
  }
});

// ---------------------------------------------------------------------------
// Alerts

let al = null; // status from the server
let chanDraft = null; // channel being edited
let rulesDraft = null;

async function loadAlerts() {
  try {
    al = await api('GET', '/api/admin/alerts');
    renderAlerts();
  } catch (e) {
    showMsg('al-rules-msg', e.message, false);
  }
}

const chanSummary = (c) => (c.type === 'ntfy' ? `${c.url.replace(/^https:\/\//, '')}/${c.topic}`
  : c.type === 'telegram' ? `chat ${c.chatId}`
    : c.type === 'discord' ? (c.hasSecret ? 'webhook set' : 'no webhook')
      : `to ${c.to.join(', ')} via ${c.host}`);

function renderAlerts() {
  $('al-add').replaceChildren(el('option', { value: '', text: 'Add channel…' }), ...Object.entries(al.channelTypes).map(([k, label]) => el('option', { value: k, text: label })));
  $('al-channels').replaceChildren(...(al.channels.length ? al.channels.map((c) => {
    const result = el('span', { class: 'small' });
    const last = c.last;
    return el('div', { class: `svc-row${chanDraft?.id === c.id ? ' selected' : ''}` },
      el('span', { class: `led ${!c.enabled ? 'off' : last ? (last.ok ? 'good' : 'critical') : 'off'}`, 'aria-hidden': 'true' }),
      el('div', { class: 'device-main' },
        el('strong', { text: c.name }),
        el('span', { class: 'small muted', text: `${al.channelTypes[c.type]} · ${chanSummary(c)}${c.enabled ? '' : ' · paused'}` }),
        last && !last.ok ? el('span', { class: 'small msg error', text: `Last send failed: ${last.error}` }) : null,
        result),
      el('span'),
      el('span', { class: 'svc-row-actions' },
        el('button', { type: 'button', text: 'Test', onclick: () => testChannel(c, result) }),
        el('button', { type: 'button', text: 'Edit', onclick: () => openChannel(c) })));
  }) : [el('p', { class: 'small muted', text: 'No channels yet: alerts are only listed on this page.' })]));
  renderRules();
  renderAlertLists();
}

function numField(label, unit, value, min, max, onChange, aria) {
  const n = el('input', { type: 'number', min, max, step: 1, value, 'aria-label': aria });
  n.addEventListener('input', () => onChange(Number(n.value)));
  return el('label', { class: 'inline-num' }, el('span', { text: label }), n, unit ? el('span', { class: 'muted', text: unit }) : null);
}

function renderRules() {
  rulesDraft = structuredClone(al.rules);
  const f = $('al-rules').elements;
  f.resolved.checked = al.settings.resolved;
  f.repeatHours.replaceChildren(...al.repeatOptions.map((h) => el('option', { value: h, text: h ? `Every ${h} h` : 'Never' })));
  f.repeatHours.value = String(al.settings.repeatHours);
  const chans = al.channels;
  const rows = Object.entries(al.types).map(([k, t]) => {
    const r = rulesDraft[k];
    const on = el('input', { type: 'checkbox', checked: r.enabled, 'aria-label': `${t.label}: on` });
    on.addEventListener('change', () => (r.enabled = on.checked));
    const settings = [];
    if (!t.event) settings.push(numField('Wait', 'min', r.delay, 0, 1440, (v) => (r.delay = v), `${t.label}: minutes to wait`));
    for (const [p, d] of Object.entries(t.params)) {
      if (d.type === 'bool') {
        const cb = el('input', { type: 'checkbox', checked: r[p] });
        cb.addEventListener('change', () => (r[p] = cb.checked));
        settings.push(el('label', { class: 'check' }, cb, ` ${d.label}`));
      } else settings.push(numField(d.label, d.unit, r[p], d.min, d.max, (v) => (r[p] = v), `${t.label}: ${d.label}`));
    }
    return el('tr', null,
      el('td', null, el('strong', { text: t.label }), el('div', { class: 'small muted', text: t.hint })),
      el('td', { class: 'c', 'data-label': 'On' }, on),
      el('td', null, el('div', { class: 'rule-settings' }, settings.length ? settings : el('span', { class: 'muted', text: '–' }))),
      chans.length
        ? chans.map((c) => {
          const cb = el('input', { type: 'checkbox', checked: r.channels.includes(c.id), 'aria-label': `Send “${t.label}” to ${c.name}` });
          cb.addEventListener('change', () => (r.channels = cb.checked ? [...r.channels, c.id] : r.channels.filter((x) => x !== c.id)));
          return el('td', { class: 'c', 'data-label': c.name }, cb);
        })
        : k === 'offline' ? el('td', { class: 'small muted', rowspan: Object.keys(al.types).length, text: 'Add a channel first' }) : null);
  });
  $('al-rules-table').replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'rules' },
    el('thead', null, el('tr', null, el('th', { text: 'Alert' }), el('th', { class: 'c', text: 'On' }), el('th', { text: 'Settings' }),
      chans.length ? chans.map((c) => el('th', { class: 'c', text: c.name })) : el('th', { text: 'Send to' }))),
    el('tbody', null, rows))));
}

const sevChip = (severity, event) => (event === 'resolved' ? status('Resolved', 'good')
  : event === 'reminder' ? status('Reminder', severity === 'critical' ? 'critical' : 'warning')
    : status(severity === 'critical' ? 'Critical' : 'Warning', severity === 'critical' ? 'critical' : 'warning'));

function renderAlertLists() {
  $('al-active').replaceChildren(al.active.length
    ? el('ul', { class: 'alert-list' }, al.active.map((a) => el('li', null,
      sevChip(a.severity), ' ', el('strong', { text: a.title }),
      el('div', { class: 'small muted', text: [a.detail, a.firedAt ? `since ${fmt.time(a.since)}` : `waiting before sending (started ${fmt.ago(a.since)})`].filter(Boolean).join(' · ') }))))
    : el('p', { class: 'small' }, status('Nothing wrong right now', 'good')));
  $('al-log').replaceChildren(al.log.length
    ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['When', 'Alert', 'Sent to'].map((t) => el('th', { text: t })))),
      el('tbody', null, al.log.slice(0, 30).map((e) => el('tr', null,
        el('td', { class: 'small nowrap', text: fmt.time(e.at) }),
        el('td', null, sevChip(e.severity, e.event), ' ', el('span', { text: e.title }), e.detail && e.event !== 'resolved' ? el('div', { class: 'small muted', text: e.detail }) : null),
        el('td', null, e.sent.length ? e.sent.map((x) => [status(x.ok ? x.name : `${x.name}: ${x.error}`, x.ok ? 'good' : 'critical'), ' ']) : el('span', { class: 'small muted', text: 'No channel' })))))))
    : el('p', { class: 'small muted', text: 'Nothing sent yet.' }));
}

async function testChannel(c, out) {
  out.textContent = ' Sending…';
  out.className = 'small muted';
  try {
    const r = await api('POST', `/api/admin/alerts/channels/${c.id}/test`, {});
    out.textContent = r.ok ? 'Sent: check that it arrived' : r.error;
    out.className = `small msg ${r.ok ? 'ok' : 'error'}`;
  } catch (e) {
    out.textContent = e.message;
    out.className = 'small msg error';
  }
}

$('al-rules').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    al = await api('PUT', '/api/admin/alerts', { rules: rulesDraft, settings: { resolved: f.resolved.checked, repeatHours: Number(f.repeatHours.value) } });
    renderAlerts();
    showMsg('al-rules-msg', 'Saved', true);
  } catch (e) {
    showMsg('al-rules-msg', e.message, false);
  }
});

$('al-refresh').addEventListener('click', loadAlerts);

// --- channel editor ---

$('al-add').addEventListener('change', (e) => {
  const type = e.target.value;
  e.target.value = '';
  if (type) openChannel({ id: null, type, name: '', enabled: true, url: 'https://ntfy.sh', topic: '', auth: 'none', security: 'starttls', port: 587, tlsMode: 'verify', to: [] });
});

const randomTopic = () => `homelab-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20)}`;

function openChannel(c) {
  chanDraft = { ...c, to: Array.isArray(c.to) ? c.to.join(', ') : c.to || '', secret: '' };
  const box = $('al-editor');
  box.classList.remove('hidden');
  const fieldsBox = el('div', { class: 'form-grid two' });
  const extra = el('div');
  const fpBox = el('div', { class: 'fp-box hidden' });
  const renderFields = () => {
    const fields = [];
    const input = (key, label, attrs = {}, hint = null, cls = null) => {
      const n = el('input', { value: chanDraft[key] ?? '', spellcheck: 'false', autocomplete: 'off', ...attrs });
      n.addEventListener('input', () => {
        chanDraft[key] = attrs.type === 'number' ? Number(n.value) : n.value;
        if (key === 'url') renderWarnings();
      });
      fields.push(el('label', { class: cls }, el('span', { text: label }), n, hint ? el('span', { class: 'hint', text: hint }) : null));
      return n;
    };
    const select = (key, label, options, onChange) => {
      const n = el('select', null, options.map(([v, t]) => el('option', { value: v, text: t })));
      n.value = chanDraft[key];
      n.addEventListener('change', () => {
        chanDraft[key] = n.value;
        if (onChange) onChange(n.value);
        renderFields();
      });
      fields.push(el('label', null, el('span', { text: label }), n));
    };
    const secret = (label) => input('secret', label, { type: 'password', autocomplete: 'new-password', placeholder: c.hasSecret ? 'Stored (leave blank to keep)' : 'Not set' }, null, c.type === 'discord' ? 'wide' : null);
    const tlsFields = (fetchable) => {
      select('tlsMode', 'TLS certificate check', [['verify', 'Verify with trusted CAs'], ['pin', 'Pin SHA-256 fingerprint']]);
      if (chanDraft.tlsMode === 'pin') {
        input('fingerprint', 'Fingerprint', { placeholder: 'AB:CD:…' });
        if (fetchable) {
          fields.push(el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Fetch certificate', onclick: fetchFp })));
        }
      }
    };
    input('name', 'Name', { placeholder: { ntfy: 'Phone (ntfy)', telegram: 'Telegram', discord: 'Discord #homelab', email: 'E-mail' }[c.type] });
    const en = el('input', { type: 'checkbox', checked: chanDraft.enabled });
    en.addEventListener('change', () => (chanDraft.enabled = en.checked));
    fields.push(el('label', { class: 'check' }, en, ' Enabled'));
    if (c.type === 'ntfy') {
      input('url', 'Server', { placeholder: 'https://ntfy.sh' }, 'ntfy.sh or your own server');
      const topic = input('topic', 'Topic', { placeholder: 'homelab-…' });
      fields.push(el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Random topic name', onclick: () => { chanDraft.topic = randomTopic(); topic.value = chanDraft.topic; } })));
      select('auth', 'Login', [['none', 'None'], ['token', 'Access token'], ['basic', 'User name and password']]);
      if (chanDraft.auth === 'basic') input('username', 'User name');
      if (chanDraft.auth !== 'none') secret(chanDraft.auth === 'basic' ? 'Password' : 'Access token');
      if (/^https:/i.test(chanDraft.url || 'https:')) tlsFields(true);
    }
    if (c.type === 'telegram') {
      secret('Bot token');
      input('chatId', 'Chat ID', { placeholder: '123456789' });
    }
    if (c.type === 'discord') secret('Webhook URL');
    if (c.type === 'email') {
      input('host', 'SMTP server', { placeholder: 'smtp.gmail.com' });
      select('security', 'Encryption', [['starttls', 'STARTTLS (usually port 587)'], ['tls', 'TLS (usually port 465)'], ['none', 'None (port 25, local relay without login)']], (v) => {
        chanDraft.port = { starttls: 587, tls: 465, none: 25 }[v];
        if (v === 'none') chanDraft.username = '';
      });
      input('port', 'Port', { type: 'number', min: 1, max: 65535 });
      if (chanDraft.security !== 'none') {
        input('username', 'User name', { placeholder: 'you@gmail.com' });
        secret('Password');
      }
      input('from', 'From', { placeholder: 'homelab@example.com' });
      input('to', 'To', { placeholder: 'you@example.com, other@example.com' }, 'Up to 10, separated by commas');
      if (chanDraft.security !== 'none') tlsFields(chanDraft.security === 'tls');
    }
    fieldsBox.replaceChildren(...fields);
    renderWarnings();
  };
  const renderWarnings = () => {
    const notes = [];
    if (c.type === 'ntfy') {
      if (/^http:/i.test(chanDraft.url || '') && chanDraft.auth !== 'none') notes.push(el('p', { class: 'banner', text: 'This server uses http://, so the token or password is sent unencrypted. Use https:// if you can.' }));
      if (/ntfy\.sh/i.test(chanDraft.url || '') && chanDraft.auth === 'none') notes.push(el('p', { class: 'hint', text: 'Anyone who knows a topic on ntfy.sh can read it: use a long random name (button above). Then subscribe to the same topic in the ntfy app.' }));
    }
    if (c.type === 'telegram') notes.push(el('details', { class: 'small' }, el('summary', { text: 'How to get a bot token and chat ID' }), el('ol', null,
      el('li', { text: 'In Telegram, message @BotFather, send /newbot and copy the token it gives you.' }),
      el('li', { text: 'Send any message to your new bot (or add it to a group).' }),
      el('li', { text: 'Open https://api.telegram.org/bot<token>/getUpdates in your browser and copy "chat":{"id": …}. Group IDs start with -100.' }))));
    if (c.type === 'discord') notes.push(el('p', { class: 'hint', text: 'In Discord: Server settings → Integrations → Webhooks → New webhook → Copy webhook URL. The URL is the secret.' }));
    if (c.type === 'email') notes.push(el('p', { class: 'hint', text: 'Gmail: smtp.gmail.com, STARTTLS, port 587, with an app password (Google account → Security → App passwords).' }));
    extra.replaceChildren(...notes);
  };
  const fetchFp = async () => {
    fpBox.classList.remove('hidden');
    fpBox.replaceChildren('Connecting…');
    try {
      const address = c.type === 'ntfy' ? (() => { const u = new URL(chanDraft.url); return `${u.hostname}:${u.port || 443}`; })() : `${chanDraft.host}:${chanDraft.port}`;
      const r = await api('POST', '/api/admin/fingerprint', { type: 'idrac', address });
      fpBox.replaceChildren(
        el('div', null, el('strong', { text: 'SHA-256: ' }), el('code', { text: r.fingerprint })),
        el('div', { class: 'small', text: `${r.subject || '–'} · issued by ${r.issuer || '–'}${r.caTrusted ? ' · trusted by system CAs' : ' · self-signed'}` }),
        el('div', { class: 'form-actions' }, el('button', { type: 'button', text: 'Use this fingerprint', onclick: () => { chanDraft.fingerprint = r.fingerprint; renderFields(); fpBox.classList.add('hidden'); } })));
    } catch (e) {
      fpBox.replaceChildren(el('span', { class: 'msg error', text: e.message }));
    }
  };
  const msg = el('span', { class: 'msg', role: 'status' });
  const body = () => ({ ...chanDraft, to: String(chanDraft.to || '').split(/[\s,;]+/).filter(Boolean) });
  box.replaceChildren(
    el('h4', { text: `${c.id ? 'Edit' : 'New'} channel: ${al.channelTypes[c.type]}` }),
    fieldsBox, fpBox, extra,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: 'Save channel', onclick: async () => {
        try {
          const r = c.id ? await api('PUT', `/api/admin/alerts/channels/${c.id}`, body()) : await api('POST', '/api/admin/alerts/channels', body());
          al = r.status;
          if (r.note) alert(r.note);
          closeChannel();
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Send test', onclick: async () => {
        msg.textContent = 'Sending…';
        msg.className = 'msg';
        try {
          const r = await api('POST', '/api/admin/alerts/test', { ...body(), id: c.id || undefined, type: c.type });
          msg.textContent = r.ok ? 'Sent: check that it arrived' : r.error;
          msg.className = `msg ${r.ok ? 'ok' : 'error'}`;
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Close', onclick: closeChannel }),
      c.id ? el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: async () => {
        if (!confirm(`Delete the channel ${c.name}? Alerts stop going there.`)) return;
        al = await api('DELETE', `/api/admin/alerts/channels/${c.id}`);
        closeChannel();
      } }) : null,
      msg));
  renderFields();
  renderAlerts();
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeChannel() {
  chanDraft = null;
  $('al-editor').classList.add('hidden');
  $('al-editor').replaceChildren();
  renderAlerts();
}

// ---------------------------------------------------------------------------
// Backup

let bk = null; // status from the server
let destDraft = null; // destination being edited

async function loadBackup() {
  try {
    bk = await api('GET', '/api/admin/backup');
    renderBackup();
  } catch (e) {
    showMsg('bk-schedule-msg', e.message, false);
  }
}

const destSummary = (d) => (d.type === 'folder' ? `${bk.folderBase}/${d.folder || ''}`.replace(/\/$/, '')
  : d.type === 's3' ? `${d.bucket}${d.prefix ? `/${d.prefix}` : ''} · ${new URL(d.endpoint).host}`
    : `${d.user}@${d.host}:${d.path}${d.port !== 22 ? ` (port ${d.port})` : ''}`);

function renderBackup() {
  const f = $('bk-schedule').elements;
  f.enabled.checked = bk.schedule.enabled;
  f.time.value = bk.schedule.time;
  f.keep.value = bk.schedule.keep;
  f.passphrase.value = '';
  f.passphrase.placeholder = bk.hasPassphrase ? 'Stored (leave blank to keep)' : 'Not set';
  $('bk-pass-hint').textContent = bk.hasPassphrase ? 'Write-only. Needed to restore these backups; keep a copy somewhere safe.' : 'Required for automatic backups (min. 12 characters).';
  $('bk-history').replaceChildren(bk.history.length
    ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, ['When', 'Trigger', 'Size', 'Result'].map((t) => el('th', { text: t })))),
      el('tbody', null, bk.history.slice(0, 10).map((h) => el('tr', null,
        el('td', { class: 'small', text: fmt.time(h.at) }), el('td', { class: 'small', text: h.trigger }),
        el('td', { class: 'small num', text: h.bytes ? fmt.bytes(h.bytes) : '–' }),
        el('td', null, h.error ? HD.status(h.error, 'critical')
          : [HD.status('Local copy', 'good'), ...h.results.map((x) => [' ', HD.status(x.ok ? x.name : `${x.name}: ${x.error}`, x.ok ? 'good' : 'critical')])]))))))
    : el('p', { class: 'small muted', text: 'No backups yet.' }));
  $('bk-add').replaceChildren(el('option', { value: '', text: 'Add destination…' }), ...Object.entries(bk.types).map(([k, label]) => el('option', { value: k, text: label })));
  $('bk-dests').replaceChildren(...(bk.destinations.length ? bk.destinations.map((d) => {
    const last = bk.history.find((h) => h.results?.some((x) => x.id === d.id))?.results.find((x) => x.id === d.id);
    const result = el('span', { class: 'small' });
    return el('div', { class: `svc-row${destDraft?.id === d.id ? ' selected' : ''}` },
      el('span', { class: `led ${!d.enabled ? 'off' : last ? (last.ok ? 'good' : 'critical') : 'off'}`, 'aria-hidden': 'true' }),
      el('div', { class: 'device-main' }, el('strong', { text: d.name }), el('span', { class: 'small muted', text: `${bk.types[d.type]} · ${destSummary(d)}${d.enabled ? '' : ' · paused'}` }), result),
      el('span'),
      el('span', { class: 'svc-row-actions' },
        el('button', { type: 'button', text: 'Test', onclick: () => testDestination(d, result) }),
        el('button', { type: 'button', text: 'Edit', onclick: () => openDestination(d) })));
  }) : [el('p', { class: 'small muted', text: 'None yet: backups are only kept on this server.' })]));
  $('bk-local').replaceChildren(bk.local.length
    ? el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'File' }), el('th', { class: 'r', text: 'Size' }), el('th'))),
      el('tbody', null, bk.local.map((x) => el('tr', null,
        el('td', { class: 'small num', text: x.file }), el('td', { class: 'r small num', text: fmt.bytes(x.bytes) }),
        el('td', { class: 'r' },
          el('button', { type: 'button', text: 'Download', onclick: () => downloadLocal(x.file) }), ' ',
          el('button', { type: 'button', text: 'Restore', onclick: () => restoreLocal(x.file) }), ' ',
          el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: () => deleteLocal(x.file) })))))))
    : el('p', { class: 'small muted', text: 'None yet.' }));
}

async function testDestination(d, out) {
  out.textContent = ' Testing…';
  out.className = 'small muted';
  try {
    const r = await api('POST', `/api/admin/backup/destinations/${d.id}/test`, {});
    out.textContent = r.ok ? 'Works' : r.error;
    out.className = `small msg ${r.ok ? 'ok' : 'error'}`;
  } catch (e) {
    out.textContent = e.message;
    out.className = 'small msg error';
  }
}

async function downloadLocal(file) {
  const r = await HD.raw('GET', `/api/admin/backup/local/${file}`);
  HD.saveBlob(await r.blob(), file);
}
async function deleteLocal(file) {
  if (!confirm(`Delete the local copy ${file}?`)) return;
  bk = await api('DELETE', `/api/admin/backup/local/${file}`);
  renderBackup();
}
async function restoreLocal(file) {
  const passphrase = prompt(`Restore ${file}?\n\nThis replaces the current settings, devices, services and docs (the current state is saved as a local copy first).\n\nPassphrase of this backup:`);
  if (!passphrase) return;
  try {
    await api('POST', '/api/admin/backup/restore-local', { file, passphrase });
    alert('Restored. The page will reload.');
    location.reload();
  } catch (e) {
    alert(e.message);
  }
}

$('bk-download').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  showMsg('bk-download-msg', 'Preparing…', true);
  try {
    const r = await HD.raw('POST', '/api/admin/backup/download', { json: { passphrase: f.passphrase.value } });
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'homelab-dashboard.hldb';
    HD.saveBlob(await r.blob(), name);
    showMsg('bk-download-msg', `Saved ${name}`, true);
  } catch (e) {
    showMsg('bk-download-msg', e.message, false);
  } finally {
    f.passphrase.value = '';
  }
});

$('bk-restore').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const file = f.file.files[0];
  if (!file || !confirm(`Restore from ${file.name}? This replaces the current settings, devices, services and docs.`)) return;
  showMsg('bk-restore-msg', 'Restoring…', true);
  try {
    const r = await HD.raw('POST', '/api/admin/backup/restore', {
      body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(f.passphrase.value), 'X-Restore-Admin': f.admin.checked ? '1' : '0', 'X-Restore-Server': f.server.checked ? '1' : '0' },
    });
    const info = await r.json();
    alert(`Restored the backup from ${fmt.time(info.createdAt)} (${info.host}). The page will reload.`);
    location.reload();
  } catch (e) {
    showMsg('bk-restore-msg', e.message, false);
  } finally {
    f.passphrase.value = '';
  }
});

$('bk-schedule').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    bk = await api('PUT', '/api/admin/backup/settings', { schedule: { enabled: f.enabled.checked, time: f.time.value, keep: Number(f.keep.value) }, passphrase: f.passphrase.value });
    renderBackup();
    showMsg('bk-schedule-msg', 'Saved', true);
  } catch (e) {
    showMsg('bk-schedule-msg', e.message, false);
  } finally {
    f.passphrase.value = '';
  }
});

$('bk-run').addEventListener('click', async () => {
  showMsg('bk-schedule-msg', 'Backing up…', true);
  try {
    const r = await api('POST', '/api/admin/backup/run', {});
    bk = r.status;
    renderBackup();
    const failed = r.entry.results.filter((x) => !x.ok);
    showMsg('bk-schedule-msg', failed.length ? `Saved locally; failed: ${failed.map((x) => x.name).join(', ')}` : `Done: ${r.entry.file}`, !failed.length);
  } catch (e) {
    showMsg('bk-schedule-msg', e.message, false);
  }
});

// --- destination editor ---

$('bk-add').addEventListener('change', (e) => {
  const type = e.target.value;
  e.target.value = '';
  if (type) openDestination({ id: null, type, name: '', enabled: true, folder: '', port: 22, region: '', pathStyle: false, tlsMode: 'verify' });
});

function openDestination(d) {
  destDraft = { ...d, secret: '' };
  const box = $('bk-editor');
  box.classList.remove('hidden');
  const fields = [];
  const input = (key, label, attrs = {}, hint = null, cls = null) => {
    const n = el('input', { value: destDraft[key] ?? '', spellcheck: 'false', autocomplete: 'off', ...attrs });
    n.addEventListener('input', () => (destDraft[key] = attrs.type === 'number' ? Number(n.value) : n.value));
    fields.push(el('label', { class: cls }, el('span', { text: label }), n, hint ? el('span', { class: 'hint', text: hint }) : null));
    return n;
  };
  const check = (key, label) => {
    const n = el('input', { type: 'checkbox', checked: destDraft[key] });
    n.addEventListener('change', () => (destDraft[key] = n.checked));
    fields.push(el('label', { class: 'check' }, n, ` ${label}`));
  };
  input('name', 'Name', { placeholder: { folder: 'NAS', s3: 'Backblaze B2', rsync: 'Synology' }[d.type] });
  check('enabled', 'Enabled');
  const extra = [];
  if (d.type === 'folder') {
    input('folder', 'Subfolder', { placeholder: 'e.g. lookout' }, `Saved under ${bk.folderBase}/…`);
    extra.push(el('details', { class: 'small' }, el('summary', { text: 'How to mount a share from the DS418 there' }),
      el('p', { text: bk.folderBaseExists ? `${bk.folderBase} exists.` : `${bk.folderBase} does not exist yet: re-run the installer.` }),
      el('pre', { text: [
        '# NFS (DSM: Control Panel → Shared Folder → Edit → NFS Permissions → allow this VM)',
        `192.168.1.x:/volume1/backups  ${bk.folderBase}  nfs  defaults,_netdev  0 0`,
        '',
        '# or SMB/CIFS (credentials file readable by root only)',
        `//192.168.1.x/backups  ${bk.folderBase}  cifs  credentials=/root/.smb-backup,uid=homelab-dash,gid=homelab-dash,file_mode=0600,dir_mode=0700,_netdev  0 0`,
      ].join('\n') })));
  }
  if (d.type === 's3') {
    input('endpoint', 'Endpoint', { placeholder: 'https://s3.eu-central-003.backblazeb2.com' }, null, 'wide');
    input('region', 'Region', { placeholder: 'eu-central-003' });
    input('bucket', 'Bucket', { placeholder: 'my-homelab-backups' });
    input('prefix', 'Folder in bucket', { placeholder: 'lookout' });
    input('accessKey', 'Access key ID');
    input('secret', 'Secret access key', { type: 'password', autocomplete: 'new-password', placeholder: d.hasSecret ? 'Stored (leave blank to keep)' : 'Not set' });
    check('pathStyle', 'Path-style URLs (MinIO and most self-hosted S3)');
    const tls = el('select', null, el('option', { value: 'verify', text: 'Verify with trusted CAs' }), el('option', { value: 'pin', text: 'Pin SHA-256 fingerprint' }));
    tls.value = destDraft.tlsMode || 'verify';
    tls.addEventListener('change', () => (destDraft.tlsMode = tls.value));
    fields.push(el('label', null, el('span', { text: 'TLS certificate check' }), tls));
    input('fingerprint', 'Fingerprint (when pinned)', { placeholder: 'AB:CD:…' });
  }
  if (d.type === 'rsync') {
    input('host', 'Host', { placeholder: '192.168.1.x' });
    input('port', 'SSH port', { type: 'number', min: 1, max: 65535 });
    input('user', 'User', { placeholder: 'backup' });
    input('path', 'Remote folder', { placeholder: '/volume1/backups/lookout' });
    input('rsyncPath', 'Remote rsync path (optional)', { placeholder: 'only if rsync is not in PATH' });
    if (d.id) {
      const keyOut = el('div');
      const hostOut = el('div');
      const showKey = (pub) => keyOut.replaceChildren(el('p', { class: 'small', text: 'Add this line to ~/.ssh/authorized_keys of the user on the target (it can only be used with this key):' }), el('pre', { class: 'wrap', text: pub }));
      if (d.publicKey) showKey(d.publicKey);
      extra.push(el('h4', { text: 'SSH key' }), keyOut, el('div', { class: 'form-actions' }, el('button', {
        type: 'button',
        text: d.publicKey ? 'Generate a new key' : 'Generate key',
        onclick: async () => {
          if (d.publicKey && !confirm('Replace the key? The old public key stops working.')) return;
          const r = await api('POST', `/api/admin/backup/destinations/${d.id}/sshkey`, {});
          d.publicKey = r.publicKey;
          showKey(r.publicKey);
        },
      })));
      extra.push(el('h4', { text: 'Host key (pinned)' }), hostOut, el('div', { class: 'form-actions' }, el('button', {
        type: 'button',
        text: 'Fetch host key',
        onclick: async () => {
          hostOut.replaceChildren('Connecting…');
          try {
            const r = await api('POST', '/api/admin/backup/keyscan', { host: destDraft.host, port: destDraft.port });
            hostOut.replaceChildren(el('ul', { class: 'small' }, r.fingerprints.map((x) => el('li', null, `${x.type}: `, el('code', { text: x.fingerprint })))),
              el('p', { class: 'small muted', text: 'Compare with the target (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), then trust it.' }),
              el('button', { type: 'button', text: 'Trust this host key', onclick: () => { destDraft.knownHosts = r.knownHosts; hostOut.replaceChildren(el('span', { class: 'msg ok', text: 'Will be pinned when you save.' })); } }));
          } catch (e) {
            hostOut.replaceChildren(el('span', { class: 'msg error', text: e.message }));
          }
        },
      })));
      if (d.knownHosts) hostOut.replaceChildren(el('span', { class: 'small muted', text: `Pinned: ${d.knownHosts.split('\n').map((l) => l.split(' ')[1]).join(', ')}` }));
    } else extra.push(el('p', { class: 'hint', text: 'Save first; then generate the SSH key and pin the host key.' }));
  }
  const msg = el('span', { class: 'msg', role: 'status' });
  box.replaceChildren(
    el('h4', { text: `${d.id ? 'Edit' : 'New'} destination: ${bk.types[d.type]}` }),
    el('div', { class: 'form-grid two' }, fields),
    ...extra,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: 'Save destination', onclick: async () => {
        try {
          const body = { ...destDraft };
          const r = d.id ? await api('PUT', `/api/admin/backup/destinations/${d.id}`, body) : await api('POST', '/api/admin/backup/destinations', body);
          bk = r.status;
          if (r.note) alert(r.note);
          renderBackup();
          if (!d.id && d.type === 'rsync') openDestination(r.destination); // continue with key + host key
          else closeDestination();
        } catch (e) {
          msg.textContent = e.message;
          msg.className = 'msg error';
        }
      } }),
      el('button', { type: 'button', text: 'Close', onclick: closeDestination }),
      d.id ? el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: async () => {
        if (!confirm(`Delete the destination ${d.name}? Files already there are kept.`)) return;
        bk = await api('DELETE', `/api/admin/backup/destinations/${d.id}`);
        closeDestination();
      } }) : null,
      msg));
  renderBackup();
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeDestination() {
  destDraft = null;
  $('bk-editor').classList.add('hidden');
  $('bk-editor').replaceChildren();
  renderBackup();
}

// ---------------------------------------------------------------------------
// Appearance

const THEME_NAMES = {
  auto: 'Auto (system)',
  light: 'Light',
  dark: 'Dark',
  nord: 'Nord',
  dracula: 'Dracula',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-latte': 'Catppuccin Latte',
  'solarized-dark': 'Solarized Dark',
  'solarized-light': 'Solarized Light',
  'gruvbox-dark': 'Gruvbox Dark',
  'tokyo-night': 'Tokyo Night',
};
const BG_NAMES = { aurora: 'Aurora', sunset: 'Sunset', ocean: 'Ocean', forest: 'Forest', nebula: 'Nebula', graphite: 'Graphite' };
const MAX_UPLOAD = 10 * 1024 * 1024;
let appearance = null; // working copy, previewed live

function isBg(type, value) {
  const b = appearance.background;
  return b.type === type && (type === 'none' || (type === 'builtin' ? b.builtin === value : b.imageId === value));
}

function bgOption(label, selected, onPick, visual) {
  return el('button', { type: 'button', class: 'bg-option', 'aria-pressed': String(selected), title: label, onclick: onPick }, visual, el('span', { class: 'bg-name', text: label }));
}

function renderAppearance() {
  // Theme cards carry their own data-theme, so each previews its real colors
  $('theme-grid').replaceChildren(...state.themes.map((t) => el('button', {
    type: 'button',
    class: 'theme-option',
    'data-theme': t,
    'aria-pressed': String(appearance.theme === t),
    onclick: () => {
      appearance.theme = t;
      renderAppearance();
    },
  }, el('strong', { text: THEME_NAMES[t] || t }),
  el('div', { class: 'swatches', 'aria-hidden': 'true' }, ['surface', 'text', 'accent', 'good'].map((k) => el('span', { class: `sw-${k}` }))))));

  const pick = (background) => () => {
    appearance.background = { ...appearance.background, ...background };
    renderAppearance();
  };
  const upload = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  upload.addEventListener('change', () => uploadBackground(upload));
  $('bg-grid').replaceChildren(
    bgOption('None', isBg('none'), pick({ type: 'none' }), el('span', { class: 'bg-swatch' })),
    ...state.builtinBackgrounds.map((b) => bgOption(BG_NAMES[b] || b, isBg('builtin', b), pick({ type: 'builtin', builtin: b }), el('span', { class: `bg-swatch bg-${b}` }))),
    ...state.backgrounds.map((img) => el('div', { class: 'bg-wrap' },
      bgOption(img.name, isBg('image', img.id), pick({ type: 'image', imageId: img.id }), el('img', { src: `/media/bg/${img.id}`, alt: '', loading: 'lazy' })),
      el('button', { type: 'button', class: 'bg-delete danger', title: `Delete ${img.name}`, 'aria-label': `Delete ${img.name}`, text: '×', onclick: () => deleteBackground(img) }))),
    el('label', { class: 'bg-upload' }, upload, el('span', { text: '+ Upload image' })));

  for (const [key, id, unit] of [['blur', 'ap-blur', ' px'], ['dim', 'ap-dim', ' %'], ['cardOpacity', 'ap-opacity', ' %']]) {
    $(id).value = appearance[key];
    $(`${id}-out`).textContent = `${appearance[key]}${unit}`;
  }
  previewAppearance();
}

function previewAppearance() {
  const a = appearance;
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.bg = a.background.type === 'builtin' ? a.background.builtin : a.background.type === 'image' ? 'image' : 'none';
  root.style.setProperty('--bg-blur', `${a.blur}px`);
  root.style.setProperty('--bg-dim', String(a.dim / 100));
  root.style.setProperty('--card-alpha', String(a.cardOpacity / 100));
  document.querySelector('.app-bg').style.backgroundImage = a.background.type === 'image' ? `url("/media/bg/${a.background.imageId}")` : '';
}

for (const [key, id] of [['blur', 'ap-blur'], ['dim', 'ap-dim'], ['cardOpacity', 'ap-opacity']]) {
  $(id).addEventListener('input', () => {
    appearance[key] = Number($(id).value);
    $(`${id}-out`).textContent = `${appearance[key]}${key === 'blur' ? ' px' : ' %'}`;
    previewAppearance();
  });
}

async function uploadBackground(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_UPLOAD) return showMsg('ap-msg', 'Image is larger than 10 MB', false);
  showMsg('ap-msg', 'Uploading…', true);
  try {
    const r = await HD.upload('/api/admin/backgrounds', file);
    state.backgrounds.push(r.background);
    appearance.background = { ...appearance.background, type: 'image', imageId: r.background.id };
    renderAppearance();
    showMsg('ap-msg', 'Uploaded. Save appearance to use it.', true);
  } catch (e) {
    showMsg('ap-msg', e.message, false);
  }
}

async function deleteBackground(img) {
  if (!confirm(`Delete the image “${img.name}”?`)) return;
  try {
    const r = await api('DELETE', `/api/admin/backgrounds/${img.id}`);
    state.backgrounds = state.backgrounds.filter((b) => b.id !== img.id);
    state.settings.appearance = r.appearance;
    if (appearance.background.imageId === img.id) appearance.background = { ...appearance.background, type: 'none', imageId: null };
    renderAppearance();
  } catch (e) {
    showMsg('ap-msg', e.message, false);
  }
}

$('ap-save').addEventListener('click', async () => {
  try {
    const r = await api('PUT', '/api/admin/settings', { appearance });
    state.settings = r.settings;
    appearance = structuredClone(r.settings.appearance);
    renderAppearance();
    showMsg('ap-msg', 'Saved', true);
  } catch (e) {
    showMsg('ap-msg', e.message, false);
  }
});

$('ap-revert').addEventListener('click', () => {
  appearance = structuredClone(state.settings.appearance);
  renderAppearance();
});

// ---------------------------------------------------------------------------
// Tabs (remembered in the URL, e.g. /admin#devices)

const TABS = ['devices', 'services', 'alerts', 'power', 'dashboard', 'appearance', 'backup', 'account'];

function showTab(name, focus) {
  if (name === 'hosts' || name === 'rack') name = 'devices'; // old links
  if (!TABS.includes(name)) name = 'devices';
  for (const t of TABS) {
    const on = t === name;
    $(`tabbtn-${t}`).setAttribute('aria-selected', String(on));
    $(`tabbtn-${t}`).tabIndex = on ? 0 : -1;
    $(`tab-${t}`).hidden = !on;
  }
  if (focus) $(`tabbtn-${name}`).focus();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'devices' && state) refreshDevices(); // picks up newly discovered devices and statuses
  if (name === 'services') loadServices();
  if (name === 'dashboard') loadWeb();
  if (name === 'backup') loadBackup();
  if (name === 'alerts') loadAlerts();
}

for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
document.querySelector('.page-tabs').addEventListener('keydown', (e) => {
  const i = TABS.findIndex((t) => $(`tabbtn-${t}`) === document.activeElement);
  const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
  if (i < 0 || !(e.key in keys)) return;
  e.preventDefault();
  showTab(TABS[(keys[e.key] + TABS.length) % TABS.length], true);
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

$('logout').addEventListener('click', HD.logout);
load();
