'use strict';

const { api, el, status, fmt } = HD;
const $ = (id) => document.getElementById(id);

const TYPE_TEXT = {
  idrac: {
    username: 'Username',
    usernameHint: 'A user on the iDRAC, iLO, XClarity or Supermicro BMC; a read-only role is enough.',
    secret: 'Password',
    address: 'Management controller host or IP (default port 443)',
  },
  snmp: {
    username: 'SNMPv3 user',
    usernameHint: 'A read-only SNMPv3 user with authentication and privacy (SHA + AES). Ports, CPU, storage and UPS values are read with standard MIBs.',
    secret: 'Authentication password',
    address: 'Device host or IP (SNMP, default UDP port 161)',
  },
  nut: {
    username: 'UPS name',
    usernameHint: 'The name in ups.conf on the NUT server, e.g. "ups". Only values are read; no login is needed.',
    secret: null,
    address: 'NUT server host or IP (default port 3493). Its upsd must listen on the network.',
  },
  omada: {
    username: 'Viewer account',
    usernameHint: 'A local Omada account with the Viewer role.',
    secret: 'Password',
    address: 'Omada controller host or IP (default port 443; software controllers often use :8043)',
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
  shelly: {
    username: 'User name (if it has a password)',
    usernameHint: 'Usually admin. Leave both empty if the plug has no login. Gen 2 and newer: keep the login off.',
    secret: 'Password (optional)',
    address: 'The plug\'s host or IP (plain HTTP, port 80)',
  },
  tasmota: {
    username: 'User name (if it has a web password)',
    usernameHint: 'Usually admin. Leave both empty without a web password.',
    secret: 'Web password (optional)',
    address: 'The plug\'s host or IP (plain HTTP, port 80)',
  },
  docker: {
    username: null,
    secret: null,
    address: 'The Docker host and the socket proxy\'s port (default 2375). Only read access: see "Docker" in the guide for the proxy and its firewall line.',
  },
  portainer: {
    username: 'Environment ID',
    usernameHint: 'The number in the environment\'s address in Portainer (…/#!/2/docker/…). Empty = the first environment.',
    secret: 'Access token',
    address: 'Portainer URL, e.g. https://192.168.1.132:9443',
  },
  hass: {
    username: 'Entity ID',
    usernameHint: 'The power sensor in watts or kilowatts, e.g. sensor.server_plug_power (Settings → Entities in Home Assistant).',
    secret: 'Long-lived access token',
    address: 'Home Assistant URL, e.g. http://homeassistant.local:8123',
  },
  ping: {
    username: null,
    secret: null,
    address: 'Host or IP to ping, without a port. Online while it answers; for things without an API (a printer, a Pi).',
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
    HD.shell({ title: state.settings.dashboard.title });
    $('passive-add').replaceChildren(el('option', { value: '', text: 'Add panel…' }), ...Object.entries(Rack.PASSIVE_LABELS).map(([k, l]) => el('option', { value: k, text: l })));
    $('passive-kind').replaceChildren(...Object.entries(Rack.PASSIVE_LABELS).map(([k, l]) => el('option', { value: k, text: l })));
    $('device-front').replaceChildren(...Object.entries(Rack.FRONT_LABELS).map(([k, l]) => el('option', { value: k, text: l })));
    $('device-drives').replaceChildren(...Object.entries(Rack.DRIVE_LABELS).map(([k, l]) => el('option', { value: k, text: l })));
    fillPower(state.settings.power);
    fillDashboard(state.settings.dashboard);
    appearance = structuredClone(state.settings.appearance);
    renderAppearance();
    renderRuntime(state.runtime);
    rackData = await api('GET', '/api/dashboard').catch(() => null);
    renderDevicesTab();
  } catch (e) {
    $('global-error').textContent = e.message;
    $('global-error').classList.remove('hidden');
  }
}

// What runs the dashboard: its version, Node.js (and whether that still gets security fixes),
// and where the graph history is stored
function renderRuntime(rt) {
  if (!rt) return;
  const v = rt.version;
  const rows = [
    ['Homelab Lookout', v ? `${v.commit}${v.deployedAt ? `, deployed ${new Date(v.deployedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Not deployed with the deploy script'],
    ['Node.js', `${rt.node}${rt.nodeEnd ? ` · security fixes ${rt.nodeSupported ? 'until' : 'ended'} ${rt.nodeEnd}` : ''}`],
    ['Graph history', rt.history === 'sqlite' ? 'SQLite database (history.db)' : 'history.json (Node.js 22.5 or newer stores it in a database instead)'],
  ];
  $('runtime').replaceChildren(
    el('div', { class: 'kv' }, rows.map(([k, val]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: val })))),
    rt.nodeSupported ? null : el('p', { class: 'banner', role: 'alert' },
      `Node.js ${parseInt(rt.node, 10)} no longer gets security updates. Install Node.js 24 LTS on this server (see "Updating Node.js" in the README), then restart the service.`));
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

// --- The provider's logo: found automatically, uploaded, from a link, or none ---
let carrierDraft = { kind: 'auto' };
let carrierMode = null; // which choice is open (upload/link stay open until a logo is in)

function renderCarrier() {
  const box = $('carrier-pick');
  if (!box || !state) return;
  const auto = state.carrierAuto || {};
  const mode = carrierMode || (carrierDraft.kind === 'file' ? 'upload' : carrierDraft.kind);
  const src = carrierDraft.kind === 'file' ? `/media/icon/${carrierDraft.id}` : carrierDraft.kind === 'auto' ? auto.url : null;
  const setMode = (k) => {
    carrierMode = k;
    if (k === 'auto' || k === 'none') carrierDraft = { kind: k };
    renderCarrier();
  };
  const useIcon = (icon) => {
    carrierDraft = { kind: 'file', id: icon.id };
    carrierMode = null;
    renderCarrier();
    showMsg('dash-msg', 'Logo ready. Save dashboard settings to use it.', true);
  };
  const parts = [
    el('div', { class: 'logo-head' },
      el('span', { class: 'logo-preview' }, src ? el('img', { src, alt: '' }) : HD.icon('globe')),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Provider logo' }, [['auto', 'Automatic'], ['upload', 'Upload'], ['link', 'Link'], ['none', 'None']].map(([k, label]) => el('button', { type: 'button', 'aria-pressed': String(mode === k), text: label, onclick: () => setMode(k) })))),
  ];
  if (mode === 'auto') {
    const what = auto.iconId && auto.isp === auto.current ? `Found on ${auto.domain}.` : auto.current ? (auto.error && auto.isp === auto.current ? `Nothing found: ${auto.error}.` : 'Not looked up yet; it is looked up from who owns your public IP.') : 'Waiting for the UniFi console to report your provider.';
    parts.push(el('div', { class: 'logo-image' },
      el('span', { class: 'small muted', text: what }),
      auto.current ? el('button', { type: 'button', text: 'Find again', onclick: async (e) => {
        e.target.disabled = true;
        showMsg('dash-msg', 'Looking for the logo…', true);
        try {
          const r = await api('POST', '/api/admin/carrier-logo/auto', {});
          state.carrierAuto = { ...r.carrier, current: auto.current, url: r.url };
          state.settings.dashboard.carrierLogo = { kind: 'auto' };
          carrierDraft = { kind: 'auto' };
          showMsg('dash-msg', r.url ? 'Logo found and saved' : 'No logo found; upload one or paste a link', Boolean(r.url));
        } catch (err) {
          showMsg('dash-msg', err.message, false);
        }
        renderCarrier();
      } }) : null));
  }
  if (mode === 'upload') {
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' });
    upload.addEventListener('change', async () => {
      const file = upload.files[0];
      upload.value = '';
      if (!file) return;
      if (file.size > 1024 * 1024) return showMsg('dash-msg', 'The logo is larger than 1 MB', false);
      try {
        useIcon((await HD.upload('/api/admin/logo', file)).icon);
      } catch (e) {
        showMsg('dash-msg', e.message, false);
      }
    });
    parts.push(el('div', { class: 'logo-image' }, el('label', { class: 'button' }, upload, HD.icon('upload'), 'Upload logo'), el('span', { class: 'small muted', text: 'PNG, JPEG, WebP or SVG, up to 1 MB' })));
  }
  if (mode === 'link') {
    const input = el('input', { type: 'url', id: 'carrier-link', placeholder: 'https://… link to the logo image', 'aria-label': 'Link to the logo image' });
    const use = async () => {
      if (!input.value.trim()) return;
      showMsg('dash-msg', 'Fetching…', true);
      try {
        useIcon((await api('POST', '/api/admin/carrier-logo/url', { url: input.value.trim() })).icon);
      } catch (e) {
        showMsg('dash-msg', e.message, false);
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), use()));
    parts.push(el('div', { class: 'logo-image' }, input, el('button', { type: 'button', text: 'Use', onclick: use })),
      el('p', { class: 'hint', text: 'The dashboard fetches the image once (https only) and keeps a copy; PNG, JPEG, WebP, SVG or .ico.' }));
  }
  box.replaceChildren(el('span', { class: 'carrier-pick-label', text: 'Provider logo' }), ...parts);
}

function fillDashboard(d) {
  const f = $('dash-form').elements;
  f.title.value = d.title;
  f.carrier.value = d.carrier || '';
  carrierDraft = structuredClone(d.carrierLogo || { kind: 'auto' });
  carrierMode = null;
  renderCarrier();
  f.refreshSeconds.value = d.refreshSeconds;
  f.public.checked = d.public;
  f.homeServices.value = d.homeServices;
  f.serviceAlerts.checked = d.serviceAlerts;
  for (const [k, v] of Object.entries(d.vms)) if (f[`vms.${k}`]) f[`vms.${k}`].checked = v;
  const sp = $('sp-form').elements;
  sp.enabled.checked = Boolean(d.statusPage?.enabled);
  sp.title.value = d.statusPage?.title || '';
}

$('sp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    const r = await api('PUT', '/api/admin/settings', { dashboard: { ...state.settings.dashboard, statusPage: { enabled: f.enabled.checked, title: f.title.value } } });
    state.settings = r.settings;
    showMsg('sp-msg', f.enabled.checked ? 'Saved: the status page is public' : 'Saved: the status page is off', true);
  } catch (e) {
    showMsg('sp-msg', e.message, false);
  }
});

async function saveSettings(msgId) {
  const d = $('dash-form').elements;
  const body = {
    dashboard: {
      title: d.title.value,
      carrier: d.carrier.value,
      carrierLogo: carrierDraft,
      refreshSeconds: Number(d.refreshSeconds.value),
      public: d.public.checked,
      homeServices: d.homeServices.value,
      serviceAlerts: d.serviceAlerts.checked,
      vms: Object.fromEntries(Object.entries(state.settings.dashboard.vms).map(([k, v]) => [k, d[`vms.${k}`] ? d[`vms.${k}`].checked : v])),
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
    showMsg('pw-msg', 'Password changed. Other sessions and remembered devices have been signed out.', true);
    loadRemembered();
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

const KIND_FOR_TYPE = { idrac: 'server', proxmox: 'server', truenas: 'storage', synology: 'nas', unifi: 'gateway', snmp: 'switch', nut: 'ups', omada: 'gateway', ping: 'other', shelly: 'server', tasmota: 'server', hass: 'server', docker: 'server', portainer: 'server' };
const SNMP_TYPES = ['synology', 'snmp'];
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

function freeU(height, exceptId, from = 1) {
  const taken = [...state.devices.filter((o) => !o.hidden && o.location === 'rack'), ...state.rack.passive].filter((o) => o.id !== exceptId);
  for (let u = from; u + height - 1 <= state.rack.units; u++) {
    if (!taken.some((o) => o.u <= u + height - 1 && u <= o.u + o.height - 1)) return u;
  }
  return null;
}

function renderDevicesTab() {
  fillRackSettings();
  const rack = rackData?.rack ? { ...rackData.rack, items: rackData.devices } : { ...state.rack, items: [] };
  Rack.render($('rack-preview'), rack, rackData, {
    editable: true,
    selectedId: draft?.id || passiveDraft?.id,
    onSelect: (item) => openDevice(state.devices.find((d) => d.id === item.id)),
    onMove: (item, u) => moveDevice(item, u),
    onSelectPassive: (p) => openPassive(p),
    onMovePassive: (p, u) => savePassive({ ...p, u }, `Moved to U${u}`),
    onEmpty: (u) => showRackAdd(u),
  });
  renderDeviceList();
}

// --- Passive rack items (blank and patch panels, shelves…) and the "add at this U" chooser ---

let passiveDraft = null;

function hideRackSide() {
  $('rack-add').hidden = true;
  $('passive-editor').hidden = true;
  passiveDraft = null;
}

function showRackAdd(u) {
  if (draft) closeDevice();
  hideRackSide();
  $('rack-add-title').textContent = `Add at U${u}`;
  $('rack-add-choices').replaceChildren(
    el('button', { type: 'button', class: 'primary', text: 'Device…', onclick: () => { hideRackSide(); openDevice(null, { location: 'rack', u }); } }),
    ...Object.entries(Rack.PASSIVE_LABELS).map(([kind, label]) => el('button', { type: 'button', text: label, onclick: () => addPassive(kind, u) })),
    el('button', { type: 'button', text: 'Cancel', onclick: () => { hideRackSide(); renderDevicesTab(); } }));
  $('rack-add').hidden = false;
  $('rack-add').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('rack-add-choices').firstChild.focus();
}

async function addPassive(kind, u) {
  try {
    const { item } = await api('POST', '/api/admin/rack/passive', { kind, u, height: 1, ...(kind === 'patch' ? { ports: 24 } : {}) });
    hideRackSide();
    await refreshDevices();
    showMsg('rack-msg', `${Rack.PASSIVE_LABELS[kind]} added at U${u}`, true);
    openPassive(item);
  } catch (e) {
    showMsg('rack-msg', e.message, false);
  }
}

$('passive-add').addEventListener('change', (e) => {
  const kind = e.target.value;
  e.target.value = '';
  if (!kind) return;
  const u = freeU(1);
  if (u === null) return showMsg('rack-msg', 'The rack is full', false);
  addPassive(kind, u);
});

function openPassive(p) {
  if (draft) closeDevice();
  hideRackSide();
  passiveDraft = { ...p };
  const f = $('passive-form').elements;
  f.kind.value = p.kind;
  f.ports.value = String(p.ports || 24);
  f.height.value = p.height;
  f.u.value = p.u;
  $('passive-title').textContent = `${Rack.PASSIVE_LABELS[p.kind]} at U${p.u}`;
  $('passive-msg').textContent = '';
  syncPassive();
  $('passive-editor').hidden = false;
  renderDevicesTab();
  $('passive-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function syncPassive() {
  const f = $('passive-form').elements;
  for (const n of document.querySelectorAll('#passive-form .patch-only')) n.classList.toggle('hidden', f.kind.value !== 'patch');
}

async function savePassive(p, okText) {
  try {
    await api('PUT', `/api/admin/rack/passive/${p.id}`, { kind: p.kind, u: p.u, height: p.height, ports: p.ports });
    showMsg('rack-msg', okText || `${Rack.PASSIVE_LABELS[p.kind]} saved`, true);
    return true;
  } catch (e) {
    showMsg(passiveDraft ? 'passive-msg' : 'rack-msg', e.message, false);
    return false;
  } finally {
    await refreshDevices();
  }
}

$('passive-form').addEventListener('change', syncPassive);
$('passive-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const p = { ...passiveDraft, kind: f.kind.value, height: Number(f.height.value), u: Number(f.u.value), ports: f.kind.value === 'patch' ? Number(f.ports.value) : undefined };
  if (await savePassive(p)) {
    hideRackSide();
    renderDevicesTab();
  }
});
$('passive-close').addEventListener('click', () => {
  hideRackSide();
  renderDevicesTab();
});
$('passive-delete').addEventListener('click', async () => {
  if (!passiveDraft) return;
  try {
    await api('DELETE', `/api/admin/rack/passive/${passiveDraft.id}`);
    showMsg('rack-msg', `${Rack.PASSIVE_LABELS[passiveDraft.kind]} removed`, true);
    hideRackSide();
    await refreshDevices();
  } catch (e) {
    showMsg('passive-msg', e.message, false);
  }
});

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
  const what = [...conns.map((h) => state.types[h.type].short || state.types[h.type].label), d.unifi && !conns.some((h) => h.type === 'unifi') ? 'found via UniFi' : null].filter(Boolean).join(' + ');
  const problems = [errors ? `${errors} with errors` : '', missing ? `${missing} without credentials` : ''].filter(Boolean).join(', ');
  const art = rackData ? Rack.deviceArt(item, rackData) : null;
  return el('button', { type: 'button', class: `device-row${draft?.id === d.id ? ' selected' : ''}`, onclick: () => openDevice(d) },
    el('span', { class: 'device-thumb', 'aria-hidden': 'true' }, art || HD.icon(Rack.KIND_ICONS[d.kind] || 'box')),
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
    options: { ...h.options }, secret: '', secret2: '', clearSecret: false, hasSecret: h.hasSecret, status: h.status, nodes: h.nodes || [], found: [],
    orig: { address: h.address, username: h.username, tlsMode: h.tlsMode, fingerprint: h.fingerprint },
  };
}

function newConn(type) {
  return {
    id: null, type, address: '', username: '', tlsMode: type === 'hass' || type === 'portainer' ? 'verify' : 'pin', fingerprint: '',
    options: SNMP_TYPES.includes(type) ? { snmpAuth: 'sha' } : type === 'proxmox' ? { node: '' } : type === 'omada' ? { mac: '' } : {},
    secret: '', secret2: '', clearSecret: false, hasSecret: false, status: null, nodes: [], found: [], orig: null,
  };
}

function openDevice(dev, preset = {}) {
  draft = dev
    ? { ...structuredClone(dev), connections: hostsOf(dev).map(connFromHost) }
    : { id: null, name: '', kind: 'server', location: 'rack', u: null, height: 1, estimateW: null, discovered: false, unifi: null, connections: [], ...preset };
  if (!dev && draft.location === 'rack' && !draft.u) draft.u = freeU(draft.height);
  hideRackSide();
  draft.front = { model: 'auto', drives: 'auto', ...(draft.front || {}) };
  const f = deviceForm();
  f.name.value = draft.name;
  // blank and patch panels and shelves are passive rack items now, not devices
  const passiveKinds = ['blank', 'patch-panel', 'shelf'];
  $('device-kind').replaceChildren(...state.rackKinds.filter((k) => !passiveKinds.includes(k) || k === draft.kind).map((k) => el('option', { value: k, text: Rack.KIND_LABELS[k] || k })));
  f.kind.value = draft.kind;
  f.brand.value = draft.model?.brand || '';
  f.modelName.value = draft.model?.name || '';
  $('brand-list').replaceChildren(...[...new Set(CATALOG.map((x) => x.brand))].map((b) => el('option', { value: b })));
  f.frontModel.value = draft.front.model;
  f.frontDrives.value = draft.front.drives;
  f.location.value = draft.location;
  f.height.value = draft.height;
  f.u.value = draft.u ?? '';
  f.estimateW.value = draft.estimateW ?? '';
  draft.powerSource ||= 'auto';
  // what it is reached through: automatic (UniFi's uplink), nothing, or a chosen device
  const auto = rackData?.devices?.find((x) => x.id === draft.id)?.reachedThrough;
  const autoName = draft.parent ? null : state.devices.find((x) => x.id === auto)?.name;
  $('device-parent').replaceChildren(
    el('option', { value: '', text: `Automatic${autoName ? ` (now: ${autoName}, from UniFi)` : draft.unifi ? ' (from UniFi)' : ' (nothing found)'}` }),
    el('option', { value: 'none', text: 'Nothing (directly reachable)' }),
    el('optgroup', { label: 'Devices' }, state.devices.filter((x) => x.id !== draft.id && !x.hidden).sort((a, b) => a.name.localeCompare(b.name)).map((x) => el('option', { value: x.id, text: x.name }))));
  f.parent.value = draft.parent || '';
  $('device-editor-title').textContent = dev ? `Edit ${dev.name}` : 'Add device';
  $('device-catalog-hint').textContent = draft.catalogNote || '';
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
  if (f.powerSource.value) draft.powerSource = f.powerSource.value;
  draft.parent = f.parent.value || null;
  draft.model = f.brand.value.trim() || f.modelName.value.trim() ? { brand: f.brand.value.trim(), name: f.modelName.value.trim() } : null;
  draft.front = { model: f.frontModel.value || 'auto', drives: f.frontDrives.value || 'auto' };
  for (const n of document.querySelectorAll('#device-form .rack-only')) n.classList.toggle('hidden', draft.location !== 'rack');
  // what "Automatic" means for this device, from what it reports
  const item = { ...(rackData?.devices?.find((x) => x.id === draft.id) || { links: [] }), kind: draft.kind, height: draft.height, front: draft.front };
  const fr = Rack.frontOf(item, Rack.itemInfo(item, rackData));
  $('device-drives-label').classList.toggle('hidden', !Rack.WITH_DRIVES.has(fr.model));
  $('device-front-hint').textContent = `Automatic here: ${Rack.FRONT_LABELS[fr.auto.model]}${fr.auto.drives ? `, ${Rack.DRIVE_LABELS[fr.auto.drives]}` : ''}${item.links.length ? ', from what the device reports.' : '.'}`;
  const types = draft.connections.map((c) => c.type);
  // where the power comes from: one source per device, so nothing is counted twice
  const hasIdrac = types.includes('idrac');
  const hasPlug = types.some((t) => ['shelly', 'tasmota', 'hass'].includes(t));
  const autoFrom = hasIdrac ? 'Redfish' : hasPlug ? 'the smart plug' : draft.estimateW ? 'the estimate' : 'nothing yet';
  const opts = [['auto', `Automatic (now: ${autoFrom})`], hasIdrac && ['idrac', 'Redfish (iDRAC, iLO…)'], hasPlug && ['plug', 'Smart plug'], ['estimate', 'The estimate below'], ['none', 'Not counted']].filter(Boolean);
  if (!opts.some(([v]) => v === draft.powerSource)) draft.powerSource = 'auto';
  $('device-power').replaceChildren(...opts.map(([v, t]) => el('option', { value: v, text: t })));
  $('device-power').value = draft.powerSource;
  $('device-power-hint').textContent = draft.powerSource === 'none'
    ? 'Left out of the power total and the cost, e.g. when it hangs on a plug that measures another device too.'
    : 'Counted once, from this source, in the power total and the cost. Automatic takes Redfish, then a smart plug, then the estimate.';
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
  const snmp = SNMP_TYPES.includes(c.type);
  const nut = c.type === 'nut';
  const ping = c.type === 'ping';
  const plugHttp = c.type === 'shelly' || c.type === 'tasmota'; // plain HTTP, an optional password
  const urlType = c.type === 'hass' || c.type === 'portainer'; // a URL: TLS only for https://
  const hassHttp = urlType && !/^https:/i.test(c.address || '');
  const plain = nut || ping || c.type === 'docker'; // nothing secret is sent: no password and no certificate
  const noTls = plain || plugHttp || hassHttp;
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
    field('Address', (() => {
      const a = input('address', { placeholder: ping ? 'host or IP' : c.type === 'hass' ? 'http://homeassistant.local:8123' : c.type === 'portainer' ? 'https://192.168.1.132:9443' : 'host or IP[:port]' });
      // Home Assistant and Portainer over https:// get the certificate fields
      if (urlType) a.addEventListener('change', () => hassHttp !== !/^https:/i.test(a.value) && renderConnections());
      return a;
    })(), t.address),
    t.username ? field(t.username, input('username'), t.usernameHint) : null,
    plain ? null : field(t.secret, input('secret', { type: 'password', autocomplete: 'new-password', placeholder: stored }), c.hasSecret ? 'Write-only: the stored value is never shown.' : null),
  ].filter(Boolean);
  if (noTls) {
    // no TLS here: nothing to verify or pin
  } else if (snmp) {
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
  if (c.type === 'omada') {
    const found = [...(c.found || [])];
    if (c.options.mac && !found.some((x) => x.mac === c.options.mac)) found.push({ mac: c.options.mac, name: c.options.mac, model: '' });
    fields.push(field('Which Omada device', select([['', 'The whole controller (all its devices)'], ...found.map((x) => [x.mac, `${x.name}${x.model ? ` · ${x.model}` : ''}`])], c.options.mac || '', (v) => (c.options.mac = v)),
      'Pick the switch, gateway or access point this device is. Press Test to list them.'));
  }
  if (!noTls) fields.push(fpField);
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
      noTls ? null : el('button', { type: 'button', text: snmp ? 'Fetch engine ID' : 'Fetch certificate', onclick: () => fetchIdentity(c, fpInput, result) }),
      el('button', { type: 'button', text: 'Test', onclick: () => testConnection(c, result) }),
      el('span', { class: 'hint', text: ping ? 'Sends three pings; no password.' : c.type === 'docker' ? 'Reads the containers: state, health, restarts, CPU and memory. Never their settings or environment.' : c.type === 'portainer' ? (hassHttp && c.address ? 'This URL is plain http://, so the token travels unencrypted. Use https:// (port 9443).' : 'Reads the containers of that environment. In Portainer Community a token can also change things: keep it only here.') : plugHttp ? 'Only reads the power; never switches the plug. Plain HTTP, so a password would travel unencrypted.' : c.type === 'hass' ? (hassHttp && c.address ? 'This URL is plain http://, so the token travels unencrypted on your network. Use https:// if your Home Assistant has it.' : 'Reads that one sensor; the token is stored encrypted.') : nut ? 'Sends one read-only command (LIST VAR); no password.' : snmp ? 'Fetching only does an unauthenticated SNMP discovery.' : 'Fetching only does a TLS handshake; nothing else is sent.' })),
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
    if (r.ok && (r.nodes || r.devices)) {
      if (r.nodes) c.nodes = r.nodes;
      if (r.devices) c.found = r.devices;
      renderConnections(); // refresh the node or device list
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
$('device-new').addEventListener('click', openCatalog);

// --- Add device: start from the catalog ---
const CONN_TEXT = { idrac: 'Redfish', unifi: 'UniFi console', 'unifi-found': 'Found through UniFi', synology: 'Synology SNMPv3', snmp: 'SNMPv3', nut: 'NUT', omada: 'Omada controller', ping: 'Ping', shelly: 'Shelly plug', tasmota: 'Tasmota plug', hass: 'Home Assistant sensor', docker: 'Docker', portainer: 'Portainer', proxmox: 'Proxmox', truenas: 'TrueNAS', protect: 'Drawn only (Protect)', null: 'Drawn only' };

function presetFrom(x) {
  const desktopNas = x.front === 'synology-ds' || x.unifi?.rackFront === 'synology-ds';
  const rackable = x.height > 0 || desktopNas;
  const generic = x.brand === 'Generic' || x.brand === 'Proxmox';
  return {
    name: generic ? '' : x.model.replace(/^(PowerEdge|ProLiant|ThinkSystem|Catalyst) /, ''),
    kind: x.kind,
    location: rackable ? 'rack' : 'outside',
    height: desktopNas ? 4 : Math.max(1, x.height),
    estimateW: x.watts,
    front: { model: x.front || 'auto', drives: x.drives || 'auto' },
    model: generic ? null : { brand: x.brand, name: x.model },
    connections: x.connection && x.connection !== 'unifi-found' ? [newConn(x.connection)] : [],
    catalogNote: x.connection === 'unifi-found' ? CATALOG_NEEDS['unifi-found'] : x.brand === 'UniFi' && !x.connection ? CATALOG_NEEDS.protect : null,
  };
}

// What a UniFi model has on its front
const buildText = (m) => (m ? [m.rj ? `${m.rj + (m.wan || 0)} ports${m.poe ? ' (PoE)' : ''}` : m.ports ? `${m.ports} ports` : null, m.sfp ? `${m.sfp} SFP` : null, m.bays ? `${m.bays} drive bay${m.bays === 1 ? '' : 's'}` : null, m.outlets ? `${m.outlets} outlets` : null].filter(Boolean).join(' · ') : '');
const connKey = (x) => (x.brand === 'UniFi' && !x.connection ? 'protect' : x.connection);
const sizeText = (x) => (x.height ? `${x.height} U` : x.unifi?.rackFront === 'synology-ds' ? 'Desktop, on a shelf or outside' : x.unifi ? { desktop: 'Desktop', ceiling: 'Ceiling', wall: 'Wall', inwall: 'In-wall', outdoor: 'Outdoor', mesh: 'Mesh', camera: 'Camera' }[x.unifi.form] || 'Desktop' : x.front === 'synology-ds' ? 'Desktop, on a shelf' : 'Not rack-mounted');

// The model as it looks: its front in a rack, or its shape
function catalogFace(x) {
  const box = el('div', { class: 'cat-face' });
  const shape = x.unifi && x.unifi.form !== 'rack' ? Rack.productShape(x.unifi) : null;
  if (shape) box.append(shape);
  else if (x.height > 0 || x.front === 'synology-ds') {
    const p = presetFrom(x);
    const item = { id: `preview-${x.id}`, name: x.model, kind: x.kind, location: 'rack', u: 1, height: p.height, estimateW: x.watts, links: [], front: p.front, model: p.model };
    Rack.render(box, { enabled: true, units: p.height, numbering: 'bottom', items: [item], passive: [] }, null, { mode: 'realistic' });
  } else box.append(el('span', { class: 'tile-icon' }, HD.icon(Rack.KIND_ICONS[x.kind] || 'box')));
  return box;
}

// Add device: brand → type → model, each step with what is in it; search jumps straight to models
function openCatalog() {
  let brand = null;
  let type = null;
  let q = '';
  const search = el('input', { type: 'search', placeholder: 'Search: R740, Pro Max, U7, DS923, UPS…', 'aria-label': 'Search the catalog', autocomplete: 'off', spellcheck: 'false' });
  const crumbs = el('nav', { class: 'cat-crumbs', 'aria-label': 'Steps' });
  const stage = el('div', { class: 'cat-stage' });
  const pickBox = el('div', { class: 'cat-pick', 'aria-live': 'polite' });
  let close = () => {};
  const add = (x) => {
    close();
    openDevice(null, x ? presetFrom(x) : {});
  };
  const typeName = (k) => (CATALOG_TYPES.find(([t]) => t === k) || [k, Rack.KIND_LABELS[k] || k])[1];
  const typeOf = (x) => (x.kind === 'storage' ? 'nas' : CATALOG_TYPES.some(([t]) => t === x.kind) ? x.kind : 'other');
  const show = (x) => {
    pickBox.replaceChildren(el('div', { class: 'cat-chosen' },
      catalogFace(x),
      el('h3', { text: `${x.brand} ${x.model}` }),
      el('p', { class: 'muted small', text: [typeName(typeOf(x)), sizeText(x), buildText(x.unifi), x.watts ? `about ${x.watts} W` : null].filter(Boolean).join(' · ') }),
      el('div', { class: 'kv' }, el('div', null, el('div', { class: 'k', text: 'Live data' }), el('div', { class: 'v', text: CONN_TEXT[connKey(x)] }))),
      el('p', { class: 'hint', text: CATALOG_NEEDS[connKey(x)] }),
      el('div', { class: 'form-actions' },
        el('button', { type: 'button', class: 'primary', text: x.connection === 'unifi-found' ? 'Add anyway (drawn only)' : 'Add this device', onclick: () => add(x) }),
        el('button', { type: 'button', text: 'Back', onclick: () => { pickBox.replaceChildren(); stage.hidden = false; } }))));
    stage.hidden = true;
    pickBox.scrollIntoView({ block: 'nearest' });
  };
  const modelCard = (x) => el('li', null, el('button', { type: 'button', class: 'cat-model', onclick: () => show(x) },
    catalogFace(x),
    el('span', { class: 'cat-text' }, el('b', { text: brand ? x.model : `${x.brand} ${x.model}` }), el('small', { text: [sizeText(x), buildText(x.unifi) || CONN_TEXT[connKey(x)]].filter(Boolean).join(' · ') })),
    el('span', { class: `tag ${x.connection && x.connection !== 'unifi-found' ? 'live' : 'drawn'}`, text: x.connection === 'unifi-found' ? 'Found by itself' : x.connection ? 'Live data' : 'Drawn only' })));
  const crumb = (label, onclick, current) => el(current ? 'span' : 'button', { type: current ? null : 'button', class: current ? 'here' : 'link-button', text: label, onclick: current ? null : onclick, 'aria-current': current ? 'step' : null });
  const draw = () => {
    pickBox.replaceChildren();
    stage.hidden = false;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      const found = CATALOG.filter((x) => terms.every((t) => `${x.brand} ${x.model} ${typeName(typeOf(x))} ${x.kind}`.toLowerCase().includes(t)));
      crumbs.replaceChildren(crumb('All brands', () => { search.value = ''; q = ''; brand = type = null; draw(); }), crumb(`${found.length} found`, null, true));
      stage.replaceChildren(found.length ? el('ul', { class: 'cat-models' }, found.slice(0, 60).map(modelCard))
        : el('p', { class: 'muted small cat-none', text: 'Not in the catalog. Add it as “Any other device”: choose its type, size and connection yourself.' }));
      return;
    }
    if (!brand) {
      crumbs.replaceChildren(crumb('Choose the brand', null, true));
      const brands = [...new Set(CATALOG.map((x) => x.brand))];
      stage.replaceChildren(el('ul', { class: 'cat-brands-grid' }, brands.map((b) => {
        const items = CATALOG.filter((x) => x.brand === b);
        const kinds = [...new Set(items.map(typeOf))];
        return el('li', null, el('button', { type: 'button', class: 'cat-brand', onclick: () => { brand = b; type = kinds.length === 1 ? kinds[0] : null; draw(); } },
          el('b', { text: b }), el('small', { text: `${items.length} model${items.length === 1 ? '' : 's'} · ${kinds.map((k) => typeName(k).toLowerCase()).slice(0, 3).join(', ')}${kinds.length > 3 ? '…' : ''}` })));
      })));
      return;
    }
    const mine = CATALOG.filter((x) => x.brand === brand);
    if (!type) {
      crumbs.replaceChildren(crumb('All brands', () => { brand = null; draw(); }), el('span', { class: 'sep', text: '›' }), crumb(brand, null, true));
      stage.replaceChildren(el('ul', { class: 'cat-types' }, CATALOG_TYPES.filter(([k]) => mine.some((x) => typeOf(x) === k)).map(([k, label]) => {
        const items = mine.filter((x) => typeOf(x) === k);
        return el('li', null, el('button', { type: 'button', class: 'cat-type', onclick: () => { type = k; draw(); } },
          catalogFace(items.find((x) => x.height > 0) || items[0]),
          el('b', { text: label }), el('small', { text: `${items.length} model${items.length === 1 ? '' : 's'}` })));
      })));
      return;
    }
    crumbs.replaceChildren(crumb('All brands', () => { brand = type = null; draw(); }), el('span', { class: 'sep', text: '›' }), crumb(brand, () => { type = null; draw(); }), el('span', { class: 'sep', text: '›' }), crumb(typeName(type), null, true));
    stage.replaceChildren(el('ul', { class: 'cat-models' }, mine.filter((x) => typeOf(x) === type).map(modelCard)));
  };
  search.addEventListener('input', () => {
    q = search.value;
    draw();
  });
  const body = el('div', { class: 'detail catalog' },
    el('div', null, el('h2', { class: 'cat-title', text: 'Add device' }), el('p', { class: 'muted', text: 'Choose the brand, then the type, then the model: you get its front in the rack (or its shape), its size and the right way to read it.' })),
    el('label', { class: 'cat-search' }, HD.icon('search'), search),
    crumbs,
    pickBox,
    stage,
    el('button', { type: 'button', class: 'link-button', text: 'Any other device: start with an empty form', onclick: () => add(null) }));
  ({ close } = HD.drawer('Catalog', body));
  draw();
  search.focus();
}
$('device-cancel').addEventListener('click', closeDevice);

$('device-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  syncDraft();
  const d = draft;
  const body = {
    name: d.name, kind: d.kind, location: d.location, u: d.location === 'rack' ? d.u : null, height: d.height, estimateW: d.estimateW, powerSource: d.powerSource || 'auto', parent: d.parent || null, hidden: false, front: d.front, model: d.model,
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
let svcPrevIntegration = ''; // integration type before the current change
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
        : !r?.check ? HD.status('Pending', '') : r.check.up ? HD.status(HD.checkText(r.check).replace(/ · certificate.*/, ''), 'good') : HD.status('Down', 'critical');
      const integ = svc.integration ? svcState.integrations[svc.integration.type]?.label : null;
      return el('div', { class: `svc-row${svcDraft?.id === svc.id ? ' selected' : ''}` },
        serviceIcon(svc),
        el('div', { class: 'device-main' },
          el('strong', { text: svc.name }),
          el('span', { class: 'small muted', text: [integ !== svc.name ? integ : null, svc.description, svc.hidden ? 'hidden on the Services page' : null].filter(Boolean).join(' · ') || (integ ? '' : 'Link') }),
          r?.error ? el('span', { class: 'small msg error', text: r.error }) : null),
        st,
        el('span', { class: 'svc-row-actions' },
          el('button', { type: 'button', text: 'Edit', onclick: () => openService(svc) })));
    }),
  ]));
}

