'use strict';
// The installed app's icon drawn from the logo (PNGs from the browser), and a domain name for the
// dashboard: answered on, and used in links.
const http = require('node:http');
const zlib = require('node:zlib');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
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
  return { status: r.status, json, text };
}
// a plain square PNG of one colour
function png(size, rgb = [40, 90, 200]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const b64 = (b) => b.toString('base64');
// a request with another Host header (fetch can't set it)
const asHost = (host, p) => new Promise((resolve) => {
  const u = new URL(BASE);
  http.get({ host: u.hostname, port: u.port, path: p, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
});

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // --- app icon ---
  let man = JSON.parse((await req('GET', '/manifest.webmanifest')).text);
  ok(man.icons[0].src === '/static/icons/icon-192.png', 'the default logo: the shipped app icon');
  const look = (await req('GET', '/api/admin/config')).json.settings.appearance;
  await req('PUT', '/api/admin/settings', { appearance: { ...look, logo: { kind: 'icon', name: 'server', color: 'teal' } } });
  let info = (await req('GET', '/api/admin/app-icons')).json;
  ok(info.logo === 'icon' && /^#[0-9a-f]{6}$/i.test(info.background) && info.custom === false, `the page learns the logo and the theme colour (${info.background})`);
  const bare = (await req('GET', '/logo?bare=1')).text;
  ok(!bare.includes('#16191e') && (await req('GET', '/logo')).text.includes('#16191e'), 'the built-in icon without its tile, for drawing on the theme colour');

  const icons = { 180: b64(png(180)), 192: b64(png(192)), 512: b64(png(512)), maskable: b64(png(512)) };
  let r = await req('PUT', '/api/admin/app-icons', { icons: { ...icons, 180: b64(png(181)) } });
  ok(r.status === 400 && /180×180/.test(r.json.error), 'each icon must be its size');
  r = await req('PUT', '/api/admin/app-icons', { icons: { ...icons, 192: b64(Buffer.from('<svg/>')) } });
  ok(r.status === 400 && /PNG/.test(r.json.error), 'and a PNG');
  r = await req('PUT', '/api/admin/app-icons', { icons });
  ok(r.status === 200 && r.json.custom, 'the drawn icons are saved');
  man = JSON.parse((await req('GET', '/manifest.webmanifest')).text);
  ok(/^\/app-icon\/192\.png\?v=[0-9a-f]{12}$/.test(man.icons[0].src) && /^\/app-icon\/maskable\.png\?v=/.test(man.icons[2].src), `the manifest uses them (${man.icons[0].src})`);
  const page = (await req('GET', '/')).text;
  ok(/<link rel="apple-touch-icon" href="\/app-icon\/180\.png\?v=[0-9a-f]{12}">/.test(page), 'and the iPhone home screen icon');
  const anon = await fetch(`${BASE}/app-icon/180.png`);
  const buf = Buffer.from(await anon.arrayBuffer());
  ok(anon.status === 200 && anon.headers.get('content-type') === 'image/png' && buf.readUInt32BE(16) === 180, 'served without signing in, like the logo');

  // a later Look save without them keeps them
  const look2 = (await req('GET', '/api/admin/config')).json.settings.appearance;
  await req('PUT', '/api/admin/settings', { appearance: { ...look2, appIcons: undefined, theme: look2.theme } });
  ok(Boolean((await req('GET', '/api/admin/config')).json.settings.appearance.appIcons), 'saving Look again keeps the app icon');

  // back to the default
  r = await req('PUT', '/api/admin/app-icons', { icons: null });
  man = JSON.parse((await req('GET', '/manifest.webmanifest')).text);
  ok(r.json.custom === false && man.icons[0].src === '/static/icons/icon-192.png' && (await fetch(`${BASE}/app-icon/192.png`)).status === 200, 'back to the shipped icon');

  // --- the dashboard address ---
  ok(await asHost('lookout.test:18080', '/login') === 421, 'a name it was not given is refused');
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'http://lookout.test:18080' } });
  ok(r.status === 200 && !r.json.warning, 'a dashboard address is saved');
  ok(await asHost('lookout.test:18080', '/login') === 200, 'it answers on that name');
  ok(await asHost('127.0.0.1:18080', '/login') === 200, 'and still on its IP');
  ok(await asHost('evil.test:18080', '/login') === 421, 'other names are still refused');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: '' } });
  ok(await asHost('lookout.test:18080', '/login') === 421, 'cleared: the name is refused again');

  console.log(failures ? `\n${failures} FAILED` : '\nALL APP ICON TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
