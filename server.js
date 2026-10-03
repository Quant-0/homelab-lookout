#!/usr/bin/env node
'use strict';
// Homelab dashboard: single-file server, no external dependencies. Requires Node.js >= 18.
//
//   node server.js                    start the server
//   node server.js set-admin [user]   create/replace the admin account (prompts for password)
//
// Environment:
//   HOST            address to bind (loopback or private IP only; never 0.0.0.0)   default 127.0.0.1
//   PORT            default 8080
//   DATA_DIR        state directory (0700)                                      default /var/lib/homelab-dashboard
//   KEY_FILE        AES-256 key file (0600) when not using systemd LoadCredential=secret_key
//   ALLOWED_HOSTS   extra comma-separated Host names accepted (e.g. lookout.tailnet.ts.net)
//   PORT            default HTTP port (8080); HTTPS_PORT default HTTPS port (8443). Both can be
//                   changed in Admin afterwards (Dashboard → Web server)
//   TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_FILE   certificate when not using systemd LoadCredential
//                   (tls_cert, tls_key, ca_cert), e.g. for development
//   COOKIE_SECURE   1/0 override for the Secure cookie flag (default: on for HTTPS requests)
//
//   node server.js reset-network   reset HTTP/HTTPS ports to the defaults (service stopped)

const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/var/lib/homelab-dashboard');
const HOST = (process.env.HOST || '127.0.0.1').trim();
const PORT = parseInt(process.env.PORT || '8080', 10);
const TZ = 'Europe/Oslo';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const ENERGY_FILE = path.join(DATA_DIR, 'energy.json');
const REMEMBER_FILE = path.join(DATA_DIR, 'remembered.json');

const SESSION_IDLE_MS = 2 * 3600 * 1000;
const SESSION_MAX_MS = 12 * 3600 * 1000;
const REMEMBER_MS = 30 * 86400 * 1000; // "Remember this device": view-only, fixed 30 days from login
const REMEMBER_MAX = 20;
const MAX_BODY = 64 * 1024;
const COLLECT_TIMEOUT_MS = 45000; // iDRAC8 can be slow to answer

const HOST_TYPES = {
  idrac: { label: 'iDRAC', port: 443 },
  proxmox: { label: 'Proxmox', port: 8006 },
  truenas: { label: 'TrueNAS', port: 443 },
  synology: { label: 'Synology', port: 161 }, // SNMPv3 over UDP
  unifi: { label: 'UniFi', port: 443 },
};
const AREAS = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
const THEMES = [
  'auto', 'light', 'dark', 'nord', 'dracula', 'catppuccin-mocha', 'catppuccin-latte',
  'solarized-dark', 'solarized-light', 'gruvbox-dark', 'tokyo-night',
];
const BUILTIN_BACKGROUNDS = ['aurora', 'sunset', 'ocean', 'forest', 'nebula', 'graphite'];
const MAX_BACKGROUNDS = 20;
const MAX_BACKGROUND_BYTES = 10 << 20;
const RACK_KINDS = ['server', 'storage', 'nas', 'switch', 'gateway', 'patch-panel', 'shelf', 'pdu', 'ups', 'blank', 'ap', 'other'];
// host:<host id> | unifi:<host id>:<device mac> | pve:<host id>:<node name>
const RACK_LINK = /^(host:[0-9a-f-]{36}|unifi:[0-9a-f-]{36}:[0-9a-f:]{17}|pve:[0-9a-f-]{36}:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const DEFAULT_RACK = { enabled: true, units: 24, numbering: 'bottom', passive: [] };
// Passive rack items: no name, no monitoring, not in the docs
const PASSIVE_KINDS = { blank: 'Blank panel', vented: 'Vented panel', brush: 'Brush panel', cable: 'Cable management', patch: 'Patch panel', shelf: 'Shelf' };
// How a device's front is drawn in the rack ('auto' = from the model it reports)
const FRONTS = ['auto', 'dell13', 'dell14', 'udm-pro', 'usw-24-poe', 'unifi-switch', 'synology-rs', 'synology-ds', 'server', 'switch', 'plain'];
const DRIVE_LAYOUTS = ['auto', 'none', '4x3.5', '8x3.5', '12x3.5', '8x2.5', '10x2.5', '16x2.5', '24x2.5'];
const DEVICE_LOCATIONS = ['rack', 'outside', 'none']; // none = not placed
const KIND_FOR_TYPE = { idrac: 'server', proxmox: 'server', truenas: 'storage', synology: 'nas', unifi: 'gateway' };
const WIDGET_ID = /^(power-summary|power-chart|device:[0-9a-f-]{36})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NORGESPRIS_ORE_EX_VAT = 40; // 50 øre/kWh incl. 25 % VAT

const DEFAULT_SETTINGS = {
  dashboard: { title: 'Homelab', refreshSeconds: 30, public: false, showStoppedGuests: true },
  power: {
    plan: 'spot',
    area: 'NO1',
    vat: true,
    markupOre: 0,
    support: { enabled: true, thresholdOre: 77, percent: 90 },
    grid: {
      dayOre: 0,
      nightOre: 0,
      ratesInclVat: true, // entered day/night rates already include 25 % VAT
      ratesInclFees: true, // ...and already include elavgift + Enova fee
      elavgiftOre: 7.13, // excl. VAT (2026 standard rate)
      enovaOre: 1.0, // excl. VAT
      dayStartHour: 6,
      dayEndHour: 22,
      weekendNight: true,
      holidayNight: true,
    },
    fixed: { gridMonthlyKr: 0, supplierMonthlyKr: 0, include: false },
    includeEstimates: false, // count estimated device power (rack equipment) in cost
  },
  server: {
    https: { enabled: true, port: parseInt(process.env.HTTPS_PORT || '8443', 10) },
    http: { enabled: true, port: PORT, mode: 'redirect' }, // redirect | serve
  },
  appearance: {
    theme: 'auto',
    background: { type: 'none', builtin: 'aurora', imageId: null },
    blur: 12, // px
    dim: 35, // % scrim over the background
    cardOpacity: 85, // % (below 100 gives frosted-glass cards)
  },
};

// ---------------------------------------------------------------------------
// Utilities

class UserError extends Error {} // message is safe to show to the admin

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fatal(msg) {
  console.error('FATAL:', msg);
  process.exit(1);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return structuredClone(base);
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(v, over[k]) : k in over ? over[k] : v;
  }
  return out;
}

function withTimeout(promise, ms, what = 'Request') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new UserError(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(s);
}

// ---------------------------------------------------------------------------
// Data directory and encryption key

function ensureDataDir() {
  if (isInside(DATA_DIR, ROOT)) fatal(`DATA_DIR (${DATA_DIR}) must be outside the application directory`);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const st = fs.statSync(DATA_DIR);
  if (st.uid !== process.getuid()) fatal(`DATA_DIR ${DATA_DIR} is not owned by the user running the server`);
  if ((st.mode & 0o777) !== 0o700) {
    fs.chmodSync(DATA_DIR, 0o700);
    log(`Fixed permissions on ${DATA_DIR} to 0700`);
  }
}

function loadKey() {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  let file;
  let fromCredential = false;
  if (credDir && fs.existsSync(path.join(credDir, 'secret_key'))) {
    file = path.join(credDir, 'secret_key');
    fromCredential = true;
  } else {
    file = path.resolve(process.env.KEY_FILE || path.join(DATA_DIR, 'secret.key'));
  }
  if (isInside(file, ROOT)) fatal('The encryption key file must be outside the application directory');
  if (!fromCredential) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
      log(`Generated new encryption key at ${file}`);
    }
    const st = fs.statSync(file);
    if (st.mode & 0o077) fatal(`Key file ${file} is accessible by other users; run: chmod 600 ${file}`);
  }
  const raw = fs.readFileSync(file);
  let key;
  if (raw.length === 32) key = raw;
  else {
    const text = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, 'hex');
    else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) key = Buffer.from(text, 'base64');
  }
  if (!key || key.length !== 32) fatal('Encryption key must be 32 bytes (raw, 64 hex chars or base64)');
  return key;
}

let KEY = null;

// The secret is bound to the host's identity: changing type/address/username/TLS pin
// makes old ciphertext undecryptable, on top of being deleted explicitly.
function secretAad(h) {
  return Buffer.from(JSON.stringify(['v1', h.id, h.type, h.address, h.username, h.tlsMode, h.fingerprint || '']));
}

function encryptSecret(h, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  c.setAAD(secretAad(h));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decryptSecret(h) {
  try {
    if (typeof h.secret !== 'string' || !h.secret.startsWith('v1.')) throw new Error('format');
    const buf = Buffer.from(h.secret.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAAD(secretAad(h));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new UserError('Stored credential could not be decrypted (key changed?); please re-enter it');
  }
}

// ---------------------------------------------------------------------------
// Admin account (scrypt)

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, p) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: 128 * p.N * p.r * 2 }, (e, k) =>
      e ? reject(e) : resolve(k)
    )
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const p = { N: +parts[1], r: +parts[2], p: +parts[3] };
  const expected = Buffer.from(parts[5], 'base64');
  const actual = await scryptAsync(password, Buffer.from(parts[4], 'base64'), { ...p, keylen: expected.length });
  return crypto.timingSafeEqual(actual, expected);
}

// Used so unknown usernames cost the same time as known ones.
let DUMMY_HASH = null;

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Password must be at least 12 characters';
  if (pw.length > 1024) return 'Password is too long';
  return null;
}

function readAdmin() {
  return readJson(ADMIN_FILE, null);
}

// ---------------------------------------------------------------------------
// Config

let config = null;

// A device is a physical box (server, NAS, switch, patch panel, ...). Monitoring connections
// (`hosts`: iDRAC, Proxmox, TrueNAS, Synology, UniFi) belong to a device via `deviceId`.
// Devices found through a UniFi console are created automatically (`discovered`, `unifi`).
function newDevice(fields) {
  return { id: crypto.randomUUID(), name: 'Device', kind: 'other', location: 'none', u: null, height: 1, estimateW: null, unifi: null, discovered: false, hidden: false, ...fields };
}

function loadConfig() {
  const raw = readJson(CONFIG_FILE, {});
  config = {
    version: 2,
    settings: deepMerge(DEFAULT_SETTINGS, raw.settings),
    hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
    backgrounds: Array.isArray(raw.backgrounds) ? raw.backgrounds : [], // [{ id, mime, bytes, name, uploadedAt }]
    layout: raw.layout && Array.isArray(raw.layout.items) ? raw.layout : null,
    rack: {
      enabled: raw.rack?.enabled !== false,
      units: Number.isInteger(raw.rack?.units) ? raw.rack.units : DEFAULT_RACK.units,
      numbering: raw.rack?.numbering === 'top' ? 'top' : 'bottom',
      passive: cleanPassive(raw.rack?.passive),
    },
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    services: Array.isArray(raw.services) ? raw.services : [],
    icons: Array.isArray(raw.icons) ? raw.icons : [], // [{ id, mime, bytes, source, addedAt }]
    servicesLayout: raw.servicesLayout?.groups ? raw.servicesLayout : null,
    backup: { ...structuredClone(DEFAULT_BACKUP), ...(raw.backup || {}), schedule: { ...DEFAULT_BACKUP.schedule, ...(raw.backup?.schedule || {}) } },
    alerts: normalizeAlerts(raw.alerts),
  };
  if (!Array.isArray(raw.devices)) migrateToDevices(raw);
  // Blank panels, patch panels and shelves used to be devices; they are passive rack items now
  const PASSIVE_FROM = { blank: 'blank', 'patch-panel': 'patch', shelf: 'shelf' };
  config.devices = config.devices.filter((d) => {
    if (!PASSIVE_FROM[d.kind] || d.unifi || config.hosts.some((h) => h.deviceId === d.id)) return true;
    if (d.location === 'rack' && Number.isInteger(d.u)) {
      config.rack.passive.push({ id: d.id, kind: PASSIVE_FROM[d.kind], u: d.u, height: Math.min(Math.max(d.height || 1, 1), 4), ...(d.kind === 'patch-panel' ? { ports: 24 } : {}) });
      return false;
    }
    return true;
  });
  // Every connection belongs to a device
  for (const h of config.hosts) {
    if (config.devices.some((d) => d.id === h.deviceId)) continue;
    const d = newDevice({ name: h.name, kind: KIND_FOR_TYPE[h.type] || 'other' });
    config.devices.push(d);
    h.deviceId = d.id;
  }
}

// Version 1 had hosts plus rack items that linked to them; turn that into devices.
function migrateToDevices(raw) {
  const hostById = new Map(config.hosts.map((h) => [h.id, h]));
  for (const it of Array.isArray(raw.rack?.items) ? raw.rack.items : []) {
    const d = newDevice({
      id: typeof it.id === 'string' && UUID.test(it.id) ? it.id : crypto.randomUUID(),
      name: String(it.name || 'Device').slice(0, 48),
      kind: RACK_KINDS.includes(it.kind) ? it.kind : 'other',
      location: it.location || (it.u === null || it.u === undefined ? 'outside' : 'rack'),
      u: it.u ?? null,
      height: it.height || 1,
      estimateW: it.estimateW ?? null,
    });
    for (const l of it.links || []) {
      const [kind, hostId, ...rest] = String(l).split(':');
      const h = hostById.get(hostId);
      if (kind === 'host' && h && !h.deviceId) h.deviceId = d.id;
      if (kind === 'pve' && h && !h.deviceId) {
        h.deviceId = d.id;
        h.options = { ...(h.options || {}), node: rest.join(':') };
      }
      if (kind === 'unifi' && !d.unifi) d.unifi = { hostId, mac: rest.join(':') };
    }
    config.devices.push(d);
  }
  // A UniFi console's own device is the gateway it reports (e.g. the UDM Pro rack item)
  for (const h of config.hosts) {
    if (h.type !== 'unifi' || h.deviceId) continue;
    const gw = config.devices.find((d) => d.unifi?.hostId === h.id && ['gateway', 'other'].includes(d.kind));
    if (gw) h.deviceId = gw.id;
  }
  for (const h of config.hosts) {
    if (h.deviceId) continue;
    const d = newDevice({ name: h.name, kind: KIND_FOR_TYPE[h.type] || 'other' });
    config.devices.push(d);
    h.deviceId = d.id;
  }
  // Dashboard layout: one widget per device instead of per host
  if (config.layout) {
    const toDevice = (id) => {
      const m = /^(idrac|proxmox|truenas|synology|unifi):(.+)$/.exec(id);
      if (!m) return id;
      const h = hostById.get(m[2]);
      return h ? `device:${h.deviceId}` : null;
    };
    const seen = new Set();
    config.layout.items = config.layout.items
      .map((i) => ({ ...i, id: toDevice(i.id) }))
      .filter((i) => i.id && !seen.has(i.id) && seen.add(i.id));
    config.layout.hidden = [...new Set((config.layout.hidden || []).map(toDevice).filter(Boolean))];
  }
  if (raw.rack?.items) log(`Converted ${config.devices.length} devices from the old rack/host setup`);
}

function saveConfig() {
  writeJsonAtomic(CONFIG_FILE, config);
}

// Only these fields ever leave the server for a host. `secret` never does.
function publicHost(h) {
  return {
    id: h.id,
    type: h.type,
    name: h.name,
    address: h.address,
    username: h.username,
    tlsMode: h.tlsMode,
    fingerprint: h.fingerprint ? formatFingerprint(h.fingerprint) : '',
    options: h.options || {},
    hasSecret: Boolean(h.secret),
  };
}

function normalizeAddress(input, type) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  let host;
  let port;
  const v6 = s.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (v6) [, host, port] = v6;
  else if (net.isIPv6(s)) host = s;
  else {
    const m = s.match(/^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/);
    if (!m) throw new UserError('Address must be a hostname or IP, optionally with :port (no path)');
    [, host, port] = m;
    if (!net.isIPv4(host) && !host.split('.').every((l) => /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l)))
      throw new UserError('Invalid hostname');
  }
  if (net.isIPv6(host) === false && v6) throw new UserError('Invalid IPv6 address');
  const portNum = port ? parseInt(port, 10) : HOST_TYPES[type].port;
  if (!(portNum >= 1 && portNum <= 65535)) throw new UserError('Invalid port');
  return net.isIPv6(host) ? `[${host}]:${portNum}` : `${host.toLowerCase()}:${portNum}`;
}

function splitAddress(address) {
  const m = address.match(/^\[(.+)\]:(\d+)$/) || address.match(/^(.+):(\d+)$/);
  return { host: m[1], port: parseInt(m[2], 10) };
}

function normalizeFingerprint(fp) {
  const hex = String(fp || '')
    .replace(/^sha256[:/ ]*/i, '')
    .replace(/[\s:]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new UserError('Fingerprint must be a SHA-256 hash (64 hex characters)');
  return hex;
}

function formatFingerprint(hex) {
  return hex.toUpperCase().match(/../g).join(':');
}

function validateHostInput(body, type) {
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 64 || hasControlChars(name)) throw new UserError('Name is required (max 64 characters)');
  const address = normalizeAddress(body.address, type);
  const username = String(body.username ?? '').trim();
  if (username.length > 128 || hasControlChars(username) || /\s/.test(username)) throw new UserError('Invalid username');
  if (type === 'idrac' && username.includes(':')) throw new UserError('iDRAC username cannot contain ":"');
  if (type === 'idrac' && !username) throw new UserError('Username is required for iDRAC');
  if (type === 'proxmox' && !/^[^\s@!=]+@[^\s@!=]+![A-Za-z][A-Za-z0-9._-]*$/.test(username))
    throw new UserError('Proxmox username must be the full token ID, e.g. root@pam!dashboard');
  if ((type === 'unifi' || type === 'synology') && !username) throw new UserError('Username is required');
  if (type === 'synology') {
    // SNMP has no TLS; the agent's engine ID is pinned instead
    const engineId = String(body.fingerprint || '').replace(/[\s:]/g, '').toLowerCase();
    if (!/^([0-9a-f]{2}){5,32}$/.test(engineId)) throw new UserError('SNMP engine ID is required (fetch it from the device)');
    const snmpAuth = body.options?.snmpAuth === 'sha256' ? 'sha256' : 'sha';
    return { name, address, username, tlsMode: 'pin', fingerprint: engineId, options: { snmpAuth } };
  }
  const tlsMode = body.tlsMode === 'pin' ? 'pin' : 'verify';
  const fingerprint = tlsMode === 'pin' ? normalizeFingerprint(body.fingerprint) : '';
  return { name, address, username, tlsMode, fingerprint, options: {} };
}

// Synology stores two SNMPv3 passwords; they are set together as one encrypted secret.
function secretFromBody(type, body) {
  if (type !== 'synology') return validateSecret(body.secret);
  const auth = validateSecret(body.secret);
  const priv = validateSecret(body.secret2);
  if (!auth && !priv) return null;
  if (!auth || !priv) throw new UserError('Enter both the authentication and the privacy password');
  if (auth.length < 8 || priv.length < 8) throw new UserError('SNMPv3 passwords must be at least 8 characters');
  return JSON.stringify({ auth, priv });
}

function validateSecret(s) {
  if (typeof s !== 'string') return null;
  if (s.length === 0) return null;
  if (s.length > 4096 || hasControlChars(s)) throw new UserError('Invalid password/token/key');
  return s;
}

function num(v, min, max, name, { int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n)))
    throw new UserError(`${name} must be ${int ? 'a whole number' : 'a number'} between ${min} and ${max}`);
  return n;
}

function validateDashboard(d) {
  const title = String(d.title ?? '').trim() || 'Homelab';
  if (title.length > 60 || hasControlChars(title)) throw new UserError('Title is too long');
  return {
    title,
    refreshSeconds: num(d.refreshSeconds, 10, 3600, 'Refresh interval', { int: true }),
    public: d.public === true,
    showStoppedGuests: d.showStoppedGuests !== false,
  };
}

function validatePower(p) {
  const g = p.grid || {};
  const s = p.support || {};
  const fx = p.fixed || {};
  if (!['spot', 'norgespris'].includes(p.plan)) throw new UserError('Invalid plan');
  if (!AREAS.includes(p.area)) throw new UserError('Invalid price area');
  const dayStartHour = num(g.dayStartHour, 0, 23, 'Day start hour', { int: true });
  const dayEndHour = num(g.dayEndHour, 1, 24, 'Day end hour', { int: true });
  if (dayEndHour <= dayStartHour) throw new UserError('Day end hour must be after day start hour');
  return {
    plan: p.plan,
    area: p.area,
    vat: p.vat !== false,
    markupOre: num(p.markupOre ?? 0, -100, 1000, 'Supplier markup'),
    support: {
      enabled: s.enabled === true,
      thresholdOre: num(s.thresholdOre, 0, 1000, 'Subsidy threshold'),
      percent: num(s.percent, 0, 100, 'Subsidy percentage'),
    },
    grid: {
      dayOre: num(g.dayOre, 0, 1000, 'Day rate'),
      nightOre: num(g.nightOre, 0, 1000, 'Night rate'),
      ratesInclVat: g.ratesInclVat === true,
      ratesInclFees: g.ratesInclFees === true,
      elavgiftOre: num(g.elavgiftOre, 0, 100, 'Elavgift'),
      enovaOre: num(g.enovaOre, 0, 100, 'Enova fee'),
      dayStartHour,
      dayEndHour,
      weekendNight: g.weekendNight === true,
      holidayNight: g.holidayNight === true,
    },
    fixed: {
      gridMonthlyKr: num(fx.gridMonthlyKr ?? 0, 0, 100000, 'Fixed grid fee'),
      supplierMonthlyKr: num(fx.supplierMonthlyKr ?? 0, 0, 100000, 'Supplier monthly fee'),
      include: fx.include === true,
    },
    includeEstimates: p.includeEstimates === true,
  };
}

function validateAppearance(a) {
  const bg = a.background || {};
  if (!THEMES.includes(a.theme)) throw new UserError('Unknown theme');
  if (!['none', 'builtin', 'image'].includes(bg.type)) throw new UserError('Invalid background type');
  const builtin = BUILTIN_BACKGROUNDS.includes(bg.builtin) ? bg.builtin : 'aurora';
  const imageId = typeof bg.imageId === 'string' && config.backgrounds.some((b) => b.id === bg.imageId) ? bg.imageId : null;
  if (bg.type === 'image' && !imageId) throw new UserError('Choose an uploaded image');
  return {
    theme: a.theme,
    background: { type: bg.type, builtin, imageId },
    blur: num(a.blur, 0, 40, 'Blur', { int: true }),
    dim: num(a.dim, 0, 90, 'Background dimming', { int: true }),
    cardOpacity: num(a.cardOpacity, 30, 100, 'Card opacity', { int: true }),
  };
}

// Sections not present in the request keep their current values.
function validateSettings(b, current) {
  return {
    dashboard: b.dashboard ? validateDashboard(b.dashboard) : current.dashboard,
    power: b.power ? validatePower(b.power) : current.power,
    appearance: b.appearance ? validateAppearance(b.appearance) : current.appearance,
    server: current.server, // changed only through /api/admin/server
  };
}

function validateServerSettings(b) {
  const port = (v, name) => num(v, 1, 65535, `${name} port`, { int: true });
  const https = { enabled: b.https?.enabled === true, port: port(b.https?.port, 'HTTPS') };
  const http = { enabled: b.http?.enabled === true, port: port(b.http?.port, 'HTTP'), mode: b.http?.mode === 'serve' ? 'serve' : 'redirect' };
  if (!https.enabled && !http.enabled) throw new UserError('At least one of HTTP and HTTPS must be on');
  if (https.enabled && http.enabled && https.port === http.port) throw new UserError('HTTP and HTTPS need different ports');
  if (https.enabled && !tlsInfo) throw new UserError('No certificate is installed; re-run the installer to create one');
  if (http.enabled && http.mode === 'redirect' && !https.enabled) throw new UserError('Redirecting to HTTPS needs HTTPS to be on');
  return { https, http };
}

// Typical draw from spec sheets, used to pre-fill estimates (W, without PoE output).
const POWER_HINTS = { DS418: 26, DS418play: 26, DS420: 24, DS918: 28, DS920: 32, DS923: 35, DS220: 17, DS224: 15, UDMPRO: 25, UDMPROSE: 30, UDM: 15, UCGMAX: 12 };
const TYPE_HINTS = { usw: 20, udm: 25, ugw: 15, uxg: 15 };

// Normalized names, used to pick the Proxmox node matching a device ("Orion" = node "orion").
const matchName = (n) => String(n || '').toLowerCase().split('.')[0].replace(/[^a-z0-9]/g, '');
const PVE_NODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateRackSettings(b) {
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!int(b.units, 1, 60)) throw new UserError('Rack size must be 1–60 U');
  const tooHigh = config.devices.find((d) => !d.hidden && d.location === 'rack' && d.u + d.height - 1 > b.units)
    || config.rack.passive.map((x) => ({ ...x, name: `The ${PASSIVE_KINDS[x.kind].toLowerCase()}` })).find((x) => x.u + x.height - 1 > b.units);
  if (tooHigh) throw new UserError(`${tooHigh.name} sits at U${tooHigh.u + tooHigh.height - 1}; move it before shrinking the rack`);
  return { enabled: b.enabled !== false, units: b.units, numbering: b.numbering === 'top' ? 'top' : 'bottom', passive: config.rack.passive };
}

function rackClash(dev, selfId) {
  const overlaps = (o) => o.id !== selfId && o.u <= dev.u + dev.height - 1 && dev.u <= o.u + o.height - 1;
  const d = config.devices.find((o) => !o.hidden && o.location === 'rack' && overlaps(o));
  if (d) return d;
  const p = config.rack.passive.find(overlaps);
  return p ? { name: `the ${PASSIVE_KINDS[p.kind].toLowerCase()} at U${p.u}` } : null;
}

function validatePassive(b, selfId) {
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!PASSIVE_KINDS[b.kind]) throw new UserError('Invalid panel type');
  const label = PASSIVE_KINDS[b.kind];
  const height = b.height ?? 1;
  if (!int(height, 1, 4)) throw new UserError('Height must be 1–4 U');
  if (!int(b.u, 1, config.rack.units) || b.u + height - 1 > config.rack.units) throw new UserError(`The ${label.toLowerCase()} does not fit at U${b.u ?? '?'} (the rack has ${config.rack.units} U)`);
  const clash = rackClash({ u: b.u, height }, selfId);
  if (clash) throw new UserError(`The ${label.toLowerCase()} overlaps ${clash.name}`);
  return { kind: b.kind, u: b.u, height, ...(b.kind === 'patch' ? { ports: [12, 24, 48].includes(b.ports) ? b.ports : 24 } : {}) };
}

// From the config file or a backup: keep well-formed items only
const cleanPassive = (list) => (Array.isArray(list) ? list : []).filter((x) => UUID.test(x?.id) && PASSIVE_KINDS[x.kind] && Number.isInteger(x.u) && Number.isInteger(x.height) && x.height >= 1 && x.height <= 4)
  .slice(0, 120).map((x) => ({ id: x.id, kind: x.kind, u: x.u, height: x.height, ...(x.kind === 'patch' ? { ports: [12, 24, 48].includes(x.ports) ? x.ports : 24 } : {}) }));

function validateFront(f) {
  return { model: FRONTS.includes(f?.model) ? f.model : 'auto', drives: DRIVE_LAYOUTS.includes(f?.drives) ? f.drives : 'auto' };
}

function validatePlacement(b, selfId, name) {
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const location = DEVICE_LOCATIONS.includes(b.location) ? b.location : 'none';
  const height = b.height ?? 1;
  if (!int(height, 1, 12)) throw new UserError('Height must be 1–12 U');
  const u = location === 'rack' ? b.u : null;
  if (location === 'rack') {
    if (!int(u, 1, config.rack.units) || u + height - 1 > config.rack.units) throw new UserError(`${name} does not fit in the rack at U${u ?? '?'} (the rack has ${config.rack.units} U)`);
    const clash = rackClash({ u, height }, selfId);
    if (clash) throw new UserError(`${name} overlaps ${clash.name}`);
  }
  return { location, u, height };
}

function validateDeviceFields(b, selfId) {
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 48 || hasControlChars(name)) throw new UserError('Name is required (max 48 characters)');
  if (!RACK_KINDS.includes(b.kind)) throw new UserError('Invalid device type');
  const estimateW = b.estimateW === null || b.estimateW === undefined || b.estimateW === '' ? null : num(b.estimateW, 0, 5000, 'Estimated power');
  return { name, kind: b.kind, ...validatePlacement(b, selfId, name), estimateW, ...(b.front !== undefined ? { front: validateFront(b.front) } : {}) };
}

// Creates or updates a connection from request data. A changed address, user name or pinned
// identity without a newly entered secret deletes the stored secret.
function buildConnection(old, body, device) {
  const type = old ? old.type : body.type;
  if (!HOST_TYPES[type]) throw new UserError('Invalid connection type');
  const fields = validateHostInput({ ...body, name: device.name }, type);
  const next = old ? { ...old, ...fields, deviceId: device.id } : { id: crypto.randomUUID(), type, ...fields, deviceId: device.id, secret: null };
  if (type === 'proxmox') {
    const node = String(body.options?.node ?? '').trim();
    if (node && !PVE_NODE.test(node)) throw new UserError('Invalid Proxmox node name');
    next.options = { ...next.options, node };
  }
  const secret = secretFromBody(type, body);
  let note = null;
  if (secret) next.secret = encryptSecret(next, secret);
  else if (old && body.clearSecret === true) next.secret = null;
  else if (old && old.secret && ['address', 'username', 'tlsMode', 'fingerprint'].some((k) => next[k] !== old[k])) {
    next.secret = null; // never send an old secret to a different endpoint/identity
    note = `${HOST_TYPES[type].label}: the address, user name or pinned identity changed, so the stored secret was deleted. Enter it again.`;
  }
  return { host: next, note };
}

function validateConnections(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > Object.keys(HOST_TYPES).length) throw new UserError('Invalid connections');
  const types = list.map((c) => c?.type);
  if (new Set(types).size !== types.length) throw new UserError('A device can have only one connection of each type');
  return list;
}

function findDevice(id) {
  const d = config.devices.find((x) => x.id === id);
  if (!d) throw Object.assign(new UserError('Device not found'), { status: 404 });
  return d;
}

function deviceHosts(d) {
  return config.hosts.filter((h) => h.deviceId === d.id);
}

// The Proxmox node a device represents: chosen, the only node, or the one named like the device.
function effectiveNode(h, d) {
  if (h.options?.node) return h.options.node;
  const nodes = results.get(h.id)?.data?.nodes || [];
  if (nodes.length === 1) return nodes[0].name;
  return nodes.find((n) => matchName(n.name) === matchName(d.name))?.name || null;
}

// Rack/status links for the dashboard (derived from the device's connections)
function deviceLinks(d) {
  const links = [];
  for (const h of deviceHosts(d)) {
    if (h.type === 'proxmox') {
      const node = effectiveNode(h, d);
      links.push(node ? `pve:${h.id}:${node}` : `host:${h.id}`);
    } else if (h.type !== 'unifi') links.push(`host:${h.id}`);
  }
  if (d.unifi) links.push(`unifi:${d.unifi.hostId}:${d.unifi.mac}`);
  return links;
}

// Devices reported by a UniFi console appear automatically; the console's own gateway
// (e.g. the UDM Pro) is attached to the device that holds the connection.
function syncUnifiDevices(h, devices) {
  const owner = config.devices.find((d) => d.id === h.deviceId);
  let added = 0;
  for (const ud of devices) {
    if (!ud.mac || config.devices.some((d) => d.unifi?.hostId === h.id && d.unifi.mac === ud.mac)) continue;
    const gateway = ['udm', 'uxg', 'ugw'].includes(ud.type);
    const hint = ud.type === 'uap' ? null : POWER_HINTS[ud.model] ?? TYPE_HINTS[ud.type] ?? null;
    if (gateway && owner && !owner.unifi) {
      owner.unifi = { hostId: h.id, mac: ud.mac };
      if (owner.estimateW === null && hint !== null) owner.estimateW = hint;
      added++;
      continue;
    }
    config.devices.push(newDevice({
      name: String(ud.name || ud.model || ud.mac).slice(0, 48),
      kind: ud.type === 'usw' ? 'switch' : ud.type === 'uap' ? 'ap' : gateway ? 'gateway' : 'other',
      location: ud.type === 'uap' ? 'outside' : 'none',
      estimateW: hint,
      unifi: { hostId: h.id, mac: ud.mac },
      discovered: true,
    }));
    added++;
  }
  if (added) {
    saveConfig();
    log(`UniFi: ${added} device(s) found through ${h.name}`);
  }
}

function validateLayout(b) {
  if (b === null || b.items === null) return null;
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!Array.isArray(b.items) || b.items.length > 300) throw new UserError('Invalid layout');
  const seen = new Set();
  const items = b.items.map((i) => {
    if (!i || typeof i.id !== 'string' || !WIDGET_ID.test(i.id) || seen.has(i.id)) throw new UserError('Invalid layout item');
    seen.add(i.id);
    if (!int(i.x, 0, 11) || !int(i.w, 1, 12) || i.x + i.w > 12 || !int(i.y, 0, 2000) || !int(i.h, 1, 300))
      throw new UserError('Invalid layout position');
    return { id: i.id, x: i.x, y: i.y, w: i.w, h: i.h };
  });
  const hidden = Array.isArray(b.hidden) ? b.hidden.filter((id) => typeof id === 'string' && WIDGET_ID.test(id)).slice(0, 300) : [];
  // v2: sizes made for the compact cards; older layouts keep their places but re-measure heights
  return { v: b.v === 2 ? 2 : 1, items, hidden: [...new Set(hidden)] };
}

// ---------------------------------------------------------------------------
// Outbound TLS with optional certificate pinning
//
// The TLS handshake is completed and the peer certificate verified (CA chain + hostname,
// or SHA-256 pin) before a single byte of application data, and thus any credential,
// is written to the socket.

function friendlyNetError(e) {
  const map = {
    ECONNREFUSED: 'Connection refused',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    ENOTFOUND: 'Hostname not found',
    EAI_AGAIN: 'DNS lookup failed',
    ETIMEDOUT: 'Connection timed out',
    ECONNRESET: 'Connection reset',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed certificate; use fingerprint pinning',
    SELF_SIGNED_CERT_IN_CHAIN: 'Certificate not trusted (self-signed CA); use fingerprint pinning',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Certificate not trusted; use fingerprint pinning',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Certificate not trusted; use fingerprint pinning',
    CERT_HAS_EXPIRED: 'Certificate has expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'Certificate does not match hostname',
  };
  if (e instanceof UserError) return e;
  return new UserError(map[e.code] || 'Connection failed' + (e.code ? ` (${e.code})` : ''));
}

// With `socket`, upgrades an existing connection (SMTP STARTTLS) instead of opening one.
function tlsConnect(target, { timeoutMs = 15000, pin = null, verify = true, alpn = ['http/1.1'], socket = null } = {}) {
  const { host, port } = splitAddress(target);
  return new Promise((resolve, reject) => {
    const opts = { host, port, minVersion: 'TLSv1.2', rejectUnauthorized: verify && !pin, ...(alpn ? { ALPNProtocols: alpn } : {}), ...(socket ? { socket } : {}) };
    if (!net.isIP(host)) opts.servername = host;
    const sock = tls.connect(opts);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new UserError('Connection timed out'));
    }, timeoutMs);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      if (pin) {
        const cert = sock.getPeerCertificate();
        const actual = cert && cert.raw ? crypto.createHash('sha256').update(cert.raw).digest() : Buffer.alloc(32);
        if (!crypto.timingSafeEqual(actual, Buffer.from(pin, 'hex'))) {
          sock.destroy();
          return reject(new UserError('TLS fingerprint mismatch; nothing was sent. Verify the certificate and update the pin'));
        }
      }
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(friendlyNetError(e));
    });
  });
}

function connectHost(h, opts = {}) {
  return tlsConnect(h.address, { ...opts, pin: h.tlsMode === 'pin' ? h.fingerprint : null, verify: true });
}

function hostHeader(address) {
  const { host, port } = splitAddress(address);
  const name = net.isIPv6(host) ? `[${host}]` : host;
  return port === 443 ? name : `${name}:${port}`;
}

