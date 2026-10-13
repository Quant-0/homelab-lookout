'use strict';
// Push to the app (Web Push) and webhooks. A mock push service checks the VAPID signature
// (RFC 8292) and decrypts each message as a browser would (RFC 8291); the decryption here is first
// checked against the RFC's own example. Runs with PUSH_HOSTS=127.0.0.1:18476, the mock's CA
// trusted (NODE_EXTRA_CA_CERTS) and OFFLINE_GRACE_S=0.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
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
const b64 = (x) => Buffer.from(x).toString('base64url');

// --- what a browser does with a push message (RFC 8291, aes128gcm) ---
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const prkKey = crypto.createHmac('sha256', authSecret).update(shared).digest();
  const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])])).digest();
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const cek = crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).digest().subarray(0, 16);
  const nonce = crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).digest().subarray(0, 12);
  const data = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  const end = plain.lastIndexOf(2); // padding delimiter of the last record
  return plain.subarray(0, end).toString('utf8');
}

// a browser's subscription
function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), pub, auth: crypto.randomBytes(16) };
}

// --- the push service ---
const pushed = [];
let gone = new Set();
const cdir = process.env.MOCK_CERT_DIR;
const pushSrv = https.createServer({ key: fs.readFileSync(path.join(cdir, 'key.pem')), cert: fs.readFileSync(path.join(cdir, 'cert.pem')) }, (q, res) => {
  const chunks = [];
  q.on('data', (c) => chunks.push(c));
  q.on('end', () => {
    pushed.push({ path: q.url, headers: q.headers, body: Buffer.concat(chunks) });
    res.writeHead(gone.has(q.url) ? 410 : 201).end();
  });
}).listen(18476, '127.0.0.1');
const hooks = [];
const hookSrv = http.createServer((q, res) => {
  let b = '';
  q.on('data', (c) => (b += c));
  q.on('end', () => {
    hooks.push({ path: q.url, headers: q.headers, json: JSON.parse(b) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
}).listen(18477, '127.0.0.1');

// the VAPID header: a JWT signed with the key it names
function vapidOk(h, aud) {
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(h || '');
  if (!m) return false;
  const [head, claims, sig] = m[1].split('.');
  const k = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(k.subarray(1, 33)), y: b64(k.subarray(33)) }, format: 'jwk' });
  const c = JSON.parse(Buffer.from(claims, 'base64url'));
  return JSON.parse(Buffer.from(head, 'base64url')).alg === 'ES256' && crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))
    && c.aud === aud && c.exp > Date.now() / 1000 && c.exp < Date.now() / 1000 + 86400 && /^(mailto:|https:)/.test(c.sub) && m[2];
}

