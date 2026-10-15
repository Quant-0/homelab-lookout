'use strict';
// Metrics export: /metrics (Prometheus) and /metrics.json (Home Assistant) with a token made in Admin
// that works only from the addresses entered with it. Uses the iDRAC mock, the service mock and an
// agent report.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const scrape = async (p, auth, headers = {}) => {
  const r = await fetch(BASE + p, { headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } });
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(400);
  }
}
const value = (text, re) => {
  const line = text.split('\n').find((l) => re.test(l));
  return line ? Number(line.split(' ').pop()) : null;
};

(async () => {
  let r = await scrape('/metrics');
  ok(r.status === 403, 'without any token, nothing (and not from this address either)');

  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, refreshSeconds: 10 } });

  // something to measure: a server with an iDRAC, a service, an agent
  r = await req('POST', '/api/admin/devices', { name: 'Atlas "R730"', kind: 'server', location: 'none', connections: [{ type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  ok(r.status === 201, 'a server with an iDRAC');
  await req('POST', '/api/admin/services', { name: 'Wiki', connection: { url: 'http://127.0.0.1:18090/' } });
  r = await req('POST', '/api/admin/agents', { name: 'pi', attach: 'new', interval: 30, updates: true });
  const agent = r.json;
  await fetch(`${BASE}/agent/report`, { method: 'POST', headers: { Authorization: `Bearer ${agent.agent.id}.${agent.token}`, 'Content-Type': 'application/json', Accept: 'text/plain' }, body: JSON.stringify({
    agent: '1.0.0', hostname: 'pi', uptime: 3600, cpu: { cores: 4, usage: 12.5, load: [0.5, 0.4, 0.3] }, mem: { total: 4e9, available: 3e9 },
    fs: [{ mount: '/', type: 'ext4', size: 32e9, used: 8e9 }], updates: { count: 3, security: 1, reboot: true }, watched: [{ unit: 'nginx.service', state: 'active' }], failed: [],
  }) });

  // --- tokens in Admin ---
  r = await req('POST', '/api/admin/metrics-tokens', { name: 'Prometheus', allow: '' });
  ok(r.status === 400 && /addresses it may be used from/.test(r.json.error), 'a token needs the addresses it may be used from');
  r = await req('POST', '/api/admin/metrics-tokens', { name: 'Prometheus', allow: '127.0.0.1; rm' });
  ok(r.status === 400 && /not an IP address/.test(r.json.error), 'and they must be addresses or ranges');
  r = await req('POST', '/api/admin/metrics-tokens', { name: 'Prometheus', allow: '127.0.0.0/8, ::1' });
  ok(r.status === 201 && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(r.json.secret), 'a token is made and shown once');
  const prom = r.json;
  ok(/job_name: homelab-lookout/.test(prom.setup.prometheus) && prom.setup.prometheus.includes(prom.secret) && prom.setup.url === `${BASE}/metrics`, 'with a Prometheus scrape config that holds it');
  ok(/resource: http:\/\/127\.0\.0\.1:18080\/metrics\.json/.test(prom.setup.homeAssistant) && /!secret lookout_metrics/.test(prom.setup.homeAssistant), 'and Home Assistant REST sensors');
  r = await req('GET', '/api/admin/metrics-tokens');
  ok(r.json.tokens.length === 1 && r.json.tokens[0].usedAt === null && !r.text.includes(prom.secret.split('.')[1]) && !r.text.includes('tokenHash'), 'listed; the token is never shown again');
  const other = (await req('POST', '/api/admin/metrics-tokens', { name: 'Elsewhere', allow: '192.0.2.10' })).json;

  // --- who may scrape ---
  r = await scrape('/metrics', 'x');
  ok(r.status === 401, 'a wrong token: 401');
  r = await scrape('/metrics', `${prom.token.id}.${'A'.repeat(43)}`);
  ok(r.status === 401, 'a guessed token: 401');
  r = await scrape('/metrics', other.secret);
  ok(r.status === 403 && /not available from this address/.test(r.text), 'a real token from an address it does not list: 403');
  r = await scrape('/metrics', prom.secret, { Cookie: cookie });
  ok(r.status === 200 && /^text\/plain; version=0\.0\.4/.test(r.type), 'the right token from its address: Prometheus text');
  r = await fetch(`${BASE}/metrics`, { method: 'POST', headers: { Authorization: `Bearer ${prom.secret}` } });
  ok(r.status === 405, 'only GET');
  ok((await scrape('/metrics', null, { Cookie: cookie })).status === 401, 'a browser sign-in is not enough');

  // --- what is in it ---
  const m = await until(async () => {
    const t = (await scrape('/metrics', prom.secret)).text;
    return /lookout_power_watts\{/.test(t) && /lookout_service_up\{/.test(t) ? t : null;
  });
  ok(m, 'the iDRAC and the service have been polled');
  const text = m || '';
  ok(/^# HELP lookout_info /m.test(text) && /^# TYPE lookout_device_up gauge$/m.test(text), 'HELP and TYPE lines');
  ok(text.split('\n').filter((l) => l.startsWith('# TYPE lookout_device_up ')).length === 1, 'each family once');
  ok(value(text, /^lookout_device_up\{device="Atlas \\"R730\\"",kind="server"\}/) === 1, 'a name with quotes is escaped, and the device is up');
  ok(value(text, /^lookout_power_watts\{device="Atlas \\"R730\\"",source="idrac"\}/) > 0, 'the iDRAC power reading');
  ok(/^lookout_temperature_celsius\{device="Atlas \\"R730\\"",sensor="[^"]+"\} \d/m.test(text), 'its temperatures');
  ok(/^lookout_fan_(rpm|percent)\{/m.test(text) && /^lookout_psu_healthy\{/m.test(text), 'fans and power supplies');
  ok(value(text, /^lookout_service_up\{service="Wiki"\}/) === 1 && value(text, /^lookout_service_response_seconds\{service="Wiki"\}/) >= 0, 'the service is up, with its response time');
  ok(value(text, /^lookout_agent_up\{agent="pi",device="pi"\}/) === 1, 'the agent');
  ok(value(text, /^lookout_agent_memory_used_bytes\{agent="pi"/) === 1e9 && value(text, /^lookout_agent_cpu_ratio\{agent="pi"/) === 0.125, 'its memory and CPU');
  ok(value(text, /^lookout_storage_used_bytes\{device="pi",storage="\/"/) === 8e9 || value(text, /^lookout_storage_used_bytes\{agent="pi",device="pi",storage="\/"\}/) === 8e9, 'its filesystems');
  ok(value(text, /^lookout_agent_security_updates_pending\{agent="pi"/) === 1 && value(text, /^lookout_agent_reboot_required\{agent="pi"/) === 1, 'updates and a reboot');
  ok(value(text, /^lookout_agent_service_up\{agent="pi",device="pi",unit="nginx.service"\}/) === 1, 'a watched service');
  ok(/^lookout_problems\{severity="critical"\} \d+$/m.test(text) && /^lookout_energy_kwh\{period="today"\} /m.test(text), 'problems and energy');
  ok(!/127\.0\.0\.1|calvin|root|18443|18090/.test(text), 'no addresses, users or passwords in it');
  const bad = text.split('\n').filter((l) => l && !l.startsWith('#') && !/^[a-z_][a-z0-9_]*(\{[^}]*\})? -?[\d.e+-]+$/.test(l));
  ok(!bad.length, `every line parses ${bad.slice(0, 3).join(' / ')}`);

  // --- Home Assistant ---
  r = await scrape('/metrics.json', prom.secret);
  const j = JSON.parse(r.text);
  ok(r.status === 200 && /^application\/json/.test(r.type), '/metrics.json with the same token');
  ok(j.devices.atlas_r730?.up === true && j.devices.atlas_r730.watts > 0 && typeof j.devices.atlas_r730.temp_max === 'number', 'devices by key, with power and temperature');
  ok(j.services.wiki?.up === true && j.services.up >= 1, 'services by key');
  ok(typeof j.problems.critical === 'number' && Array.isArray(j.problems.list) && 'today_kwh' in j.power, 'problems and power');
  ok(!/127\.0\.0\.1|calvin|18443/.test(r.text), 'no addresses or secrets');
  ok((await scrape('/metrics.json', other.secret)).status === 403, 'and only from the listed addresses');

  // last used, changing and removing a token
  r = await req('GET', '/api/admin/metrics-tokens');
  ok(r.json.tokens.find((t) => t.id === prom.token.id).usedFrom === '127.0.0.1', 'Admin shows when and from where it was last used');
  r = await req('PUT', `/api/admin/metrics-tokens/${prom.token.id}`, { name: 'Prometheus', allow: '192.0.2.20' });
  ok(r.status === 200 && (await scrape('/metrics', prom.secret)).status === 403, 'changing its addresses takes effect at once');
  r = await req('PUT', `/api/admin/metrics-tokens/${prom.token.id}`, { name: 'Prometheus', allow: '127.0.0.1' });
  r = await req('DELETE', `/api/admin/metrics-tokens/${prom.token.id}`);
  ok(r.status === 200 && (await scrape('/metrics', prom.secret)).status === 403, 'a removed token stops working');
  const log = (await req('GET', '/api/admin/events')).json.events.map((e) => e.text);
  ok(log.includes('Metrics token added: Prometheus') && log.includes('Metrics token removed: Prometheus'), 'adding and removing are logged');
  const hist = (await req('GET', '/api/admin/config-history')).json.versions;
  ok(hist[0].changes.some((c) => c.label === 'Metrics token Prometheus' && c.kind === 'removed') && !JSON.stringify(hist).includes(prom.secret.split('.')[1]), 'and in the configuration history, without the token');

  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