// With `full`, resolves { status, headers, json, text } for any status instead of rejecting non-2xx.
// With `headOnly`, resolves { status, headers } as soon as the response starts (status checks).
async function httpsRequest(sockPromise, address, { method = 'GET', path: reqPath, headers = {}, body = null, full = false, headOnly = false, binary = false, timeoutMs = 15000, maxBytes = 8 << 20 }) {
  const sock = await sockPromise;
  return new Promise((resolve, reject) => {
    if (body !== null) headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers };
    const req = http.request({
      method,
      path: reqPath,
      createConnection: () => sock,
      headers: { Host: hostHeader(address), Accept: 'application/json', Connection: 'close', ...headers },
      timeout: timeoutMs,
    });
    req.on('timeout', () => req.destroy(new UserError('Request timed out')));
    req.on('error', (e) => reject(e instanceof UserError ? e : friendlyNetError(e)));
    req.on('response', (res) => {
      if (headOnly) {
        resolve({ status: res.statusCode, headers: res.headers });
        res.destroy();
        sock.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new UserError('Response too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        sock.destroy();
        if (binary) return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        const text = Buffer.concat(chunks).toString('utf8');
        if (full) {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          return resolve({ status: res.statusCode, headers: res.headers, json, text });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const hint = res.statusCode === 401 ? ' (authentication failed)' : res.statusCode === 403 ? ' (permission denied)' : '';
          const err = new UserError(`HTTP ${res.statusCode}${hint}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new UserError('Invalid JSON response'));
        }
      });
      res.on('error', (e) => reject(friendlyNetError(e)));
    });
    req.end(body ?? undefined);
  });
}

// ---------------------------------------------------------------------------
// Minimal WebSocket client (RFC 6455), used for TrueNAS JSON-RPC

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_MESSAGE = 32 << 20;

class WsClient extends EventEmitter {
  constructor(sock, initial) {
    super();
    this.sock = sock;
    this.buf = initial;
    this.fragments = [];
    this.fragSize = 0;
    this.closed = false;
    sock.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      try {
        this.parse();
      } catch (e) {
        this.fail(e);
      }
    });
    sock.on('close', () => this.fail(new UserError('Connection closed')));
    sock.on('error', (e) => this.fail(friendlyNetError(e)));
    if (this.buf.length) setImmediate(() => this.parse());
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    this.emit('close', err);
  }

  parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_MESSAGE)) throw new UserError('WebSocket message too large');
        len = Number(big);
        off = 10;
      }
      const masked = b1 & 0x80;
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= this.buf[maskOff + (i & 3)];
      }
      this.buf = this.buf.subarray(off + len);
      this.onFrame(Boolean(b0 & 0x80), b0 & 0x0f, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.send(0x8, Buffer.alloc(0));
      return this.fail(new UserError('Connection closed by server'));
    }
    if (opcode === 0x9) return this.send(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) this.fragments = [];
    else if (opcode !== 0x0) throw new UserError('Unexpected WebSocket frame');
    this.fragments.push(payload);
    this.fragSize += payload.length;
    if (this.fragSize > WS_MAX_MESSAGE) throw new UserError('WebSocket message too large');
    if (fin) {
      const msg = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.fragSize = 0;
      this.emit('message', msg);
    }
  }

  send(opcode, data) {
    if (this.closed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = 0x80 | len;
    else if (len < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (this.closed) return;
    this.send(0x8, Buffer.from([0x03, 0xe8]));
    this.closed = true;
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 1000).unref();
  }
}

async function wsConnect(h, wsPath, timeoutMs = 15000) {
  const sock = await connectHost(h, { timeoutMs });
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new UserError('WebSocket handshake timed out')), timeoutMs);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 16384) done(new UserError('Invalid WebSocket handshake'));
        return;
      }
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const status = lines[0].match(/^HTTP\/1\.1 (\d{3})/);
      const hdrs = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      if (!status || status[1] !== '101')
        return done(new UserError(`WebSocket upgrade failed (HTTP ${status ? status[1] : '?'}); is this TrueNAS 25.04 or newer?`));
      if (hdrs['sec-websocket-accept'] !== expectedAccept) return done(new UserError('Invalid WebSocket handshake'));
      done(null, buf.subarray(end + 4));
    };
    const onErr = (e) => done(friendlyNetError(e));
    const onClose = () => done(new UserError('Connection closed during handshake'));
    function done(err, rest) {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onErr);
      sock.off('close', onClose);
      if (err) {
        sock.destroy();
        reject(err);
      } else resolve(new WsClient(sock, rest));
    }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
    sock.write(
      `GET ${wsPath} HTTP/1.1\r\nHost: ${hostHeader(h.address)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
}

class JsonRpc {
  constructor(ws, timeoutMs = 20000) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const p = msg && msg.id != null ? this.pending.get(msg.id) : null;
      if (!p) return; // notifications (e.g. collection_update) are ignored
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new UserError(`${p.method}: ${String(msg.error.data?.reason || msg.error.message || 'error').slice(0, 200)}`);
        e.rpcCode = msg.error.code;
        p.reject(e);
      } else p.resolve(msg.result);
    });
    ws.on('close', (err) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err || new UserError('Connection closed'));
      }
      this.pending.clear();
    });
  }

  call(method, params = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UserError(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(0x1, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
}

// ---------------------------------------------------------------------------
// SNMPv3 client (RFC 3412/3414/3826/7860), used for Synology
//
// Only authPriv is supported: HMAC-SHA-96 or HMAC-SHA-256-192 authentication plus
// AES-128-CFB encryption. Passwords never leave the server; they only key the HMAC and
// the cipher. The agent's engine ID is pinned (like a TLS fingerprint): it is checked
// after the unauthenticated discovery step and before any authenticated message is sent,
// so a device impersonating the NAS never receives a message it could use to attack the
// passwords offline.

const T = {
  INT: 0x02, OCTETS: 0x04, NULL: 0x05, OID: 0x06, SEQ: 0x30,
  IPADDR: 0x40, COUNTER32: 0x41, GAUGE32: 0x42, TIMETICKS: 0x43, COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80, NO_SUCH_INSTANCE: 0x81, END_OF_MIB: 0x82,
  GET: 0xa0, GETNEXT: 0xa1, RESPONSE: 0xa2, GETBULK: 0xa5, REPORT: 0xa8,
};
const SNMP_AUTH = { sha: { hash: 'sha1', macLen: 12 }, sha256: { hash: 'sha256', macLen: 24 } };
const USM_REPORTS = {
  '1.3.6.1.6.3.15.1.1.1.0': 'SNMP user is not configured for authentication + privacy (authPriv)',
  '1.3.6.1.6.3.15.1.1.2.0': 'SNMP time window error',
  '1.3.6.1.6.3.15.1.1.3.0': 'Unknown SNMP user name',
  '1.3.6.1.6.3.15.1.1.4.0': 'Unknown SNMP engine ID',
  '1.3.6.1.6.3.15.1.1.5.0': 'Wrong SNMP authentication password or protocol',
  '1.3.6.1.6.3.15.1.1.6.0': 'Wrong SNMP privacy password (or the device does not use AES)',
};

function berLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), berLength(value.length), value]);
function berInt(n) {
  const bytes = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(T.INT, Buffer.from(bytes));
}
function berOid(oid) {
  const p = oid.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const enc = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(T.OID, Buffer.from(out));
}
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function berRead(buf, pos) {
  if (pos + 2 > buf.length) throw new UserError('Malformed SNMP packet');
  const tag = buf[pos];
  let len = buf[pos + 1];
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > buf.length) throw new UserError('Malformed SNMP packet');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  if (p + len > buf.length) throw new UserError('Malformed SNMP packet');
  return { tag, start: p, end: p + len };
}
function berChildren(buf, node) {
  const out = [];
  for (let p = node.start; p < node.end; ) {
    const c = berRead(buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}
function berToInt(buf, n) {
  let v = n.end > n.start && buf[n.start] & 0x80 ? -1 : 0;
  for (let i = n.start; i < n.end; i++) v = v * 256 + buf[i];
  return v;
}
function berToOid(buf, n) {
  const b = buf.subarray(n.start, n.end);
  const first = b[0] < 40 ? 0 : b[0] < 80 ? 1 : 2;
  const parts = [first, b[0] - 40 * first];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}
function berValue(buf, n) {
  switch (n.tag) {
    case T.INT:
      return berToInt(buf, n);
    case T.COUNTER32:
    case T.GAUGE32:
    case T.TIMETICKS: {
      let v = 0;
      for (let i = n.start; i < n.end; i++) v = v * 256 + buf[i];
      return v;
    }
    case T.COUNTER64: {
      let v = 0n;
      for (let i = n.start; i < n.end; i++) v = v * 256n + BigInt(buf[i]);
      return Number(v);
    }
    case T.OCTETS:
      return buf.subarray(n.start, n.end).toString('utf8');
    case T.OID:
      return berToOid(buf, n);
    case T.IPADDR:
      return [...buf.subarray(n.start, n.end)].join('.');
    default:
      return null; // NULL, noSuchObject, noSuchInstance, endOfMibView
  }
}

function scopedPdu(engineId, pduTag, requestId, a, b, oids) {
  const vbs = oids.map((oid) => tlv(T.SEQ, Buffer.concat([berOid(oid), tlv(T.NULL, Buffer.alloc(0))])));
  const pdu = tlv(pduTag, Buffer.concat([berInt(requestId), berInt(a), berInt(b), tlv(T.SEQ, Buffer.concat(vbs))]));
  return tlv(T.SEQ, Buffer.concat([tlv(T.OCTETS, engineId), tlv(T.OCTETS, Buffer.alloc(0)), pdu]));
}

function snmpMessage({ msgId, flags, engineId, boots, time, user, authParams, privParams, data }) {
  const sec = tlv(T.SEQ, Buffer.concat([
    tlv(T.OCTETS, engineId), berInt(boots), berInt(time), tlv(T.OCTETS, Buffer.from(user, 'utf8')),
    tlv(T.OCTETS, authParams), tlv(T.OCTETS, privParams),
  ]));
  const global = tlv(T.SEQ, Buffer.concat([berInt(msgId), berInt(65507), tlv(T.OCTETS, Buffer.from([flags])), berInt(3)]));
  return tlv(T.SEQ, Buffer.concat([berInt(3), global, tlv(T.OCTETS, sec), data]));
}

function snmpParse(buf) {
  const [version, global, secOctets, data] = berChildren(buf, berRead(buf, 0));
  if (!data || berToInt(buf, version) !== 3) throw new UserError('Not an SNMPv3 message');
  const g = berChildren(buf, global);
  const s = berChildren(buf, berRead(buf, secOctets.start));
  return {
    msgId: berToInt(buf, g[0]),
    flags: buf[g[2].start],
    engineId: Buffer.from(buf.subarray(s[0].start, s[0].end)),
    boots: berToInt(buf, s[1]),
    time: berToInt(buf, s[2]),
    authNode: s[4],
    privParams: Buffer.from(buf.subarray(s[5].start, s[5].end)),
    data,
  };
}

function parseScopedPdu(buf, node) {
  const [, , pdu] = berChildren(buf, node);
  const [rid, errStatus, , vbl] = berChildren(buf, pdu);
  return {
    type: pdu.tag,
    requestId: berToInt(buf, rid),
    errorStatus: berToInt(buf, errStatus),
    varbinds: berChildren(buf, vbl).map((vb) => {
      const [o, v] = berChildren(buf, vb);
      return { oid: berToOid(buf, o), type: v.tag, value: berValue(buf, v) };
    }),
  };
}

const randId = () => crypto.randomInt(1, 0x7fffffff);

// Sends a datagram and waits for a reply accepted by `match` (which returns a value, or
// null to keep waiting). Packets that fail to parse or authenticate are ignored.
function udpExchange(host, port, packet, match, { timeoutMs = 2500, attempts = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let tries = 0;
    let timer = null;
    let lastProblem = null;
    const finish = (err, value) => {
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve(value);
    };
    sock.on('message', (msg, rinfo) => {
      if (rinfo.port !== port) return;
      try {
        const v = match(msg);
        if (v !== null) finish(null, v);
      } catch (e) {
        if (e instanceof UserError && e.fatal) return finish(e);
        lastProblem = e;
      }
    });
    sock.on('error', (e) => finish(friendlyNetError(e)));
    const send = () => {
      tries++;
      sock.send(packet, port, host, (e) => e && finish(friendlyNetError(e)));
      timer = setTimeout(() => {
        if (tries < attempts) send();
        else
          finish(new UserError(lastProblem instanceof UserError ? lastProblem.message
            : 'No SNMP response (check the address, that SNMPv3 is enabled in DSM, and firewall rules)'));
      }, timeoutMs);
    };
    send();
  });
}

async function snmpDiscover(host, port) {
  const msgId = randId();
  const pkt = snmpMessage({
    msgId, flags: 0x04, engineId: Buffer.alloc(0), boots: 0, time: 0, user: '',
    authParams: Buffer.alloc(0), privParams: Buffer.alloc(0), data: scopedPdu(Buffer.alloc(0), T.GET, randId(), 0, 0, []),
  });
  const res = await udpExchange(host, port, pkt, (raw) => {
    const m = snmpParse(raw);
    return m.msgId === msgId ? m : null;
  });
  if (!res.engineId.length) throw new UserError('The SNMP agent did not report an engine ID (is SNMPv3 enabled?)');
  return res;
}

function snmpPasswordKey(password, hash) {
  const pw = Buffer.from(password, 'utf8');
  const block = Buffer.alloc(1048576);
  for (let i = 0; i < block.length; i += pw.length) pw.copy(block, i);
  return crypto.createHash(hash).update(block).digest();
}
const localizeKey = (ku, engineId, hash) => crypto.createHash(hash).update(Buffer.concat([ku, engineId, ku])).digest();

async function snmpSession(h, secrets) {
  const { host, port } = splitAddress(h.address);
  const auth = SNMP_AUTH[h.options?.snmpAuth] || SNMP_AUTH.sha;
  const d = await snmpDiscover(host, port);
  const pinned = Buffer.from(h.fingerprint, 'hex');
  if (d.engineId.length !== pinned.length || !crypto.timingSafeEqual(d.engineId, pinned))
    throw new UserError('SNMP engine ID mismatch; nothing was sent. Verify the device and update the pinned engine ID');
  return {
    host, port, user: h.username, auth, engineId: d.engineId, boots: d.boots, time: d.time, timeAt: Date.now(),
    authKey: localizeKey(snmpPasswordKey(secrets.auth, auth.hash), d.engineId, auth.hash),
    privKey: localizeKey(snmpPasswordKey(secrets.priv, auth.hash), d.engineId, auth.hash).subarray(0, 16),
  };
}

async function snmpRequest(ctx, pduTag, oids, a = 0, b = 0, retried = false) {
  const msgId = randId();
  const time = ctx.time + Math.floor((Date.now() - ctx.timeAt) / 1000);
  const salt = crypto.randomBytes(8);
  const cipher = crypto.createCipheriv('aes-128-cfb', ctx.privKey, Buffer.concat([u32(ctx.boots), u32(time), salt]));
  const plain = scopedPdu(ctx.engineId, pduTag, randId(), a, b, oids);
  const placeholder = crypto.randomBytes(ctx.auth.macLen);
  const msg = snmpMessage({
    msgId, flags: 0x07, engineId: ctx.engineId, boots: ctx.boots, time, user: ctx.user,
    authParams: placeholder, privParams: salt, data: tlv(T.OCTETS, Buffer.concat([cipher.update(plain), cipher.final()])),
  });
  const at = msg.indexOf(placeholder);
  msg.fill(0, at, at + ctx.auth.macLen);
  crypto.createHmac(ctx.auth.hash, ctx.authKey).update(msg).digest().subarray(0, ctx.auth.macLen).copy(msg, at);

  const res = await udpExchange(ctx.host, ctx.port, msg, (raw) => {
    const m = snmpParse(raw);
    if (m.msgId !== msgId) return null;
    if (!(m.flags & 0x01)) {
      // Unauthenticated: only acceptable as a USM error report
      const pdu = parseScopedPdu(raw, m.data);
      if (pdu.type !== T.REPORT) return null;
      return { m, pdu };
    }
    const mac = Buffer.from(raw.subarray(m.authNode.start, m.authNode.end));
    const copy = Buffer.from(raw);
    copy.fill(0, m.authNode.start, m.authNode.end);
    const expected = crypto.createHmac(ctx.auth.hash, ctx.authKey).update(copy).digest().subarray(0, ctx.auth.macLen);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) throw new UserError('SNMP response failed authentication');
    if (!m.engineId.equals(ctx.engineId)) throw new UserError('SNMP engine ID changed');
    if (!(m.flags & 0x02)) return { m, pdu: parseScopedPdu(raw, m.data) };
    const decipher = crypto.createDecipheriv('aes-128-cfb', ctx.privKey, Buffer.concat([u32(m.boots), u32(m.time), m.privParams]));
    const enc = raw.subarray(m.data.start, m.data.end);
    const clear = Buffer.concat([decipher.update(enc), decipher.final()]);
    return { m, pdu: parseScopedPdu(clear, berRead(clear, 0)) };
  }).catch((e) => {
    // Discovery worked, so silence here usually means the agent could not decrypt the request
    if (/^No SNMP response/.test(e.message))
      throw new UserError('No response to the encrypted request: most likely a wrong privacy password, or the device is not set to AES');
    throw e;
  });

  if (res.pdu.type === T.REPORT) {
    const oid = res.pdu.varbinds[0]?.oid;
    if (oid === '1.3.6.1.6.3.15.1.1.2.0' && !retried) {
      Object.assign(ctx, { boots: res.m.boots, time: res.m.time, timeAt: Date.now() });
      return snmpRequest(ctx, pduTag, oids, a, b, true);
    }
    throw new UserError(USM_REPORTS[oid] || `SNMP error report (${oid || 'unknown'})`);
  }
  if (res.pdu.errorStatus) throw new UserError(`SNMP error status ${res.pdu.errorStatus}`);
  return res.pdu.varbinds;
}

async function snmpGet(ctx, oidMap) {
  const entries = Object.entries(oidMap);
  const out = {};
  for (let i = 0; i < entries.length; i += 20) {
    const chunk = entries.slice(i, i + 20);
    const vbs = await snmpRequest(ctx, T.GET, chunk.map(([, oid]) => oid));
    chunk.forEach(([k], j) => (out[k] = vbs[j]?.value ?? null));
  }
  return out;
}

// Walks a table and returns rows keyed by index: { index: { column: value } }
async function snmpTable(ctx, tableOid, maxVarbinds = 2000) {
  const rows = {};
  let cur = tableOid;
  for (let count = 0; count < maxVarbinds; ) {
    const vbs = await snmpRequest(ctx, T.GETBULK, [cur], 0, 40);
    if (!vbs.length) break;
    for (const vb of vbs) {
      if (vb.type === T.END_OF_MIB || !vb.oid.startsWith(tableOid + '.')) return rows;
      const [col, ...idx] = vb.oid.slice(tableOid.length + 1).split('.');
      (rows[idx.join('.')] ||= {})[col] = vb.value;
      cur = vb.oid;
      count++;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Collectors

const redfishPathCache = new Map();

function okPath(p) {
  return typeof p === 'string' && p.startsWith('/redfish/v1/') && !p.includes('..') ? p : null;
}

function healthOf(status) {
  return status ? { health: status.Health || status.HealthRollup || null, state: status.State || null } : { health: null, state: null };
}

async function collectIdrac(h, secret) {
  const auth = 'Basic ' + Buffer.from(`${h.username}:${secret}`).toString('base64');
  const get = (p) => httpsRequest(connectHost(h), h.address, { path: p, headers: { Authorization: auth, 'OData-Version': '4.0' } });
  const tryGet = (p) => get(p).catch((e) => (e.status === 404 || e.status === 405 ? null : Promise.reject(e)));

  const cacheKey = `${h.id}|${h.address}`;
  let paths = redfishPathCache.get(cacheKey);
  if (!paths) {
    const systems = await get('/redfish/v1/Systems');
    const sysPath = okPath(systems.Members?.[0]?.['@odata.id']);
    if (!sysPath) throw new UserError('No Redfish system found');
    const sys = await get(sysPath);
    const chassisPath = okPath(sys.Links?.Chassis?.[0]?.['@odata.id']) || '/redfish/v1/Chassis/System.Embedded.1';
    paths = { sysPath, chassisPath };
    redfishPathCache.set(cacheKey, paths);
  }
  const [sys, power, thermal] = await Promise.all([
    get(paths.sysPath),
    tryGet(paths.chassisPath + '/Power'),
    tryGet(paths.chassisPath + '/Thermal'),
  ]);

  const out = {
    model: sys.Model || null,
    serviceTag: sys.SKU || sys.SerialNumber || null,
    hostName: sys.HostName || null,
    powerState: sys.PowerState || null,
    ...healthOf(sys.Status),
    watts: null,
    psus: [],
    temps: [],
    fans: [],
  };

  if (power) {
    const pc = (power.PowerControl || [])[0];
    out.watts = typeof pc?.PowerConsumedWatts === 'number' ? pc.PowerConsumedWatts : null;
    out.psus = (power.PowerSupplies || []).map((p) => ({
      name: p.Name || p.MemberId || 'PSU',
      ...healthOf(p.Status),
      inputWatts: p.PowerInputWatts ?? null,
      outputWatts: p.PowerOutputWatts ?? p.LastPowerOutputWatts ?? null,
      capacityWatts: p.PowerCapacityWatts ?? null,
      voltage: p.LineInputVoltage ?? null,
    }));
  } else {
    // Newer Redfish schema (PowerSubsystem / EnvironmentMetrics)
    const env = await tryGet(paths.chassisPath + '/EnvironmentMetrics');
    out.watts = env?.PowerWatts?.Reading ?? null;
    const coll = await tryGet(paths.chassisPath + '/PowerSubsystem/PowerSupplies');
    const members = (coll?.Members || []).map((m) => okPath(m['@odata.id'])).filter(Boolean).slice(0, 8);
    out.psus = (await Promise.all(members.map(tryGet))).filter(Boolean).map((p) => ({
      name: p.Name || p.Id || 'PSU',
      ...healthOf(p.Status),
      inputWatts: null,
      outputWatts: null,
      capacityWatts: p.PowerCapacityWatts ?? null,
      voltage: null,
    }));
  }

  if (thermal) {
    out.temps = (thermal.Temperatures || [])
      .filter((t) => typeof t.ReadingCelsius === 'number')
      .map((t) => ({
        name: t.Name || t.MemberId || 'Sensor',
        celsius: t.ReadingCelsius,
        warn: t.UpperThresholdNonCritical ?? null,
        crit: t.UpperThresholdCritical ?? null,
        ...healthOf(t.Status),
      }));
    out.fans = (thermal.Fans || []).map((f) => ({
      name: f.Name || f.FanName || f.MemberId || 'Fan',
      rpm: f.ReadingUnits === 'Percent' ? null : (f.Reading ?? null),
      percent: f.ReadingUnits === 'Percent' ? f.Reading : null,
      ...healthOf(f.Status),
    }));
  } else {
    const metrics = await tryGet(paths.chassisPath + '/ThermalSubsystem/ThermalMetrics');
    out.temps = (metrics?.TemperatureReadingsCelsius || [])
      .filter((t) => typeof t.Reading === 'number')
      .map((t) => ({ name: t.DeviceName || 'Sensor', celsius: t.Reading, warn: null, crit: null, health: null, state: null }));
    const coll = await tryGet(paths.chassisPath + '/ThermalSubsystem/Fans');
    const members = (coll?.Members || []).map((m) => okPath(m['@odata.id'])).filter(Boolean).slice(0, 16);
    out.fans = (await Promise.all(members.map(tryGet))).filter(Boolean).map((f) => ({
      name: f.Name || f.Id || 'Fan',
      rpm: f.SpeedPercent?.SpeedRPM ?? null,
      percent: f.SpeedPercent?.Reading ?? null,
      ...healthOf(f.Status),
    }));
  }
  return out;
}

async function collectProxmox(h, secret) {
  const headers = { Authorization: `PVEAPIToken=${h.username}=${secret}` };
  const get = (p) => httpsRequest(connectHost(h), h.address, { path: p, headers }).then((r) => r.data);
  const [nodes, guests] = await Promise.all([get('/api2/json/nodes'), get('/api2/json/cluster/resources?type=vm')]);
  return {
    nodes: (nodes || [])
      .map((n) => ({
        name: n.node,
        status: n.status,
        cpu: n.cpu ?? null,
        maxcpu: n.maxcpu ?? null,
        mem: n.mem ?? null,
        maxmem: n.maxmem ?? null,
        disk: n.disk ?? null,
        maxdisk: n.maxdisk ?? null,
        uptime: n.uptime ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    guests: (guests || [])
      .map((g) => ({
        vmid: g.vmid,
        name: g.name || `${g.type}-${g.vmid}`,
        type: g.type === 'lxc' ? 'lxc' : 'qemu',
        status: g.status,
        node: g.node,
        template: Boolean(g.template),
        cpu: g.cpu ?? null,
        maxcpu: g.maxcpu ?? null,
        mem: g.mem ?? null,
        maxmem: g.maxmem ?? null,
        uptime: g.uptime ?? null,
      }))
      .filter((g) => !g.template)
      .sort((a, b) => a.vmid - b.vmid),
  };
}

// Connects, logs in and hands the JSON-RPC client to `fn`; the socket is always closed
async function truenasSession(h, secret, fn) {
  const ws = await wsConnect(h, '/api/current');
  const rpc = new JsonRpc(ws);
  try {
    let loggedIn = false;
    if (h.username) {
      try {
        const r = await rpc.call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: h.username, api_key: secret }]);
        if (r?.response_type !== 'SUCCESS')
          throw new UserError(r?.response_type === 'EXPIRED' ? 'API key has expired' : 'Authentication failed (check username and API key)');
        loggedIn = true;
      } catch (e) {
        if (e.rpcCode !== -32601) throw e; // fall back only if the method does not exist
      }
    }
    if (!loggedIn) {
      const ok = await rpc.call('auth.login_with_api_key', [secret]);
      if (ok !== true) throw new UserError('Authentication failed (check API key)');
    }
    return await fn(rpc);
  } finally {
    ws.close();
  }
}

function collectTruenas(h, secret) {
  return truenasSession(h, secret, async (rpc) => {
    const poolFields = ['name', 'status', 'healthy', 'warning', 'status_detail', 'size', 'allocated', 'free'];
    const [info, pools, alerts] = await Promise.all([
      rpc.call('system.info'),
      rpc.call('pool.query', [[], { select: poolFields }]).catch(() => rpc.call('pool.query')),
      rpc.call('alert.list'),
    ]);

    const outPools = (pools || []).map((p) => ({
      name: p.name,
      status: p.status,
      healthy: p.healthy,
      warning: p.warning ?? false,
      detail: p.status_detail || null,
      size: p.size ?? null,
      allocated: p.allocated ?? null,
      free: p.free ?? null,
    }));
    if (outPools.some((p) => p.size == null)) {
      const ds = await rpc
        .call('pool.dataset.query', [[['id', 'in', outPools.map((p) => p.name)]], { extra: { retrieve_children: false } }])
        .catch(() => []);
      for (const p of outPools) {
        const d = ds.find((x) => x.id === p.name);
        if (p.size == null && d) {
          p.allocated = d.used?.parsed ?? null;
          p.free = d.available?.parsed ?? null;
          if (p.allocated != null && p.free != null) p.size = p.allocated + p.free;
        }
      }
    }

    const ts = (d) => (typeof d === 'number' ? d : typeof d?.$date === 'number' ? d.$date : null);
    return {
      system: {
        hostname: info.hostname || null,
        version: info.version || null,
        model: info.system_product || info.model || null,
        cpuModel: info.model || null,
        cores: info.cores ?? null,
        memory: info.physmem ?? null,
        uptime: info.uptime_seconds ?? null,
        loadavg: Array.isArray(info.loadavg) ? info.loadavg : null,
      },
      pools: outPools,
      alerts: (alerts || [])
        .filter((a) => !a.dismissed)
        .map((a) => ({ level: a.level, text: String(a.formatted || a.text || a.klass || '').slice(0, 1000), time: ts(a.datetime) }))
        .sort((a, b) => (b.time || 0) - (a.time || 0)),
    };
  });
}


// --- Synology (SNMPv3) ---

const SYNO = '1.3.6.1.4.1.6574';
const SYNO_DISK_STATUS = { 1: 'Normal', 2: 'Initialized', 3: 'Not initialized', 4: 'System partition failed', 5: 'Crashed' };
const SYNO_DISK_HEALTH = { 1: 'Normal', 2: 'Warning', 3: 'Critical', 4: 'Failing' };
const SYNO_RAID_STATUS = {
  1: 'Normal', 2: 'Repairing', 3: 'Migrating', 4: 'Expanding', 5: 'Deleting', 6: 'Creating', 7: 'Syncing',
  8: 'Parity checking', 9: 'Assembling', 10: 'Canceling', 11: 'Degraded', 12: 'Crashed', 13: 'Data scrubbing',
  14: 'Deploying', 15: 'Undeploying', 16: 'Mounting cache', 17: 'Unmounting cache', 18: 'Expanding', 19: 'Converting', 20: 'Migrating',
};

async function collectSynology(h, secretJson) {
  let secrets;
  try {
    secrets = JSON.parse(secretJson);
  } catch {
    throw new UserError('Stored SNMP credentials are invalid; please re-enter them');
  }
  const ctx = await snmpSession(h, secrets);
  const v = await snmpGet(ctx, {
    name: '1.3.6.1.2.1.1.5.0',
    uptime: '1.3.6.1.2.1.25.1.1.0',
    status: `${SYNO}.1.1.0`,
    temp: `${SYNO}.1.2.0`,
    power: `${SYNO}.1.3.0`,
    systemFan: `${SYNO}.1.4.1.0`,
    cpuFan: `${SYNO}.1.4.2.0`,
    model: `${SYNO}.1.5.1.0`,
    serial: `${SYNO}.1.5.2.0`,
    version: `${SYNO}.1.5.3.0`,
    upgrade: `${SYNO}.1.5.4.0`,
    cpuIdle: '1.3.6.1.4.1.2021.11.11.0',
    memTotal: '1.3.6.1.4.1.2021.4.5.0',
    memAvail: '1.3.6.1.4.1.2021.4.6.0',
    memBuffer: '1.3.6.1.4.1.2021.4.14.0',
    memCached: '1.3.6.1.4.1.2021.4.15.0',
    load1: '1.3.6.1.4.1.2021.10.1.3.1',
    load5: '1.3.6.1.4.1.2021.10.1.3.2',
    load15: '1.3.6.1.4.1.2021.10.1.3.3',
  });
  const [disks, raids, storage] = [
    await snmpTable(ctx, `${SYNO}.2.1.1`),
    await snmpTable(ctx, `${SYNO}.3.1.1`),
    await snmpTable(ctx, '1.3.6.1.2.1.25.2.3.1'),
  ];
  const ok = (n) => (n === 1 ? 'Normal' : n === 2 ? 'Failed' : null);
  const kb = (n) => (typeof n === 'number' ? n * 1024 : null);
  const memUsed = v.memTotal != null && v.memAvail != null ? v.memTotal - v.memAvail - (v.memBuffer || 0) - (v.memCached || 0) : null;
  return {
    system: {
      name: v.name,
      model: v.model,
      serial: v.serial,
      version: v.version,
      upgradeAvailable: v.upgrade === 1,
      uptime: typeof v.uptime === 'number' ? Math.round(v.uptime / 100) : null,
      temp: v.temp,
      status: ok(v.status),
      powerStatus: ok(v.power),
      systemFan: ok(v.systemFan),
      cpuFan: ok(v.cpuFan),
      cpu: typeof v.cpuIdle === 'number' ? Math.max(0, 100 - v.cpuIdle) / 100 : null,
      memTotal: kb(v.memTotal),
      memUsed: kb(memUsed),
      load: [v.load1, v.load5, v.load15].every((x) => x != null) ? [v.load1, v.load5, v.load15].map(Number) : null,
    },
    volumes: Object.values(storage)
      .filter((r) => typeof r['3'] === 'string' && /^\/volume\d+$/.test(r['3']))
      .map((r) => ({ name: r['3'], size: r['5'] * r['4'], used: r['6'] * r['4'] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    pools: Object.values(raids).map((r) => ({
      name: r['2'],
      status: SYNO_RAID_STATUS[r['3']] || `Status ${r['3']}`,
      healthy: r['3'] === 1 || r['3'] === 13 || r['3'] === 8,
      free: r['4'] ?? null,
      size: r['5'] ?? null,
    })),
    disks: Object.entries(disks)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, r]) => ({
        id: r['2'],
        model: typeof r['3'] === 'string' ? r['3'].trim() : null,
        type: r['4'] ?? null,
        status: SYNO_DISK_STATUS[r['5']] || null,
        health: SYNO_DISK_HEALTH[r['13']] || null,
        temp: r['6'] ?? null,
        remainingLife: typeof r['11'] === 'number' && r['11'] >= 0 ? r['11'] : null,
      })),
  };
}

// --- UniFi (UniFi OS console, local View Only account) ---
//
// The session cookie is kept in memory only. After a failed login no new attempt is made
// for 15 minutes, so a wrong password can't lock the account on the console.

const unifiSessions = new Map(); // `${id}|${address}|${username}` -> { cookie, failedUntil, error }
const UNIFI_BACKOFF_MS = 15 * 60 * 1000;

async function unifiLogin(h, password) {
  const key = `${h.id}|${h.address}|${h.username}`;
  const s = unifiSessions.get(key) || {};
  if (s.failedUntil > Date.now())
    throw new UserError(`${s.error} Next login attempt in ${Math.ceil((s.failedUntil - Date.now()) / 60000)} min.`);
  const r = await httpsRequest(connectHost(h), h.address, {
    method: 'POST',
    path: '/api/auth/login',
    body: JSON.stringify({ username: h.username, password, rememberMe: false }),
    full: true,
  });
  if (r.status === 200) {
    const cookies = [].concat(r.headers['set-cookie'] || []);
    const token = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('TOKEN='));
    if (!token) throw new UserError('UniFi login returned no session token');
    unifiSessions.set(key, { cookie: token });
    return token;
  }
  const error =
    r.status === 499 ? 'The UniFi account requires MFA; use a local account without MFA.'
      : r.status === 429 ? 'Too many login attempts on the UniFi console.'
        : r.status === 401 || r.status === 403 || r.status === 400 ? 'UniFi login failed (check the username/password of the local account).'
          : `UniFi login failed (HTTP ${r.status}).`;
  unifiSessions.set(key, { failedUntil: Date.now() + UNIFI_BACKOFF_MS, error });
  throw new UserError(error);
}

async function unifiGet(h, password, apiPath) {
  const key = `${h.id}|${h.address}|${h.username}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = unifiSessions.get(key)?.cookie || (await unifiLogin(h, password));
    const r = await httpsRequest(connectHost(h), h.address, { path: apiPath, headers: { Cookie: cookie }, full: true });
    if (r.status === 401 && attempt === 0) {
      unifiSessions.delete(key); // session expired: log in again once
      continue;
    }
    if (r.status === 403) throw new UserError('The UniFi account lacks access to the Network application');
    if (r.status < 200 || r.status >= 300) throw Object.assign(new UserError(`HTTP ${r.status}`), { status: r.status });
    if (!r.json) throw new UserError('Invalid JSON response');
    return r.json.data ?? r.json;
  }
  throw new UserError('UniFi session could not be established');
}

const num0 = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function unifiDevice(d) {
  const ports = (d.port_table || []).map((p) => ({
    idx: p.port_idx,
    name: p.name || `Port ${p.port_idx}`,
    up: Boolean(p.up),
    speed: num0(p.speed),
    uplink: Boolean(p.is_uplink),
    sfp: /sfp/i.test(String(p.media || '')),
    poeW: p.port_poe && p.poe_enable !== false ? num0(p.poe_power) ?? 0 : null,
  }));
  const poePorts = ports.filter((p) => p.poeW !== null);
  const temps = (d.temperatures || []).map((t) => ({ name: t.name || t.type || 'Sensor', value: num0(t.value) })).filter((t) => t.value !== null);
  if (!temps.length && num0(d.general_temperature) !== null) temps.push({ name: 'General', value: num0(d.general_temperature) });
  const stats = d['system-stats'] || {};
  return {
    mac: String(d.mac || '').toLowerCase(),
    name: d.name || d.model || d.mac,
    model: d.model || null,
    type: d.type || null, // udm, ugw, usw, uap, ...
    online: d.state === 1,
    state: d.state === 1 ? 'Online' : d.state === 0 ? 'Offline' : d.state === 4 ? 'Upgrading' : d.state === 5 ? 'Provisioning' : `State ${d.state}`,
    version: d.version || null,
    upgradable: Boolean(d.upgradable),
    upgradeTo: d.upgradable && typeof d.upgrade_to_firmware === 'string' ? d.upgrade_to_firmware.slice(0, 40) : null,
    ip: d.ip || null,
    uptime: num0(d.uptime),
    cpu: num0(stats.cpu) !== null ? num0(stats.cpu) / 100 : null,
    mem: num0(stats.mem) !== null ? num0(stats.mem) / 100 : null,
    temps,
    fanLevel: num0(d.fan_level),
    clients: num0(d.num_sta),
    ports,
    poe: poePorts.length ? { usedW: poePorts.reduce((a, p) => a + p.poeW, 0), budgetW: num0(d.total_max_power) } : null,
    radios: (d.radio_table_stats || []).map((r) => ({ radio: r.radio, channel: r.channel ?? null, clients: num0(r.num_sta), satisfaction: num0(r.satisfaction) })),
    uplinkMac: d.uplink?.uplink_mac ? String(d.uplink.uplink_mac).toLowerCase() : null,
    uplinkPort: num0(d.uplink?.uplink_remote_port),
  };
}

async function collectUnifi(h, password) {
  const sites = await unifiGet(h, password, '/proxy/network/api/self/sites');
  const names = (Array.isArray(sites) ? sites : [])
    .map((x) => x.name)
    .filter((n) => typeof n === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(n))
    .slice(0, 5);
  const devices = [];
  let health = null;
  for (const site of names.length ? names : ['default']) {
    const [devs, hl] = await Promise.all([
      unifiGet(h, password, `/proxy/network/api/s/${site}/stat/device`),
      unifiGet(h, password, `/proxy/network/api/s/${site}/stat/health`).catch(() => []),
    ]);
    for (const d of Array.isArray(devs) ? devs : []) devices.push({ site, ...unifiDevice(d) });
    if (!health && Array.isArray(hl)) {
      const sub = Object.fromEntries(hl.map((x) => [x.subsystem, x]));
      health = {
        wan: sub.wan ? { status: sub.wan.status, ip: sub.wan.wan_ip || null } : null,
        internet: sub.www ? { status: sub.www.status, latencyMs: num0(sub.www.latency), downMbps: num0(sub.www.xput_down), upMbps: num0(sub.www.xput_up) } : null,
        clients: (num0(sub.wlan?.num_user) || 0) + (num0(sub.lan?.num_user) || 0),
        wifiClients: num0(sub.wlan?.num_user),
        wiredClients: num0(sub.lan?.num_user),
      };
    }
  }
  const order = { udm: 0, ugw: 0, uxg: 0, usw: 1, uap: 2 };
  devices.sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.name.localeCompare(b.name));
  return { health, devices: devices.slice(0, 200) };
}

const COLLECTORS = { idrac: collectIdrac, proxmox: collectProxmox, truenas: collectTruenas, synology: collectSynology, unifi: collectUnifi };

function safeErrorMessage(e, secret) {
  let msg = e instanceof UserError ? e.message : 'Unexpected error while collecting data';
  if (!(e instanceof UserError)) log('collector error:', e && e.stack ? e.stack.split('\n')[0] : e);
  const parts = [secret];
  try {
    parts.push(...Object.values(JSON.parse(secret)));
  } catch {
    /* not a JSON secret */
  }
  for (const part of parts) if (typeof part === 'string' && part.length >= 4) msg = msg.split(part).join('[redacted]');
  return msg.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Services (Homepage-style): a link card with a status check and an optional integration
//
// A service has a user-facing link (`href`, never requested by the server) and an optional
// connection URL used for the status check and the integration. HTTPS connections use the
// same CA verification / SHA-256 pinning as devices; plain HTTP is allowed for LAN services,
// and the admin page warns that a key would then travel unencrypted.

function parseServiceUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new UserError('Invalid URL (include http:// or https://)');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http:// and https:// URLs are supported');
  if (url.username || url.password) throw new UserError('Put credentials in the credential fields, not in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return { https: url.protocol === 'https:', host, port, base: url.pathname.replace(/\/+$/, ''), href: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}` };
}

function plainConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new UserError('Connection timed out'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(friendlyNetError(e));
    });
  });
}

