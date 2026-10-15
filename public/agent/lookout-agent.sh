#!/bin/sh
# Homelab Lookout agent: reports how this Linux machine is doing to the dashboard, once a minute.
# It only reads (/proc, df, systemctl, the package lists) and sends; it never runs anything the
# dashboard asks for. Runs as its own system user from a systemd timer.
#
#   lookout-agent status            what it last sent, and its settings
#   lookout-agent test              send a report now and show the answer
#   lookout-agent watch add <unit>  also watch a systemd service (watch remove / watch list)
#   lookout-agent update            install the newest agent from the dashboard (as root)
#   lookout-agent uninstall         remove it from this machine (as root)
#
# Settings: /etc/lookout-agent/agent.conf. Services to watch and the interval can also be set on
# the dashboard (Admin → Devices → Linux agents); both lists count.
VERSION=1.0.0
CONF=${LOOKOUT_AGENT_CONF:-/etc/lookout-agent/agent.conf}
STATE=${LOOKOUT_AGENT_STATE:-/var/lib/lookout-agent}
set -u

# sending is done as its own user, so its files stay its own (sudo lookout-agent test works too)
case "${1:-run}" in
  run|test)
    if [ "$(id -u)" = 0 ] && id lookout-agent >/dev/null 2>&1 && [ -z "${LOOKOUT_AGENT_CONF:-}" ]; then
      exec su -s /bin/sh lookout-agent -c "/usr/local/bin/lookout-agent ${1:-run}"
    fi
    ;;
esac

[ -r "$CONF" ] && . "$CONF"
: "${URL:=}" "${ID:=}" "${TOKEN:=}" "${CA:=}" "${INTERVAL:=60}" "${WATCH:=}" "${UPDATES:=yes}"

