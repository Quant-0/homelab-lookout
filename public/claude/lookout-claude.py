#!/usr/bin/env python3
# Homelab Lookout: the Claude reporter. Every 5 minutes it adds up what Claude Code on this machine
# used (tokens per model and hour, sessions, active time) from its own logs in ~/.claude, and sends
# only those numbers to the dashboard: never a prompt, a reply, a file name or a project name.
# With plan limits on (Admin), it also asks Anthropic how much of the 5-hour and weekly limits is
# used, and how the week splits between Claude Code, chats and the rest, with this machine's own
# Claude sign-in; the sign-in itself never leaves the machine. With token counting off (Admin), it
# doesn't read the logs at all.
# Runs as the user who uses Claude Code, from a systemd user timer.
#
#   lookout-claude status      what it last sent
#   lookout-claude test        send a report now and show the answer
#   lookout-claude update      install the newest reporter from the dashboard
#   lookout-claude uninstall   remove it (the logs in ~/.claude are not touched)
#
# Settings: ~/.config/lookout-claude/reporter.conf
import calendar
import glob
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

VERSION = '1.1.2'
HOME = os.path.expanduser('~')
CONF = os.environ.get('LOOKOUT_CLAUDE_CONF') or os.path.join(HOME, '.config', 'lookout-claude', 'reporter.conf')
STATE_DIR = os.environ.get('LOOKOUT_CLAUDE_STATE') or os.path.join(HOME, '.local', 'state', 'lookout-claude')
CLAUDE_DIR = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.claude')
USAGE_URL = os.environ.get('LOOKOUT_CLAUDE_USAGE_URL') or 'https://api.anthropic.com/api/oauth/usage'
PROFILE_URL = os.environ.get('LOOKOUT_CLAUDE_PROFILE_URL') or 'https://api.anthropic.com/api/oauth/profile'
KEEP_DAYS = 35
GAP_MIN = 5  # quiet for longer than this between two lines is a break, not work


def say(*a):
    print(*a)


def die(msg):
    sys.stderr.write(f'lookout-claude: {msg}\n')
    sys.exit(1)


def read_conf():
    conf = {'URL': '', 'ID': '', 'TOKEN': '', 'CA': ''}
    try:
        with open(CONF) as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    conf[k.strip()] = v.strip().strip('"\'')
    except FileNotFoundError:
        pass
    return conf


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f'{path}.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def parse_ts(s):
    # "2026-11-03T18:38:59.755Z" -> seconds since 1970 (the logs are in UTC)
    try:
        return calendar.timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S'))
    except (TypeError, ValueError):
        return None


def hour_key(t):
    return time.strftime('%Y-%m-%dT%H', time.gmtime(t))


# --- the logs: read what was added to each file since last time ---

