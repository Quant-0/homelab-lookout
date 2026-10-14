'use strict';
// Passkeys (WebAuthn) with a software authenticator: adding one, signing in with it, confirming a
// risky change with it, and everything the server must refuse (another site, a reused challenge,
// no fingerprint/Face ID check, a wrong signature, a copied key, a removed passkey).
// Runs with STEP_UP_S=2, so a risky change asks again after 2 seconds.
const crypto = require('node:crypto');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const ORIGIN = 'https://lookout.test:8443';
const RP = 'lookout.test';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  let csrf = '';
  const req = async (method, p, body) => {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { req, session: async () => { csrf = (await req('GET', '/api/session')).json?.csrf || ''; return csrf; } };
}

// --- a tiny CBOR writer (what an authenticator sends) ---
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor');
}

// --- a software authenticator ---
function authenticator(kind = 'es256') {
  const { privateKey, publicKey } = kind === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32);
  const cose = kind === 'ed25519'
    ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  let count = 0;
  let userId = null;
  const rpHash = (rp) => crypto.createHash('sha256').update(rp).digest();
  const cd = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: credId.toString('base64url'),
    create(o, { origin = ORIGIN, rp = RP, flags = 0x45 } = {}) {
      userId = o.user.id;
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash(rp), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cbor(cose)]);
      return { id: credId.toString('base64url'), clientDataJSON: cd('webauthn.create', o.challenge, origin).toString('base64url'), attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url'), transports: ['internal'] };
    },
    get(o, { origin = ORIGIN, flags = 0x05, counter, badSig = false } = {}) {
      count = counter ?? count + 1;
      const c = Buffer.alloc(4); c.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash(RP), Buffer.from([flags]), c]);
      const clientData = cd('webauthn.get', o.challenge, origin);
      const data = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
      let sig = crypto.sign(kind === 'ed25519' ? null : 'sha256', data, privateKey);
      if (badSig) sig = Buffer.from(sig.map((x, i) => (i === sig.length - 1 ? x ^ 1 : x)));
      return { id: credId.toString('base64url'), clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url'), userHandle: userId };
    },
  };
}