function openService(svc) {
  svcDraft = svc
    ? { ...structuredClone(svc), secret: '', clearSecret: false, labels: svc.result?.labels || [] }
    : { id: null, name: '', group: '', description: '', href: '', deviceId: null, icon: { kind: 'letter' }, connection: null, integration: null, secret: '', clearSecret: false, hasSecret: false };
  const f = svcForm();
  f.name.value = svcDraft.name;
  f.group.value = svcDraft.group;
  f.description.value = svcDraft.description;
  f.href.value = svcDraft.href;
  f.onHome.checked = svcDraft.onHome !== false;
  $('svc-device').replaceChildren(el('option', { value: '', text: '–' }), ...svcState.devices.map((d) => el('option', { value: d.id, text: d.name })));
  f.deviceId.value = svcDraft.deviceId || '';
  f.url.value = svcDraft.connection?.url || '';
  f.tlsMode.value = svcDraft.connection?.tlsMode || 'verify';
  f.fingerprint.value = svcDraft.connection?.fingerprint || '';
  const mon = svcDraft.monitor || {};
  f.monitor.value = mon.type || 'http';
  f.monHost.value = mon.host?.replace(/^\[|\]$/g, '') || '';
  f.monPort.value = mon.port || '';
  f.monPath.value = mon.path || '';
  f.monContains.value = mon.contains || '';
  f.monJsonPath.value = mon.jsonPath || '';
  f.monJsonEquals.value = mon.jsonEquals || '';
  f.monOkStatus.value = mon.okStatus || 'any';
  f.dnsServer.value = mon.server || '';
  f.dnsName.value = mon.name || '';
  f.dnsExpect.value = mon.expect || '';
  const defs = svcState.integrations;
  const byGroup = {};
  for (const [k, d] of Object.entries(defs)) (byGroup[d.group] ||= []).push([k, d]);
  $('svc-integration').replaceChildren(el('option', { value: '', text: 'None (status check only)' }),
    ...Object.entries(byGroup).map(([g, items]) => el('optgroup', { label: g }, items.map(([k, d]) => el('option', { value: k, text: d.label })))));
  f.integration.value = svcDraft.integration?.type || '';
  svcPrevIntegration = f.integration.value;
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
  // TrueNAS, Synology, UniFi, UPS: the numbers of a device already added, or the card's own login
  let fromDevice = false;
  if (def.fromDevice) {
    const list = svcState.sources.filter((h) => def.fromDevice.includes(h.type) && h.ups);
    integ.options ||= {};
    if (integ.options.device === undefined) integ.options.device = svcDraft.id ? '' : list[0]?.id || '';
    if (integ.options.device && !list.some((h) => h.id === integ.options.device)) integ.options.device = '';
    const sel = el('select', { name: 'source' },
      list.map((h) => el('option', { value: h.id, text: `${h.name} (a device you added)` })),
      el('option', { value: '', text: def.noUrl ? 'A NUT server (address below)' : 'Its own login (URL and credentials below)' }));
    sel.value = integ.options.device;
    const suggestLink = () => {
      const web = list.find((h) => h.id === integ.options.device)?.web;
      const f = svcForm();
      if (web && !f.href.value.trim()) f.href.value = web;
    };
    suggestLink();
    sel.addEventListener('change', () => {
      integ.options.device = sel.value;
      suggestLink();
      renderIntegrationFields();
      syncService();
    });
    fields.push(el('label', { class: 'wide' }, el('span', { text: 'Numbers from' }), sel));
    fromDevice = Boolean(integ.options.device);
    if (fromDevice) fields.push(el('p', { class: 'hint wide', text: 'Uses what the dashboard already reads from that device: no second password is stored. A connection URL is optional and only adds an up/down check.' }));
  }
  if (def.user && !fromDevice) {
    const u = el('input', { value: integ.username || '', autocomplete: 'off', spellcheck: 'false' });
    u.addEventListener('input', () => (integ.username = u.value));
    fields.push(el('label', null, el('span', { text: def.user }), u));
  }
  if (def.secret && !fromDevice) {
    const stored = svcDraft.hasSecret && svcDraft.id ? 'Stored (leave blank to keep)' : def.optionalSecret ? 'Optional' : 'Not set';
    const sec = el('input', { type: 'password', autocomplete: 'new-password', value: svcDraft.secret, placeholder: stored });
    sec.addEventListener('input', () => {
      svcDraft.secret = sec.value;
      syncService();
    });
    fields.push(el('label', null, el('span', { text: def.secret }), sec));
  }
  for (const o of def.options) {
    if (fromDevice && o.own) continue;
    const input = o.multiline ? el('textarea', { rows: 4, value: integ.options?.[o.key] || '', placeholder: o.placeholder || '' }) : el('input', { value: integ.options?.[o.key] || '', placeholder: o.placeholder || '' });
    input.addEventListener('input', () => ((integ.options ||= {})[o.key] = input.value));
    fields.push(el('label', { class: o.multiline ? 'wide' : null }, el('span', { text: o.label }), input));
  }
  if (svcDraft.hasSecret && svcDraft.id && !fromDevice) {
    const clear = el('input', { type: 'checkbox', checked: svcDraft.clearSecret });
    clear.addEventListener('change', () => (svcDraft.clearSecret = clear.checked));
    fields.push(el('label', { class: 'check wide' }, clear, ' Delete the stored secret'));
  }
  fields.push(el('fieldset', { class: 'wide numbers-choice', id: 'svc-numbers' }));
  box.replaceChildren(...fields);
  renderNumbersChoice();
}

