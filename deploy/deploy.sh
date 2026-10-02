#!/bin/sh
# Deploys the committed main branch of the dashboard repository (server.js and public/ only)
# to /opt/homelab-dashboard and restarts the service. If it doesn't come up, the previous
# version is put back.
#
# Installed root-owned as /usr/local/sbin/homelab-dashboard-deploy by
#   sudo sh deploy/install.sh --allow-deploy USER
# which also lets USER run it with sudo, without a password and without arguments:
#   sudo -n /usr/local/sbin/homelab-dashboard-deploy
#
# Root never runs anything from the repository: git runs as the deploy user, and only file
# contents (blobs) of regular files are copied. Symlinks, submodules and unusual paths abort
# the deploy. The systemd unit, config, keys and certificates are not touched (install.sh).
set -eu
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REPO=@REPO@
DEPLOY_USER=@DEPLOY_USER@
BRANCH=main
SERVICE=homelab-dashboard
SVC_USER=homelab-dash
APP_DIR=/opt/homelab-dashboard

fail() { echo "Deploy failed: $*" >&2; logger -t "$SERVICE-deploy" "failed: $*" 2>/dev/null || true; exit 1; }
[ $# -eq 0 ] || { echo "Usage: sudo $0   (no arguments: deploys $BRANCH from $REPO)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || fail "run with sudo"

exec 9>/run/lock/"$SERVICE"-deploy.lock
flock -n 9 || fail "another deploy is running"

git_as_user() { runuser -u "$DEPLOY_USER" -- env HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" "$@"; }

COMMIT=$(git_as_user rev-parse --verify --quiet "refs/heads/$BRANCH^{commit}") || fail "no branch $BRANCH in $REPO"
echo "$COMMIT" | grep -Eq '^[0-9a-f]{40}$' || fail "unexpected commit id"
SUBJECT=$(git_as_user log -1 --format=%s "$COMMIT" | tr -cd '[:print:]' | cut -c1-120)

STAGE=$(mktemp -d /opt/."$SERVICE".XXXXXX)
LIST=$STAGE.list
trap 'rm -rf "$STAGE" "$LIST"' EXIT # after the swap $STAGE no longer exists
git_as_user ls-tree -r --full-tree "$COMMIT" -- server.js public > "$LIST" || fail "could not list files"
COUNT=0
while IFS= read -r line; do
  meta=${line%%	*}
  file=${line#*	}
  set -- $meta
  [ "$#" = 3 ] || fail "unexpected entry: $line"
  mode=$1; type=$2; sha=$3
  [ "$type" = blob ] && { [ "$mode" = 100644 ] || [ "$mode" = 100755 ]; } || fail "not a regular file: $file"
  echo "$sha" | grep -Eq '^[0-9a-f]{40}$' || fail "unexpected object id for $file"
  echo "$file" | grep -Eq '^(server\.js|public(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)$' || fail "unexpected path: $file"
  mkdir -p "$STAGE/$(dirname "$file")"
  git_as_user cat-file blob "$sha" > "$STAGE/$file" || fail "could not read $file"
  COUNT=$((COUNT + 1))
done < "$LIST"
[ -s "$STAGE/server.js" ] && [ -f "$STAGE/public/dashboard.html" ] || fail "server.js or public/ missing in $BRANCH"
printf '%s\n%s\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/VERSION"
chown -R root:root "$STAGE"
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
# Syntax check as the service user (parses only, runs nothing)
runuser -u "$SVC_USER" -- /usr/bin/node --check "$STAGE/server.js" || fail "server.js has a syntax error"

# The unit file is installed by install.sh only; say so if the repository has a newer one
UNIT_SHA=$(git_as_user rev-parse --verify --quiet "$COMMIT:deploy/$SERVICE.service" || true)
if [ -n "$UNIT_SHA" ] && ! git_as_user cat-file blob "$UNIT_SHA" | cmp -s - "/etc/systemd/system/$SERVICE.service"; then
  echo "Note: deploy/$SERVICE.service changed. Run install.sh to install the new unit."
fi

# Swap (the running service has its files in memory), restart, and wait for it to listen
rm -rf "$APP_DIR.prev"
[ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.prev"
mv "$STAGE" "$APP_DIR"
SINCE=$(date +%s)
systemctl restart "$SERVICE"
up=0
for _ in $(seq 1 40); do
  if journalctl -u "$SERVICE" --since "@$SINCE" -o cat --no-pager 2>/dev/null | grep -q 'Listening on'; then up=1; break; fi
  sleep 0.5
done
if [ "$up" = 1 ]; then
  sleep 2
  systemctl is-active --quiet "$SERVICE" || up=0
fi
if [ "$up" != 1 ]; then
  echo "The service did not start with $COMMIT; restoring the previous version." >&2
  journalctl -u "$SERVICE" --since "@$SINCE" -o cat --no-pager | tail -n 15 >&2 || true
  if [ -d "$APP_DIR.prev" ]; then
    rm -rf "$APP_DIR.failed"
    mv "$APP_DIR" "$APP_DIR.failed"
    mv "$APP_DIR.prev" "$APP_DIR"
    systemctl restart "$SERVICE" || true
  fi
  fail "rolled back from $COMMIT"
fi

logger -t "$SERVICE-deploy" "deployed $COMMIT ($SUBJECT) by ${SUDO_USER:-root}, $COUNT files" 2>/dev/null || true
echo "Deployed $(echo "$COMMIT" | cut -c1-7) \"$SUBJECT\" ($COUNT files). Previous version kept in $APP_DIR.prev"