(async () => {
  const a = client();
  await a.req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  await a.session();

  // --- no domain: no passkeys ---
  let r = await a.req('GET', '/api/admin/passkeys');
  ok(r.json.site === null && /domain name/.test(r.json.why), `without a dashboard address, it says why (${r.json.why})`);
  const dash = (await a.req('GET', '/api/admin/config')).json.settings.dashboard;
  await a.req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'https://10.1.2.3:8443' } });
  r = await a.req('POST', '/api/admin/passkeys/options', {});
  ok(r.status === 400 && /not an IP address/.test(r.json.error), 'an IP address is refused: passkeys need a name');
  await a.req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: ORIGIN } });
  r = await a.req('GET', '/api/admin/passkeys');
  ok(r.json.site?.rpId === RP && r.json.here === false, 'the domain from the Dashboard address is used (this request is not on it)');

  // --- adding one ---
  const phone = authenticator();
  let o = (await a.req('POST', '/api/admin/passkeys/options', {})).json;
  ok(o.rp.id === RP && o.authenticatorSelection.userVerification === 'required' && o.attestation === 'none' && o.user.name === 'admin', 'creation options: this site, Face ID or PIN required');
  r = await a.req('POST', '/api/admin/passkeys', { ...phone.create(o, { origin: 'https://evil.test' }), name: 'x' });
  ok(r.status === 400 && /not on https:\/\/lookout.test/.test(r.json.error), 'made on another site: refused');
  r = await a.req('POST', '/api/admin/passkeys', { ...phone.create(o), name: 'x' });
  ok(r.status === 400 && /ran out/.test(r.json.error), 'a challenge works once');
  o = (await a.req('POST', '/api/admin/passkeys/options', {})).json;
  r = await a.req('POST', '/api/admin/passkeys', { ...phone.create(o, { rp: 'evil.test' }), name: 'x' });
  ok(r.status === 400 && /another site/.test(r.json.error), 'a passkey for another site: refused');
  o = (await a.req('POST', '/api/admin/passkeys/options', {})).json;
  r = await a.req('POST', '/api/admin/passkeys', { ...phone.create(o, { flags: 0x41 }), name: 'x' });
  ok(r.status === 400 && /checks that it is you|check that it is you/.test(r.json.error), 'without Face ID / PIN: refused');
  o = (await a.req('POST', '/api/admin/passkeys/options', {})).json;
  r = await a.req('POST', '/api/admin/passkeys', { ...phone.create(o), name: 'iPhone' });
  ok(r.status === 201 && r.json.passkeys.length === 1 && r.json.passkeys[0].name === 'iPhone' && !('key' in r.json.passkeys[0]), 'the passkey is added (its key is not sent back)');
  const yubi = authenticator('ed25519');
  o = (await a.req('POST', '/api/admin/passkeys/options', {})).json;
  ok(o.exclude.length === 1, 'the next one is told which passkey exists already');
  r = await a.req('POST', '/api/admin/passkeys', { ...yubi.create(o), name: 'YubiKey' });
  ok(r.status === 201 && r.json.passkeys.length === 2, 'an Ed25519 key too');

  // --- signing in ---
  const s = client();
  r = await s.req('GET', '/api/passkey');
  ok(r.json.available === true && r.json.url === ORIGIN, 'the sign-in page learns that passkeys work, and where');
  let lo = (await s.req('POST', '/api/passkey/options', {})).json;
  ok(lo.rpId === RP && !lo.allow, 'a challenge without listing any passkey');
  r = await s.req('POST', '/api/passkey/login', { ...phone.get(lo, { badSig: true }), keep: true });
  ok(r.status === 401 && /signature/.test(r.json.error), 'a wrong signature is refused');
  r = await s.req('POST', '/api/passkey/login', phone.get(lo));
  ok(r.status === 401 && /ran out/.test(r.json.error), 'and its challenge is gone');
  lo = (await s.req('POST', '/api/passkey/options', {})).json;
  r = await s.req('POST', '/api/passkey/login', phone.get(lo, { origin: 'https://evil.test' }));
  ok(r.status === 401, 'used on another site: refused');
  lo = (await s.req('POST', '/api/passkey/options', {})).json;
  r = await s.req('POST', '/api/passkey/login', phone.get(lo, { flags: 0x01 }));
  ok(r.status === 401, 'without Face ID / PIN: refused');
  lo = (await s.req('POST', '/api/passkey/options', {})).json;
  r = await s.req('POST', '/api/passkey/login', { ...phone.get(lo, { counter: 10 }), keep: true });
  ok(r.status === 200, 'signed in with the passkey');
  ok((await s.session()) && (await s.req('GET', '/api/admin/config')).status === 200, 'the session works like a password sign-in');
  ok((await a.req('GET', '/api/admin/sessions')).json.sessions.some((x) => x.keep), 'Keep me signed in applies to it too');
  const p2 = client();
  lo = (await p2.req('POST', '/api/passkey/options', {})).json;
  r = await p2.req('POST', '/api/passkey/login', phone.get(lo, { counter: 5 }));
  ok(r.status === 401 && /copied/.test(r.json.error), 'a counter that goes backwards (a copied key) is refused');
  lo = (await p2.req('POST', '/api/passkey/options', {})).json;
  r = await p2.req('POST', '/api/passkey/login', yubi.get(lo));
  ok(r.status === 200, 'the Ed25519 key signs in');
  const used = (await a.req('GET', '/api/admin/passkeys')).json.passkeys;
  ok(used.every((x) => x.lastUsed), 'last used is shown');

  // --- confirming a risky change with it ---
  await sleep(2300);
  r = await s.req('POST', '/api/admin/alerts/channels', { type: 'push', name: 'Phones' });
  ok(r.status === 403 && r.json.reauth, 'after the step-up time, a risky change asks again');
  const ro = (await s.req('POST', '/api/reauth/passkey/options', {})).json;
  ok(ro.allow.length === 2 && ro.rpId === RP, 'the confirmation lists the passkeys for this site');
  const other = client();
  await other.req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  await other.session();
  r = await other.req('POST', '/api/reauth/passkey', phone.get(ro, { counter: 11 }));
  ok(r.status === 403 && /another sign-in/.test(r.json.error), "another browser can't use this browser's confirmation");
  const ro2 = (await s.req('POST', '/api/reauth/passkey/options', {})).json;
  r = await s.req('POST', '/api/reauth/passkey', phone.get(ro2, { counter: 12 }));
  ok(r.status === 200, 'Face ID confirms the change');
  r = await s.req('POST', '/api/admin/alerts/channels', { type: 'push', name: 'Phones' });
  ok(r.status === 201, 'and the change goes through');

  // --- removing one ---
  await s.req('DELETE', `/api/admin/passkeys/${phone.id}`);
  lo = (await p2.req('POST', '/api/passkey/options', {})).json;
  r = await p2.req('POST', '/api/passkey/login', phone.get(lo, { counter: 20 }));
  ok(r.status === 401 && /not known/.test(r.json.error), 'a removed passkey no longer signs in');

  // --- another address: the passkey stays, but only works on its own domain ---
  await sleep(2300);
  r = await s.req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'https://other.test:8443' } });
  ok(r.status === 403, 'changing the address asks to confirm first');
  const ro3 = (await s.req('POST', '/api/reauth/passkey/options', {})).json;
  await s.req('POST', '/api/reauth/passkey', yubi.get(ro3));
  await s.req('PUT', '/api/admin/settings', { dashboard: { ...dash, linkUrl: 'https://other.test:8443' } });
  ok((await s.req('GET', '/api/passkey')).json.available === false, 'a new address: the old domain\'s passkey is not offered');
  const events = (await a.req('GET', '/api/admin/events')).json.events.map((e) => e.text).join('\n');
  ok(/Passkey added: iPhone/.test(events) && /Signed in with the passkey "iPhone"/.test(events) && /Failed passkey sign-in/.test(events) && /Confirmed a change with the passkey/.test(events), 'the Log has it all');

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSKEY TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
