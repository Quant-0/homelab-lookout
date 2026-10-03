'use strict';
// Energy report and CSV export: month by day, year by month, previous period, per device, both
// CSV formats, formula-safe text, visibility, and live per-device logging.
// test/run.js calls seed() on the data directory before the server starts.
const fs = require('node:fs');
const path = require('node:path');

const TITAN = 'cccccccc-0000-4000-8000-000000000001';
const SW = 'cccccccc-0000-4000-8000-000000000002';
const EVIL = 'cccccccc-0000-4000-8000-000000000003';
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ devices: [
    { id: TITAN, name: 'titan', kind: 'server', location: 'none', u: null, height: 2 },
    { id: SW, name: 'USW-24-POE', kind: 'switch', location: 'none', u: null, height: 1 },
    { id: EVIL, name: '=HYPERLINK("http://x")', kind: 'other', location: 'none', u: null, height: 1 },
  ] }), { mode: 0o600 });
  const buckets = {};
  // September 2026 in Oslo: every hour 0.25 kWh at 100 øre/kWh, plus 0.02 kWh estimated
  for (let t = Date.parse('2026-09-01T00:00:00+02:00'); t < Date.parse('2026-10-01T00:00:00+02:00'); t += 3600e3) {
    buckets[t] = { wh: 250, ore: 25, unpricedWh: 0, estWh: 20, estOre: 2, dev: { [TITAN]: { wh: 200, ore: 20 }, [SW]: { wh: 50, ore: 5, estWh: 20, estOre: 2 }, [EVIL]: { wh: 0.5, ore: 0.05 } } };
  }
  // one day in September 2025, before per-device logging existed
  for (let t = Date.parse('2025-09-10T00:00:00+02:00'); t < Date.parse('2025-09-11T00:00:00+02:00'); t += 3600e3) buckets[t] = { wh: 100, ore: 10, unpricedWh: 0 };
  fs.writeFileSync(path.join(dir, 'energy.json'), JSON.stringify({ buckets }), { mode: 0o600 });
}
module.exports = { seed };

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) < 0.01;

async function run() {
  let r = await req('GET', '/api/energy/report?period=2026-09', undefined, { anon: true });
  ok(r.status === 401, 'the report follows the dashboard: private means login');
  r = await req('GET', '/energy', undefined, { anon: true });
  ok(r.status === 303 && /next=energy/.test(r.headers.get('location')), 'the page sends you to log in');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // a month, by day
  r = await req('GET', '/api/energy/report?period=2026-09');
  let x = r.json;
  ok(x.kind === 'month' && x.by === 'day' && x.rows.length === 30 && x.rows[0].key === '2026-09-01' && near(x.rows[0].kwh, 6) && near(x.rows[0].cost, 6), `September by day: 30 rows, 6 kWh and 6 kr each (${x.rows[0].kwh} kWh)`);
  ok(near(x.totals.kwh, 180) && near(x.totals.cost, 180) && x.totals.avgPrice === 100, `totals: ${x.totals.kwh} kWh, ${x.totals.cost} kr, ${x.totals.avgPrice} øre/kWh`);
  ok(x.devices[0].name === 'titan' && near(x.devices[0].kwh, 144) && near(x.devices[1].estKwh, 14.4), 'per device, largest first: titan 144 kWh; the switch with its estimate');
  ok(x.previous.period === '2026-08' && x.previous.totals.kwh === 0 && x.periods.months.includes('2026-09') && x.periods.years.includes('2025'), 'previous month and the periods with data');

  // a year, by month, compared with the year before
  r = await req('GET', '/api/energy/report?period=2026');
  x = r.json;
  ok(x.kind === 'year' && x.by === 'month' && x.rows.length === 12 && near(x.rows[8].kwh, 180) && x.rows[8].key === '2026-09', '2026 by month: September 180 kWh');
  ok(x.previous.period === '2025' && near(x.previous.totals.kwh, 2.4), 'compared with 2025 (2.4 kWh)');
  r = await req('GET', '/api/energy/report?period=2025-13');
  ok(r.status === 400, 'invalid period rejected');

  // estimates count once enabled
  const power = (await req('GET', '/api/admin/config')).json.settings.power;
  await req('PUT', '/api/admin/settings', { power: { ...power, includeEstimates: true } });
  r = await req('GET', '/api/energy/report?period=2026-09');
  ok(near(r.json.totals.kwh, 194.4) && r.json.includeEstimates, `with estimates: ${r.json.totals.kwh} kWh`);
  await req('PUT', '/api/admin/settings', { power: { ...power, includeEstimates: false } });

  // CSV
  r = await req('GET', '/api/energy/export?period=2026-09&by=day&format=no');
  let lines = r.text.split('\r\n');
  ok(r.headers.get('content-type').startsWith('text/csv') && /attachment; filename="energy-2026-09-per-day-excel\.csv"/.test(r.headers.get('content-disposition')), 'Excel CSV comes as a file download');
  const bytes = Buffer.from(await (await fetch(`${BASE}/api/energy/export?period=2026-09&by=day&format=no`, { headers: { Cookie: cookie } })).arrayBuffer());
  ok(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && lines[0].replace(/^\uFEFF/, '') === 'Date;kWh;Cost (kr);Average price (øre/kWh);kWh without price', 'Norwegian Excel: BOM (so Excel reads æøå), semicolons');
  ok(lines[1] === '2026-09-01;6,000;6,00;100,0;0,000' && lines[31] === 'Total;180,000;180,00;100,0;0,000', `decimal comma: ${lines[1]}`);
  ok(lines.includes('titan;144,000;144,00;0,000;0,00') && lines.some((l) => l.startsWith('"\'=HYPERLINK(""http://x"")";')), 'device rows; a name starting with = cannot run as a formula');
  r = await req('GET', '/api/energy/export?period=2026-09&by=day&format=std');
  lines = r.text.split('\r\n');
  ok(lines[0] === 'Date,kWh,Cost (kr),Average price (øre/kWh),kWh without price' && lines[1] === '2026-09-01,6.000,6.00,100.0,0.000', 'standard CSV: commas and decimal points');
  r = await req('GET', '/api/energy/export?period=2026&by=month&format=std');
  lines = r.text.split('\r\n');
  ok(lines[0].startsWith('Month,') && lines.includes('2026-09,180.000,180.00,100.0,0.000') && !lines.some((l) => l.startsWith('2026-12')), 'per month for a year, without months still to come');
  r = await req('GET', '/api/energy/export?period=2026-09&by=month&format=std');
  ok(r.status === 400 && /needs a year/.test(r.json.error), 'per month needs a year');

  // live per-device logging (two readings make the first interval)
  const dev = (await req('POST', '/api/admin/devices', { name: 'orion', kind: 'server', location: 'none', connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] })).json.device;
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, refreshSeconds: 10 } });
  let orion = null;
  for (let i = 0; i < 30 && !orion; i++) {
    await sleep(1000);
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    orion = (await req('GET', `/api/energy/report?period=${month}`)).json.devices.find((d) => d.id === dev.id && d.kwh > 0);
  }
  ok(orion && orion.name === 'orion', `live readings are logged per device (${orion ? `${(orion.kwh * 1000).toFixed(2)} Wh` : 'none'})`);

  // public dashboard: visitors may see the report too
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: true } });
  r = await req('GET', '/api/energy/report?period=2026-09', undefined, { anon: true });
  ok(r.status === 200 && r.json.loggedIn === false, 'public dashboard: the report is public too');
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: false } });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ENERGY TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) run();
