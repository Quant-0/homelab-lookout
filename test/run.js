#!/usr/bin/env node
'use strict';
// End-to-end tests against mock devices and services. No npm packages needed.
//
//   node test/run.js              API suites
//   node test/run.js --ui         also the browser tests (needs Playwright installed)
//   node test/run.js --verbose    print every check, not only failures
//   node test/run.js --only backup   run matching suites only
//
// Needs: Node 18+, openssl (test certificate). Optional: snmpd from net-snmp (set SNMPD=path if it
// is not in PATH) for the SNMPv3 suite, which is skipped otherwise.
// Uses ports 18080 (dashboard), 18444-18448 (HTTPS/backup suites), 18443 (device mock), 18090 (service
// mock), 18022 (sshd for the rsync test), 16161/udp (snmpd), 18449-18452, 18025, 18026, 18465 (alert
// mocks) and 18466 (NUT mock). rsync tests need rsync and sshd.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const PORT = 18080;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'correct horse battery';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-test-'));
const children = [];
let server = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, argv, env = {}, name = cmd) {
  const child = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => (child.output += d));
  child.stderr.on('data', (d) => (child.output += d));
  child.name = name;
  children.push(child);
  return child;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitFor(url, ms = 10000) {
  // (with HTTPS on, the HTTP port answers with a redirect, which is enough)
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(':').concat(['/usr/sbin', '/sbin'])) {
    const p = path.join(dir, bin);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Fresh data dir + admin account; or reuse the current one (fresh = false)
let dataDir = null;
async function startServer(fresh, extraEnv = {}, seed = null) {
  if (server) {
    server.kill();
    await new Promise((r) => server.once('exit', r));
  }
  if (fresh || !dataDir) {
    dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
    fs.chmodSync(dataDir, 0o700);
    execFileSync(process.execPath, ['server.js', 'set-admin', 'admin'], { cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir }, input: `${ADMIN_PW}\n${ADMIN_PW}\n`, stdio: ['pipe', 'ignore', 'inherit'] });
  }
  if (seed) seed(dataDir);
  server = start(process.execPath, ['server.js'], { DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(PORT), ...extraEnv }, 'server');
  await waitFor(`${BASE_URL}/login`);
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    const onLine = (chunk) => {
      out += chunk;
      for (const line of String(chunk).split('\n')) if (line && (verbose || !line.startsWith('PASS'))) console.log(`    ${line}`);
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('exit', (code) => resolve({ code, passed: (out.match(/^PASS/gm) || []).length, failed: (out.match(/^FAIL/gm) || []).length }));
  });
}

