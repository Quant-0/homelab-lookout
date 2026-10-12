'use strict';
// Check-ins (a job calls its URL), maintenance windows (planned quiet), uptime and the public status page.
// Runs with CHECKIN_MINUTE_MS=1000 (a check-in "minute" is a second) and OFFLINE_GRACE_S=0.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false, headers: extra = {} } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf && !anon ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
}
const attention = async () => (await req('GET', '/api/dashboard')).json.attention;

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // ---------------- check-ins ----------------
  let r = await req('GET', '/api/admin/checkins', undefined, { anon: true });
  ok(r.status === 401, 'check-ins are managed by the admin only');
  r = await req('POST', '/api/admin/checkins', { name: '', everyMin: 5, graceMin: 5 });
  ok(r.status === 400, 'a check-in needs a name');
  r = await req('POST', '/api/admin/checkins', { name: 'Nightly backup', everyMin: 0, graceMin: 5 });
  ok(r.status === 400, 'the period must be at least a minute');
  r = await req('POST', '/api/admin/checkins', { name: 'Nightly backup', everyMin: 2, graceMin: 2 });
  const ck = r.json?.checkin;
  ok(r.status === 201 && /^\/ping\/[A-Za-z0-9_-]{32}$/.test(ck.path) && ck.status.state === 'new' && ck.every === '2 min', `a check-in with its own address (${ck?.path})`);
  ok(!(await attention()).some((a) => a.type === 'checkin'), 'a check-in that never ran is not a problem yet');

  r = await req('GET', ck.path, undefined, { anon: true });
  ok(r.status === 200 && r.text === 'OK\n' && r.headers.get('cache-control') === 'no-store', 'calling the address checks in, without a login');
  r = await req('POST', ck.path, 'log output from the job', { anon: true, headers: { Origin: 'https://elsewhere.example', 'Content-Type': 'text/plain' } });
  ok(r.status === 200, 'a POST from a script (any origin, with a body) works too');
  r = await req('PUT', ck.path, undefined, { anon: true });
  ok(r.status === 405, 'other methods are refused');
  r = await req('GET', '/ping/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', undefined, { anon: true });
  ok(r.status === 404, 'an unknown address is a 404');
  let st = (await req('GET', '/api/admin/checkins')).json.checkins[0].status;
  ok(st.state === 'up' && st.last > Date.now() - 5000, 'the check-in is up');

  // late after its period, missed after the grace time (a minute is a second here)
  st = await until(async () => { const s = (await req('GET', '/api/admin/checkins')).json.checkins[0].status; return s.state === 'late' && s; }, 5000);
  ok(st?.state === 'late', 'late once the period has passed');
  const missed = await until(async () => (await attention()).find((a) => a.type === 'checkin'), 8000);
  ok(missed && missed.severity === 'critical' && missed.subject === 'Nightly backup' && missed.text === 'missed its check-in' && /^Last check-in \d{4}-\d\d-\d\d \d\d:\d\d; expected every 2 min$/.test(missed.detail), `missed after the grace time (${missed?.text})`);
  await req('GET', ck.path, undefined, { anon: true });
  ok(!(await attention()).some((a) => a.type === 'checkin'), 'checking in again clears it');

  await req('GET', `${ck.path}/fail`, undefined, { anon: true });
  const failed = (await attention()).find((a) => a.type === 'checkin');
  ok(failed && failed.subject === 'Nightly backup' && failed.text === 'reported a failure', 'calling …/fail reports a failure at once');
  r = await req('POST', `/api/admin/checkins/${ck.id}/reset`);
  ok(r.status === 200 && r.json.checkins[0].status.state === 'new' && !(await attention()).some((a) => a.type === 'checkin'), 'reset forgets the failure');
  await req('GET', `${ck.path}/start`, undefined, { anon: true });
  ok((await req('GET', '/api/admin/checkins')).json.checkins[0].status.lastStart > 0, '…/start notes when the job began');

  r = await req('POST', `/api/admin/checkins/${ck.id}/token`);
  const newPath = r.json.checkin.path;
  ok(newPath !== ck.path && (await req('GET', ck.path, undefined, { anon: true })).status === 404 && (await req('GET', newPath, undefined, { anon: true })).status === 200, 'a new address replaces the old one at once');
  r = await req('PUT', `/api/admin/checkins/${ck.id}`, { name: 'Nightly backup', everyMin: 1440, graceMin: 60 });
  ok(r.status === 200 && r.json.checkin.every === '1 day' && r.json.checkin.grace === '1 h' && r.json.checkin.path === newPath, 'editing keeps the address');
  const log = (await req('GET', '/api/admin/events?cat=alerts')).json.events.map((e) => e.text);
  ok(log.some((t) => /^Check-in added: Nightly backup/.test(t)) && log.some((t) => /new URL/.test(t)), 'changes are in the Log');

  // ---------------- maintenance ----------------
  const dev = (await req('POST', '/api/admin/devices', { name: 'orion', kind: 'server', location: 'outside', connections: [{ type: 'ping', address: '192.0.2.1' }] })).json.device;
  const svc = (await req('POST', '/api/admin/services', { name: 'Web', group: 'Apps', href: 'http://10.9.9.9/secret-path', description: 'internal note', icon: { kind: 'letter' }, connection: null, integration: null, monitor: { type: 'tcp', host: '127.0.0.1', port: 18080 } })).json.service;
  const down = await until(async () => (await attention()).find((a) => a.deviceId === dev.id), 15000);
  ok(down && !down.maintenance, 'a device that stops answering is a problem');

  const now = Date.now();
  r = await req('POST', '/api/admin/maintenance', { name: 'x', targets: { devices: [] }, schedule: { kind: 'once', start: now, end: now + 3600e3 } });
  ok(r.status === 400 && /Choose what/.test(r.json.error), 'a window needs something to cover');
  r = await req('POST', '/api/admin/maintenance', { name: 'x', targets: { devices: [dev.id] }, schedule: { kind: 'once', start: now - 7200e3, end: now - 3600e3 } });
  ok(r.status === 400 && /already passed/.test(r.json.error), 'a window in the past is refused');
  r = await req('POST', '/api/admin/maintenance', { name: 'x', targets: { devices: [dev.id] }, schedule: { kind: 'weekly', days: [], start: '02:00', minutes: 60 } });
  ok(r.status === 400 && /day/.test(r.json.error), 'a weekly window needs a day');

  r = await req('POST', '/api/admin/maintenance', { name: 'Disk swap', targets: { devices: [dev.id], checkins: [ck.id] }, schedule: { kind: 'once', start: now - 1000, end: now + 3600e3 } });
  const win = r.json?.windows?.find((w) => w.name === 'Disk swap');
  ok(r.status === 201 && win.active && win.until === now + 3600e3, 'maintenance starting now');
  let d = (await req('GET', '/api/dashboard')).json;
  const held = d.attention.find((a) => a.deviceId === dev.id);
  ok(held?.maintenance?.name === 'Disk swap' && d.maintenance.length === 1 && d.maintenance[0].devices.includes(dev.id), 'its problems are marked as maintenance on Home');
  await sleep(1500);
  const active = (await req('GET', '/api/admin/alerts')).json.active;
  ok(!active.some((a) => a.title.startsWith('orion')), 'no alert is started while in maintenance');
  await req('GET', `${newPath}/fail`, undefined, { anon: true });
  ok((await attention()).find((a) => a.type === 'checkin')?.maintenance?.name === 'Disk swap', 'a check-in can be in maintenance too');
  await req('POST', `/api/admin/checkins/${ck.id}/reset`);

  r = await req('POST', `/api/admin/maintenance/${win.id}/end`);
  ok(r.status === 200 && !r.json.windows.find((w) => w.id === win.id).active, 'ending it early');
  d = (await req('GET', '/api/dashboard')).json;
  ok(!d.maintenance.length && d.attention.find((a) => a.deviceId === dev.id)?.maintenance === null, 'afterwards the problem counts again');
  r = await req('POST', `/api/admin/maintenance/${win.id}/end`);
  ok(r.status === 400, 'a window that is not on cannot be ended');

  // weekly: on today's weekday from 10 minutes ago, in Oslo time
  const z = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() - 10 * 60e3));
  const part = (t) => z.find((x) => x.type === t).value;
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday'));
  r = await req('POST', '/api/admin/maintenance', { name: 'Weekly patching', targets: { services: [svc.id] }, schedule: { kind: 'weekly', days: [wd], start: `${part('hour')}:${part('minute')}`, minutes: 60 } });
  const weekly = r.json?.windows?.find((w) => w.name === 'Weekly patching');
  ok(r.status === 201 && weekly.active && weekly.until > Date.now() + 40 * 60e3, `a weekly window that is on now (${weekly?.text})`);
  r = await req('POST', '/api/admin/maintenance', { name: 'Other day', targets: { all: true }, schedule: { kind: 'weekly', days: [(wd + 3) % 7], start: '03:00', minutes: 30 } });
  const later = r.json.windows.find((w) => w.name === 'Other day');
  ok(!later.active && later.next && later.next.start > Date.now() && later.next.end - later.next.start === 30 * 60e3, 'a weekly window on another day says when it is next');
  await req('DELETE', `/api/admin/maintenance/${later.id}`);

  // ---------------- status page ----------------
  r = await req('GET', '/status', undefined, { anon: true });
  ok(r.status === 404 && (await req('GET', '/api/status', undefined, { anon: true })).status === 404, 'the status page is off until switched on');
  ok((await req('GET', '/static/js/status.js', undefined, { anon: true })).status === 401, '…and so is its script');
  r = await req('GET', '/api/status');
  ok(r.status === 200, 'signed in, it can be previewed');
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, statusPage: { enabled: true, title: 'Lab status' } } });
  ok(r.status === 200 && r.json.settings.dashboard.statusPage.enabled, 'switched on');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, statusPage: undefined, title: 'My Lab' } });
  ok(r.json.settings.dashboard.statusPage.enabled === true, 'saving the dashboard form leaves it as it is');
  r = await req('GET', '/status', undefined, { anon: true });
  ok(r.status === 200 && /<title>Status<\/title>/.test(r.text) && (await req('GET', '/static/js/status.js', undefined, { anon: true })).status === 200, 'anyone can open it now');
  const pub = (await req('GET', '/api/status', undefined, { anon: true }));
  const web = pub.json.groups.flatMap((g) => g.services).find((x) => x.name === 'Web');
  ok(pub.json.title === 'Lab status' && web && web.state === 'maintenance' && pub.json.overall === 'maintenance', `a service in maintenance (${web?.state}, overall ${pub.json.overall})`);
  ok(pub.json.maintenance.some((w) => w.name === 'Weekly patching' && w.active), 'the maintenance is announced');
  ok(!/10\.9\.9\.9|secret-path|internal note|127\.0\.0\.1|orion/.test(pub.text), 'no links, addresses, descriptions or devices on it');
  ok(!(await req('GET', '/api/dashboard', undefined, { anon: true })).json?.attention, 'the dashboard itself stays private');

  // uptime: time in maintenance doesn't count, so the service has none yet; after the window it does
  await req('POST', `/api/admin/maintenance/${weekly.id}/end`);
  const up = await until(async () => {
    const s = (await req('GET', '/api/status', undefined, { anon: true })).json.groups.flatMap((g) => g.services).find((x) => x.name === 'Web');
    return s?.state === 'up' && s.uptime.d1 !== null && s;
  }, 20000);
  ok(up && up.uptime.d1 === 1 && up.days.length >= 1 && pub.json.groups.length >= 1, `uptime is recorded (${up?.uptime.d1})`);

  // ---------------- clean-up when things are deleted ----------------
  r = await req('POST', '/api/admin/maintenance', { name: 'Only orion', targets: { devices: [dev.id] }, schedule: { kind: 'once', start: Date.now() + 3600e3, end: Date.now() + 7200e3 } });
  await req('DELETE', `/api/admin/devices/${dev.id}`);
  r = await req('GET', '/api/admin/maintenance');
  ok(!r.json.windows.some((w) => w.name === 'Only orion'), 'a window left with nothing to cover goes when its device is deleted');
  r = await req('DELETE', `/api/admin/checkins/${ck.id}`);
  ok(r.status === 200 && !r.json.checkins.length && (await req('GET', newPath, undefined, { anon: true })).status === 404, 'a deleted check-in stops answering');

  // ---------------- a backup brings them back ----------------
  const kept = (await req('POST', '/api/admin/checkins', { name: 'Offsite sync', everyMin: 60, graceMin: 15 })).json.checkin;
  await req('POST', '/api/admin/maintenance', { name: 'Sunday patching', targets: { checkins: [kept.id], services: [svc.id] }, schedule: { kind: 'weekly', days: [6], start: '02:00', minutes: 120 } });
  const file = Buffer.from(await (await fetch(`${BASE}/api/admin/backup/download`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'backup passphrase 123' }) })).arrayBuffer());
  await req('DELETE', `/api/admin/checkins/${kept.id}`);
  r = await fetch(`${BASE}/api/admin/backup/restore`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent('backup passphrase 123') }, body: file });
  ok(r.status === 200, 'restored a backup');
  const back = (await req('GET', '/api/admin/checkins')).json.checkins.find((c) => c.name === 'Offsite sync');
  const backWin = (await req('GET', '/api/admin/maintenance')).json.windows.find((w) => w.name === 'Sunday patching');
  ok(back?.path === kept.path && backWin?.targets.checkins[0] === kept.id && backWin.text === 'Sun 02:00 for 2 h', 'check-ins keep their address, windows what they cover');
  ok((await req('GET', kept.path, undefined, { anon: true })).status === 200, 'the restored address answers');

  console.log(failures ? `\n${failures} FAILED` : '\nALL SCHEDULE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
