'use strict';
// The brand-neutral readers: any SNMPv3 device (real net-snmp agent with UPS-MIB values), a UPS
// through NUT (mock upsd started here) and an Omada controller (device mock).
const https = require('node:https');
const net = require('node:net');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const SECRETS = ['authpass123', 'privpass123', 'omadapass', 'OMADA-SESSION-SECRET', 'OMADATOKEN123'];
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
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const stats = () => new Promise((res) => https.get({ host: '127.0.0.1', port: 18443, path: '/__stats', rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }));
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny upsd: answers LIST VAR for "rackups", refuses anything else
let nutCommands = [];
let onBattery = false;
const nut = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      nutCommands.push(line);
      if (line === 'LIST VAR rackups') {
        const vars = { 'device.mfr': 'Eaton', 'device.model': '5E 1100i', 'ups.status': onBattery ? 'OB DISCHRG' : 'OL CHRG', 'battery.charge': onBattery ? '64' : '100', 'battery.runtime': '1830', 'ups.load': '24', 'ups.realpower.nominal': '660', 'input.voltage': '229.6', 'ups.temperature': '31' };
        sock.write(`BEGIN LIST VAR rackups\n${Object.entries(vars).map(([k, v]) => `VAR rackups ${k} "${v}"`).join('\n')}\nEND LIST VAR rackups\n`);
      } else if (line.startsWith('LIST VAR ')) sock.write('ERR UNKNOWN-UPS\n');
      else sock.write('ERR UNKNOWN-COMMAND\n');
    }
  });
});

