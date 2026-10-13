#!/bin/sh
# homelab-pkg: lets one user (who may deploy the dashboard) keep lookout's packages in order
# without full sudo. Installed root-owned as /usr/local/sbin/homelab-pkg by
#   sudo sh deploy/allow-packages.sh USER
# which also adds one sudoers line allowing USER only these:
#   sudo -n homelab-pkg install PACKAGE...    packages on the owner's list, from the repositories
#                                           already set up (signed), never a file or an option
#   sudo -n homelab-pkg upgrade               apt-get update + upgrade of what is installed
#   sudo -n homelab-pkg setup-nodesource-24   adds the NodeSource Node.js 24 repository once,
#                                           with its signing key checked against a pinned fingerprint
#   sudo -n homelab-pkg list                  shows the list
# Only the owner changes the list (with their own sudo password):
#   sudo homelab-pkg allow PACKAGE...   /   sudo homelab-pkg disallow PACKAGE...
# Every run is logged: journalctl -t homelab-pkg
set -eu
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
LIST=/etc/homelab-pkg/allowed
PKG_USER=@PKG_USER@
SERVICE=homelab-dashboard
# NodeSource's repository signing key (NSolid <nsolid-gpg@nodesource.com>)
NODESOURCE_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4

say() { logger -t homelab-pkg "$*" 2>/dev/null || true; echo "$*"; }
fail() { logger -t homelab-pkg "refused: $*" 2>/dev/null || true; echo "homelab-pkg: $*" >&2; exit 1; }
usage() { fail "usage: homelab-pkg install PACKAGE... | upgrade | setup-nodesource-24 | list | allow PACKAGE... | disallow PACKAGE..."; }
apt() { apt-get -q -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
name_ok() { echo "$1" | grep -Eq '^[a-z0-9][a-z0-9.+-]{0,62}$'; }
listed() { grep -qxF "$1" "$LIST" 2>/dev/null; }
node_version() { dpkg-query -W -f '${Version}' nodejs 2>/dev/null || true; }
# a new Node.js only takes effect once the dashboard restarts
restart_if_node_changed() {
  if [ "$(node_version)" != "$1" ] && systemctl is-active --quiet "$SERVICE"; then
    systemctl restart "$SERVICE"
    say "Node.js changed ($1 -> $(node_version)): $SERVICE restarted"
  fi
}

[ "$(id -u)" = 0 ] || fail "run with sudo"
BY=${SUDO_USER:-root}
CMD=${1:-}
[ $# -gt 0 ] && shift
exec 9>/run/lock/homelab-pkg.lock
flock -w 900 9 || fail "another run is busy"

case "$CMD" in
  list)
    [ $# -eq 0 ] || usage
    cat "$LIST"
    ;;
  install)
    [ $# -ge 1 ] && [ $# -le 20 ] || usage
    for p in "$@"; do
      name_ok "$p" || fail "not a package name: $p"
      listed "$p" || fail "$p is not on the list; the owner can add it with: sudo homelab-pkg allow $p"
    done
    say "$BY: install $*"
    before=$(node_version)
    apt update
    apt install --no-install-recommends "$@"
    restart_if_node_changed "$before"
    ;;
  upgrade)
    [ $# -eq 0 ] || usage
    say "$BY: upgrade"
    before=$(node_version)
    apt update
    apt upgrade
    restart_if_node_changed "$before"
    ;;
  setup-nodesource-24)
    [ $# -eq 0 ] || usage
    if [ -f /etc/apt/sources.list.d/nodesource.list ]; then
      echo "The NodeSource repository is already set up"
      exit 0
    fi
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp/key" || fail "could not download the NodeSource key"
    fpr=$(GNUPGHOME="$tmp" gpg --batch --show-keys --with-colons "$tmp/key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
    [ "$fpr" = "$NODESOURCE_FPR" ] || fail "the NodeSource key has fingerprint ${fpr:-none}, expected $NODESOURCE_FPR: not added"
    install -d -m 0755 /etc/apt/keyrings
    GNUPGHOME="$tmp" gpg --batch --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$tmp/key"
    chmod 0644 /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    say "$BY: added the NodeSource Node.js 24 repository (key $NODESOURCE_FPR)"
    apt update
    echo "Now: sudo -n homelab-pkg install nodejs"
    ;;
  allow | disallow)
    # the owner only: the user this tool is for can't change its own list
    [ "$BY" != "$PKG_USER" ] || fail "only the owner can change the list"
    [ $# -ge 1 ] || usage
    for p in "$@"; do name_ok "$p" || fail "not a package name: $p"; done
    install -d -m 0755 "$(dirname "$LIST")"
    touch "$LIST"
    for p in "$@"; do
      if [ "$CMD" = allow ]; then
        listed "$p" || echo "$p" >> "$LIST"
      else
        grep -vxF "$p" "$LIST" > "$LIST.tmp" || true
        mv "$LIST.tmp" "$LIST"
      fi
    done
    chmod 0644 "$LIST"
    say "$BY: ${CMD}ed $*"
    ;;
  *)
    usage
    ;;
esac