// Which numbers the card shows: from what the service reported (or Test), at most four
function renderNumbersChoice() {
  const box = $('svc-numbers');
  if (!box || !svcDraft?.integration) return;
  const def = svcState.integrations[svcDraft.integration.type];
  const labels = svcDraft.labels || [];
  const chosen = svcDraft.integration.fields?.length ? svcDraft.integration.fields : def?.fields || labels.slice(0, 4);
  const legend = el('legend', { text: 'Numbers on the card' });
  if (!labels.length) return box.replaceChildren(legend, el('p', { class: 'hint', text: 'Use Test to see which numbers this service reports, then pick up to four.' }));
  const boxes = labels.map((label) => {
    const cb = el('input', { type: 'checkbox', checked: chosen.includes(label) });
    cb.addEventListener('change', () => {
      const now = boxes.filter((b) => b.cb.checked).map((b) => b.label);
      svcDraft.integration.fields = now;
      for (const b of boxes) b.cb.disabled = !b.cb.checked && now.length >= 4;
    });
    return { label, cb };
  });
  for (const b of boxes) b.cb.disabled = !b.cb.checked && boxes.filter((x) => x.cb.checked).length >= 4;
  box.replaceChildren(legend,
    el('div', { class: 'numbers-list' }, boxes.map((b) => el('label', { class: 'check' }, b.cb, ` ${b.label}`))),
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', text: 'Use the defaults', onclick: () => { svcDraft.integration.fields = []; renderNumbersChoice(); } }),
      el('span', { class: 'hint', text: svcDraft.integration.fields?.length ? 'Your choice' : 'Defaults: the ones that say something is waiting' })));
}

