'use strict';
// Tests for themes, background uploads (metadata stripping, access control) and layout API.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, extra = {}, raw = false) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, text: buf.toString('latin1'), buf, headers: r.headers };
}

// --- craft a JPEG with EXIF (orientation 6 + GPS), XMP and a comment -----------
function u16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; }
function exifSegment() {
  // big-endian TIFF: IFD0 = [Orientation=6, GPSInfo -> GPS IFD]; GPS IFD = [GPSLatitudeRef='N', GPSLatitude via "SECRETGPS" ascii tag]
  const entries = [
    [0x0112, 3, 1, Buffer.from([0, 6, 0, 0])],
    [0x8825, 4, 1, null], // filled with GPS IFD offset
  ];
  const ifd0Off = 8;
  const ifd0Size = 2 + entries.length * 12 + 4;
  const gpsOff = ifd0Off + ifd0Size;
  const gpsAscii = Buffer.from('SECRETGPS-59.95N-11.05E\0', 'latin1');
  const gpsSize = 2 + 2 * 12 + 4;
  const asciiOff = gpsOff + gpsSize;
  const parts = [Buffer.from('MM\0*', 'latin1'), Buffer.from([0, 0, 0, 8]), u16(entries.length)];
  for (const [tag, type, count, val] of entries) {
    const e = Buffer.alloc(12); e.writeUInt16BE(tag, 0); e.writeUInt16BE(type, 2); e.writeUInt32BE(count, 4);
    if (val) val.copy(e, 8); else e.writeUInt32BE(gpsOff, 8);
    parts.push(e);
  }
  parts.push(Buffer.alloc(4));
  parts.push(u16(2));
  const g1 = Buffer.alloc(12); g1.writeUInt16BE(1, 0); g1.writeUInt16BE(2, 2); g1.writeUInt32BE(2, 4); g1.write('N\0', 8, 'latin1');
  const g2 = Buffer.alloc(12); g2.writeUInt16BE(0x001b, 0); g2.writeUInt16BE(2, 2); g2.writeUInt32BE(gpsAscii.length, 4); g2.writeUInt32BE(asciiOff, 8);
  parts.push(g1, g2, Buffer.alloc(4), gpsAscii);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), ...parts]);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), u16(payload.length + 2), payload]);
}
function seg(marker, data) { return Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]); }
const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const jpegWithMeta = Buffer.concat([
  tinyJpeg.subarray(0, 2), exifSegment(),
  seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRETXMP</x:xmpmeta>', 'latin1')),
  seg(0xfe, Buffer.from('SECRETCOMMENT', 'latin1')),
  tinyJpeg.subarray(2),
]);

// PNG 1x1 with a tEXt chunk
const zlib = require('node:zlib');
function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0SECRETPNG', 'latin1')), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);

function orientationOf(jpeg) {
  for (let p = 2; p < jpeg.length - 4;) {
    if (jpeg[p] !== 0xff) return null;
    const m = jpeg[p + 1]; const len = jpeg.readUInt16BE(p + 2);
    if (m === 0xe1 && jpeg.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = jpeg.subarray(p + 10); const ifd = t.readUInt32BE(4); const n = t.readUInt16BE(ifd);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (t.readUInt16BE(e) === 0x0112) return t.readUInt16BE(e + 8); }
    }
    if (m === 0xda) return null;
    p += 2 + len;
  }
  return null;
}

