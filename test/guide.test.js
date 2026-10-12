'use strict';
// The user guide PDF: for whoever may see the dashboard.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, { anon = false, headers: extra = {} } = {}) {
  const headers = { ...(cookie && !anon ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && !anon) cookie = sc.split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch {}
  return { status: r.status, json, buf, headers: r.headers };
}

(async () => {
  let r = await req('GET', '/guide.pdf', undefined, { anon: true });
  ok(r.status === 303 && r.headers.get('location') === '/login?next=guide', 'a private dashboard sends you to sign in first');

  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  r = await req('GET', '/guide.pdf');
  ok(r.status === 200 && r.headers.get('content-type') === 'application/pdf' && r.buf.subarray(0, 5).toString() === '%PDF-' && Number(r.headers.get('content-length')) === r.buf.length, `signed in: the PDF (${(r.buf.length / 1e6).toFixed(1)} MB)`);
  ok(/inline; filename="Homelab Lookout - User guide.pdf"/.test(r.headers.get('content-disposition')), 'opens in the browser, saves with a readable name');
  const etag = r.headers.get('etag');
  r = await req('GET', '/guide.pdf', undefined, { headers: { 'If-None-Match': etag } });
  ok(r.status === 304 && r.buf.length === 0, 'unchanged: 304 without a body');

  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, public: true } });
  r = await req('GET', '/guide.pdf', undefined, { anon: true });
  ok(r.status === 200 && r.buf.subarray(0, 5).toString() === '%PDF-', 'a public dashboard: visitors can open it too');

  r = await req('GET', '/static/js/common.js');
  ok(/href: '\/guide\.pdf'/.test(r.buf.toString()), 'the menu links to it');
  r = await req('GET', '/static/js/login.js');
  ok(/guide: '\/guide\.pdf'/.test(r.buf.toString()), 'after signing in you land on the guide');

  console.log(failures ? `\n${failures} FAILED` : '\nALL GUIDE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