(async () => {
  await new Promise((r) => nut.listen(18466, '127.0.0.1', r));
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  let r = await req('GET', '/api/admin/config');
  ok(r.json.types.snmp && r.json.types.nut && r.json.types.omada && /iLO/.test(r.json.types.idrac.label), 'new connection types offered (SNMP, NUT, Omada, Redfish for all brands)');

  // --- Any SNMPv3 device: here a UPS network card (UPS-MIB) on a Linux agent ---
  r = await req('POST', '/api/admin/fingerprint', { type: 'snmp', address: '127.0.0.1:16161' });
  ok(r.status === 200 && r.json.engineId, 'engine ID discovery for a generic SNMP device');
  const snmpConn = { type: 'snmp', name: 'Rack UPS', address: '127.0.0.1:16161', username: 'dashuser', fingerprint: r.json.engineId, options: { snmpAuth: 'sha' } };
  r = await req('POST', '/api/admin/hosts', { ...snmpConn, secret: 'authpass123' });
  ok(r.status === 400 && /both/.test(r.json.error), 'SNMP device needs both passwords');
  r = await req('POST', '/api/admin/hosts', { ...snmpConn, fingerprint: '' , secret: 'authpass123', secret2: 'privpass123' });
  ok(r.status === 400 && /engine ID/.test(r.json.error), 'SNMP device needs the pinned engine ID');
  r = await req('POST', '/api/admin/hosts', { ...snmpConn, secret: 'authpass123', secret2: 'privpass123' });
  ok(r.status === 201 && r.json.host.hasSecret, 'SNMP device added');
  noSecrets(r.text, 'add SNMP response');
  const snmpId = r.json.host.id;
  r = await req('POST', '/api/admin/test-connection', { ...snmpConn, id: snmpId });
  ok(r.json.ok === true && /APC Smart-UPS 1500/.test(r.json.info), `SNMP test: ${r.json.info || r.json.error}`);

  // --- NUT ---
  const nutConn = { type: 'nut', name: 'USB UPS', address: '127.0.0.1:18466', username: 'rackups' };
  r = await req('POST', '/api/admin/hosts', { ...nutConn, username: 'bad$name' });
  ok(r.status === 400 && /UPS name/.test(r.json.error), 'NUT: invalid UPS name rejected');
  r = await req('POST', '/api/admin/hosts', { ...nutConn, secret: 'should-not-be-stored' });
  ok(r.status === 201 && !r.json.host.hasSecret && r.json.host.tlsMode === 'none', 'NUT added without any secret');
  const nutId = r.json.host.id;
  r = await req('POST', '/api/admin/test-connection', { ...nutConn, username: 'nosuchups' });
  ok(r.json.ok === false && /No UPS called "nosuchups"/.test(r.json.error), `NUT: unknown UPS explained (${r.json.error})`);
  nutCommands = [];
  r = await req('POST', '/api/admin/test-connection', { ...nutConn, id: nutId });
  ok(r.json.ok === true && /Eaton 5E 1100i · battery 100 %/.test(r.json.info), `NUT test: ${r.json.info || r.json.error}`);
  ok(nutCommands.length === 1 && nutCommands[0] === 'LIST VAR rackups', 'NUT: only a read-only LIST VAR is sent (no login, no password)');
  r = await req('POST', '/api/admin/fingerprint', { type: 'nut', address: '127.0.0.1:18466' });
  ok(r.status === 400, 'NUT has no identity to fetch');

  // --- Omada ---
  const om = { type: 'omada', name: 'Omada', address: '127.0.0.1:18443', username: 'omview', tlsMode: 'pin', fingerprint: FP };
  r = await req('POST', '/api/admin/test-connection', { ...om, secret: 'wrongpass' });
  ok(r.json.ok === false && /Omada login failed/.test(r.json.error), `Omada wrong password: ${r.json.error}`);
  r = await req('POST', '/api/admin/test-connection', { ...om, secret: 'omadapass' });
  ok(r.json.ok === true && r.json.devices?.length === 3 && r.json.devices[1].mac === 'aa:bb:cc:00:00:02', `Omada test lists its devices: ${r.json.info || r.json.error}`);
  noSecrets(r.text, 'Omada test response');
  r = await req('POST', '/api/admin/hosts', { ...om, secret: 'omadapass' });
  ok(r.status === 201, 'Omada controller added');
  const omId = r.json.host.id;
  await sleep(1500); // the first poll logs in; measure after it, not alongside it
  const l0 = (await stats()).omadaLogins;
  for (let i = 0; i < 3; i++) await req('POST', `/api/admin/hosts/${omId}/test`, {});
  ok((await stats()).omadaLogins - l0 <= 1, 'Omada session reused across polls');

  // a device bound to one Omada device
  r = await req('POST', '/api/admin/devices', { name: 'Rack switch', kind: 'switch', location: 'none', height: 1, connections: [{ ...om, secret: 'omadapass', options: { mac: 'AA-BB-CC-00-00-02' } }] });
  ok(r.status === 201, 'device bound to an Omada switch');
  const boundDev = r.json.device.id;
  r = await req('POST', '/api/admin/devices', { name: 'Bad', kind: 'switch', location: 'none', height: 1, connections: [{ ...om, secret: 'omadapass', options: { mac: 'not-a-mac' } }] });
  ok(r.status === 400, 'invalid Omada device rejected');

  // --- Dashboard ---
  await sleep(2500);
  r = await req('GET', '/api/dashboard');
  noSecrets(r.text, 'dashboard API');
  const d = r.json;
  const ups = d.snmp[0]?.data?.ups;
  ok(ups && ups.model === 'Smart-UPS 1500' && ups.charge === 87 && ups.runtimeMin === 42 && ups.outputW === 312 && ups.loadPct === 31 && ups.source === 'Mains' && ups.inputV === 231, `UPS-MIB read: ${JSON.stringify(ups)}`);
  const sys = d.snmp[0]?.data?.system;
  ok(sys && sys.name === 'ds418-mock' && sys.uptime > 0, 'SNMP system group read');
  ok(Array.isArray(d.snmp[0]?.data?.ports), `SNMP ports read (${d.snmp[0]?.data?.ports?.length} Ethernet ports on this machine)`);
  const nu = d.nut[0]?.data?.ups;
  ok(nu && nu.maker === 'Eaton' && nu.charge === 100 && nu.runtimeMin === 31 && nu.loadPct === 24 && nu.outputW === 158 && !nu.onBattery, `NUT values: ${JSON.stringify(nu)}`);
  const omd = d.omada.find((h) => h.data)?.data;
  ok(omd && omd.devices.length === 3 && omd.devices[0].type === 'gateway' && omd.devices[2].online === false, 'Omada devices in the dashboard');
  ok(d.devices.find((x) => x.id === boundDev)?.connections[0].type === 'omada', 'bound device shows its Omada connection');

  // alerts: an offline Omada AP; a UPS running on battery
  onBattery = true;
  await req('POST', `/api/admin/hosts/${nutId}/test`, {});
  await sleep(2500);
  r = await req('GET', '/api/dashboard');
  const att = r.json.attention || [];
  ok(att.some((a) => /Garage EAP is offline/.test(a.text) || /Garage EAP/.test(a.subject || '')), 'offline Omada device needs attention');
  ok(att.some((a) => /running on battery/.test(a.text)), `UPS on battery needs attention (${att.map((a) => a.text).join(' | ')})`);

  // a public dashboard leaves out Omada IPs and versions, and SNMP system descriptions
  r = await req('GET', '/api/admin/config');
  const dash = r.json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: true } });
  const pub = await fetch(`${BASE}/api/dashboard`).then((x) => x.json());
  ok(pub.omada.every((h) => !h.data || h.data.devices.every((x) => x.ip === undefined && x.version === undefined)) && pub.snmp.every((h) => !h.data || h.data.system.descr === null), 'public dashboard hides Omada IPs/versions and SNMP descriptions');
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: false } });
  r = await req('GET', '/api/admin/config');
  noSecrets(r.text, 'admin config');
  const nh = r.json.hosts.find((h) => h.id === nutId);
  ok(nh && !nh.hasSecret, 'NUT connection still has no secret');

  nut.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
