'use strict';
// Homelab Lookout's own updates: the running commit (LOOKOUT_VERSION_FILE) compared with the latest
// GitHub release (the device mock plays GitHub's API). Runs with UPDATE_CHECK_GAP_S=1.
const fs = require('node:fs');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const MOCK = 'https://127.0.0.1:18443';
const VERSION = process.env.LOOKOUT_VERSION_FILE;
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
// the mock's own CA is trusted through NODE_EXTRA_CA_CERTS
const mock = (p) => fetch(MOCK + p).then((r) => r.json());
const commit = (c) => c.repeat(40);
async function check(version) {
  if (version !== undefined) fs.writeFileSync(VERSION, version);
  await sleep(1100);
  const r = await req('POST', '/api/admin/updates/check', {});
  return { status: r.status, row: r.json?.rows?.find((x) => x.source === 'lookout'), all: r.json };
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // a development copy (no VERSION): shown, not compared
  let { row } = await check('');
  ok(row && row.name === 'Homelab Lookout' && row.current === 'development copy' && !row.available, 'a copy not built from a commit is listed, not compared');
  let calls = (await mock('/gh/__requests')).length;
  ok(calls === 1, `and GitHub isn't asked (${calls - 1} calls besides the list)`);

  // older than the latest release: an update, with what's new and how
  ({ row } = await check(`${commit('a')}\n2026-10-01T10:00:00Z\n`));
  ok(row.available && row.latest === 'v1.2.0' && row.current === 'aaaaaaa', `an older version: v1.2.0 is available (${row.current} → ${row.latest})`);
  ok(row.detail === '3 changes since this version' && /git pull && sudo sh deploy\/install\.sh/.test(row.howTo), 'it says how many changes, and how to update (not in Docker)');
  ok(/What's new\n- Metrics for Prometheus\n- Undo in Admin/.test(row.notes) && !/\r/.test(row.notes), 'with the release notes');
  ok(row.url === 'https://github.com/Quant-0/homelab-lookout/releases/tag/v1.2.0', 'and a link to the release');
  const log = (await req('GET', '/api/admin/events')).json.events.map((e) => e.text);
  ok(log.includes('Homelab Lookout v1.2.0 is available (running aaaaaaa)'), 'a new release goes in the Log, once');
  const reqs = await mock('/gh/__requests');
  ok(reqs.some((x) => x.url === `/gh/repos/Quant-0/homelab-lookout/compare/${commit('a')}...v1.2.0`) && reqs.every((x) => x.url === '/gh/__requests' || x.agent === 'homelab-lookout (update check)'), 'it asks GitHub to compare this commit with the release, saying who it is');
  const dash = (await req('GET', '/api/dashboard')).json;
  ok(dash.updates.available >= 1, 'Home counts it with the other updates');

  // a release version in the image, the release itself, a newer build, an unknown commit
  ({ row } = await check(`${commit('a')}\n2026-10-01T10:00:00Z\n1.1.0\n`));
  ok(row.current === '1.1.0 (aaaaaaa)' && row.available, 'an image with its version: 1.1.0 → v1.2.0');
  ({ row } = await check(`${commit('b')}\n2026-10-14T10:00:00Z\n1.2.0\n`));
  ok(!row.available && row.current === 'v1.2.0' && !row.notes && !row.howTo, 'the release itself: up to date');
  ({ row } = await check(`${commit('c')}\n2026-10-15T10:00:00Z\n`));
  ok(!row.available && row.current === 'ccccccc, 2 changes newer than v1.2.0', `newer than the release (an :edge build): up to date (${row.current})`);
  ({ row } = await check(`${commit('d')}\n2026-10-15T10:00:00Z\n`));
  ok(!row.available && !row.error && /not on GitHub/.test(row.detail), 'a commit GitHub doesn\'t know: said so, no error');
  await fetch(`${MOCK}/__gh?release=0`);
  ({ row } = await check(`${commit('a')}\n2026-10-01T10:00:00Z\n`));
  ok(!row.available && row.detail === 'No release has been published yet', 'no release yet: said so');
  await fetch(`${MOCK}/__gh?release=1`);

  // Admin shows the version; the check can be switched off, and then GitHub isn't asked
  fs.writeFileSync(VERSION, `${commit('b')}\n2026-10-14T10:00:00Z\n1.2.0\n`);
  let r = await req('GET', '/api/admin/config');
  ok(r.json.runtime.version.release === '1.2.0' && r.json.runtime.version.commit === 'bbbbbbb' && r.json.runtime.repo === 'Quant-0/homelab-lookout', 'Admin → Server shows 1.2.0 and the repository');
  ok(r.json.settings.dashboard.lookoutUpdates === true, 'the check is on by default');
  r = await req('PUT', '/api/admin/settings', { dashboard: { ...r.json.settings.dashboard, lookoutUpdates: false } });
  ok(r.status === 200 && r.json.settings.dashboard.lookoutUpdates === false, 'it can be switched off');
  calls = (await mock('/gh/__requests')).length;
  const off = await check();
  ok(!off.row, 'off: no row for it');
  ok((await mock('/gh/__requests')).length === calls + 1, 'and GitHub is not asked');

  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