(async () => {
  let r = await req('GET', '/appearance.css');
  ok(r.status === 200 && r.text.includes('--bg-blur') && !r.text.includes('/media/bg'), 'appearance.css public, no image URL');
  r = await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  ok(r.status === 200, 'login');
  csrf = (await req('GET', '/api/session')).json.csrf;

  const saved = csrf; csrf = '';
  r = await req('POST', '/api/admin/backgrounds', jpegWithMeta, { 'Content-Type': 'image/jpeg' }, true);
  ok(r.status === 403, 'upload without CSRF rejected');
  csrf = saved;

  r = await req('POST', '/api/admin/backgrounds', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { 'Content-Type': 'image/svg+xml' }, true);
  ok(r.status === 400, 'SVG upload rejected');
  r = await req('POST', '/api/admin/backgrounds', Buffer.from('GIF89a....'), { 'Content-Type': 'image/png' }, true);
  ok(r.status === 400, 'non-image with image content-type rejected');
  r = await req('POST', '/api/admin/backgrounds', Buffer.alloc(11 << 20, 1), { 'Content-Type': 'image/jpeg' }, true);
  ok(r.status === 413, 'oversized upload rejected');

  r = await req('POST', '/api/admin/backgrounds', jpegWithMeta, { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent('holiday photo.jpg') }, true);
  ok(r.status === 201 && r.json.background.mime === 'image/jpeg', 'JPEG upload accepted');
  const jpg = r.json.background;
  ok(jpg.name === 'holiday photo.jpg', 'file name kept');
  r = await req('GET', `/media/bg/${jpg.id}`);
  ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'image served to logged-in user');
  ok(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff on images');
  ok(!/SECRET/.test(r.text), 'EXIF GPS, XMP and comment stripped from JPEG');
  ok(orientationOf(r.buf) === 6, `EXIF orientation preserved (${orientationOf(r.buf)})`);
  ok(r.buf.subarray(-20).equals(jpegWithMeta.subarray(-20)), 'image data intact');

  r = await req('POST', '/api/admin/backgrounds', png, { 'Content-Type': 'image/png' }, true);
  ok(r.status === 201, 'PNG upload accepted');
  const pngRec = r.json.background;
  r = await req('GET', `/media/bg/${pngRec.id}`);
  ok(!r.text.includes('SECRETPNG') && r.text.includes('IDAT') && r.text.includes('IEND'), 'PNG text chunk stripped, image chunks kept');

  // Appearance
  r = await req('PUT', '/api/admin/settings', { appearance: { theme: 'evil"><script>', background: { type: 'none' }, blur: 1, dim: 1, cardOpacity: 50 } });
  ok(r.status === 400, 'unknown theme rejected');
  r = await req('PUT', '/api/admin/settings', { appearance: { theme: 'nord', background: { type: 'image', imageId: 'f'.repeat(32) }, blur: 1, dim: 1, cardOpacity: 50 } });
  ok(r.status === 400, 'unknown image id rejected');
  const before = (await req('GET', '/api/admin/config')).json.settings.power;
  r = await req('PUT', '/api/admin/settings', { appearance: { theme: 'nord', background: { type: 'image', imageId: jpg.id }, blur: 20, dim: 40, cardOpacity: 70 } });
  ok(r.status === 200 && r.json.settings.appearance.theme === 'nord', 'appearance saved');
  ok(JSON.stringify(r.json.settings.power) === JSON.stringify(before), 'partial settings update keeps power settings');
  // the owner's accent colour: one of a fixed list, put on <html> for every page
  r = await req('PUT', '/api/admin/settings', { appearance: { ...r.json.settings.appearance, accent: 'neon"><script>' } });
  ok(r.status === 400, 'unknown accent colour rejected');
  r = await req('PUT', '/api/admin/settings', { appearance: { ...(await req('GET', '/api/admin/config')).json.settings.appearance, accent: 'teal' } });
  ok(r.status === 200 && r.json.settings.appearance.accent === 'teal', 'accent colour saved');
  ok((await req('GET', '/')).text.includes('data-accent="teal"'), 'accent colour on the page');
  r = await req('PUT', '/api/admin/settings', { appearance: { ...r.json.settings.appearance, accent: 'theme' } });
  r = await req('GET', '/');
  ok(r.text.includes('<html lang="en" data-theme="nord" data-accent="theme" data-bg="image">'), 'theme + background injected into page');
  r = await req('GET', '/appearance.css');
  ok(r.text.includes(`/media/bg/${jpg.id}`) && r.text.includes('--bg-blur:20px') && r.text.includes('--card-alpha:0.7'), 'appearance.css has image and values for logged-in user');

  // Layout
  r = await req('PUT', '/api/admin/layout', { items: [{ id: 'power-summary', x: 6, y: 0, w: 7, h: 4 }] });
  ok(r.status === 400, 'layout wider than grid rejected');
  r = await req('PUT', '/api/admin/layout', { items: [{ id: '../../etc', x: 0, y: 0, w: 2, h: 2 }] });
  ok(r.status === 400, 'invalid widget id rejected');
  r = await req('PUT', '/api/admin/layout', { items: [{ id: 'power-summary', x: 0, y: 0, w: 6, h: 8 }, { id: 'power-chart', x: 6, y: 0, w: 6, h: 9 }], hidden: [] });
  ok(r.status === 200 && r.json.layout.items.length === 2, 'layout saved');
  r = await req('GET', '/api/dashboard');
  ok(r.json.layout && r.json.layout.items[1].x === 6, 'layout returned with dashboard data');

  // Logged out: no background image exposed
  const loggedInCookie = cookie;
  cookie = '';
  r = await req('GET', '/login');
  ok(r.text.includes('data-theme="nord" data-accent="theme" data-bg="none"'), 'login page themed, background image hidden');
  r = await req('GET', '/appearance.css');
  ok(!r.text.includes('/media/bg'), 'appearance.css hides image when logged out');
  r = await req('GET', `/media/bg/${jpg.id}`);
  ok(r.status === 401, 'image not served when logged out');
  r = await req('PUT', '/api/admin/layout', { items: [] });
  ok(r.status === 401 || r.status === 403, 'layout cannot be changed logged out');
  cookie = loggedInCookie;

  // Delete selected image -> background falls back to none
  r = await req('DELETE', `/api/admin/backgrounds/${jpg.id}`);
  ok(r.status === 200 && r.json.appearance.background.type === 'none', 'deleting selected image resets background');
  r = await req('GET', `/media/bg/${jpg.id}`);
  ok(r.status === 404, 'deleted image gone');
  r = await req('PUT', '/api/admin/layout', null);
  ok(r.status === 400 || r.status === 200, `layout reset request handled (${r.status})`);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL APPEARANCE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