// conn: { url, tlsMode, fingerprint }
function connRequest(conn, reqPath, opts = {}) {
  const u = parseServiceUrl(conn.url);
  const address = net.isIPv6(u.host) ? `[${u.host}]:${u.port}` : `${u.host}:${u.port}`;
  const timeoutMs = opts.timeoutMs || 10000;
  const sock = u.https
    ? tlsConnect(address, { pin: conn.tlsMode === 'pin' ? conn.fingerprint : null, verify: true, timeoutMs })
    : plainConnect(u.host, u.port, timeoutMs);
  return httpsRequest(sock, address, { ...opts, timeoutMs, path: u.base + reqPath });
}

// Integration context: small helpers so each integration only describes its API.
function integrationCtx(svc, secret) {
  const conn = svc.connection;
  const req = async (method, p, { headers = {}, body = null, form = null, okStatus } = {}) => {
    const h = { ...headers };
    let b = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    if (form) {
      b = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const r = await connRequest(conn, p, { method, headers: h, body: b, full: true });
    if (okStatus ? !okStatus(r.status) : r.status < 200 || r.status >= 300) {
      const hint = r.status === 401 ? ' (authentication failed)' : r.status === 403 ? ' (permission denied)' : r.status === 404 ? ' (not found: check the URL and the version)' : '';
      throw Object.assign(new UserError(`HTTP ${r.status}${hint}`), { status: r.status });
    }
    return r;
  };
  const json = async (method, p, o) => {
    const r = await req(method, p, o);
    if (r.json === null) throw new UserError('Invalid JSON response (is the URL correct?)');
    return r.json;
  };
  return {
    svc,
    secret,
    username: svc.integration.username,
    options: svc.integration.options || {},
    req,
    get: (p, o) => json('GET', p, o),
    post: (p, body, o) => json('POST', p, { ...o, body }),
    basic: () => ({ Authorization: 'Basic ' + Buffer.from(`${svc.integration.username}:${secret}`).toString('base64') }),
  };
}

const svcSessions = new Map(); // `${service id}|${url}|${user}` -> session token/cookie (memory only)

// Pi-hole v6 sessions are limited, so the stats and the update check share one
const piholeLogin = (x) => async () => {
  const r = await x.post('/api/auth', { password: x.secret });
  if (!r.session?.valid || !r.session.sid) throw Object.assign(new UserError('Pi-hole login failed'), { status: 401 });
  return r.session.sid;
};
async function withSession(x, login, use) {
  const key = `${x.svc.id}|${x.svc.connection.url}|${x.username}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let session = svcSessions.get(key);
    if (!session) {
      session = await login();
      svcSessions.set(key, session);
    }
    try {
      return await use(session);
    } catch (e) {
      svcSessions.delete(key);
      if (attempt === 1 || ![401, 403].includes(e.status)) throw e;
    }
  }
}

const stat = (label, value, unit) => ({ label, value: value ?? null, ...(unit ? { unit } : {}) });
const count = (r) => (Array.isArray(r) ? r.length : 0);
const total = (r) => r?.totalRecords ?? r?.total ?? null;

// Each integration: label, what it needs, and fetch(x) -> up to 4 stats.
const INTEGRATIONS = {
  // --- Media ---
  jellyfin: {
    label: 'Jellyfin', group: 'Media', secret: 'API key', icon: 'jellyfin',
    async fetch(x) {
      const H = { headers: { 'X-Emby-Token': x.secret } };
      const [c, sessions] = await Promise.all([x.get('/Items/Counts', H), x.get('/Sessions', H)]);
      return [stat('Movies', c.MovieCount), stat('Series', c.SeriesCount), stat('Episodes', c.EpisodeCount), stat('Streaming', sessions.filter((s) => s.NowPlayingItem).length)];
    },
  },
  emby: {
    label: 'Emby', group: 'Media', secret: 'API key', icon: 'emby',
    async fetch(x) {
      return INTEGRATIONS.jellyfin.fetch(x);
    },
  },
  plex: {
    label: 'Plex', group: 'Media', secret: 'Plex token', icon: 'plex',
    async fetch(x) {
      const H = { headers: { 'X-Plex-Token': x.secret, Accept: 'application/json' } };
      const [sessions, sections] = await Promise.all([x.get('/status/sessions', H), x.get('/library/sections', H)]);
      const dirs = sections.MediaContainer?.Directory || [];
      const size = async (type) => {
        let n = 0;
        for (const d of dirs.filter((y) => y.type === type)) {
          const r = await x.get(`/library/sections/${encodeURIComponent(d.key)}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`, H);
          n += r.MediaContainer?.totalSize ?? r.MediaContainer?.size ?? 0;
        }
        return n;
      };
      return [stat('Streams', sessions.MediaContainer?.size ?? 0), stat('Movies', await size('movie')), stat('TV shows', await size('show')), stat('Libraries', dirs.length)];
    },
  },
  tautulli: {
    label: 'Tautulli', group: 'Media', secret: 'API key', icon: 'tautulli',
    async fetch(x) {
      const r = await x.get(`/api/v2?apikey=${encodeURIComponent(x.secret)}&cmd=get_activity`);
      const d = r.response?.data || {};
      return [stat('Streams', Number(d.stream_count) || 0), stat('Transcoding', Number(d.stream_count_transcode) || 0), stat('Bandwidth', (Number(d.total_bandwidth) || 0) * 1000, 'bps')];
    },
  },
  sonarr: {
    label: 'Sonarr', group: 'Media', secret: 'API key', icon: 'sonarr',
    async fetch(x) {
      const H = { headers: { 'X-Api-Key': x.secret } };
      const [series, wanted, queue] = await Promise.all([x.get('/api/v3/series', H), x.get('/api/v3/wanted/missing?pageSize=1', H), x.get('/api/v3/queue?pageSize=1', H)]);
      return [stat('Series', count(series)), stat('Wanted', total(wanted)), stat('Queued', total(queue))];
    },
  },
  radarr: {
    label: 'Radarr', group: 'Media', secret: 'API key', icon: 'radarr',
    async fetch(x) {
      const H = { headers: { 'X-Api-Key': x.secret } };
      const [movies, wanted, queue] = await Promise.all([x.get('/api/v3/movie', H), x.get('/api/v3/wanted/missing?pageSize=1', H), x.get('/api/v3/queue?pageSize=1', H)]);
      return [stat('Movies', count(movies)), stat('On disk', Array.isArray(movies) ? movies.filter((m) => m.hasFile).length : null), stat('Wanted', total(wanted)), stat('Queued', total(queue))];
    },
  },
  lidarr: {
    label: 'Lidarr', group: 'Media', secret: 'API key', icon: 'lidarr',
    async fetch(x) {
      const H = { headers: { 'X-Api-Key': x.secret } };
      const [artists, wanted, queue] = await Promise.all([x.get('/api/v1/artist', H), x.get('/api/v1/wanted/missing?pageSize=1', H), x.get('/api/v1/queue?pageSize=1', H)]);
      return [stat('Artists', count(artists)), stat('Wanted', total(wanted)), stat('Queued', total(queue))];
    },
  },
  prowlarr: {
    label: 'Prowlarr', group: 'Media', secret: 'API key', icon: 'prowlarr',
    async fetch(x) {
      const H = { headers: { 'X-Api-Key': x.secret } };
      const [indexers, st] = await Promise.all([x.get('/api/v1/indexer', H), x.get('/api/v1/indexerstats', H)]);
      const rows = st.indexers || [];
      const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
      return [stat('Indexers', Array.isArray(indexers) ? indexers.filter((i) => i.enable).length : null), stat('Grabs', sum('numberOfGrabs')), stat('Queries', sum('numberOfQueries')), stat('Failed', sum('numberOfFailedQueries'))];
    },
  },
  bazarr: {
    label: 'Bazarr', group: 'Media', secret: 'API key', icon: 'bazarr',
    async fetch(x) {
      const H = { headers: { 'X-API-KEY': x.secret } };
      const [ep, mv] = await Promise.all([x.get('/api/episodes/wanted?start=0&length=1', H), x.get('/api/movies/wanted?start=0&length=1', H)]);
      return [stat('Missing episodes', ep.total ?? null), stat('Missing movies', mv.total ?? null)];
    },
  },
  overseerr: {
    label: 'Seerr / Overseerr / Jellyseerr', group: 'Media', secret: 'API key', icon: 'overseerr',
    async fetch(x) {
      const c = await x.get('/api/v1/request/count', { headers: { 'X-Api-Key': x.secret } });
      return [stat('Pending', c.pending), stat('Processing', c.processing), stat('Approved', c.approved), stat('Available', c.available)];
    },
  },
  qbittorrent: {
    label: 'qBittorrent', group: 'Media', user: 'Username', secret: 'Password', icon: 'qbittorrent',
    async fetch(x) {
      const origin = parseServiceUrl(x.svc.connection.url).href;
      return withSession(x, async () => {
        const r = await x.req('POST', '/api/v2/auth/login', { form: { username: x.username, password: x.secret }, headers: { Referer: origin, Origin: origin } });
        // "SID" before qBittorrent 5.x; newer versions may use "QBT_SID_<port>"
        const sid = [].concat(r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => /^(SID|QBT_SID[\w-]*)=/.test(c));
        if (!sid || /fail/i.test(r.text || '')) throw Object.assign(new UserError('qBittorrent login failed'), { status: 401 });
        return sid;
      }, async (sid) => {
        const H = { headers: { Cookie: sid, Referer: origin, Origin: origin } };
        const [info, torrents] = await Promise.all([x.get('/api/v2/transfer/info', H), x.get('/api/v2/torrents/info', H)]);
        const states = (Array.isArray(torrents) ? torrents : []).map((t) => t.state);
        return [stat('Download', info.dl_info_speed, 'B/s'), stat('Upload', info.up_info_speed, 'B/s'),
          stat('Leeching', states.filter((y) => ['downloading', 'stalledDL', 'metaDL', 'forcedDL'].includes(y)).length),
          stat('Seeding', states.filter((y) => ['uploading', 'stalledUP', 'forcedUP'].includes(y)).length)]; // paused/queued not counted
      });
    },
  },
  transmission: {
    label: 'Transmission', group: 'Media', user: 'Username (optional)', secret: 'Password (optional)', optionalSecret: true, icon: 'transmission',
    async fetch(x) {
      const auth = x.username ? x.basic() : {};
      const call = (sid) => x.req('POST', '/transmission/rpc', { body: { method: 'session-stats' }, headers: { ...auth, ...(sid ? { 'X-Transmission-Session-Id': sid } : {}) }, okStatus: (st) => st === 200 || st === 409 });
      let r = await call(null);
      if (r.status === 409) r = await call(r.headers['x-transmission-session-id']);
      const a = r.json?.arguments || {};
      return [stat('Download', a.downloadSpeed, 'B/s'), stat('Upload', a.uploadSpeed, 'B/s'), stat('Active', a.activeTorrentCount), stat('Torrents', a.torrentCount)];
    },
  },
  sabnzbd: {
    label: 'SABnzbd', group: 'Media', secret: 'API key', icon: 'sabnzbd',
    async fetch(x) {
      const r = await x.get(`/api?mode=queue&output=json&apikey=${encodeURIComponent(x.secret)}`);
      const q = r.queue || {};
      return [stat('Speed', (Number(q.kbpersec) || 0) * 1024, 'B/s'), stat('Queue', Number(q.noofslots) || 0), stat('Time left', q.timeleft || '0:00:00')];
    },
  },

  // --- Network & DNS ---
  pihole: {
    label: 'Pi-hole', group: 'Network', secret: 'Password (v6) or API token (v5)', icon: 'pi-hole',
    async fetch(x) {
      // Pi-hole v6: session API (sessions are reused; v6 limits concurrent sessions)
      try {
        return await withSession(x, piholeLogin(x), async (sid) => {
          const s = await x.get('/api/stats/summary', { headers: { 'X-FTL-SID': sid } });
          return [stat('Queries', s.queries?.total), stat('Blocked', s.queries?.blocked), stat('Block rate', s.queries?.percent_blocked, '%'), stat('On blocklist', s.gravity?.domains_being_blocked)];
        });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      const s = await x.get(`/admin/api.php?summaryRaw&auth=${encodeURIComponent(x.secret)}`); // v5
      return [stat('Queries', s.dns_queries_today), stat('Blocked', s.ads_blocked_today), stat('Block rate', s.ads_percentage_today, '%'), stat('On blocklist', s.domains_being_blocked)];
    },
  },
  adguard: {
    label: 'AdGuard Home', group: 'Network', user: 'Username', secret: 'Password', icon: 'adguard-home',
    async fetch(x) {
      const s = await x.get('/control/stats', { headers: x.basic() });
      const q = s.num_dns_queries || 0;
      return [stat('Queries', q), stat('Blocked', s.num_blocked_filtering), stat('Block rate', q ? (100 * (s.num_blocked_filtering || 0)) / q : 0, '%'), stat('Latency', (s.avg_processing_time || 0) * 1000, 'ms')];
    },
  },
  npm: {
    label: 'Nginx Proxy Manager', group: 'Network', user: 'E-mail', secret: 'Password', icon: 'nginx-proxy-manager',
    async fetch(x) {
      return withSession(x, async () => {
        const r = await x.post('/api/tokens', { identity: x.username, secret: x.secret });
        if (!r.token) throw Object.assign(new UserError('Login failed'), { status: 401 });
        return r.token;
      }, async (token) => {
        const hosts = await x.get('/api/nginx/proxy-hosts', { headers: { Authorization: `Bearer ${token}` } });
        const list = Array.isArray(hosts) ? hosts : [];
        return [stat('Enabled', list.filter((h) => h.enabled).length), stat('Disabled', list.filter((h) => !h.enabled).length), stat('Total', list.length)];
      });
    },
  },
  traefik: {
    label: 'Traefik', group: 'Network', user: 'Username (optional)', secret: 'Password (optional)', optionalSecret: true, icon: 'traefik',
    async fetch(x) {
      const o = await x.get('/api/overview', { headers: x.username ? x.basic() : {} });
      return [stat('Routers', o.http?.routers?.total), stat('Services', o.http?.services?.total), stat('Middleware', o.http?.middlewares?.total), stat('Errors', (o.http?.routers?.errors || 0) + (o.http?.services?.errors || 0))];
    },
  },

  // --- Home & productivity ---
  homeassistant: {
    label: 'Home Assistant', group: 'Home', secret: 'Long-lived access token', icon: 'home-assistant',
    async fetch(x) {
      const states = await x.get('/api/states', { headers: { Authorization: `Bearer ${x.secret}` } });
      const list = Array.isArray(states) ? states : [];
      const on = (prefix) => list.filter((e) => e.entity_id.startsWith(prefix) && e.state === 'on').length;
      return [stat('People home', list.filter((e) => e.entity_id.startsWith('person.') && e.state === 'home').length), stat('Lights on', on('light.')), stat('Switches on', on('switch.')), stat('Entities', list.length)];
    },
  },
  nextcloud: {
    label: 'Nextcloud', group: 'Home', user: 'Username (empty = serverinfo token)', secret: 'App password or serverinfo token', icon: 'nextcloud',
    async fetch(x) {
      const headers = { 'OCS-APIRequest': 'true', ...(x.username ? x.basic() : { 'NC-Token': x.secret }) };
      const r = await x.get('/ocs/v2.php/apps/serverinfo/api/v1/info?format=json', { headers });
      const d = r.ocs?.data || {};
      return [stat('Active users (24 h)', d.activeUsers?.last24hours), stat('Files', d.nextcloud?.storage?.num_files), stat('Free space', d.nextcloud?.system?.freespace, 'B'), stat('CPU load', d.nextcloud?.system?.cpuload?.[0])];
    },
  },
  immich: {
    label: 'Immich', group: 'Home', secret: 'API key', icon: 'immich',
    async fetch(x) {
      const H = { headers: { 'x-api-key': x.secret } };
      let s;
      try {
        s = await x.get('/api/server/statistics', H);
      } catch (e) {
        if (e.status !== 404) throw e;
        s = await x.get('/api/server-info/statistics', H); // older versions
      }
      return [stat('Photos', s.photos), stat('Videos', s.videos), stat('Storage', s.usage, 'B'), stat('Users', s.usageByUser?.length)];
    },
  },
  paperless: {
    label: 'Paperless-ngx', group: 'Home', secret: 'API token', icon: 'paperless-ngx',
    async fetch(x) {
      const s = await x.get('/api/statistics/', { headers: { Authorization: `Token ${x.secret}` } });
      return [stat('Documents', s.documents_total), stat('Inbox', s.documents_inbox)];
    },
  },

  // --- Monitoring & admin ---
  uptimekuma: {
    label: 'Uptime Kuma', group: 'Monitoring', secret: null, icon: 'uptime-kuma', options: [{ key: 'slug', label: 'Status page slug', required: true, placeholder: 'e.g. homelab' }],
    async fetch(x) {
      const slug = encodeURIComponent(x.options.slug || '');
      const hb = await x.get(`/api/status-page/heartbeat/${slug}`);
      const last = Object.values(hb.heartbeatList || {}).map((beats) => beats[beats.length - 1]).filter(Boolean);
      const ratios = Object.entries(hb.uptimeList || {}).filter(([k]) => k.endsWith('_24')).map(([, v]) => v);
      const avg = ratios.length ? (100 * ratios.reduce((a, b) => a + b, 0)) / ratios.length : null;
      return [stat('Up', last.filter((b) => b.status === 1).length), stat('Down', last.filter((b) => b.status === 0).length), stat('Uptime 24 h', avg, '%')];
    },
  },
  grafana: {
    label: 'Grafana', group: 'Monitoring', user: 'Username (empty = API token)', secret: 'Password or service account token', icon: 'grafana',
    async fetch(x) {
      const s = await x.get('/api/admin/stats', { headers: x.username ? x.basic() : { Authorization: `Bearer ${x.secret}` } });
      return [stat('Dashboards', s.dashboards), stat('Data sources', s.datasources), stat('Alert rules', s.alerts), stat('Users', s.users)];
    },
  },
  portainer: {
    label: 'Portainer', group: 'Monitoring', secret: 'Access token', icon: 'portainer', options: [{ key: 'env', label: 'Environment ID', placeholder: 'empty = first' }],
    async fetch(x) {
      const H = { headers: { 'X-API-Key': x.secret } };
      let env = String(x.options.env || '').trim();
      if (!env) env = String((await x.get('/api/endpoints', H))[0]?.Id ?? '1');
      if (!/^\d+$/.test(env)) throw new UserError('Environment ID must be a number');
      const containers = await x.get(`/api/endpoints/${env}/docker/containers/json?all=1`, H);
      const list = Array.isArray(containers) ? containers : [];
      return [stat('Running', list.filter((c) => c.State === 'running').length), stat('Stopped', list.filter((c) => c.State !== 'running').length), stat('Total', list.length)];
    },
  },
  speedtest: {
    label: 'Speedtest Tracker', group: 'Monitoring', secret: 'API token (v1 API; empty for old versions)', optionalSecret: true, icon: 'speedtest-tracker',
    async fetch(x) {
      const r = x.secret
        ? await x.get('/api/v1/results/latest', { headers: { Authorization: `Bearer ${x.secret}`, Accept: 'application/json' } })
        : await x.get('/api/speedtest/latest');
      const d = r.data || {};
      const mbps = (bits, legacy) => (bits != null ? bits / 1e6 : legacy != null ? Number(legacy) : null);
      return [stat('Download', mbps(d.download_bits, d.download), 'Mbps'), stat('Upload', mbps(d.upload_bits, d.upload), 'Mbps'), stat('Ping', Number(d.ping), 'ms')];
    },
  },
  prometheus: {
    label: 'Prometheus', group: 'Monitoring', secret: null, icon: 'prometheus',
    async fetch(x) {
      const r = await x.get('/api/v1/targets?state=active');
      const t = r.data?.activeTargets || [];
      return [stat('Targets up', t.filter((y) => y.health === 'up').length), stat('Down', t.filter((y) => y.health !== 'up').length)];
    },
  },
  authentik: {
    label: 'authentik', group: 'Monitoring', secret: 'API token', icon: 'authentik',
    async fetch(x) {
      const H = { headers: { Authorization: `Bearer ${x.secret}` } };
      const since = new Date(Date.now() - 86400000).toISOString();
      const [users, logins, failed] = await Promise.all([
        x.get('/api/v3/core/users/?page_size=1', H),
        x.get(`/api/v3/events/events/?action=login&page_size=1&created__gt=${encodeURIComponent(since)}`, H),
        x.get(`/api/v3/events/events/?action=login_failed&page_size=1&created__gt=${encodeURIComponent(since)}`, H),
      ]);
      return [stat('Users', users.pagination?.count), stat('Logins (24 h)', logins.pagination?.count), stat('Failed (24 h)', failed.pagination?.count)];
    },
  },

  // --- Anything with a JSON API ---
  customapi: {
    label: 'Custom JSON API', group: 'Other', secret: 'Header value (optional)', optionalSecret: true, icon: null,
    options: [
      { key: 'path', label: 'Path', placeholder: '/api/stats' },
      { key: 'header', label: 'Auth header name (optional)', placeholder: 'X-Api-Key' },
      { key: 'fields', label: 'Fields: one per line, "Label = json.path"', multiline: true, required: true, placeholder: 'Users = data.users\nUptime = stats.uptime' },
    ],
    async fetch(x) {
      const p = String(x.options.path || '/');
      if (!p.startsWith('/') || /\s/.test(p)) throw new UserError('Path must start with /');
      const header = String(x.options.header || '').trim();
      if (header && !/^[A-Za-z0-9-]{1,64}$/.test(header)) throw new UserError('Invalid header name');
      const data = await x.get(p, { headers: header && x.secret ? { [header]: x.secret } : {} });
      return String(x.options.fields || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).map((line) => {
        const [label, expr = ''] = line.split('=').map((v) => v.trim());
        const value = expr.split('.').filter(Boolean).reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), data);
        return stat(label.slice(0, 30), typeof value === 'number' || typeof value === 'string' ? value : value === undefined ? null : JSON.stringify(value).slice(0, 40));
      });
    },
  },
};

// What the admin form needs to know about each integration (no code)
// The numbers a card shows unless you pick others: first the ones that say something is waiting for you
const DEFAULT_FIELDS = {
  jellyfin: ['Streaming', 'Movies', 'Series'], emby: ['Streaming', 'Movies', 'Series'], plex: ['Streams', 'Movies', 'TV shows'],
  tautulli: ['Streams', 'Transcoding', 'Bandwidth'], sonarr: ['Wanted', 'Queued', 'Series'], radarr: ['Wanted', 'Queued', 'Movies'],
  lidarr: ['Wanted', 'Queued', 'Artists'], prowlarr: ['Failed', 'Grabs', 'Indexers'], bazarr: ['Missing episodes', 'Missing movies'],
  overseerr: ['Pending', 'Processing', 'Available'], qbittorrent: ['Download', 'Upload', 'Leeching'], transmission: ['Download', 'Active', 'Torrents'],
  sabnzbd: ['Speed', 'Queue', 'Time left'], pihole: ['Queries', 'Blocked', 'Block rate'], adguard: ['Queries', 'Blocked', 'Block rate'],
  npm: ['Enabled', 'Disabled'], traefik: ['Routers', 'Services', 'Errors'], homeassistant: ['People home', 'Lights on', 'Switches on'],
  nextcloud: ['Active users (24 h)', 'Files', 'Free space'], immich: ['Photos', 'Videos', 'Storage'], paperless: ['Inbox', 'Documents'],
  uptimekuma: ['Up', 'Down', 'Uptime 24 h'], grafana: ['Dashboards', 'Alert rules'], portainer: ['Running', 'Stopped'],
  speedtest: ['Download', 'Upload', 'Ping'], prometheus: ['Targets up', 'Down'], authentik: ['Logins (24 h)', 'Failed (24 h)', 'Users'],
};
const MAX_FIELDS = 4;

// The integration's own order; the ones you picked, or the defaults
function shownStats(svc, stats) {
  if (!stats) return null;
  const want = svc.integration?.fields?.length ? svc.integration.fields : DEFAULT_FIELDS[svc.integration?.type];
  return (want ? stats.filter((x) => want.includes(x.label)) : stats).slice(0, MAX_FIELDS);
}

function integrationDefs() {
  return Object.fromEntries(Object.entries(INTEGRATIONS).map(([k, v]) => [k, {
    label: v.label, group: v.group, user: v.user || null, secret: v.secret, optionalSecret: Boolean(v.optionalSecret), icon: v.icon, options: v.options || [], fields: DEFAULT_FIELDS[k] || null,
  }]));
}

const serviceResults = new Map(); // service id -> { check, stats, error, updatedAt }

async function checkService(svc) {
  if (!svc.connection?.url) return null;
  const t0 = Date.now();
  try {
    const r = await connRequest(svc.connection, '/', { method: 'GET', headOnly: true, timeoutMs: 8000 });
    return { up: r.status < 500, code: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { up: false, code: null, ms: null, error: e instanceof UserError ? e.message : 'Unreachable' };
  }
}

async function runIntegration(svc, plainSecret = null) {
  const def = svc.integration && INTEGRATIONS[svc.integration.type];
  if (!def) return { stats: null, error: null };
  let secret = plainSecret;
  try {
    if (!secret && svc.secret) secret = decryptSecret(serviceSecretHost(svc));
    if (def.secret && !def.optionalSecret && !secret) throw new UserError('No credentials set; enter them in Admin → Services');
    const stats = await withTimeout(def.fetch(integrationCtx(svc, secret || '')), 20000, 'Integration');
    return { stats: stats.slice(0, 4), error: null };
  } catch (e) {
    return { stats: null, error: safeErrorMessage(e, secret) };
  }
}

// The secret is bound to the service and its connection (AAD), like device secrets.
function serviceIdentity(svc) {
  return { id: svc.id, type: `svc:${svc.integration?.type || ''}`, address: svc.connection?.url || '', username: svc.integration?.username || '', tlsMode: svc.connection?.tlsMode || '', fingerprint: svc.connection?.fingerprint || '' };
}
// What encryptSecret/decryptSecret take: the identity plus the stored ciphertext
function serviceSecretHost(svc) {
  return { ...serviceIdentity(svc), secret: svc.secret };
}

async function pollService(svc) {
  const [check, integ] = await Promise.all([checkService(svc), runIntegration(svc)]);
  if (config.services.find((x) => x.id === svc.id) !== svc) return;
  const prev = serviceResults.get(svc.id);
  serviceResults.set(svc.id, {
    check,
    stats: integ.stats ?? (integ.error ? prev?.stats ?? null : null),
    error: integ.error,
    updatedAt: Date.now(),
  });
  evaluateAlerts().catch((e) => log('Alert check failed:', e.message));
}

function forgetService(id) {
  serviceResults.delete(id);
  for (const k of svcSessions.keys()) if (k.startsWith(id + '|')) svcSessions.delete(k);
}

// --- Service configuration ---

const ICON_DIR = path.join(DATA_DIR, 'icons');
const ICON_INDEX_URL = { host: 'cdn.jsdelivr.net:443', path: '/gh/homarr-labs/dashboard-icons/tree.json' };
let iconIndex = { names: null, fetchedAt: 0 };
const iconPreviewCache = new Map(); // name -> sanitized image (memory only)

const validId = (v) => typeof v === 'string' && UUID.test(v);
const str = (v, max, name, { required = false, multiline = false } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new UserError(`${name} is required`);
  if (s.length > max) throw new UserError(`${name} is too long (max ${max} characters)`);
  if (multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s) : hasControlChars(s)) throw new UserError(`${name} contains invalid characters`);
  return s;
};

function validateLink(v) {
  const s = str(v, 500, 'Link');
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new UserError('Link must be a full URL (https://…)');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('Link must start with http:// or https://');
  return u.href;
}

function validateServiceInput(b) {
  const name = str(b.name, 48, 'Name', { required: true });
  const out = {
    name,
    group: str(b.group, 32, 'Group').replace(/^@+/, '') || 'Services',
    description: str(b.description, 120, 'Description'),
    href: validateLink(b.href),
    deviceId: b.deviceId && config.devices.some((d) => d.id === b.deviceId) ? b.deviceId : null,
    icon: b.icon?.kind === 'file' && config.icons.some((i) => i.id === b.icon.id) ? { kind: 'file', id: b.icon.id } : { kind: 'letter' },
    connection: null,
    integration: null,
  };
  const url = str(b.connection?.url, 500, 'Connection URL');
  if (url) {
    const u = parseServiceUrl(url);
    const tlsMode = u.https && b.connection?.tlsMode === 'pin' ? 'pin' : 'verify';
    out.connection = { url: u.href, tlsMode, fingerprint: tlsMode === 'pin' ? normalizeFingerprint(b.connection.fingerprint) : '' };
  }
  const type = b.integration?.type;
  if (type) {
    const def = INTEGRATIONS[type];
    if (!def) throw new UserError('Unknown integration');
    if (!out.connection) throw new UserError(`${def.label} needs a connection URL`);
    const options = {};
    for (const o of def.options || []) {
      options[o.key] = str(b.integration.options?.[o.key], o.multiline ? 1000 : 200, o.label, { required: o.required, multiline: o.multiline });
    }
    const username = def.user ? str(b.integration.username, 128, def.user) : '';
    if (def.user && !/optional|empty/i.test(def.user) && !username) throw new UserError(`${def.user} is required for ${def.label}`);
    // which numbers to show (none chosen = the defaults)
    const fields = Array.isArray(b.integration.fields) ? [...new Set(b.integration.fields.map((f) => str(f, 40, 'Number')).filter(Boolean))] : [];
    if (fields.length > MAX_FIELDS) throw new UserError(`Pick at most ${MAX_FIELDS} numbers`);
    out.integration = { type, username, options, ...(fields.length ? { fields } : {}) };
  }
  return out;
}

// Applies a create/update. A changed connection, integration type or user name without a
// newly entered secret deletes the stored secret (it is never sent anywhere new).
function buildService(old, b) {
  const fields = validateServiceInput(b);
  const next = old ? { ...old, ...fields } : { id: crypto.randomUUID(), ...fields, secret: null, order: Math.max(0, ...config.services.map((x) => x.order || 0)) + 1 };
  const secret = typeof b.secret === 'string' && b.secret.length ? b.secret : null;
  if (secret && (secret.length > 4096 || hasControlChars(secret))) throw new UserError('Invalid secret');
  let note = null;
  const ident = (x) => JSON.stringify(serviceIdentity(x));
  if (!next.integration) next.secret = null;
  else if (secret) next.secret = encryptSecret(serviceSecretHost(next), secret);
  else if (old && b.clearSecret === true) next.secret = null;
  else if (old?.secret && ident(old) !== ident(next)) {
    next.secret = null;
    note = 'The URL, integration or user name changed, so the stored secret was deleted. Enter it again.';
  }
  return { svc: next, note };
}

function publicService(svc) {
  return { ...svc, secret: undefined, hasSecret: Boolean(svc.secret) };
}

function iconUrl(icon) {
  return icon?.kind === 'file' ? `/media/icon/${icon.id}` : null;
}

// Services page: groups in the order chosen with Customize ('@vms' = Proxmox VMs and containers),
// with an optional column count each. Hidden services are only listed for the admin.
const VMS_GROUP = '@vms';

function servicesPayload(admin = false) {
  const layout = config.servicesLayout || { groups: [], columns: {} };
  const byGroup = new Map();
  const hidden = [];
  for (const svc of [...config.services].sort((a, b) => (a.order || 0) - (b.order || 0))) {
    const r = serviceResults.get(svc.id);
    const card = {
      id: svc.id,
      name: svc.name,
      description: svc.description,
      href: svc.href,
      icon: iconUrl(svc.icon),
      device: config.devices.find((d) => d.id === svc.deviceId)?.name || null,
      integration: svc.integration ? INTEGRATIONS[svc.integration.type]?.label : null,
      check: svc.connection ? r?.check ?? null : undefined,
      stats: shownStats(svc, r?.stats ?? null),
      error: r?.error ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
    if (svc.hidden) {
      if (admin) hidden.push({ ...card, group: svc.group });
      continue;
    }
    if (!byGroup.has(svc.group)) byGroup.set(svc.group, []);
    byGroup.get(svc.group).push(card);
  }
  const vms = vmsPayload();
  const keys = layout.groups.filter((k) => byGroup.has(k) || (k === VMS_GROUP && vms));
  for (const k of byGroup.keys()) if (!keys.includes(k)) keys.push(k);
  if (vms && !keys.includes(VMS_GROUP)) keys.push(VMS_GROUP);
  const cols = (key) => (Number.isInteger(layout.columns?.[key]) && layout.columns[key] >= 1 && layout.columns[key] <= 6 ? layout.columns[key] : 0);
  return {
    groups: keys.map((key) => (key === VMS_GROUP
      ? { key, name: 'Virtual machines & containers', columns: cols(key), vms }
      : { key, name: key, columns: cols(key), services: byGroup.get(key) })),
    ...(admin ? { hidden } : {}),
    refreshSeconds: config.settings.dashboard.refreshSeconds,
  };
}

// Validates everything first, then applies, so a rejected layout changes nothing
function saveServicesLayout(b) {
  if (!Array.isArray(b.groups) || b.groups.length > 200) throw new UserError('Invalid layout');
  const plan = [];
  for (const g of b.groups) {
    const key = g?.key === VMS_GROUP ? VMS_GROUP : str(g?.key, 32, 'Group name', { required: true });
    if (key !== VMS_GROUP && key.startsWith('@')) throw new UserError('Group names cannot start with @');
    if (plan.some((x) => x.key === key)) throw new UserError(`The group ${key} appears twice`);
    const columns = num(g.columns ?? 0, 0, 6, 'Columns', { int: true });
    const from = key !== VMS_GROUP && typeof g.from === 'string' && g.from !== key ? g.from : null;
    plan.push({ key, columns, from, ids: key === VMS_GROUP || !Array.isArray(g.services) ? [] : g.services });
  }
  const placed = new Set();
  let n = 0;
  for (const g of plan) {
    for (const id of g.ids) {
      const svc = config.services.find((x) => x.id === id);
      if (!svc || placed.has(id)) continue;
      placed.add(id);
      Object.assign(svc, { group: g.key, order: ++n });
    }
  }
  // services the layout didn't mention (e.g. hidden ones) keep their group, renamed if it was
  const renamed = new Map(plan.filter((g) => g.from).map((g) => [g.from, g.key]));
  for (const svc of [...config.services].sort((x, y) => (x.order || 0) - (y.order || 0))) {
    if (placed.has(svc.id)) continue;
    svc.order = ++n;
    if (renamed.has(svc.group)) svc.group = renamed.get(svc.group);
  }
  const hidden = new Set(Array.isArray(b.hidden) ? b.hidden : []);
  for (const svc of config.services) svc.hidden = hidden.has(svc.id);
  config.servicesLayout = { groups: plan.map((g) => g.key), columns: Object.fromEntries(plan.filter((g) => g.columns).map((g) => [g.key, g.columns])) };
}

// Proxmox VMs and containers, shown on the Services page (the Overview keeps the node health)
function vmsPayload() {
  const pve = config.hosts.filter((h) => h.type === 'proxmox');
  if (!pve.length) return null;
  const items = [];
  const notes = [];
  for (const h of pve) {
    const r = results.get(h.id);
    const name = config.devices.find((d) => d.id === h.deviceId)?.name || h.name;
    if (r && !r.ok) notes.push(`${name}: ${r.error}${r.data ? ' (showing the last known state)' : ''}`);
    for (const g of r?.data?.guests || []) {
      // two connections to the same cluster report the same guests: list each once
      if (items.some((x) => x.vmid === g.vmid && x.node === g.node)) continue;
      items.push({ key: `${h.id}:${g.vmid}`, vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status, cpu: g.cpu, maxcpu: g.maxcpu, mem: g.mem, maxmem: g.maxmem, uptime: g.uptime });
    }
  }
  return { items, notes, showStopped: config.settings.dashboard.showStoppedGuests };
}

// Icons: stored like backgrounds (sanitized PNG/JPEG/WebP, 0600, random id)
function storeIcon(buf, source) {
  const { mime, data } = sanitizeImage(buf);
  const existing = config.icons.find((i) => i.source === source && source.startsWith('library:'));
  if (existing) return existing;
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(ICON_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ICON_DIR, id), data, { mode: 0o600, flag: 'wx' });
  const rec = { id, mime, bytes: data.length, source, addedAt: Date.now() };
  config.icons.push(rec);
  return rec;
}

function pruneIcons() {
  const used = new Set(config.services.filter((s) => s.icon?.kind === 'file').map((s) => s.icon.id));
  for (const icon of config.icons.filter((i) => !used.has(i.id))) {
    if (Date.now() - icon.addedAt < 3600 * 1000) continue; // just picked in an unsaved form
    fs.rmSync(path.join(ICON_DIR, icon.id), { force: true });
    config.icons = config.icons.filter((i) => i !== icon);
  }
}

async function iconNames() {
  if (iconIndex.names && Date.now() - iconIndex.fetchedAt < 24 * 3600 * 1000) return iconIndex.names;
  const r = await httpsRequest(tlsConnect(ICON_INDEX_URL.host, { verify: true }), ICON_INDEX_URL.host, { path: ICON_INDEX_URL.path, full: true, maxBytes: 4 << 20 });
  if (r.status !== 200 || !Array.isArray(r.json?.png)) throw new UserError('Could not load the icon library');
  iconIndex = { names: r.json.png.filter((n) => /^[a-z0-9][a-z0-9._-]{0,80}\.png$/.test(n)).map((n) => n.slice(0, -4)), fetchedAt: Date.now() };
  return iconIndex.names;
}

async function fetchLibraryIcon(name) {
  const names = await iconNames();
  if (!names.includes(name)) throw new UserError('Unknown icon');
  const host = ICON_INDEX_URL.host;
  const r = await httpsRequest(tlsConnect(host, { verify: true }), host, { path: `/gh/homarr-labs/dashboard-icons/png/${name}.png`, binary: true, maxBytes: 2 << 20 });
  if (r.status !== 200) throw new UserError(`Icon download failed (HTTP ${r.status})`);
  return storeIcon(r.body, `library:${name}`);
}

// --- Documentation (always behind login, even with a public dashboard) ---

const DOCS_FILE = path.join(DATA_DIR, 'docs.json');
let docs = null;
const emptyDocs = () => ({ servers: {}, network: { networks: [], reservations: [], notes: '' }, pages: [] });

function loadDocs() {
  const d = readJson(DOCS_FILE, null);
  docs = normalizeDocs(d);
}

function normalizeDocs(d) {
  const out = { ...emptyDocs(), ...(d && typeof d === 'object' ? d : {}) };
  try {
    out.nav = out.nav ? validateDocsNav(out.nav) : defaultDocsNav(out.pages);
  } catch {
    out.nav = defaultDocsNav(out.pages);
  }
  return out;
}

// --- Docs menu: groups of server sheets and pages, plus the fixed Network group ---
// 'devices' and 'pages' are where sheets and pages land when they're in no other group, so they
// can be renamed and moved but not deleted.
const DOCS_ITEM = /^(server|page):[0-9a-f-]{36}$/;
const DOCS_FIXED_GROUPS = { devices: 'Servers & devices', pages: 'Pages' };

function defaultDocsNav(pages = []) {
  const folders = new Map(); // folders from before groups existed become groups
  for (const p of pages) if (p.folder) folders.set(p.folder, [...(folders.get(p.folder) || []), `page:${p.id}`]);
  return {
    groups: [
      { id: 'devices', name: DOCS_FIXED_GROUPS.devices, items: [] },
      { id: 'network' },
      ...[...folders].map(([name, items]) => ({ id: crypto.randomUUID(), name: name.slice(0, 48), items })),
      { id: 'pages', name: DOCS_FIXED_GROUPS.pages, items: [] },
    ],
  };
}

function validateDocsNav(b) {
  if (!Array.isArray(b?.groups) || b.groups.length > 100) throw new UserError('Invalid menu');
  const ids = new Set();
  const items = new Set();
  const groups = b.groups.map((g) => {
    if (g?.id === 'network') {
      if (ids.has('network')) throw new UserError('Invalid menu');
      ids.add('network');
      return { id: 'network' };
    }
    // new groups come with a temporary id from the browser
    const id = (DOCS_FIXED_GROUPS[g?.id] || UUID.test(g?.id)) ? g.id : /^new-\d{1,6}$/.test(g?.id) ? crypto.randomUUID() : null;
    if (!id || ids.has(id)) throw new UserError('Invalid menu');
    ids.add(id);
    const list = (Array.isArray(g.items) ? g.items : []).filter((it) => typeof it === 'string' && DOCS_ITEM.test(it) && !items.has(it) && items.add(it));
    return { id, name: str(g.name, 48, 'Group name', { required: true }), items: list.slice(0, 2000) };
  });
  if (!ids.has('network')) groups.push({ id: 'network' });
  for (const [id, name] of Object.entries(DOCS_FIXED_GROUPS)) if (!ids.has(id)) groups.push({ id, name, items: [] });
  return { groups };
}

// --- Page history: the last versions of each page, and recently deleted pages ---
// Kept in its own file so docs.json stays small. Saves within 10 minutes of each other are one
// version; a restore always becomes a version of its own.
const DOCS_HISTORY_FILE = path.join(DATA_DIR, 'docs-history.json');
const PAGE_VERSIONS = 50;
const MERGE_MS = 10 * 60e3;
const MAX_DELETED = 50;
let docsHistory = { pages: {}, deleted: [] };

// From the file or a backup: well-formed entries only
function cleanDocsHistory(h) {
  const out = { pages: {}, deleted: [] };
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const version = (x) => (Number.isInteger(x?.v) && Number.isFinite(x?.at)
    ? { v: x.v, at: x.at, title: text(x.title, 120), body: text(x.body, 200000), ...(Number.isInteger(x.restoredFrom) || x.restoredFrom === 'deleted' ? { restoredFrom: x.restoredFrom } : {}) }
    : null);
  for (const [id, list] of Object.entries(h?.pages && typeof h.pages === 'object' ? h.pages : {})) {
    if (!UUID.test(id) || !Array.isArray(list)) continue;
    const versions = list.map(version).filter(Boolean).slice(-PAGE_VERSIONS);
    if (versions.length) out.pages[id] = versions;
  }
  for (const d of Array.isArray(h?.deleted) ? h.deleted : []) {
    if (UUID.test(d?.id) && Number.isFinite(d.deletedAt)) out.deleted.push({ id: d.id, title: text(d.title, 120), body: text(d.body, 200000), group: text(d.group, 64), deletedAt: d.deletedAt });
  }
  out.deleted = out.deleted.slice(0, MAX_DELETED);
  return out;
}

function loadDocsHistory() {
  docsHistory = cleanDocsHistory(readJson(DOCS_HISTORY_FILE, null));
}
function saveDocsHistory() {
  writeJsonAtomic(DOCS_HISTORY_FILE, docsHistory);
}

// After a page is saved: add its new state as a version (or update the last one, within 10 minutes).
// `prev` is the page before the save, for pages that existed before history did.
function recordPageVersion(page, { prev = null, restoredFrom = null } = {}) {
  const list = (docsHistory.pages[page.id] ||= []);
  if (!list.length && prev) list.push({ v: 1, at: prev.updatedAt || Date.now(), title: prev.title, body: prev.body });
  const last = list[list.length - 1];
  const now = Date.now();
  if (last && !restoredFrom && last.title === page.title && last.body === page.body) return; // nothing changed
  if (last && !restoredFrom && !last.restoredFrom && list.length > 1 && now - last.at < MERGE_MS) Object.assign(last, { at: now, title: page.title, body: page.body });
  else list.push({ v: (last?.v || 0) + 1, at: now, title: page.title, body: page.body, ...(restoredFrom ? { restoredFrom } : {}) });
  if (list.length > PAGE_VERSIONS) list.splice(0, list.length - PAGE_VERSIONS);
  saveDocsHistory();
}

const pageGroup = (id) => docs.nav.groups.find((g) => g.items?.includes(`page:${id}`))?.id || 'pages';

// Puts a sheet or page into a group (or back where unplaced ones go)
function placeDocsItem(item, groupId) {
  for (const g of docs.nav.groups) if (g.items) g.items = g.items.filter((x) => x !== item);
  if (groupId === undefined) return;
  const target = docs.nav.groups.find((g) => g.items && g.id === groupId);
  if (target) target.items.push(item);
}
function saveDocs() {
  writeJsonAtomic(DOCS_FILE, docs);
}

const SERVER_DOC_FIELDS = { role: 80, os: 80, location: 80, purchased: 20, warranty: 20, notes: 50000 };
function validateServerDoc(b) {
  const out = {};
  for (const [k, max] of Object.entries(SERVER_DOC_FIELDS)) out[k] = str(b[k], max, k, { multiline: k === 'notes' });
  out.custom = (Array.isArray(b.custom) ? b.custom : []).slice(0, 40).map((f) => ({ label: str(f?.label, 60, 'Field name'), value: str(f?.value, 500, 'Field value') })).filter((f) => f.label || f.value);
  out.updatedAt = Date.now();
  return out;
}

function validateNetworkDoc(b) {
  const row = (r, spec) => Object.fromEntries(Object.entries(spec).map(([k, max]) => [k, str(r?.[k], max, k)]));
  const networks = (Array.isArray(b.networks) ? b.networks : []).slice(0, 100).map((r) => row(r, { name: 60, vlan: 10, subnet: 50, gateway: 50, dhcp: 80, purpose: 200 }));
  const reservations = (Array.isArray(b.reservations) ? b.reservations : []).slice(0, 1000).map((r) => ({
    ...row(r, { ip: 50, name: 80, mac: 30, notes: 200 }),
    deviceId: validId(r?.deviceId) && config.devices.some((d) => d.id === r.deviceId) ? r.deviceId : null,
  }));
  return { networks, reservations, notes: str(b.notes, 50000, 'Notes', { multiline: true }), updatedAt: Date.now() };
}

function validatePage(b) {
  return {
    title: str(b.title, 120, 'Title', { required: true }),
    body: str(b.body, 200000, 'Page', { multiline: true }),
    updatedAt: Date.now(),
  };
}

// UniFi data that only the docs need (networks, clients); fetched on demand, cached briefly.
// Only whitelisted fields are kept: network configs can also contain VPN/PPPoE secrets.
const unifiDocsCache = new Map(); // host id -> { at, data }
async function unifiDocsData(h) {
  const c = unifiDocsCache.get(h.id);
  if (c && Date.now() - c.at < 60000) return c.data;
  const password = decryptSecret(h);
  const site = 'default';
  const [nets, sta] = await Promise.all([
    unifiGet(h, password, `/proxy/network/api/s/${site}/rest/networkconf`).catch(() => []),
    unifiGet(h, password, `/proxy/network/api/s/${site}/stat/sta`).catch(() => []),
  ]);
  const data = {
    networks: (Array.isArray(nets) ? nets : []).filter((n) => n.purpose !== 'wan' && n.ip_subnet).map((n) => ({
      name: String(n.name || ''), vlan: n.vlan_enabled ? String(n.vlan ?? '') : '', subnet: String(n.ip_subnet || ''), purpose: String(n.purpose || ''),
      dhcp: n.dhcpd_enabled ? `${n.dhcpd_start || ''} – ${n.dhcpd_stop || ''}` : '', domain: String(n.domain_name || ''),
    })),
    clients: (Array.isArray(sta) ? sta : []).slice(0, 2000).map((x) => ({
      mac: String(x.mac || '').toLowerCase(), name: String(x.name || x.hostname || ''), ip: String(x.ip || ''), wired: Boolean(x.is_wired),
      swMac: x.sw_mac ? String(x.sw_mac).toLowerCase() : null, swPort: num0(x.sw_port), apMac: x.ap_mac ? String(x.ap_mac).toLowerCase() : null,
      network: String(x.network || ''), fixedIp: x.use_fixedip ? String(x.fixed_ip || '') : '',
    })),
  };
  unifiDocsCache.set(h.id, { at: Date.now(), data });
  return data;
}

// Facts gathered automatically for the documentation (login only)
async function docsAuto() {
  const hostIp = (h) => splitAddress(h.address).host;
  const devices = config.devices.filter((d) => !d.hidden).map((d) => {
    const conns = deviceHosts(d);
    const data = (type) => results.get(conns.find((h) => h.type === type)?.id)?.data;
    const idrac = data('idrac');
    const pveHost = conns.find((h) => h.type === 'proxmox');
    const pve = pveHost && results.get(pveHost.id)?.data;
    const node = pveHost ? effectiveNode(pveHost, d) : null;
    const syno = data('synology');
    const tn = data('truenas');
    const ud = d.unifi ? results.get(d.unifi.hostId)?.data?.devices?.find((x) => x.mac === d.unifi.mac) : null;
    const nodeInfo = pve?.nodes?.find((n) => n.name === node) || (pve?.nodes?.length === 1 ? pve.nodes[0] : null);
    return {
      id: d.id, name: d.name, kind: d.kind, location: d.location, u: d.u, height: d.height, estimateW: d.estimateW,
      connections: conns.map((h) => ({ type: h.type, label: HOST_TYPES[h.type].label, address: h.address, ip: hostIp(h) })),
      ips: [...new Set([...conns.map(hostIp), ud?.ip].filter(Boolean))],
      model: idrac?.model || syno?.system?.model || tn?.system?.model || ud?.model || null,
      serviceTag: idrac?.serviceTag || syno?.system?.serial || null,
      hostName: idrac?.hostName || tn?.system?.hostname || syno?.system?.name || null,
      firmware: syno?.system?.version || tn?.system?.version || ud?.version || null,
      cpu: nodeInfo?.maxcpu ? `${nodeInfo.maxcpu} threads` : tn?.system?.cores ? `${tn.system.cores} cores` : null,
      memory: nodeInfo?.maxmem || tn?.system?.memory || syno?.system?.memTotal || null,
      psus: idrac?.psus?.map((p) => p.capacityWatts && `${p.name}: ${p.capacityWatts} W`).filter(Boolean) || [],
      disks: syno?.disks?.map((x) => `${x.id}: ${x.model || ''} (${x.health || x.status || ''})`) || [],
      pools: [...(syno?.pools || []).map((p) => `${p.name}: ${p.status}`), ...(tn?.pools || []).map((p) => `${p.name}: ${p.status}`)],
      vms: pve ? pve.guests.filter((g) => !node || g.node === node).map((g) => ({ vmid: g.vmid, name: g.name, type: g.type, status: g.status, maxmem: g.maxmem, maxcpu: g.maxcpu })) : [],
      services: config.services.filter((s) => s.deviceId === d.id).map((s) => ({ name: s.name, href: s.href })),
      unifiMac: d.unifi?.mac || null,
    };
  });
  const unifi = [];
  for (const h of config.hosts.filter((x) => x.type === 'unifi' && x.secret)) {
    const r = results.get(h.id);
    if (!r?.data) continue;
    let extra = { networks: [], clients: [] };
    try {
      extra = await unifiDocsData(h);
    } catch {
      /* show what we have */
    }
    unifi.push({
      console: h.name,
      devices: r.data.devices.map((x) => ({ mac: x.mac, name: x.name, type: x.type, model: x.model, ip: x.ip, online: x.online, uplinkMac: x.uplinkMac, uplinkPort: x.uplinkPort, ports: x.ports })),
      ...extra,
    });
  }
  return { devices, unifi };
}

// ---------------------------------------------------------------------------
// History: metrics over time for the small graphs
//
// Every poll adds a value per series; values are averaged into 1-minute (kept 24 h),
// 15-minute (8 days) and 2-hour (92 days) buckets. Series: power:total, idrac:<host>:watts|inlet|tmax,
// pve:<host>:<node>:cpu|mem, syno:<host>:temp|cpu|mem, nas:<host>:load, unifi:<host>:<mac>:cpu|mem|temp|clients|poe,

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HIST_TIERS = [
  { name: 'm', step: 60e3, keep: 24 * 3600e3 + 3600e3 },
  { name: 'q', step: 15 * 60e3, keep: 8 * 86400e3 },
  { name: 'h', step: 2 * 3600e3, keep: 92 * 86400e3 },
];
const HIST_KEY = /^(power:total|idrac:[0-9a-f-]{36}:(watts|inlet|tmax)|pve:[0-9a-f-]{36}:[A-Za-z0-9._-]{1,64}:(cpu|mem)|syno:[0-9a-f-]{36}:(temp|cpu|mem)|nas:[0-9a-f-]{36}:load|unifi:[0-9a-f-]{36}:[0-9a-f:]{17}:(cpu|mem|temp|clients|poe))$/;
let history = { series: {} }; // key -> { m: [[t, v]], q: [...], h: [...], acc: { m: { t, sum, n }, ... }, seen }
let historyDirty = false;

// Only well-formed series with known keys are kept (the file may come from a backup)
function cleanHistory(h) {
  const out = { series: {} };
  const pts = (a) => (Array.isArray(a) ? a.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) : []);
  for (const [k, v] of Object.entries(h?.series && typeof h.series === 'object' ? h.series : {})) {
    if (!HIST_KEY.test(k) || !v || typeof v !== 'object') continue;
    const acc = {};
    for (const t of HIST_TIERS) {
      const a = v.acc?.[t.name];
      if (a && [a.t, a.sum, a.n].every(Number.isFinite)) acc[t.name] = { t: a.t, sum: a.sum, n: a.n };
    }
    out.series[k] = { m: pts(v.m), q: pts(v.q), h: pts(v.h), acc, seen: Number.isFinite(v.seen) ? v.seen : 0 };
  }
  return out;
}

function loadHistory() {
  history = cleanHistory(readJson(HISTORY_FILE, null));
}

function saveHistory() {
  if (!historyDirty) return;
  const cutoff = Date.now() - 30 * 86400e3;
  for (const [k, s] of Object.entries(history.series)) if ((s.seen || 0) < cutoff) delete history.series[k]; // removed devices
  writeJsonAtomic(HISTORY_FILE, history);
  historyDirty = false;
}

const round2 = (v) => Math.round(v * 100) / 100;

function histRecord(key, value, t = Date.now()) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const s = (history.series[key] ||= { m: [], q: [], h: [], acc: {} });
  s.seen = t;
  for (const tier of HIST_TIERS) {
    const bucket = Math.floor(t / tier.step) * tier.step;
    const a = s.acc[tier.name];
    if (a && a.t !== bucket && a.n) {
      s[tier.name].push([a.t, round2(a.sum / a.n)]);
      const from = t - tier.keep;
      let i = 0;
      while (i < s[tier.name].length && s[tier.name][i][0] < from) i++;
      if (i) s[tier.name].splice(0, i);
    }
    if (!a || a.t !== bucket) s.acc[tier.name] = { t: bucket, sum: 0, n: 0 };
    s.acc[tier.name].sum += value;
    s.acc[tier.name].n++;
  }
  historyDirty = true;
}

// Values for a range, averaged down to at most `points` points
function histQuery(key, rangeMs, points) {
  const s = history.series[key];
  if (!s) return [];
  const tier = rangeMs <= 26 * 3600e3 ? 'm' : rangeMs <= 8 * 86400e3 ? 'q' : 'h';
  const from = Date.now() - rangeMs;
  let data = s[tier].filter(([t]) => t >= from);
  const a = s.acc[tier];
  if (a?.n) data = [...data, [a.t, round2(a.sum / a.n)]];
  if (data.length <= points) return data;
  const out = [];
  for (let g = 0; g < points; g++) {
    const chunk = data.slice(Math.floor((g * data.length) / points), Math.floor(((g + 1) * data.length) / points));
    out.push([chunk[0][0], round2(chunk.reduce((x, [, v]) => x + v, 0) / chunk.length)]);
  }
  return out;
}

// What a poll result contributes to the history
function recordHistory(h, data, t) {
  const pct = (a, b) => (typeof a === 'number' && b ? (100 * a) / b : null);
  if (h.type === 'idrac') {
    histRecord(`idrac:${h.id}:watts`, data.watts, t);
    const inlet = data.temps.find((x) => /inlet/i.test(x.name));
    if (inlet) histRecord(`idrac:${h.id}:inlet`, inlet.celsius, t);
    if (data.temps.length) histRecord(`idrac:${h.id}:tmax`, Math.max(...data.temps.map((x) => x.celsius)), t);
  } else if (h.type === 'proxmox') {
    for (const n of data.nodes.filter((x) => x.status === 'online')) {
      histRecord(`pve:${h.id}:${n.name}:cpu`, typeof n.cpu === 'number' ? n.cpu * 100 : null, t);
      histRecord(`pve:${h.id}:${n.name}:mem`, pct(n.mem, n.maxmem), t);
    }
  } else if (h.type === 'synology') {
    histRecord(`syno:${h.id}:temp`, data.system.temp, t);
    histRecord(`syno:${h.id}:cpu`, typeof data.system.cpu === 'number' ? data.system.cpu * 100 : null, t);
    histRecord(`syno:${h.id}:mem`, pct(data.system.memUsed, data.system.memTotal), t);
  } else if (h.type === 'truenas') {
    histRecord(`nas:${h.id}:load`, data.system.loadavg?.[0], t);
  } else if (h.type === 'unifi') {
    for (const d of data.devices.filter((x) => x.online)) {
      const k = `unifi:${h.id}:${d.mac}`;
      histRecord(`${k}:cpu`, typeof d.cpu === 'number' ? d.cpu * 100 : null, t);
      histRecord(`${k}:mem`, typeof d.mem === 'number' ? d.mem * 100 : null, t);
      if (d.temps.length) histRecord(`${k}:temp`, Math.max(...d.temps.map((x) => x.value)), t);
      histRecord(`${k}:clients`, d.clients, t);
      if (d.poe) histRecord(`${k}:poe`, d.poe.usedW, t);
    }
  }
}

// ---------------------------------------------------------------------------
// Polling

const results = new Map(); // host id -> { ok, error, data, updatedAt, lastOkAt }
let pollTimer = null;
let polling = false;

// `plainSecret` is only used to test a connection before it is saved.
async function runCollector(h, plainSecret = null) {
  let secret = plainSecret;
  try {
    if (!secret && !h.secret) throw new UserError('No credentials set; enter them in Admin');
    secret ||= decryptSecret(h);
    const data = await withTimeout(COLLECTORS[h.type](h, secret), COLLECT_TIMEOUT_MS, 'Data collection');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: safeErrorMessage(e, secret) };
  }
}

async function pollHost(h) {
  const r = await runCollector(h);
  if (config.hosts.find((x) => x.id === h.id) !== h) return; // host edited/removed meanwhile
  const now = Date.now();
  const prev = results.get(h.id);
  if (r.ok) {
    results.set(h.id, { ok: true, data: r.data, updatedAt: now, lastOkAt: now });
    recordHistory(h, r.data, now);
    if (h.type === 'idrac' && typeof r.data.watts === 'number') recordPower(`idrac:${h.id}`, r.data.watts, now, false, h.deviceId);
    if (h.type === 'unifi') {
      // PoE a switch delivers counts for that switch
      for (const d of r.data.devices) if (d.poe) recordPower(`poe:${h.id}:${d.mac}`, d.poe.usedW, now, false, config.devices.find((v) => v.unifi?.hostId === h.id && v.unifi.mac === d.mac)?.id || null);
      syncUnifiDevices(h, r.data.devices);
    }
    if (h.type === 'idrac' || h.type === 'unifi') histRecord('power:total', measuredWatts().total, now);
  } else {
    results.set(h.id, { ok: false, error: r.error, data: prev?.data ?? null, updatedAt: now, lastOkAt: prev?.lastOkAt ?? null });
  }
  evaluateAlerts().catch((e) => log('Alert check failed:', e.message));
}

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    await ensurePrices().catch(() => {});
    await Promise.all([...config.hosts.map(pollHost), ...config.services.map(pollService)]);
    const now = Date.now();
    for (const d of estimatedDevices()) recordPower(`est:${d.id}`, d.estimateW, now, true, d.id);
  } finally {
    polling = false;
  }
}

function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollAll, config.settings.dashboard.refreshSeconds * 1000);
  pollAll();
}

// ---------------------------------------------------------------------------
// Time helpers (Europe/Oslo)

const zonedFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

function zoned(ms) {
  const p = {};
  for (const { type, value } of zonedFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    month: `${p.year}-${p.month}`,
    year: p.year,
    hour: parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10),
    second: parseInt(p.second, 10),
    weekend: p.weekday === 'Sat' || p.weekday === 'Sun',
  };
}

function osloDayStart(ms) {
  const z = zoned(ms);
  let t = ms - ((z.hour * 60 + z.minute) * 60 + z.second) * 1000 - (ms % 1000);
  // Correct for DST shifts within the day
  for (let i = 0; i < 3 && zoned(t).date !== z.date; i++) t += 3600 * 1000;
  for (let i = 0; i < 3 && zoned(t - 3600 * 1000).date === z.date; i++) t -= 3600 * 1000;
  return t;
}

// ---------------------------------------------------------------------------
// Electricity prices

const spotCache = new Map(); // `${area}|${date}` -> { slots: [{start,end,nokPerKwh}] } | { failedAt }

async function fetchSpot(area, date) {
  const [y, m, d] = date.split('-');
  const address = 'www.hvakosterstrommen.no:443';
  const data = await httpsRequest(tlsConnect(address, { verify: true }), address, {
    path: `/api/v1/prices/${y}/${m}-${d}_${area}.json`,
  });
  if (!Array.isArray(data) || !data.length) throw new UserError('Empty price data');
  return data
    .map((e) => ({ start: Date.parse(e.time_start), end: Date.parse(e.time_end), nok: Number(e.NOK_per_kWh) }))
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && Number.isFinite(e.nok))
    .sort((a, b) => a.start - b.start);
}

async function loadSpot(area, date) {
  const k = `${area}|${date}`;
  const c = spotCache.get(k);
  if (c?.slots) return c.slots;
  if (c?.failedAt && Date.now() - c.failedAt < 10 * 60 * 1000) return null;
  try {
    const slots = await fetchSpot(area, date);
    spotCache.set(k, { slots });
    return slots;
  } catch (e) {
    spotCache.set(k, { failedAt: Date.now() });
    if (!(e.status === 404)) log(`Spot price fetch failed for ${area} ${date}: ${e.message}`);
    return null;
  }
}

async function ensurePrices() {
  const p = config.settings.power;
  if (p.plan !== 'spot') return;
  const now = Date.now();
  await loadSpot(p.area, zoned(now).date);
  if (zoned(now).hour >= 13) await loadSpot(p.area, zoned(now + 24 * 3600 * 1000).date);
  if (spotCache.size > 20) {
    const keep = new Set([0, -1, 1].map((d) => `${p.area}|${zoned(now + d * 86400000).date}`));
    for (const k of spotCache.keys()) if (!keep.has(k)) spotCache.delete(k);
  }
}

function spotAt(area, t) {
  const slots = spotCache.get(`${area}|${zoned(t).date}`)?.slots;
  return slots?.find((s) => t >= s.start && t < s.end) ?? null;
}

// Norwegian public holidays (helligdager) as YYYY-MM-DD, for tariffs with night rate on holidays.
const holidayCache = new Map();
function holidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  // Easter Sunday (anonymous Gregorian algorithm)
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = Date.UTC(year, month - 1, day);
  const rel = (n) => new Date(easter + n * 86400000).toISOString().slice(0, 10);
  const set = new Set(
    [`${year}-01-01`, `${year}-05-01`, `${year}-05-17`, `${year}-12-25`, `${year}-12-26`].concat([-3, -2, 0, 1, 39, 49, 50].map(rel))
  );
  holidayCache.set(year, set);
  return set;
}

function gridRateAt(t, p) {
  const g = p.grid;
  const z = zoned(t);
  const offDay = (g.weekendNight && z.weekend) || (g.holidayNight && holidays(+z.year).has(z.date));
  const day = z.hour >= g.dayStartHour && z.hour < g.dayEndHour && !offDay;
  let ore = day ? g.dayOre : g.nightOre;
  if (g.ratesInclVat) ore /= 1.25;
  if (!g.ratesInclFees) ore += g.elavgiftOre + g.enovaOre;
  return { ore: ore * (p.vat ? 1.25 : 1), period: day ? 'day' : 'night' };
}

function fixedPerHourKr(p) {
  return p.fixed.include ? ((p.fixed.gridMonthlyKr + p.fixed.supplierMonthlyKr) * 12) / 8760 : 0;
}

// Returns total price in øre/kWh (energy incl. VAT/markup/subsidy + grid tariff), or null if unknown.
function priceAt(t, p = config.settings.power) {
  const vat = p.vat ? 1.25 : 1;
  let energy;
  let spotOre = null;
  // Under Norgespris the supplier still bills spot + markup; the state settles spot vs. 40 øre.
  if (p.plan === 'norgespris') energy = NORGESPRIS_ORE_EX_VAT * vat + p.markupOre;
  else {
    const slot = spotAt(p.area, t);
    if (!slot) return null;
    spotOre = slot.nok * 100;
    let ex = spotOre;
    if (p.support.enabled) ex -= Math.max(0, spotOre - p.support.thresholdOre) * (p.support.percent / 100);
    energy = ex * vat + p.markupOre;
  }
  const grid = gridRateAt(t, p);
  return { energy, grid: grid.ore, total: energy + grid.ore, period: grid.period, spotOre };
}

// ---------------------------------------------------------------------------
// Energy log: integrates iDRAC power readings into hourly buckets

let energy = { buckets: {} }; // hourStartMs -> { wh, ore, unpricedWh }
let energyDirty = false;
const lastSample = new Map(); // host id -> { t, w }

function loadEnergy() {
  const e = readJson(ENERGY_FILE, null);
  if (e && e.buckets && typeof e.buckets === 'object') energy = e;
}

function saveEnergy() {
  if (!energyDirty) return;
  const cutoff = Date.now() - 3 * 366 * 86400000;
  for (const k of Object.keys(energy.buckets)) if (+k < cutoff) delete energy.buckets[k];
  writeJsonAtomic(ENERGY_FILE, energy);
  energyDirty = false;
}

// Measured sources: `idrac:<host>`, `poe:<host>:<mac>`. Estimated: 'estimate' (rack equipment).
// Integrates readings into hourly buckets: totals, and (since the energy report) per device in
// `dev: { [device id]: { wh, ore, estWh, estOre } }`.
function recordPower(sourceId, watts, t, estimated = false, deviceId = null) {
  const prev = lastSample.get(sourceId);
  lastSample.set(sourceId, { t, w: watts });
  if (!prev) return;
  const dt = t - prev.t;
  const maxGap = Math.max(3 * config.settings.dashboard.refreshSeconds * 1000, 5 * 60 * 1000);
  if (dt <= 0 || dt > maxGap) return;
  const mid = prev.t + dt / 2;
  const wh = ((prev.w + watts) / 2) * (dt / 3600000);
  const key = String(Math.floor(mid / 3600000) * 3600000);
  const b = (energy.buckets[key] ||= { wh: 0, ore: 0, unpricedWh: 0 });
  const price = priceAt(mid);
  const [whKey, oreKey, unKey] = estimated ? ['estWh', 'estOre', 'estUnpricedWh'] : ['wh', 'ore', 'unpricedWh'];
  b[whKey] = (b[whKey] || 0) + wh;
  if (price) b[oreKey] = (b[oreKey] || 0) + (wh / 1000) * price.total;
  else b[unKey] = (b[unKey] || 0) + wh;
  if (deviceId) {
    const d = ((b.dev ||= {})[deviceId] ||= {});
    const [dw, dor] = estimated ? ['estWh', 'estOre'] : ['wh', 'ore'];
    d[dw] = Math.round(((d[dw] || 0) + wh) * 100) / 100;
    if (price) d[dor] = Math.round(((d[dor] || 0) + (wh / 1000) * price.total) * 100) / 100;
  }
  energyDirty = true;
}

const bucketDayCache = new Map();

function energySummary() {
  const now = Date.now();
  const zNow = zoned(now);
  const fixedHour = fixedPerHourKr(config.settings.power); // fixed fees pro rata per logged hour, if enabled
  const est = config.settings.power.includeEstimates;
  const add = (acc, b) => {
    acc.kwh += (b.wh + (est ? b.estWh || 0 : 0)) / 1000;
    acc.cost += (b.ore + (est ? b.estOre || 0 : 0)) / 100 + fixedHour;
    acc.unpricedKwh += (b.unpricedWh + (est ? b.estUnpricedWh || 0 : 0)) / 1000;
  };
  const blank = () => ({ kwh: 0, cost: 0, unpricedKwh: 0 });
  const today = blank();
  const month = blank();
  const year = blank();
  const days = new Map();
  for (let i = 29; i >= 0; i--) days.set(zoned(now - i * 86400000).date, { date: zoned(now - i * 86400000).date, ...blank() });
  let first = null;
  for (const [k, b] of Object.entries(energy.buckets)) {
    let date = bucketDayCache.get(k);
    if (!date) {
      date = zoned(+k + 1).date;
      bucketDayCache.set(k, date);
    }
    if (first === null || +k < first) first = +k;
    if (date === zNow.date) add(today, b);
    if (date.startsWith(zNow.month)) add(month, b);
    if (date.startsWith(zNow.year)) add(year, b);
    if (days.has(date)) add(days.get(date), b);
  }
  return { today, month, year, days: [...days.values()], since: first };
}

// ---------------------------------------------------------------------------
// Energy report: a month or a year from the hourly log, by day or by month, per device where the
// log has it. Costs are counted like the power card: estimates and fixed fees only if enabled.

function energyReport(period, by = null) {
  const kind = /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? 'month' : /^\d{4}$/.test(period) ? 'year' : null;
  if (!kind) throw new UserError('Choose a month (2026-10) or a year (2026)');
  const step = by || (kind === 'month' ? 'day' : 'month');
  if (step === 'month' && kind === 'month') throw new UserError('Per month needs a year');
  const est = config.settings.power.includeEstimates;
  const fixedHour = fixedPerHourKr(config.settings.power);
  const today = zoned(Date.now()).date;
  const blank = () => ({ kwh: 0, cost: 0, energyOre: 0, pricedKwh: 0, unpricedKwh: 0, hours: 0 });
  // every day (or month) of the period, so gaps show as zero and the future as empty
  const rows = new Map();
  const y = Number(period.slice(0, 4));
  if (step === 'day') {
    for (let d = new Date(Date.UTC(y, kind === 'month' ? Number(period.slice(5)) - 1 : 0, 1)); d.toISOString().startsWith(period); d = new Date(d.getTime() + 86400e3)) {
      const key = d.toISOString().slice(0, 10);
      rows.set(key, { key, future: key > today, ...blank() });
    }
  } else {
    for (let m = 1; m <= 12; m++) {
      const key = `${period}-${String(m).padStart(2, '0')}`;
      rows.set(key, { key, future: key > today.slice(0, 7), ...blank() });
    }
  }
  const totals = blank();
  const devices = new Map();
  let devicesSince = null;
  let first = null;
  for (const [k, b] of Object.entries(energy.buckets)) {
    let date = bucketDayCache.get(k);
    if (!date) {
      date = zoned(+k + 1).date;
      bucketDayCache.set(k, date);
    }
    if (!date.startsWith(period)) continue;
    const row = rows.get(step === 'day' ? date : date.slice(0, 7));
    if (!row) continue;
    const wh = b.wh + (est ? b.estWh || 0 : 0);
    const ore = b.ore + (est ? b.estOre || 0 : 0);
    const un = b.unpricedWh + (est ? b.estUnpricedWh || 0 : 0);
    for (const acc of [row, totals]) {
      acc.kwh += wh / 1000;
      acc.energyOre += ore;
      acc.pricedKwh += (wh - un) / 1000;
      acc.unpricedKwh += un / 1000;
      acc.cost += ore / 100 + fixedHour;
      acc.hours++;
    }
    if (first === null || +k < first) first = +k;
    for (const [id, d] of Object.entries(b.dev || {})) {
      if (devicesSince === null || +k < devicesSince) devicesSince = +k;
      const acc = devices.get(id) || { id, kwh: 0, cost: 0, estKwh: 0, estCost: 0 };
      acc.kwh += (d.wh || 0) / 1000;
      acc.cost += (d.ore || 0) / 100;
      acc.estKwh += (d.estWh || 0) / 1000;
      acc.estCost += (d.estOre || 0) / 100;
      devices.set(id, acc);
    }
  }
  const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
  const out = (a) => ({ kwh: round(a.kwh), cost: round(a.cost, 2), avgPrice: a.pricedKwh > 0.0005 ? round(a.energyOre / a.pricedKwh, 1) : null, unpricedKwh: round(a.unpricedKwh) });
  const devName = (id) => config.devices.find((d) => d.id === id)?.name || 'Removed device';
  return {
    period, kind, by: step,
    rows: [...rows.values()].map((r) => ({ key: r.key, future: r.future, ...(r.hours ? out(r) : { kwh: 0, cost: 0, avgPrice: null, unpricedKwh: 0 }) })),
    totals: out(totals),
    loggedSince: first,
    devices: [...devices.values()].map((d) => ({ id: d.id, name: devName(d.id), kwh: round(d.kwh), cost: round(d.cost, 2), estKwh: round(d.estKwh), estCost: round(d.estCost, 2) }))
      .sort((a, b) => b.kwh + b.estKwh - (a.kwh + a.estKwh)),
    devicesSince,
    includeEstimates: est,
    fixedIncluded: fixedHour > 0,
  };
}

// Months and years that have logged energy, newest first (for the period picker)
function energyPeriods() {
  const months = new Set();
  for (const k of Object.keys(energy.buckets)) {
    let date = bucketDayCache.get(k);
    if (!date) {
      date = zoned(+k + 1).date;
      bucketDayCache.set(k, date);
    }
    months.add(date.slice(0, 7));
  }
  months.add(zoned(Date.now()).month);
  const list = [...months].sort().reverse();
  return { months: list, years: [...new Set(list.map((m) => m.slice(0, 4)))] };
}

// CSV for spreadsheets. "no": semicolons, decimal comma and a BOM, as Norwegian Excel expects;
// "std": commas and decimal points. Text that a spreadsheet would run as a formula is defused.
function energyCsv(r, format) {
  const no = format === 'no';
  const sep = no ? ';' : ',';
  const num = (v, d) => (v === null || v === undefined ? '' : (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', no ? ',' : '.'));
  const text = (v) => {
    let t = String(v).replace(/[\r\n]+/g, ' ');
    if (/^[=+\-@\t]/.test(t)) t = `'${t}`;
    return /["\n;,]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const header = [r.by === 'day' ? 'Date' : 'Month', 'kWh', 'Cost (kr)', 'Average price (øre/kWh)', 'kWh without price'];
  const lines = [header.map(text).join(sep)];
  for (const row of r.rows.filter((x) => !x.future)) lines.push([text(row.key), num(row.kwh, 3), num(row.cost, 2), num(row.avgPrice, 1), num(row.unpricedKwh, 3)].join(sep));
  lines.push([text('Total'), num(r.totals.kwh, 3), num(r.totals.cost, 2), num(r.totals.avgPrice, 1), num(r.totals.unpricedKwh, 3)].join(sep));
  if (r.devices.length) {
    lines.push('');
    lines.push(['Device', 'Measured kWh', 'Measured cost (kr)', 'Estimated kWh', 'Estimated cost (kr)'].map(text).join(sep));
    for (const d of r.devices) lines.push([text(d.name), num(d.kwh, 3), num(d.cost, 2), num(d.estKwh, 3), num(d.estCost, 2)].join(sep));
  }
  return (no ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

// Rack equipment estimates; devices linked to an iDRAC are measured instead.
// Estimated draw of devices without a power sensor; devices with an iDRAC are measured instead.
// Devices without a power sensor that have an estimate (a device with an iDRAC is measured)
function estimatedDevices() {
  return config.devices.filter((d) => !d.hidden && d.estimateW > 0 && !deviceHosts(d).some((h) => h.type === 'idrac'));
}

function estimatedWatts() {
  return estimatedDevices().reduce((w, d) => w + d.estimateW, 0);
}

function measuredWatts() {
  let idrac = null;
  let poe = null;
  for (const h of config.hosts) {
    const r = results.get(h.id);
    if (!r?.ok) continue;
    if (h.type === 'idrac' && typeof r.data?.watts === 'number') idrac = (idrac || 0) + r.data.watts;
    if (h.type === 'unifi') for (const d of r.data.devices) if (d.poe) poe = (poe || 0) + d.poe.usedW;
  }
  return { idrac, poe, total: idrac === null && poe === null ? null : (idrac || 0) + (poe || 0) };
}

function powerSummary() {
  const p = config.settings.power;
  const measured = measuredWatts();
  const estimatedW = estimatedWatts();
  const watts = measured.total === null && !(p.includeEstimates && estimatedW) ? null : (measured.total || 0) + (p.includeEstimates ? estimatedW : 0);
  const now = Date.now();
  const priceNow = priceAt(now);
  let estimate = null;
  if (watts !== null) {
    // Cost for a full day at the current draw with today's price profile
    const start = osloDayStart(now);
    const end = osloDayStart(start + 36 * 3600 * 1000);
    let ore = 0;
    let complete = true;
    for (let t = start; t < end; t += 15 * 60 * 1000) {
      const pr = priceAt(t + 7.5 * 60 * 1000);
      if (!pr) {
        complete = false;
        break;
      }
      ore += (watts / 1000) * 0.25 * pr.total;
    }
    const kwhDay = (watts / 1000) * ((end - start) / 3600000);
    const fixedMonth = p.fixed.include ? p.fixed.gridMonthlyKr + p.fixed.supplierMonthlyKr : 0;
    estimate = complete
      ? {
          kwhDay,
          day: ore / 100 + (fixedMonth * 12) / 365,
          month: (ore / 100) * 30.4375 + fixedMonth,
          year: (ore / 100) * 365 + fixedMonth * 12,
        }
      : { kwhDay, day: null, month: null, year: null };
  }
  return {
    watts, // what the cost is based on
    measured,
    estimatedW,
    includeEstimates: p.includeEstimates,
    plan: p.plan,
    area: p.area,
    vat: p.vat,
    priceNow,
    fixed: { monthlyKr: p.fixed.gridMonthlyKr + p.fixed.supplierMonthlyKr, included: p.fixed.include },
    estimate,
    usage: energySummary(),
  };
}

// ---------------------------------------------------------------------------
// Sessions, rate limiting

const sessions = new Map(); // id -> { user, csrf, created, seen }

// HTTPS requests get a __Host- cookie with the Secure flag; plain HTTP a separate cookie, so a
// session created over HTTPS is never sent over HTTP. COOKIE_SECURE=1 is for TLS-terminating proxies.
function secureRequest(req) {
  return process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE !== '0' && Boolean(req.socket.encrypted));
}
const cookieName = (req) => (secureRequest(req) ? '__Host-hd_session' : 'hd_session');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req) {
  const id = parseCookies(req.headers.cookie)[cookieName(req)];
  if (!id) return null;
  const s = sessions.get(id);
  if (!s || s.secure !== secureRequest(req)) return null; // HTTPS sessions are only valid over HTTPS (and vice versa)
  const now = Date.now();
  if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
    sessions.delete(id);
    return null;
  }
  s.seen = now;
  s.id = id;
  return s;
}

function createSession(req, res, user) {
  const id = crypto.randomBytes(32).toString('base64url');
  const s = { user, csrf: crypto.randomBytes(32).toString('base64url'), created: Date.now(), seen: Date.now(), secure: secureRequest(req) };
  sessions.set(id, s);
  setCookie(req, res, id, SESSION_MAX_MS / 1000);
  return s;
}

function setCookie(req, res, value, maxAge, name = cookieName(req)) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [
    ...(prev ? [].concat(prev) : []),
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureRequest(req) ? '; Secure' : ''}`,
  ]);
}

// Remembered devices. "Remember this device" at login gives that browser 30 days of view-only
// access: what the dashboard shows, plus Docs and Updates, but no changes and no Admin; those ask
// for the password. The cookie holds a random token; only its SHA-256 hash is stored, so the file
// can't be used to sign in. Admin → System lists the devices and can sign them out.
const remembered = new Map(); // hash -> { id, hash, user, name, created, lastSeen, lastIp, expires, secure }
const viewerCsrf = new Map(); // device id -> CSRF token for its log-out (memory only)
let rememberedDirty = false;
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const deviceCookieName = (req) => (secureRequest(req) ? '__Host-hd_device' : 'hd_device');

function loadRemembered() {
  const admin = readAdmin();
  for (const r of readJson(REMEMBER_FILE, {}).devices || []) {
    // Devices remembered under an earlier password (changed here or with set-admin) are dropped
    if (r && typeof r.hash === 'string' && /^[0-9a-f]{16}$/.test(r.id) && r.expires > Date.now() && admin && r.user === admin.username && r.pw === (admin.changedAt ?? null)) remembered.set(r.hash, r);
  }
}

function saveRemembered() {
  rememberedDirty = false;
  writeJsonAtomic(REMEMBER_FILE, { devices: [...remembered.values()] });
}

function deviceName(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' on ') || 'Unknown browser';
}

function rememberDevice(req, res, admin) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const rec = { id: crypto.randomBytes(8).toString('hex'), hash: tokenHash(token), user: admin.username, pw: admin.changedAt ?? null, name: deviceName(req.headers['user-agent']), created: now, lastSeen: now, lastIp: req.socket.remoteAddress || '', expires: now + REMEMBER_MS, secure: secureRequest(req) };
  remembered.set(rec.hash, rec);
  for (const r of [...remembered.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(REMEMBER_MAX)) forgetDevice(r);
  saveRemembered();
  setCookie(req, res, token, REMEMBER_MS / 1000, deviceCookieName(req));
}

function forgetDevice(rec) {
  remembered.delete(rec.hash);
  viewerCsrf.delete(rec.id);
  rememberedDirty = true;
}

function rememberedFor(req) {
  const token = parseCookies(req.headers.cookie)[deviceCookieName(req)];
  if (!token) return null;
  const rec = remembered.get(tokenHash(token));
  return rec && rec.secure === secureRequest(req) && rec.expires > Date.now() ? rec : null;
}

// View-only access from a remembered device, shaped like a session for the routes that read
function getViewer(req) {
  const rec = rememberedFor(req);
  if (!rec) return null;
  rec.lastSeen = Date.now();
  rec.lastIp = req.socket.remoteAddress || '';
  rememberedDirty = true;
  if (!viewerCsrf.has(rec.id)) viewerCsrf.set(rec.id, crypto.randomBytes(32).toString('base64url'));
  return { user: rec.user, csrf: viewerCsrf.get(rec.id), readOnly: true, device: rec };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) sessions.delete(id);
  for (const r of remembered.values()) if (r.expires <= now) forgetDevice(r);
  for (const [k, v] of loginFailures) if (now - v.last > 24 * 3600 * 1000) loginFailures.delete(k);
}, 60 * 1000).unref();

const loginFailures = new Map(); // key -> { count, last, lockedUntil }

function lockRemaining(key) {
  const f = loginFailures.get(key);
  return f && f.lockedUntil > Date.now() ? Math.ceil((f.lockedUntil - Date.now()) / 1000) : 0;
}

function registerFailure(key, freeAttempts) {
  const now = Date.now();
  const f = loginFailures.get(key) || { count: 0, last: 0, lockedUntil: 0 };
  if (now - f.last > 3600 * 1000) f.count = 0;
  f.count++;
  f.last = now;
  if (f.count >= freeAttempts) f.lockedUntil = now + Math.min(30000 * 2 ** (f.count - freeAttempts), 3600 * 1000);
  loginFailures.set(key, f);
}

// ---------------------------------------------------------------------------
// HTTP plumbing

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return reject(Object.assign(new UserError('Content-Type must be application/json'), { status: 415 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new UserError('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(Object.assign(new UserError('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const allowedHosts = new Set();
function initAllowedHosts() {
  allowedHosts.clear();
  const ports = [listeners.https?.port, listeners.http?.port].filter(Boolean);
  const names = [HOST.includes(':') ? `[${HOST}]` : HOST];
  if (HOST === '127.0.0.1' || HOST === '::1') names.push('localhost', '127.0.0.1', '[::1]');
  for (const extra of String(process.env.ALLOWED_HOSTS || '').split(',')) if (extra.trim()) names.push(extra.trim().toLowerCase());
  for (const n of names) {
    if (/:\d+$/.test(n) && !n.endsWith(']')) allowedHosts.add(n);
    else {
      for (const p of ports) allowedHosts.add(`${n}:${p}`);
      allowedHosts.add(n.replace(/:\d+$/, '')); // default ports and reverse proxies (e.g. tailscale serve)
    }
  }
}

function hostAllowed(h) {
  return typeof h === 'string' && allowedHosts.has(h.toLowerCase());
}

// Blocks cross-site state-changing requests in addition to the CSRF token and SameSite cookie.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() !== String(req.headers.host).toLowerCase() && !allowedHosts.has(o.host.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function csrfOk(req, session) {
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || !session) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Static files are loaded once into memory from an explicit allow-list.
const STATIC = {};
const PUBLIC_ASSETS = new Set(['/static/css/style.css', '/static/js/login.js', '/static/js/common.js', '/static/favicon.svg', '/static/js/offline.js',
  '/static/icons/icon-192.png', '/static/icons/icon-512.png', '/static/icons/maskable-512.png', '/static/icons/apple-touch-icon.png']);
const DASHBOARD_ASSETS = new Set(['/static/js/dashboard.js', '/static/js/layout.js', '/static/js/rack.js', '/static/js/services.js', '/static/js/energy.js']);
function loadStatic() {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const files = {
    'login.html': 'login.html',
    'dashboard.html': 'dashboard.html',
    'admin.html': 'admin.html',
    'services.html': 'services.html',
    'docs.html': 'docs.html',
    'updates.html': 'updates.html',
    'energy.html': 'energy.html',
    'offline.html': 'offline.html',
    '/sw.js': 'sw.js',
    '/static/js/offline.js': 'js/offline.js',
    '/static/icons/icon-192.png': 'icons/icon-192.png',
    '/static/icons/icon-512.png': 'icons/icon-512.png',
    '/static/icons/maskable-512.png': 'icons/maskable-512.png',
    '/static/icons/apple-touch-icon.png': 'icons/apple-touch-icon.png',
    '/static/js/energy.js': 'js/energy.js',
    '/static/js/updates.js': 'js/updates.js',
    '/static/js/services.js': 'js/services.js',
    '/static/js/docs.js': 'js/docs.js',
    '/static/js/markdown.js': 'js/markdown.js',
    '/static/css/style.css': 'css/style.css',
    '/static/js/common.js': 'js/common.js',
    '/static/js/login.js': 'js/login.js',
    '/static/js/dashboard.js': 'js/dashboard.js',
    '/static/js/layout.js': 'js/layout.js',
    '/static/js/rack.js': 'js/rack.js',
    '/static/js/admin.js': 'js/admin.js',
    '/static/favicon.svg': 'favicon.svg',
  };
  for (const [key, rel] of Object.entries(files)) {
    STATIC[key] = { body: fs.readFileSync(path.join(PUBLIC_DIR, rel)), type: types[path.extname(rel)] };
  }
}

function sendStatic(res, key) {
  const f = STATIC[key];
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length });
  res.end(f.body);
}

// ---------------------------------------------------------------------------
// Background images
//
// Only JPEG, PNG and WebP are accepted, identified by their content (never SVG, which can
// carry scripts). Metadata that may hold GPS position, camera details or comments
// (EXIF, XMP, IPTC, PNG text chunks) is removed before the file is stored. A JPEG's
// EXIF orientation is kept, so portrait photos still display upright.

const BACKGROUND_DIR = path.join(DATA_DIR, 'backgrounds');

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function exifOrientation(app1) {
  if (app1.length < 14 || app1.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const t = app1.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  const r16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const r32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  try {
    const ifd = r32(4);
    const n = r16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (r16(e) === 0x0112) {
        const v = r16(e + 8);
        return v >= 1 && v <= 8 ? v : null;
      }
    }
  } catch {
    /* malformed EXIF: ignore */
  }
  return null;
}

function orientationSegment(v) {
  // APP1 with a minimal big-endian TIFF holding only the Orientation tag
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const hdr = Buffer.from([0xff, 0xe1, 0, 0]);
  hdr.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([hdr, payload]);
}

function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let pos = 2;
  let orientation = null;
  let scan = false;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break;
    const m = buf[pos + 1];
    if (m === 0xff) {
      pos++;
      continue;
    }
    if (m === 0xda) {
      out.push(buf.subarray(pos)); // start of scan: the rest is image data
      scan = true;
      break;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      out.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const end = pos + 2 + buf.readUInt16BE(pos + 2);
    if (end > buf.length || end < pos + 4) break;
    if (m === 0xe1) orientation = exifOrientation(buf.subarray(pos + 4, end)) || orientation; // EXIF/XMP: dropped
    else if (m !== 0xed && m !== 0xfe) out.push(buf.subarray(pos, end)); // IPTC (APP13) and comments dropped
    pos = end;
  }
  if (!scan) throw new UserError('Invalid or truncated JPEG');
  if (orientation && orientation !== 1) out.splice(1, 0, orientationSegment(orientation));
  return Buffer.concat(out);
}

function stripPng(buf) {
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const out = [buf.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + buf.readUInt32BE(pos);
    if (end > buf.length) break;
    if (!drop.has(type)) out.push(buf.subarray(pos, end));
    if (type === 'IEND') return Buffer.concat(out);
    pos = end;
  }
  throw new UserError('Invalid or truncated PNG');
}

function stripWebp(buf) {
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > buf.length) throw new UserError('Invalid or truncated WebP');
    const end = Math.min(pos + 8 + size + (size & 1), buf.length);
    if (id !== 'EXIF' && id !== 'XMP ') {
      const c = Buffer.from(buf.subarray(pos, end));
      if (id === 'VP8X' && c.length > 8) c[8] &= ~0x0c; // clear EXIF/XMP flags
      chunks.push(c);
    }
    pos = end;
  }
  if (!chunks.length) throw new UserError('Invalid WebP');
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const hdr = Buffer.alloc(8);
  hdr.write('RIFF', 0, 'latin1');
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

function sanitizeImage(buf) {
  const mime = sniffImage(buf);
  if (!mime) throw new UserError('Only JPEG, PNG and WebP images are supported');
  const clean = mime === 'image/jpeg' ? stripJpeg(buf) : mime === 'image/png' ? stripPng(buf) : stripWebp(buf);
  return { mime, data: clean };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > maxBytes) {
      req.resume();
      return reject(Object.assign(new UserError(`Image too large (max ${maxBytes >> 20} MB)`), { status: 413 }));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new UserError(`Image too large (max ${maxBytes >> 20} MB)`), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function backgroundVisible(session) {
  return Boolean(session) || config.settings.dashboard.public;
}

// Per-request appearance: CSS custom properties and the background image URL.
function appearanceCss(session) {
  const a = config.settings.appearance;
  let css = `:root{--bg-blur:${a.blur}px;--bg-dim:${a.dim / 100};--card-alpha:${a.cardOpacity / 100};}\n`;
  if (a.background.type === 'image' && a.background.imageId && backgroundVisible(session))
    css += `.app-bg{background-image:url("/media/bg/${a.background.imageId}");}\n`;
  return css;
}

function htmlAttrs(session) {
  const a = config.settings.appearance;
  const bg =
    a.background.type === 'builtin' ? a.background.builtin : a.background.type === 'image' && backgroundVisible(session) ? 'image' : 'none';
  return `data-theme="${a.theme}" data-bg="${bg}"`; // both values come from fixed allow-lists
}

// The bar colour of the installed app follows the theme (its --surface colour)
const THEME_COLORS = {
  light: '#fcfcfb', dark: '#1a1a19', nord: '#3b4252', dracula: '#282a36', 'catppuccin-mocha': '#1e1e2e', 'catppuccin-latte': '#eff1f5',
  'solarized-dark': '#073642', 'solarized-light': '#fdf6e3', 'gruvbox-dark': '#282828', 'tokyo-night': '#1a1b26',
};

function appHead() {
  const theme = config.settings.appearance.theme;
  const color = THEME_COLORS[theme]
    ? `<meta name="theme-color" content="${THEME_COLORS[theme]}">`
    : `<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">`;
  // use-credentials: the app gets its name from the dashboard title only when signed in
  return `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">${color}<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">\n</head>`;
}

