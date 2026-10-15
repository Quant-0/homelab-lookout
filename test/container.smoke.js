'use strict';
// The Docker image, started the way docker-compose.yml starts it (host network, read-only, only
// the capabilities it lists). Needs Docker or Podman and an image:
//
//   docker build -t lookout:test .  &&  node test/container.smoke.js lookout:test
//   ENGINE=podman node test/container.smoke.js localhost/lookout:test
//
// Uses 127.0.0.1:18443/18080 and a temporary folder for /data and /key.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the container's own CA
const ENGINE = process.env.ENGINE || 'docker';
const IMAGE = process.argv[2] || 'lookout:test';
const BASE = 'https://127.0.0.1:18443';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-ct-'));
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...args) => execFileSync(ENGINE, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const shOk = (...args) => { try { return sh(...args); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; } };
// as root on the host for Docker; inside the user namespace for rootless Podman
const hostCmd = (...args) => execFileSync(ENGINE === 'podman' ? 'podman' : args[0], ENGINE === 'podman' ? ['unshare', ...args] : args.slice(1), { encoding: 'utf8' });

function start(name, data, key, extra = []) {
  for (const d of [data, key]) fs.mkdirSync(d, { recursive: true });
  shOk('rm', '-f', name);
  sh('run', '-d', '--name', name, '--network', 'host',
    '-e', 'LOOKOUT_HOST=127.0.0.1', '-e', 'LOOKOUT_HTTPS_PORT=18443', '-e', 'LOOKOUT_HTTP_PORT=18080', ...extra,
    '-v', `${data}:/data`, '-v', `${key}:/key`,
    '--read-only', '--tmpfs', '/tmp:size=16m,mode=1777',
    // one --cap-add each: Docker doesn't take a comma-separated list (Podman does)
    '--cap-drop', 'ALL', ...['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'NET_RAW'].flatMap((c) => ['--cap-add', c]), '--security-opt', 'no-new-privileges',
    IMAGE);
}
async function healthy(name) {
  for (let i = 0; i < 60; i++) {
    try {
      sh('exec', name, 'node', '/app/healthcheck.js');
      return true;
    } catch {
      await sleep(1000);
    }
  }
  console.log(shOk('logs', name));
  return false;
}
let cookie = '';
async function req(method, p, body) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, location: r.headers.get('location') };
}
let csrf = '';

