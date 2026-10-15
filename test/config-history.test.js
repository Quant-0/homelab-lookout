'use strict';
// Configuration history: every change made in Admin is a version that can be undone on its own
// (asking first when it was changed again since) or used to put everything back as it was then.
// test/run.js calls seed() before the server starts: a configuration that changed while the
// dashboard was not running. Runs with STEP_UP_S=4.
const fs = require('node:fs');
const path = require('node:path');

const SEEDED = 'cccccccc-0000-4000-8000-000000000001';
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ devices: [{ id: SEEDED, name: 'Seeded box', kind: 'server', location: 'none' }] }), { mode: 0o600 });
  // history from before: nothing tracked yet, and one broken version that is dropped
  fs.writeFileSync(path.join(dir, 'config-history.json'), JSON.stringify({ last: {}, versions: [{ v: 'x', at: 1, changes: [] }] }), { mode: 0o600 });
}
module.exports = { seed };

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf && !anon ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const cfg = async () => (await req('GET', '/api/admin/config')).json;
const versions = async () => (await req('GET', '/api/admin/config-history')).json.versions;
const idrac = { type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP };

async function run() {
  let r = await req('GET', '/api/admin/config-history', undefined, { anon: true });
  ok(r.status === 401, 'the history needs a sign-in');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // what changed while the dashboard was not running is a version of its own
  let vs = await versions();
  ok(vs.length === 1 && /outside the dashboard/.test(vs[0].texts[0]) && vs[0].by === null, 'a change made while stopped is recorded (and the broken version dropped)');
  ok(vs[0].changes.some((c) => c.label === 'Device Seeded box' && c.kind === 'added'), 'it names what changed');

  // --- each change made in Admin is a version, described like in the log ---
  r = await req('POST', '/api/admin/devices', { name: 'Atlas', kind: 'server', location: 'none', connections: [{ ...idrac, secret: 'calvin' }] });
  ok(r.status === 201, 'device added');
  const atlas = r.json.device;
  vs = await versions();
  const added = vs[0];
  ok(/Device added: Atlas/.test(added.texts.join()) && added.by === 'admin', `the version says what and who (${added.texts[0]})`);
  ok(added.changes.some((c) => c.label === 'Device Atlas' && c.kind === 'added') && added.changes.some((c) => c.label === 'Connection Atlas (idrac)' && c.kind === 'added'), 'the device and its connection are in one version');

  const host = (await cfg()).hosts.find((h) => h.deviceId === atlas.id);
  r = await req('PUT', `/api/admin/devices/${atlas.id}`, { name: 'Atlas 2', kind: 'server', location: 'none', connections: [{ ...idrac, id: host.id, secret: 'a-new-secret-value' }] });
  ok(r.status === 200, 'device renamed and its password changed');
  r = await req('GET', '/api/admin/config-history');
  const renamed = r.json.versions[0];
  ok(renamed.changes.some((c) => c.label === 'Device Atlas 2' && /Name: Atlas → Atlas 2/.test(c.detail)), 'the rename shows before → after');
  ok(renamed.changes.some((c) => /^Connection .*\(idrac\)$/.test(c.label) && /Secret changed/.test(c.detail)), 'a password is only said to have changed');
  ok(!/calvin|a-new-secret-value|"secret"|v1\./.test(r.text), 'no password, stored or plain, leaves the server');

  const dash = (await cfg()).settings.dashboard;
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...dash, title: 'Lab One' } });
  ok(r.status === 200, 'title changed');
  vs = await versions();
  ok(vs[0].changes.length === 1 && vs[0].changes[0].label === 'Dashboard settings' && /Title: Homelab Lookout → Lab One/.test(vs[0].changes[0].detail), 'a settings change names its section');
  const titleV = vs[0].v;

  // ids are shown as the names of what they point to
  const ch = (await req('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'Phone', url: 'http://127.0.0.1:18475', topic: 'lab' })).json.channel;
  const rules = (await req('GET', '/api/admin/alerts')).json.rules;
  r = await req('PUT', '/api/admin/alerts', { rules: { ...rules, offline: { ...rules.offline, channels: rules.offline.channels.includes(ch.id) ? [] : [ch.id] } }, settings: { resolved: true, repeatHours: 0 } });
  ok(r.status === 200, 'a rule changed');
  r = await req('GET', '/api/admin/config-history');
  const ruleText = r.json.versions.slice(0, 2).flatMap((v) => v.changes.map((x) => x.detail || '')).join(' | ');
  ok(/offline › channels: [^|]*Phone/.test(ruleText) && !ruleText.includes(ch.id), `a rule's channels are named (${ruleText.slice(0, 100)})`);

  r = await req('DELETE', `/api/admin/devices/${atlas.id}`);
  ok(r.status === 200, 'device deleted');
  vs = await versions();
  const deleted = vs[0];
  ok(deleted.changes.filter((c) => c.kind === 'removed').length === 2, 'the device and its connection went in one version');

  // a GET or a save without changes adds nothing
  await req('PUT', '/api/admin/settings', { dashboard: (await cfg()).settings.dashboard });
  ok((await versions())[0].v === deleted.v, 'saving without changes makes no version');

  // --- undo one change: the device comes back with its connection and password ---
  r = await req('POST', `/api/admin/config-history/${deleted.v}/undo`, {});
  ok(r.status === 200 && r.json.ok, 'the deletion is undone');
  let c = await cfg();
  const back = c.devices.find((d) => d.id === atlas.id);
  const backHost = c.hosts.find((h) => h.id === host.id);
  ok(back?.name === 'Atlas 2' && backHost?.deviceId === atlas.id && backHost.hasSecret, 'device, connection and stored password are back');
  ok(c.settings.dashboard.title === 'Lab One', 'later changes elsewhere are left alone');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: host.id });
  ok(r.json.ok === false && /401/.test(r.json.error || ''), 'with the password it had (the mock only knows calvin)');
  vs = await versions();
  ok(vs[0].undoOf === deleted.v && /Undid a change: Device removed: Atlas 2/.test(vs[0].texts[0]), `the undo is a version of its own (${vs[0].texts[0]})`);
  ok(vs[0].changes.length === 2 && vs[0].changes.every((x) => /^(Device|Connection) /.test(x.label) && x.kind === 'added'), `and holds only what it put back (${vs[0].changes.map((x) => x.label)})`);
  const log = (await req('GET', '/api/admin/events')).json.events;
  ok(log.some((e) => /^Undid a change/.test(e.text) && e.by === 'admin'), 'and is in the log');

  // undoing the undo deletes it again ("redid"); the deletion can then be undone once more
  r = await req('POST', `/api/admin/config-history/${vs[0].v}/undo`, {});
  ok(r.json.ok && !(await cfg()).devices.some((d) => d.id === atlas.id), 'an undo can be undone');
  ok(/^Redid a change: Device removed: Atlas 2$/.test((await versions())[0].texts[0]), 'which reads as redone');
  r = await req('POST', `/api/admin/config-history/${deleted.v}/undo`, {});
  ok(r.json.ok && (await cfg()).devices.some((d) => d.id === atlas.id), 'and the deletion undone again');

  // the rename, after it was renamed again: changed since, so it asks first
  r = await req('PUT', `/api/admin/devices/${atlas.id}`, { name: 'Atlas 3', kind: 'server', location: 'none' });
  r = await req('POST', `/api/admin/config-history/${renamed.v}/undo`, {});
  ok(r.json.conflict === true && r.json.parts.includes('Device Atlas 3'), `undoing the rename asks first (${r.json.parts})`);
  ok(r.json.later.some((x) => /Device updated: Atlas 3/.test(x.text)) && r.json.later.length === 5, `and lists what changed it since (${r.json.later.length})`);
  ok((await cfg()).devices.find((d) => d.id === atlas.id).name === 'Atlas 3', 'nothing changed before the answer');
  r = await req('POST', `/api/admin/config-history/${renamed.v}/undo`, { force: true });
  ok(r.json.ok && (await cfg()).devices.find((d) => d.id === atlas.id).name === 'Atlas', 'with force it is undone anyway');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: host.id });
  ok(r.json.ok, 'the password from before the rename is back too, and works');

  // an older change on its own: the title, while the device stays
  r = await req('POST', `/api/admin/config-history/${titleV}/undo`, {});
  c = await cfg();
  ok(r.json.ok && c.settings.dashboard.title === 'Homelab Lookout' && c.devices.some((d) => d.id === atlas.id), 'an older change is undone on its own');

  // --- restore everything to a point: right after the title was changed, then right after the device was added ---
  r = await req('POST', `/api/admin/config-history/${titleV}/restore`);
  ok(r.status === 200, 'restored to a point');
  c = await cfg();
  ok(c.devices.find((d) => d.id === atlas.id)?.name === 'Atlas 2' && c.settings.dashboard.title === 'Lab One', 'everything is as it was then');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: host.id });
  ok(r.json.ok === false, 'with the password from then');
  vs = await versions();
  ok(vs[0].restoreTo === titleV && /Configuration restored/.test(vs[0].texts[0]), 'the restore is a version');
  r = await req('POST', `/api/admin/config-history/${added.v}/restore`);
  c = await cfg();
  ok(r.status === 200 && c.devices.find((d) => d.id === atlas.id)?.name === 'Atlas' && c.settings.dashboard.title === 'Homelab Lookout', 'and back to just after the device was added');
  r = await req('POST', '/api/admin/test-connection', { ...idrac, id: host.id });
  ok(r.json.ok, 'its first password works again');
  vs = await versions();
  r = await req('POST', `/api/admin/config-history/${vs[0].v}/restore`);
  ok(r.status === 400 && /Nothing has changed/.test(r.json.error), 'restoring to now does nothing');
  r = await req('POST', '/api/admin/config-history/99999/undo', {});
  ok(r.status === 400 && /no longer kept/.test(r.json.error), 'an unknown version');

  // --- step-up: undo and restore need the password again after a while ---
  await sleep(4500);
  r = await req('POST', `/api/admin/config-history/${added.v}/restore`);
  ok(r.status === 403 && r.json.reauth, 'undo and restore ask for the password again');
  r = await req('GET', '/api/admin/config-history');
  ok(r.status === 200, 'looking needs no password');
  r = await req('POST', '/api/reauth', { password: 'correct horse battery' });
  r = await req('POST', `/api/admin/config-history/${vs[0].v}/undo`, {});
  ok(r.status === 200, 'after confirming it works');

  r = await req('GET', '/api/admin/config-history');
  ok(r.json.keepDays === 90 && r.json.keepMax === 500 && r.json.total === r.json.versions.length, 'kept for 90 days, at most 500');

  process.exit(failures ? 1 : 0);
}

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