// Installable app. The name is the dashboard title for those who may see the dashboard,
// otherwise just "Homelab"; nothing else in it says anything about the lab.
function manifest(sees) {
  const name = sees ? config.settings.dashboard.title : 'Homelab';
  return {
    id: '/',
    name,
    short_name: name.length > 12 ? 'Homelab' : name,
    description: 'Homelab dashboard',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#1a1a19',
    theme_color: THEME_COLORS[config.settings.appearance.theme] || THEME_COLORS.dark,
    icons: [
      { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/static/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

function sendPage(res, key, session, edit = (html) => html) {
  const html = edit(STATIC[key].body.toString('utf8').replace('<html lang="en">', `<html lang="en" ${htmlAttrs(session)}>`).replace('</head>', appHead()));
  const body = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': STATIC[key].type, 'Content-Length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Routes

// What visitors of a public dashboard don't get: addresses (UniFi reports WAN and LAN IPs) and
// software versions, which tell an attacker what to try. Names and status stay.
function forVisitors(payload) {
  payload.unifi = payload.unifi.map((h) => (h.data ? {
    ...h,
    data: {
      ...h.data,
      health: h.data.health ? { ...h.data.health, wan: h.data.health.wan ? { ...h.data.health.wan, ip: null } : null } : null,
      devices: h.data.devices.map(({ ip, version, upgradable, upgradeTo, ...d }) => d),
    },
  } : h));
  payload.synology = payload.synology.map((h) => (h.data ? { ...h, data: { ...h.data, system: { ...h.data.system, version: null, upgradeAvailable: false } } } : h));
  payload.truenas = payload.truenas.map((h) => (h.data ? { ...h, data: { ...h.data, system: { ...h.data.system, version: null } } } : h));
  return payload;
}

// What needs attention, worst first, tied to the device or service it is about
function attentionList() {
  const rank = { critical: 0, warning: 1 };
  return [...alertConditions(true)].map(([key, c]) => {
    const host = config.hosts.find((h) => h.id === c.owner);
    const deviceId = c.device || host?.deviceId || null;
    const dev = deviceId && config.devices.find((d) => d.id === deviceId);
    const svc = c.type === 'service' ? config.services.find((x) => x.id === c.owner) : null;
    const subject = dev?.name || svc?.name || null;
    // titles read "titan: PS2 failed"; the subject is shown separately
    const text = subject && c.title.startsWith(`${subject}: `) ? c.title.slice(subject.length + 2) : c.title;
    // a TrueNAS alert's own text says more than "TrueNAS critical"
    const own = c.type === 'nas' && c.detail;
    return { key, type: c.type, severity: c.severity, subject, text: own ? c.detail : text, detail: own ? text : c.detail, deviceId: dev ? deviceId : null, serviceId: svc?.id || null, since: alertState.active[key]?.since || null };
  }).filter((a) => !a.deviceId || !config.devices.find((d) => d.id === a.deviceId)?.hidden)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (a.subject || '').localeCompare(b.subject || ''));
}

function servicesSummary() {
  const checked = config.services.filter((s) => s.connection && !s.hidden).map((s) => serviceResults.get(s.id)?.check).filter(Boolean);
  return { total: config.services.filter((s) => !s.hidden).length, up: checked.filter((c) => c.up).length, down: checked.filter((c) => !c.up).length };
}

function dashboardPayload() {
  const s = config.settings.dashboard;
  const group = (type) =>
    config.hosts
      .filter((h) => h.type === type)
      .map((h) => {
        const r = results.get(h.id);
        return {
          id: h.id,
          name: h.name,
          ok: r ? r.ok : null,
          error: r && !r.ok ? r.error : null,
          updatedAt: r?.updatedAt ?? null,
          lastOkAt: r?.lastOkAt ?? null,
          data: r?.data ?? null,
        };
      });
  const devices = config.devices
    .filter((d) => !d.hidden)
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      location: d.location,
      u: d.u,
      height: d.height,
      estimateW: d.estimateW,
      front: d.front || null,
      unifi: d.unifi,
      links: deviceLinks(d),
      connections: deviceHosts(d).map((h) => ({ id: h.id, type: h.type, node: h.type === 'proxmox' ? effectiveNode(h, d) : undefined })),
    }));
  return {
    title: s.title,
    refreshSeconds: s.refreshSeconds,
    showStoppedGuests: s.showStoppedGuests,
    layout: config.layout,
    generatedAt: Date.now(),
    idrac: group('idrac'),
    proxmox: group('proxmox'),
    truenas: group('truenas'),
    synology: group('synology'),
    unifi: group('unifi'),
    devices,
    rack: { ...config.rack, items: devices },
    power: powerSummary(),
    attention: attentionList(),
    services: servicesSummary(),
  };
}

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const wait = Math.max(lockRemaining('ip:' + ip), lockRemaining('global'));
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    return sendError(res, 429, `Too many failed attempts. Try again in ${wait} s.`);
  }
  const body = await readBody(req);
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
  const admin = readAdmin();
  if (!admin) return sendError(res, 503, 'No admin account exists. Run: node server.js set-admin');
  const userOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(username).digest(),
    crypto.createHash('sha256').update(admin.username).digest()
  );
  const passOk = await verifyPassword(password, userOk ? admin.hash : DUMMY_HASH);
  if (!(userOk && passOk)) {
    registerFailure('ip:' + ip, 5);
    registerFailure('global', 20);
    log(`Failed login from ${ip}`);
    await new Promise((r) => setTimeout(r, 400 + crypto.randomInt(400)));
    return sendError(res, 401, 'Invalid username or password');
  }
  loginFailures.delete('ip:' + ip);
  const old = getSession(req);
  if (old) sessions.delete(old.id);
  createSession(req, res, admin.username);
  const known = rememberedFor(req);
  if (body.remember === true && !known) rememberDevice(req, res, admin);
  log(`Admin login from ${ip}${body.remember === true && !known ? ' (device remembered for viewing)' : ''}`);
  sendJson(res, 200, { ok: true, remembered: Boolean(known) || body.remember === true });
}

