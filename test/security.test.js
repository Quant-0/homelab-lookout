'use strict';
// Security sweep over the whole server:
// - every API route as a stranger, as a remembered (view-only) device, and as the admin without a
//   CSRF token / from another origin / via another site: refused before anything happens
// - pages and scripts that need a login, wrong Host header, security headers on every kind of response
// - "canary" secrets stored in every place that takes one (device, service, alert channels, backup
//   passphrase, S3 key) never come back in any API response, page or script, nor in plain text on disk
// - a crafted backup can't plant scripts (image types from the content, theme from the fixed list)
// - guessing the current password on "Change password" is locked out like the login form
// The route list is read from server.js, so a new route is covered (or the test says it isn't).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const DATA = process.env.DATA_DIR;
const FP = process.env.MOCK_FP;
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

async function call(method, p, { cookie = '', body, raw, csrf, headers = {} } = {}) {
  const r = await fetch(BASE + p, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch {}
  return { status: r.status, headers: r.headers, buf, text: buf.toString('utf8'), json, cookies: r.headers.getSetCookie() };
}
const cookieOf = (r, name) => (r.cookies.find((c) => c.startsWith(`${name}=`)) || '').split(';')[0];

// --- every API route, from the source ---
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const U = '00000000-0000-4000-8000-0000000000aa';
const fixed = [...src.matchAll(/p === '(\/api\/[^']+)' && m === '([A-Z]+)'/g)].map((x) => [x[2], x[1]]);
fixed.push(['POST', '/api/admin/backup/restore'], ['POST', '/api/admin/backup/restore-local']); // written as (a || b) && POST
const patterned = {
  remembered: [['DELETE', '/api/admin/remembered/00000000000000aa']],
  hosts: [['PUT', `/api/admin/hosts/${U}`], ['DELETE', `/api/admin/hosts/${U}`], ['POST', `/api/admin/hosts/${U}/test`]],
  passive: [['PUT', `/api/admin/rack/passive/${U}`], ['DELETE', `/api/admin/rack/passive/${U}`]],
  devices: [['PUT', `/api/admin/devices/${U}`], ['DELETE', `/api/admin/devices/${U}`], ['PUT', `/api/admin/devices/${U}/placement`]],
  backgrounds: [['DELETE', `/api/admin/backgrounds/${'a'.repeat(32)}`]],
  services: [['PUT', `/api/admin/services/${U}`], ['DELETE', `/api/admin/services/${U}`]],
  iconPreview: [['GET', '/api/admin/icons/preview/proxmox']],
  docsServers: [['PUT', `/api/docs/servers/${U}`]],
  docsDeleted: [['DELETE', `/api/docs/deleted/${U}`], ['POST', `/api/docs/deleted/${U}/restore`]],
  docsHistory: [['GET', `/api/docs/pages/${U}/history`], ['GET', `/api/docs/pages/${U}/history/1`], ['POST', `/api/docs/pages/${U}/history/1/restore`]],
  docsPages: [['PUT', `/api/docs/pages/${U}`], ['DELETE', `/api/docs/pages/${U}`]],
  channels: [['PUT', `/api/admin/alerts/channels/${U}`], ['DELETE', `/api/admin/alerts/channels/${U}`], ['POST', `/api/admin/alerts/channels/${U}/test`]],
  localBackups: [['GET', '/api/admin/backup/local/homelab-dashboard-2026-01-01-000000.hldb'], ['DELETE', '/api/admin/backup/local/homelab-dashboard-2026-01-01-000000.hldb']],
  destinations: [['PUT', `/api/admin/backup/destinations/${U}`], ['DELETE', `/api/admin/backup/destinations/${U}`], ['POST', `/api/admin/backup/destinations/${U}/test`], ['POST', `/api/admin/backup/destinations/${U}/sshkey`]],
};
const ROUTES = [...fixed, ...Object.values(patterned).flat()];
const VIEWER_OK = new Set(['GET /api/dashboard', 'GET /api/services', 'GET /api/energy/report', 'GET /api/energy/export', 'GET /api/history', 'GET /api/session', 'GET /api/docs', 'GET /api/updates', 'POST /api/logout']);
const bodyFor = (m) => (m === 'GET' ? undefined : {});

async function run() {
  const patterns = (src.match(/p\.match\(\/\^\\\/api\\\//g) || []).length;
  ok(patterns === Object.keys(patterned).length, `every route pattern in server.js is in this test (${patterns} in the code, ${Object.keys(patterned).length} here)`);
  ok(fixed.length > 40, `${ROUTES.length} API routes found (${fixed.length} fixed paths, the rest by pattern)`);

  // --- a stranger: everything but the login form needs a login ---
  let leaks = [];
  for (const [m, p] of ROUTES) {
    if (p === '/api/login') continue;
    const r = await call(m, p, { body: bodyFor(m) });
    if (r.status !== 401) leaks.push(`${m} ${p} → ${r.status}`);
  }
  ok(!leaks.length, `stranger: every API route answers 401${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
  for (const [p, next] of [['/', ''], ['/services', '?next=services'], ['/energy', '?next=energy'], ['/admin', '?next=admin'], ['/docs', '?next=docs'], ['/updates', '?next=updates']]) {
    const r = await call('GET', p);
    ok(r.status === 303 && r.headers.get('location') === `/login${next}`, `stranger: ${p} sends to the login page`);
  }
  const PUBLIC = new Set(['css/style.css', 'js/login.js', 'js/common.js', 'favicon.svg', 'js/offline.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
    'js/icons.js', 'js/look.js', 'fonts/inter-5.3.0.woff2', 'licenses/Inter-OFL.txt', 'licenses/Lucide-LICENSE.txt']);
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) f.isDirectory() ? walk(path.join(dir, f.name)) : files.push(path.relative(path.join(ROOT, 'public'), path.join(dir, f.name))); };
  walk(path.join(ROOT, 'public'));
  leaks = [];
  for (const f of files.filter((x) => !x.endsWith('.html') && x !== 'sw.js')) {
    const r = await call('GET', `/static/${f}`);
    if (PUBLIC.has(f) ? r.status !== 200 : r.status !== 401) leaks.push(`${f} → ${r.status}`);
  }
  ok(!leaks.length, `stranger: only the login page's and the app shell's files are public${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
  for (const p of ['/static/../server.js', '/static/%2e%2e/server.js', '/static/js/../../server.js', '/media/bg/../../config.json', '/..%2fconfig.json']) {
    const r = await call('GET', p);
    ok(r.status === 404 || r.status === 400, `path trick ${p} → ${r.status}`);
  }
  // fetch() won't send a different Host header, so plain http here
  const hostStatus = (host) => new Promise((res) => require('node:http').get({ host: '127.0.0.1', port: new URL(BASE).port, path: '/login', headers: { Host: host } }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)));
  ok(await hostStatus('evil.example') === 421 && await hostStatus('attacker.example:18080') === 421 && await hostStatus(new URL(BASE).host) === 200, 'a foreign Host header is refused (DNS rebinding)');
  let r;

  // --- security headers on every kind of response ---
  const kinds = [['page', '/login'], ['API error', '/api/session'], ['script', '/static/js/common.js'], ['image', '/static/icons/icon-192.png'], ['manifest', '/manifest.webmanifest'],
    ['service worker', '/sw.js'], ['not found', '/nope'], ['redirect', '/admin'], ['CA certificate', '/ca.crt']];
  for (const [what, p] of kinds) {
    const h = (await call('GET', p)).headers;
    const csp = h.get('content-security-policy') || '';
    ok(/default-src 'none'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp) && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' && h.get('referrer-policy') === 'no-referrer',
      `${what}: CSP without inline scripts, nosniff, no framing, no referrer`);
  }

  // --- the admin, and canary secrets everywhere ---
  const login = await call('POST', '/api/login', { body: { username: 'admin', password: 'correct horse battery', remember: true } });
  const admin = cookieOf(login, 'hd_session');
  const device = cookieOf(login, 'hd_device');
  const csrf = (await call('GET', '/api/session', { cookie: admin })).json.csrf;
  const A = (m, p, body) => call(m, p, { cookie: admin, csrf, body });
  const C = Object.fromEntries(['idrac', 'service', 'ntfy', 'smtp', 'telegram', 'discord', 'passphrase', 's3'].map((k) => [k, `CANARY-${k}-${crypto.randomBytes(6).toString('hex')}`]));
  const made = [
    await A('POST', '/api/admin/devices', { name: 'Titan', kind: 'server', location: 'none', connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: C.idrac }] }),
    await A('POST', '/api/admin/services', { name: 'Pi-hole', group: 'Network', connection: { url: 'http://127.0.0.1:18090/pihole' }, integration: { type: 'pihole', options: {} }, secret: C.service }),
    await A('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'Phone', url: 'https://127.0.0.1:18449', topic: 'canary', auth: 'token', secret: C.ntfy, tlsMode: 'pin', fingerprint: FP }),
    await A('POST', '/api/admin/alerts/channels', { type: 'email', name: 'Mail', host: '127.0.0.1', security: 'starttls', port: 18025, username: 'alerts@example.com', secret: C.smtp, from: 'alerts@example.com', to: 'me@example.com', tlsMode: 'pin', fingerprint: FP }),
    await A('POST', '/api/admin/alerts/channels', { type: 'telegram', name: 'Telegram', chatId: '42', secret: `123456:${C.telegram}` }),
    await A('POST', '/api/admin/alerts/channels', { type: 'discord', name: 'Discord', secret: `https://discord.com/api/webhooks/123456789012/${C.discord}-abcdefghijklmnop` }),
    await A('PUT', '/api/admin/backup/settings', { schedule: { enabled: false, time: '03:30', keep: 7 }, passphrase: C.passphrase }),
    await A('POST', '/api/admin/backup/destinations', { type: 's3', name: 'B2', endpoint: 'https://127.0.0.1:18443', region: 'eu-central-003', bucket: 'backups', prefix: 'homelab', accessKey: 'S3ACCESSKEY', pathStyle: true, tlsMode: 'pin', fingerprint: FP, secret: C.s3 }),
  ];
  ok(made.every((x) => x.status < 300), `stored a secret in each place (${made.map((x) => x.status).join(' ')})`);
  await new Promise((res) => setTimeout(res, 1500)); // first poll of the device and the service

  const reads = [...ROUTES.filter(([m]) => m === 'GET').map(([, p]) => p), '/api/history?range=24h&keys=power:total', '/api/energy/report?period=2026-10', '/api/energy/export?period=2026-10&by=day&format=std'];
  const pages = ['/', '/admin', '/services', '/docs', '/updates', '/energy', '/login', '/offline', '/manifest.webmanifest', '/sw.js', '/appearance.css', ...files.filter((x) => x.endsWith('.js')).map((f) => `/static/${f}`)];
  const seen = [];
  for (const p of [...reads, ...pages]) {
    const res = await call('GET', p, { cookie: admin });
    for (const [k, v] of Object.entries(C)) if (res.text.includes(v)) seen.push(`${k} in ${p}`);
  }
  ok(!seen.length, `no stored secret comes back in ${reads.length} API reads or ${pages.length} pages/scripts${seen.length ? `: ${seen.join(', ')}` : ''}`);
  r = await call('GET', '/api/admin/config', { cookie: admin });
  ok(r.json.hosts.some((h) => h.hasSecret === true) && !/"secret"\s*:\s*"/.test(r.text), 'hosts say only "set / not set"');
  const onDisk = [];
  const scan = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, f.name); if (f.isDirectory()) scan(full); else { const t = fs.readFileSync(full, 'latin1'); for (const [k, v] of Object.entries(C)) if (t.includes(v)) onDisk.push(`${k} in ${path.relative(DATA, full)}`); } } };
  scan(DATA);
  ok(!onDisk.length, `no secret in plain text in the data folder${onDisk.length ? `: ${onDisk.join(', ')}` : ''}`);
  const modes = [];
  const perm = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, f.name); const mode = fs.statSync(full).mode & 0o777; if (f.isDirectory()) { if (mode !== 0o700) modes.push(`${f.name}/ ${mode.toString(8)}`); perm(full); } else if (mode & 0o077) modes.push(`${path.relative(DATA, full)} ${mode.toString(8)}`); } };
  perm(DATA);
  ok(!modes.length && (fs.statSync(DATA).mode & 0o777) === 0o700, `data folder 0700, nothing in it readable by others${modes.length ? `: ${modes.join(', ')}` : ''}`);

  // --- a remembered device: only the read routes ---
  const vcsrf = (await call('GET', '/api/session', { cookie: device })).json.csrf;
  leaks = [];
  for (const [m, p] of ROUTES) {
    if (p === '/api/login' || VIEWER_OK.has(`${m} ${p}`)) continue;
    const res = await call(m, p, { cookie: device, csrf: vcsrf, body: bodyFor(m) });
    if (res.status !== 401) leaks.push(`${m} ${p} → ${res.status}`);
  }
  ok(!leaks.length, `remembered device: every route outside the read list answers 401${leaks.length ? `: ${leaks.join(', ')}` : ''}`);

  // --- the admin: writes need the CSRF token and this origin ---
  const writes = ROUTES.filter(([m, p]) => m !== 'GET' && p !== '/api/login');
  const refusedAll = async (label, opts) => {
    const bad = [];
    for (const [m, p] of writes) {
      const res = await call(m, p, { cookie: admin, body: bodyFor(m), ...opts });
      if (res.status !== 403) bad.push(`${m} ${p} → ${res.status}`);
    }
    ok(!bad.length, `${label}: all ${writes.length} writes refused${bad.length ? `: ${bad.join(', ')}` : ''}`);
  };
  await refusedAll('admin without CSRF token', {});
  await refusedAll('admin with a wrong CSRF token', { csrf: 'x'.repeat(43) });
  await refusedAll('admin, request from another site (Origin)', { csrf, headers: { Origin: 'https://evil.example' } });
  await refusedAll('admin, request from another site (Sec-Fetch-Site)', { csrf, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  r = await call('PUT', '/api/admin/layout', { cookie: admin, csrf, raw: 'items=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  ok(r.status === 415, 'form posts are refused (JSON only)');

  // --- a crafted backup can't plant a script ---
  const pass = 'a long backup passphrase';
  r = await call('POST', '/api/admin/backup/download', { cookie: admin, csrf, body: { passphrase: pass } });
  const key = (salt) => new Promise((res, rej) => crypto.scrypt(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 }, (e, k) => (e ? rej(e) : res(k))));
  const MAGIC = r.buf.subarray(0, 8);
  const d = crypto.createDecipheriv('aes-256-gcm', await key(r.buf.subarray(8, 24)), r.buf.subarray(24, 36));
  d.setAAD(MAGIC);
  d.setAuthTag(r.buf.subarray(36, 52));
  const bundle = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(r.buf.subarray(52)), d.final()])).toString('utf8'));
  const JS = 'b'.repeat(32);
  const PNG = 'c'.repeat(32);
  bundle.config.settings.appearance = { theme: 'dark"><script src="/media/bg/' + JS + '"></script><x a="', background: { type: 'image', builtin: 'aurora', imageId: JS }, blur: '1px}body{display:none', dim: 0, cardOpacity: 100 };
  bundle.config.backgrounds = [{ id: JS, mime: 'text/javascript', bytes: 9, name: 'evil' }, { id: PNG, mime: 'text/html', bytes: 1, name: 'png' }];
  bundle.config.services.push({ id: '00000000-0000-4000-8000-0000000000bb', name: 'Evil link', group: 'Network', href: 'javascript:alert(document.cookie)', order: 99 });
  bundle.files.backgrounds = { [JS]: Buffer.from('alert(1)').toString('base64'), [PNG]: fs.readFileSync(path.join(ROOT, 'public/icons/icon-192.png')).toString('base64') };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', await key(salt), iv);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(bundle)))), c.final()]);
  r = await call('POST', '/api/admin/backup/restore', { cookie: admin, csrf, raw: Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]), headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(pass) } });
  ok(r.status === 200, 'crafted backup restored (as far as it is valid)');
  r = await call('GET', '/', { cookie: admin });
  ok(/<html lang="en" data-theme="auto" data-accent="theme" data-bg="none">/.test(r.text) && !r.text.includes('<script src="/media'), 'theme from the backup that is not on the list: the default, nothing injected');
  ok((await call('GET', `/media/bg/${JS}`, { cookie: admin })).status === 404, 'a "background" that is a script is left out');
  r = await call('GET', `/media/bg/${PNG}`, { cookie: admin });
  ok(r.status === 200 && r.headers.get('content-type') === 'image/png', 'a real image keeps its real type (not the one in the backup)');
  ok(!(await call('GET', '/appearance.css', { cookie: admin })).text.includes('display:none'), 'no CSS from the backup gets into the page style');
  r = await call('GET', '/api/services', { cookie: admin });
  const evil = r.json.groups.flatMap((g) => g.services || []).find((x) => x.name === 'Evil link');
  ok(evil && evil.href === '' && !r.text.includes('javascript:'), 'a javascript: link from the backup is dropped');

  // --- guessing the current password on "Change password" is locked out ---
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/admin/password', { cookie: admin, csrf, body: { current: `guess ${i}`, password: 'another long password' } })).status);
  ok(statuses.slice(0, 5).every((s) => s === 400) && statuses[5] === 429, `change password: locked after 5 wrong guesses (${statuses.join(' ')})`);
  r = await call('POST', '/api/admin/password', { cookie: admin, csrf, body: { current: 'correct horse battery', password: 'another long password' } });
  ok(r.status === 429, 'even the right password waits until the lock ends');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SECURITY TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.log(`FAIL  crashed: ${e.stack}`); process.exit(1); });