async function run() {
  const data = path.join(dir, 'data');
  const key = path.join(dir, 'key');
  start('lookout-smoke', data, key);
  ok(await healthy('lookout-smoke'), 'starts and turns healthy');
  const log = shOk('logs', 'lookout-smoke');
  const code = (/setup code: ([A-Z0-9]{5}-[A-Z0-9]{5})/.exec(log) || [])[1];
  ok(code && /made a new encryption key/.test(log) && /made a local CA/.test(log), 'the log has the setup code, and a new key and CA were made');

  // --- who runs what ---
  const procs = sh('exec', 'lookout-smoke', 'sh', '-c', 'for p in /proc/[0-9]*; do c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in *node*server.js*|*tini*) echo "$(awk "/^Uid/{print \\$2}" $p/status) $(awk "/^CapEff/{print \\$2}" $p/status) $(awk "/^NoNewPrivs/{print \\$2}" $p/status) $c";; esac; done');
  const lines = procs.trim().split('\n').filter((l) => !l.includes('for p in'));
  ok(lines.length >= 2 && lines.every((l) => /^10001 0000000000002000 1 /.test(l)), `tini and node run as uid 10001 with only NET_RAW and no-new-privs\n${procs}`);
  ok(/Read-only file system/.test(shOk('exec', '--user', '10001', 'lookout-smoke', 'touch', '/app/x')), 'the app cannot change the image');
  ok(/Permission denied/.test(shOk('exec', '--user', '10001', 'lookout-smoke', 'cat', '/key/tls/ca.key')), 'nor read the CA key');
  const perms = hostCmd('stat', '-c', '%u %a %n', data, key, path.join(key, 'secret.key'), path.join(key, 'tls', 'ca.key'), path.join(key, 'tls', 'server.key'));
  ok(/^10001 700 .*data$/m.test(perms) && /^0 750 .*key$/m.test(perms) && /^10001 600 .*secret\.key$/m.test(perms) && /^0 600 .*ca\.key$/m.test(perms) && /^10001 600 .*server\.key$/m.test(perms), `folders and keys have the right owners and modes\n${perms}`);

  // --- the setup page ---
  let r = await req('GET', '/login');
  ok(r.status === 303 && r.location === '/setup', 'without an admin, sign-in sends to the setup page');
  r = await req('GET', '/setup');
  ok(r.status === 200 && /Create the admin account/.test(r.text), 'the setup page');
  r = await req('POST', '/api/setup', { code: 'AAAAA-AAAAA', username: 'admin', password: 'correct horse battery', password2: 'correct horse battery' });
  ok(r.status === 401 && /container's log/.test(r.json.error), 'a wrong code is refused, pointing at the log');
  r = await req('POST', '/api/setup', { code: code.toLowerCase(), username: 'admin', password: 'short', password2: 'short' });
  ok(r.status === 400 && /12 characters/.test(r.json.error), 'a short password is refused');
  r = await req('POST', '/api/setup', { code: code.toLowerCase(), username: 'admin', password: 'correct horse battery', password2: 'correct horse battery' });
  ok(r.status === 200, 'the right code (any case) makes the admin and signs in');
  csrf = (await req('GET', '/api/session')).json?.csrf;
  ok(Boolean(csrf), 'signed in');
  r = await req('POST', '/api/setup', { code, username: 'evil', password: 'correct horse battery', password2: 'correct horse battery' });
  ok(r.status === 404, 'the setup page is gone once the admin exists');
  ok((await req('GET', '/setup')).location === '/login', 'and /setup sends to sign-in');
  // ping from the app itself (its NET_RAW); `docker exec` gets no capabilities, so not that way
  r = await req('POST', '/api/admin/test-connection', { type: 'ping', address: '127.0.0.1' });
  ok(r.json?.ok === true, `the app can ping (${r.json?.info || r.json?.error || r.text.slice(0, 80)})`);
  r = await req('GET', '/api/admin/config');
  ok(r.json?.runtime?.install === 'docker' && /^[0-9a-f]{7}$/.test(r.json.runtime.version?.commit || ''), `Admin knows it runs in Docker, and the version (${r.json?.runtime?.version?.commit})`);

  // a stored password, encrypted with the key
  r = await req('POST', '/api/admin/devices', { name: 'atlas', kind: 'server', location: 'none', connections: [{ type: 'idrac', address: '127.0.0.1:9', username: 'root', tlsMode: 'verify', secret: 'calvin-plain-text' }] });
  ok(r.status === 201, 'a device with a password');
  const hostId = (await req('GET', '/api/admin/config')).json.hosts[0].id;
  const cfg = hostCmd('cat', path.join(data, 'config.json'));
  ok(!cfg.includes('calvin-plain-text') && /"secret": "v1\./.test(cfg), 'the password is stored encrypted');

  // --- a restart keeps everything ---
  sh('restart', 'lookout-smoke');
  ok(await healthy('lookout-smoke'), 'healthy again after a restart');
  ok((shOk('logs', 'lookout-smoke').match(/setup code: /g) || []).length === 1, 'no new setup code once the admin exists');
  cookie = '';
  csrf = '';
  r = await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  ok(r.status === 200, 'sign in after the restart');
  csrf = (await req('GET', '/api/session')).json.csrf;
  r = await req('POST', '/api/admin/test-connection', { type: 'idrac', id: hostId, address: '127.0.0.1:9', username: 'root', tlsMode: 'verify' });
  ok(!/could not be decrypted/.test(r.text), 'the stored password still decrypts');

  // resetting the admin password from the command line, as the docs say
  execFileSync(ENGINE, ['exec', '-i', '-u', '10001', 'lookout-smoke', 'node', '/app/server.js', 'set-admin', 'admin'], { input: 'another long password\nanother long password\n', encoding: 'utf8' });
  sh('restart', 'lookout-smoke');
  await healthy('lookout-smoke');
  cookie = '';
  csrf = '';
  ok((await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' })).status === 401 && (await req('POST', '/api/login', { username: 'admin', password: 'another long password' })).status === 200, 'docker exec -u 10001 … set-admin sets a new password');
  sh('rm', '-f', 'lookout-smoke');

  // --- a copy of the data folder alone can't decrypt the passwords ---
  const copy = path.join(dir, 'copy');
  hostCmd('cp', '-a', data, copy);
  start('lookout-copy', copy, path.join(dir, 'other-key'));
  ok(await healthy('lookout-copy'), 'the data copy starts with a new key');
  cookie = '';
  csrf = '';
  await req('POST', '/api/login', { username: 'admin', password: 'another long password' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  r = await req('POST', '/api/admin/test-connection', { type: 'idrac', id: hostId, address: '127.0.0.1:9', username: 'root', tlsMode: 'verify' });
  ok(/could not be decrypted/.test(r.text), `without the key the stored password is useless (${(r.json?.error || r.text).slice(0, 80)})`);
  sh('rm', '-f', 'lookout-copy');

  // --- started as another user (e.g. for a NAS share): runs as that user, no root steps ---
  const own = path.join(dir, 'own');
  fs.mkdirSync(path.join(own, 'data'), { recursive: true });
  fs.mkdirSync(path.join(own, 'key'), { recursive: true });
  hostCmd('chown', '-R', '10002:10002', own);
  start('lookout-user', path.join(own, 'data'), path.join(own, 'key'), ['--user', '10002:10002']);
  ok(await healthy('lookout-user'), 'started as uid 10002, it runs');
  ok(/^10002\s*$/.test(sh('exec', 'lookout-user', 'sh', '-c', 'awk "/^Uid/{print \\$2}" /proc/1/status')), 'as that user');
  sh('rm', '-f', 'lookout-user');

  hostCmd('rm', '-rf', dir);
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  for (const n of ['lookout-smoke', 'lookout-copy', 'lookout-user']) shOk('rm', '-f', n);
  process.exit(1);
});
