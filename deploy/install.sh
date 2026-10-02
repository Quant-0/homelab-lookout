#!/bin/sh
# Install or update the homelab dashboard as a hardened systemd service.
# Run as root from the repository:
#
#   sudo sh deploy/install.sh [--host IP] [--port N] [--allowed-hosts a,b] [--reset-admin]
#                             [--renew-cert] [--low-ports | --no-low-ports] [--reset-network]
#
#   --port N         default HTTP port (8080). HTTPS defaults to 8443. Both can be changed in Admin.
#   --renew-cert     issue a new server certificate now (it is also renewed automatically
#                    30 days before it expires, and when --host changes)
#   --low-ports      allow ports below 1024 (e.g. 443/80) by granting CAP_NET_BIND_SERVICE
#   --reset-network  set HTTP/HTTPS back to the default ports (if you locked yourself out)
#
# Review the code before running: whatever is installed runs with access to your secrets.
set -eu

SERVICE=homelab-dashboard
SVC_USER=homelab-dash
APP_DIR=/opt/homelab-dashboard
ETC_DIR=/etc/homelab-dashboard
TLS_DIR=$ETC_DIR/tls
DATA_DIR=/var/lib/homelab-dashboard
DROPIN_DIR=/etc/systemd/system/$SERVICE.service.d
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)

HOST=""
PORT=""
ALLOWED=""
RESET_ADMIN=0
RENEW_CERT=0
LOW_PORTS=""
RESET_NETWORK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --allowed-hosts) ALLOWED=$2; shift 2 ;;
    --reset-admin) RESET_ADMIN=1; shift ;;
    --renew-cert) RENEW_CERT=1; shift ;;
    --low-ports) LOW_PORTS=on; shift ;;
    --no-low-ports) LOW_PORTS=off; shift ;;
    --reset-network) RESET_NETWORK=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

# --- Packages ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)')" -lt 18 ]; then
  echo "Installing Node.js from Debian..."
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
[ -x /usr/bin/node ] || { echo "/usr/bin/node not found" >&2; exit 1; }
for pkg in openssl rsync; do
  command -v "$pkg" >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq "$pkg"; }
done
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

OLD_HOST=""
[ -f "$ETC_DIR/env" ] && OLD_HOST=$(sed -n 's/^HOST=//p' "$ETC_DIR/env")
if [ ! -f "$ETC_DIR/env" ] || [ -n "$HOST$PORT$ALLOWED" ]; then
  if [ -z "$HOST" ]; then
    if [ -n "$OLD_HOST" ]; then HOST=$OLD_HOST; else
      printf "Address to listen on (127.0.0.1 or this VM's internal IP) [127.0.0.1]: "
      read -r HOST
      HOST=${HOST:-127.0.0.1}
    fi
  fi
  case "$HOST" in 0.0.0.0|::|"") echo "Refusing to listen on all interfaces." >&2; exit 1 ;; esac
  [ -z "$ALLOWED" ] && [ -f "$ETC_DIR/env" ] && ALLOWED=$(sed -n 's/^ALLOWED_HOSTS=//p' "$ETC_DIR/env")
  [ -z "$PORT" ] && [ -f "$ETC_DIR/env" ] && PORT=$(sed -n 's/^PORT=//p' "$ETC_DIR/env")
  (umask 022; cat > "$ETC_DIR/env" <<EOF
HOST=$HOST
PORT=${PORT:-8080}
HTTPS_PORT=8443
ALLOWED_HOSTS=$ALLOWED
EOF
)
fi
grep -q '^HTTPS_PORT=' "$ETC_DIR/env" || echo "HTTPS_PORT=8443" >> "$ETC_DIR/env"
HOST=$(sed -n 's/^HOST=//p' "$ETC_DIR/env")

# --- Local CA and server certificate ------------------------------------------
# The CA is name-constrained to this VM (its /24 network, 127.0.0.1 and its host names), so
# even a leaked CA key could not be used to impersonate other sites. CA key: root only.
install -d -o root -g root -m 0700 "$TLS_DIR"
SHORT=$(hostname -s)
FQDN=$(hostname -f 2>/dev/null || hostname)
case "$HOST" in
  *:*) IP_CONSTRAINTS="" ;; # IPv6: IP names left unconstrained
  *) NET=$(echo "$HOST" | awk -F. '{print $1"."$2"."$3".0"}')
     IP_CONSTRAINTS="permitted;IP:$NET/255.255.255.0,permitted;IP:127.0.0.1/255.255.255.255," ;;
