'use strict';
// HTTPS with the local CA, HTTP redirect/serve modes, safe port changes and lockout protection.
// Started by test/run.js with a test CA (TLS_CA_FILE) and HTTPS_PORT=18444.
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CA = fs.readFileSync(process.env.TLS_CA_FILE);
const HTTP_PORT = Number(new URL(process.env.BASE_URL).port);
let httpsPort = Number(process.env.HTTPS_PORT);
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jars = { https: '', http: '' };
let csrf = '';

function request(scheme, port, method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const mod = scheme === 'https' ? https : http;
    const data = body === undefined ? null : JSON.stringify(body);
    const req = mod.request({
      host: '127.0.0.1', port, path: p, method, ca: CA, servername: undefined,
      headers: { ...(jars[scheme] ? { Cookie: jars[scheme] } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
    }, (res) => {
      const authorized = res.socket?.authorized; // the socket is detached once the response ends
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) jars[scheme] = String(sc[0]).split(';')[0];
        let json = null;
        try { json = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: b, cookie: sc ? sc[0] : null, authorized });
      });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(data);
  });
}
const H = (method, p, body, headers) => request('https', httpsPort, method, p, body, headers);
const P = (method, p, body, headers) => request('http', HTTP_PORT, method, p, body, headers);
const portOpen = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });

(async () => {
  // --- HTTPS with the local CA ---
  let r = await H('GET', '/login');
  ok(r.status === 200 && r.authorized, 'HTTPS works and the certificate verifies against the local CA');
  ok(/max-age=/.test(r.headers['strict-transport-security'] || ''), 'HSTS header on HTTPS');
  r = await P('GET', '/admin?x=1');
  ok(r.status === 308 && r.headers.location === `https://127.0.0.1:${httpsPort}/admin?x=1`, `HTTP redirects to HTTPS (${r.headers.location})`);
  r = await P('GET', '/', undefined, { Host: 'evil.example' });
  ok(r.status === 421, 'redirect refuses unknown Host headers (no open redirect)');
  r = await H('GET', '/ca.crt');
  ok(r.status === 200 && r.text.includes('BEGIN CERTIFICATE') && /attachment/.test(r.headers['content-disposition']), 'CA certificate downloadable');

  // --- cookies ---
  r = await H('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  ok(r.status === 200 && /^__Host-hd_session=/.test(r.cookie) && /; Secure/.test(r.cookie), 'login over HTTPS: __Host- cookie with Secure');
  csrf = (await H('GET', '/api/session')).json.csrf;
  r = await H('GET', '/api/admin/server');
  ok(r.json.current === 'https' && r.json.tls?.caFingerprint && r.json.urls.https === `https://127.0.0.1:${httpsPort}`, 'server status: URLs, certificate and CA fingerprint');
  ok(r.json.tls.validTo > Date.now() + 700 * 86400000, 'server certificate valid ~825 days');

  // --- validation and lockout protection ---
  const cur = r.json.settings;
  const put = (s) => H('PUT', '/api/admin/server', s);
  r = await put({ https: { ...cur.https, enabled: false }, http: { ...cur.http, enabled: false } });
  ok(r.status === 400 && /At least one/.test(r.json.error), 'cannot turn both off');
  r = await put({ https: { ...cur.https, enabled: false }, http: { ...cur.http, mode: 'redirect' } });
  ok(r.status === 400 && /needs HTTPS/.test(r.json.error), 'cannot redirect to a disabled HTTPS');
  r = await put({ https: cur.https, http: { ...cur.http, port: httpsPort } });
  ok(r.status === 400 && /different ports/.test(r.json.error), 'HTTP and HTTPS cannot share a port');
  const blocker = net.createServer().listen(18446, '127.0.0.1');
  await sleep(100);
  r = await put({ https: { ...cur.https, port: 18446 }, http: cur.http });
  ok(r.status === 400 && /already in use/.test(r.json.error), `port used by another program is refused: ${r.json.error}`);
  r = await H('GET', '/api/session');
  ok(r.status === 200, `...and the dashboard keeps running on the old port (${r.status || r.error})`);
  blocker.close();
  r = await put({ https: { ...cur.https, port: 444 }, http: cur.http });
  ok(r.status === 400 && /below 1024|--low-ports|in use/.test(r.json.error), `low port without privileges is refused: ${r.json.error}`);

  // --- move HTTPS to another port ---
  r = await put({ https: { ...cur.https, port: 18445 }, http: cur.http });
  ok(r.status === 200 && r.json.urls.https === 'https://127.0.0.1:18445', 'HTTPS moved to 18445 (response came on the old port)');
  const oldPort = httpsPort;
  httpsPort = 18445;
  r = await H('GET', '/api/session');
  ok(r.status === 200, `new HTTPS port answers, same session (${r.status || r.error})`);
  await sleep(1800);
  ok(!(await portOpen(oldPort)), 'old HTTPS port closed');
  r = await P('GET', '/');
  ok(r.headers.location === 'https://127.0.0.1:18445/', 'HTTP now redirects to the new port');
  r = await H('GET', '/api/admin/config');
  ok(r.status === 200, 'session still valid after the move');

  // --- HTTP serving the dashboard instead of redirecting ---
  r = await put({ https: { enabled: true, port: 18445 }, http: { enabled: true, port: HTTP_PORT, mode: 'serve' } });
  ok(r.status === 200 && r.json.httpMode === 'serve', 'HTTP set to serve');
  r = await P('GET', '/login');
  ok(r.status === 200, 'HTTP serves the login page (no redirect, no re-bind)');
  r = await P('GET', '/api/admin/config', undefined, { Cookie: jars.https.replace('__Host-hd_session', 'hd_session') });
  ok(r.status === 401, `an HTTPS session is not accepted over HTTP (${r.status || r.error})`);
  const csrfHttps = csrf;
  csrf = '';
  r = await P('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  ok(r.status === 200 && /^hd_session=/.test(r.cookie) && !/Secure/.test(r.cookie), 'login over HTTP: plain cookie without Secure');
  csrf = csrfHttps;

  // --- HTTPS only ---
  r = await put({ https: { enabled: true, port: 18445 }, http: { enabled: false, port: HTTP_PORT, mode: 'redirect' } });
  ok(r.status === 200 && r.json.urls.http === null, 'HTTP turned off');
  await sleep(1800);
  ok(!(await portOpen(HTTP_PORT)), 'HTTP port closed');
  // back to the defaults for the runner
  r = await put({ https: { enabled: true, port: oldPort }, http: { enabled: true, port: HTTP_PORT, mode: 'redirect' } });
  ok(r.status === 200, 'back to the original ports');

  // --- emergency reset (service stopped) ---
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hd-reset-'));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { server: { https: { enabled: false, port: 1 }, http: { enabled: true, port: 2, mode: 'serve' } } } }));
  execFileSync(process.execPath, ['server.js', 'reset-network'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, HTTPS_PORT: '8443', PORT: '8080' } });
  const reset = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).settings.server;
  ok(reset.https.enabled && reset.https.port === 8443 && reset.http.port === 8080 && reset.http.mode === 'redirect', 'node server.js reset-network restores the defaults');
  fs.rmSync(dir, { recursive: true });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL HTTPS TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