function findHost(id) {
  const h = config.hosts.find((x) => x.id === id);
  if (!h) throw Object.assign(new UserError('Host not found'), { status: 404 });
  return h;
}

function forgetHost(id) {
  results.delete(id);
  for (const k of lastSample.keys()) if (k === `idrac:${id}` || k.startsWith(`poe:${id}:`)) lastSample.delete(k);
  for (const k of unifiSessions.keys()) if (k.startsWith(id + '|')) unifiSessions.delete(k);
  for (const k of redfishPathCache.keys()) if (k.startsWith(id + '|')) redfishPathCache.delete(k);
}

// What a remembered device may read besides the dashboard views; anything else asks for the password
const VIEWER_READS = new Set(['/api/session', '/api/docs', '/api/updates']);

async function handleApi(req, res, url, session, viewer = null) {
  const p = url.pathname;
  const m = req.method;
  const sees = Boolean(session || viewer || config.settings.dashboard.public);

  if (p === '/api/login' && m === 'POST') return handleLogin(req, res);

  if (p === '/api/dashboard' && m === 'GET') {
    if (!sees) return sendError(res, 401, 'Login required');
    const payload = dashboardPayload();
    if (!session && !viewer) forVisitors(payload);
    else {
      const up = updatesPayload().rows.filter((r) => r.available);
      payload.updates = { available: up.length, devices: [...new Set(up.filter((r) => r.ownerType === 'device' && r.owner).map((r) => r.owner))] };
    }
    return sendJson(res, 200, { ...payload, loggedIn: Boolean(session), viewer: Boolean(viewer) });
  }

  if (p === '/api/energy/report' && m === 'GET') {
    if (!sees) return sendError(res, 401, 'Login required');
    const period = url.searchParams.get('period') || zoned(Date.now()).month;
    const report = energyReport(period);
    const prev = report.kind === 'month'
      ? (() => { const [yy, mm] = period.split('-').map(Number); return mm === 1 ? `${yy - 1}-12` : `${yy}-${String(mm - 1).padStart(2, '0')}`; })()
      : String(Number(period) - 1);
    return sendJson(res, 200, { ...report, previous: { period: prev, totals: energyReport(prev).totals }, periods: energyPeriods(), loggedIn: Boolean(session), viewer: Boolean(viewer), title: config.settings.dashboard.title });
  }
  if (p === '/api/energy/export' && m === 'GET') {
    if (!sees) return sendError(res, 401, 'Login required');
    const period = url.searchParams.get('period') || '';
    const by = url.searchParams.get('by') === 'month' ? 'month' : 'day';
    const format = url.searchParams.get('format') === 'std' ? 'std' : 'no';
    const body = Buffer.from(energyCsv(energyReport(period, by), format));
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="energy-${period}-per-${by}${format === 'no' ? '-excel' : ''}.csv"`,
      'Content-Length': body.length,
    });
    return res.end(body);
  }
  if (p === '/api/history' && m === 'GET') {
    if (!sees) return sendError(res, 401, 'Login required');
    const ranges = { '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };
    const rangeMs = ranges[url.searchParams.get('range')] || ranges['24h'];
    const points = Math.min(Math.max(parseInt(url.searchParams.get('points') || '120', 10) || 120, 10), 500);
    const keys = String(url.searchParams.get('keys') || '').split(',').filter((k) => HIST_KEY.test(k)).slice(0, 80);
    return sendJson(res, 200, { series: Object.fromEntries(keys.map((k) => [k, histQuery(k, rangeMs, points)])) });
  }

  if (p === '/api/services' && m === 'GET') {
    if (!sees) return sendError(res, 401, 'Login required');
    return sendJson(res, 200, { ...servicesPayload(Boolean(session)), loggedIn: Boolean(session), viewer: Boolean(viewer), title: config.settings.dashboard.title });
  }

  if (!session) {
    if (!viewer) return sendError(res, 401, 'Login required');
    // A remembered device reads; it never changes anything
    if (!(m === 'GET' && VIEWER_READS.has(p)) && !(m === 'POST' && p === '/api/logout')) return sendError(res, 401, 'Enter your password to make changes');
    session = viewer;
  }

  if (p === '/api/session' && m === 'GET') return sendJson(res, 200, { user: session.user, csrf: session.csrf, readOnly: Boolean(session.readOnly) });

  // Everything below changes state or exposes admin data: require CSRF token on writes.
  if (m !== 'GET' && !csrfOk(req, session)) return sendError(res, 403, 'Invalid CSRF token');

  if (p === '/api/logout' && m === 'POST') {
    // Logging out also forgets this device, if it was remembered
    if (!session.readOnly) sessions.delete(session.id);
    const device = rememberedFor(req);
    if (device) {
      forgetDevice(device);
      saveRemembered();
    }
    setCookie(req, res, '', 0);
    setCookie(req, res, '', 0, deviceCookieName(req));
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/remembered' && m === 'GET') {
    const here = rememberedFor(req);
    const devices = [...remembered.values()].filter((r) => r.expires > Date.now()).sort((a, b) => b.lastSeen - a.lastSeen);
    return sendJson(res, 200, { days: REMEMBER_MS / 86400e3, devices: devices.map((r) => ({ id: r.id, name: r.name, created: r.created, lastSeen: r.lastSeen, lastIp: r.lastIp, expires: r.expires, current: r === here })) });
  }
  if (p === '/api/admin/remembered' && m === 'DELETE') {
    for (const r of [...remembered.values()]) forgetDevice(r);
    saveRemembered();
    log('All remembered devices signed out');
    return sendJson(res, 200, { ok: true });
  }
  const rmd = p.match(/^\/api\/admin\/remembered\/([0-9a-f]{16})$/);
  if (rmd && m === 'DELETE') {
    const rec = [...remembered.values()].find((r) => r.id === rmd[1]);
    if (!rec) return sendError(res, 404, 'Not found');
    forgetDevice(rec);
    saveRemembered();
    log(`Remembered device signed out: ${rec.name}`);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/config' && m === 'GET') {
    return sendJson(res, 200, {
      settings: config.settings,
      hosts: config.hosts.map((h) => {
        const r = results.get(h.id);
        return {
          ...publicHost(h),
          deviceId: h.deviceId,
          nodes: h.type === 'proxmox' ? (r?.data?.nodes || []).map((n) => n.name) : undefined,
          status: r ? { ok: r.ok, error: r.ok ? null : r.error, updatedAt: r.updatedAt } : null,
        };
      }),
      devices: config.devices,
      types: HOST_TYPES,
      themes: THEMES,
      builtinBackgrounds: BUILTIN_BACKGROUNDS,
      backgrounds: config.backgrounds,
      rack: config.rack,
      rackKinds: RACK_KINDS,
      user: session.user,
    });
  }

  if (p === '/api/admin/settings' && m === 'PUT') {
    const body = await readBody(req);
    const prevRefresh = config.settings.dashboard.refreshSeconds;
    const prevPower = JSON.stringify(config.settings.power);
    config.settings = validateSettings(body, config.settings);
    saveConfig();
    if (config.settings.dashboard.refreshSeconds !== prevRefresh) schedulePolling();
    else if (JSON.stringify(config.settings.power) !== prevPower) ensurePrices().catch(() => {});
    log('Settings updated');
    return sendJson(res, 200, { settings: config.settings });
  }

  if (p === '/api/admin/hosts' && m === 'POST') {
    const body = await readBody(req);
    const type = body.type;
    if (!HOST_TYPES[type]) throw new UserError('Invalid host type');
    const h = { id: crypto.randomUUID(), type, ...validateHostInput(body, type), secret: null };
    const secret = secretFromBody(type, body);
    if (secret) h.secret = encryptSecret(h, secret);
    const dev = newDevice({ name: h.name, kind: KIND_FOR_TYPE[type] || 'other' });
    h.deviceId = dev.id;
    config.devices.push(dev);
    config.hosts.push(h);
    saveConfig();
    log(`Host added: ${type} ${h.name}`);
    pollHost(h);
    return sendJson(res, 201, { host: publicHost(h) });
  }

  const hm = p.match(/^\/api\/admin\/hosts\/([0-9a-f-]{36})(\/test)?$/);
  if (hm) {
    const old = findHost(hm[1]);
    if (hm[2] && m === 'POST') {
      const r = await runCollector(old);
      if (r.ok) {
        const now = Date.now();
        results.set(old.id, { ok: true, data: r.data, updatedAt: now, lastOkAt: now });
      }
      return sendJson(res, 200, r.ok ? { ok: true } : { ok: false, error: r.error });
    }
    if (!hm[2] && m === 'PUT') {
      const body = await readBody(req);
      const next = { ...old, ...validateHostInput(body, old.type) };
      const secret = secretFromBody(old.type, body);
      const identityChanged = ['address', 'username', 'tlsMode', 'fingerprint'].some((k) => next[k] !== old[k]);
      let secretNote = null;
      if (secret) next.secret = encryptSecret(next, secret);
      else if (body.clearSecret === true) next.secret = null;
      else if (identityChanged && old.secret) {
        next.secret = null; // never send an old secret to a different endpoint/identity
        secretNote = 'Address, username or the pinned identity changed: the stored secret was deleted. Enter it again.';
      }
      config.hosts[config.hosts.indexOf(old)] = next;
      saveConfig();
      forgetHost(old.id);
      log(`Host updated: ${next.type} ${next.name}`);
      pollHost(next);
      return sendJson(res, 200, { host: publicHost(next), note: secretNote });
    }
    if (!hm[2] && m === 'DELETE') {
      config.hosts = config.hosts.filter((x) => x !== old);
      // drop the device too if it was only a holder for this connection
      const dev = config.devices.find((d) => d.id === old.deviceId);
      if (dev && !dev.discovered && dev.location === 'none' && !deviceHosts(dev).length) config.devices = config.devices.filter((d) => d !== dev);
      saveConfig();
      forgetHost(old.id);
      recheckAlerts();
      log(`Host removed: ${old.type} ${old.name}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/server' && m === 'GET') return sendJson(res, 200, { ...serverStatus(), current: secureRequest(req) ? 'https' : 'http' });
  if (p === '/api/admin/server' && m === 'PUT') {
    const next = validateServerSettings(await readBody(req));
    const old = await applyServer(next); // throws (and changes nothing) if a port can't be used
    config.settings.server = next;
    saveConfig();
    log(`Web server settings changed: ${JSON.stringify(serverUrls())}`);
    sendJson(res, 200, serverStatus());
    closeListeners(old); // after the response, so the browser gets it on the old port
    return;
  }

  if (p === '/api/admin/rack' && m === 'PUT') {
    config.rack = validateRackSettings(await readBody(req));
    saveConfig();
    log('Rack settings updated');
    return sendJson(res, 200, { rack: config.rack });
  }

  if (p === '/api/admin/rack/passive' && m === 'POST') {
    if (config.rack.passive.length >= 120) throw new UserError('Too many panels');
    const item = { id: crypto.randomUUID(), ...validatePassive(await readBody(req), null) };
    config.rack.passive.push(item);
    saveConfig();
    return sendJson(res, 201, { item });
  }
  const rp = p.match(/^\/api\/admin\/rack\/passive\/([0-9a-f-]{36})$/);
  if (rp) {
    const item = config.rack.passive.find((x) => x.id === rp[1]);
    if (!item) throw Object.assign(new UserError('Panel not found'), { status: 404 });
    if (m === 'PUT') {
      Object.assign(item, validatePassive({ ...item, ...(await readBody(req)) }, item.id));
      if (item.kind !== 'patch') delete item.ports;
      saveConfig();
      return sendJson(res, 200, { item });
    }
    if (m === 'DELETE') {
      config.rack.passive = config.rack.passive.filter((x) => x !== item);
      saveConfig();
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/devices' && m === 'POST') {
    const body = await readBody(req);
    const dev = newDevice(validateDeviceFields(body, null));
    const built = validateConnections(body.connections).map((c) => buildConnection(null, c, dev));
    config.devices.push(dev);
    config.hosts.push(...built.map((b) => b.host));
    saveConfig();
    log(`Device added: ${dev.name} (${built.map((b) => b.host.type).join(', ') || 'no connections'})`);
    built.forEach((b) => pollHost(b.host));
    return sendJson(res, 201, { device: dev, notes: built.map((b) => b.note).filter(Boolean) });
  }

  const dm = p.match(/^\/api\/admin\/devices\/([0-9a-f-]{36})(\/placement)?$/);
  if (dm) {
    const dev = findDevice(dm[1]);
    if (dm[2] && m === 'PUT') {
      // Drag in the rack view: only placement changes
      Object.assign(dev, validatePlacement({ ...dev, ...(await readBody(req)) }, dev.id, dev.name));
      saveConfig();
      return sendJson(res, 200, { device: dev });
    }
    if (!dm[2] && m === 'PUT') {
      const body = await readBody(req);
      const fields = validateDeviceFields(body, dev.id);
      const existing = deviceHosts(dev);
      // Without a connections list (e.g. "show again"), the connections are left as they are
      const list = body.connections === undefined ? existing.map((h) => ({ ...h, id: h.id, secret: undefined })) : body.connections;
      const built = validateConnections(list).map((c) => {
        const old = c.id ? existing.find((h) => h.id === c.id) : null;
        if (c.id && !old) throw new UserError('Unknown connection');
        return buildConnection(old, c, { ...dev, ...fields });
      });
      const keep = new Set(built.map((b) => b.host.id));
      const removed = existing.filter((h) => !keep.has(h.id));
      Object.assign(dev, fields, { hidden: body.hidden === true });
      const byId = new Map(built.map((b) => [b.host.id, b.host]));
      config.hosts = config.hosts.filter((h) => !removed.includes(h)).map((h) => byId.get(h.id) || h);
      for (const b of built) if (!existing.some((h) => h.id === b.host.id)) config.hosts.push(b.host);
      saveConfig();
      const same = (a, b) => ['address', 'username', 'tlsMode', 'fingerprint', 'secret'].every((k) => a[k] === b[k]) && JSON.stringify(a.options) === JSON.stringify(b.options);
      const changed = built.map((b) => b.host).filter((h) => !existing.some((o) => o.id === h.id && same(o, h)));
      for (const h of [...removed, ...changed]) forgetHost(h.id);
      changed.forEach((h) => pollHost(h));
      log(`Device updated: ${dev.name}`);
      return sendJson(res, 200, { device: dev, notes: built.map((b) => b.note).filter(Boolean) });
    }
    if (!dm[2] && m === 'DELETE') {
      if (dev.discovered) {
        // Would be re-created by the next UniFi update, so it is hidden instead
        dev.hidden = true;
        saveConfig();
        recheckAlerts();
        return sendJson(res, 200, { hidden: true });
      }
      const removed = deviceHosts(dev);
      config.hosts = config.hosts.filter((h) => !removed.includes(h));
      config.devices = config.devices.filter((d) => d !== dev);
      saveConfig();
      removed.forEach((h) => forgetHost(h.id));
      recheckAlerts();
      log(`Device removed: ${dev.name}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/test-connection' && m === 'POST') {
    // Tests settings from the form; a newly typed secret is used once and not stored.
    const body = await readBody(req);
    const old = typeof body.id === 'string' && UUID.test(body.id) ? config.hosts.find((h) => h.id === body.id) : null;
    const type = old ? old.type : body.type;
    if (!HOST_TYPES[type]) throw new UserError('Invalid connection type');
    const fields = validateHostInput({ ...body, name: old?.name || 'Test' }, type);
    const h = { id: old?.id || crypto.randomUUID(), type, ...fields };
    if (type === 'proxmox') h.options = { ...h.options, node: String(body.options?.node || '') };
    let secret = secretFromBody(type, body);
    if (!secret && old?.secret) {
      if (['address', 'username', 'tlsMode', 'fingerprint'].some((k) => h[k] !== old[k]))
        throw new UserError('The address or identity changed: enter the secret again to test');
      secret = decryptSecret(old);
    }
    if (!secret) throw new UserError('Enter the password/token/key to test');
    const r = await runCollector(h, secret);
    if (!old) for (const k of unifiSessions.keys()) if (k.startsWith(h.id + '|')) unifiSessions.delete(k);
    if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error });
    const d = r.data;
    const info = {
      idrac: () => [d.model, typeof d.watts === 'number' ? `${d.watts} W` : null].filter(Boolean).join(' · '),
      proxmox: () => `${d.nodes.length} node${d.nodes.length === 1 ? '' : 's'}: ${d.nodes.map((n) => n.name).join(', ')}`,
      truenas: () => [d.system.hostname, d.system.version].filter(Boolean).join(' · '),
      synology: () => [d.system.model, d.system.version].filter(Boolean).join(' · '),
      unifi: () => `${d.devices.length} device${d.devices.length === 1 ? '' : 's'} found`,
    }[type]();
    return sendJson(res, 200, { ok: true, info, nodes: type === 'proxmox' ? d.nodes.map((n) => n.name) : undefined });
  }

  if (p === '/api/admin/layout' && m === 'PUT') {
    config.layout = validateLayout(await readBody(req));
    saveConfig();
    log(config.layout ? 'Dashboard layout saved' : 'Dashboard layout reset');
    return sendJson(res, 200, { layout: config.layout });
  }

  if (p === '/api/admin/backgrounds' && m === 'POST') {
    if (config.backgrounds.length >= MAX_BACKGROUNDS) throw new UserError(`At most ${MAX_BACKGROUNDS} images; delete one first`);
    const { mime, data } = sanitizeImage(await readRawBody(req, MAX_BACKGROUND_BYTES));
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(BACKGROUND_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(BACKGROUND_DIR, id), data, { mode: 0o600, flag: 'wx' });
    const rawName = String(req.headers['x-file-name'] || '');
    let name = 'Image';
    try {
      name = decodeURIComponent(rawName).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || name;
    } catch {
      /* keep default */
    }
    const rec = { id, mime, bytes: data.length, name, uploadedAt: Date.now() };
    config.backgrounds.push(rec);
    saveConfig();
    log(`Background uploaded (${mime}, ${data.length} bytes)`);
    return sendJson(res, 201, { background: rec });
  }

  const bm = p.match(/^\/api\/admin\/backgrounds\/([0-9a-f]{32})$/);
  if (bm && m === 'DELETE') {
    const rec = config.backgrounds.find((b) => b.id === bm[1]);
    if (!rec) throw Object.assign(new UserError('Image not found'), { status: 404 });
    config.backgrounds = config.backgrounds.filter((b) => b !== rec);
    const a = config.settings.appearance;
    if (a.background.imageId === rec.id) a.background = { ...a.background, type: 'none', imageId: null };
    saveConfig();
    fs.rmSync(path.join(BACKGROUND_DIR, rec.id), { force: true });
    return sendJson(res, 200, { ok: true, appearance: a });
  }

  // --- Services (admin) ---
  if (p === '/api/admin/services' && m === 'GET') {
    return sendJson(res, 200, {
      services: [...config.services].sort((a, b) => (a.order || 0) - (b.order || 0)).map((x) => {
        const r = serviceResults.get(x.id);
        return { ...publicService(x), result: r ? { check: r.check, error: r.error, labels: r.stats?.map((st) => st.label) || [] } : null };
      }),
      integrations: integrationDefs(),
      devices: config.devices.filter((d) => !d.hidden).map((d) => ({ id: d.id, name: d.name })),
      icons: config.icons.map((i) => ({ id: i.id, source: i.source })),
    });
  }
  if (p === '/api/admin/services' && m === 'POST') {
    const { svc, note } = buildService(null, await readBody(req));
    config.services.push(svc);
    saveConfig();
    log(`Service added: ${svc.name}`);
    pollService(svc);
    return sendJson(res, 201, { service: publicService(svc), note });
  }
  if (p === '/api/admin/services/layout' && m === 'PUT') {
    saveServicesLayout(await readBody(req));
    saveConfig();
    log('Services layout updated');
    return sendJson(res, 200, { ...servicesPayload(true), loggedIn: true, title: config.settings.dashboard.title });
  }
  if (p === '/api/admin/services/order' && m === 'PUT') {
    const { ids } = await readBody(req);
    if (!Array.isArray(ids)) throw new UserError('Invalid order');
    ids.forEach((id, i) => {
      const svc = config.services.find((x) => x.id === id);
      if (svc) svc.order = i + 1;
    });
    saveConfig();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/services/test' && m === 'POST') {
    // Tests the form as entered; a newly typed secret is used once and not stored
    const body = await readBody(req);
    const old = validId(body.id) ? config.services.find((x) => x.id === body.id) : null;
    const { svc } = buildService(old, { ...body, secret: '' });
    let secret = typeof body.secret === 'string' && body.secret ? body.secret : null;
    if (!secret && old?.secret) {
      if (JSON.stringify(serviceIdentity(old)) !== JSON.stringify(serviceIdentity(svc))) throw new UserError('The URL, integration or user name changed: enter the secret again to test');
      secret = decryptSecret(serviceSecretHost(old));
    }
    const [check, integ] = await Promise.all([checkService(svc), runIntegration(svc, secret)]);
    for (const k of svcSessions.keys()) if (!old && k.startsWith(svc.id + '|')) svcSessions.delete(k);
    return sendJson(res, 200, { check, stats: integ.stats, error: integ.error });
  }
  const sm = p.match(/^\/api\/admin\/services\/([0-9a-f-]{36})$/);
  if (sm) {
    const old = config.services.find((x) => x.id === sm[1]);
    if (!old) throw Object.assign(new UserError('Service not found'), { status: 404 });
    if (m === 'PUT') {
      const { svc, note } = buildService(old, await readBody(req));
      config.services[config.services.indexOf(old)] = svc;
      pruneIcons();
      saveConfig();
      forgetService(old.id);
      pollService(svc);
      return sendJson(res, 200, { service: publicService(svc), note });
    }
    if (m === 'DELETE') {
      config.services = config.services.filter((x) => x !== old);
      pruneIcons();
      saveConfig();
      forgetService(old.id);
      recheckAlerts();
      log(`Service removed: ${old.name}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- Icons ---
  if (p === '/api/admin/icons/search' && m === 'GET') {
    const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
    if (q.length < 2) return sendJson(res, 200, { names: [] });
    const names = await iconNames();
    const hits = names.filter((n) => n.includes(q)).sort((a, b) => (a.startsWith(q) ? 0 : 1) - (b.startsWith(q) ? 0 : 1) || a.length - b.length).slice(0, 36);
    return sendJson(res, 200, { names: hits });
  }
  const ip = p.match(/^\/api\/admin\/icons\/preview\/([a-z0-9][a-z0-9._-]{0,80})$/);
  if (ip && m === 'GET') {
    // Thumbnail for the icon search: fetched by the server (CSP keeps the browser on this origin)
    let entry = iconPreviewCache.get(ip[1]);
    if (!entry) {
      if (!(await iconNames()).includes(ip[1])) throw Object.assign(new UserError('Unknown icon'), { status: 404 });
      const host = ICON_INDEX_URL.host;
      const r = await httpsRequest(tlsConnect(host, { verify: true }), host, { path: `/gh/homarr-labs/dashboard-icons/png/${ip[1]}.png`, binary: true, maxBytes: 2 << 20 });
      if (r.status !== 200) throw new UserError('Icon not available');
      entry = sanitizeImage(r.body);
      iconPreviewCache.set(ip[1], entry);
      if (iconPreviewCache.size > 300) iconPreviewCache.delete(iconPreviewCache.keys().next().value);
    }
    res.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': entry.data.length, 'Cache-Control': 'private, max-age=86400' });
    return res.end(entry.data);
  }
  if (p === '/api/admin/icons/library' && m === 'POST') {
    const { name } = await readBody(req);
    const icon = await fetchLibraryIcon(String(name || ''));
    saveConfig();
    return sendJson(res, 201, { icon: { id: icon.id, source: icon.source } });
  }
  if (p === '/api/admin/icons' && m === 'POST') {
    const icon = storeIcon(await readRawBody(req, 2 << 20), 'upload');
    saveConfig();
    return sendJson(res, 201, { icon: { id: icon.id, source: icon.source } });
  }

  // --- Documentation (login required even when the dashboard is public) ---
  if (p === '/api/docs' && m === 'GET') return sendJson(res, 200, { docs, auto: await docsAuto(), deletedCount: docsHistory.deleted.length, readOnly: Boolean(session.readOnly) });
  const ds = p.match(/^\/api\/docs\/servers\/([0-9a-f-]{36})$/);
  if (ds && m === 'PUT') {
    findDevice(ds[1]);
    docs.servers[ds[1]] = validateServerDoc(await readBody(req));
    saveDocs();
    return sendJson(res, 200, { server: docs.servers[ds[1]] });
  }
  if (p === '/api/docs/nav' && m === 'PUT') {
    docs.nav = validateDocsNav(await readBody(req));
    saveDocs();
    return sendJson(res, 200, { nav: docs.nav });
  }
  if (p === '/api/docs/network' && m === 'PUT') {
    docs.network = validateNetworkDoc(await readBody(req));
    saveDocs();
    return sendJson(res, 200, { network: docs.network });
  }
  if (p === '/api/docs/pages' && m === 'POST') {
    if (docs.pages.length >= 500) throw new UserError('Too many pages');
    const body = await readBody(req);
    const page = { id: crypto.randomUUID(), ...validatePage(body) };
    docs.pages.push(page);
    placeDocsItem(`page:${page.id}`, typeof body.group === 'string' ? body.group : 'pages');
    saveDocs();
    recordPageVersion(page);
    return sendJson(res, 201, { page, nav: docs.nav });
  }
  // Recently deleted pages
  if (p === '/api/docs/deleted' && m === 'GET') {
    return sendJson(res, 200, { deleted: docsHistory.deleted.map((d) => ({ id: d.id, title: d.title, deletedAt: d.deletedAt, size: d.body.length, versions: docsHistory.pages[d.id]?.length || 0 })) });
  }
  const del = p.match(/^\/api\/docs\/deleted\/([0-9a-f-]{36})(\/restore)?$/);
  if (del) {
    const gone = docsHistory.deleted.find((x) => x.id === del[1]);
    if (!gone) throw Object.assign(new UserError('Not in Recently deleted'), { status: 404 });
    if (del[2] && m === 'POST') {
      if (docs.pages.some((x) => x.id === gone.id)) throw new UserError('That page exists already');
      if (docs.pages.length >= 500) throw new UserError('Too many pages');
      docsHistory.deleted = docsHistory.deleted.filter((x) => x !== gone);
      const page = { id: gone.id, title: gone.title, body: gone.body, updatedAt: Date.now() };
      docs.pages.push(page);
      placeDocsItem(`page:${page.id}`, docs.nav.groups.some((g) => g.items && g.id === gone.group) ? gone.group : 'pages');
      saveDocs();
      recordPageVersion(page, { restoredFrom: 'deleted' });
      return sendJson(res, 200, { page, nav: docs.nav });
    }
    if (!del[2] && m === 'DELETE') {
      docsHistory.deleted = docsHistory.deleted.filter((x) => x !== gone);
      delete docsHistory.pages[gone.id];
      saveDocsHistory();
      return sendJson(res, 200, { ok: true });
    }
  }
  const dh = p.match(/^\/api\/docs\/pages\/([0-9a-f-]{36})\/history(?:\/(\d{1,6})(\/restore)?)?$/);
  if (dh) {
    const page = docs.pages.find((x) => x.id === dh[1]);
    if (!page) throw Object.assign(new UserError('Page not found'), { status: 404 });
    const list = docsHistory.pages[page.id] || [];
    if (!dh[2] && m === 'GET') {
      // pages from before history existed show their current state as the first version
      const versions = list.length ? list : [{ v: 1, at: page.updatedAt || Date.now(), title: page.title, body: page.body }];
      return sendJson(res, 200, { versions: versions.map((x) => ({ v: x.v, at: x.at, title: x.title, size: x.body.length, restoredFrom: x.restoredFrom ?? null })).reverse() });
    }
    const ver = list.find((x) => x.v === Number(dh[2]));
    if (!ver) throw Object.assign(new UserError('That version is no longer kept'), { status: 404 });
    if (!dh[3] && m === 'GET') return sendJson(res, 200, { version: ver });
    if (dh[3] && m === 'POST') {
      Object.assign(page, { title: ver.title, body: ver.body, updatedAt: Date.now() });
      saveDocs();
      recordPageVersion(page, { restoredFrom: ver.v });
      return sendJson(res, 200, { page, nav: docs.nav });
    }
  }
  const dp = p.match(/^\/api\/docs\/pages\/([0-9a-f-]{36})$/);
  if (dp) {
    const page = docs.pages.find((x) => x.id === dp[1]);
    if (!page) throw Object.assign(new UserError('Page not found'), { status: 404 });
    if (m === 'PUT') {
      const body = await readBody(req);
      const prev = { ...page };
      Object.assign(page, validatePage(body));
      delete page.folder; // replaced by menu groups
      if (typeof body.group === 'string') placeDocsItem(`page:${page.id}`, body.group);
      saveDocs();
      recordPageVersion(page, { prev });
      return sendJson(res, 200, { page, nav: docs.nav });
    }
    if (m === 'DELETE') {
      // to Recently deleted, with its history, so it can come back
      if (!docsHistory.pages[page.id]) recordPageVersion(page);
      docsHistory.deleted.unshift({ id: page.id, title: page.title, body: page.body, group: pageGroup(page.id), deletedAt: Date.now() });
      for (const old of docsHistory.deleted.splice(MAX_DELETED)) delete docsHistory.pages[old.id];
      docs.pages = docs.pages.filter((x) => x !== page);
      placeDocsItem(`page:${page.id}`);
      saveDocs();
      saveDocsHistory();
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- Backup ---
  // --- Updates (admin only: versions help an attacker) ---
  if (p === '/api/updates' && m === 'GET') return sendJson(res, 200, { ...updatesPayload(), readOnly: Boolean(session.readOnly) });
  if (p === '/api/admin/updates/check' && m === 'POST') {
    if (!updatesRunning && Date.now() - updatesManualAt < 60000) throw Object.assign(new UserError('Checked less than a minute ago; try again shortly'), { status: 429 });
    updatesManualAt = Date.now();
    await checkUpdates();
    return sendJson(res, 200, updatesPayload());
  }

  // --- Alerts ---
  if (p === '/api/admin/alerts' && m === 'GET') return sendJson(res, 200, alertsStatus());
  if (p === '/api/admin/alerts' && m === 'PUT') {
    const b = await readBody(req);
    const ids = new Set(config.alerts.channels.map((c) => c.id));
    const rules = Object.fromEntries(Object.keys(ALERT_TYPES).map((k) => [k, validateRule(k, b.rules?.[k] ?? config.alerts.rules[k], ids)]));
    const repeatHours = Number(b.settings?.repeatHours ?? 0);
    if (!REPEAT_HOURS.includes(repeatHours)) throw new UserError('Invalid reminder interval');
    config.alerts = { ...config.alerts, rules, settings: { resolved: b.settings?.resolved !== false, repeatHours } };
    saveConfig();
    recheckAlerts();
    log('Alert rules updated');
    return sendJson(res, 200, alertsStatus());
  }
  if (p === '/api/admin/alerts/test' && m === 'POST') {
    // Test before saving: with a newly typed secret, or the stored one if it would go to the same place
    const b = await readBody(req);
    const old = b.id ? config.alerts.channels.find((c) => c.id === b.id) : null;
    if (b.id && !old) throw Object.assign(new UserError('Channel not found'), { status: 404 });
    const c = { id: old?.id || 'new', ...validateChannel({ ...b, type: old?.type || b.type }) };
    let secret = channelSecret(c, b.secret);
    if (!secret && channelNeedsSecret(c)) {
      if (!old?.secret) throw new UserError('Enter the token, password or webhook URL to test');
      if (!sameChannelIdentity(old, c)) throw new UserError('The server, user or certificate changed: enter the password or token again to test');
      secret = decryptSecret(channelHost(old));
    }
    return sendJson(res, 200, await sendToChannel({ ...c, id: null }, testMessage(), { secret, rateLimit: false }));
  }
  if (p === '/api/admin/alerts/channels' && m === 'POST') {
    const b = await readBody(req);
    if (config.alerts.channels.length >= MAX_CHANNELS) throw new UserError(`At most ${MAX_CHANNELS} channels`);
    const c = { id: crypto.randomUUID(), ...validateChannel(b), secret: null };
    const secret = channelSecret(c, b.secret);
    if (channelNeedsSecret(c) && !secret) throw new UserError('Enter the token, password or webhook URL');
    if (secret) c.secret = encryptSecret(channelHost(c), secret);
    config.alerts.channels.push(c);
    for (const r of Object.values(config.alerts.rules)) if (r.enabled) r.channels.push(c.id); // adjust per alert in the table
    saveConfig();
    log(`Alert channel added: ${c.name} (${c.type})`);
    return sendJson(res, 201, { channel: publicChannel(c), status: alertsStatus() });
  }
  const ac = p.match(/^\/api\/admin\/alerts\/channels\/([0-9a-f-]{36})(\/test)?$/);
  if (ac) {
    const old = config.alerts.channels.find((c) => c.id === ac[1]);
    if (!old) throw Object.assign(new UserError('Channel not found'), { status: 404 });
    if (ac[2] && m === 'POST') {
      const r = await sendToChannel(old, testMessage(), { rateLimit: false });
      saveAlertState();
      return sendJson(res, 200, r);
    }
    if (!ac[2] && m === 'PUT') {
      const b = await readBody(req);
      const next = { ...old, ...validateChannel({ ...b, type: old.type }) };
      const secret = channelSecret(next, b.secret);
      let note = null;
      if (secret) next.secret = encryptSecret(channelHost(next), secret);
      else if (!channelNeedsSecret(next)) next.secret = null;
      else if (old.secret && !sameChannelIdentity(old, next)) {
        next.secret = null;
        note = 'The server, user or certificate changed, so the stored password or token was deleted. Enter it again.';
      }
      config.alerts.channels = config.alerts.channels.map((c) => (c.id === old.id ? next : c));
      saveConfig();
      log(`Alert channel updated: ${next.name}`);
      return sendJson(res, 200, { channel: publicChannel(next), note, status: alertsStatus() });
    }
    if (!ac[2] && m === 'DELETE') {
      config.alerts.channels = config.alerts.channels.filter((c) => c.id !== old.id);
      for (const r of Object.values(config.alerts.rules)) r.channels = r.channels.filter((id) => id !== old.id);
      delete alertState.channels[old.id];
      alertsDirty = true;
      saveConfig();
      saveAlertState();
      log(`Alert channel deleted: ${old.name}`);
      return sendJson(res, 200, alertsStatus());
    }
  }

  if (p === '/api/admin/backup' && m === 'GET') return sendJson(res, 200, backupStatus());
  if (p === '/api/admin/backup/settings' && m === 'PUT') {
    const b = await readBody(req);
    const time = String(b.schedule?.time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new UserError('Time must be HH:MM');
    const schedule = { enabled: b.schedule?.enabled === true, time, keep: num(b.schedule?.keep, 1, 100, 'Copies to keep', { int: true }) };
    if (typeof b.passphrase === 'string' && b.passphrase) {
      const problem = backupPassphraseProblem(b.passphrase);
      if (problem) throw new UserError(problem);
      config.backup.passphrase = encryptSecret(passHost(), b.passphrase);
    }
    if (schedule.enabled && !config.backup.passphrase) throw new UserError('Set a backup passphrase to enable automatic backups');
    config.backup.schedule = schedule;
    saveConfig();
    return sendJson(res, 200, backupStatus());
  }
  if (p === '/api/admin/backup/run' && m === 'POST') {
    const entry = await runBackup('manual');
    return sendJson(res, entry.error ? 400 : 200, { entry, status: backupStatus(), error: entry.error });
  }
  if (p === '/api/admin/backup/download' && m === 'POST') {
    const { passphrase } = await readBody(req);
    const problem = backupPassphraseProblem(passphrase);
    if (problem) throw new UserError(problem);
    saveEnergy();
    const data = await encryptBackup(backupBundle(), passphrase);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${backupStamp('-manual')}"`, 'Content-Length': data.length });
    return res.end(data);
  }
  if ((p === '/api/admin/backup/restore' || p === '/api/admin/backup/restore-local') && m === 'POST') {
    let passphrase;
    let buf;
    let opts;
    if (p.endsWith('-local')) {
      const b = await readBody(req);
      if (typeof b.file !== 'string' || !BACKUP_NAME.test(b.file)) throw new UserError('Unknown backup');
      buf = fs.readFileSync(path.join(LOCAL_BACKUP_DIR, b.file));
      passphrase = String(b.passphrase || '');
      opts = { admin: b.admin === true, server: b.server === true };
    } else {
      try {
        passphrase = decodeURIComponent(String(req.headers['x-backup-passphrase'] || ''));
      } catch {
        throw new UserError('Invalid passphrase header');
      }
      opts = { admin: req.headers['x-restore-admin'] === '1', server: req.headers['x-restore-server'] === '1' };
      buf = await readRawBody(req, 512 << 20);
    }
    const bundle = await decryptBackup(buf, passphrase);
    // Safety net: the current state, encrypted with the same passphrase, kept as a local copy
    fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true, mode: 0o700 });
    saveEnergy();
    fs.writeFileSync(path.join(LOCAL_BACKUP_DIR, backupStamp('-pre-restore')), await encryptBackup(backupBundle(), passphrase), { mode: 0o600 });
    await restoreBundle(bundle, opts);
    log(`Restored backup from ${new Date(bundle.createdAt).toISOString()} (${bundle.host})`);
    return sendJson(res, 200, { ok: true, createdAt: bundle.createdAt, host: bundle.host });
  }
  const lb = p.match(/^\/api\/admin\/backup\/local\/(homelab-dashboard-[0-9a-z-]+\.hldb)$/);
  if (lb && BACKUP_NAME.test(lb[1])) {
    const file = path.join(LOCAL_BACKUP_DIR, lb[1]);
    if (!fs.existsSync(file)) throw Object.assign(new UserError('Not found'), { status: 404 });
    if (m === 'DELETE') {
      fs.rmSync(file);
      return sendJson(res, 200, backupStatus());
    }
    if (m === 'GET') {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${lb[1]}"`, 'Content-Length': data.length });
      return res.end(data);
    }
  }
  if (p === '/api/admin/backup/keyscan' && m === 'POST') {
    const b = await readBody(req);
    const d = validateDestination({ type: 'rsync', host: b.host, port: b.port, user: 'x', path: 'x' });
    return sendJson(res, 200, await sshKeyscan(d.host, d.port));
  }
  if (p === '/api/admin/backup/destinations' && m === 'POST') {
    const b = await readBody(req);
    const d = { id: crypto.randomUUID(), ...validateDestination(b), secret: null };
    if (d.type === 's3' && b.secret) d.secret = encryptSecret(destHost(d), String(b.secret));
    config.backup.destinations.push(d);
    saveConfig();
    return sendJson(res, 201, { destination: { ...d, secret: undefined, hasSecret: Boolean(d.secret) }, status: backupStatus() });
  }
  const dd = p.match(/^\/api\/admin\/backup\/destinations\/([0-9a-f-]{36})(\/test|\/sshkey)?$/);
  if (dd) {
    const old = config.backup.destinations.find((x) => x.id === dd[1]);
    if (!old) throw Object.assign(new UserError('Destination not found'), { status: 404 });
    if (dd[2] === '/sshkey' && m === 'POST') {
      if (old.type !== 'rsync') throw new UserError('Only for rsync destinations');
      const key = await generateSshKey(`homelab-dashboard@${os.hostname()}`);
      old.publicKey = key.publicKey;
      old.secret = encryptSecret(destHost(old), key.privateKey);
      saveConfig();
      return sendJson(res, 200, { publicKey: key.publicKey, status: backupStatus() });
    }
    if (dd[2] === '/test' && m === 'POST') {
      try {
        if (old.type === 'folder') {
          const dir = path.join(BACKUP_BASE, old.folder || '');
          if (!fs.existsSync(BACKUP_BASE)) throw new UserError(`${BACKUP_BASE} does not exist (re-run the installer, then mount your share there)`);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const probe = path.join(dir, `.write-test-${crypto.randomBytes(4).toString('hex')}`);
          fs.writeFileSync(probe, 'ok');
          fs.rmSync(probe);
        } else if (old.type === 's3') {
          const secret = secretOrNull(destHost(old));
          if (!secret) throw new UserError('No secret access key set');
          await s3List(old, secret);
        } else {
          fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true, mode: 0o700 });
          await rsyncPush(old, LOCAL_BACKUP_DIR, { dryRun: true });
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e instanceof UserError ? e.message : safeErrorMessage(e, null) });
      }
    }
    if (!dd[2] && m === 'PUT') {
      const b = await readBody(req);
      const next = { ...old, ...validateDestination({ ...b, type: old.type, publicKey: old.publicKey }) };
      let note = null;
      if (old.type === 's3') {
        const changed = ['endpoint', 'accessKey', 'tlsMode', 'fingerprint'].some((k) => next[k] !== old[k]);
        if (b.secret) next.secret = encryptSecret(destHost(next), String(b.secret));
        else if (changed && old.secret) {
          next.secret = null;
          note = 'The endpoint, access key or certificate changed, so the stored secret was deleted. Enter it again.';
        }
      }
      if (old.type === 'rsync') {
        if (next.host !== old.host || next.port !== old.port) {
          if (next.knownHosts === old.knownHosts) next.knownHosts = ''; // a different server needs its own pinned host key
        }
        // the SSH key is bound to the destination id, not to the host: keep it decryptable
        next.secret = old.secret ? encryptSecret(destHost(next), decryptSecret(destHost(old))) : null;
      }
      config.backup.destinations[config.backup.destinations.indexOf(old)] = next;
      saveConfig();
      return sendJson(res, 200, { destination: { ...next, secret: undefined, hasSecret: Boolean(next.secret) }, note, status: backupStatus() });
    }
    if (!dd[2] && m === 'DELETE') {
      config.backup.destinations = config.backup.destinations.filter((x) => x !== old);
      saveConfig();
      return sendJson(res, 200, backupStatus());
    }
  }

  if (p === '/api/admin/fingerprint' && m === 'POST') {
    // Connects and reads the certificate only; no application data is sent.
    const body = await readBody(req);
    if (!HOST_TYPES[body.type]) throw new UserError('Invalid host type');
    const address = normalizeAddress(body.address, body.type);
    if (body.type === 'synology') {
      // SNMPv3 discovery: unauthenticated, carries no user name or credentials
      const { host, port } = splitAddress(address);
      const d = await snmpDiscover(host, port);
      return sendJson(res, 200, { address, engineId: formatFingerprint(d.engineId.toString('hex')), boots: d.boots, uptime: d.time });
    }
    const sock = await tlsConnect(address, { verify: false, timeoutMs: 10000 });
    const cert = sock.getPeerCertificate();
    const caTrusted = sock.authorized;
    sock.destroy();
    if (!cert || !cert.raw) throw new UserError('No certificate presented');
    return sendJson(res, 200, {
      address,
      fingerprint: formatFingerprint(crypto.createHash('sha256').update(cert.raw).digest('hex')),
      subject: cert.subject?.CN || null,
      issuer: cert.issuer?.CN || cert.issuer?.O || null,
      validFrom: cert.valid_from,
      validTo: cert.valid_to,
      caTrusted,
    });
  }

  if (p === '/api/admin/password' && m === 'POST') {
    const body = await readBody(req);
    const admin = readAdmin();
    if (!(await verifyPassword(String(body.current || ''), admin.hash))) {
      registerFailure('ip:' + (req.socket.remoteAddress || '?'), 5);
      throw new UserError('Current password is incorrect');
    }
    const problem = passwordProblem(body.password);
    if (problem) throw new UserError(problem);
    const changedAt = Date.now();
    writeJsonAtomic(ADMIN_FILE, { username: admin.username, hash: await hashPassword(body.password), changedAt });
    for (const id of sessions.keys()) if (id !== session.id) sessions.delete(id);
    const here = rememberedFor(req);
    for (const r of [...remembered.values()]) if (r !== here) forgetDevice(r);
    if (here) here.pw = changedAt;
    saveRemembered();
    log('Admin password changed; other sessions and remembered devices signed out');
    return sendJson(res, 200, { ok: true });
  }

  sendError(res, 404, 'Not found');
}

async function handle(req, res) {
  securityHeaders(req, res);
  if (!hostAllowed(req.headers.host)) return sendError(res, 421, 'Unknown host; add it to ALLOWED_HOSTS');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendError(res, 400, 'Bad request');
  }
  const p = url.pathname;
  if (req.method !== 'GET' && !sameOrigin(req)) return sendError(res, 403, 'Cross-origin request blocked');
  const session = getSession(req);
  const viewer = session ? null : getViewer(req); // a remembered device: view only
  const seer = session || viewer;
  const sees = Boolean(seer || config.settings.dashboard.public);

  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url, session, viewer);
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

    if (p === '/login') {
      if (session) return redirect(res, '/');
      // A remembered device comes here when something needs the password; it's already remembered
      return sendPage(res, 'login.html', seer, viewer ? (h) => h.replace('id="reauth" hidden', 'id="reauth"').replace('id="remember-row"', 'id="remember-row" hidden') : undefined);
    }
    if (p === '/') {
      if (!sees) return redirect(res, '/login');
      return sendPage(res, 'dashboard.html', seer);
    }
    if (p === '/admin') return session ? sendPage(res, 'admin.html', session) : redirect(res, '/login?next=admin');
    if (p === '/services') {
      if (!sees) return redirect(res, '/login?next=services');
      return sendPage(res, 'services.html', seer);
    }
    if (p === '/docs') return seer ? sendPage(res, 'docs.html', seer) : redirect(res, '/login?next=docs');
    if (p === '/updates') return seer ? sendPage(res, 'updates.html', seer) : redirect(res, '/login?next=updates');
    if (p === '/energy') {
      if (!sees) return redirect(res, '/login?next=energy');
      return sendPage(res, 'energy.html', seer);
    }
    // The installable app: manifest, service worker and its offline screen hold no data
    if (p === '/manifest.webmanifest') {
      const body = Buffer.from(JSON.stringify(manifest(sees)));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Content-Length': body.length });
      return res.end(body);
    }
    if (p === '/sw.js') return sendStatic(res, '/sw.js');
    if (p === '/offline') return sendPage(res, 'offline.html', null);
    const im = p.match(/^\/media\/icon\/([0-9a-f]{32})$/);
    if (im) {
      const rec = config.icons.find((i) => i.id === im[1]);
      if (!rec) return sendError(res, 404, 'Not found');
      if (!backgroundVisible(seer)) return sendError(res, 401, 'Login required');
      const data = fs.readFileSync(path.join(ICON_DIR, rec.id));
      res.writeHead(200, { 'Content-Type': rec.mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(data);
    }
    if (p === '/appearance.css') {
      const css = Buffer.from(appearanceCss(seer));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': css.length });
      return res.end(css);
    }
    const mm = p.match(/^\/media\/bg\/([0-9a-f]{32})$/);
    if (mm) {
      const rec = config.backgrounds.find((b) => b.id === mm[1]);
      if (!rec) return sendError(res, 404, 'Not found');
      if (!backgroundVisible(seer)) return sendError(res, 401, 'Login required');
      const data = fs.readFileSync(path.join(BACKGROUND_DIR, rec.id));
      // Immutable: ids are random and never reused
      res.writeHead(200, { 'Content-Type': rec.mime, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(data);
    }
    if (STATIC[p] && p.startsWith('/static/')) {
      const allowed = PUBLIC_ASSETS.has(p) || session || (viewer && p !== '/static/js/admin.js') || (DASHBOARD_ASSETS.has(p) && config.settings.dashboard.public);
      return allowed ? sendStatic(res, p) : sendError(res, 401, 'Login required');
    }
    if (p === '/favicon.ico') return sendStatic(res, '/static/favicon.svg');
    if (p === '/ca.crt') {
      // The local CA certificate (public), for importing on phones and PCs
      if (!tlsInfo?.ca) return sendError(res, 404, 'No local CA');
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="homelab-dashboard-ca.crt"', 'Content-Length': tlsInfo.ca.length });
      return res.end(tlsInfo.ca);
    }
    sendError(res, 404, 'Not found');
  } catch (e) {
    if (e instanceof UserError) return sendError(res, e.status || 400, e.message);
    log('Request error:', e && e.stack ? e.stack : e);
    if (!res.headersSent) sendError(res, 500, 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// Alerts
//
// After each poll the current problems ("conditions") are compared with the active alerts. A
// condition that lasts longer than its rule's delay is sent to the channels chosen for that rule,
// and again when it clears. Channels: ntfy, Telegram, Discord webhooks and e-mail (SMTP). Their
// tokens and passwords are encrypted like device credentials, bound to where they are sent, and
// never returned by the API. Hosts without fresh data keep their alerts as they are, so a NAS that
// stops answering doesn't "resolve" its degraded pool.

const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const TELEGRAM_API = process.env.TELEGRAM_API_URL || 'https://api.telegram.org'; // overridable for the tests
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com', ...String(process.env.DISCORD_WEBHOOK_HOSTS || '').split(',').filter(Boolean)];
const CHANNEL_TYPES = { ntfy: 'ntfy', telegram: 'Telegram', discord: 'Discord', email: 'E-mail (SMTP)' };
const ALERT_TYPES = {
  offline: { label: 'Device offline', hint: 'A connection stops answering, a Proxmox node goes offline or a UniFi device disconnects.', delay: 5 },
  service: { label: 'Service down', hint: 'A service status check fails.', delay: 5 },
  hardware: { label: 'Hardware fault', hint: 'Power supplies, fans and system health (iDRAC, Synology).', delay: 0 },
  storage: { label: 'Storage problem', hint: 'Degraded or crashed pools and failing disks.', delay: 0 },
  temperature: {
    label: 'High temperature',
    hint: 'iDRAC sensors use their own warning limits; other sensors use these.',
    delay: 5,
    params: { diskC: { label: 'Disks at', unit: '°C', min: 30, max: 90, def: 55 }, otherC: { label: 'Other sensors at', unit: '°C', min: 30, max: 120, def: 80 } },
  },
  space: { label: 'Storage almost full', hint: 'A pool or volume is fuller than the limit.', delay: 0, params: { pct: { label: 'Full at', unit: '%', min: 50, max: 99, def: 90 } } },
  nas: { label: 'TrueNAS alerts', hint: 'New critical alerts reported by TrueNAS.', delay: 0, params: { warnings: { label: 'Warnings too', type: 'bool', def: false } } },
  power: { label: 'High power draw', hint: 'The total measured draw stays above the limit.', delay: 10, off: true, params: { watts: { label: 'Above', unit: 'W', min: 10, max: 50000, def: 600 } } },
  backup: { label: 'Backup failed', hint: 'An automatic backup or one of its destinations failed.', delay: null },
};
const SEVERITY_RANK = { warning: 1, critical: 2 };
const REPEAT_HOURS = [0, 1, 4, 12, 24];
const MAX_CHANNELS = 20;
const CHANNEL_RATE = 30; // messages per channel per hour
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function validateRule(type, b, channelIds) {
  const t = ALERT_TYPES[type];
  const out = {
    enabled: b?.enabled === true,
    delay: t.delay === null ? null : num(b?.delay ?? t.delay, 0, 1440, `${t.label}: delay`, { int: true }),
    channels: [...new Set((Array.isArray(b?.channels) ? b.channels : []).filter((id) => channelIds.has(id)))],
  };
  for (const [k, d] of Object.entries(t.params || {})) out[k] = d.type === 'bool' ? b?.[k] === true : num(b?.[k] ?? d.def, d.min, d.max, `${t.label}: ${d.label.toLowerCase()}`, { int: true });
  return out;
}

function defaultRule(type) {
  const t = ALERT_TYPES[type];
  return validateRule(type, { enabled: !t.off }, new Set());
}

// From the config file or a backup: unknown or broken entries fall back to the defaults
function normalizeAlerts(raw, channels = Array.isArray(raw?.channels) ? raw.channels.filter((c) => UUID.test(c?.id) && CHANNEL_TYPES[c.type]) : []) {
  const ids = new Set(channels.map((c) => c.id));
  const rules = {};
  for (const k of Object.keys(ALERT_TYPES)) {
    try {
      rules[k] = raw?.rules?.[k] ? validateRule(k, raw.rules[k], ids) : defaultRule(k);
    } catch {
      rules[k] = defaultRule(k);
    }
  }
  const rh = Number(raw?.settings?.repeatHours);
  return { channels, rules, settings: { resolved: raw?.settings?.resolved !== false, repeatHours: REPEAT_HOURS.includes(rh) ? rh : 0 } };
}

function validateChannel(b) {
  const type = b.type;
  if (!CHANNEL_TYPES[type]) throw new UserError('Unknown channel type');
  const out = { type, name: str(b.name, 48, 'Name') || CHANNEL_TYPES[type], enabled: b.enabled !== false };
  if (type === 'ntfy') {
    const u = parseServiceUrl(str(b.url, 300, 'Server') || 'https://ntfy.sh');
    out.url = u.href;
    out.topic = str(b.topic, 64, 'Topic', { required: true });
    if (!/^[A-Za-z0-9_-]+$/.test(out.topic)) throw new UserError('Topic: letters, digits, - and _ only');
    out.auth = ['token', 'basic'].includes(b.auth) ? b.auth : 'none';
    out.username = out.auth === 'basic' ? str(b.username, 64, 'User name', { required: true }) : '';
    out.tlsMode = u.https && b.tlsMode === 'pin' ? 'pin' : 'verify';
    out.fingerprint = out.tlsMode === 'pin' ? normalizeFingerprint(b.fingerprint) : '';
  }
  if (type === 'telegram') {
    out.chatId = str(b.chatId, 40, 'Chat ID', { required: true });
    if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(out.chatId)) throw new UserError('Chat ID: a number (e.g. 123456789 or -100…) or @channelname');
  }
  if (type === 'email') {
    out.host = str(b.host, 253, 'SMTP server', { required: true });
    if (!net.isIP(out.host) && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(out.host)) throw new UserError('Invalid SMTP server');
    out.security = ['tls', 'starttls', 'none'].includes(b.security) ? b.security : 'starttls';
    out.port = num(b.port || { tls: 465, starttls: 587, none: 25 }[out.security], 1, 65535, 'Port', { int: true });
    out.username = str(b.username, 254, 'User name');
    if (out.security === 'none' && out.username) throw new UserError('Logging in needs TLS or STARTTLS, so the password is never sent unencrypted');
    out.from = str(b.from, 254, 'From', { required: true });
    out.to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to ?? '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))];
    if (!out.to.length || out.to.length > 10) throw new UserError('Enter 1 to 10 recipients');
    for (const a of [out.from, ...out.to]) if (a.length > 254 || !EMAIL_RE.test(a)) throw new UserError(`Invalid e-mail address: ${a.slice(0, 80)}`);
    out.tlsMode = out.security !== 'none' && b.tlsMode === 'pin' ? 'pin' : 'verify';
    out.fingerprint = out.tlsMode === 'pin' ? normalizeFingerprint(b.fingerprint) : '';
  }
  return out;
}

function parseDiscordWebhook(s) {
  let u = null;
  try {
    u = new URL(s);
  } catch {
    /* handled below */
  }
  if (!u || u.protocol !== 'https:' || !DISCORD_HOSTS.includes(u.host) || u.username || u.password || u.search || !/^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}$/.test(u.pathname))
    throw new UserError('Paste the whole webhook URL (https://discord.com/api/webhooks/…)');
  return { url: `https://${u.host}`, path: u.pathname };
}

const channelNeedsSecret = (c) => (c.type === 'ntfy' ? c.auth !== 'none' : c.type === 'email' ? Boolean(c.username) : true);

function channelSecret(c, s) {
  const v = validateSecret(s);
  if (!v || !channelNeedsSecret(c)) return null;
  if (c.type === 'telegram' && !/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/.test(v)) throw new UserError('That does not look like a bot token (123456789:AA…)');
  if (c.type === 'discord') parseDiscordWebhook(v);
  return v;
}

// Where the secret is sent: changing any of this without re-entering it deletes the stored one
function channelIdentity(c) {
  const address = c.type === 'ntfy' ? c.url : c.type === 'email' ? `${c.security}://${c.host}:${c.port}` : c.type === 'telegram' ? TELEGRAM_API : 'discord';
  const username = c.type === 'ntfy' ? `${c.auth}:${c.username || ''}` : c.type === 'email' ? c.username : '';
  return { id: c.id, type: `alert:${c.type}`, address, username, tlsMode: c.tlsMode || '', fingerprint: c.fingerprint || '' };
}
const channelHost = (c) => ({ ...channelIdentity(c), secret: c.secret });
const sameChannelIdentity = (a, b) => JSON.stringify(channelIdentity(a)) === JSON.stringify(channelIdentity(b));

// --- Sending ---

async function checkedSend(request, label, errorOf) {
  const r = await request;
  if (r.status >= 200 && r.status < 300) return;
  const why = errorOf(r);
  throw new UserError(`${label}: HTTP ${r.status}${why ? ` (${String(why).slice(0, 160)})` : ''}`);
}

const SEVERITY_ICON = { critical: '🔴', warning: '🟠', resolved: '✅', test: '🔔' };

function sendNtfy(c, secret, m) {
  const headers = {};
  if (c.auth === 'token') headers.Authorization = `Bearer ${secret}`;
  if (c.auth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${c.username}:${secret}`).toString('base64')}`;
  const body = JSON.stringify({
    topic: c.topic,
    title: `${m.site}: ${m.title}`.slice(0, 250),
    message: m.text || m.title,
    priority: { critical: 5, warning: 4 }[m.severity] || 3,
    tags: [{ critical: 'rotating_light', warning: 'warning', resolved: 'white_check_mark' }[m.severity] || 'bell'],
  });
  return checkedSend(connRequest({ url: c.url, tlsMode: c.tlsMode, fingerprint: c.fingerprint }, '/', { method: 'POST', headers, body, full: true }), 'ntfy', (r) => r.json?.error);
}

function sendTelegram(c, token, m) {
  const text = `${SEVERITY_ICON[m.severity] || ''} ${m.title}${m.text ? `\n${m.text}` : ''}\n— ${m.site}`.trim().slice(0, 4000);
  return checkedSend(connRequest({ url: TELEGRAM_API, tlsMode: 'verify' }, `/bot${token}/sendMessage`, {
    method: 'POST', body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }), full: true,
  }), 'Telegram', (r) => r.json?.description);
}

function sendDiscord(c, webhook, m) {
  const hook = parseDiscordWebhook(webhook);
  const body = JSON.stringify({
    username: m.site.slice(0, 80),
    allowed_mentions: { parse: [] }, // names and messages from devices can't ping anyone
    embeds: [{ title: m.title.slice(0, 256), description: m.text ? m.text.slice(0, 4000) : undefined, color: { critical: 0xd03b3b, warning: 0xfab219, resolved: 0x0ca30c }[m.severity] ?? 0x2a78d6, timestamp: new Date().toISOString() }],
  });
  return checkedSend(connRequest({ url: hook.url, tlsMode: 'verify' }, hook.path, { method: 'POST', body, full: true }), 'Discord', (r) => r.json?.message);
}

// RFC 2047 encoded words for non-ASCII header text, folded so each stays short
function mimeHeader(s) {
  const clean = String(s).replace(/[\r\n\t]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length < 900) return clean;
  const words = [];
  let cur = '';
  for (const ch of clean) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

function emailMessage(c, m) {
  const body = `${m.title}\n\n${m.text ? `${m.text}\n\n` : ''}— ${m.site}\n`.replace(/\r?\n/g, '\r\n');
  return [
    `From: ${mimeHeader(m.site)} <${c.from}>`,
    `To: ${c.to.join(', ')}`,
    `Subject: ${mimeHeader(`[${m.site}] ${m.title}`.slice(0, 200))}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@homelab-dashboard>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    Buffer.from(body).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}

// Minimal SMTP client: implicit TLS or STARTTLS (required, never downgraded), AUTH PLAIN/LOGIN.
// The certificate (CA or pinned fingerprint) is checked before the login is sent.
async function sendEmail(c, password, m) {
  const address = net.isIPv6(c.host) ? `[${c.host}]:${c.port}` : `${c.host}:${c.port}`;
  const pin = c.tlsMode === 'pin' ? c.fingerprint : null;
  let sock = c.security === 'tls' ? await tlsConnect(address, { pin, verify: true, alpn: null }) : await plainConnect(c.host, c.port, 15000);
  const lines = [];
  let buf = '';
  let failed = null;
  let wake = null;
  const onData = (d) => {
    buf += d.toString('latin1');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      lines.push(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    if (buf.length > 65536 || lines.length > 500) failed ||= new UserError('SMTP: reply too long');
    wake?.();
  };
  const onError = (e) => {
    failed ||= friendlyNetError(e);
    wake?.();
  };
  const onClose = () => {
    failed ||= new UserError('SMTP: the server closed the connection');
    wake?.();
  };
  const attach = (s) => s.on('data', onData).on('error', onError).on('close', onClose);
  const detach = (s) => s.off('data', onData).off('error', onError).off('close', onClose);
  const reply = () => new Promise((resolve, reject) => {
    wake = () => {
      const end = lines.findIndex((l) => /^\d{3}( |$)/.test(l));
      if (end >= 0) {
        wake = null;
        const all = lines.splice(0, end + 1);
        return resolve({ code: Number(all[end].slice(0, 3)), text: all.map((l) => l.slice(4)).join('\n') });
      }
      if (failed) {
        wake = null;
        reject(failed);
      }
    };
    wake();
  });
  const expect = async (prefix) => {
    const r = await reply();
    if (!String(r.code).startsWith(prefix)) throw new UserError(`SMTP: ${r.code} ${r.text.split('\n')[0].slice(0, 160)}`);
    return r;
  };
  const cmd = (line, prefix) => {
    sock.write(`${line}\r\n`);
    return expect(prefix);
  };
  const helo = /^[A-Za-z0-9.-]{1,253}$/.test(os.hostname()) ? os.hostname() : 'homelab-dashboard';
  try {
    attach(sock);
    await expect('2');
    let ehlo = await cmd(`EHLO ${helo}`, '250');
    if (c.security === 'starttls') {
      if (!/^STARTTLS$/im.test(ehlo.text)) throw new UserError('The server does not offer STARTTLS; nothing was sent');
      await cmd('STARTTLS', '220');
      detach(sock);
      sock = await tlsConnect(address, { pin, verify: true, alpn: null, socket: sock });
      attach(sock);
      ehlo = await cmd(`EHLO ${helo}`, '250');
    }
    if (c.username) {
      const methods = (/^AUTH[ =](.*)$/im.exec(ehlo.text)?.[1] || '').toUpperCase().split(/\s+/);
      if (methods.includes('PLAIN')) await cmd(`AUTH PLAIN ${Buffer.from(`\0${c.username}\0${password}`).toString('base64')}`, '235');
      else if (methods.includes('LOGIN')) {
        await cmd('AUTH LOGIN', '334');
        await cmd(Buffer.from(c.username).toString('base64'), '334');
        await cmd(Buffer.from(password).toString('base64'), '235');
      } else throw new UserError('The server offers no supported login method (PLAIN or LOGIN)');
    }
    await cmd(`MAIL FROM:<${c.from}>`, '250');
    for (const to of c.to) await cmd(`RCPT TO:<${to}>`, '25');
    await cmd('DATA', '354');
    await cmd(`${emailMessage(c, m).replace(/^\./gm, '..')}\r\n.`, '250');
    sock.write('QUIT\r\n');
  } finally {
    detach(sock);
    sock.on('error', () => {});
    sock.end();
    setTimeout(() => sock.destroy(), 2000).unref();
  }
}

const CHANNEL_SENDERS = { ntfy: sendNtfy, telegram: sendTelegram, discord: sendDiscord, email: sendEmail };
const channelSends = new Map(); // channel id -> send times in the last hour (rate limit)

// `secret` overrides the stored one (testing a channel before it is saved)
async function sendToChannel(c, m, { secret, rateLimit = true } = {}) {
  const now = Date.now();
  const recent = (channelSends.get(c.id) || []).filter((t) => now - t < 3600e3);
  let plain = secret ?? null;
  let res;
  try {
    if (rateLimit && recent.length >= CHANNEL_RATE) throw new UserError(`Skipped: more than ${CHANNEL_RATE} messages in the last hour`);
    if (secret === undefined && channelNeedsSecret(c)) plain = c.secret ? decryptSecret(channelHost(c)) : null;
    if (channelNeedsSecret(c) && !plain) throw new UserError('No token or password stored; edit the channel');
    await withTimeout(CHANNEL_SENDERS[c.type](c, plain, m), 30000, 'Sending');
    recent.push(now);
    res = { ok: true };
  } catch (e) {
    res = { ok: false, error: safeErrorMessage(e instanceof UserError ? e : new UserError('Sending failed'), plain) };
  }
  if (c.id) {
    channelSends.set(c.id, recent);
    alertState.channels[c.id] = { at: now, ...res };
    alertsDirty = true;
  }
  return res;
}

function duration(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${Math.floor(h / 24)} days`;
}

function alertMessage(events) {
  const site = config.settings.dashboard.title;
  const head = (e) => `${{ reminder: 'Still active: ', resolved: 'Resolved: ' }[e.event] || ''}${e.title}`;
  if (events.length === 1) {
    const e = events[0];
    const text = e.event === 'resolved' ? `Cleared after ${duration(Date.now() - e.since)}.` : e.event === 'reminder' ? `Active for ${duration(Date.now() - e.since)}. ${e.detail || ''}` : e.detail || '';
    return { site, severity: e.event === 'resolved' ? 'resolved' : e.severity, title: head(e), text: text.trim() };
  }
  const open = events.filter((e) => e.event !== 'resolved');
  const resolved = events.length - open.length;
  return {
    site,
    severity: open.some((e) => e.severity === 'critical') ? 'critical' : open.length ? 'warning' : 'resolved',
    title: [open.length && `${open.length} alert${open.length === 1 ? '' : 's'}`, resolved && `${resolved} resolved`].filter(Boolean).join(', '),
    text: events.slice(0, 20).map((e) => `• ${e.event === 'resolved' ? '' : `[${e.severity === 'critical' ? 'Critical' : 'Warning'}] `}${head(e)}${e.detail && e.event !== 'resolved' ? ` (${e.detail})` : ''}`).join('\n')
      + (events.length > 20 ? `\n…and ${events.length - 20} more` : ''),
  };
}

const testMessage = () => ({ site: config.settings.dashboard.title, severity: 'test', title: 'Test notification', text: `Alerts from ${config.settings.dashboard.title} will arrive here.` });

// --- State and evaluation ---

let alertState = { active: {}, log: [], channels: {} };
let alertsDirty = false;
let alertsRunning = false;
let alertsAgain = false; // a check was asked for while one was running

function loadAlertState() {
  const s = readJson(ALERTS_FILE, null);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  alertState = { active: obj(s?.active), log: Array.isArray(s?.log) ? s.log.slice(0, 200) : [], channels: obj(s?.channels) };
}

function saveAlertState() {
  if (!alertsDirty) return;
  writeJsonAtomic(ALERTS_FILE, alertState);
  alertsDirty = false;
}

// Everything that is wrong right now: Map of key -> { type, severity, title, detail, owner, fromData }
// `all`: for the dashboard's "needs attention" list, every kind counts whether or not notifications
// are on (except the power limit, which only exists when you set it).
function alertConditions(all = false) {
  const rules = config.alerts.rules;
  const out = new Map();
  const add = (type, id, severity, title, detail, owner, fromData = true, device = null) => {
    if (all ? type !== 'power' || rules.power.enabled : rules[type]?.enabled) out.set(`${type}:${id}`, { type, severity, title: String(title).slice(0, 200), detail: String(detail || '').slice(0, 300), owner, fromData, device });
  };
  // Over a limit; once active it only clears below the limit minus a margin, so it doesn't flap
  const over = (type, id, value, limit, margin) => typeof value === 'number' && (value >= limit || (Boolean(alertState.active[`${type}:${id}`]) && value > limit - margin));
  const { temperature: temp, space } = rules;
  const pct = (used, size) => (size ? (100 * used) / size : null);
  for (const h of config.hosts) {
    const r = results.get(h.id);
    const name = config.devices.find((d) => d.id === h.deviceId)?.name || h.name;
    if (r?.ok === false) add('offline', h.id, 'critical', `${name}: ${HOST_TYPES[h.type].label} not answering`, r.error, h.id, false);
    if (!r?.ok) continue;
    const d = r.data;
    const own = h.id;
    if (h.type === 'idrac') {
      let specific = false;
      for (const p of d.psus) {
        if (p.state === 'Absent' || !['Critical', 'Warning'].includes(p.health)) continue;
        specific = true;
        add('hardware', `${h.id}:psu:${p.name}`, p.health === 'Critical' ? 'critical' : 'warning', `${name}: ${p.name} ${p.health.toLowerCase()}`, 'Power supply', own);
      }
      for (const f of d.fans) {
        if (!['Critical', 'Warning'].includes(f.health)) continue;
        specific = true;
        add('hardware', `${h.id}:fan:${f.name}`, f.health === 'Critical' ? 'critical' : 'warning', `${name}: ${f.name} ${f.health.toLowerCase()}`, f.rpm != null ? `${f.rpm} rpm` : 'Fan', own);
      }
      if (d.health === 'Critical' && !specific) add('hardware', `${h.id}:system`, 'critical', `${name}: iDRAC reports critical health`, '', own);
      for (const t of d.temps) {
        const limit = t.warn ?? temp.otherC;
        if (over('temperature', `${h.id}:${t.name}`, t.celsius, limit, 3))
          add('temperature', `${h.id}:${t.name}`, t.crit && t.celsius >= t.crit ? 'critical' : 'warning', `${name}: ${t.name} at ${t.celsius} °C`, `Limit ${limit} °C${t.crit ? `, critical at ${t.crit} °C` : ''}`, own);
      }
    } else if (h.type === 'proxmox') {
      // a connection that represents one node only reports that node, so a cluster isn't reported twice
      const dev = config.devices.find((x) => x.id === h.deviceId);
      const mine = dev ? effectiveNode(h, dev) : null;
      for (const n of d.nodes) if (n.status !== 'online' && (!mine || n.name === mine)) add('offline', `${h.id}:node:${n.name}`, 'critical', `${name}: Proxmox node ${n.name} is ${n.status || 'offline'}`, '', own);
    } else if (h.type === 'truenas') {
      for (const p of d.pools) {
        if (!p.healthy) add('storage', `${h.id}:pool:${p.name}`, 'critical', `${name}: pool ${p.name} is ${p.status}`, p.detail || '', own);
        const f = pct(p.allocated, p.size);
        if (over('space', `${h.id}:${p.name}`, f, space.pct, 2)) add('space', `${h.id}:${p.name}`, 'warning', `${name}: pool ${p.name} is ${Math.round(f)} % full`, `Limit ${space.pct} %`, own);
      }
      for (const a of d.alerts) {
        const crit = ['CRITICAL', 'ERROR', 'ALERT', 'EMERGENCY'].includes(a.level);
        if (crit || (rules.nas.warnings && a.level === 'WARNING')) add('nas', `${h.id}:${sha256hex(a.text).slice(0, 16)}`, crit ? 'critical' : 'warning', `${name}: TrueNAS ${a.level.toLowerCase()}`, a.text, own);
      }
    } else if (h.type === 'synology') {
      const s = d.system;
      if (s.status === 'Failed') add('hardware', `${h.id}:system`, 'critical', `${name}: system status failed`, '', own);
      if (s.systemFan === 'Failed') add('hardware', `${h.id}:fan:system`, 'critical', `${name}: system fan failed`, '', own);
      if (s.cpuFan === 'Failed') add('hardware', `${h.id}:fan:cpu`, 'critical', `${name}: CPU fan failed`, '', own);
      if (s.powerStatus === 'Failed') add('hardware', `${h.id}:power`, 'critical', `${name}: power supply failed`, '', own);
      if (over('temperature', `${h.id}:system`, s.temp, temp.otherC, 3)) add('temperature', `${h.id}:system`, 'warning', `${name}: system at ${s.temp} °C`, `Limit ${temp.otherC} °C`, own);
      for (const x of d.disks) {
        const crit = ['Critical', 'Failing'].includes(x.health) || x.status === 'Crashed';
        if (crit || x.health === 'Warning') add('storage', `${h.id}:disk:${x.id}`, crit ? 'critical' : 'warning', `${name}: ${x.id} ${x.status === 'Crashed' ? 'crashed' : x.health.toLowerCase()}`, x.model || '', own);
        if (over('temperature', `${h.id}:disk:${x.id}`, x.temp, temp.diskC, 3)) add('temperature', `${h.id}:disk:${x.id}`, 'warning', `${name}: ${x.id} at ${x.temp} °C`, `Limit ${temp.diskC} °C`, own);
      }
      for (const p of d.pools) if (!p.healthy) add('storage', `${h.id}:pool:${p.name}`, /Crashed/.test(p.status) ? 'critical' : 'warning', `${name}: ${p.name} is ${p.status}`, '', own);
      for (const v of d.volumes) {
        const f = pct(v.used, v.size);
        if (over('space', `${h.id}:${v.name}`, f, space.pct, 2)) add('space', `${h.id}:${v.name}`, 'warning', `${name}: ${v.name.replace('/', '')} is ${Math.round(f)} % full`, `Limit ${space.pct} %`, own);
      }
    } else if (h.type === 'unifi') {
      for (const x of d.devices) {
        const dev = config.devices.find((v) => v.unifi?.hostId === h.id && v.unifi.mac === x.mac);
        if (dev?.hidden) continue; // deleted in Admin
        const dn = dev?.name || x.name;
        if (!x.online) add('offline', `${h.id}:${x.mac}`, 'critical', `${dn} is ${String(x.state || 'offline').toLowerCase()}`, 'Reported by UniFi', own, true, dev?.id);
        const t = x.temps.length ? Math.max(...x.temps.map((v) => v.value)) : null;
        if (over('temperature', `${h.id}:${x.mac}`, t, temp.otherC, 3)) add('temperature', `${h.id}:${x.mac}`, 'warning', `${dn} at ${t} °C`, `Limit ${temp.otherC} °C`, own, true, dev?.id);
      }
    }
  }
  for (const svc of config.services) {
    const c = serviceResults.get(svc.id)?.check;
    if (c && !c.up) add('service', svc.id, 'critical', `${svc.name} is down`, c.error || (c.code ? `HTTP ${c.code}` : ''), svc.id, false);
  }
  const w = measuredWatts().total;
  if (over('power', 'total', w, rules.power.watts, rules.power.watts * 0.05)) add('power', 'total', 'warning', `Power draw ${Math.round(w)} W`, `Limit ${rules.power.watts} W`, null, false);
  return out;
}

async function evaluateAlerts(now = Date.now()) {
  if (alertsRunning) {
    alertsAgain = true; // run once more when this one is done
    return;
  }
  alertsRunning = true;
  try {
    const cond = alertConditions();
    const { rules, settings } = config.alerts;
    const events = [];
    for (const [key, a] of Object.entries(alertState.active)) {
      if (cond.has(key)) continue;
      // deleted (or hidden) things go away quietly instead of "resolving"
      const exists = (!a.owner || config.hosts.some((h) => h.id === a.owner) || config.services.some((s) => s.id === a.owner))
        && !(a.device && config.devices.find((d) => d.id === a.device)?.hidden);
      if (exists && rules[a.type]?.enabled && a.fromData && !results.get(a.owner)?.ok) continue; // no fresh data: unknown
      delete alertState.active[key];
      alertsDirty = true;
      if (exists && a.firedAt && rules[a.type]?.enabled && settings.resolved) events.push({ ...a, key, event: 'resolved' });
    }
    for (const [key, c] of cond) {
      let a = alertState.active[key];
      if (!a) {
        a = alertState.active[key] = { ...c, since: now, firedAt: null, notifiedAt: null };
        alertsDirty = true;
      }
      const escalated = a.firedAt && SEVERITY_RANK[c.severity] > SEVERITY_RANK[a.severity];
      Object.assign(a, { severity: c.severity, detail: c.detail, owner: c.owner, fromData: c.fromData, device: c.device }, a.firedAt && !escalated ? {} : { title: c.title });
      let event = null;
      if (!a.firedAt && now - a.since >= (rules[c.type].delay || 0) * 60e3) event = 'fired';
      else if (escalated) event = 'escalated';
      else if (a.firedAt && settings.repeatHours && now - a.notifiedAt >= settings.repeatHours * 3600e3) event = 'reminder';
      if (!event) continue;
      if (event === 'fired') a.firedAt = now;
      a.notifiedAt = now;
      alertsDirty = true;
      events.push({ ...a, key, event });
    }
    if (events.length) await deliverAlerts(events, now);
  } finally {
    alertsRunning = false;
    saveAlertState();
    if (alertsAgain) {
      alertsAgain = false;
      setImmediate(() => evaluateAlerts().catch((e) => log('Alert check failed:', e.message)));
    }
  }
}

const recheckAlerts = () => setImmediate(() => evaluateAlerts().catch((e) => log('Alert check failed:', e.message)));

// One-off events (a failed backup): sent right away, nothing to resolve
async function alertEvent(type, severity, title, detail) {
  if (!config.alerts.rules[type]?.enabled) return;
  const now = Date.now();
  await deliverAlerts([{ type, key: `${type}:${now}`, severity, title, detail, since: now, event: 'fired' }], now);
  saveAlertState();
}

// Several alerts for the same channel in one round go out as one message
async function deliverAlerts(events, now) {
  const entries = events.map((e) => ({ at: now, type: e.type, event: e.event, severity: e.severity, title: e.title, detail: e.detail || '', sent: [] }));
  const groups = new Map();
  events.forEach((e, i) => {
    for (const id of config.alerts.rules[e.type]?.channels || []) {
      const ch = config.alerts.channels.find((c) => c.id === id && c.enabled);
      if (ch) groups.set(ch, [...(groups.get(ch) || []), i]);
    }
  });
  await Promise.all([...groups].map(async ([ch, idx]) => {
    const r = await sendToChannel(ch, alertMessage(idx.map((i) => events[i])));
    for (const i of idx) entries[i].sent.push({ id: ch.id, name: ch.name, ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  }));
  for (const e of entries) log(`Alert ${e.event}: ${e.title}${e.sent.length ? ` → ${e.sent.map((s) => `${s.name} ${s.ok ? 'ok' : 'FAILED'}`).join(', ')}` : ' (no channel)'}`);
  alertState.log = [...entries.reverse(), ...alertState.log].slice(0, 200);
  alertsDirty = true;
}

const publicChannel = (c) => ({ ...c, secret: undefined, hasSecret: Boolean(c.secret), last: alertState.channels[c.id] || null });

function alertsStatus() {
  return {
    types: Object.fromEntries(Object.entries(ALERT_TYPES).map(([k, t]) => [k, { label: t.label, hint: t.hint, event: t.delay === null, params: t.params || {} }])),
    channelTypes: CHANNEL_TYPES,
    channels: config.alerts.channels.map(publicChannel),
    rules: config.alerts.rules,
    settings: config.alerts.settings,
    repeatOptions: REPEAT_HOURS,
    active: Object.entries(alertState.active)
      .map(([key, a]) => ({ key, type: a.type, severity: a.severity, title: a.title, detail: a.detail, since: a.since, firedAt: a.firedAt }))
      .sort((a, b) => b.since - a.since),
    log: alertState.log.slice(0, 100),
  };
}

// ---------------------------------------------------------------------------
// Updates
//
// What can be updated, and to which version. UniFi firmware and Synology DSM come with every poll;
// Proxmox packages, TrueNAS (and its apps) and the apps' own update APIs are checked once a day at
// night, or with "Check now". Read-only: nothing is ever installed from here. Software versions
// help an attacker, so this is shown to the logged-in admin only, even on a public dashboard.

const UPDATES_FILE = path.join(DATA_DIR, 'updates.json');
const UPDATE_HOUR = 4; // 04:00–04:59 Europe/Oslo, after the nightly backup
let updates = { checkedAt: null, lastAutoDate: null, items: [] };
let updatesRunning = null; // promise while a check runs
let updatesManualAt = 0;

const RELEASE_NOTES = {
  sonarr: 'https://github.com/Sonarr/Sonarr/releases', radarr: 'https://github.com/Radarr/Radarr/releases', lidarr: 'https://github.com/Lidarr/Lidarr/releases',
  prowlarr: 'https://github.com/Prowlarr/Prowlarr/releases', overseerr: 'https://github.com/seerr-team/seerr/releases', pihole: 'https://github.com/pi-hole/pi-hole/releases',
  paperless: 'https://github.com/paperless-ngx/paperless-ngx/releases', authentik: 'https://goauthentik.io/docs/releases', portainer: 'https://github.com/portainer/portainer/releases',
  homeassistant: 'https://www.home-assistant.io/blog/', tautulli: 'https://github.com/Tautulli/Tautulli/releases', plex: 'https://forums.plex.tv/t/plex-media-server/30447',
  adguard: 'https://github.com/AdguardTeam/AdGuardHome/releases',
  proxmox: 'https://pve.proxmox.com/wiki/Roadmap', truenas: 'https://www.truenas.com/docs/softwarereleases/', unifi: 'https://community.ui.com/releases', synology: 'https://www.synology.com/releaseNote/DSM',
};

const cleanVersion = (v) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 60));

// Sonarr, Radarr, Lidarr, Prowlarr: the newest release first, the installed one marked
const servarrUpdate = (api) => async (x) => {
  const list = await x.get(`${api}/update`, { headers: { 'X-Api-Key': x.secret } });
  if (!Array.isArray(list) || !list.length) return { current: null, latest: null, available: false };
  const installed = list.find((u) => u.installed);
  return { current: installed?.version, latest: list[0].version, available: !list[0].installed };
};

// Per integration: { current, latest, available, detail?, list?, url? }
const UPDATE_CHECKS = {
  sonarr: servarrUpdate('/api/v3'),
  radarr: servarrUpdate('/api/v3'),
  lidarr: servarrUpdate('/api/v1'),
  prowlarr: servarrUpdate('/api/v1'),
  async overseerr(x) {
    const s = await x.get('/api/v1/status', { headers: { 'X-Api-Key': x.secret } });
    return { current: s.version, latest: null, available: Boolean(s.updateAvailable), detail: s.commitsBehind ? `${s.commitsBehind} commits behind` : '' };
  },
  async pihole(x) {
    try {
      return await withSession(x, piholeLogin(x), async (sid) => {
        const v = (await x.get('/api/info/version', { headers: { 'X-FTL-SID': sid } })).version || {};
        const parts = [['Core', v.core], ['Web', v.web], ['FTL', v.ftl]].filter(([, p]) => p?.local?.version);
        const behind = parts.filter(([, p]) => p.remote?.version && p.remote.version !== p.local.version);
        return { current: parts.map(([n, p]) => `${n} ${p.local.version}`).join(', '), latest: behind.map(([n, p]) => `${n} ${p.remote.version}`).join(', '), available: behind.length > 0 };
      });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const v = await x.get(`/admin/api.php?versions&auth=${encodeURIComponent(x.secret)}`); // v5
    const parts = [['Core', v.core_current, v.core_latest, v.core_update], ['Web', v.web_current, v.web_latest, v.web_update], ['FTL', v.FTL_current, v.FTL_latest, v.FTL_update]];
    return { current: parts.map(([n, c]) => `${n} ${c}`).join(', '), latest: parts.filter((p) => p[3]).map(([n, , l]) => `${n} ${l}`).join(', '), available: parts.some((p) => p[3]) };
  },
  async paperless(x) {
    const r = await x.get('/api/remote_version/', { headers: { Authorization: `Token ${x.secret}` } });
    return { current: null, latest: r.version, available: Boolean(r.update_available) };
  },
  async authentik(x) {
    const r = await x.get('/api/v3/admin/version/', { headers: { Authorization: `Bearer ${x.secret}` } });
    return { current: r.version_current, latest: r.version_latest, available: Boolean(r.outdated) };
  },
  async portainer(x) {
    const r = await x.get('/api/system/version', { headers: { 'X-API-Key': x.secret } });
    return { current: r.ServerVersion, latest: r.LatestVersion, available: Boolean(r.UpdateAvailable) };
  },
  async homeassistant(x) {
    const states = await x.get('/api/states', { headers: { Authorization: `Bearer ${x.secret}` } });
    const list = (Array.isArray(states) ? states : []).filter((e) => e.entity_id?.startsWith('update.'));
    const pending = list.filter((e) => e.state === 'on');
    const core = list.find((e) => e.entity_id === 'update.home_assistant_core_update');
    return {
      current: core?.attributes?.installed_version, latest: pending.length === 1 ? pending[0].attributes?.latest_version : null, available: pending.length > 0,
      detail: list.length ? `${pending.length} of ${list.length} update entities` : 'No update entities',
      list: pending.map((e) => ({ name: String(e.attributes?.title || e.attributes?.friendly_name || e.entity_id).slice(0, 80), current: cleanVersion(e.attributes?.installed_version), latest: cleanVersion(e.attributes?.latest_version) })),
    };
  },
  async tautulli(x) {
    const r = await x.get(`/api/v2?apikey=${encodeURIComponent(x.secret)}&cmd=update_check`);
    const d = r.response?.data || {};
    return { current: null, latest: d.latest_release || null, available: Boolean(d.update) };
  },
  async plex(x) {
    const r = await x.get('/updater/status', { headers: { 'X-Plex-Token': x.secret, Accept: 'application/json' } });
    const rel = r.MediaContainer?.Release?.[0];
    return { current: null, latest: rel?.version || null, available: Boolean(rel) };
  },
  async adguard(x) {
    const [st, v] = await Promise.all([x.get('/control/status', { headers: x.basic() }), x.post('/control/version.json', { recheck_now: false }, { headers: x.basic() })]);
    return { current: st.version, latest: v.new_version || null, available: Boolean(v.new_version) && v.new_version !== st.version, url: /^https:\/\//.test(v.announcement_url || '') ? v.announcement_url : null };
  },
};

// Which device a Proxmox node is: the one whose connection represents that node, else the connection's device
function nodeDevice(h, node) {
  for (const d of config.devices) {
    if (deviceHosts(d).some((x) => x.type === 'proxmox' && effectiveNode(x, d) === node)) return d.id;
  }
  return h.deviceId;
}

async function proxmoxUpdates(h, node) {
  const headers = { Authorization: `PVEAPIToken=${h.username}=${decryptSecret(h)}` };
  const get = (p) => httpsRequest(connectHost(h), h.address, { path: p, headers }).then((r) => r.data);
  const n = encodeURIComponent(node);
  let list;
  try {
    list = await get(`/api2/json/nodes/${n}/apt/update`);
  } catch (e) {
    if (/403/.test(e.message)) throw new UserError('Proxmox did not let this read-only token list updates (newer Proxmox VE versions allow it with Sys.Audit)');
    throw e;
  }
  const ver = await get(`/api2/json/nodes/${n}/version`).catch(() => null);
  const pkgs = (Array.isArray(list) ? list : []).map((p) => ({ name: String(p.Package || '').slice(0, 80), current: cleanVersion(p.OldVersion), latest: cleanVersion(p.Version) }));
  const mgr = pkgs.find((p) => p.name === 'pve-manager');
  return { current: ver?.version ? `Proxmox VE ${ver.version}` : null, latest: mgr ? `Proxmox VE ${mgr.latest}` : null, available: pkgs.length > 0, count: pkgs.length, detail: pkgs.length ? `${pkgs.length} package${pkgs.length === 1 ? '' : 's'}` : '', list: pkgs.slice(0, 300) };
}

function truenasUpdates(h) {
  return truenasSession(h, decryptSecret(h), async (rpc) => {
    let os;
    try {
      const r = await rpc.call('update.check_available');
      os = { latest: r?.version || null, available: r?.status === 'AVAILABLE', detail: r?.status === 'REBOOT_REQUIRED' ? 'Installed; restart to finish' : '' };
    } catch (e) {
      if (e.rpcCode !== -32601) throw e;
      const st = await rpc.call('update.status'); // newer releases
      const nv = st?.status?.new_version ?? st?.new_version ?? null;
      os = { latest: typeof nv === 'string' ? nv : nv?.version || null, available: Boolean(nv) };
    }
    const out = [{ part: 'TrueNAS', current: results.get(h.id)?.data?.system?.version || null, ...os, url: RELEASE_NOTES.truenas }];
    const apps = await rpc.call('app.query').catch(() => null);
    if (Array.isArray(apps) && apps.length) {
      const up = apps.filter((a) => a.upgrade_available);
      out.push({
        part: 'TrueNAS apps', sub: 'apps', current: `${apps.length} app${apps.length === 1 ? '' : 's'}`, latest: null, available: up.length > 0, count: up.length,
        detail: up.length ? `${up.length} can be updated` : '',
        list: up.slice(0, 100).map((a) => ({ name: String(a.name).slice(0, 80), current: cleanVersion(a.human_version || a.version), latest: cleanVersion(a.latest_app_version || a.latest_version) })),
      });
    }
    return out;
  });
}

async function serviceUpdate(svc) {
  const secret = svc.secret ? decryptSecret(serviceSecretHost(svc)) : null;
  return UPDATE_CHECKS[svc.integration.type](integrationCtx(svc, secret));
}

const updateError = (e) => (e instanceof UserError ? e.message : 'Check failed').slice(0, 300);

async function runUpdateChecks() {
  const jobs = [];
  const now = Date.now();
  const seenNodes = new Set();
  for (const h of config.hosts.filter((x) => x.type === 'proxmox' && x.secret)) {
    const dev = config.devices.find((d) => d.id === h.deviceId);
    const mine = dev ? effectiveNode(h, dev) : null;
    const nodes = mine ? [mine] : (results.get(h.id)?.data?.nodes || []).filter((n) => n.status === 'online').map((n) => n.name);
    for (const node of nodes) {
      if (seenNodes.has(node)) continue; // two connections to one cluster
      seenNodes.add(node);
      const base = { key: `pve:${h.id}:${node}`, source: 'proxmox', ownerType: 'device', owner: nodeDevice(h, node), part: `Proxmox node ${node}`, url: RELEASE_NOTES.proxmox };
      jobs.push(withTimeout(proxmoxUpdates(h, node), 45000, 'Update check').then((r) => [{ ...base, ...r }], (e) => [{ ...base, error: updateError(e) }]));
    }
  }
  for (const h of config.hosts.filter((x) => x.type === 'truenas' && x.secret)) {
    const base = { source: 'truenas', ownerType: 'device', owner: h.deviceId };
    jobs.push(withTimeout(truenasUpdates(h), 60000, 'Update check').then(
      (list) => list.map((r) => ({ ...base, key: `truenas:${h.id}${r.sub ? `:${r.sub}` : ''}`, ...r })),
      (e) => [{ ...base, key: `truenas:${h.id}`, part: 'TrueNAS', url: RELEASE_NOTES.truenas, error: updateError(e) }]));
  }
  for (const svc of config.services.filter((x) => x.connection && x.integration && UPDATE_CHECKS[x.integration.type])) {
    const base = { key: `svc:${svc.id}`, source: svc.integration.type, ownerType: 'service', owner: svc.id, part: INTEGRATIONS[svc.integration.type].label, url: RELEASE_NOTES[svc.integration.type] || null };
    jobs.push(withTimeout(serviceUpdate(svc), 30000, 'Update check').then((r) => [{ ...base, ...r }], (e) => [{ ...base, error: updateError(e) }]));
  }
  const items = (await Promise.all(jobs)).flat().map((it) => ({
    ...it,
    current: cleanVersion(it.current), latest: cleanVersion(it.latest), available: Boolean(it.available), checkedAt: now,
    url: it.url && /^https:\/\//.test(it.url) ? it.url : null,
  }));
  updates = { ...updates, checkedAt: now, items };
  writeJsonAtomic(UPDATES_FILE, updates);
  const n = items.filter((x) => x.available).length;
  log(`Update check: ${n} can be updated, ${items.filter((x) => x.error).length} could not be checked`);
}

function checkUpdates() {
  if (!updatesRunning) updatesRunning = runUpdateChecks().catch((e) => log('Update check failed:', e.message)).finally(() => (updatesRunning = null));
  return updatesRunning;
}

function loadUpdates() {
  const u = readJson(UPDATES_FILE, null);
  if (u && Array.isArray(u.items)) updates = { checkedAt: u.checkedAt || null, lastAutoDate: u.lastAutoDate || null, items: u.items };
}

// Every few minutes: once a night, and soon after start if the last check is more than a day old
function updatesTick() {
  const now = Date.now();
  const z = zoned(now);
  const stale = !updates.checkedAt || now - updates.checkedAt > 26 * 3600e3;
  if ((z.hour === UPDATE_HOUR && updates.lastAutoDate !== z.date) || stale) {
    updates.lastAutoDate = z.date;
    checkUpdates();
  }
}

// Everything that can be checked, live and daily, named after its device or service as it is now
function updatesPayload() {
  const rows = [];
  const devName = (id) => config.devices.find((d) => d.id === id)?.name || null;
  for (const h of config.hosts.filter((x) => x.type === 'unifi')) {
    const r = results.get(h.id);
    for (const d of r?.data?.devices || []) {
      const dev = config.devices.find((v) => v.unifi?.hostId === h.id && v.unifi.mac === d.mac);
      if (dev?.hidden) continue;
      rows.push({ key: `unifi:${h.id}:${d.mac}`, source: 'unifi', ownerType: 'device', owner: dev?.id || null, name: dev?.name || d.name, part: 'UniFi firmware', current: d.version || null, latest: d.upgradeTo || null, available: d.upgradable, url: RELEASE_NOTES.unifi, checkedAt: r.updatedAt });
    }
  }
  for (const h of config.hosts.filter((x) => x.type === 'synology')) {
    const r = results.get(h.id);
    const s = r?.data?.system;
    if (s) rows.push({ key: `dsm:${h.id}`, source: 'synology', ownerType: 'device', owner: h.deviceId, name: devName(h.deviceId) || h.name, part: 'DSM', current: s.version || null, latest: null, available: Boolean(s.upgradeAvailable), url: RELEASE_NOTES.synology, checkedAt: r.updatedAt });
  }
  for (const it of updates.items) {
    const svc = it.ownerType === 'service' ? config.services.find((x) => x.id === it.owner) : null;
    if (it.ownerType === 'service' && !svc) continue; // removed since the check
    if (it.ownerType === 'device' && !config.devices.some((d) => d.id === it.owner)) continue;
    rows.push({ ...it, name: svc ? svc.name : devName(it.owner) });
  }
  rows.sort((a, b) => Number(b.available) - Number(a.available) || Number(Boolean(b.error)) - Number(Boolean(a.error)) || String(a.name).localeCompare(String(b.name)));
  const z = zoned(Date.now());
  return {
    checkedAt: updates.checkedAt,
    running: Boolean(updatesRunning),
    nextCheck: `${z.hour >= UPDATE_HOUR + 1 || updates.lastAutoDate === z.date ? 'tomorrow' : 'tonight'} at 0${UPDATE_HOUR}:00`,
    available: rows.filter((r) => r.available).length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Backup and restore
//
// A backup is one file: settings, devices, connections, services, docs, energy history and
// uploaded images, gzip-compressed and encrypted with a passphrase (scrypt + AES-256-GCM).
// Secrets are decrypted with the server key and travel inside the passphrase-encrypted file,
// so a backup restores on a fresh install (new server key); the server key itself never leaves.
// Automatic backups keep the last N copies locally and send them to the chosen destinations:
// a mounted folder, S3-compatible storage, or rsync over SSH (pinned host key, encrypted SSH key).

const zlib = require('node:zlib');
const os = require('node:os');
const { execFile } = require('node:child_process');

const BACKUP_MAGIC = Buffer.from('HLDBAK1\n');
const BACKUP_SCRYPT = { N: 32768, r: 8, p: 1 };
const LOCAL_BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_BASE = path.resolve(process.env.BACKUP_DIR || '/var/backups/homelab-dashboard'); // mount NAS shares here
const BACKUP_NAME = /^homelab-dashboard-\d{4}-\d{2}-\d{2}-\d{6}(-[a-z-]+)?\.hldb$/;
const DEFAULT_BACKUP = { schedule: { enabled: false, time: '03:30', keep: 14 }, passphrase: null, destinations: [], history: [], lastAutoDate: null };

async function backupKey(passphrase, salt) {
  return scryptAsync(passphrase, salt, { ...BACKUP_SCRYPT, keylen: 32 });
}

function backupPassphraseProblem(p) {
  return typeof p !== 'string' || p.length < 12 ? 'The backup passphrase must be at least 12 characters' : p.length > 1024 ? 'Passphrase too long' : null;
}

const secretOrNull = (holder) => {
  if (!holder?.secret) return null;
  try {
    return decryptSecret(holder);
  } catch {
    return null;
  }
};
const destHost = (d) => ({ id: d.id, type: `backup:${d.type}`, address: d.endpoint || d.host || '', username: d.accessKey || d.user || '', tlsMode: d.tlsMode || '', fingerprint: d.fingerprint || '', secret: d.secret });
const passHost = () => ({ id: 'backup-passphrase', type: 'backup', address: '', username: '', tlsMode: '', fingerprint: '', secret: config.backup.passphrase });

// Everything worth keeping, with secrets in plain text (only ever written encrypted)
function backupBundle() {
  const files = (dir, list) => Object.fromEntries(list.map((x) => {
    try {
      return [x.id, fs.readFileSync(path.join(dir, x.id)).toString('base64')];
    } catch {
      return [x.id, null];
    }
  }).filter(([, v]) => v));
  return {
    format: 'homelab-dashboard-backup',
    version: 1,
    createdAt: Date.now(),
    host: os.hostname(),
    admin: readAdmin(),
    config: {
      ...config,
      hosts: config.hosts.map((h) => ({ ...h, secret: undefined, secretPlain: secretOrNull(h) })),
      services: config.services.map((x) => ({ ...x, secret: undefined, secretPlain: x.secret ? secretOrNull(serviceSecretHost(x)) : null })),
      backup: {
        ...config.backup,
        passphrase: undefined,
        passphrasePlain: config.backup.passphrase ? secretOrNull(passHost()) : null,
        destinations: config.backup.destinations.map((d) => ({ ...d, secret: undefined, secretPlain: d.secret ? secretOrNull(destHost(d)) : null })),
      },
      alerts: { ...config.alerts, channels: config.alerts.channels.map((c) => ({ ...c, secret: undefined, secretPlain: c.secret ? secretOrNull(channelHost(c)) : null })) },
    },
    docs,
    docsHistory,
    energy,
    history,
    files: { backgrounds: files(BACKGROUND_DIR, config.backgrounds), icons: files(ICON_DIR, config.icons) },
  };
}

async function encryptBackup(bundle, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', await backupKey(passphrase, salt), iv);
  c.setAAD(BACKUP_MAGIC);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(bundle)))), c.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, c.getAuthTag(), body]);
}

async function decryptBackup(buf, passphrase) {
  if (buf.length < 52 || !buf.subarray(0, 8).equals(BACKUP_MAGIC)) throw new UserError('Not a homelab dashboard backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', await backupKey(passphrase, buf.subarray(8, 24)), buf.subarray(24, 36));
  d.setAAD(BACKUP_MAGIC);
  d.setAuthTag(buf.subarray(36, 52));
  let plain;
  try {
    plain = Buffer.concat([d.update(buf.subarray(52)), d.final()]);
  } catch {
    throw new UserError('Wrong passphrase, or the file is damaged');
  }
  const bundle = JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: 1024 * 1024 * 1024 }).toString('utf8'));
  if (bundle?.format !== 'homelab-dashboard-backup' || bundle.version !== 1 || !bundle.config) throw new UserError('Unsupported backup format');
  return bundle;
}

async function restoreBundle(bundle, { admin = false, server = false } = {}) {
  const c = bundle.config;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const hosts = arr(c.hosts).filter((h) => UUID.test(h?.id) && HOST_TYPES[h.type]).map(({ secretPlain, ...h }) => {
    const out = { ...h, secret: null };
    if (secretPlain) out.secret = encryptSecret(out, secretPlain);
    return out;
  });
  const services = arr(c.services).filter((x) => UUID.test(x?.id)).map(({ secretPlain, ...x }) => {
    const out = { ...x, secret: null };
    if (secretPlain) out.secret = encryptSecret(serviceSecretHost(out), secretPlain);
    return out;
  });
  const b = c.backup || {};
  const destinations = arr(b.destinations).filter((d) => UUID.test(d?.id)).map(({ secretPlain, ...d }) => {
    const out = { ...d, secret: null };
    if (secretPlain) out.secret = encryptSecret(destHost(out), secretPlain);
    return out;
  });
  const channels = arr(c.alerts?.channels).filter((x) => UUID.test(x?.id)).flatMap(({ secretPlain, ...x }) => {
    try {
      const out = { id: x.id, ...validateChannel(x), secret: null };
      if (secretPlain && channelNeedsSecret(out)) out.secret = encryptSecret(channelHost(out), secretPlain);
      return [out];
    } catch {
      return []; // not valid in this version
    }
  });
  const keepServer = config.settings.server;
  config = {
    version: 2,
    settings: deepMerge(DEFAULT_SETTINGS, c.settings),
    hosts,
    backgrounds: arr(c.backgrounds),
    layout: c.layout?.items ? c.layout : null,
    rack: { ...DEFAULT_RACK, ...(c.rack || {}), passive: cleanPassive(c.rack?.passive) },
    devices: arr(c.devices),
    services,
    icons: arr(c.icons),
    servicesLayout: Array.isArray(c.servicesLayout?.groups) ? { groups: c.servicesLayout.groups.filter((k) => typeof k === 'string').slice(0, 200), columns: c.servicesLayout.columns || {} } : null,
    backup: { ...structuredClone(DEFAULT_BACKUP), ...b, passphrase: null, passphrasePlain: undefined, destinations },
    alerts: normalizeAlerts(c.alerts, channels),
  };
  if (b.passphrasePlain) config.backup.passphrase = encryptSecret(passHost(), b.passphrasePlain);
  if (!server) config.settings.server = keepServer;
  // uploaded images
  for (const [dir, list, key] of [[BACKGROUND_DIR, config.backgrounds, 'backgrounds'], [ICON_DIR, config.icons, 'icons']]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const rec of list) {
      const data = bundle.files?.[key]?.[rec.id];
      if (/^[0-9a-f]{32}$/.test(rec.id) && data) fs.writeFileSync(path.join(dir, rec.id), Buffer.from(data, 'base64'), { mode: 0o600 });
    }
  }
  saveConfig();
  docs = normalizeDocs(bundle.docs);
  saveDocs();
  docsHistory = cleanDocsHistory(bundle.docsHistory);
  saveDocsHistory();
  energy = bundle.energy?.buckets ? bundle.energy : { buckets: {} };
  energyDirty = true;
  saveEnergy();
  history = cleanHistory(bundle.history);
  historyDirty = true;
  saveHistory();
  if (admin && bundle.admin?.username && bundle.admin?.hash) {
    writeJsonAtomic(ADMIN_FILE, bundle.admin);
    for (const r of [...remembered.values()]) forgetDevice(r); // they belonged to the replaced password
    saveRemembered();
  }
  results.clear();
  serviceResults.clear();
  lastSample.clear();
  unifiSessions.clear();
  svcSessions.clear();
  schedulePolling();
}

// --- destinations ---

const BACKUP_TYPES = { folder: 'Folder (mounted NAS share)', s3: 'S3-compatible', rsync: 'rsync over SSH' };

function validateDestination(b) {
  const type = b.type;
  if (!BACKUP_TYPES[type]) throw new UserError('Unknown destination type');
  const out = { type, name: str(b.name, 48, 'Name') || BACKUP_TYPES[type], enabled: b.enabled !== false };
  if (type === 'folder') {
    const sub = str(b.folder, 120, 'Folder');
    if (sub && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(sub)) throw new UserError('Folder: letters, digits, . _ - and / only');
    if (sub.split('/').some((x) => x === '..' || x === '.')) throw new UserError('Invalid folder');
    out.folder = sub;
  }
  if (type === 's3') {
    const u = parseServiceUrl(str(b.endpoint, 300, 'Endpoint', { required: true }));
    if (!u.https) throw new UserError('S3 endpoint must use https://');
    out.endpoint = u.href;
    out.region = str(b.region, 40, 'Region') || 'us-east-1';
    if (!/^[a-z0-9-]+$/.test(out.region)) throw new UserError('Invalid region');
    out.bucket = str(b.bucket, 63, 'Bucket', { required: true });
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(out.bucket)) throw new UserError('Invalid bucket name');
    out.prefix = str(b.prefix, 200, 'Folder in bucket').replace(/^\/+|\/+$/g, '');
    if (out.prefix && !/^[A-Za-z0-9._\/-]+$/.test(out.prefix)) throw new UserError('Folder in bucket: letters, digits, . _ - / only');
    out.accessKey = str(b.accessKey, 128, 'Access key ID', { required: true });
    out.pathStyle = b.pathStyle === true;
    out.tlsMode = b.tlsMode === 'pin' ? 'pin' : 'verify';
    out.fingerprint = out.tlsMode === 'pin' ? normalizeFingerprint(b.fingerprint) : '';
  }
  if (type === 'rsync') {
    out.host = str(b.host, 253, 'Host', { required: true });
    if (!net.isIP(out.host) && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(out.host)) throw new UserError('Invalid host');
    out.port = num(b.port || 22, 1, 65535, 'SSH port', { int: true });
    out.user = str(b.user, 32, 'User', { required: true });
    if (!/^[a-z_][a-z0-9_.-]*$/i.test(out.user)) throw new UserError('Invalid user name');
    out.path = str(b.path, 200, 'Remote folder', { required: true });
    if (!/^[A-Za-z0-9._\/~-]+$/.test(out.path) || out.path.split('/').includes('..')) throw new UserError('Remote folder: letters, digits, . _ - / ~ only');
    out.knownHosts = str(b.knownHosts, 4000, 'Host key', { multiline: true });
    if (out.knownHosts && !/^(\S+ (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) [A-Za-z0-9+/=]+\n?)+$/.test(out.knownHosts.trim() + '\n')) throw new UserError('Invalid host key');
    out.publicKey = str(b.publicKey, 600, 'Public key');
    out.rsyncPath = str(b.rsyncPath, 200, 'Remote rsync path');
    if (out.rsyncPath && !/^\/[A-Za-z0-9._\/-]+$/.test(out.rsyncPath)) throw new UserError('Remote rsync path must be an absolute path');
  }
  return out;
}

