'use strict';
// The logo (default, a built-in icon in a colour, an uploaded image or SVG), the internet provider
// on Home and snoozing a warning at the top of Home for everyone.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, raw) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, json, text: buf.toString('utf8'), headers: r.headers, buf };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  // --- logo, before signing in: the default, for the sign-in page ---
  let r = await req('GET', '/logo');
  ok(r.status === 200 && /image\/svg/.test(r.headers.get('content-type')) && r.text.includes('<svg'), 'the default logo is served to anyone (sign-in page, browser tab)');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const st = (await req('GET', '/api/admin/config')).json;
  ok(st.logoIcons?.includes('server') && st.logoColors?.blue, 'Admin gets the built-in logo icons and colours');
  const ap = st.settings.appearance;
  ok(ap.logo?.kind === 'default', 'logo starts as the default');

  // a built-in icon in a colour, drawn by the server
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: { kind: 'icon', name: 'house', color: 'green' } } });
  ok(r.status === 200 && r.json.settings.appearance.logo.name === 'house', 'a built-in icon can be chosen');
  r = await req('GET', '/logo');
  ok(r.text.includes('#34c46a') && r.text.includes('<path') && /sandbox/.test(r.headers.get('content-security-policy')), 'the icon logo is an SVG in the chosen colour, with a sandboxing CSP');
  const etag = r.headers.get('etag');
  r = await fetch(BASE + '/logo', { headers: { 'If-None-Match': etag } });
  ok(r.status === 304, 'the logo answers 304 when unchanged');
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: { kind: 'icon', name: 'not-an-icon', color: 'green' } } });
  ok(r.status === 400, 'an unknown icon is refused');
  // the Customize drawer sends appearance without a logo: it is kept
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: undefined } });
  ok(r.json.settings.appearance.logo.name === 'house', 'saving appearance without a logo keeps the logo');

  // uploads: PNG, a plain SVG, and SVGs with script or links refused
  r = await req('POST', '/api/admin/logo', PNG, true);
  ok(r.status === 201 && /^[0-9a-f]{32}$/.test(r.json.icon.id), 'a PNG logo uploads');
  const png = r.json.icon.id;
  const plain = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>\n';
  r = await req('POST', '/api/admin/logo', Buffer.from(plain), true);
  ok(r.status === 201, 'a plain SVG logo uploads (internal references are fine)');
  const svgId = r.json.icon?.id;
  for (const [what, bad] of [
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>'],
    ['an outside link', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>'],
    ['an outside stylesheet', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/a.css);</style></svg>'],
    ['embedded HTML', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>'],
    ['an entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['not an image', 'hello'],
  ]) {
    r = await req('POST', '/api/admin/logo', Buffer.from(bad), true);
    ok(r.status === 400, `an SVG with ${what} is refused`);
  }
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: { kind: 'file', id: svgId } } });
  r = await req('GET', '/logo');
  ok(r.text === plain && /sandbox/.test(r.headers.get('content-security-policy')) && r.headers.get('x-content-type-options') === 'nosniff', 'the SVG logo is served as uploaded, sandboxed');
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: { kind: 'file', id: png } } });
  r = await req('GET', '/logo');
  ok(r.headers.get('content-type') === 'image/png' && r.buf.length > 0, 'the PNG logo is served as a PNG');
  r = await req('PUT', '/api/admin/settings', { appearance: { ...ap, logo: { kind: 'file', id: 'f'.repeat(32) } } });
  ok(r.status === 400, 'a logo image that does not exist is refused');
  r = await req('GET', '/');
  ok(r.text.includes('<link rel="icon" href="/logo">'), 'pages use /logo as the browser tab icon');

  // --- internet provider ---
  r = await req('POST', '/api/admin/devices', { name: 'gw', kind: 'gateway', location: 'rack', u: 12, height: 1, connections: [{ type: 'unifi', address: '127.0.0.1:18443', username: 'viewer', secret: 'unifipass', tlsMode: 'pin', fingerprint: FP }] });
  r = await req('POST', '/api/admin/devices', { name: 'titan', kind: 'server', location: 'rack', u: 1, height: 2, connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', secret: 'calvin', tlsMode: 'pin', fingerprint: FP }] });
  await sleep(3000);
  let d = (await req('GET', '/api/dashboard')).json;
  const uh = d.unifi.find((h) => h.data?.health);
  ok(uh?.data.health.wan.isp === 'Fiberlink' && d.carrier === null, 'the provider UniFi reports is on the dashboard');
  ok(uh.data.health.internet.rxMbps === 142 && uh.data.health.internet.txMbps === 18, `traffic now through the gateway, in Mbit/s (${uh.data.health.internet.rxMbps}/${uh.data.health.internet.txMbps})`);
  const hist = (await req('GET', `/api/history?range=24h&points=120&keys=${encodeURIComponent(`unifi:${uh.id}:wan:down,unifi:${uh.id}:wan:up`)}`)).json.series;
  ok(hist[`unifi:${uh.id}:wan:down`]?.at(-1)?.[1] === 142 && hist[`unifi:${uh.id}:wan:up`]?.at(-1)?.[1] === 18, 'download and upload are kept as history for the graph');
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, carrier: '  Telia  ' } });
  ok(r.status === 200 && r.json.settings.dashboard.carrier === 'Telia', 'a provider set in Admin is saved (trimmed)');
  d = (await req('GET', '/api/dashboard')).json;
  ok(d.carrier === 'Telia', 'and is sent to Home instead');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, carrier: 'x'.repeat(61) } });
  ok(r.status === 400, 'a provider name over 60 characters is refused');

  // --- snooze ---
  const warn = d.attention.find((a) => a.subject === 'titan' && /PS2/.test(a.text));
  ok(warn && warn.key && warn.snoozedUntil === null, `a warning to snooze: ${warn?.key}`);
  r = await req('POST', '/api/admin/snooze', { key: warn.key, days: 3 });
  ok(r.status === 400, 'only 1 day or 1 week');
  r = await req('POST', '/api/admin/snooze', { key: 'hardware:nope', days: 1 });
  ok(r.status === 400, 'a warning that is not active cannot be snoozed');
  r = await req('POST', '/api/admin/snooze', { key: warn.key, days: 7 });
  const week = Date.now() + 7 * 864e5;
  ok(r.status === 200 && Math.abs(r.json.snoozedUntil - week) < 60000, 'snoozed for a week');
  d = (await req('GET', '/api/dashboard')).json;
  const after = d.attention.find((a) => a.key === warn.key);
  ok(after && Math.abs(after.snoozedUntil - week) < 60000, 'the dashboard still lists it, marked snoozed (the device keeps showing it)');
  const saved = cookie;
  cookie = '';
  const savedCsrf = csrf;
  csrf = '';
  r = await req('POST', '/api/admin/snooze', { key: warn.key, days: 1 });
  ok(r.status === 401 || r.status === 403, 'snoozing needs an admin login');
  cookie = saved;
  csrf = savedCsrf;
  r = await req('POST', '/api/admin/snooze', { key: warn.key, days: 0 });
  d = (await req('GET', '/api/dashboard')).json;
  ok(r.status === 200 && d.attention.find((a) => a.key === warn.key).snoozedUntil === null, 'it can be shown again');

  // leave an uploaded logo and provider logo in place: the next suite restarts the server and checks them
  const cfgNow = (await req('GET', '/api/admin/config')).json.settings;
  r = await req('PUT', '/api/admin/settings', { appearance: { ...cfgNow.appearance, logo: { kind: 'file', id: png } }, dashboard: { ...cfgNow.dashboard, carrierLogo: { kind: 'file', id: png } } });
  ok(r.status === 200 && r.json.settings.appearance.logo.id === png && r.json.settings.dashboard.carrierLogo.id === png, 'an uploaded logo and provider logo are saved');

  console.log(failures ? `\n${failures} FAILED` : '\nALL BRANDING TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
