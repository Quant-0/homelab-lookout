'use strict';
// Backup & restore: encryption, restore (also on a fresh server with another key), and the
// folder, S3 and rsync-over-SSH destinations. rsync runs only if rsync and sshd are available.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE_URL;
const FP = process.env.MOCK_FP;
const PASS = 'backup passphrase 42';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  let cookie = '';
  let csrf = '';
  const req = async (method, p, body, extra = {}, raw = false) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString()); } catch {}
    return { status: r.status, json, buf, text: buf.toString('latin1'), headers: r.headers };
  };
  req.login = async () => {
    await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
    csrf = (await req('GET', '/api/session')).json.csrf;
  };
  return req;
}
const s3stats = () => new Promise((res) => https.get({ host: '127.0.0.1', port: 18443, path: '/__s3', rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }));
function decrypt(buf, pass) {
  const key = crypto.scryptSync(pass, buf.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(24, 36));
  d.setAAD(buf.subarray(0, 8));
  d.setAuthTag(buf.subarray(36, 52));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(52)), d.final()])));
}
const cleanup = [];
process.on('exit', () => cleanup.forEach((fn) => { try { fn(); } catch {} }));
const which = (b) => (process.env.PATH || '').split(':').concat(['/usr/sbin']).map((d) => path.join(d, b)).find((p) => fs.existsSync(p));

