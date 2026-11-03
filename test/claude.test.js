'use strict';
// Claude: the real Python reporter adds up fake Claude Code logs (a reply written three times, a
// sub-agent, an error line, a line still being written) and sends only numbers; plan limits with
// the machine's own sign-in; the status page and an outage under Needs you; the Admin API key
// (checked before it is kept, never shown again); what Home and the wall show; tokens and visitors.
// Needs the service mock (status page, Anthropic API, plan limits) and python3.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const SCRIPT = path.join(__dirname, '..', 'public', 'claude', 'lookout-claude.py');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body, headers = {}) {
  const h = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers };
  const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const claude = async () => (await req('GET', '/api/dashboard')).json.claude;

// a fake ~/.claude: logs and a sign-in
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookout-claude-'));
const home = path.join(dir, 'claude');
const proj = path.join(home, 'projects', '-home-me-secret-project');
fs.mkdirSync(path.join(proj, 'sA', 'subagents'), { recursive: true });
const T0 = Date.now() - 6 * 60000;
const at = (min) => new Date(T0 + min * 60000).toISOString();
const line = (o) => `${JSON.stringify(o)}\n`;
const reply = (id, model, u, min, extra = {}) => ({ type: 'assistant', sessionId: 'sA', requestId: `r-${id}`, timestamp: at(min), message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'SECRET-REPLY-TEXT' }], usage: u }, ...extra });
const opus = { input_tokens: 10000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 200000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200000 } };
const main = path.join(proj, 'sA.jsonl');
const m5 = JSON.stringify(reply('m5', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 5));
fs.writeFileSync(main, [
  line({ type: 'user', sessionId: 'sA', timestamp: at(0), message: { role: 'user', content: 'SECRET-PROMPT-TEXT' } }),
  // one reply, one line per content block, each with the same usage: counted once
  line(reply('m1', 'claude-opus-5-5', opus, 1)), line(reply('m1', 'claude-opus-5-5', opus, 1)), line(reply('m1', 'claude-opus-5-5', opus, 1)),
  line(reply('err', '<synthetic>', { input_tokens: 999, output_tokens: 999 }, 1)),
  line(reply('m2', 'claude-sonnet-5-5', { input_tokens: 5000, output_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 100000, cache_creation: { ephemeral_5m_input_tokens: 100000, ephemeral_1h_input_tokens: 0 } }, 3)),
  'not json at all\n',
  m5, // still being written: no newline yet
].join(''));
fs.writeFileSync(path.join(proj, 'sA', 'subagents', 'agent-1.jsonl'), line(reply('m3', 'claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 10000 }, 4, { isSidechain: true })));
fs.writeFileSync(path.join(proj, 'old.jsonl'), line({ ...reply('m4', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 1000 }, 0), sessionId: 'sB', timestamp: new Date(Date.now() - 10 * 864e5).toISOString() }));
fs.writeFileSync(path.join(proj, 'notes.md'), 'not a log');
const cred = (expiresAt) => fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token-123', refreshToken: 'never-used', expiresAt, scopes: [], subscriptionType: 'max' } }));
cred(Date.now() + 3600e3);
const conf = path.join(dir, 'reporter.conf');
const state = path.join(dir, 'state');
function reporter(cmd = 'test') {
  try {
    const out = execFileSync('python3', [SCRIPT, cmd], { env: { ...process.env, LOOKOUT_CLAUDE_CONF: conf, LOOKOUT_CLAUDE_STATE: state, CLAUDE_CONFIG_DIR: home, LOOKOUT_CLAUDE_USAGE_URL: 'http://127.0.0.1:18090/oauthusage/api/oauth/usage' }, encoding: 'utf8', timeout: 30000 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  ok((await claude()) === null, 'nothing set up: no Claude on Home');
  ok((await req('GET', '/api/admin/alerts')).json.types.claude?.label === 'Claude outage', 'Alerts has a Claude outage rule');

  // --- a reporter ---
  let r = await req('POST', '/api/admin/claude/reporters', { name: '' });
  ok(r.status === 400, 'a reporter needs a name');
  r = await req('POST', '/api/admin/claude/reporters', { name: 'workstation', limits: false });
  ok(r.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(r.json.token), 'a reporter gets its own token');
  const { id } = r.json.reporter;
  let token = r.json.token;
  ok(r.json.commands.install.includes(`/claude/install.sh | sh -s -- --id ${id} --token ${token}`) && !/sudo/.test(r.json.commands.install), 'the install command runs as the user, without sudo');
  const inst = await fetch(`${BASE}/claude/install.sh`).then((x) => x.text());
  ok(inst.includes(`URL="${BASE}"`) && !inst.includes('__URL__'), 'the install script gets this dashboard\'s address');
  const shCheck = path.join(dir, 'install.sh');
  fs.writeFileSync(shCheck, inst);
  try {
    execFileSync('sh', ['-n', shCheck]);
    ok(true, 'the install script is valid shell');
  } catch {
    ok(false, 'the install script is valid shell');
  }
  ok((await fetch(`${BASE}/claude/lookout-claude.py`).then((x) => x.text())).startsWith('#!/usr/bin/env python3'), 'the reporter itself can be downloaded');
  ok((await fetch(`${BASE}/claude/report`, { method: 'POST', headers: { Authorization: `Bearer ${id}.${'x'.repeat(43)}` }, body: '{}' })).status === 401, 'a wrong token is refused');

  fs.writeFileSync(conf, `URL=${BASE}\nID=${id}\nTOKEN=${token}\nCA=\n`);
  let run = reporter();
  ok(run.ok && /4 replies/.test(run.out) && /limits=no/.test(run.out), `the reporter sends, counting each reply once (3 now, 1 ten days ago) (${run.out.trim().split('\n')[0]})`);
  let c = await claude();
  ok(c && c.reporters === 1 && c.machines[0].ok && c.machines[0].name === 'workstation' && c.machines[0].version === '1.0.0', 'Home has Claude, with the machine reporting');
  ok(c.week.tokens === 1476000 && c.week.replies === 3 && c.week.input === 16000 && c.week.output === 160000 && c.week.cacheRead === 1000000 && c.week.cacheWrite === 300000, `7 days: tokens by kind, the error line and the half-written line left out (${c.week.tokens})`);
  ok(Math.abs(c.week.cost - 4.65) < 0.011, `the cost at API prices, cache writes and reads included ($${c.week.cost})`);
  ok(Math.abs(c.week.cacheHit - 1000000 / 1316000) < 1e-6, 'cache hits: reads of all input');
  ok(c.week.sessions === 1 && c.week.active === 5, `one session (the sub-agent is part of it), 5 active minutes (${c.week.sessions}, ${c.week.active})`);
  ok(c.month.tokens >= c.week.tokens && c.days.length === 30 && c.days.reduce((s, d) => s + d.tokens, 0) === 1477100, 'the last 30 days include the older session');
  ok(c.models.week.map((m) => m.name).join() === 'Opus 5.5,Sonnet 5.5,Haiku 4.5' && c.models.week[0].tokens === 1310000, 'models by tokens, with plain names');
  ok(c.limits === null, 'plan limits are off until switched on');
  const all = JSON.stringify(await req('GET', '/api/dashboard')) + JSON.stringify(await req('GET', '/api/admin/claude')) + fs.readFileSync(path.join(state, 'state.json'), 'utf8');
  ok(!/SECRET-(PROMPT|REPLY)-TEXT|oauth-token-123|never-used/.test(all), 'no prompt, reply or sign-in reaches the dashboard (or the reporter\'s own state)');

  // the line that was being written is finished: only the new part is read
  fs.appendFileSync(main, '\n');
  run = reporter();
  c = await claude();
  ok(run.ok && c.week.replies === 4 && c.week.tokens === 1477000, 'a finished line is counted on the next run, nothing twice');

  // --- plan limits, with this machine's own sign-in ---
  r = await req('PUT', `/api/admin/claude/reporters/${id}`, { name: 'workstation', limits: true });
  ok(r.status === 200, 'plan limits switched on');
  run = reporter();
  c = await claude();
  ok(run.ok && /limits=yes/.test(run.out) && c.limits?.fiveHour?.pct === 37 && c.limits.sevenDay.pct === 81.5 && c.limits.plan === 'max' && c.limits.machine === 'workstation', 'the next report has the 5-hour and weekly limits (sent right after the switch)');
  ok(c.limits.fiveHour.resetsAt > Date.now() && c.limits.sevenDayOpus === null, 'with when they reset; limits the plan doesn\'t have are left out');
  cred(Date.now() - 1000);
  run = reporter();
  c = await claude();
  ok(/expired/.test(c.limits?.error || '') && !c.limits.fiveHour, 'an expired sign-in says so (it is never renewed by the reporter)');
  cred(Date.now() + 3600e3);
  run = reporter('status');
  ok(run.ok && /Plan limits: on/.test(run.out) && /Last report/.test(run.out), 'lookout-claude status tells what it sent');

  // junk in a report
  r = await fetch(`${BASE}/claude/report`, { method: 'POST', headers: { Authorization: `Bearer ${id}.${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reporter: 'x'.repeat(500), hostname: 'a\u0000b', hours: { 'not-a-key': { s: 1 }, '2026-01-01T00': { s: 5 }, [new Date().toISOString().slice(0, 13)]: { s: -4, a: 9999, m: { 'gpt-4': [1, 1, 1, 1, 1, 1], 'claude-opus-5-5': [1, 'x', -5, 1e20, 0, 1] } } }, limits: { fiveHour: { pct: 'lots' } } }) });
  c = await claude();
  ok(r.status === 200 && c.today.tokens === 1e13 + 1 && c.today.active === 60 && c.today.sessions === 0 && c.machines[0].version.length === 20, 'a report is checked field by field (old hours, other models and bad numbers dropped)');
  reporter();

  // a new token: the old one stops working
  r = await req('POST', `/api/admin/claude/reporters/${id}/token`, {});
  ok(r.status === 200 && r.json.token !== token, 'a new token');
  run = reporter();
  ok(!run.ok && /401/.test(run.out), 'the old token stops working');
  token = r.json.token;
  fs.writeFileSync(conf, `URL=${BASE}\nID=${id}\nTOKEN=${token}\nCA=\n`);
  ok(reporter().ok, 'with the new one it reports again');

  // --- the status page ---
  r = await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: true } });
  ok(r.status === 200 && r.json.status.enabled, 'the status page is switched on');
  await sleep(1500);
  c = await claude();
  ok(c.status?.indicator === 'none' && c.status.components.length === 2 && !c.status.components.some((x) => x.name === 'A group'), 'it reads the status and the components (not their groups)');
  await fetch('http://127.0.0.1:18090/claudestatus/set?indicator=major', { method: 'POST' });
  await sleep(2500);
  let d = (await req('GET', '/api/dashboard')).json;
  let a = d.attention.find((x) => x.key === 'claude:status');
  ok(d.claude.status.indicator === 'major' && d.claude.status.incidents[0].link === 'https://stspg.io/abc' && a?.severity === 'warning' && /Partial System Outage/.test(a.text), 'a major outage shows under Needs you, with the incident');
  await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: false } });
  d = (await req('GET', '/api/dashboard')).json;
  ok(!d.attention.some((x) => x.key === 'claude:status') && d.claude.status.indicator === 'major', 'with Needs you switched off it only shows on the tile');
  await fetch('http://127.0.0.1:18090/claudestatus/set?indicator=none', { method: 'POST' });

  // --- the Admin API key ---
  r = await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: true }, adminKey: 'hunter2' });
  ok(r.status === 400 && /sk-ant-/.test(r.json.error), 'only something that looks like an Anthropic key');
  r = await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: true }, adminKey: 'sk-ant-admin01-wrongkey-999' });
  ok(r.status === 400 && /wrong, revoked/.test(r.json.error), 'a wrong key is refused when it is saved, not later');
  r = await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: true }, adminKey: 'sk-ant-admin01-testkey-123' });
  ok(r.status === 200 && r.json.adminKey === true && r.json.api.lastOkAt, 'a working key is kept');
  c = await claude();
  ok(c.api && c.api.today.cost === 124 && c.api.today.tokens === 8500 && c.api.month === 124 && c.api.week.cost === 124, 'the API organization: cost from cents, tokens over both pages');
  ok(c.api.models.map((m) => `${m.name}:${m.cost}`).join() === 'Opus 5.5:123.45,Haiku 4.5:0.55' && c.api.refreshedAt < Date.now(), 'its models by cost, and how fresh the numbers are');
  const leak = JSON.stringify((await req('GET', '/api/admin/claude')).json) + JSON.stringify((await req('GET', '/api/admin/config')).json) + JSON.stringify(await claude());
  ok(!leak.includes('testkey'), 'the key is never sent back');
  r = await req('PUT', '/api/admin/claude/settings', { status: { enabled: true, alert: true } });
  ok(r.json.adminKey === true, 'saving without a key keeps it');

  // --- Home and the wall ---
  ok(JSON.stringify(c.home) === JSON.stringify({ hidden: false, stats: ['tokens', 'cost', 'limits', 'status'] }), 'the tile shows tokens, cost, limits and status by default');
  r = await req('PUT', '/api/admin/layout', { v: 3, items: [], hidden: [], claude: { hidden: true, stats: ['status', 'bogus', 'tokens', 'tokens'] } });
  c = await claude();
  ok(r.status === 200 && JSON.stringify(c.home) === JSON.stringify({ hidden: true, stats: ['tokens', 'status'] }), 'Customize keeps what the tile shows (known ones, in order) and whether it is on Home');
  d = (await req('GET', '/api/dashboard')).json;
  ok(d.wall.claude.style === 'number' && d.wall.hidden.includes('claude') && d.wall.panels.some((p) => p.id === 'claude'), 'the wall has a Claude panel, hidden at first');
  const oldWall = { panels: d.wall.panels.filter((p) => p.id !== 'claude'), hidden: [], showServices: true, services: null, devices: null };
  r = await req('PUT', '/api/admin/wall', oldWall);
  ok(r.status === 200 && r.json.wall.hidden.includes('claude') && r.json.wall.panels.at(-1).id === 'claude', 'a wall saved before there was a Claude panel gets it hidden');
  r = await req('PUT', '/api/admin/wall', { ...r.json.wall, hidden: [], claude: { style: 'rings', stats: ['limits', 'nope'] } });
  ok(r.status === 200 && r.json.wall.claude.style === 'rings' && r.json.wall.claude.stats.join() === 'limits', 'its style and what it shows are kept');
  r = await req('PUT', '/api/admin/wall', { ...r.json.wall, claude: { style: 'neon', stats: 'x' } });
  ok(r.json.wall.claude.style === 'number' && r.json.wall.claude.stats.join() === 'tokens,limits,status', 'an unknown style falls back to the defaults');

  // visitors never see it
  const cfg = (await req('GET', '/api/admin/config')).json.settings.dashboard;
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, public: true } });
  const pub = await fetch(`${BASE}/api/dashboard`).then((x) => x.json());
  ok(pub.claude === null && !pub.loggedIn, 'a public dashboard leaves Claude out for visitors');
  await req('PUT', '/api/admin/settings', { dashboard: { ...cfg, public: false } });

  // --- uninstalled there, then removed here ---
  r = await fetch(`${BASE}/claude/bye`, { method: 'POST', headers: { Authorization: `Bearer ${id}.${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  c = await claude();
  ok(r.status === 200 && c.machines[0].removedAt && c.week.tokens === 0, 'uninstalling on the machine marks it here and drops its numbers');
  const log = (await req('GET', '/api/admin/events')).json;
  ok(JSON.stringify(log).includes('Claude reporter workstation was uninstalled'), 'and it is in the log');
  r = await req('DELETE', `/api/admin/claude/reporters/${id}`);
  c = await claude();
  ok(r.status === 200 && c.reporters === 0 && c.machines.length === 0 && c.api && c.status, 'a removed reporter is gone; the API and status page stay');
  await req('PUT', '/api/admin/claude/settings', { status: { enabled: false }, adminKey: null });
  ok((await claude()) === null, 'with everything off, Claude leaves Home');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CLAUDE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