function syncService() {
  if (!svcDraft) return;
  const f = svcForm();
  const url = f.url.value.trim();
  const https = /^https:\/\//i.test(url);
  for (const n of document.querySelectorAll('#svc-form .https-only')) n.classList.toggle('hidden', !https);
  for (const n of document.querySelectorAll('#svc-form .pin-only')) n.classList.toggle('hidden', !https || f.tlsMode.value !== 'pin');
  const mon = f.monitor.value;
  for (const n of document.querySelectorAll('#svc-form .mon-host')) n.classList.toggle('hidden', mon === 'http' || mon === 'dns');
  for (const n of document.querySelectorAll('#svc-form .mon-http')) n.classList.toggle('hidden', mon !== 'http');
  for (const n of document.querySelectorAll('#svc-form .mon-dns')) n.classList.toggle('hidden', mon !== 'dns');
  for (const n of document.querySelectorAll('#svc-form .mon-port')) n.classList.toggle('hidden', mon !== 'tcp');
  // the host of the connection URL is the likely one to ping
  if ((mon === 'ping' || mon === 'tcp') && !f.monHost.value.trim() && url) {
    try {
      f.monHost.value = new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {}
  }
  const def = svcState.integrations[f.integration.value];
  const urlOptional = def && (def.noUrl || (def.fromDevice && svcDraft.integration?.options?.device));
  $('svc-url-label').textContent = urlOptional ? 'Connection URL (optional: an up/down check)' : 'Connection URL';
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
    onHome: f.onHome.checked,
    icon: svcDraft.icon,
    connection: f.url.value.trim() ? { url: f.url.value.trim(), tlsMode: f.tlsMode.value, fingerprint: f.fingerprint.value } : null,
    monitor: f.monitor.value === 'http'
      ? { type: 'http', path: f.monPath.value.trim(), contains: f.monContains.value, jsonPath: f.monJsonPath.value.trim(), jsonEquals: f.monJsonEquals.value, okStatus: f.monOkStatus.value }
      : f.monitor.value === 'dns'
        ? { type: 'dns', server: f.dnsServer.value.trim(), name: f.dnsName.value.trim(), expect: f.dnsExpect.value.trim() }
        : { type: f.monitor.value, host: f.monHost.value.trim(), port: f.monPort.value },
    integration: type ? { type, username: svcDraft.integration?.username || '', options: svcDraft.integration?.options || {}, fields: svcDraft.integration?.type === type ? svcDraft.integration.fields || [] : [] } : null,
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
    if (!svcState.icons.some((i) => i.id === icon.id)) svcState.icons.push({ id: icon.id, source: `library:${name}` });
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
  const f = svcForm();
  const type = f.integration.value;
  const prev = svcState.integrations[svcPrevIntegration];
  svcPrevIntegration = type;
  svcDraft.labels = []; // the numbers another integration reported don't apply
  renderIntegrationFields();
  const def = svcState.integrations[type];
  // Choosing an integration fills in name, group and icon; they follow later changes of the
  // integration as long as they are still what the previous one filled in
  const label = (d) => d?.label.split(' / ')[0];
  if (def && (!f.name.value || f.name.value === label(prev))) f.name.value = label(def);
  if (def && (!f.group.value || f.group.value === prev?.group)) f.group.value = def.group;
  const source = svcDraft.icon.kind === 'file' ? svcState.icons.find((i) => i.id === svcDraft.icon.id)?.source : null;
  if (svcDraft.icon.kind === 'letter' || (prev?.icon && source === `library:${prev.icon}`)) {
    if (def?.icon) await pickLibraryIcon(def.icon).catch(() => {});
    else svcDraft.icon = { kind: 'letter' };
  }
  syncService();
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
    if (r.check) parts.push(HD.status(HD.checkText(r.check), r.check.up ? 'good' : 'critical'));
    if (r.stats) {
      parts.push(el('span', { class: 'small' }, r.stats.map((st) => `${st.label}: ${HD.statValue(st)}`).join(' · ')));
      svcDraft.labels = r.stats.map((st) => st.label);
      renderNumbersChoice();
    }
    if (r.error) parts.push(el('span', { class: 'msg error', text: r.error }));
    out.replaceChildren(...(parts.length ? parts.flatMap((n) => [n, ' ']) : [el('span', { class: 'small muted', text: 'Nothing to test: add a connection URL or a status check.' })]));
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
      setTimeout(() => (location.href = `${next.replace(/\/$/, '')}/admin#system`), 1200);
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

// ---------------------------------------------------------------------------
// Check-ins: a job calls its own address when it has run

let ck = null; // { checkins, devices, httpPort }
const EVERY = [5, 15, 30, 60, 120, 360, 720, 1440, 2880, 10080];
const GRACE = [5, 15, 30, 60, 120, 360, 720, 1440];
const minText = (m) => (m % 10080 === 0 ? `${m / 10080} week${m === 10080 ? '' : 's'}` : m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const CK_STATE = { new: ['Waiting for the first check-in', ''], up: ['OK', 'good'], late: ['Late', 'warning'], down: ['Missed', 'critical'], failed: ['Failed', 'critical'] };

function pingUrls(c) {
  const https = `${location.origin}${c.path}`;
  const http = ck.httpPort ? `http://${location.hostname}${ck.httpPort === 80 ? '' : `:${ck.httpPort}`}${c.path}` : null;
  return { https, http };
}

function copyButton(text, label = 'Copy') {
  const b = el('button', { type: 'button', text: label });
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select and copy it';
    }
    setTimeout(() => (b.textContent = label), 1600);
  });
  return b;
}