(async () => {
  // the decryption above, on RFC 8291's example (appendix A)
  const ex = Buffer.from('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', 'base64url');
  let rfc = '';
  try {
    rfc = decrypt(ex, Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'), Buffer.from('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'base64url'), Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'));
  } catch (e) {
    rfc = e.message;
  }
  ok(rfc === 'When I grow up, I want to be a watermelon', `the test's decryption reads RFC 8291's example (${rfc})`);

  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const dash = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...dash, refreshSeconds: 10 } });

  // --- push ---
  let r = await req('POST', '/api/admin/alerts/channels', { type: 'push', name: 'Phones' });
  ok(r.status === 201 && r.json.channel.subs.length === 0, 'a push channel needs nothing but a name');
  const ch = r.json.channel;
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/test`);
  ok(r.json.ok === false && /No browser has push turned on/.test(r.json.error), 'without a device it says how to turn it on');

  const key = (await req('GET', '/api/admin/push/key')).json.publicKey;
  ok(Buffer.from(key, 'base64url').length === 65 && Buffer.from(key, 'base64url')[0] === 4, 'the key browsers subscribe with');
  ok((await fetch(`${BASE}/api/admin/push/key`)).status === 401, 'only for the admin');

  const phone = browser();
  const laptop = browser();
  const sub = (b, n) => ({ endpoint: `https://127.0.0.1:18476/push/${n}`, keys: { p256dh: b64(b.pub), auth: b64(b.auth) } });
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/subscriptions`, { subscription: { ...sub(phone, 'a'), endpoint: 'https://push.evil.test/x' }, label: 'iPhone' });
  ok(r.status === 400 && /push service/.test(r.json.error), 'only a known push service');
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/subscriptions`, { subscription: { ...sub(phone, 'a'), keys: { p256dh: b64(Buffer.alloc(65, 4)), auth: b64(phone.auth) } }, label: 'iPhone' });
  ok(r.status === 400, 'keys that are not a point on the curve are refused');
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/subscriptions`, { subscription: sub(phone, 'phone-token-123'), label: 'iPhone · app' });
  ok(r.status === 201 && r.json.sub.label === 'iPhone · app' && r.json.sub.by === 'admin' && !('endpoint' in r.json.sub), 'the phone turns push on');
  const phoneSub = r.json.sub;
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/subscriptions`, { subscription: sub(phone, 'phone-token-123'), label: 'iPhone · app' });
  ok(r.json.sub.id === phoneSub.id, 'the same browser again keeps its entry');
  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/subscriptions`, { subscription: sub(laptop, 'laptop-token-456'), label: 'Mac · Firefox' });
  const status = r.json.status;
  ok(status.channels.find((c) => c.id === ch.id).subs.length === 2, 'turning it on twice in the same browser counts once');
  const shown = (await req('GET', '/api/admin/alerts')).text + (await req('GET', '/api/admin/config')).text;
  ok(!shown.includes('phone-token-123') && !shown.includes(b64(phone.pub)), 'the push addresses and keys are never sent back');

  r = await req('POST', `/api/admin/alerts/channels/${ch.id}/test`);
  ok(r.json.ok, `Send test (${r.json.error || 'ok'})`);
  const p1 = pushed.find((x) => x.path === '/push/phone-token-123');
  ok(p1 && p1.headers['content-encoding'] === 'aes128gcm' && p1.headers.ttl === '86400' && p1.headers['content-type'] === 'application/octet-stream', 'sent as an encrypted push message');
  ok(vapidOk(p1?.headers.authorization, 'https://127.0.0.1:18476') === key, 'signed with the VAPID key the browser subscribed with');
  let msg = null;
  try {
    msg = JSON.parse(decrypt(p1.body, phone.priv, phone.pub, phone.auth));
  } catch (e) {
    console.log(e.message);
  }
  ok(msg?.title === 'Test notification' && msg.url === '/', `the phone can read it, nobody else (${msg?.title})`);
  let other = null;
  try {
    other = decrypt(p1.body, laptop.priv, laptop.pub, laptop.auth);
  } catch {}
  ok(other === null, "the laptop's keys can't");
  ok(!p1.body.includes('Test notification'), 'the push service sees no text');

  // --- webhook ---
  r = await req('POST', '/api/admin/alerts/channels', { type: 'webhook', name: 'Home Assistant' });
  ok(r.status === 400, 'a webhook needs its URL');
  r = await req('POST', '/api/admin/alerts/channels', { type: 'webhook', name: 'Home Assistant', secret: 'http://user:pw@127.0.0.1:18477/x' });
  ok(r.status === 400, 'no login in the URL');
  r = await req('POST', '/api/admin/alerts/channels', { type: 'webhook', name: 'Home Assistant', secret: 'http://127.0.0.1:18477/api/webhook/secret-hook-id-789?x=1' });
  const hook = r.json.channel;
  ok(r.status === 201 && hook.url === 'http://127.0.0.1:18477' && hook.hasSecret, 'a webhook shows only where it goes');
  ok(!(await req('GET', '/api/admin/alerts')).text.includes('secret-hook-id-789'), 'its path (often the secret) is never sent back');
  r = await req('POST', `/api/admin/alerts/channels/${hook.id}/test`);
  ok(r.json.ok && hooks.at(-1)?.path === '/api/webhook/secret-hook-id-789?x=1' && hooks.at(-1).json.source === 'homelab-lookout' && hooks.at(-1).json.title === 'Test notification', `the test reaches the whole URL (${r.json.error || hooks.at(-1)?.path})`);
  r = await req('PUT', `/api/admin/alerts/channels/${hook.id}`, { name: 'HA', url: 'http://127.0.0.1:18477', tlsMode: 'verify' });
  ok(r.status === 200 && r.json.channel.hasSecret && !r.json.note, 'renaming keeps the URL');
  r = await req('PUT', `/api/admin/alerts/channels/${hook.id}`, { name: 'HA', url: 'http://127.0.0.2:18477', tlsMode: 'verify' });
  ok(r.json.note && !r.json.channel.hasSecret, 'pointing it elsewhere without the URL deletes the stored one');
  await req('PUT', `/api/admin/alerts/channels/${hook.id}`, { name: 'HA', secret: 'http://127.0.0.1:18477/api/webhook/secret-hook-id-789' });

  // --- a real alert to both ---
  const rules = (await req('GET', '/api/admin/alerts')).json.rules;
  for (const k of Object.keys(rules)) rules[k] = { ...rules[k], channels: [] };
  rules.offline = { ...rules.offline, enabled: true, delay: 0, channels: [ch.id, hook.id] };
  await req('PUT', '/api/admin/alerts', { rules, settings: { resolved: true, repeatHours: 0 } });
  gone = new Set(['/push/laptop-token-456']); // the laptop turned notifications off
  const n = pushed.length;
  const dev = (await req('POST', '/api/admin/devices', { name: 'atlas', kind: 'server', location: 'outside', connections: [{ type: 'ping', address: '192.0.2.41' }] })).json.device;
  const h = await until(() => hooks.find((x) => x.json.alerts?.[0]?.type === 'offline'));
  ok(h && h.json.severity === 'critical' && /atlas/.test(h.json.title) && /^http:\/\/.+\/ack\/[0-9a-f]{16}\?t=/.test(h.json.ackUrl) && h.json.alerts[0].event === 'fired' && h.json.alerts[0].since, `the webhook gets the alert as JSON, with the link to acknowledge it (${h?.json.title})`);
  const p2 = await until(() => pushed.slice(n).find((x) => x.path === '/push/phone-token-123'));
  const m2 = p2 && JSON.parse(decrypt(p2.body, phone.priv, phone.pub, phone.auth));
  ok(m2 && /^🔴 atlas/.test(m2.title) && /^\/ack\/[0-9a-f]{16}\?t=/.test(m2.ack) && p2.headers.urgency === 'high', `the phone gets it, urgent, with Acknowledge (${m2?.title})`);
  const after = await until(async () => (await req('GET', '/api/admin/alerts')).json.channels.find((c) => c.id === ch.id).subs.length === 1);
  ok(after, 'a browser that turned notifications off is removed');
  const log = (await req('GET', '/api/admin/events')).json.events || [];
  ok(log.some((e) => /Push: 1 browser had turned notifications off/.test(e.text)), 'and the log says so');

  // the Acknowledge button in the notification posts the link as the page would
  const t = new URLSearchParams(m2.ack.split('?')[1]).get('t');
  r = await fetch(BASE + m2.ack.split('?')[0], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }, body: `t=${t}` });
  ok(r.status === 200 && (await req('GET', '/api/admin/incidents')).json.incidents.find((x) => x.deviceId === dev.id)?.ack?.via === 'link', 'Acknowledge from the notification');

  // --- turning it off ---
  r = await req('DELETE', `/api/admin/alerts/channels/${ch.id}/subscriptions/${phoneSub.id}`);
  ok(r.status === 200 && r.json.channels.find((c) => c.id === ch.id).subs.length === 0, 'Remove turns it off for that device');

  pushSrv.close();
  hookSrv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PUSH TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