def scan(state):
    files = state.setdefault('files', {})
    cutoff = time.time() - KEEP_DAYS * 86400
    paths = glob.glob(os.path.join(CLAUDE_DIR, 'projects', '**', '*.jsonl'), recursive=True)
    alive = set()
    for p in paths:
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        alive.add(p)
        rec = files.get(p)
        if rec is None or st.st_size < rec['offset'] or st.st_ino != rec.get('ino'):
            rec = files[p] = {'offset': 0, 'ino': st.st_ino, 'msgs': {}, 'minutes': [], 'sessions': {}}
        if st.st_size == rec['offset']:
            continue
        minutes = set(rec['minutes'])
        with open(p, 'rb') as f:
            f.seek(rec['offset'])
            data = f.read()
        end = data.rfind(b'\n') + 1  # a line still being written waits for the next run
        for raw in data[:end].splitlines():
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            t = parse_ts(d.get('timestamp'))
            if t is None:
                continue
            sid = d.get('sessionId')
            if isinstance(sid, str) and d.get('type') in ('user', 'assistant'):
                minutes.add(int(t // 60))
                if sid not in rec['sessions'] or t < rec['sessions'][sid]:
                    rec['sessions'][sid] = t
            m = d.get('message')
            if d.get('type') != 'assistant' or not isinstance(m, dict) or not isinstance(m.get('usage'), dict):
                continue
            model = m.get('model')
            if not isinstance(model, str) or not model.startswith('claude-'):
                continue  # "<synthetic>": an error shown in the session, nothing was used
            u = m['usage']
            cc = u.get('cache_creation') if isinstance(u.get('cache_creation'), dict) else {}
            n = lambda v: v if isinstance(v, int) and v >= 0 else 0
            w1h = n(cc.get('ephemeral_1h_input_tokens'))
            w5m = n(cc.get('ephemeral_5m_input_tokens'))
            if not cc:
                w5m = n(u.get('cache_creation_input_tokens'))
            # one reply is written once per content block, each time with the same usage: counted once
            key = f"{m.get('id')}/{d.get('requestId')}"
            rec['msgs'][key] = [int(t), model[:60], n(u.get('input_tokens')), n(u.get('output_tokens')), n(u.get('cache_read_input_tokens')), w5m, w1h]
        rec['offset'] += end
        old = int(cutoff // 60)
        rec['minutes'] = sorted(x for x in minutes if x >= old)
        rec['msgs'] = {k: v for k, v in rec['msgs'].items() if v[0] >= cutoff}
    for p in list(files):
        if p not in alive:
            del files[p]


# per UTC hour: sessions started, active minutes, and per model [input, output, cache read, cache write 5m, cache write 1h, replies]
def totals(state):
    hours = {}
    h = lambda t: hours.setdefault(hour_key(t), {'s': 0, 'a': 0, 'm': {}})
    for rec in state['files'].values():
        for t, model, i, o, cr, w5, w1 in rec['msgs'].values():
            row = h(t)['m'].setdefault(model, [0, 0, 0, 0, 0, 0])
            for k, v in enumerate((i, o, cr, w5, w1, 1)):
                row[k] += v
    first = {}
    for rec in state['files'].values():
        for sid, t in rec['sessions'].items():
            if sid not in first or t < first[sid]:
                first[sid] = t
    cutoff = time.time() - KEEP_DAYS * 86400
    for t in first.values():
        if t >= cutoff:
            h(t)['s'] += 1
    mins = sorted({x for rec in state['files'].values() for x in rec['minutes']})
    for k, m in enumerate(mins):
        nxt = mins[k + 1] if k + 1 < len(mins) else None
        span = nxt - m if nxt is not None and nxt - m <= GAP_MIN else 1
        for x in range(m, m + span):
            h(x * 60)['a'] += 1
    return hours


# --- plan limits: this machine's own sign-in, read here and only sent to Anthropic ---

# The account's plan as Anthropic names it now ("Ultra"): the sign-in keeps the plan it was made
# with, so an upgrade shows here first. Asked at most once an hour; only the plan's name is kept.
def plan_name(token, state):
    cached = state.get('plan')
    if isinstance(cached, dict) and time.time() - cached.get('at', 0) < 3600:
        return cached.get('name')
    req = urllib.request.Request(PROFILE_URL, headers={'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': f'homelab-lookout-claude/{VERSION}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            org = json.load(r).get('organization') or {}
        name = org.get('plan_display_name') if isinstance(org.get('plan_display_name'), str) else None
    except (OSError, ValueError, AttributeError):
        name = None
    state['plan'] = {'at': time.time(), 'name': name}
    return name


def plan_limits(state):
    cred = load_json(os.path.join(CLAUDE_DIR, '.credentials.json'), None)
    o = cred.get('claudeAiOauth') if isinstance(cred, dict) else None
    if not isinstance(o, dict) or not o.get('accessToken'):
        return {'error': 'Not signed in to Claude here (or the sign-in is kept in a keychain)'}
    if isinstance(o.get('expiresAt'), (int, float)) and o['expiresAt'] / 1000 < time.time():
        return {'error': 'The Claude sign-in here has expired; it renews the next time Claude Code is used', 'plan': o.get('subscriptionType')}
    req = urllib.request.Request(USAGE_URL, headers={'Authorization': f"Bearer {o['accessToken']}", 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': f'homelab-lookout-claude/{VERSION}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return {'error': f'Anthropic answered HTTP {e.code}', 'plan': o.get('subscriptionType')}
    except (OSError, ValueError) as e:
        return {'error': f'Could not reach Anthropic: {str(e)[:80]}', 'plan': o.get('subscriptionType')}
    out = {'plan': plan_name(o['accessToken'], state) or (o.get('subscriptionType') if isinstance(o.get('subscriptionType'), str) else None)}
    for src, dst in (('five_hour', 'fiveHour'), ('seven_day', 'sevenDay'), ('seven_day_opus', 'sevenDayOpus'), ('seven_day_sonnet', 'sevenDaySonnet')):
        w = d.get(src) if isinstance(d, dict) else None
        if isinstance(w, dict) and isinstance(w.get('utilization'), (int, float)):
            out[dst] = {'pct': w['utilization'], 'resetsAt': w.get('resets_at') if isinstance(w.get('resets_at'), str) else None}
    rows = (d.get('seven_day_breakdown') or {}).get('rows') if isinstance(d, dict) and isinstance(d.get('seven_day_breakdown'), dict) else None
    if isinstance(rows, list):
        out['breakdown'] = [{'key': str(x.get('key'))[:30], 'name': str(x.get('display_name'))[:40], 'pct': x['percent']} for x in rows[:8]
                            if isinstance(x, dict) and isinstance(x.get('percent'), (int, float)) and x.get('key') and x.get('display_name')]
    if not any(k in out for k in ('fiveHour', 'sevenDay')):
        out['error'] = 'Anthropic did not report any limits for this plan'
    return out


# --- sending ---

# The system's trusted certificates, plus the dashboard's own CA when it has one (like curl does):
# the same address may be the dashboard itself or a reverse proxy with a public certificate
def tls(conf):
    ctx = ssl.create_default_context()
    if conf['CA']:
        ctx.load_verify_locations(cafile=conf['CA'])
    return ctx


def post(conf, path, body):
    ctx = tls(conf)
    req = urllib.request.Request(conf['URL'].rstrip('/') + path, data=json.dumps(body).encode(), method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': f"Bearer {conf['ID']}.{conf['TOKEN']}", 'User-Agent': f'homelab-lookout-claude/{VERSION}'})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        return r.read().decode('utf-8', 'replace')


def report(verbose=False):
    conf = read_conf()
    if not (conf['URL'] and conf['ID'] and conf['TOKEN']):
        die(f'not set up: {CONF} needs URL, ID and TOKEN (the install command from Admin writes it)')
    path = os.path.join(STATE_DIR, 'state.json')
    state = load_json(path, {})
    if state.get('v') != 1:
        state = {'v': 1, 'files': {}}
    counting = state.get('usage') != 'no'
    if counting:
        scan(state)
    else:
        state['files'] = {}  # nothing is kept from the logs either
    hours = totals(state) if counting else {}
    body = {'reporter': VERSION, 'hostname': os.uname().nodename[:64], 'hours': hours}
    if state.get('limits') == 'yes':
        body['limits'] = plan_limits(state)
    try:
        answer = post(conf, '/claude/report', body)
    except urllib.error.HTTPError as e:
        save_json(path, state)
        die(f'the dashboard answered HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}')
    except OSError as e:
        save_json(path, state)
        die(f'could not reach the dashboard: {e}')
    was = (state.get('usage'), state.get('limits'))
    for line in answer.splitlines():
        if line.startswith('usage='):
            state['usage'] = line[6:].strip()
        if line.startswith('limits='):
            state['limits'] = line[7:].strip()
        if line.startswith('latest='):
            state['latest'] = line[7:].strip()
    state['sentAt'] = int(time.time())
    state['sent'] = {'hours': len(hours), 'replies': sum(r[5] for x in hours.values() for r in x['m'].values()), 'limits': body.get('limits')}
    save_json(path, state)
    if verbose:
        say(f"Sent: {len(hours)} hours with use, {state['sent']['replies']} replies in the last {KEEP_DAYS} days")
        if 'limits' in body:
            say(f"Plan limits: {json.dumps(body['limits'])}")
        say(f'Answer from the dashboard:\n{answer.strip()}')
    # what to report was just changed in Admin: send it that way right away
    changed = was != (None, None) and (state.get('usage'), state.get('limits')) != was
    if changed or (state.get('limits') == 'yes' and 'limits' not in body) or (state.get('usage') == 'no' and hours):
        report(verbose)


def status():
    conf = read_conf()
    state = load_json(os.path.join(STATE_DIR, 'state.json'), {})
    say(f'lookout-claude {VERSION}')
    say(f"Dashboard: {conf['URL'] or '(not set)'}")
    say(f'Claude Code logs: {os.path.join(CLAUDE_DIR, "projects")}')
    if state.get('sentAt'):
        s = state['sent']
        say(f"Last report: {time.strftime('%Y-%m-%d %H:%M', time.localtime(state['sentAt']))} ({s['hours']} hours with use, {s['replies']} replies)")
        say(f"Claude Code tokens: {'counted' if state.get('usage') != 'no' else 'not counted (switched off in Admin)'}")
        say(f"Plan limits: {'on' if state.get('limits') == 'yes' else 'off (switch them on in Admin)'}")
        if s.get('limits'):
            say(f"  {json.dumps(s['limits'])}")
    else:
        say('Nothing sent yet (run: lookout-claude test)')
    if state.get('latest') and state['latest'] != VERSION:
        say(f"A newer reporter is available: {state['latest']} (run: lookout-claude update)")


def update():
    conf = read_conf()
    with urllib.request.urlopen(conf['URL'].rstrip('/') + '/claude/lookout-claude.py', timeout=20, context=tls(conf)) as r:
        text = r.read()
    if not text.startswith(b'#!/usr/bin/env python3'):
        die('the dashboard did not send a reporter')
    me = os.path.realpath(sys.argv[0])
    tmp = f'{me}.new'
    with open(tmp, 'wb') as f:
        f.write(text)
    os.chmod(tmp, 0o755)
    os.replace(tmp, me)
    say('Updated. It sends with the new version from the next report.')


def uninstall():
    conf = read_conf()
    if conf['URL'] and conf['ID'] and conf['TOKEN']:
        try:
            post(conf, '/claude/bye', {})
        except OSError:
            pass
    os.system('systemctl --user disable --now lookout-claude.timer >/dev/null 2>&1')
    for p in (os.path.join(HOME, '.config', 'systemd', 'user', 'lookout-claude.timer'), os.path.join(HOME, '.config', 'systemd', 'user', 'lookout-claude.service'), CONF, os.path.join(STATE_DIR, 'state.json'), os.path.realpath(sys.argv[0])):
        try:
            os.remove(p)
        except OSError:
            pass
    os.system('systemctl --user daemon-reload >/dev/null 2>&1')
    say('Removed. The Claude Code logs in ~/.claude were not touched.')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if cmd == 'run':
        report()
    elif cmd == 'test':
        report(True)
    elif cmd == 'status':
        status()
    elif cmd == 'update':
        update()
    elif cmd == 'uninstall':
        uninstall()
    else:
        die('usage: lookout-claude [run|test|status|update|uninstall]')
