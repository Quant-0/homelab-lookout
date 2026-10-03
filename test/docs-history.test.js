'use strict';
// Docs page history: versions per page (ten-minute merging, 50 kept), restore, Recently deleted,
// and backup. test/run.js calls seed() on the data directory before the server starts.
const fs = require('node:fs');
const path = require('node:path');

const OLD = 'bbbbbbbb-0000-4000-8000-000000000001'; // a page from before history existed
const LONG = 'bbbbbbbb-0000-4000-8000-000000000002'; // a page that already has 50 versions
function seed(dir) {
  const day = 86400e3;
  fs.writeFileSync(path.join(dir, 'docs.json'), JSON.stringify({ servers: {}, network: { networks: [], reservations: [], notes: '' }, pages: [
    { id: OLD, title: 'Restore from backup', body: '1. Stop the VM\n2. Restore from PBS\n3. Start it', updatedAt: Date.now() - 30 * day },
    { id: LONG, title: 'Changelog', body: 'line 50', updatedAt: Date.now() - day },
  ] }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'docs-history.json'), JSON.stringify({
    pages: {
      [LONG]: Array.from({ length: 50 }, (_, i) => ({ v: i + 1, at: Date.now() - (60 - i) * 3600e3, title: 'Changelog', body: `line ${i + 1}` })),
      evil: [{ v: 1, at: 1, title: 'x', body: 'x' }],
    },
    deleted: [{ id: 'not-a-uuid', title: 'x', body: 'x', deletedAt: 1 }],
  }), { mode: 0o600 });
}
module.exports = { seed };

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false, raw = false } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf && !anon ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  if (raw) return r;
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const history = async (id) => (await req('GET', `/api/docs/pages/${id}/history`)).json?.versions || [];

async function run() {
  let r = await req('GET', '/api/docs/deleted', undefined, { anon: true });
  ok(r.status === 401, 'history and Recently deleted need login');
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  // a page from before history: its current state is the first version
  let v = await history(OLD);
  ok(v.length === 1 && v[0].v === 1 && v[0].title === 'Restore from backup', 'an older page shows one version');
  const put = (id, title, body) => req('PUT', `/api/docs/pages/${id}`, { title, body });
  await put(OLD, 'Restore from backup', '1. Stop the VM\n2. Restore from PBS (newest snapshot)\n3. Start it\n4. Check the logs');
  v = await history(OLD);
  ok(v.length === 2 && v[1].at < Date.now() - 86400e3, 'first edit keeps the old text as version 1');
  await put(OLD, 'Restore from backup', '1. Stop the VM\n2. Restore from PBS (newest snapshot)\n3. Start it\n4. Check the logs\n5. Tell the family');
  v = await history(OLD);
  ok(v.length === 2 && v[0].size > 90, 'saves within ten minutes count as one version');
  await put(OLD, 'Restore from backup', '1. Stop the VM\n2. Restore from PBS (newest snapshot)\n3. Start it\n4. Check the logs\n5. Tell the family');
  ok((await history(OLD)).length === 2, 'saving without changes adds nothing');
  r = await req('GET', `/api/docs/pages/${OLD}/history/1`);
  ok(r.json.version.body === '1. Stop the VM\n2. Restore from PBS\n3. Start it', 'an old version can be read');
  r = await req('GET', `/api/docs/pages/${OLD}/history/99`);
  ok(r.status === 404, 'unknown version: 404');

  // restore
  r = await req('POST', `/api/docs/pages/${OLD}/history/1/restore`, {});
  ok(r.status === 200 && r.json.page.body === '1. Stop the VM\n2. Restore from PBS\n3. Start it', 'restore puts the old text back');
  v = await history(OLD);
  ok(v.length === 3 && v[0].restoredFrom === 1, 'the restore is a version of its own (restored from 1)');
  await put(OLD, 'Restore from backup', 'after the restore');
  ok((await history(OLD)).length === 4, 'an edit right after a restore is not merged into it');

  // at most 50
  await put(LONG, 'Changelog', 'line 51');
  v = await history(LONG);
  ok(v.length === 50 && v[0].v === 51 && v.at(-1).v === 2, 'at most 50 versions; the oldest goes');

  // Recently deleted
  r = await req('PUT', '/api/docs/nav', { groups: [{ id: 'new-1', name: 'Procedures', items: [`page:${OLD}`] }] });
  const procedures = r.json.nav.groups[0].id;
  r = await req('DELETE', `/api/docs/pages/${OLD}`);
  ok(r.status === 200, 'page deleted');
  r = await req('GET', '/api/docs');
  ok(r.json.deletedCount === 1 && !r.json.docs.pages.some((p) => p.id === OLD) && !r.json.docs.nav.groups.some((g) => g.items?.includes(`page:${OLD}`)), 'gone from the pages and the menu; one in Recently deleted');
  r = await req('GET', '/api/docs/deleted');
  ok(r.json.deleted[0].id === OLD && r.json.deleted[0].versions === 4, 'Recently deleted keeps it with its 4 versions');
  r = await req('POST', `/api/docs/deleted/${OLD}/restore`, {});
  ok(r.status === 200 && r.json.page.id === OLD && r.json.page.body === 'after the restore' && r.json.nav.groups.find((g) => g.id === procedures).items.includes(`page:${OLD}`), 'restored with the same id, back in its group');
  v = await history(OLD);
  ok(v.length === 5 && v[0].restoredFrom === 'deleted', 'history kept, plus "restored after it was deleted"');
  r = await req('POST', `/api/docs/deleted/${OLD}/restore`, {});
  ok(r.status === 404, 'not in Recently deleted any more');

  // delete forever
  await req('DELETE', `/api/docs/pages/${LONG}`);
  r = await req('DELETE', `/api/docs/deleted/${LONG}`);
  ok(r.status === 200 && (await req('GET', '/api/docs/deleted')).json.deleted.length === 0, 'Delete forever empties Recently deleted');
  const file = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'docs-history.json'), 'utf8'));
  ok(!file.pages[LONG] && file.pages[OLD]?.length === 5 && !file.pages.evil && !file.deleted.length, 'its history is gone too; malformed entries were dropped on load');

  // backup and restore keep the history
  const bk = Buffer.from(await (await req('POST', '/api/admin/backup/download', { passphrase: 'backup passphrase 123' }, { raw: true })).arrayBuffer());
  await put(OLD, 'Restore from backup', 'changed after the backup');
  r = await fetch(`${BASE}/api/admin/backup/restore`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent('backup passphrase 123') }, body: bk });
  ok(r.status === 200, 'backup restored');
  v = await history(OLD);
  ok(v.length === 5 && v[0].restoredFrom === 'deleted', 'the history comes back with the backup');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DOCS HISTORY TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) run();
