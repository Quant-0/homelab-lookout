#!/bin/sh
# Installs the Homelab Lookout Claude reporter for the user who runs it (no sudo: it reads that
# user's ~/.claude). Use the command from the dashboard (Admin → Dashboard → Claude); it passes
# this reporter's ID and token:
#   curl -fsS __URL__/claude/install.sh | sh -s -- --id ID --token TOKEN [--ca FILE]
# What it does: the reporter in ~/.local/bin/lookout-claude, its settings in
# ~/.config/lookout-claude/reporter.conf, and a systemd user timer. Remove it with:
#   lookout-claude uninstall
set -eu
URL="__URL__"
ID=""; TOKEN=""; CAFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) ID=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --ca) CAFILE=$2; shift 2 ;;
    --url) URL=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
fail() { echo "Lookout Claude reporter: $*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || fail "run it as the user who uses Claude Code, not with sudo"
[ -n "$ID" ] && [ -n "$TOKEN" ] || fail "--id and --token are needed (copy the whole command from the dashboard)"
case "$ID$TOKEN" in *[!A-Za-z0-9_-]*) fail "the ID or token is not right; copy the command again" ;; esac
command -v curl >/dev/null 2>&1 || fail "curl is needed (apt install curl)"
command -v python3 >/dev/null 2>&1 || fail "Python 3 is needed (apt install python3)"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || fail "Python 3.8 or newer is needed"
systemctl --user show-environment >/dev/null 2>&1 || fail "systemd for your user is needed (log in normally, not with su)"
[ -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ] || echo "Note: no Claude Code logs in ${CLAUDE_CONFIG_DIR:-$HOME/.claude} yet; it reports once Claude Code has been used here."

echo "Installing the Lookout Claude reporter for $URL"
CONFDIR="$HOME/.config/lookout-claude"
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
mkdir -p -m 0700 "$CONFDIR"
CA=""
if [ -n "$CAFILE" ]; then
  cp "$CAFILE" "$CONFDIR/ca.crt"
  CA="$CONFDIR/ca.crt"
fi
tmp=$(mktemp)
curl -fsS --max-time 30 ${CA:+--cacert "$CA"} -o "$tmp" "$URL/claude/lookout-claude.py" || fail "could not download the reporter from $URL"
head -n 1 "$tmp" | grep -q '^#!/usr/bin/env python3' || fail "the download is not the reporter"
install -m 0755 "$tmp" "$HOME/.local/bin/lookout-claude"
rm -f "$tmp"
umask 077
cat > "$CONFDIR/reporter.conf" <<CONF
# Homelab Lookout Claude reporter. Plan limits are switched on and off on the dashboard.
URL=$URL
ID=$ID
TOKEN=$TOKEN
CA=$CA
CONF
umask 022

cat > "$HOME/.config/systemd/user/lookout-claude.service" <<UNIT
[Unit]
Description=Homelab Lookout Claude reporter (one report)

[Service]
Type=oneshot
ExecStart=$HOME/.local/bin/lookout-claude run
${CLAUDE_CONFIG_DIR:+Environment=CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR}
UNIT
cat > "$HOME/.config/systemd/user/lookout-claude.timer" <<'UNIT'
[Unit]
Description=Homelab Lookout Claude reporter

[Timer]
OnStartupSec=1min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now lookout-claude.timer >/dev/null

if "$HOME/.local/bin/lookout-claude" test; then
  echo "Done. It reports every 5 minutes; check it with: ~/.local/bin/lookout-claude status"
else
  echo "Installed, but the first report did not get through; see above. Try again with: ~/.local/bin/lookout-claude test" >&2
fi
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  echo "To keep reporting while you are logged out, run once: sudo loginctl enable-linger $(id -un)"
fi
