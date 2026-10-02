#!/bin/sh
# Install or update the homelab dashboard as a hardened systemd service.
# Run as root from the repository:  sudo sh deploy/install.sh [--host IP] [--port N] [--allowed-hosts a,b] [--reset-admin]
#
# Review the code before running: whatever is installed runs with access to your secrets.
set -eu

SERVICE=homelab-dashboard
SVC_USER=homelab-dash
APP_DIR=/opt/homelab-dashboard
ETC_DIR=/etc/homelab-dashboard
DATA_DIR=/var/lib/homelab-dashboard
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

HOST=""
PORT=""
ALLOWED=""
RESET_ADMIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --allowed-hosts) ALLOWED=$2; shift 2 ;;
    --reset-admin) RESET_ADMIN=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

# --- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)')" -lt 18 ]; then
  echo "Installing Node.js from Debian..."
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
[ -x /usr/bin/node ] || { echo "/usr/bin/node not found" >&2; exit 1; }
echo "Node.js $(/usr/bin/node --version)"

# --- Service user (no shell, no home, not in any extra group) --------------
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  echo "Created system user $SVC_USER"
fi

# --- Application code: owned by root, read-only for the service ------------
install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/public" "$APP_DIR/public/css" "$APP_DIR/public/js"
install -o root -g root -m 0644 "$SRC_DIR/server.js" "$APP_DIR/server.js"
for f in login.html dashboard.html admin.html services.html docs.html favicon.svg css/style.css js/common.js js/login.js js/layout.js js/rack.js js/dashboard.js js/admin.js js/services.js js/docs.js js/markdown.js; do
  install -o root -g root -m 0644 "$SRC_DIR/public/$f" "$APP_DIR/public/$f"
done

# --- Config and key: root only. The key reaches the service via LoadCredential=
install -d -o root -g root -m 0700 "$ETC_DIR"
if [ ! -f "$ETC_DIR/secret.key" ]; then
  (umask 077; /usr/bin/node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex')+'\n')" > "$ETC_DIR/secret.key")
  echo "Generated encryption key $ETC_DIR/secret.key"
fi
chown root:root "$ETC_DIR/secret.key"
chmod 0600 "$ETC_DIR/secret.key"

if [ ! -f "$ETC_DIR/env" ] || [ -n "$HOST$PORT$ALLOWED" ]; then
  if [ -z "$HOST" ]; then
    printf "Address to listen on (127.0.0.1 or this VM's internal IP) [127.0.0.1]: "
    read -r HOST
    HOST=${HOST:-127.0.0.1}
  fi
  case "$HOST" in 0.0.0.0|::|"") echo "Refusing to listen on all interfaces." >&2; exit 1 ;; esac
  (umask 022; cat > "$ETC_DIR/env" <<EOF
HOST=$HOST
PORT=${PORT:-8080}
ALLOWED_HOSTS=$ALLOWED
EOF
)
fi

# --- State directory --------------------------------------------------------
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 0700 "$DATA_DIR"

# --- systemd unit -----------------------------------------------------------
install -o root -g root -m 0644 "$SRC_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload

# --- Admin account ----------------------------------------------------------
if [ ! -f "$DATA_DIR/admin.json" ] || [ "$RESET_ADMIN" = 1 ]; then
  printf "Admin username [admin]: "
  read -r ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}
  runuser -u "$SVC_USER" -- env DATA_DIR="$DATA_DIR" /usr/bin/node "$APP_DIR/server.js" set-admin "$ADMIN_USER"
fi

systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 1
systemctl --no-pager --lines=5 status "$SERVICE" || true

echo
echo "Permissions:"
ls -ld "$DATA_DIR" "$ETC_DIR" "$ETC_DIR/secret.key"
. "$ETC_DIR/env"
echo
echo "Dashboard: http://$HOST:${PORT:-8080}/"
