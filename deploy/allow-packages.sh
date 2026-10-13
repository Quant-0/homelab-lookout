#!/bin/sh
# Lets USER install listed packages, apply upgrades and add the NodeSource 24 repository, as root,
# without full sudo (see deploy/homelab-pkg.sh for exactly what it can do). Run once, as root:
#
#   sudo sh deploy/allow-packages.sh USER       install or update the tool and the permission
#   sudo sh deploy/allow-packages.sh --remove   take the permission away again (the list is kept)
#
# Installs /usr/local/sbin/homelab-pkg (root-owned), the list /etc/homelab-pkg/allowed (if there is
# none yet) and /etc/sudoers.d/homelab-pkg, checked with visudo.
set -eu
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BIN=/usr/local/sbin/homelab-pkg
SUDOERS=/etc/sudoers.d/homelab-pkg
LIST=/etc/homelab-pkg/allowed
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
[ $# -eq 1 ] || { echo "Usage: sudo sh deploy/allow-packages.sh USER | --remove" >&2; exit 2; }

if [ "$1" = --remove ]; then
  rm -f "$SUDOERS" "$BIN"
  echo "Removed $BIN and its sudoers line ($LIST is kept)."
  exit 0
fi

USER_NAME=$1
echo "$USER_NAME" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' && id "$USER_NAME" >/dev/null 2>&1 || { echo "No such user: $USER_NAME" >&2; exit 1; }
[ "$USER_NAME" != root ] || { echo "Choose a normal user" >&2; exit 1; }

sed -e "s|@PKG_USER@|$USER_NAME|" "$SRC_DIR/deploy/homelab-pkg.sh" > "$BIN.tmp"
sh -n "$BIN.tmp" || { rm -f "$BIN.tmp"; echo "Syntax check failed" >&2; exit 1; }
chown root:root "$BIN.tmp"
chmod 0755 "$BIN.tmp"
mv "$BIN.tmp" "$BIN"

# what the dashboard uses; add more with: sudo homelab-pkg allow NAME
if [ ! -f "$LIST" ]; then
  install -d -m 0755 "$(dirname "$LIST")"
  printf '%s\n' nodejs rsync openssh-client iputils-ping openssl ca-certificates curl gnupg > "$LIST"
  chmod 0644 "$LIST"
fi

# exactly these four forms; anything else (allow, disallow) still needs the owner's own password
printf '# Added by deploy/allow-packages.sh: %s may install listed packages, upgrade, and add the NodeSource 24 repository\n%s ALL=(root) NOPASSWD: %s install *, %s upgrade, %s setup-nodesource-24, %s list\n' \
  "$USER_NAME" "$USER_NAME" "$BIN" "$BIN" "$BIN" "$BIN" > "$SUDOERS.tmp"
chmod 0440 "$SUDOERS.tmp"
visudo -cqf "$SUDOERS.tmp" || { rm -f "$SUDOERS.tmp"; echo "sudoers check failed" >&2; exit 1; }
mv "$SUDOERS.tmp" "$SUDOERS"

echo "$USER_NAME may now run: sudo -n homelab-pkg install|upgrade|setup-nodesource-24|list"
echo "Allowed packages ($LIST):"
sed 's/^/  /' "$LIST"
echo "Add one later with: sudo homelab-pkg allow NAME   (every run is logged: journalctl -t homelab-pkg)"
