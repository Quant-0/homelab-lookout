'use strict';
// After a restart on the same data (test/sessions.test.js ran before): the kept session still works.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const STATE = path.join(os.tmpdir(), 'hd-sessions-test.json');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

(async () => {
  const { cookie } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  fs.rmSync(STATE, { force: true });
  let r = await fetch(`${BASE}/api/session`, { headers: { Cookie: cookie } });
  ok(r.status === 200, 'the session survived the restart (made before the password change, kept under the new one)');
  r = await fetch(`${BASE}/api/admin/config`, { headers: { Cookie: cookie } });
  ok(r.status === 200, 'and can use Admin');
  r = await fetch(`${BASE}/api/session`, { headers: { Cookie: 'hd_session=not-a-real-session-token' } });
  ok(r.status === 401, 'a made-up token is refused');
  r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  ok(r.status === 401, 'the old password no longer works');
  console.log(failures ? `\n${failures} FAILED` : '\nALL SESSION RESTART TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
