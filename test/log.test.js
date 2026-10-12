'use strict';
// The change log (what changed, when and by whom), the public IP with its change notice, and the
// internet provider's logo (found from the registry record, from a link, or none).
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const MOCK = 'https://127.0.0.1:18443';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the mock's own certificate, for switching its public IP
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const setWan = (ip) => fetch(`${MOCK}/__wan?ip=${encodeURIComponent(ip)}`);
const log = async (q = '') => (await req('GET', `/api/admin/events${q}`)).json;
const find = (l, re) => l.events.find((e) => re.test(e.text));

(async () => {
  await setWan('203.0.113.45');
  let r = await req('GET', '/api/admin/events');
  ok(r.status === 401, 'the log needs an admin login');
  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong' });
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  let l = await log();
  ok(find(l, /^Dashboard started$/) && l.categories.includes('network') && l.keepDays === 365, 'the log has the start, its categories and keeps a year');
  ok(find(l, /^Failed sign-in from/) && find(l, /^Signed in from/)?.by === 'admin', 'failed and successful sign-ins are logged, with the user');

  // settings: what changed, from → to
  const cfg = (await req('GET', '/api/admin/config')).json;
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, title: 'My Lab', refreshSeconds: 10, carrierLogo: { kind: 'none' } } });
  l = await log('?cat=settings');
  const st = find(l, /^Settings changed/);
  ok(st && /Dashboard › title: Homelab Lookout → My Lab/.test(st.detail) && st.by === 'admin', `a settings change says what changed (${st?.detail})`);
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, title: 'My Lab', refreshSeconds: 10, carrierLogo: { kind: 'none' } } });
  ok((await log('?cat=settings')).events.filter((e) => /^Settings changed/.test(e.text)).length === 1, 'saving without changes adds nothing');

  // devices: added, changed (with what), moved, a change no route describes gets a line too
  r = await req('POST', '/api/admin/devices', { name: 'gw', kind: 'gateway', location: 'rack', u: 12, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', secret: 'unifipass', tlsMode: 'pin', fingerprint: FP }] });
  const gw = r.json.device;
  r = await req('PUT', `/api/admin/devices/${gw.id}`, { ...gw, name: 'edge', connections: undefined });
  r = await req('PUT', `/api/admin/devices/${gw.id}/placement`, { location: 'rack', u: 11, height: 1 });
  r = await req('PUT', '/api/admin/layout', { v: 3, items: [], hidden: [] });
  l = await log('?cat=devices');
  ok(find(l, /^Device added: gw/), 'a new device is logged');
  ok(/Name: gw → edge/.test(find(l, /^Device updated: edge/)?.detail || ''), 'a device change says what changed');
  ok(find(l, /^Device moved: edge/)?.detail === 'rack U12 → rack U11', 'moving a device in the rack is logged');
  l = await log();
  ok(!l.text && JSON.stringify(l).includes('unifipass') === false, 'no password in the log');
  ok(l.events.some((e) => /^Changed: Home layout$/.test(e.text) && e.by === 'admin'), 'a change without its own description still gets a line');

  // filters and search
  l = await log('?q=my%20lab');
  ok(l.events.length >= 1 && l.events.every((e) => `${e.text} ${e.detail}`.toLowerCase().includes('my lab')), 'search finds by text and details');
  l = await log('?cat=sign-in');
  ok(l.events.length >= 2 && l.events.every((e) => e.cat === 'sign-in'), 'the category filter');
  r = await req('GET', '/api/admin/events.csv?cat=settings');
  ok(/text\/csv/.test(r.headers.get('content-type')) && r.text.includes('"Time (UTC)","Category","What","Details","By"') && r.text.includes('My Lab'), 'CSV download with the filter');

  // --- public IP and its change notice ---
  await sleep(2500);
  let d = (await req('GET', '/api/dashboard')).json;
  let uh = d.unifi.find((h) => h.data?.health);
  for (let i = 0; i < 40 && !uh; i++) {
    await sleep(300);
    d = (await req('GET', '/api/dashboard')).json;
    uh = d.unifi.find((h) => h.data?.health);
  }
  if (!uh) console.log('  unifi:', JSON.stringify(d.unifi).slice(0, 400));
  ok(uh.data.health.wan.ip === '203.0.113.45' && d.notices.length === 0, 'the public IP is on the dashboard; the first one seen is no notice');
  ok(find(await log('?cat=network'), /^Public IP: 203\.0\.113\.45 \(Fiberlink\)$/), 'the first public IP is logged');
  await setWan('203.0.113.99');
  let n = null;
  for (let i = 0; i < 50 && !n; i++) { // the next poll (every 10 s)
    await sleep(300);
    d = (await req('GET', '/api/dashboard')).json;
    n = d.notices.find((x) => x.kind === 'ip');
  }
  ok(n && n.detail === '203.0.113.45 → 203.0.113.99', `a new public IP becomes a notice (${n?.detail})`);
  ok(find(await log('?cat=network'), /^Public IP changed: 203\.0\.113\.45 → 203\.0\.113\.99/), 'and a line in the log');
  // visitors (public dashboard) see neither the IP nor the notice
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, title: 'My Lab', refreshSeconds: 10, public: true, carrierLogo: { kind: 'none' } } });
  const saved = cookie;
  cookie = '';
  r = await req('GET', '/api/dashboard');
  ok(r.status === 200 && r.json.notices.length === 0 && !r.text.includes('203.0.113.99'), 'a visitor gets no notice and no IP');
  r = await req('DELETE', `/api/admin/notices/${n.id}`);
  ok(r.status === 401 || r.status === 403, 'only an admin can close it');
  cookie = saved;
  r = await req('DELETE', `/api/admin/notices/${n.id}`);
  d = (await req('GET', '/api/dashboard')).json;
  ok(r.status === 200 && d.notices.length === 0, 'an admin closes it for everyone');
  ok(find(await log('?cat=network'), /^Notice closed: Public IP changed \(203\.0\.113\.45 → 203\.0\.113\.99\)$/)?.by === 'admin', 'closing it is logged');

  // --- the provider's logo ---
  r = await req('POST', '/api/admin/carrier-logo/url', { url: `${MOCK}/redirect-logo` });
  ok(r.status === 201 && /^[0-9a-f]{32}$/.test(r.json.icon?.id), 'a logo from a link (after a redirect) is fetched and kept');
  const linked = r.json.icon.id;
  r = await req('POST', '/api/admin/carrier-logo/url', { url: 'http://127.0.0.1:18443/logo.png' });
  ok(r.status === 400 && /https/.test(r.json.error), 'only https links');
  r = await req('POST', '/api/admin/carrier-logo/url', { url: 'https://example.com/logo.png' });
  ok(r.status === 400, 'other hosts are not reached from the tests');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...cfg.settings.dashboard, title: 'My Lab', refreshSeconds: 10, public: false, carrierLogo: { kind: 'file', id: linked } } });
  d = (await req('GET', '/api/dashboard')).json;
  ok(d.carrierLogo === `/media/icon/${linked}`, 'the linked logo is used on Home');
  r = await req('POST', '/api/admin/carrier-logo/auto', {});
  ok(r.status === 200 && r.json.carrier.isp === 'Fiberlink' && /fiberlink\.invalid/.test(`${r.json.carrier.error} ${(r.json.carrier.tried || []).join(' ')}`), `automatic: the registry record names the provider's website (${r.json.carrier.error})`);
  ok(find(await log('?cat=network'), /^No logo found for Fiberlink$/), 'a lookup that finds nothing is logged');
  ok((await req('GET', '/api/admin/config')).json.settings.dashboard.carrierLogo.kind === 'auto', '"Find again" switches to automatic');

  // a connection that stops answering only counts as down after the grace period (12 s here)
  r = await req('POST', '/api/admin/devices', { name: 'slowbmc', kind: 'server', location: 'outside', connections: [{ type: 'idrac', address: '127.0.0.1:1', username: 'root', secret: 'x', tlsMode: 'pin', fingerprint: FP }] });
  const slow = r.json.device;
  let firstFail = null;
  for (let i = 0; i < 40 && !firstFail; i++) {
    await sleep(250);
    const host = (await req('GET', '/api/dashboard')).json.idrac.find((x) => x.ok === false);
    if (host) firstFail = Date.now();
  }
  d = (await req('GET', '/api/dashboard')).json;
  ok(firstFail && !d.attention.some((a) => a.type === 'offline' && a.subject === 'slowbmc'), 'one failed poll is not "not answering" yet');
  let down = null;
  for (let i = 0; i < 120 && !down; i++) {
    await sleep(250);
    d = (await req('GET', '/api/dashboard')).json;
    down = d.attention.find((a) => a.type === 'offline' && a.subject === 'slowbmc');
  }
  ok(down && Date.now() - firstFail >= 10000, `still failing after the grace period: now it is (${Math.round((Date.now() - firstFail) / 1000)} s)`);
  await req('DELETE', `/api/admin/devices/${slow.id}`);

  console.log(failures ? `\n${failures} FAILED` : '\nALL LOG TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