async function loadCheckins() {
  try {
    ck = await api('GET', '/api/admin/checkins');
    renderCheckins();
  } catch (e) {
    $('ck-list').replaceChildren(el('p', { class: 'msg error', text: e.message }));
  }
}

function renderCheckins() {
  const dev = (id) => ck.devices.find((d) => d.id === id)?.name;
  $('ck-list').replaceChildren(...(ck.checkins.length ? ck.checkins.map((c) => {
    const [label, tone] = CK_STATE[c.status.state];
    const u = pingUrls(c);
    const url = u.http || u.https;
    const more = el('details', { class: 'ck-how' },
      el('summary', { text: 'Address and how to use it' }),
      el('div', { class: 'ck-url' }, el('code', { text: url }), copyButton(url)),
      u.http && location.protocol === 'https:' ? el('p', { class: 'hint', text: `Plain HTTP on port ${ck.httpPort}, so curl works without trusting the dashboard's certificate. Over HTTPS it is ${u.https}` }) : null,
      el('p', { class: 'hint', text: 'At the end of a job (cron, a backup script, a systemd timer):' }),
      el('pre', { class: 'ck-code' }, el('code', { text: `your-backup-command && curl -fsS -m 10 --retry 3 ${url} \\\n  || curl -fsS -m 10 --retry 3 ${url}/fail` })),
      el('p', { class: 'hint', text: 'Optional: call …/start when the job begins. Anyone with the address can check in, so treat it like a password; "New address" replaces it.' }));
    return el('div', { class: 'svc-row ck-row' },
      el('span', { class: `led ${tone || 'off'}`, 'aria-hidden': 'true' }),
      el('div', { class: 'device-main' },
        el('strong', { text: c.name }),
        el('span', { class: 'small muted', text: [label, `every ${c.every}`, `grace ${c.grace}`, c.status.last ? `last ${fmt.ago(c.status.last)}` : null, dev(c.deviceId) ? `on ${dev(c.deviceId)}` : null].filter(Boolean).join(' · ') }),
        more),
      el('span'),
      el('span', { class: 'svc-row-actions' },
        ['down', 'failed'].includes(c.status.state) ? el('button', { type: 'button', text: 'Reset', title: 'Forget the missed or failed check-in', onclick: () => ckAction(`/api/admin/checkins/${c.id}/reset`, 'POST') }) : null,
        el('button', { type: 'button', text: 'Edit', onclick: () => openCheckin(c) })));
  }) : [el('p', { class: 'empty', text: 'No check-ins yet. Add one for each backup or scheduled job you want to hear about when it stops running.' })]));
}