say() { printf '%s\n' "$*"; }
die() { printf 'lookout-agent: %s\n' "$*" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
num() { case "$1" in ''|*[!0-9.]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
curl_dash() { curl -fsS --max-time 20 ${CA:+--cacert "$CA"} "$@"; }

# the dashboard's own settings for this agent (from its last answer)
remote() {
  [ -r "$STATE/remote" ] || return 0
  sed -n "s/^$1=//p" "$STATE/remote" | head -n 1
}

cpu_json() {
  read -r _ u n s i w q sq st _ < /proc/stat
  now="$u $n $s $i $w $q $sq ${st:-0}"
  prev=$(cat "$STATE/cpu" 2>/dev/null || true)
  printf '%s' "$now" > "$STATE/cpu"
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  cores=$(grep -c '^processor' /proc/cpuinfo)
  if [ -n "$prev" ]; then
    set -- $prev $now
    tot=$(( ($9+${10}+${11}+${12}+${13}+${14}+${15}+${16}) - ($1+$2+$3+$4+$5+$6+$7+$8) ))
    idle=$(( (${12}+${13}) - ($4+$5) ))
    io=$(( ${13} - $5 ))
    stl=$(( ${16} - $8 ))
    if [ "$tot" -gt 0 ]; then
      printf '"cpu":{"cores":%s,"usage":%s,"iowait":%s,"steal":%s,"load":[%s]}' "$cores" \
        "$(awk -v a="$tot" -v b="$idle" 'BEGIN{printf "%.1f", 100*(a-b)/a}')" "$(awk -v a="$tot" -v b="$io" 'BEGIN{printf "%.1f", 100*b/a}')" \
        "$(awk -v a="$tot" -v b="$stl" 'BEGIN{printf "%.1f", 100*b/a}')" "$(echo "$load" | tr ' ' ',')"
      return
    fi
  fi
  printf '"cpu":{"cores":%s,"usage":null,"load":[%s]}' "$cores" "$(echo "$load" | tr ' ' ',')"
}

mem_json() {
  awk '/^(MemTotal|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):/ {gsub(":", "", $1); v[$1]=$2}
    END {printf "\"mem\":{\"total\":%d,\"available\":%d,\"cache\":%d,\"swapTotal\":%d,\"swapUsed\":%d}", v["MemTotal"]*1024, v["MemAvailable"]*1024, (v["Buffers"]+v["Cached"])*1024, v["SwapTotal"]*1024, (v["SwapTotal"]-v["SwapFree"])*1024}' /proc/meminfo
}

fs_json() {
  printf '"fs":['
  df -PkT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs -x proc -x sysfs 2>/dev/null | awk 'NR>1 && $7 !~ /^\/(boot\/efi|snap)/ {print $7, $2, $3, $4}' | head -n 30 |
  { first=1; while read -r mnt type size used; do
      inodes=$(df -Pi "$mnt" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
      [ $first = 1 ] || printf ','; first=0
      printf '{"mount":"%s","type":"%s","size":%s,"used":%s,"inodes":%s}' "$(esc "$mnt")" "$(esc "$type")" "$(( size * 1024 ))" "$(( used * 1024 ))" "$(num "$inodes")"
    done; }
  printf ']'
}

net_json() {
  printf '"net":['
  awk 'NR>2 {sub(/^ +/, ""); split($0, a, /[: ]+/); n=a[1]; if (n ~ /^(lo|veth|docker|br-|virbr|tap|fwbr|fwln|fwpr|cali|flannel|cni)/ || c >= 30) next; printf "%s{\"name\":\"%s\",\"rx\":%s,\"tx\":%s}", (c++ ? "," : ""), n, a[2], a[10]}' /proc/net/dev
  printf ']'
}

temp_json() {
  printf '"temps":['
  first=1; count=0
  for f in /sys/class/hwmon/hwmon*/temp*_input; do
    [ -r "$f" ] || continue
    d=${f%/*}; base=${f%_input}
    label=$(cat "${base}_label" 2>/dev/null || cat "$d/name" 2>/dev/null || echo sensor)
    v=$(cat "$f" 2>/dev/null) || continue
    [ $first = 1 ] || printf ','; first=0
    printf '{"name":"%s","c":%s}' "$(esc "$(cat "$d/name" 2>/dev/null) $label")" "$(awk -v x="$v" 'BEGIN{printf "%.1f", x/1000}')"
    count=$((count + 1)); [ $count -ge 24 ] && break
  done
  if [ $first = 1 ]; then
    for z in /sys/class/thermal/thermal_zone*; do
      [ -r "$z/temp" ] || continue
      [ $first = 1 ] || printf ','; first=0
      printf '{"name":"%s","c":%s}' "$(esc "$(cat "$z/type" 2>/dev/null)")" "$(awk -v x="$(cat "$z/temp")" 'BEGIN{printf "%.1f", x/1000}')"
    done
  fi
  printf ']'
}

units_json() {
  printf '"failed":['
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --failed --no-legend --plain --type=service 2>/dev/null | awk '{print $1}' | head -n 30 |
      { first=1; while read -r u; do [ -n "$u" ] || continue; [ $first = 1 ] || printf ','; first=0; printf '"%s"' "$(esc "$u")"; done; }
  fi
  printf '],"watched":['
  first=1
  for u in $(remote watch) $WATCH; do
    case "$u" in *[!A-Za-z0-9@._:-]*) continue ;; esac
    state=$(systemctl is-active "$u" 2>/dev/null || true)
    [ $first = 1 ] || printf ','; first=0
    printf '{"unit":"%s","state":"%s"}' "$(esc "$u")" "$(esc "${state:-unknown}")"
  done
  printf ']'
}

# pending updates, looked up every 6 hours (the system's own apt/dnf timer refreshes the lists)
updates_json() {
  want=$(remote updates); [ -n "$want" ] || want=$UPDATES
  if [ "$want" != yes ]; then printf '"updates":null'; return; fi
  cache="$STATE/updates"
  if [ ! -s "$cache" ] || [ -n "$(find "$cache" -mmin +360 2>/dev/null)" ]; then
    if command -v apt >/dev/null 2>&1; then
      apt list --upgradable 2>/dev/null | awk -F'[/ ]' 'NR>1 && NF>2 {print $1, $2, $3}' > "$cache.new"
    elif command -v dnf >/dev/null 2>&1; then
      dnf -q check-update 2>/dev/null | awk 'NF==3 && $1 ~ /\./ {print $1, $3, $2}' > "$cache.new"
    else
      printf 'none\n' > "$cache.new"
    fi
    mv "$cache.new" "$cache"
  fi
  if grep -qx none "$cache" 2>/dev/null; then printf '"updates":null'; return; fi
  total=$(grep -c . "$cache" || true)
  sec=$(grep -c -- '-security' "$cache" || true)
  reboot=false; [ -e /var/run/reboot-required ] && reboot=true
  printf '"updates":{"count":%s,"security":%s,"reboot":%s,"packages":[' "${total:-0}" "${sec:-0}" "$reboot"
  head -n 60 "$cache" | { first=1; while read -r name suite ver; do [ $first = 1 ] || printf ','; first=0; printf '{"name":"%s","version":"%s","security":%s}' "$(esc "$name")" "$(esc "$ver")" "$(case "$suite" in *-security*) echo true ;; *) echo false ;; esac)"; done; }
  printf ']}'
}

top_json() {
  printf '"top":['
  ps -eo comm=,pcpu=,pmem= --sort=-pcpu 2>/dev/null | head -n 5 | { first=1; while read -r c p m; do [ $first = 1 ] || printf ','; first=0; printf '{"name":"%s","cpu":%s,"mem":%s}' "$(esc "$c")" "$(num "$p")" "$(num "$m")"; done; }
  printf ']'
}

report() {
  [ -n "$URL" ] && [ -n "$ID" ] && [ -n "$TOKEN" ] || die "not set up: $CONF needs URL, ID and TOKEN"
  pretty=$( (. /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-Linux}") )
  ips=$(hostname -I 2>/dev/null || ip -4 -o addr show scope global 2>/dev/null | awk '{sub("/.*","",$4); printf "%s ", $4}')
  {
    printf '{"agent":"%s","hostname":"%s","os":"%s","kernel":"%s","uptime":%s,"interval":%s,"ips":"%s",' \
      "$VERSION" "$(esc "$(hostname)")" "$(esc "$pretty")" "$(esc "$(uname -r)")" "$(cut -d. -f1 /proc/uptime)" "$(num "$INTERVAL")" "$(esc "$ips")"
    cpu_json; printf ','; mem_json; printf ','; fs_json; printf ','; net_json; printf ','; temp_json; printf ','
    units_json; printf ','; updates_json; printf ','; top_json
    printf '}'
  } > "$STATE/report.json"
  if curl_dash -H "Authorization: Bearer $ID.$TOKEN" -H 'Content-Type: application/json' -H 'Accept: text/plain' \
      --data-binary @"$STATE/report.json" -o "$STATE/remote.new" "$URL/agent/report" 2> "$STATE/error"; then
    mv "$STATE/remote.new" "$STATE/remote"
    date +%s > "$STATE/last"
    : > "$STATE/error"
    return 0
  fi
  return 1
}

case "${1:-run}" in
  run)
    # the timer runs every 30 s; the interval (here or on the dashboard) decides when to send
    every=$(remote interval); [ -n "$every" ] || every=$INTERVAL
    last=$(cat "$STATE/last" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - last + 5 )) -ge "$every" ] || exit 0
    report || { cat "$STATE/error" >&2; exit 1; }
    ;;
  test)
    if report; then
      say "Sent. The dashboard answered:"; sed 's/^/  /' "$STATE/remote"
    else
      say "Not sent: $(cat "$STATE/error")"; exit 1
    fi
    ;;
  status)
    [ -r "$CONF" ] || die "can't read $CONF: run it with sudo"
    say "Lookout agent $VERSION, reporting to ${URL:-?}"
    last=$(cat "$STATE/last" 2>/dev/null || echo 0)
    if [ "$last" -gt 0 ]; then say "Last report: $(( $(date +%s) - last )) s ago"; else say "No report sent yet"; fi
    [ -s "$STATE/error" ] && say "Last error: $(cat "$STATE/error")"
    say "Interval: $(remote interval || true) s (dashboard), $INTERVAL s (here)"
    say "Watching: $(remote watch) $WATCH"
    latest=$(remote latest)
    [ -n "$latest" ] && [ "$latest" != "$VERSION" ] && say "A newer agent ($latest) is on the dashboard: sudo lookout-agent update"
    command -v systemctl >/dev/null 2>&1 && systemctl is-active lookout-agent.timer >/dev/null 2>&1 && say "Timer: running" || say "Timer: not running"
    ;;
  watch)
    case "${2:-list}" in
      list) say "Here: ${WATCH:-none}"; say "On the dashboard: $(remote watch)" ;;
      add|remove)
        [ "$(id -u)" = 0 ] || die "run it with sudo"
        u=${3:-}; case "$u" in ''|*[!A-Za-z0-9@._:-]*) die "a systemd unit name, like nginx or docker.service" ;; esac
        if [ "$2" = add ]; then new=$(printf '%s %s' "$WATCH" "$u" | tr ' ' '\n' | awk 'NF && !s[$0]++' | tr '\n' ' ')
        else new=$(printf '%s' "$WATCH" | tr ' ' '\n' | grep -vx "$u" | tr '\n' ' '); fi
        new=$(printf '%s' "$new" | sed 's/ *$//')
        if grep -q '^WATCH=' "$CONF"; then sed -i "s|^WATCH=.*|WATCH=\"$new\"|" "$CONF"; else printf 'WATCH="%s"\n' "$new" >> "$CONF"; fi
        say "Watching here: ${new:-none}"
        ;;
      *) die "watch add <unit> | watch remove <unit> | watch list" ;;
    esac
    ;;
  update)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    tmp=$(mktemp)
    curl_dash -o "$tmp" "$URL/agent/lookout-agent.sh" || die "could not download the agent from $URL"
    head -n 1 "$tmp" | grep -q '^#!/bin/sh' || die "the download is not the agent"
    new=$(sed -n 's/^VERSION=//p' "$tmp" | head -n 1)
    install -m 0755 "$tmp" /usr/local/bin/lookout-agent && rm -f "$tmp"
    say "Updated: $VERSION -> $new"
    ;;
  uninstall)
    [ "$(id -u)" = 0 ] || die "run it with sudo"
    [ -n "$URL" ] && curl_dash -X POST -H "Authorization: Bearer $ID.$TOKEN" "$URL/agent/bye" >/dev/null 2>&1 || true
    systemctl disable --now lookout-agent.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/lookout-agent.service /etc/systemd/system/lookout-agent.timer
    systemctl daemon-reload >/dev/null 2>&1 || true
    rm -rf /etc/lookout-agent "$STATE"
    userdel lookout-agent >/dev/null 2>&1 || true
    rm -f /usr/local/bin/lookout-agent
    say "The Lookout agent is removed from this machine."
    ;;
  version) say "$VERSION" ;;
  *) die "unknown command: $1 (status, test, watch, update, uninstall)" ;;
esac