(async () => {
  const req = client(BASE);
  await req.login();
  // something worth backing up: a device with a secret, a service, a docs page
  let r = await req('POST', '/api/admin/devices', { name: 'Orion', kind: 'server', location: 'rack', u: 10, height: 2, connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  const orion = r.json.device;
  await req('POST', '/api/docs/pages', { title: 'Runbook', body: 'Restore steps' });

  // --- settings ---
  r = await req('PUT', '/api/admin/backup/settings', { schedule: { enabled: true, time: '03:30', keep: 3 } });
  ok(r.status === 400 && /passphrase/.test(r.json.error), 'automatic backups need a passphrase');
  r = await req('PUT', '/api/admin/backup/settings', { schedule: { enabled: true, time: '03:30', keep: 3 }, passphrase: 'short' });
  ok(r.status === 400 && /12 characters/.test(r.json.error), 'short passphrase rejected');
  r = await req('PUT', '/api/admin/backup/settings', { schedule: { enabled: true, time: '25:00', keep: 3 }, passphrase: PASS });
  ok(r.status === 400, 'invalid time rejected');
  r = await req('PUT', '/api/admin/backup/settings', { schedule: { enabled: true, time: '03:30', keep: 3 }, passphrase: PASS });
  ok(r.status === 200 && r.json.hasPassphrase && !r.text.includes(PASS), 'schedule saved, passphrase write-only');

  // --- download + file format ---
  r = await req('POST', '/api/admin/backup/download', { passphrase: PASS });
  ok(r.status === 200 && r.buf.subarray(0, 8).toString() === 'HLDBAK1\n' && /attachment/.test(r.headers.get('content-disposition')), 'download: encrypted backup file');
  ok(!r.text.includes('calvin') && !r.text.includes('Runbook'), 'nothing readable without the passphrase');
  const file = r.buf;
  const bundle = decrypt(file, PASS);
  ok(bundle.config.hosts.some((h) => h.secretPlain === 'calvin') && bundle.docs.pages[0].title === 'Runbook' && bundle.config.backup.passphrasePlain === PASS, 'inside: secrets, docs and settings');
  ok(bundle.config.hosts.every((h) => !h.secret), 'server-key ciphertext is not in the file (restores with any key)');

  // --- restore (same server) ---
  await req('POST', '/api/admin/devices', { name: 'Added later', kind: 'other', location: 'none' });
  r = await req('POST', '/api/admin/backup/restore', file, { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent('wrong passphrase!!') }, true);
  ok(r.status === 400 && /Wrong passphrase/.test(r.json.error), 'wrong passphrase rejected');
  ok((await req('GET', '/api/admin/config')).json.devices.some((d) => d.name === 'Added later'), '...and nothing was changed');
  r = await req('POST', '/api/admin/backup/restore', file, { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(PASS) }, true);
  ok(r.status === 200, 'restore accepted');
  let cfg = (await req('GET', '/api/admin/config')).json;
  ok(!cfg.devices.some((d) => d.name === 'Added later') && cfg.devices.some((d) => d.name === 'Orion'), 'state restored');
  const host = cfg.hosts.find((h) => h.deviceId === orion.id);
  r = await req('POST', '/api/admin/test-connection', { id: host.id, type: 'idrac', address: host.address, username: host.username, tlsMode: host.tlsMode, fingerprint: host.fingerprint });
  ok(r.json.ok, 'restored secret works (re-encrypted with the server key)');
  r = await req('GET', '/api/admin/backup');
  ok(r.json.local.some((f) => /-pre-restore\.hldb$/.test(f.file)), 'a pre-restore copy of the old state was kept');
  r = await req('GET', '/api/session');
  ok(r.status === 200, 'still logged in after restore');

  // --- restore on a fresh server with a different key ---
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-restore-'));
  fs.chmodSync(dir2, 0o700);
  execFileSync(process.execPath, ['server.js', 'set-admin', 'admin'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir2 }, input: 'correct horse battery\ncorrect horse battery\n', stdio: ['pipe', 'ignore', 'ignore'] });
  const srv2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir2, HOST: '127.0.0.1', PORT: '18447', HTTPS_PORT: '18448', TLS_CERT_FILE: '', TLS_KEY_FILE: '' } });
  cleanup.push(() => srv2.kill());
  let log2 = '';
  srv2.stdout.on('data', (d) => (log2 += d));
  srv2.stderr.on('data', (d) => (log2 += d));
  await sleep(1500);
  const req2 = client('http://127.0.0.1:18447');
  await req2.login();
  r = await req2('POST', '/api/admin/backup/restore', file, { 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent(PASS) }, true);
  ok(r.status === 200, `restore on a fresh install accepted (${r.status} ${r.json?.error || ''})`);
  if (r.status !== 200) await sleep(500), console.log(log2.slice(-3000));
  cfg = (await req2('GET', '/api/admin/config')).json;
  const h2 = cfg.hosts.find((h) => h.deviceId === orion.id) || {};
  r = await req2('POST', '/api/admin/test-connection', { id: h2.id, type: 'idrac', address: h2.address, username: h2.username, tlsMode: h2.tlsMode, fingerprint: h2.fingerprint });
  ok(r.json.ok && cfg.devices.length > 0, 'restore on a fresh install with another server key: secrets work');
  ok((await req2('GET', '/api/docs')).json.docs.pages[0].title === 'Runbook', 'docs restored on the fresh install');
  srv2.kill();
  fs.rmSync(dir2, { recursive: true, force: true });

  // --- folder destination (mounted NAS share) ---
  r = await req('POST', '/api/admin/backup/destinations', { type: 'folder', name: 'NAS', folder: '../escape' });
  ok(r.status === 400, 'folder outside the backup base rejected');
  r = await req('POST', '/api/admin/backup/destinations', { type: 'folder', name: 'NAS', folder: 'lookout' });
  const folderDest = r.json.destination;
  r = await req('POST', `/api/admin/backup/destinations/${folderDest.id}/test`, {});
  ok(r.json.ok, `folder destination test ${r.json.error || ''}`);

  // --- S3 destination (mock with independent signature check) ---
  const s3 = { type: 's3', name: 'B2', endpoint: 'https://127.0.0.1:18443', region: 'eu-central-003', bucket: 'backups', prefix: 'homelab', accessKey: 'S3ACCESSKEY', pathStyle: true, tlsMode: 'pin', fingerprint: FP };
  r = await req('POST', '/api/admin/backup/destinations', { ...s3, endpoint: 'http://127.0.0.1:18443' });
  ok(r.status === 400 && /https/.test(r.json.error), 'S3 over plain http rejected');
  r = await req('POST', '/api/admin/backup/destinations', { ...s3, secret: 'S3SECRETKEY123' });
  ok(r.status === 201 && r.json.destination.hasSecret && !r.text.includes('S3SECRETKEY123'), 'S3 destination saved, secret write-only');
  const s3Dest = r.json.destination;
  r = await req('POST', `/api/admin/backup/destinations/${s3Dest.id}/test`, {});
  ok(r.json.ok, `S3 test (list objects, signature verified by the mock) ${r.json.error || ''}`);
  r = await req('POST', '/api/admin/backup/destinations', { ...s3, name: 'bad', secret: 'wrong-secret' });
  const bad = r.json.destination;
  r = await req('POST', `/api/admin/backup/destinations/${bad.id}/test`, {});
  ok(!r.json.ok && /SignatureDoesNotMatch/.test(r.json.error), `wrong S3 secret reported: ${r.json.error}`);
  await req('DELETE', `/api/admin/backup/destinations/${bad.id}`);
  r = await req('PUT', `/api/admin/backup/destinations/${s3Dest.id}`, { ...s3, accessKey: 'OTHER' });
  ok(r.json.destination.hasSecret === false && /deleted/.test(r.json.note), 'changing the access key without the secret deletes it');
  await req('PUT', `/api/admin/backup/destinations/${s3Dest.id}`, { ...s3, secret: 'S3SECRETKEY123' });

  // --- rsync over SSH (real sshd on 18022, if available) ---
  const rsyncBin = process.env.RSYNC || which('rsync');
  const sshd = which('sshd');
  let sshdProc = null;
  let rsyncDest = null;
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-remote-'));
  if (rsyncBin && sshd) {
    r = await req('POST', '/api/admin/backup/destinations', { type: 'rsync', name: 'Synology', host: '127.0.0.1', port: 18022, user: os.userInfo().username, path: path.join(remote, 'backups'), rsyncPath: process.env.REMOTE_RSYNC || '' });
    rsyncDest = r.json.destination;
    r = await req('POST', `/api/admin/backup/destinations/${rsyncDest.id}/test`, {});
    ok(!r.json.ok && /No SSH key/.test(r.json.error), 'rsync without a key refuses');
    r = await req('POST', `/api/admin/backup/destinations/${rsyncDest.id}/sshkey`, {});
    ok(/^ssh-ed25519 /.test(r.json.publicKey), 'SSH key generated; only the public key is shown');
    ok(!JSON.stringify(r.json).includes('PRIVATE KEY'), 'private key never returned');
    const cfgRaw = fs.readFileSync(path.join(process.env.DATA_DIR, 'config.json'), 'utf8');
    ok(!cfgRaw.includes('PRIVATE KEY'), 'private key encrypted at rest');
    // a throwaway sshd that accepts this key
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-sshd-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sd, 'host')]);
    fs.writeFileSync(path.join(sd, 'authorized_keys'), r.json.publicKey + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(sd, 'sshd_config'), [`Port 18022`, 'ListenAddress 127.0.0.1', `HostKey ${sd}/host`, `AuthorizedKeysFile ${sd}/authorized_keys`, `PidFile ${sd}/pid`,
      'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes'].join('\n') + '\n');
    sshdProc = spawn(sshd, ['-D', '-e', '-f', path.join(sd, 'sshd_config')], { stdio: 'ignore' });
    cleanup.push(() => sshdProc.kill());
    await sleep(800);
    r = await req('POST', `/api/admin/backup/destinations/${rsyncDest.id}/test`, {});
    ok(!r.json.ok && /host key/i.test(r.json.error), 'no pinned host key: refuses to connect');
    r = await req('POST', '/api/admin/backup/keyscan', { host: '127.0.0.1', port: 18022 });
    const realFp = execFileSync('ssh-keygen', ['-lf', path.join(sd, 'host.pub')]).toString().split(' ')[1];
    ok(r.json.fingerprints?.some((f) => f.fingerprint === realFp), `host key fingerprint matches ssh-keygen (${realFp})`);
    const pinned = r.json.knownHosts;
    // wrong pin first: a different host key must be refused
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sd, 'other')]);
    const wrong = `[127.0.0.1]:18022 ${fs.readFileSync(path.join(sd, 'other.pub'), 'utf8').split(' ').slice(0, 2).join(' ')}`;
    await req('PUT', `/api/admin/backup/destinations/${rsyncDest.id}`, { ...rsyncDest, knownHosts: wrong });
    r = await req('POST', `/api/admin/backup/destinations/${rsyncDest.id}/test`, {});
    ok(!r.json.ok && /does not match the pinned key/.test(r.json.error), `wrong pinned host key refused: ${r.json.error}`);
    await req('PUT', `/api/admin/backup/destinations/${rsyncDest.id}`, { ...rsyncDest, knownHosts: pinned });
    r = await req('POST', `/api/admin/backup/destinations/${rsyncDest.id}/test`, {});
    ok(r.json.ok, `rsync test with the pinned host key ${r.json.error || ''}`);
    cleanup.push(() => fs.rmSync(sd, { recursive: true, force: true }));
  } else console.log('SKIP  rsync destination (rsync or sshd not found)');

  // --- run: local copy + all destinations, keep 3 ---
  for (let i = 0; i < 4; i++) {
    r = await req('POST', '/api/admin/backup/run', {});
    await sleep(1100); // file names have second precision
  }
  const entry = r.json.entry;
  ok(r.status === 200 && entry.file && entry.results.length >= 2 && entry.results.every((x) => x.ok), `backup run: ${entry.results.map((x) => `${x.name} ${x.ok ? 'ok' : x.error}`).join(', ')}`);
  r = await req('GET', '/api/admin/backup');
  ok(r.json.local.filter((f) => !/pre-restore/.test(f.file)).length <= 3, 'local copies pruned to 3 (+ pre-restore copy)');
  const folderFiles = fs.readdirSync(path.join(process.env.BACKUP_DIR, 'lookout'));
  ok(folderFiles.length === 3 && folderFiles.every((f) => f.endsWith('.hldb')), `folder destination keeps 3 (${folderFiles.length})`);
  const s3keys = (await s3stats()).keys;
  ok(s3keys.length === 3 && s3keys.every((k) => k.startsWith('homelab/')), `S3 keeps 3 under the prefix (${s3keys.length})`);
  ok(decrypt(fs.readFileSync(path.join(process.env.BACKUP_DIR, 'lookout', folderFiles[0])), PASS).format === 'homelab-dashboard-backup', 'files on the destination decrypt with the passphrase');
  if (rsyncDest) {
    const remoteFiles = fs.readdirSync(path.join(remote, 'backups'));
    ok(remoteFiles.filter((f) => !/pre-restore/.test(f)).length === 3, `rsync mirrors the local copies (${remoteFiles.length} files)`);
  }
  ok(r.json.history[0].results.length === entry.results.length, 'run history recorded');
  if (sshdProc) sshdProc.kill();
  fs.rmSync(remote, { recursive: true, force: true });

  // --- local copy: restore + delete ---
  const local = r.json.local.find((f) => !/pre-restore/.test(f.file));
  r = await req('GET', `/api/admin/backup/local/${local.file}`);
  ok(r.status === 200 && r.buf.subarray(0, 8).toString() === 'HLDBAK1\n', 'local copy downloadable');
  r = await req('GET', '/api/admin/backup/local/..%2Fconfig.json');
  ok(r.status === 404, 'no path traversal through local copy names');
  r = await req('POST', '/api/admin/backup/restore-local', { file: local.file, passphrase: PASS });
  ok(r.status === 200, 'restore from a local copy');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BACKUP TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