async function ckAction(path, method, body) {
  try {
    ck = await api(method, path, body);
    renderCheckins();
    return true;
  } catch (e) {
    showMsg('ck-msg', e.message, false);
    return false;
  }
}

function openCheckin(c) {
  const d = c ? { ...c } : { name: '', everyMin: 1440, graceMin: 60, deviceId: null };
  const box = $('ck-editor');
  const opts = (list, v) => [...new Set([...list, v])].sort((a, b) => a - b).map((m) => el('option', { value: m, text: minText(m) }));
  const name = el('input', { value: d.name, maxlength: 48, placeholder: 'e.g. Nightly backup to NAS', required: true });
  const every = el('select', null, opts(EVERY, d.everyMin));
  every.value = d.everyMin;
  const grace = el('select', null, opts(GRACE, d.graceMin));
  grace.value = d.graceMin;
  const devSel = el('select', null, el('option', { value: '', text: '–' }), ck.devices.map((x) => el('option', { value: x.id, text: x.name })));
  devSel.value = d.deviceId || '';
  const body = () => ({ name: name.value, everyMin: Number(every.value), graceMin: Number(grace.value), deviceId: devSel.value || null });
  const close = () => {
    box.classList.add('hidden');
    box.replaceChildren();
  };
  box.replaceChildren(
    el('h4', { text: c ? `Edit ${c.name}` : 'New check-in' }),
    el('div', { class: 'form-grid two' },
      el('label', null, el('span', { text: 'Name' }), name),
      el('label', null, el('span', { text: 'Runs on' }), devSel, el('span', { class: 'hint', text: 'Optional: its problems then show on that device' })),
      el('label', null, el('span', { text: 'Expected every' }), every),
      el('label', null, el('span', { text: 'Grace time' }), grace, el('span', { class: 'hint', text: 'How late it may be before it counts as missed' }))),
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: c ? 'Save' : 'Add check-in', onclick: async () => (await ckAction(c ? `/api/admin/checkins/${c.id}` : '/api/admin/checkins', c ? 'PUT' : 'POST', body())) && close() }),
      el('button', { type: 'button', text: 'Cancel', onclick: close }),
      c ? el('button', { type: 'button', text: 'New address', title: 'The old address stops working at once', onclick: () => confirm(`Give ${c.name} a new address? The job must then use the new one.`) && ckAction(`/api/admin/checkins/${c.id}/token`, 'POST') }) : null,
      c ? el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: async () => confirm(`Delete the check-in ${c.name}?`) && (await ckAction(`/api/admin/checkins/${c.id}`, 'DELETE')) && close() }) : null,
      el('span', { class: 'msg', id: 'ck-msg', role: 'status' })));
  box.classList.remove('hidden');
  name.focus();
}
$('ck-new').addEventListener('click', () => ck && openCheckin(null));

// ---------------------------------------------------------------------------
// Maintenance windows

let mw = null; // { windows, devices, services, checkins }
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LENGTHS = [30, 60, 120, 240, 480, 720, 1440];
const at = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// <input type="datetime-local"> wants local time without a zone
const localInput = (t) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60e3);
  return d.toISOString().slice(0, 16);
};

async function loadMaintenance() {
  try {
    mw = await api('GET', '/api/admin/maintenance');
    renderMaintenance();
  } catch (e) {
    $('mw-list').replaceChildren(el('p', { class: 'msg error', text: e.message }));
  }
}

function targetsText(t) {
  if (t.all) return 'Everything';
  const names = [
    ...t.devices.map((id) => mw.devices.find((x) => x.id === id)?.name),
    ...t.services.map((id) => mw.services.find((x) => x.id === id)?.name),
    ...t.checkins.map((id) => mw.checkins.find((x) => x.id === id)?.name),
  ].filter(Boolean);
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
}

function renderMaintenance() {
  $('mw-list').replaceChildren(...(mw.windows.length ? mw.windows.map((w) => el('div', { class: 'svc-row' },
    el('span', { class: `led ${w.active ? 'info' : 'off'}`, 'aria-hidden': 'true' }),
    el('div', { class: 'device-main' },
      el('strong', { text: w.name }),
      el('span', { class: 'small muted', text: [w.active ? `On now, until ${hm(w.until)}` : w.next ? `Next ${at(w.next.start)}` : 'Over', targetsText(w.targets), w.schedule.kind === 'weekly' ? w.text : null].filter(Boolean).join(' · ') })),
    el('span'),
    el('span', { class: 'svc-row-actions' },
      w.active ? el('button', { type: 'button', text: 'End now', onclick: () => mwAction(`/api/admin/maintenance/${w.id}/end`, 'POST') }) : null,
      el('button', { type: 'button', text: 'Edit', onclick: () => openMaintenance(w) })))) : [el('p', { class: 'empty', text: 'No maintenance planned.' })]));
}

async function mwAction(path, method, body) {
  try {
    mw = await api(method, path, body);
    renderMaintenance();
    return true;
  } catch (e) {
    showMsg('mw-msg', e.message, false);
    return false;
  }
}

