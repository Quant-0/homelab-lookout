'use strict';
// Alerts: channel validation, write-only secrets, sending to ntfy/Telegram/Discord/SMTP (mocks),
// pinning and STARTTLS rules, routing, firing and resolving, and backup/restore of channels.
// test/run.js starts the server with NODE_EXTRA_CA_CERTS (the mock certificate), TELEGRAM_API_URL and
// DISCORD_WEBHOOK_HOSTS pointing at the HTTPS mock below.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const FP = process.env.MOCK_FP;
const key = fs.readFileSync(path.join(process.env.MOCK_CERT_DIR, 'key.pem'));
const cert = fs.readFileSync(path.join(process.env.MOCK_CERT_DIR, 'cert.pem'));
const NTFY_TOKEN = 'tk_secretntfytoken123456';
const TG_TOKEN = '123456789:AAHsecretTelegramToken_abcdefghij';
const HOOK = 'https://127.0.0.1:18449/api/webhooks/1234567890/secretDiscordWebhookToken_xyz';
const SMTP_PW = 'smtp-secret-pw-42';
const SECRETS = [NTFY_TOKEN, TG_TOKEN, 'secretDiscordWebhookToken', SMTP_PW];

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
let cookie = '';
let csrf = '';
async function req(method, p, body, raw = false) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return r;
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noSecrets = (t, where) => ok(!SECRETS.some((s) => t.includes(s)), `no secret in ${where}`);
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

// --- HTTPS mock: ntfy, Telegram Bot API and Discord webhooks ---
const posts = [];
const handle = (scheme) => (rq, rs) => {
  let b = '';
  rq.on('data', (c) => (b += c));
  rq.on('end', () => {
    let json = null; try { json = JSON.parse(b); } catch {}
    posts.push({ scheme, path: rq.url, headers: rq.headers, json });
    if (rq.url.startsWith('/bot')) {
      if (!rq.url.startsWith(`/bot${TG_TOKEN}/`)) return rs.writeHead(401, { 'Content-Type': 'application/json' }).end('{"ok":false,"description":"Unauthorized"}');
      if (json?.chat_id !== '42') return rs.writeHead(400, { 'Content-Type': 'application/json' }).end('{"ok":false,"description":"Bad Request: chat not found"}');
      return rs.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    }
    if (rq.url.startsWith('/api/webhooks/')) return rs.writeHead(204).end();
    if (rq.headers.authorization && rq.headers.authorization !== `Bearer ${NTFY_TOKEN}`) return rs.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
    rs.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"x"}');
  });
};
const httpsMock = https.createServer({ key, cert }, handle('https')).listen(18449, '127.0.0.1');
const httpMock = http.createServer(handle('http')).listen(18450, '127.0.0.1');