// --- S3 (AWS Signature Version 4) ---

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const awsEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

// Returns the Authorization header for a request (kept generic so it can be checked against AWS's test vectors)
function sigV4({ method, path: uriPath, query = {}, headers, payloadHash, accessKey, secretKey, region, service, amzDate }) {
  const date = amzDate.slice(0, 8);
  const canonicalQuery = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`).join('&');
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalRequest = [method, uriPath, canonicalQuery, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSigning, stringToSign).toString('hex')}`;
}

async function s3Request(d, secretKey, method, key, { body = Buffer.alloc(0), query = {} } = {}) {
  const u = parseServiceUrl(d.endpoint);
  const hostName = d.pathStyle ? u.host : `${d.bucket}.${u.host}`;
  const port = u.port === 443 ? '' : `:${u.port}`;
  const uriPath = `${u.base}${d.pathStyle ? `/${d.bucket}` : ''}/${key.split('/').map(awsEncode).join('/')}`.replace(/\/+$/, key ? '' : '/');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256hex(body);
  const headers = { host: `${hostName}${port}`, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const auth = sigV4({ method, path: uriPath, query, headers, payloadHash, accessKey: d.accessKey, secretKey, region: d.region, service: 's3', amzDate });
  const qs = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k])}`).join('&');
  const address = `${hostName}:${u.port}`;
  const r = await httpsRequest(tlsConnect(address, { pin: d.tlsMode === 'pin' ? d.fingerprint : null, verify: true }), address, {
    method, path: uriPath + (qs ? `?${qs}` : ''), full: true, timeoutMs: 120000, maxBytes: 4 << 20,
    headers: { ...headers, Authorization: auth, 'Content-Type': 'application/octet-stream', ...(method === 'PUT' ? { 'Content-Length': body.length } : {}) },
    body: method === 'PUT' ? body : null,
  });
  if (r.status < 200 || r.status >= 300) {
    const code = /<Code>([^<]+)<\/Code>/.exec(r.text || '')?.[1];
    throw Object.assign(new UserError(`S3: HTTP ${r.status}${code ? ` (${code})` : ''}`), { status: r.status });
  }
  return r;
}

async function s3List(d, secretKey) {
  const prefix = d.prefix ? `${d.prefix}/` : '';
  const r = await s3Request(d, secretKey, 'GET', '', { query: { 'list-type': '2', prefix } });
  return [...(r.text || '').matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => BACKUP_NAME.test(k.slice(prefix.length)));
}

// --- rsync over SSH (fixed binaries and validated arguments only; no shell) ---

function run(cmd, argv, { timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: '/usr/bin:/bin', HOME: DATA_DIR, ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) };
    const child = execFile(cmd, argv, { timeout: timeoutMs, maxBuffer: 1 << 20, env }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr) }));
      resolve(String(stdout));
    });
    if (input) child.stdin.end(input);
  });
}

// SSH key and known_hosts exist decrypted only in a private temporary folder during a run
async function withSshFiles(d, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ssh-'));
  try {
    const key = secretOrNull(destHost(d));
    if (!key) throw new UserError('No SSH key: generate one for this destination');
    if (!d.knownHosts) throw new UserError('No pinned host key: fetch and trust the host key first');
    fs.writeFileSync(path.join(dir, 'key'), key, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'known_hosts'), d.knownHosts.trim() + '\n', { mode: 0o600 });
    const ssh = ['ssh', '-F', '/dev/null', '-i', path.join(dir, 'key'), '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`,
      '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', String(d.port)];
    return await fn(ssh, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Prefer ssh's own explanation over rsync's generic "connection unexpectedly closed"
function sshError(e) {
  const lines = String(e.stderr || e.message).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(l)))
    return new UserError("The server's SSH host key does not match the pinned key. Check the server, then fetch and trust its host key again.");
  const ssh = lines.find((l) => /Permission denied|Connection refused|Connection timed out|No route to host|Could not resolve|Too many authentication failures|No such file or directory/i.test(l));
  return new UserError((ssh || lines.slice(-2).join(' ') || 'ssh/rsync failed').slice(0, 300));
}