function openMaintenance(w) {
  const now = Date.now();
  const d = w ? structuredClone(w) : { name: '', targets: { all: false, devices: [], services: [], checkins: [] }, schedule: { kind: 'now' } };
  const box = $('mw-editor');
  const name = el('input', { value: d.name, maxlength: 48, placeholder: 'e.g. Proxmox upgrade', required: true });
  // what: everything, or ticked devices, services and check-ins
  const all = el('input', { type: 'checkbox', checked: d.targets.all });
  const picks = { devices: new Set(d.targets.devices), services: new Set(d.targets.services), checkins: new Set(d.targets.checkins) };
  const group = (key, title, list) => (list.length ? el('fieldset', { class: 'mw-group' }, el('legend', { text: title }), list.map((x) => {
    const cb = el('input', { type: 'checkbox', checked: picks[key].has(x.id) });
    cb.addEventListener('change', () => (cb.checked ? picks[key].add(x.id) : picks[key].delete(x.id)));
    return el('label', { class: 'check' }, cb, ` ${x.name}`);
  })) : null);
  const pickBox = el('div', { class: 'mw-picks' }, group('devices', 'Devices', mw.devices), group('services', 'Services', mw.services), group('checkins', 'Check-ins', mw.checkins));
  const syncAll = () => pickBox.classList.toggle('hidden', all.checked);
  all.addEventListener('change', syncAll);
  syncAll();
  // when: now for a while, once, or every week
  const kind = el('select', null, [['now', 'Starting now'], ['once', 'Once'], ['weekly', 'Every week']].map(([v, t]) => el('option', { value: v, text: t })));
  kind.value = d.schedule.kind;
  const forLen = el('select', null, LENGTHS.map((m) => el('option', { value: m, text: `for ${minText(m)}` })));
  forLen.value = 120;
  const start = el('input', { type: 'datetime-local', value: localInput(d.schedule.kind === 'once' ? d.schedule.start : now + 3600e3) });
  const end = el('input', { type: 'datetime-local', value: localInput(d.schedule.kind === 'once' ? d.schedule.end : now + 3 * 3600e3) });
  const days = new Set(d.schedule.kind === 'weekly' ? d.schedule.days : [6]);
  const dayBox = el('div', { class: 'seg mw-days', role: 'group', 'aria-label': 'Days' }, DAYS.map((t, i) => {
    const b = el('button', { type: 'button', text: t, 'aria-pressed': String(days.has(i)) });
    b.addEventListener('click', () => {
      days.has(i) ? days.delete(i) : days.add(i);
      b.setAttribute('aria-pressed', String(days.has(i)));
    });
    return b;
  }));
  const time = el('input', { type: 'time', value: d.schedule.kind === 'weekly' ? d.schedule.start : '02:00' });
  const wkLen = el('select', null, [...new Set([...LENGTHS, d.schedule.minutes].filter(Boolean))].sort((a, b) => a - b).map((m) => el('option', { value: m, text: minText(m) })));
  wkLen.value = d.schedule.kind === 'weekly' ? d.schedule.minutes : 120;
  const when = el('div', { class: 'form-grid two' });
  const syncKind = () => when.replaceChildren(...{
    now: [el('label', null, el('span', { text: 'How long' }), forLen)],
    once: [el('label', null, el('span', { text: 'From' }), start), el('label', null, el('span', { text: 'To' }), end)],
    weekly: [el('label', { class: 'wide' }, el('span', { text: 'Days' }), dayBox), el('label', null, el('span', { text: 'Starts at' }), time), el('label', null, el('span', { text: 'Lasts' }), wkLen)],
  }[kind.value]);
  kind.addEventListener('change', syncKind);
  syncKind();
  const body = () => ({
    name: name.value,
    targets: { all: all.checked, devices: [...picks.devices], services: [...picks.services], checkins: [...picks.checkins] },
    schedule: kind.value === 'now' ? { kind: 'once', start: Date.now(), end: Date.now() + Number(forLen.value) * 60e3 }
      : kind.value === 'once' ? { kind: 'once', start: new Date(start.value).getTime(), end: new Date(end.value).getTime() }
        : { kind: 'weekly', days: [...days], start: time.value, minutes: Number(wkLen.value) },
  });
  const close = () => {
    box.classList.add('hidden');
    box.replaceChildren();
  };
  box.replaceChildren(
    el('h4', { text: w ? `Edit ${w.name}` : 'Plan maintenance' }),
    el('div', { class: 'form-grid two' },
      el('label', { class: 'wide' }, el('span', { text: 'Name' }), name),
      el('label', { class: 'check wide' }, all, ' Everything (all devices, services and check-ins)')),
    pickBox,
    el('div', { class: 'form-grid two' }, el('label', null, el('span', { text: 'When' }), kind)),
    when,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', class: 'primary', text: w ? 'Save' : 'Plan', onclick: async () => (await mwAction(w ? `/api/admin/maintenance/${w.id}` : '/api/admin/maintenance', w ? 'PUT' : 'POST', body())) && close() }),
      el('button', { type: 'button', text: 'Cancel', onclick: close }),
      w ? el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: async () => confirm(`Delete ${w.name}?`) && (await mwAction(`/api/admin/maintenance/${w.id}`, 'DELETE')) && close() }) : null,
      el('span', { class: 'msg', id: 'mw-msg', role: 'status' })));
  box.classList.remove('hidden');
  name.focus();
}
$('mw-new').addEventListener('click', () => mw && openMaintenance(null));

const chanSummary = (c) => (c.type === 'ntfy' ? `${c.url.replace(/^https:\/\//, '')}/${c.topic}`
  : c.type === 'telegram' ? `chat ${c.chatId}`
    : c.type === 'discord' ? (c.hasSecret ? 'webhook set' : 'no webhook')
      : c.type === 'sendblue' ? `to ${c.to.join(', ')} from ${c.from}`
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
    input('name', 'Name', { placeholder: { ntfy: 'Phone (ntfy)', telegram: 'Telegram', discord: 'Discord #homelab', email: 'E-mail', sendblue: 'iMessage' }[c.type] });
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
    if (c.type === 'sendblue') {
      input('keyId', 'API key ID', { placeholder: 'From the Sendblue dashboard' });
      secret('API secret key');
      input('from', 'Your Sendblue line', { placeholder: '+15551234567', inputmode: 'tel' }, 'The number messages are sent from, with country code');
      input('to', 'Send to', { placeholder: '+4791234567, +4798765432', inputmode: 'tel' }, 'Up to 10 phone numbers with country code, separated by commas');
    }
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
    if (c.type === 'sendblue') notes.push(el('p', { class: 'hint', text: 'Sendblue sends a blue-bubble iMessage, or an SMS to a phone without iMessage. Find the API key ID and secret key under API keys in the Sendblue dashboard; the line is one of the numbers on your account. Each alert is one message per number, which Sendblue counts toward your plan.' }));
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
  // phone numbers may contain spaces; e-mail addresses may be separated by them
  const body = () => ({ ...chanDraft, to: String(chanDraft.to || '').split(c.type === 'sendblue' ? /[,;\n]+/ : /[\s,;]+/).map((x) => x.trim()).filter(Boolean) });
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
  graphite: 'Graphite',
  oled: 'OLED Black',
  ocean: 'Deep Ocean',
  forest: 'Forest',
  ember: 'Ember',
  'rose-pine': 'Rosé Pine',
  synthwave: 'Synthwave',
  arctic: 'Arctic',
  sandstone: 'Sandstone',
  'high-contrast': 'High Contrast',
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

  const ACCENT_NAMES = { theme: 'Theme colour', indigo: 'Indigo', blue: 'Blue', teal: 'Teal', green: 'Green', amber: 'Amber', pink: 'Pink', red: 'Red', graphite: 'Graphite' };
  $('accent-row').replaceChildren(...Object.keys(HD_LOOK.ACCENTS).map((k) => {
    const b = el('button', { type: 'button', class: `swatch${k === 'theme' ? ' theme' : ''}`, title: ACCENT_NAMES[k], 'aria-label': ACCENT_NAMES[k], 'aria-pressed': String((appearance.accent || 'theme') === k), onclick: () => {
      appearance.accent = k;
      renderAppearance();
    } });
    if (HD_LOOK.ACCENTS[k]) b.style.setProperty('--c', `light-dark(${HD_LOOK.ACCENTS[k][0]}, ${HD_LOOK.ACCENTS[k][1]})`);
    return b;
  }));

  renderLogo();

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

// --- Logo: the shipped one, a built-in icon in a colour, or an image (upload or the icon library) ---
const LOGO_COLOR_NAMES = { blue: 'Blue', indigo: 'Indigo', teal: 'Teal', green: 'Green', amber: 'Amber', pink: 'Pink', red: 'Red', white: 'White' };
let logoMode = null; // which choice is open; an image choice stays open until one is uploaded or picked
let logoSearchTimer = null;

function logoPreview(logo) {
  if (logo.kind === 'icon') {
    const box = el('span', { class: 'logo-preview icon' }, HD.icon(logo.name));
    box.style.setProperty('--c', state.logoColors[logo.color]);
    return box;
  }
  return el('span', { class: 'logo-preview' }, el('img', { src: logo.kind === 'file' ? `/media/icon/${logo.id}` : '/static/favicon.svg', alt: '' }));
}

function renderLogo() {
  const logo = appearance.logo || { kind: 'default' };
  const mode = logoMode || (logo.kind === 'file' ? 'image' : logo.kind);
  const set = (l) => {
    appearance.logo = l;
    renderLogo();
  };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Logo' }, [['default', 'Default'], ['icon', 'Built-in icon'], ['image', 'Image']].map(([k, label]) => el('button', {
    type: 'button',
    'aria-pressed': String(mode === k),
    text: label,
    onclick: () => {
      logoMode = k;
      if (k === 'default') set({ kind: 'default' });
      else if (k === 'icon' && logo.kind !== 'icon') set({ kind: 'icon', name: state.logoIcons[0], color: 'blue' });
      else renderLogo();
    },
  })));
  const parts = [el('div', { class: 'logo-head' }, logoPreview(mode === 'image' && logo.kind !== 'file' ? { kind: 'default' } : logo), seg)];
  if (mode === 'icon' && logo.kind === 'icon') {
    parts.push(el('div', { class: 'logo-icons', role: 'group', 'aria-label': 'Icon' }, state.logoIcons.map((n) => el('button', {
      type: 'button', class: 'logo-icon', title: n, 'aria-label': n, 'aria-pressed': String(logo.name === n), onclick: () => set({ ...logo, name: n }),
    }, HD.icon(n)))));
    parts.push(el('div', { class: 'swatches-row', role: 'group', 'aria-label': 'Logo colour' }, Object.keys(state.logoColors).map((k) => {
      const b = el('button', { type: 'button', class: 'swatch', title: LOGO_COLOR_NAMES[k] || k, 'aria-label': LOGO_COLOR_NAMES[k] || k, 'aria-pressed': String(logo.color === k), onclick: () => set({ ...logo, color: k }) });
      b.style.setProperty('--c', state.logoColors[k]);
      return b;
    })));
  }
  if (mode === 'image') {
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' });
    upload.addEventListener('change', async () => {
      const file = upload.files[0];
      upload.value = '';
      if (!file) return;
      if (file.size > 1024 * 1024) return showMsg('ap-msg', 'The logo is larger than 1 MB', false);
      try {
        const { icon } = await HD.upload('/api/admin/logo', file);
        logoMode = null;
        set({ kind: 'file', id: icon.id });
        showMsg('ap-msg', 'Uploaded. Save appearance to use it.', true);
      } catch (e) {
        showMsg('ap-msg', e.message, false);
      }
    });
    const results = el('div', { class: 'icon-results' });
    const search = el('input', { type: 'search', id: 'logo-search', placeholder: 'Search the icon library (e.g. proxmox)', 'aria-label': 'Search the icon library' });
    search.addEventListener('input', () => {
      clearTimeout(logoSearchTimer);
      const q = search.value.trim();
      logoSearchTimer = setTimeout(async () => {
        if (q.length < 2) return results.replaceChildren();
        try {
          const { names } = await api('GET', `/api/admin/icons/search?q=${encodeURIComponent(q)}`);
          results.replaceChildren(...(names.length ? names.map((n) => el('button', {
            type: 'button',
            class: 'icon-choice',
            title: n,
            onclick: async () => {
              try {
                const { icon } = await api('POST', '/api/admin/icons/library', { name: n });
                logoMode = null;
                set({ kind: 'file', id: icon.id });
              } catch (e) {
                showMsg('ap-msg', e.message, false);
              }
            },
          }, el('img', { src: `/api/admin/icons/preview/${n}`, alt: '', loading: 'lazy' }), el('span', { text: n }))) : [el('span', { class: 'small muted', text: 'No icons found' })]));
        } catch (e) {
          results.replaceChildren(el('span', { class: 'msg error', text: e.message }));
        }
      }, 250);
    });
    parts.push(el('div', { class: 'logo-image' },
      el('label', { class: 'button' }, upload, HD.icon('upload'), 'Upload logo'),
      search),
    results,
    el('p', { class: 'hint', text: 'PNG, JPEG, WebP or SVG, up to 1 MB. A square or wide image works best. SVG files with scripts or links to other files are refused.' }));
  }
  $('logo-pick').replaceChildren(...parts);
}