esac
if [ ! -f "$TLS_DIR/ca.key" ]; then
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$TLS_DIR/ca.key" 2>/dev/null)
  cat > "$TLS_DIR/ca.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = Homelab dashboard local CA ($SHORT)
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,${IP_CONSTRAINTS}permitted;DNS:$SHORT,permitted;DNS:$FQDN,permitted;DNS:localhost
EOF
  openssl req -x509 -new -key "$TLS_DIR/ca.key" -sha256 -days 3650 -config "$TLS_DIR/ca.cnf" -out "$TLS_DIR/ca.crt"
  echo "Created local CA $TLS_DIR/ca.crt"
  RENEW_CERT=1
fi
if [ ! -f "$TLS_DIR/server.crt" ] || ! openssl x509 -in "$TLS_DIR/server.crt" -noout -checkend 2592000 >/dev/null 2>&1 \
   || ! openssl x509 -in "$TLS_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$HOST\b"; then
  RENEW_CERT=1
fi
if [ "$RENEW_CERT" = 1 ]; then
  SAN="IP:$HOST,DNS:$SHORT,DNS:$FQDN"
  [ "$HOST" = "127.0.0.1" ] && SAN="$SAN,DNS:localhost"
  cat > "$TLS_DIR/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $FQDN
[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $SAN
EOF
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$TLS_DIR/server.key" 2>/dev/null)
  openssl req -new -key "$TLS_DIR/server.key" -config "$TLS_DIR/server.cnf" -out "$TLS_DIR/server.csr"
  # 825 days: the maximum Apple devices accept for TLS server certificates
  openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
    -days 825 -sha256 -extfile "$TLS_DIR/server.cnf" -extensions ext -out "$TLS_DIR/server.crt" 2>/dev/null
  rm -f "$TLS_DIR/server.csr"
  echo "Issued server certificate for $SAN"
fi
chown -R root:root "$TLS_DIR"
chmod 0600 "$TLS_DIR/ca.key" "$TLS_DIR/server.key"
chmod 0644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"

# --- State directory and backup folder ---------------------------------------
# Mount a NAS share on /var/backups/homelab-dashboard (owned by the service user) for folder backups
install -d -o root -g root -m 0755 /var/backups
[ -d /var/backups/homelab-dashboard ] || install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 /var/backups/homelab-dashboard
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$DATA_DIR"
chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
chmod 0700 "$DATA_DIR"

# --- systemd unit -----------------------------------------------------------
install -o root -g root -m 0644 "$SRC_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
if [ "$LOW_PORTS" = on ]; then
  install -d -m 0755 "$DROPIN_DIR"
  printf '[Service]\n# Allows ports below 1024 (e.g. 443). Added by install.sh --low-ports\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n' > "$DROPIN_DIR/low-ports.conf"
  echo "Ports below 1024 allowed"
elif [ "$LOW_PORTS" = off ]; then
  rm -f "$DROPIN_DIR/low-ports.conf"
fi
systemctl daemon-reload

# --- Admin account ----------------------------------------------------------
if [ ! -f "$DATA_DIR/admin.json" ] || [ "$RESET_ADMIN" = 1 ]; then
  printf "Admin username [admin]: "
  read -r ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}
  runuser -u "$SVC_USER" -- env DATA_DIR="$DATA_DIR" /usr/bin/node "$APP_DIR/server.js" set-admin "$ADMIN_USER"
fi

if [ "$RESET_NETWORK" = 1 ]; then
  systemctl stop "$SERVICE" || true
  runuser -u "$SVC_USER" -- env DATA_DIR="$DATA_DIR" PORT="$(sed -n 's/^PORT=//p' "$ETC_DIR/env")" /usr/bin/node "$APP_DIR/server.js" reset-network
fi

systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 1
systemctl --no-pager --lines=5 status "$SERVICE" || true

echo
echo "Permissions:"
ls -ld "$DATA_DIR" "$ETC_DIR" "$ETC_DIR/secret.key" "$TLS_DIR" "$TLS_DIR/ca.key"
echo
echo "Local CA fingerprint (compare when importing): $(openssl x509 -in "$TLS_DIR/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
echo "Server certificate valid until: $(openssl x509 -in "$TLS_DIR/server.crt" -noout -enddate | cut -d= -f2)"
echo
echo "Dashboard: https://$HOST:8443/  (ports can be changed in Admin → Dashboard → Web server)"
echo "Import the CA once on each device: download it from http://$HOST:$(sed -n 's/^PORT=//p' "$ETC_DIR/env")/ca.crt or https://$HOST:8443/ca.crt"