async function main() {
  for (const port of [PORT, 18022, 18443, 18444, 18445, 18446, 18447, 18448, 18449, 18450, 18451, 18452, 18090, 18025, 18026, 18465, 18467]) if (!(await portFree(port))) throw new Error(`Port ${port} is in use (a leftover test process?)`);

  // Test certificate for the HTTPS device mock (pinned by the tests)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'), '-days', '7', '-subj', '/CN=mock-device', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const fp = execFileSync('openssl', ['x509', '-in', path.join(tmp, 'cert.pem'), '-noout', '-fingerprint', '-sha256']).toString().split('=')[1].trim();
  start(process.execPath, ['test/mocks/devices.js'], { MOCK_CERT_DIR: tmp }, 'device mock');

  // A local CA + server certificate for 127.0.0.1, like install.sh creates (for the HTTPS suite)
  const ssl = (...a) => execFileSync('openssl', a, { stdio: 'ignore' });
  const t = (f) => path.join(tmp, f);
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', t('ca.key'), '-out', t('ca.crt'), '-days', '2', '-subj', '/CN=Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-addext', 'nameConstraints=critical,permitted;IP:127.0.0.1/255.255.255.255');
  fs.writeFileSync(t('srv.ext'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  ssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', t('srv.key'), '-out', t('srv.csr'), '-subj', '/CN=127.0.0.1');
  ssl('x509', '-req', '-in', t('srv.csr'), '-CA', t('ca.crt'), '-CAkey', t('ca.key'), '-set_serial', '2', '-days', '825', '-extfile', t('srv.ext'), '-out', t('srv.crt'));
  const tlsEnv = { TLS_CERT_FILE: t('srv.crt'), TLS_KEY_FILE: t('srv.key'), TLS_CA_FILE: t('ca.crt'), HTTPS_PORT: '18444' };
  start(process.execPath, ['test/mocks/services.js'], {}, 'service mock');

  const snmpd = process.env.SNMPD || which('snmpd');
  if (snmpd) {
    const persist = path.join(tmp, 'snmp');
    fs.mkdirSync(persist);
    start(snmpd, ['-f', '-Lo', '-C', '-c', path.join(__dirname, 'mocks/snmpd.conf'), 'udp:127.0.0.1:16161'], { SNMP_PERSISTENT_DIR: persist, MIBS: '', MIBDIRS: '' }, 'snmpd');
  }
  await sleep(1200);

  const env = { BASE_URL, MOCK_FP: fp, MOCK_CERT_DIR: tmp };
  const backupBase = path.join(tmp, 'backup-base'); // stands in for /var/backups/homelab-dashboard
  fs.mkdirSync(backupBase, { mode: 0o700 });
  const suites = [
    { file: 'test/core.test.js', fresh: true },
    { file: 'test/https.test.js', fresh: true, env: tlsEnv },
    { file: 'test/appearance.test.js', fresh: false },
    { file: 'test/snmp-unifi.test.js', fresh: true, skip: !snmpd && 'snmpd not found (install net-snmp or set SNMPD)' },
    { file: 'test/drivers.test.js', fresh: true, skip: !snmpd && 'snmpd not found (install net-snmp or set SNMPD)' },
    { file: 'test/devices.test.js', fresh: true },
    { file: 'test/services.test.js', fresh: true },
    { file: 'test/infra.test.js', fresh: true, env: { TAILSCALE_API_URL: 'http://127.0.0.1:18090/tailscale' } },
    { file: 'test/branding.test.js', fresh: true },
    { file: 'test/branding-restart.test.js', fresh: false },
    { file: 'test/cables.test.js', fresh: true },
    { file: 'test/monitor.test.js', fresh: true, env: { OFFLINE_GRACE_S: '0' } },
    { file: 'test/proxmox.test.js', fresh: true, env: { PVE_EXTRA_S: '5' } },
    { file: 'test/log.test.js', fresh: true, env: { OFFLINE_GRACE_S: '12', PUBLIC_FETCH_ALLOW_LOCAL: '1', PUBLIC_FETCH_ONLY: '127.0.0.1', PUBLIC_FETCH_CA: path.join(tmp, 'cert.pem'), RDAP_URL: 'https://127.0.0.1:18443/rdap' } },
    { file: 'test/backup.test.js', fresh: true, env: { BACKUP_DIR: backupBase } },
    { file: 'test/history.test.js', fresh: true, seed: require('./history.test.js').seed },
    { file: 'test/rack.test.js', fresh: true, seed: require('./rack.test.js').seed },
    { file: 'test/updates.test.js', fresh: true },
    { file: 'test/docs-history.test.js', fresh: true, seed: require('./docs-history.test.js').seed },
    { file: 'test/energy.test.js', fresh: true, seed: require('./energy.test.js').seed },
    { file: 'test/remember.test.js', fresh: true, seed: require('./remember.test.js').seed },
    { file: 'test/security.test.js', fresh: true },
    // the alert mocks use the device mock's certificate, trusted here like a public CA would be
    { file: 'test/alerts.test.js', fresh: true, env: { OFFLINE_GRACE_S: '0', NODE_EXTRA_CA_CERTS: path.join(tmp, 'cert.pem'), TELEGRAM_API_URL: 'https://127.0.0.1:18449', SENDBLUE_API_URL: 'https://127.0.0.1:18449', DISCORD_WEBHOOK_HOSTS: '127.0.0.1:18449' } },
  ];
  if (args.has('--ui')) {
    let playwright = true;
    try {
      require.resolve('playwright', { paths: [ROOT, process.cwd()] });
    } catch {
      playwright = false;
    }
    const seeds = { 'history.ui.js': require('./history.test.js').seed, 'docs-nav.ui.js': require('./ui/docs-nav.ui.js').seed, 'energy.ui.js': require('./energy.test.js').seed };
    for (const f of fs.readdirSync(path.join(__dirname, 'ui')).filter((x) => x.endsWith('.ui.js')))
      suites.push({ file: `test/ui/${f}`, fresh: true, seed: seeds[f], skip: !playwright && 'Playwright not installed' });
  }

  let passed = 0;
  let failed = 0;
  let broken = 0;
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  for (const s of suites.filter((x) => !only || x.file.includes(only))) {
    if (s.skip) {
      console.log(`SKIP  ${s.file}: ${s.skip}`);
      continue;
    }
    await startServer(s.fresh, s.env, s.seed);
    console.log(`RUN   ${s.file}`);
    const r = await runSuite(s.file, { ...env, ...s.env, DATA_DIR: dataDir });
    passed += r.passed;
    failed += r.failed;
    if (r.code !== 0 && !r.failed) broken++;
    console.log(`      ${r.passed} passed, ${r.failed} failed${r.code !== 0 && !r.failed ? ' (suite crashed)' : ''}`);
  }
  console.log(`\n${failed || broken ? 'FAILED' : 'OK'}: ${passed} checks passed, ${failed} failed${broken ? `, ${broken} suite(s) crashed` : ''}`);
  if ((failed || broken) && server) console.log(`\nServer log (last lines):\n${server.output.split('\n').slice(-15).join('\n')}`);
  return failed || broken ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e.message);
    return 1;
  })
  .then(async (code) => {
    // wait for the server's shutdown save before removing its data directory
    await Promise.all(children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => new Promise((r) => {
      c.once('exit', r);
      c.kill();
      setTimeout(r, 3000);
    })));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(code);
  });