function previewAppearance() {
  const a = appearance;
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.accent = a.accent || 'theme';
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
    logoMode = null;
    renderAppearance();
    // the new logo in the top bar and the browser tab right away
    const v = `/logo?v=${Date.now()}`;
    for (const img of document.querySelectorAll('.brand img')) img.src = v;
    const tab = document.querySelector('link[rel="icon"]');
    if (tab) tab.href = v;
    showMsg('ap-msg', 'Saved', true);
  } catch (e) {
    showMsg('ap-msg', e.message, false);
  }
});

$('ap-revert').addEventListener('click', () => {
  appearance = structuredClone(state.settings.appearance);
  logoMode = null;
  renderAppearance();
});

// ---------------------------------------------------------------------------
// Tabs (remembered in the URL, e.g. /admin#devices)

// In three groups: Monitoring (devices … check-ins), Dashboard (dashboard, look, power), System
const TABS = ['devices', 'services', 'alerts', 'schedules', 'dashboard', 'look', 'power', 'backups', 'security', 'system'];
// links from before: older tab names, and the cards that moved out of Alerts, "Dashboard & look" and System
const OLD_TABS = { hosts: 'devices', rack: 'devices', appearance: 'look', backup: 'backups', account: 'security', checkins: 'schedules', maintenance: 'schedules', sessions: 'security', server: 'system' };

function showTab(name, focus) {
  name = OLD_TABS[name] || name;
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
  if (name === 'system') loadWeb();
  if (name === 'backups') loadBackup();
  if (name === 'security') loadRemembered();
  if (name === 'alerts') loadAlerts();
  if (name === 'schedules') {
    loadCheckins();
    loadMaintenance();
  }
  $('tab-select').value = name;
}

// phones: one menu instead of ten buttons
$('tab-select').addEventListener('change', (e) => showTab(e.target.value));

for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
document.querySelector('.page-tabs').addEventListener('keydown', (e) => {
  const i = TABS.findIndex((t) => $(`tabbtn-${t}`) === document.activeElement);
  // the list is vertical on a wide screen and a row on a narrow one: both arrow pairs work
  const keys = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: TABS.length - 1 };
  if (i < 0 || !(e.key in keys)) return;
  e.preventDefault();
  showTab(TABS[(keys[e.key] + TABS.length) % TABS.length], true);
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

// ---------------------------------------------------------------------------
// Remembered devices (view only) and installing the app

const shortIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

// Signed-in browsers (full sessions); remembered view-only devices are listed below them
async function loadSessions() {
  try {
    const r = await api('GET', '/api/admin/sessions');
    $('sessions-others').hidden = r.sessions.length < 2;
    $('sessions').replaceChildren(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Browser' }), el('th', { text: 'Last used' }), el('th', { text: 'Signed in until' }), el('th'))),
      el('tbody', null, r.sessions.map((x) => el('tr', null,
        el('td', null,
          el('div', null, x.name, x.current ? el('span', { class: 'small muted', text: ' · this browser' }) : ''),
          el('div', { class: 'small muted num', text: `${x.keep ? `Kept signed in (${r.keepDays} days)` : 'Normal sign-in'} · from ${shortIp(x.lastIp)}` })),
        el('td', { class: 'small num', text: fmt.time(x.lastSeen) }),
        el('td', { class: 'small num', text: fmt.time(x.expires) }),
        el('td', { class: 'r' }, el('button', { type: 'button', text: 'Sign out', onclick: () => endSession(x) }))))))));
  } catch (e) {
    $('sessions').replaceChildren(el('p', { class: 'msg error', text: e.message }));
  }
}

async function endSession(x) {
  if (x.current && !confirm('Sign out this browser?')) return;
  try {
    await api('DELETE', `/api/admin/sessions/${x.id}`);
  } catch {
    /* listed again below */
  }
  if (x.current) location.href = '/login';
  else loadSessions();
}

$('sessions-others').addEventListener('click', async () => {
  if (!confirm('Sign out every other browser? They will need the password again.')) return;
  try {
    await api('DELETE', '/api/admin/sessions');
  } finally {
    loadSessions();
  }
});

async function loadRemembered() {
  loadSessions();
  try {
    const r = await api('GET', '/api/admin/remembered');
    $('remembered-all').hidden = r.devices.length < 2;
    $('remembered').replaceChildren(r.devices.length
      ? el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', { text: 'Device' }), el('th', { text: 'Last used' }), el('th', { text: 'Remembered until' }), el('th'))),
        el('tbody', null, r.devices.map((d) => el('tr', null,
          el('td', null, el('div', null, d.name, d.current ? el('span', { class: 'small muted', text: ' · this device' }) : ''), el('div', { class: 'small muted num', text: `from ${shortIp(d.lastIp)}` })),
          el('td', { class: 'small num', text: fmt.time(d.lastSeen) }),
          el('td', { class: 'small num', text: fmt.time(d.expires) }),
          el('td', { class: 'r' }, el('button', { type: 'button', text: 'Sign out', onclick: () => forgetRemembered(d) })))))))
      : el('p', { class: 'small muted', text: 'None.' }));
  } catch (e) {
    $('remembered').replaceChildren(el('p', { class: 'msg error', text: e.message }));
  }
}

async function forgetRemembered(d) {
  try {
    await api('DELETE', `/api/admin/remembered/${d.id}`);
  } finally {
    loadRemembered();
  }
}

$('remembered-all').addEventListener('click', async () => {
  if (!confirm('Sign out every remembered device? They will need the password again.')) return;
  try {
    await api('DELETE', '/api/admin/remembered');
  } finally {
    loadRemembered();
  }
});

let installPrompt = null;
const appState = (installable, text) => {
  $('app-install').hidden = !installable;
  $('app-state').textContent = text;
  $('app-actions').hidden = !installable && !text;
};
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  appState(true, '');
});
window.addEventListener('appinstalled', () => appState(false, 'Installed on this device.'));
$('app-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  appState(false, '');
});
if (matchMedia('(display-mode: standalone)').matches) appState(false, 'You are using the installed app.');
else if (!window.isSecureContext) appState(false, 'Open the dashboard over HTTPS to install it.');

HD.shell({ active: 'admin', admin: true });
load();
