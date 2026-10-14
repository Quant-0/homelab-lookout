'use strict';
// Longer history and the monthly report. A backup is taken, given two months of history and past
// incidents, and restored: then the daily tier (also made from older 2-hour points), the 1-year
// graphs, the storage forecast with its early warning, and the report are checked.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const PASS = 'a long backup passphrase';
const DAY = 86400e3;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body, { raw, headers = {}, anon = false } = {}) {
  const h = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers };
  const r = await fetch(BASE + p, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, buf, headers: r.headers };
}
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(500);
  }
}
const keyOf = (salt) => crypto.scryptSync(PASS, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(buf.subarray(8, 24)), buf.subarray(24, 36));
  d.setAAD(buf.subarray(0, 8));
  d.setAuthTag(buf.subarray(36, 52));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(52)), d.final()])));
}
function encrypt(bundle, magic) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(salt), iv);
  c.setAAD(magic);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(bundle)))), c.final()]);
  return Buffer.concat([magic, salt, iv, c.getAuthTag(), body]);
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, refreshSeconds: 10 } });

  // a TrueNAS (its pools are storage), a service that answers and one that doesn't
  const nas = (await req('POST', '/api/admin/devices', { name: 'vault', kind: 'storage', location: 'none', connections: [{ type: 'truenas', address: '127.0.0.1:18443', tlsMode: 'pin', fingerprint: FP, username: 'truenas_admin', secret: '1-abcdefKEY' }] })).json.device;
  const up = (await req('POST', '/api/admin/services', { name: 'Jellyfin', group: 'Media', icon: { kind: 'letter' }, connection: null, integration: null, monitor: { type: 'ping', host: '127.0.0.1' } })).json.service;
  const down = (await req('POST', '/api/admin/services', { name: 'Grafana', group: 'Monitoring', icon: { kind: 'letter' }, connection: null, integration: null, monitor: { type: 'ping', host: '127.0.0.1' } })).json.service;
  const conf = (await req('GET', '/api/admin/config')).json;
  const host = conf.hosts.find((h) => h.deviceId === nas.id);
  const pools = await until(async () => (await req('GET', '/api/dashboard')).json.truenas?.[0]?.data?.pools);
  ok(pools?.length, `TrueNAS pools read (${pools?.map((p) => p.name).join(', ')})`);
  const pool = pools[0].name;

  // --- the backup with history added ---
  const file = (await req('POST', '/api/admin/backup/download', { passphrase: PASS })).buf;
  const bundle = decrypt(file);
  const now = Date.now();
  const today = Math.floor(now / DAY) * DAY;
  const series = bundle.history.series;
  // 60 days of 2-hour power points, no daily ones: the daily tier is made from them
  series['power:total'] = { m: [], q: [], h: Array.from({ length: 60 * 12 }, (_, i) => [Math.floor((now - (60 * 12 - i) * 2 * 3600e3) / 7200e3) * 7200e3, 200 + (i % 12) * 5]), acc: {}, seen: now };
  // 20 days of the pool filling 3 percentage points a day, up to where it is now
  const nowPct = (100 * pools[0].allocated) / pools[0].size;
  series[`disk:${host.id}:${pool}`] = { m: [], q: [], h: [], d: Array.from({ length: 20 }, (_, i) => [today - (20 - i) * DAY, Math.round((nowPct - 3 * (20 - i)) * 100) / 100]), dmin: [], dmax: [], acc: {}, seen: now };
  // last month: Jellyfin always up, Grafana down for half of three days
  const lm = new Date(now);
  const last = { y: lm.getUTCMonth() === 0 ? lm.getUTCFullYear() - 1 : lm.getUTCFullYear(), m: lm.getUTCMonth() === 0 ? 12 : lm.getUTCMonth() };
  const period = `${last.y}-${String(last.m).padStart(2, '0')}`;
  const from = Date.UTC(last.y, last.m - 1, 1);
  const days = (Date.UTC(last.y, last.m, 1) - from) / DAY;
  series[`upsvc:${up.id}`] = { m: [], q: [], h: [], d: Array.from({ length: days }, (_, i) => [from + i * DAY, 1]), dmin: [], dmax: [], acc: {}, seen: now };
  series[`upsvc:${down.id}`] = { m: [], q: [], h: [], d: Array.from({ length: days }, (_, i) => [from + i * DAY, i < 3 ? 0.5 : 1]), dmin: [], dmax: [], acc: {}, seen: now };
  series[`uphost:${host.id}`] = { m: [], q: [], h: [], d: Array.from({ length: days }, (_, i) => [from + i * DAY, i === 10 ? 0.75 : 1]), dmin: [], dmax: [], acc: {}, seen: now };
  const inc = (title, start, mins, extra = {}) => ({ id: crypto.randomBytes(8).toString('hex'), key: `service:${down.id}:${start}`, type: 'service', severity: 'critical', title, subject: 'Grafana', deviceId: null, serviceId: down.id, start, end: start + mins * 60e3, ack: null, behind: null, maintenance: null, ...extra });
  bundle.incidents = [...(bundle.incidents || []),
    inc('Grafana is down', from + 0.5 * DAY, 720, { ack: { at: from + 0.6 * DAY, by: 'admin', via: 'dashboard' } }),
    inc('Grafana is down', from + 1.5 * DAY, 720),
    inc('Grafana is down', from + 2.5 * DAY, 30, { behind: 'core-switch' }),
  ];
  let r = await req('POST', '/api/admin/backup/restore', undefined, { raw: encrypt(bundle, file.subarray(0, 8)), headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(PASS) } });
  ok(r.status === 200, `restored with two months of history (${r.json?.error || 'ok'})`);
  csrf = (await req('GET', '/api/session')).json?.csrf || csrf;

  // --- long graphs ---
  r = await req('GET', '/api/history?keys=power:total&range=1y&points=500');
  const pts = r.json.series['power:total'];
  ok(pts.length >= 55 && pts[0][0] < now - 55 * DAY && pts.every(([t]) => t % DAY === 0), `1 year: daily points, made from the 2-hour ones (${pts.length} days)`);
  ok(pts.every(([, v]) => v >= 200 && v <= 255), 'each day is the average of its points');
  r = await req('GET', '/api/history?keys=power:total&range=90d&points=500');
  ok(r.json.series['power:total'].length > 300, '90 days: still the 2-hour points');

  // --- the forecast and its early warning ---
  const warn = await until(async () => (await req('GET', '/api/dashboard')).json.attention.find((a) => /will be full in about \d+ days/.test(a.text) && a.deviceId === nas.id), 20000);
  ok(warn && warn.severity === 'warning' && /growing 90 percentage points a month/.test(warn.detail), `an early warning: ${warn?.text} (${warn?.detail})`);
  const dev = (await req('GET', '/api/dashboard')).json.devices.find((d) => d.id === nas.id);
  ok(dev.growing?.some((x) => x.label === `pool ${pool}` && x.forecast.perMonth === 90 && x.forecast.days != null), 'the device details list what is filling up');

  // --- the report ---
  r = await req('GET', `/api/report?period=${period}`);
  const rep = r.json;
  ok(r.status === 200 && rep.period === period && rep.periods.includes(period), `the report for ${period}`);
  const sJ = rep.services.find((x) => x.name === 'Jellyfin');
  const sG = rep.services.find((x) => x.name === 'Grafana');
  ok(sJ?.uptime === 100 && sJ.downMin === 0 && sJ.days === days, 'Jellyfin: 100 %, no downtime');
  ok(sG && Math.abs(sG.uptime - (100 - (150 / days))) < 0.01 && sG.downMin === 2160 && sG.incidents === 2 && rep.services[0].name === 'Grafana', `Grafana: ${sG?.uptime} %, 36 h down, 2 problems, listed first`);
  const dV = rep.devices.find((x) => x.name === 'vault');
  ok(dV && dV.downMin === 360, `vault: down 6 hours (${dV?.downMin} min)`);
  const sum = rep.summary.incidents;
  ok(sum.total === 2 && sum.critical === 2 && sum.acknowledged === 1 && sum.minutes === 1440 && sum.meanClearMin === 720 && sum.muted === 1, `problems: 2 (one behind an outage not counted), 24 h, cleared in 12 h on average (${JSON.stringify(sum)})`);
  ok(rep.longest.length === 2 && rep.longest[0].inMonthMin === 720, 'the longest problems');
  ok(rep.storage.some((x) => x.label === `pool ${pool}` && x.forecast?.perMonth === 90), 'storage with its growth');
  ok(rep.energy && 'kwh' in rep.energy && 'previous' in rep.energy, 'energy and cost with last month');
  r = await req('GET', '/api/report?period=2026-13');
  ok(r.status === 400, 'a month that does not exist');

  // --- who may see it ---
  r = await req('GET', '/api/report', undefined, { anon: true });
  ok(r.status === 401, 'the report needs a sign-in');
  r = await req('GET', '/report', undefined, { anon: true });
  ok(r.status === 303 && /next=report/.test(r.headers.get('location')), 'the page sends to sign-in, and back');

  console.log(failures ? `\n${failures} FAILED` : '\nALL REPORT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