// --- SMTP mock: STARTTLS (18025), no STARTTLS offered (18026), implicit TLS (18465) ---
const mails = [];
function smtpMock(port, { implicitTls = false, starttls = true } = {}) {
  const ctx = tls.createSecureContext({ key, cert });
  const onConn = (first) => {
    let sock = first;
    let secure = implicitTls;
    let buf = '';
    let data = null;
    const s = { port, secure, authBeforeTls: false, auth: null, from: '', to: [], body: '' };
    const send = (l) => sock.write(`${l}\r\n`);
    const line = (l) => {
      if (data !== null) {
        if (l === '.') {
          s.body = data;
          data = null;
          mails.push(s);
          return send('250 queued');
        }
        data += `${l.replace(/^\.\./, '.')}\n`;
        return;
      }
      const verb = l.split(' ')[0].toUpperCase();
      if (verb === 'EHLO') {
        send('250-mock.local');
        if (starttls && !secure) send('250-STARTTLS');
        send('250-AUTH LOGIN PLAIN');
        return send('250 SIZE 1000000');
      }
      if (verb === 'STARTTLS') {
        send('220 ready');
        sock.removeAllListeners('data');
        sock = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx });
        sock.on('data', onData).on('error', () => {});
        secure = s.secure = true;
        return;
      }
      if (verb === 'AUTH') {
        if (!secure) s.authBeforeTls = true;
        s.auth = Buffer.from(l.split(' ')[2] || '', 'base64').toString();
        return send(s.auth === `\0alerts@example.com\0${SMTP_PW}` ? '235 ok' : '535 5.7.8 Authentication failed');
      }
      if (verb === 'MAIL') { s.from = l; return send('250 ok'); }
      if (verb === 'RCPT') { s.to.push(l); return send('250 ok'); }
      if (verb === 'DATA') { data = ''; return send('354 go'); }
      if (verb === 'QUIT') { send('221 bye'); return sock.end(); }
      send('502 unknown');
    };
    const onData = (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const l = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        line(l);
      }
    };
    sock.on('data', onData).on('error', () => {});
    send('220 mock ESMTP');
  };
  return (implicitTls ? tls.createServer({ key, cert }, onConn) : net.createServer(onConn)).listen(port, '127.0.0.1');
}
const smtpServers = [smtpMock(18025), smtpMock(18026, { starttls: false }), smtpMock(18465, { implicitTls: true })];

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;

  let r = await req('GET', '/api/admin/alerts');
  ok(r.status === 200 && r.json.rules.hardware.enabled && !r.json.rules.power.enabled && r.json.channels.length === 0, 'defaults: rules on (power off), no channels');

  // --- validation ---
  const bad = async (body, re, what) => {
    const x = await req('POST', '/api/admin/alerts/channels', body);
    ok(x.status === 400 && re.test(x.json?.error), `${what}: ${x.json?.error}`);
  };
  await bad({ type: 'sms' }, /Unknown channel type/, 'unknown channel type rejected');
  await bad({ type: 'discord', secret: 'https://evil.example/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz' }, /whole webhook URL/, 'webhook URL must be a Discord host');
  await bad({ type: 'telegram', chatId: '42', secret: 'not-a-token' }, /bot token/, 'malformed bot token rejected');
  await bad({ type: 'email', host: 'mail.example.com', security: 'none', username: 'u', from: 'a@example.com', to: 'b@example.com', secret: 'x' }, /never sent unencrypted/, 'login without TLS refused');
  await bad({ type: 'email', host: 'mail.example.com', from: 'a@example.com', to: 'b@example.com\r\nBcc: spy@evil.example', username: 'u', secret: 'x' }, /Invalid e-mail|invalid characters/, 'header injection in recipients rejected');
  await bad({ type: 'ntfy', url: 'https://ntfy.sh', topic: 'a/b' }, /Topic/, 'ntfy topic validated');
  await bad({ type: 'ntfy', url: 'https://ntfy.sh', topic: 'abc', auth: 'token' }, /Enter the token/, 'a channel that needs a token cannot be saved without it');

  // --- channels ---
  r = await req('POST', '/api/admin/alerts/channels', { type: 'ntfy', name: 'Phone', url: 'https://127.0.0.1:18449', topic: 'homelab-test', auth: 'token', secret: NTFY_TOKEN, tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 201 && r.json.channel.hasSecret && !('secret' in r.json.channel), 'ntfy channel (pinned, token) created; token write-only');
  noSecrets(r.text, 'create response');
  const ntfy = r.json.channel;
  ok(Object.values(r.json.status.rules).every((x) => x.enabled === x.channels.includes(ntfy.id)), 'a new channel gets every enabled alert');
  const tg = (await req('POST', '/api/admin/alerts/channels', { type: 'telegram', name: 'Telegram', chatId: '42', secret: TG_TOKEN })).json.channel;
  const dc = (await req('POST', '/api/admin/alerts/channels', { type: 'discord', name: 'Discord', secret: HOOK })).json.channel;
  const mail = (await req('POST', '/api/admin/alerts/channels', { type: 'email', name: 'Mail', host: '127.0.0.1', security: 'starttls', port: 18025, username: 'alerts@example.com', secret: SMTP_PW, from: 'alerts@example.com', to: 'me@example.com, other@example.com', tlsMode: 'pin', fingerprint: FP })).json.channel;
  const mailTls = (await req('POST', '/api/admin/alerts/channels', { type: 'email', name: 'Mail TLS', host: '127.0.0.1', security: 'tls', port: 18465, from: 'alerts@example.com', to: ['me@example.com'] })).json.channel;
  ok(tg?.hasSecret && dc?.hasSecret && mail?.hasSecret && mailTls && !mailTls.hasSecret, 'Telegram, Discord and two e-mail channels created');
  r = await req('GET', '/api/admin/alerts');
  noSecrets(r.text, 'alerts status');
  noSecrets((await req('GET', '/api/admin/config')).text, 'admin config');
  noSecrets(fs.readFileSync(path.join(process.env.DATA_DIR, 'config.json'), 'utf8'), 'config file on disk (encrypted)');

  // --- test sends ---
  const test = async (c) => (await req('POST', `/api/admin/alerts/channels/${c.id}/test`, {})).json;
  let t = await test(ntfy);
  let p = posts.at(-1);
  ok(t.ok && p.headers.authorization === `Bearer ${NTFY_TOKEN}` && p.json.topic === 'homelab-test' && /Test notification/.test(p.json.title), `ntfy: JSON publish with the token (${t.error || 'ok'})`);
  t = await test(tg);
  p = posts.at(-1);
  ok(t.ok && p.path === `/bot${TG_TOKEN}/sendMessage` && p.json.chat_id === '42' && /Test notification/.test(p.json.text), `Telegram: sendMessage to the chat (${t.error || 'ok'})`);
  t = await test(dc);
  p = posts.at(-1);
  ok(t.ok && p.path === '/api/webhooks/1234567890/secretDiscordWebhookToken_xyz' && JSON.stringify(p.json.allowed_mentions) === '{"parse":[]}' && p.json.embeds[0].title === 'Test notification', `Discord: embed, mentions disabled (${t.error || 'ok'})`);
  t = await test(mail);
  let m = mails.at(-1);
  ok(t.ok && m.port === 18025 && m.secure && !m.authBeforeTls && m.to.length === 2, `e-mail via STARTTLS: login only after TLS, 2 recipients (${t.error || 'ok'})`);
  const decoded = Buffer.from(m.body.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString();
  ok(/^Subject: \[Homelab\] Test notification/m.test(m.body) && /Content-Type: text\/plain; charset=utf-8/.test(m.body) && /Test notification/.test(decoded), 'e-mail: headers and base64 body');
  t = await test(mailTls);
  ok(t.ok && mails.at(-1).port === 18465 && mails.at(-1).auth === null, `e-mail via implicit TLS without login (${t.error || 'ok'})`);
  noSecrets(JSON.stringify((await req('GET', '/api/admin/alerts')).json), 'status after sends');

  // --- failures say why, without secrets ---
  r = await req('PUT', `/api/admin/alerts/channels/${tg.id}`, { name: 'Telegram', chatId: '999' });
  t = await test(tg);
  ok(!t.ok && /chat not found/.test(t.error) && !t.error.includes(TG_TOKEN), `Telegram error is shown: ${t.error}`);
  await req('PUT', `/api/admin/alerts/channels/${tg.id}`, { name: 'Telegram', chatId: '42' });
  const before = posts.length;
  r = await req('POST', '/api/admin/alerts/test', { type: 'ntfy', url: 'https://127.0.0.1:18449', topic: 'x', auth: 'token', secret: NTFY_TOKEN, tlsMode: 'pin', fingerprint: 'aa'.repeat(32) });
  ok(!r.json.ok && /fingerprint mismatch; nothing was sent/.test(r.json.error) && posts.length === before, `pinned fingerprint checked before the token is sent: ${r.json.error}`);
  r = await req('POST', '/api/admin/alerts/test', { type: 'email', host: '127.0.0.1', security: 'starttls', port: 18026, username: 'alerts@example.com', secret: SMTP_PW, from: 'alerts@example.com', to: 'me@example.com' });
  ok(!r.json.ok && /does not offer STARTTLS; nothing was sent/.test(r.json.error) && !mails.some((x) => x.port === 18026), `no STARTTLS: refused before login: ${r.json.error}`);
  r = await req('POST', '/api/admin/alerts/test', { type: 'ntfy', url: 'http://127.0.0.1:18450', topic: 'plain' });
  ok(r.json.ok && posts.at(-1).scheme === 'http' && !posts.at(-1).headers.authorization, 'ntfy over plain http works without a token (test before saving)');

  // --- secrets follow the destination ---
  r = await req('POST', '/api/admin/alerts/test', { id: ntfy.id, url: 'https://127.0.0.1:18449', topic: 'other-topic', auth: 'token', tlsMode: 'pin', fingerprint: FP });
  ok(r.json.ok && posts.at(-1).json.topic === 'other-topic', 'testing an edited channel reuses the stored token when the server is unchanged');
  r = await req('POST', '/api/admin/alerts/test', { id: ntfy.id, url: 'https://127.0.0.2:18449', topic: 'x', auth: 'token' });
  ok(r.status === 400 && /enter the password or token again/.test(r.json.error), 'a different server needs the token typed again (it is never sent elsewhere)');
  r = await req('PUT', `/api/admin/alerts/channels/${ntfy.id}`, { name: 'Phone', url: 'https://127.0.0.1:18449', topic: 'homelab-2', auth: 'token', tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 200 && r.json.channel.hasSecret && !r.json.note, 'topic change keeps the token');
  r = await req('PUT', `/api/admin/alerts/channels/${mail.id}`, { name: 'Mail', host: 'localhost', security: 'starttls', port: 18025, username: 'alerts@example.com', from: 'alerts@example.com', to: 'me@example.com', tlsMode: 'pin', fingerprint: FP });
  ok(r.status === 200 && !r.json.channel.hasSecret && /deleted/.test(r.json.note), 'changing the SMTP server without the password deletes it');
  r = await req('PUT', `/api/admin/alerts/channels/${mail.id}`, { name: 'Mail', host: '127.0.0.1', security: 'starttls', port: 18025, username: 'alerts@example.com', secret: SMTP_PW, from: 'alerts@example.com', to: 'me@example.com', tlsMode: 'pin', fingerprint: FP });
  ok(r.json.channel.hasSecret, 'password entered again');

  // --- routing and firing ---
  const status = (await req('GET', '/api/admin/alerts')).json;
  const rules = structuredClone(status.rules);
  for (const k of Object.keys(rules)) rules[k].channels = [];
  rules.hardware.channels = [ntfy.id];
  rules.temperature = { ...rules.temperature, delay: 0, channels: [ntfy.id, dc.id] };
  rules.offline = { ...rules.offline, delay: 0, channels: [tg.id] };
  rules.service = { ...rules.service, delay: 0, channels: [mailTls.id] };
  r = await req('PUT', '/api/admin/alerts', { rules, settings: { resolved: true, repeatHours: 0 } });
  ok(r.status === 200 && r.json.rules.hardware.channels.join() === ntfy.id, 'routing saved');
  r = await req('PUT', '/api/admin/alerts', { rules: { ...rules, offline: { ...rules.offline, delay: 99999 } }, settings: {} });
  ok(r.status === 400 && /delay/.test(r.json.error), 'rule values validated');
  r = await req('PUT', '/api/admin/alerts', { rules: { ...rules, hardware: { ...rules.hardware, channels: ['00000000-0000-4000-8000-000000000000'] } }, settings: {} });
  ok(r.status === 200 && r.json.rules.hardware.channels.length === 0, 'unknown channel ids are dropped');
  await req('PUT', '/api/admin/alerts', { rules, settings: { resolved: true, repeatHours: 0 } });

  const n0 = posts.length;
  r = await req('POST', '/api/admin/devices', { name: 'Orion', kind: 'server', location: 'none', connections: [
    { type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  const orion = r.json.device;
  const hw = await until(() => posts.slice(n0).find((x) => x.path === '/' && /alerts|PS2|Fan6/.test(x.json?.title || '')));
  ok(hw && /PS2 Status critical/.test(hw.json.message) && /System Board Fan6 critical/.test(hw.json.message) && /CPU2 Temp at 88/.test(hw.json.message) && hw.json.priority === 5,
    `ntfy got the PSU, fan and temperature alerts in one message: "${hw?.json.title}"`);
  const dcMsg = posts.slice(n0).find((x) => x.path.startsWith('/api/webhooks/'));
  ok(dcMsg && /CPU2 Temp at 88/.test(dcMsg.json.embeds[0].title) && !posts.slice(n0).some((x) => x.path.startsWith('/api/webhooks/') && /PS2/.test(JSON.stringify(x.json))), 'Discord only got the temperature alert (routing)');
  r = await req('GET', '/api/admin/alerts');
  ok(r.json.active.filter((a) => a.firedAt).length === 3 && r.json.log[0].sent.length >= 1, `3 active alerts and a log entry (${r.json.active.map((a) => a.title).join('; ')})`);

  // offline, then resolved
  const n1 = posts.length;
  r = await req('POST', '/api/admin/devices', { name: 'Lynx', kind: 'server', location: 'none', connections: [
    { type: 'idrac', address: '127.0.0.1:18451', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  const lynx = r.json.device;
  const down = await until(() => posts.slice(n1).find((x) => x.path.startsWith('/bot') && /Lynx: iDRAC not answering/.test(x.json.text)));
  ok(down && /Connection refused/.test(down.json.text), 'Telegram: "Lynx: iDRAC not answering"');
  const lokiHost = (await req('GET', '/api/admin/config')).json.hosts.find((h) => h.deviceId === lynx.id);
  await req('PUT', `/api/admin/devices/${lynx.id}`, { name: 'Lynx', kind: 'server', location: 'none', connections: [
    { id: lokiHost.id, type: 'idrac', address: '127.0.0.1:18443', username: 'root', tlsMode: 'pin', fingerprint: FP, secret: 'calvin' }] });
  const up = await until(() => posts.slice(n1).find((x) => x.path.startsWith('/bot') && /Resolved: Lynx: iDRAC not answering/.test(x.json.text)));
  ok(up && /Cleared after/.test(up.json.text), 'Telegram: resolved when it answers again');

  // service down by e-mail
  const m0 = mails.length;
  await req('POST', '/api/admin/services', { name: 'Wiki', connection: { url: 'http://127.0.0.1:18452/' } });
  const svcMail = await until(() => mails.slice(m0).find((x) => /Wiki is down/.test(Buffer.from(x.body.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString())));
  ok(svcMail, 'e-mail: "Wiki is down"');

  // a deleted device's alerts go away quietly
  const n2 = posts.length;
  await req('DELETE', `/api/admin/devices/${orion.id}`);
  await sleep(1500);
  r = await req('GET', '/api/admin/alerts');
  ok(!r.json.active.some((a) => /Orion/.test(a.title)) && !posts.slice(n2).some((x) => /Resolved: Orion/.test(JSON.stringify(x.json))), 'deleting a device drops its alerts without "resolved" messages');

  // --- backup and restore keep channels working ---
  const file = Buffer.from(await (await req('POST', '/api/admin/backup/download', { passphrase: 'backup passphrase 123' }, true)).arrayBuffer());
  ok(!SECRETS.some((s) => file.includes(s)), 'backup file is encrypted (no secrets in it)');
  r = await fetch(`${BASE}/api/admin/backup/restore`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream', 'X-Backup-Passphrase': encodeURIComponent('backup passphrase 123') }, body: file });
  ok(r.status === 200, 'restored');
  r = await req('GET', '/api/admin/alerts');
  ok(r.json.channels.length === 5 && r.json.channels.filter((c) => c.hasSecret).length === 4 && r.json.rules.temperature.channels.length === 2, 'channels, secrets and routing restored');
  t = await test(r.json.channels.find((c) => c.type === 'telegram'));
  ok(t.ok, 'restored Telegram token decrypts and sends');

  // --- delete ---
  r = await req('DELETE', `/api/admin/alerts/channels/${dc.id}`);
  ok(r.status === 200 && !r.json.channels.some((c) => c.id === dc.id) && !r.json.rules.temperature.channels.includes(dc.id), 'deleting a channel removes it from the routing');

  r = await req('GET', '/api/admin/alerts');
  noSecrets(r.text, 'final status');
  noSecrets(fs.readFileSync(path.join(process.env.DATA_DIR, 'alerts.json'), 'utf8'), 'alert state file');

  httpsMock.close();
  httpMock.close();
  for (const s of smtpServers) s.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ALERT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
