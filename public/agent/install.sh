#!/bin/sh
# Installs the Homelab Lookout agent. Use the command from the dashboard (Admin → Devices → Linux
# agents); it passes this machine's ID and token:
#   curl -fsS __URL__/agent/install.sh | sudo sh -s -- --id ID --token TOKEN [--ca FILE]
# What it does: a system user "lookout-agent", the agent in /usr/local/bin/lookout-agent, its
# settings in /etc/lookout-agent/agent.conf, and a systemd timer. Remove it with:
#   sudo lookout-agent uninstall
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
fail() { echo "Lookout agent: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run it with sudo"
[ -n "$ID" ] && [ -n "$TOKEN" ] || fail "--id and --token are needed (copy the whole command from the dashboard)"
case "$ID$TOKEN" in *[!A-Za-z0-9_-]*) fail "the ID or token is not right; copy the command again" ;; esac
command -v curl >/dev/null 2>&1 || fail "curl is needed (apt install curl)"
command -v systemctl >/dev/null 2>&1 || fail "systemd is needed"

echo "Installing the Lookout agent for $URL"
id lookout-agent >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/lookout-agent --shell /usr/sbin/nologin lookout-agent
install -d -m 0750 -o root -g lookout-agent /etc/lookout-agent
install -d -m 0700 -o lookout-agent -g lookout-agent /var/lib/lookout-agent
CA=""
if [ -n "$CAFILE" ]; then
  install -m 0644 "$CAFILE" /etc/lookout-agent/ca.crt
  CA=/etc/lookout-agent/ca.crt
fi
tmp=$(mktemp)
curl -fsS --max-time 30 ${CA:+--cacert "$CA"} -o "$tmp" "$URL/agent/lookout-agent.sh" || fail "could not download the agent from $URL"
head -n 1 "$tmp" | grep -q '^#!/bin/sh' || fail "the download is not the agent"
install -m 0755 "$tmp" /usr/local/bin/lookout-agent
rm -f "$tmp"
old_watch=""
[ -r /etc/lookout-agent/agent.conf ] && old_watch=$(sed -n 's/^WATCH=//p' /etc/lookout-agent/agent.conf | tr -d '"')
umask 027
cat > /etc/lookout-agent/agent.conf <<CONF
# Homelab Lookout agent. Services to watch, the interval and update checks can also be set on
# the dashboard; what is here is added to that.
URL=$URL
ID=$ID
TOKEN=$TOKEN
CA=$CA
# seconds between reports (at least 30)
INTERVAL=60
# systemd services that must be running, separated by spaces (or: sudo lookout-agent watch add nginx)
WATCH="$old_watch"
# look for pending package updates (every 6 hours)
UPDATES=yes
CONF
chown root:lookout-agent /etc/lookout-agent/agent.conf
chmod 0640 /etc/lookout-agent/agent.conf

cat > /etc/systemd/system/lookout-agent.service <<'UNIT'
[Unit]
Description=Homelab Lookout agent (one report)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=lookout-agent
Group=lookout-agent
ExecStart=/usr/local/bin/lookout-agent run
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/lookout-agent
PrivateTmp=yes
UNIT
cat > /etc/systemd/system/lookout-agent.timer <<'UNIT'
[Unit]
Description=Homelab Lookout agent

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now lookout-agent.timer >/dev/null

if su -s /bin/sh lookout-agent -c '/usr/local/bin/lookout-agent test' ; then
  echo "Done. It reports every minute; check it with: lookout-agent status"
else
  echo "Installed, but the first report did not get through; see above. Try again with: sudo -u lookout-agent lookout-agent test" >&2
fi