async function rsyncPush(d, sourceDir, { dryRun = false } = {}) {
  return withSshFiles(d, async (ssh) => {
    if (ssh.concat([sourceDir]).some((a) => /\s/.test(a))) throw new UserError('Paths with spaces are not supported');
    const argv = ['-a', '--delete', '--include=*.hldb', '--exclude=*', ...(dryRun ? ['--dry-run'] : []), ...(d.rsyncPath ? [`--rsync-path=${d.rsyncPath}`] : []),
      '-e', ssh.join(' '), `${sourceDir}/`, `${d.user}@${d.host}:${d.path.replace(/\/+$/, '')}/`];
    try {
      await run(process.env.RSYNC || 'rsync', argv);
    } catch (e) {
      throw e.code === 'ENOENT' ? new UserError('rsync is not installed on this server (the installer installs it)') : sshError(e);
    }
  });
}

async function sshKeyscan(host, port) {
  let out;
  try {
    out = await run('ssh-keyscan', ['-T', '10', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host], { timeoutMs: 20000 });
  } catch (e) {
    throw sshError(e);
  }
  const lines = out.split('\n').filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new UserError('No SSH host key received');
  const fingerprints = lines.map((l) => {
    const [, type, b64] = l.split(' ');
    return { type, fingerprint: `SHA256:${crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}` };
  });
  return { knownHosts: lines.join('\n'), fingerprints };
}

