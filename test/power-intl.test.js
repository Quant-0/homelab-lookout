'use strict';
// Electricity prices outside Norway: a fixed price, prices by time of day (in the dashboard's time
// zone), the ENTSO-E spot price converted with the ECB's rates, Tibber, Octopus Agile and a Home
// Assistant sensor (all mocked); VAT, markup, grid fee and taxes; the currency on the pages and in
// the CSV; the keys stay write-only. Norway's plans are untouched.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body) {
  const h = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.01;
let settings = null;
// the power settings, changed as given (intl merged into what is there)
async function power(change, intl = {}) {
  const r = await req('PUT', '/api/admin/settings', { power: { ...settings.power, ...change, intl: { ...settings.power.intl, ...intl } } });
  if (r.status === 200) settings = r.json.settings;
  return r;
}
const status = async () => (await req('GET', '/api/admin/power/status')).json;
const priceNow = async () => (await req('GET', '/api/dashboard')).json.power;
const hourIn = (tz) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const weekdayIn = (tz) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date()));
const hh = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  settings = (await req('GET', '/api/admin/config')).json.settings;
  let p = await priceNow();
  ok(p.currency.code === 'NOK' && p.currency.minor === 'øre' && settings.dashboard.timeZone === 'Europe/Oslo', 'Norway as before: kroner and øre, Oslo time');
  ok(settings.power.intl.currency === 'EUR' && settings.power.intl.source === 'fixed', 'the settings for other countries are there, unused');

  // --- one fixed price, with markup, grid fee and taxes ---
  let r = await power({ plan: 'intl' }, { currency: 'EUR', source: 'fixed', fixedPrice: 0.2, markup: 0.02, taxes: 0.03, enteredInclVat: true, vatPct: 20, grid: { mode: 'fixed', price: 0.05, tou: { other: 0, periods: [] } } });
  p = await priceNow();
  ok(r.status === 200 && p.currency.code === 'EUR' && p.currency.minor === 'c' && near(p.priceNow.total, 30) && p.source.kind === 'fixed', `a fixed price: 0.20 + 0.02 markup + 0.05 grid + 0.03 taxes = 30 c per kWh (${p.priceNow?.total})`);
  await power({}, { enteredInclVat: false });
  p = await priceNow();
  ok(near(p.priceNow.total, 36), `amounts without VAT get the 20 % on top (${p.priceNow?.total})`);
  r = await power({}, { vatPct: 80 });
  ok(r.status === 400 && /VAT/.test(r.json.error), 'VAT is at most 50 %');
  r = await power({}, { currency: 'XYZ' });
  ok(r.status === 200 && settings.power.intl.currency === 'EUR', 'an unknown currency is euro');

  // --- by time of day, in the dashboard's time zone ---
  const H = hourIn('Europe/Oslo');
  const tou = (periods, other = 0.1) => power({}, { source: 'tou', enteredInclVat: true, markup: 0, taxes: 0, grid: { mode: 'none', price: 0, tou: { other: 0, periods: [] } }, tou: { other, periods } });
  await tou([{ name: 'Peak', price: 0.4, days: [0, 1, 2, 3, 4, 5, 6], from: hh(H - 1), to: hh(H + 1) }]);
  p = await priceNow();
  ok(near(p.priceNow.total, 40) && p.priceNow.period === 'Peak', `the period around now (${hh(H - 1)}–${hh(H + 1)}, also past midnight) gives its price (${p.priceNow?.total} ${p.priceNow?.period})`);
  await tou([{ name: 'Peak', price: 0.4, days: [(weekdayIn('Europe/Oslo') + 1) % 7], from: '00:00', to: '24:00' }]);
  p = await priceNow();
  ok(near(p.priceNow.total, 10) && p.priceNow.period === 'Other times', 'a period on another day: the price at other times');
  r = await tou([{ name: 'Bad', price: 0.4, days: [], from: '07:00', to: '09:00' }]);
  ok(r.status === 400 && /at least one day/.test(r.json.error), 'a period needs a day');
  r = await tou([{ name: 'Bad', price: 0.4, days: [1], from: '7', to: '09:00' }]);
  ok(r.status === 400 && /HH:MM/.test(r.json.error), 'times are HH:MM');
  // another time zone: its own hours count
  const T = hourIn('Asia/Tokyo');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...settings.dashboard, timeZone: 'Asia/Tokyo' } });
  ok(r.status === 200 && r.json.settings.dashboard.timeZone === 'Asia/Tokyo', 'the time zone can be changed');
  settings = r.json.settings;
  await tou([{ name: 'Tokyo evening', price: 0.5, days: [0, 1, 2, 3, 4, 5, 6], from: hh(T), to: hh(T + 1) }]);
  p = await priceNow();
  ok(near(p.priceNow.total, 50) && (T === H || p.priceNow.period === 'Tokyo evening'), 'prices by time of day follow the time zone set');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...settings.dashboard, timeZone: 'Mars/Olympus_Mons' } });
  ok(r.status === 400 && /time zone/.test(r.json.error), 'an unknown time zone is refused');
  settings = (await req('PUT', '/api/admin/settings', { dashboard: { ...settings.dashboard, timeZone: 'Europe/Oslo' } })).json.settings;

  // --- ENTSO-E, in Swedish kronor through the ECB's rate ---
  await power({}, { source: 'entsoe', currency: 'SEK', entsoeZone: 'SE3', vatPct: 25, enteredInclVat: true, markup: 0.05, taxes: 0.4, grid: { mode: 'fixed', price: 0.3, tou: { other: 0, periods: [] } } });
  let st = await status();
  ok(st.error === 'Add your ENTSO-E API key' && st.priceNow === null && !st.keys.entsoe, 'without a key it says what is missing, and has no price');
  st = (await req('PUT', '/api/admin/power/keys', { entsoe: 'wrong' })).json;
  ok(/refused the API key/.test(st.error) && st.keys.entsoe, 'a wrong key: ENTSO-E refuses it');
  st = (await req('PUT', '/api/admin/power/keys', { entsoe: 'entsoe-key' })).json;
  ok(!st.error && near(st.priceNow.total, 218.75) && st.slots > 24, `100 €/MWh × 11.5 = 115 öre, + 25 % VAT, + 5 markup + 30 grid + 40 taxes = 218.75 öre (${st.priceNow?.total}); the hours without a point repeat the one before`);
  p = await priceNow();
  ok(p.currency.code === 'SEK' && p.currency.minor === 'öre' && p.source.zone === 'SE3' && !p.source.error, 'Home shows the zone and the currency');
  await power({}, { entsoeZone: 'DK1' });
  st = await status();
  ok(/No matching data found/.test(st.error || ''), 'ENTSO-E\'s own message when it has nothing');
  const cfg = JSON.stringify((await req('GET', '/api/admin/config')).json) + JSON.stringify(await priceNow());
  ok(!cfg.includes('entsoe-key'), 'the key is never sent back');

  // --- Tibber: what it bills, VAT and taxes included ---
  await power({}, { source: 'tibber', currency: 'SEK', markup: 0, taxes: 0, grid: { mode: 'none', price: 0, tou: { other: 0, periods: [] } } });
  st = (await req('PUT', '/api/admin/power/keys', { tibber: 'tibber-token' })).json;
  ok(/bills in EUR/.test(st.error || ''), 'Tibber in another currency than chosen says so');
  await power({}, { currency: 'EUR', vatPct: 25 });
  st = await status();
  ok(!st.error && near(st.priceNow.total, 125), `Tibber's price as it is: 1.25 € = 125 c, no VAT added (${st.priceNow?.total})`);

  // --- Octopus Agile: the newest Agile product, half-hourly, in pence ---
  await power({}, { source: 'octopus', currency: 'GBP', vatPct: 5, octopusRegion: 'C' });
  st = await status();
  p = await priceNow();
  ok(!st.error && near(st.priceNow.total, 21) && p.currency.minor === 'p' && st.slots >= 48, `Octopus: 20 p + 5 % VAT = 21 p (${st.priceNow?.total})`);

  // --- a Home Assistant sensor, read with its unit ---
  r = await power({}, { source: 'hass', currency: 'EUR', vatPct: 25, hass: { url: 'http://127.0.0.1:18090/hassprice', entity: 'not-a-sensor', inclVat: true } });
  ok(r.status === 400 && /sensor\./.test(r.json.error), 'the price sensor must be a sensor entity');
  await power({}, { source: 'hass', currency: 'EUR', vatPct: 25, hass: { url: 'http://127.0.0.1:18090/hassprice', entity: 'sensor.el_price', inclVat: true } });
  st = await status();
  ok(st.error === 'Add a Home Assistant access token', 'it needs a token');
  st = (await req('PUT', '/api/admin/power/keys', { hass: 'ha-token' })).json;
  ok(!st.error && near(st.priceNow.total, 31), `EUR/kWh: 0.31 € = 31 c (${st.priceNow?.total})`);
  await power({}, { hass: { url: 'http://127.0.0.1:18090/hassprice', entity: 'sensor.el_cents', inclVat: false } });
  st = await status();
  ok(near(st.priceNow.total, 38.75), `c/kWh, without VAT: 31 c + 25 % = 38.75 c (${st.priceNow?.total})`);
  await power({}, { hass: { url: 'http://127.0.0.1:18090/hassprice', entity: 'sensor.el_off', inclVat: true } });
  st = await status();
  ok(/not a number/.test(st.error || ''), 'a sensor that is unavailable says so');

  // --- the currency on the energy page and in its CSV ---
  await power({}, { source: 'fixed', currency: 'USD', fixedPrice: 0.15 });
  const rep = (await req('GET', '/api/energy/report')).json;
  ok(rep.currency.code === 'USD' && rep.currency.minor === '¢', 'the energy report carries the currency');
  const csv = await req('GET', `/api/energy/export?period=${rep.period}&format=std`);
  ok(/Cost \(USD\)/.test(csv.text) && /Average price \(¢\/kWh\)/.test(csv.text), 'and so does its CSV');

  // keys removed; back to Norway
  st = (await req('PUT', '/api/admin/power/keys', { entsoe: null, tibber: null, hass: null })).json;
  ok(!st.keys.entsoe && !st.keys.tibber && !st.keys.hass, 'the keys can be removed');
  await power({ plan: 'spot' });
  p = await priceNow();
  ok(p.currency.code === 'NOK' && p.source === null, 'back on a Norwegian plan: kroner again');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INTERNATIONAL POWER TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
