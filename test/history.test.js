'use strict';
// History graphs: tiers and downsampling, key validation, visibility, live recording from polls.
// test/run.js calls seed() on the data directory before the server starts.
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const BAD_ID = '00000000-0000-4000-8000-000000000001';
const MIN = 60e3;

// Two months of a fake power series, plus things a hand-edited or old file might contain
function seed(dir) {
  const now = Date.now();
  const tierData = (step, count) => Array.from({ length: count }, (_, i) => [Math.floor((now - (count - i + 1) * step) / step) * step, 200 + (i % 10)]);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
    series: {
      'power:total': { m: tierData(MIN, 300), q: tierData(15 * MIN, 7 * 96), h: tierData(2 * 60 * MIN, 60 * 12), acc: {}, seen: now },
      [`idrac:${BAD_ID}:watts`]: { m: [[now - 5 * MIN, 'x'], [now - 4 * MIN, 150], [1, 2, 3]], q: 'nope', h: null, acc: { m: { t: 'a' } }, seen: now },
      'evil:key': { m: [[now, 1]], q: [], h: [], acc: {}, seen: now },
    },
  }), { mode: 0o600 });
}
module.exports = { seed };

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hist = (keys, range = '24h', points = 120, opts) => req('GET', `/api/history?range=${range}&points=${points}&keys=${encodeURIComponent(keys.join(','))}`, undefined, opts);
const ascending = (pts) => pts.every((p, i) => i === 0 || p[0] > pts[i - 1][0]);

async function run() {
  let r = await hist(['power:total'], '24h', 120, { anon: true });
  ok(r.status === 401, 'history needs login while the dashboard is private');

  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- tiers and downsampling ---
  r = await hist(['power:total']);
  let pts = r.json.series['power:total'];
  ok(r.status === 200 && pts.length === 120, `24 h: 300 one-minute points averaged down to ${pts.length}`);
  ok(ascending(pts) && pts.every(([t, v]) => Number.isFinite(t) && v >= 200 && v <= 209), '24 h: points in time order, averages within the value range');
  r = await hist(['power:total'], '7d');
  pts = r.json.series['power:total'];
  ok(pts.length === 120 && pts[0][0] >= Date.now() - 7 * 86400e3 - 15 * MIN, `7 d: 15-minute tier, ${pts.length} points`);
  r = await hist(['power:total'], '30d');
  pts = r.json.series['power:total'];
  ok(pts.length === 120 && pts[0][0] >= Date.now() - 30 * 86400e3 - 2 * 3600e3 && ascending(pts), `30 d: 2-hour tier limited to 30 days, ${pts.length} points`);
  r = await hist(['power:total'], '90d', 500);
  pts = r.json.series['power:total'];
  ok(pts.length === 500 && pts[0][0] < Date.now() - 59 * 86400e3, `90 d at 500 points: all 60 days, averaged down to ${pts.length}`);
  r = await hist(['power:total'], 'forever', 99999);
  ok(r.json.series['power:total'].length <= 500, 'unknown range falls back to 24 h; points capped at 500');

  // --- key validation and cleaning ---
  r = await hist(['evil:key', '../config', 'power:total']);
  ok(Object.keys(r.json.series).join() === 'power:total', 'unknown keys are ignored');
  r = await hist(Array.from({ length: 100 }, (_, i) => `pve:${BAD_ID}:node${i}:cpu`));
  ok(Object.keys(r.json.series).length === 80, 'at most 80 series per request');
  r = await hist([`idrac:${BAD_ID}:watts`]);
  ok(JSON.stringify(r.json.series[`idrac:${BAD_ID}:watts`]) === JSON.stringify([[r.json.series[`idrac:${BAD_ID}:watts`][0]?.[0], 150]]), 'malformed points in the file are dropped on load');

  // --- live recording from polls ---
  r = await req('POST', '/api/admin/devices', { name: 'Orion', kind: 'server', location: 'none', connections: [
    { type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  const hostId = (await req('GET', '/api/admin/config')).json.hosts.find((h) => h.deviceId === r.json.device.id).id;
  const keys = [`idrac:${hostId}:watts`, `idrac:${hostId}:inlet`, `idrac:${hostId}:tmax`];
  let series = {};
  for (let i = 0; i < 40; i++) {
    series = (await hist(keys)).json.series;
    if (keys.every((k) => series[k]?.length)) break;
    await sleep(250);
  }
  const watts = series[keys[0]]?.at(-1)?.[1];
  ok(watts >= 212 && watts <= 232, `iDRAC power draw recorded (${watts} W)`);
  ok(series[keys[1]]?.length && series[keys[2]]?.length && series[keys[2]].at(-1)[1] >= series[keys[1]].at(-1)[1], 'inlet and hottest-sensor temperatures recorded');
  const total = (await hist(['power:total'], '24h', 500)).json.series['power:total'].at(-1);
  ok(total[0] > Date.now() - 2 * MIN && total[1] > 200, `total measured power includes the current minute (${total[1]} W)`);

  // --- public dashboard: history follows the same visibility ---
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: true } });
  r = await hist(['power:total'], '24h', 120, { anon: true });
  ok(r.status === 200 && r.json.series['power:total'].length > 0, 'public dashboard: history readable without login');
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: false } });
  r = await hist(['power:total'], '24h', 120, { anon: true });
  ok(r.status === 401, 'private again: history needs login');

  // --- where it's stored: SQLite where Node has it (the seeded history.json was moved into it) ---
  const want = (() => { try { require('node:sqlite'); return 'sqlite'; } catch { return 'json'; } })();
  const rt = (await req('GET', '/api/admin/config')).json.runtime;
  ok(rt?.history === want && rt.node === process.versions.node && typeof rt.nodeSupported === 'boolean', `history stored as ${rt?.history} on Node ${rt?.node}`);

  // --- the dashboard page asks for the right keys ---
  r = await req('GET', '/static/js/dashboard.js');
  ok(/idrac:\$\{h\.id\}:watts/.test(r.text) && /power:total/.test(r.text), 'dashboard script requests iDRAC and total power history');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL HISTORY TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) run();