async function generateSshKey(comment) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-keygen-'));
  try {
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path.join(dir, 'key')]);
    return { privateKey: fs.readFileSync(path.join(dir, 'key'), 'utf8'), publicKey: fs.readFileSync(path.join(dir, 'key.pub'), 'utf8').trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- running backups ---

const backupStamp = (suffix = '') => {
  const z = zoned(Date.now());
  const two = (n) => String(n).padStart(2, '0');
  return `homelab-dashboard-${z.date}-${two(z.hour)}${two(z.minute)}${two(z.second)}${suffix}.hldb`;
};

function keepNewest(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
}

async function sendToDestination(d, file, data, keep) {
  if (d.type === 'folder') {
    const dir = path.join(BACKUP_BASE, d.folder || '');
    if (!isInside(dir, BACKUP_BASE)) throw new UserError('Invalid folder');
    if (!fs.existsSync(BACKUP_BASE)) throw new UserError(`${BACKUP_BASE} does not exist (re-run the installer, then mount your share there)`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, file), data, { mode: 0o600 });
    keepNewest(dir, keep);
  } else if (d.type === 's3') {
    const secret = secretOrNull(destHost(d));
    if (!secret) throw new UserError('No secret access key set');
    const prefix = d.prefix ? `${d.prefix}/` : '';
    await s3Request(d, secret, 'PUT', prefix + file, { body: data });
    const keys = (await s3List(d, secret)).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - keep))) await s3Request(d, secret, 'DELETE', k);
  } else if (d.type === 'rsync') {
    await rsyncPush(d, LOCAL_BACKUP_DIR); // mirrors the local copies, so old ones are pruned too
  }
}

let backupRunning = false;
async function runBackup(trigger) {
  if (backupRunning) throw new UserError('A backup is already running');
  backupRunning = true;
  const entry = { at: Date.now(), trigger, file: null, bytes: 0, results: [] };
  try {
    const passphrase = config.backup.passphrase ? secretOrNull(passHost()) : null;
    if (!passphrase) throw new UserError('Set a backup passphrase first');
    saveEnergy();
    const data = await encryptBackup(backupBundle(), passphrase);
    const file = backupStamp();
    fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(LOCAL_BACKUP_DIR, file), data, { mode: 0o600 });
    keepNewest(LOCAL_BACKUP_DIR, config.backup.schedule.keep);
    Object.assign(entry, { file, bytes: data.length });
    for (const d of config.backup.destinations.filter((x) => x.enabled)) {
      const t0 = Date.now();
      try {
        await withTimeout(sendToDestination(d, file, data, config.backup.schedule.keep), 10 * 60000, 'Backup upload');
        entry.results.push({ id: d.id, name: d.name, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        entry.results.push({ id: d.id, name: d.name, ok: false, error: safeErrorMessage(e, null) });
      }
    }
    log(`Backup ${file} (${data.length} bytes): ${entry.results.map((r) => `${r.name} ${r.ok ? 'ok' : 'FAILED'}`).join(', ') || 'local only'}`);
  } catch (e) {
    entry.error = e instanceof UserError ? e.message : 'Backup failed';
    log(`Backup failed: ${e.message}`);
  } finally {
    backupRunning = false;
    config.backup.history = [entry, ...config.backup.history].slice(0, 30);
    saveConfig();
  }
  const failed = entry.results.filter((x) => !x.ok);
  if (trigger === 'scheduled' && (entry.error || failed.length)) {
    alertEvent('backup', 'critical', entry.error ? 'Automatic backup failed' : 'Backup upload failed', entry.error || failed.map((x) => `${x.name}: ${x.error}`).join('; '))
      .catch((e) => log('Alert failed:', e.message));
  }
  return entry;
}

// Checked every 30 s: runs once per day at the chosen time (Europe/Oslo)
function backupTick() {
  const sch = config.backup.schedule;
  if (!sch.enabled || backupRunning) return;
  const z = zoned(Date.now());
  const [hh, mm] = sch.time.split(':').map(Number);
  if (config.backup.lastAutoDate === z.date || z.hour * 60 + z.minute < hh * 60 + mm || z.hour * 60 + z.minute > hh * 60 + mm + 30) return;
  config.backup.lastAutoDate = z.date;
  runBackup('scheduled').catch(() => {});
}

function backupStatus() {
  const b = config.backup;
  let local = [];
  try {
    local = fs.readdirSync(LOCAL_BACKUP_DIR).filter((f) => BACKUP_NAME.test(f)).sort().reverse()
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(LOCAL_BACKUP_DIR, f)).size }));
  } catch {
    /* none yet */
  }
  return {
    schedule: b.schedule,
    hasPassphrase: Boolean(b.passphrase),
    destinations: b.destinations.map((d) => ({ ...d, secret: undefined, hasSecret: Boolean(d.secret) })),
    history: b.history,
    local,
    folderBase: BACKUP_BASE,
    folderBaseExists: fs.existsSync(BACKUP_BASE),
    types: BACKUP_TYPES,
    running: backupRunning,
  };
}

// ---------------------------------------------------------------------------
// Web server: HTTPS and/or HTTP listeners, configurable in Admin
//
// Port changes bind the new port first and only then close the old one, so a port that can't be
// used never takes the dashboard offline. HTTP can redirect to HTTPS or serve the dashboard.

const listeners = { https: null, http: null }; // kind -> { server, port }
let tlsInfo = null;

function loadTls() {
  const cred = process.env.CREDENTIALS_DIRECTORY;
  const pick = (credName, envName) => {
    const p = cred && path.join(cred, credName);
    return p && fs.existsSync(p) ? p : process.env[envName] || null;
  };
  const certFile = pick('tls_cert', 'TLS_CERT_FILE');
  const keyFile = pick('tls_key', 'TLS_KEY_FILE');
  if (!certFile || !keyFile) return null;
  const cert = fs.readFileSync(certFile);
  const x = new crypto.X509Certificate(cert);
  const caFile = pick('ca_cert', 'TLS_CA_FILE');
  const ca = caFile ? fs.readFileSync(caFile) : null;
  return {
    cert,
    key: fs.readFileSync(keyFile),
    ca,
    subject: x.subject,
    names: x.subjectAltName,
    validTo: Date.parse(x.validTo),
    fingerprint: x.fingerprint256,
    caFingerprint: ca ? new crypto.X509Certificate(ca).fingerprint256 : null,
    caValidTo: ca ? Date.parse(new crypto.X509Certificate(ca).validTo) : null,
  };
}

// What actually runs: without a certificate only plain HTTP is possible.
function effectiveServer(cfg) {
  const httpsOn = cfg.https.enabled && Boolean(tlsInfo);
  return {
    https: httpsOn ? { port: cfg.https.port } : null,
    http: cfg.http.enabled || !httpsOn ? { port: cfg.http.port, mode: httpsOn ? cfg.http.mode : 'serve' } : null,
  };
}

function hostOnly(hostHeader) {
  const h = String(hostHeader || '');
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
}

function redirectToHttps(req, res) {
  securityHeaders(req, res);
  if (!hostAllowed(req.headers.host)) return sendError(res, 421, 'Unknown host; add it to ALLOWED_HOSTS');
  const port = listeners.https.port;
  const target = `https://${hostOnly(req.headers.host)}${port === 443 ? '' : `:${port}`}${String(req.url).startsWith('/') ? req.url : '/'}`;
  res.writeHead(308, { Location: target, 'Content-Length': 0 });
  res.end();
}

// The HTTP listener decides per request, so switching between redirect and serve needs no re-bind.
function httpHandler(req, res) {
  const mode = effectiveServer(config.settings.server).http?.mode;
  if (mode === 'redirect' && listeners.https) return redirectToHttps(req, res);
  return handle(req, res);
}

function makeServer(kind) {
  const srv = kind === 'https'
    ? require('node:https').createServer({ cert: tlsInfo.cert, key: tlsInfo.key, minVersion: 'TLSv1.2' }, handle)
    : http.createServer(httpHandler);
  srv.headersTimeout = 15000;
  srv.requestTimeout = 30000;
  srv.keepAliveTimeout = 5000;
  return srv;
}

function listenOn(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, HOST, () => {
      srv.off('error', reject);
      resolve();
    });
  });
}

// Starts listeners that are new or moved; returns the old ones (closed later by the caller).
async function applyServer(cfg) {
  const want = effectiveServer(cfg);
  const started = [];
  try {
    for (const kind of ['https', 'http']) {
      const w = want[kind];
      if (!w || listeners[kind]?.port === w.port) continue;
      const other = listeners[kind === 'https' ? 'http' : 'https'];
      if (other && other.port === w.port) throw new UserError(`Port ${w.port} is in use by this server's ${kind === 'https' ? 'HTTP' : 'HTTPS'} listener; change one port at a time`);
      const srv = makeServer(kind);
      try {
        await listenOn(srv, w.port);
      } catch (e) {
        throw new UserError(e.code === 'EACCES' ? `Port ${w.port} needs extra privileges (ports below 1024): re-run the installer with --low-ports`
          : e.code === 'EADDRINUSE' ? `Port ${w.port} is already in use by another program` : `Could not listen on port ${w.port} (${e.code || e.message})`);
      }
      started.push({ kind, server: srv, port: w.port });
    }
  } catch (e) {
    for (const st of started) st.server.close();
    throw e;
  }
  const old = [];
  for (const kind of ['https', 'http']) {
    const st = started.find((x) => x.kind === kind);
    if (st) {
      if (listeners[kind]) old.push(listeners[kind]);
      listeners[kind] = { server: st.server, port: st.port };
    } else if (!want[kind] && listeners[kind]) {
      old.push(listeners[kind]);
      listeners[kind] = null;
    }
  }
  initAllowedHosts();
  return old;
}

function closeListeners(old, delayMs = 1500) {
  if (!old.length) return;
  setTimeout(() => {
    for (const l of old) {
      l.server.close();
      l.server.closeAllConnections?.();
    }
  }, delayMs).unref();
}

function serverUrls() {
  const host = HOST.includes(':') ? `[${HOST}]` : HOST;
  return {
    https: listeners.https ? `https://${host}${listeners.https.port === 443 ? '' : `:${listeners.https.port}`}` : null,
    http: listeners.http ? `http://${host}${listeners.http.port === 80 ? '' : `:${listeners.http.port}`}` : null,
  };
}

function serverStatus() {
  return {
    settings: config.settings.server,
    urls: serverUrls(),
    httpMode: effectiveServer(config.settings.server).http?.mode || null,
    tls: tlsInfo ? { subject: tlsInfo.subject, names: tlsInfo.names, validTo: tlsInfo.validTo, fingerprint: tlsInfo.fingerprint, caFingerprint: tlsInfo.caFingerprint, caValidTo: tlsInfo.caValidTo } : null,
  };
}

// ---------------------------------------------------------------------------
// Startup

function validateBindHost() {
  if (!net.isIP(HOST) && HOST !== 'localhost') fatal('HOST must be an IP address (loopback or private)');
  const h = HOST === 'localhost' ? '127.0.0.1' : HOST;
  if (h === '0.0.0.0' || h === '::' || /^0+(\.0+){3}$/.test(h)) fatal('Refusing to listen on all interfaces; set HOST to 127.0.0.1 or the internal IP');
  const privateV4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
  const ok = net.isIPv4(h) ? privateV4.some((r) => r.test(h)) : h === '::1' || /^f[cd]/i.test(h) || /^fe80:/i.test(h);
  if (!ok) fatal(`HOST ${HOST} is not a loopback/private address`);
}

let pipedInput = '';
function readPasswordFromTty(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      const tryLine = () => {
        const i = pipedInput.indexOf('\n');
        if (i === -1) return false;
        const line = pipedInput.slice(0, i).replace(/\r$/, '');
        pipedInput = pipedInput.slice(i + 1);
        stdin.off('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(line);
        return true;
      };
      const onData = (d) => {
        pipedInput += d;
        tryLine();
      };
      if (tryLine()) return;
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.resume();
      return;
    }
    let pw = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function cliSetAdmin(username) {
  ensureDataDir();
  username = (username || 'admin').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) fatal('Username may only contain letters, digits, . _ -');
  const pw = await readPasswordFromTty(`New password for ${username}: `);
  const problem = passwordProblem(pw);
  if (problem) fatal(problem);
  const again = await readPasswordFromTty('Repeat password: ');
  if (again !== pw) fatal('Passwords do not match');
  writeJsonAtomic(ADMIN_FILE, { username, hash: await hashPassword(pw), changedAt: Date.now() });
  console.log(`Admin account "${username}" saved in ${ADMIN_FILE}. Restart the service to end existing sessions and remembered devices.`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'set-admin') return cliSetAdmin(arg);
  if (cmd === 'reset-network') {
    ensureDataDir();
    const raw = readJson(CONFIG_FILE, {});
    raw.settings = { ...(raw.settings || {}), server: structuredClone(DEFAULT_SETTINGS.server) };
    writeJsonAtomic(CONFIG_FILE, raw);
    console.log(`Web server reset to HTTPS port ${DEFAULT_SETTINGS.server.https.port} and HTTP port ${DEFAULT_SETTINGS.server.http.port} (redirect). Start the service again.`);
    return;
  }
  if (cmd) fatal(`Unknown command: ${cmd}`);

  const major = parseInt(process.versions.node, 10);
  if (major < 18) fatal('Node.js 18 or newer is required');
  if (process.getuid && process.getuid() === 0) fatal('Do not run as root; use the dedicated service user');
  process.umask(0o077);
  validateBindHost();
  ensureDataDir();
  KEY = loadKey();
  loadConfig();
  loadEnergy();
  loadHistory();
  loadAlertState();
  loadUpdates();
  loadDocs();
  loadDocsHistory();
  loadRemembered();
  loadStatic();
  initAllowedHosts();
  DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));
  if (!readAdmin()) log('WARNING: no admin account yet. Run: node server.js set-admin <username>');

  tlsInfo = loadTls();
  if (!tlsInfo && config.settings.server.https.enabled) log('No TLS certificate found: serving plain HTTP only');
  try {
    await applyServer(config.settings.server);
  } catch (e) {
    fatal(`${e.message}. To go back to the default ports: node server.js reset-network`);
  }
  const urls = serverUrls();
  log(`Listening on ${[urls.https, urls.http && `${urls.http}${effectiveServer(config.settings.server).http.mode === 'redirect' ? ' (redirects to HTTPS)' : ''}`].filter(Boolean).join(' and ')}`);

  schedulePolling();
  setInterval(saveEnergy, 5 * 60 * 1000).unref();
  setInterval(saveHistory, 5 * 60 * 1000).unref();
  setInterval(() => rememberedDirty && saveRemembered(), 5 * 60 * 1000).unref(); // "last used"
  setInterval(backupTick, 30 * 1000).unref();
  setTimeout(updatesTick, 2 * 60 * 1000).unref(); // after the first polls, so Proxmox nodes are known
  setInterval(updatesTick, 5 * 60 * 1000).unref();
  const shutdown = () => {
    try {
      saveEnergy();
      saveHistory();
      saveAlertState();
      if (rememberedDirty) saveRemembered();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => fatal(e && e.stack ? e.stack : String(e)));
