'use strict';
// Incidents: every problem from start to end, and acknowledging one (from Home, or from the link in
// the alert message) so its reminders stop. Runs with OFFLINE_GRACE_S=0 and REMIND_HOUR_MS=2000
// (a "1 hour" reminder is due after 2 seconds, sent on the next poll).
const http = require('node:http');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
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
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
}

// --- an ntfy server ---
const posts = [];
const ntfy = http.createServer((q, res) => {
  let b = '';
  q.on('data', (c) => (b += c));
  q.on('end', () => {
    try { posts.push(JSON.parse(b)); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"x"}');
  });
}).listen(18475, '127.0.0.1');
const about = (name) => posts.filter((p) => p.title.includes(name) && !/resolved|back/i.test(p.tags.join()));

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // where links in messages point
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  let r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'https://lookout.test:8443/admin' } });
  ok(r.status === 400 && /without a path/.test(r.json.error), 'the address for links has no path');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'https://me@evil.test' } });
  ok(r.status === 400, 'nor a user name');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, refreshSeconds: 10, linkUrl: 'https://lookout.test:8443/' } });
  ok(r.status === 200 && r.json.settings.dashboard.linkUrl === 'https://lookout.test:8443', 'an address for links is saved');

  // ntfy gets "offline" right away, with a reminder every "hour"
  const ch = (await req('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'Phone', url: 'http://127.0.0.1:18475', topic: 'lab' })).json.channel;
  const rules = (await req('GET', '/api/admin/alerts')).json.rules;
  for (const k of Object.keys(rules)) rules[k] = { ...rules[k], channels: [] };
  rules.offline = { ...rules.offline, enabled: true, delay: 0, channels: [ch.id] };
  r = await req('PUT', '/api/admin/alerts', { rules, settings: { resolved: true, repeatHours: 1 } });
  ok(r.status === 200, 'offline alerts to ntfy, a reminder every hour');

  const dev = async (name, address) => (await req('POST', '/api/admin/devices', { name, kind: 'server', location: 'outside', connections: [{ type: 'ping', address }] })).json.device;
  const atlas = await dev('atlas', '192.0.2.21');
  const first = await until(() => about('atlas')[0]);
  ok(first, 'the alert is sent');

  // the incident is open, and Home knows it
  const inc = (await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.deviceId === atlas.id);
  ok(inc && inc.open && inc.type === 'offline' && inc.severity === 'critical' && inc.subject === 'atlas' && !inc.ack && !('key' in inc), `an open incident (${inc?.title})`);
  const att = (await req('GET', '/api/dashboard')).json.attention.find((a) => a.deviceId === atlas.id);
  ok(att?.incidentId === inc?.id && !att.ack, 'the problem on Home names its incident');

  // the message carries the link
  const link = first?.actions?.[0]?.url || '';
  ok(first?.click === 'https://lookout.test:8443' && first?.actions?.[0]?.label === 'Acknowledge' && link.startsWith(`https://lookout.test:8443/ack/${inc?.id}?t=`), `ntfy has a button to acknowledge (${link})`);
  ok(await until(() => about('atlas').length >= 2, 15000), 'a reminder comes while nobody has acknowledged it');

  // the link: a wrong token is refused; GET only asks (a link preview acknowledges nothing); POST does it
  const path = link.replace('https://lookout.test:8443', '');
  const token = new URL(link).searchParams.get('t');
  let page = await fetch(`${BASE}/ack/${inc.id}?t=${'A'.repeat(32)}`);
  ok(page.status === 404 && /not valid/.test(await page.text()), 'a wrong token is refused');
  page = await fetch(BASE + path);
  const html = await page.text();
  ok(page.status === 200 && /Acknowledge this problem\?/.test(html) && /<form method="post"/.test(html), 'opening the link asks first');
  ok(!(await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.id === inc.id).ack, 'only opening it acknowledges nothing');
  ok(page.headers.get('referrer-policy') === 'same-origin', 'the page lets its form say where it comes from');
  page = await fetch(`${BASE}/ack/${inc.id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site' }, body: `t=${token}` });
  ok(page.status === 403, `a form on another site cannot post it (${page.status})`);
  // what a browser sends from the page itself
  page = await fetch(`${BASE}/ack/${inc.id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, body: `t=${token}` });
  ok(page.status === 200 && />Acknowledged</.test(await page.text()), 'the button acknowledges it, without signing in');
  const acked = (await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.id === inc.id);
  ok(acked.ack?.via === 'link' && acked.open, 'the incident is acknowledged, still open');

  const n = about('atlas').length;
  await sleep(12000);
  ok(about('atlas').length === n, `no more reminders once acknowledged (${about('atlas').length - n} more)`);
  const a2 = (await req('GET', '/api/dashboard')).json.attention.find((a) => a.deviceId === atlas.id);
  ok(a2?.ack?.via === 'link', 'Home shows it as acknowledged');
  const log = (await req('GET', '/api/admin/events')).json.events || [];
  ok(log.some((e) => /Acknowledged from the alert message: atlas/.test(e.text)), 'the log says so');

  // from Home, signed in
  const vault = await dev('vault', '192.0.2.22');
  await until(() => about('vault')[0]);
  const inc2 = (await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.deviceId === vault.id && x.open);
  r = await req('POST', `/api/admin/incidents/${inc2.id}/ack`);
  ok(r.status === 200 && r.json.incident.ack.by === 'admin' && r.json.incident.ack.via === 'dashboard', 'acknowledged from Home, by the user');
  ok((await req('GET', `/api/admin/incidents?device=${vault.id}`)).json.incidents.every((x) => x.deviceId === vault.id), 'incidents of one device');
  r = await fetch(`${BASE}/api/admin/incidents/${inc2.id}/ack`, { method: 'POST' });
  ok(r.status === 401 || r.status === 403, `the API needs a sign-in (${r.status})`);

  // it clears: the incident ends with how long it lasted
  await req('DELETE', `/api/admin/devices/${atlas.id}`);
  const closed = await until(async () => (await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.id === inc.id && !x.open));
  ok(closed && closed.end >= closed.start && closed.duration === closed.end - closed.start, `the incident ends when the problem clears (${closed?.duration} ms)`);
  r = await req('POST', `/api/admin/incidents/${inc.id}/ack`);
  ok(r.status === 400, 'a cleared one cannot be acknowledged');
  page = await fetch(BASE + path);
  ok(/Already cleared/.test(await page.text()), 'the link says it has cleared');

  ok((await req('GET', '/api/admin/incidents')).json.keepDays === 365, 'kept for a year');

  ntfy.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL INCIDENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
