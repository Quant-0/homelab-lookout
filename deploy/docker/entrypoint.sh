#!/bin/sh
# Start of the Homelab Lookout container. As root (the default) it only:
#   1. picks the address to listen on (LOOKOUT_HOST, or this machine's first private IPv4),
#   2. creates /data and /key for the app user, 0700, and the encryption key (0600),
#   3. makes the local CA and the server certificate in /key/tls, like deploy/install.sh does
#      (the CA's key stays root's: the app can't read it),
# then runs the app as the app user (uid 10001, or LOOKOUT_UID) with no way back to root and no
# capabilities but NET_RAW (for ping). Started as another user (compose `user:`), it skips what
# needs root and runs as that user.
set -eu

DATA=${DATA_DIR:-/data}
KEYFILE=${KEY_FILE:-/key/secret.key}
KEYDIR=$(dirname "$KEYFILE")
TLS=$KEYDIR/tls
RUN_UID=${LOOKOUT_UID:-10001}
RUN_GID=${LOOKOUT_GID:-$RUN_UID}
say() { echo "lookout: $*"; }

# --- 1. the address --------------------------------------------------------------------------
private() {
  case "$1" in
    10.*|192.168.*|127.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
  esac
  return 1
}
if [ -n "${LOOKOUT_HOST:-}" ]; then
  HOST=$LOOKOUT_HOST
else
  # the first private IPv4 on a real network card (not Docker's, Podman's or a VPN bridge)
  HOST=$(ip -4 -o addr show scope global 2>/dev/null \
    | awk '$2 !~ /^(docker|br-|veth|cni|flannel|podman|virbr|lxc|tailscale|wg|zt)/ { split($4, a, "/"); print a[1] }' \
    | while read -r ip; do if private "$ip"; then echo "$ip"; break; fi; done)
  if [ -z "$HOST" ]; then
    say "could not find this machine's LAN address: set LOOKOUT_HOST to it (e.g. 192.168.1.20)"
    exit 1
  fi
  say "listening on $HOST (found by itself; set LOOKOUT_HOST to choose)"
fi
export HOST
NAMES=$(echo "${LOOKOUT_NAMES:-}" | tr ', ' '\n\n' | sed '/^$/d' | tr 'A-Z' 'a-z')
ALLOWED_HOSTS=$(printf '%s\n%s\n' "${ALLOWED_HOSTS:-}" "$NAMES" | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd, -)
export ALLOWED_HOSTS
export HTTPS_PORT=${LOOKOUT_HTTPS_PORT:-${HTTPS_PORT:-8443}}
export PORT=${LOOKOUT_HTTP_PORT:-${PORT:-8080}}
# for the health check, which doesn't get this script's environment
printf '%s %s %s\n' "$HOST" "$HTTPS_PORT" "$PORT" > /tmp/lookout-run 2>/dev/null || true

ROOT=0
[ "$(id -u)" = 0 ] && ROOT=1

# --- 2. folders and the key ------------------------------------------------------------------
if [ $ROOT = 1 ]; then
  mkdir -p "$DATA" "$KEYDIR"
  # the app owns its data; only changed when needed (a big history takes a while)
  if [ "$(stat -c %u "$DATA")" != "$RUN_UID" ] || [ -n "$(find "$DATA" ! -user "$RUN_UID" -print -quit 2>/dev/null)" ]; then
    chown -R "$RUN_UID:$RUN_GID" "$DATA"
  fi
  chmod 0700 "$DATA"
  # the key folder is root's; the app may read only its key and its certificate
  chown root:"$RUN_GID" "$KEYDIR"
  chmod 0750 "$KEYDIR"
  if [ ! -s "$KEYFILE" ]; then
    (umask 077; openssl rand -hex 32 > "$KEYFILE")
    say "made a new encryption key in $KEYFILE"
  fi
  chown "$RUN_UID:$RUN_GID" "$KEYFILE"
  chmod 0600 "$KEYFILE"
else
  RUN_UID=$(id -u)
  RUN_GID=$(id -g)
  for d in "$DATA" "$KEYDIR"; do
    [ -w "$d" ] || { say "$d is not writable for uid $RUN_UID: give the host folder to that user (chown $RUN_UID $d's host folder)"; exit 1; }
  done
fi

# --- 3. the local CA and the server certificate ----------------------------------------------
# The CA may only vouch for this network (/24), 127.0.0.1 and the names given, so even its key
# couldn't be used to pretend to be other sites. Names added later need a new CA: delete
# /key/tls/ca.* (devices then import the new CA once).
mkdir -p "$TLS"
SHORT=$(hostname -s 2>/dev/null || hostname)
case "$HOST" in
  *:*) IPC="" ;;
  *) IPC="permitted;IP:$(echo "$HOST" | awk -F. '{print $1"."$2"."$3".0"}')/255.255.255.0,permitted;IP:127.0.0.1/255.255.255.255," ;;
esac
DNSC="permitted;DNS:$SHORT,permitted;DNS:localhost"
for n in $NAMES; do DNSC="$DNSC,permitted;DNS:$n"; done
RENEW=0
if [ ! -f "$TLS/ca.key" ] || [ ! -f "$TLS/ca.crt" ]; then
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$TLS/ca.key" 2>/dev/null)
  cat > "$TLS/ca.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = Homelab Lookout local CA ($SHORT)
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,${IPC}${DNSC}
EOF
  openssl req -x509 -new -key "$TLS/ca.key" -sha256 -days 3650 -config "$TLS/ca.cnf" -out "$TLS/ca.crt" 2>/dev/null
  say "made a local CA: $TLS/ca.crt (SHA-256 $(openssl x509 -in "$TLS/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2))"
  RENEW=1
fi
for n in $NAMES; do
  grep -q "permitted;DNS:$n\(,\|$\)" "$TLS/ca.cnf" 2>/dev/null || say "warning: the CA was made without $n, so browsers won't accept it for that name. Delete $TLS/ca.* and restart to make a new CA."
done
SAN="IP:$HOST,DNS:$SHORT"
[ "$HOST" = 127.0.0.1 ] && SAN="$SAN,DNS:localhost"
for n in $NAMES; do SAN="$SAN,DNS:$n"; done
if [ ! -f "$TLS/server.crt" ] || ! openssl x509 -in "$TLS/server.crt" -noout -checkend 2592000 >/dev/null 2>&1 \
   || [ "$(cat "$TLS/server.san" 2>/dev/null)" != "$SAN" ]; then
  RENEW=1
fi
if [ $RENEW = 1 ]; then
  cat > "$TLS/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $SHORT
[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = $SAN
EOF
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$TLS/server.key" 2>/dev/null)
  openssl req -new -key "$TLS/server.key" -config "$TLS/server.cnf" -out "$TLS/server.csr" 2>/dev/null
  # 825 days: the longest Apple devices accept
  openssl x509 -req -in "$TLS/server.csr" -CA "$TLS/ca.crt" -CAkey "$TLS/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
    -days 825 -sha256 -extfile "$TLS/server.cnf" -extensions ext -out "$TLS/server.crt" 2>/dev/null
  rm -f "$TLS/server.csr"
  printf '%s\n' "$SAN" > "$TLS/server.san"
  say "issued the server certificate for $SAN"
fi
if [ $ROOT = 1 ]; then
  chown -R root:root "$TLS"
  chmod 0755 "$TLS"
  chmod 0600 "$TLS/ca.key"
  chown "$RUN_UID:$RUN_GID" "$TLS/server.key"
  chmod 0600 "$TLS/server.key"
  chmod 0644 "$TLS/ca.crt" "$TLS/server.crt"
fi
export TLS_CERT_FILE=$TLS/server.crt TLS_KEY_FILE=$TLS/server.key TLS_CA_FILE=$TLS/ca.crt

# --- start ----------------------------------------------------------------------------------
run() {
  if [ $ROOT = 1 ]; then
    # NET_RAW stays for ping when the container has it. Switching to the app user clears every
    # other capability, and no-new-privs keeps anything from bringing them back.
    BND=$(awk '/^CapBnd/ { print $2 }' /proc/self/status)
    if [ $(( 0x$BND >> 13 & 1 )) = 1 ]; then CAPS=+net_raw; else CAPS=; fi
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups \
      --inh-caps="-all${CAPS:+,$CAPS}" --ambient-caps="-all${CAPS:+,$CAPS}" \
      --no-new-privs /sbin/tini -s -- "$@"
  fi
  exec /sbin/tini -s -- "$@"
}
if [ "${LOOKOUT_RESET_NETWORK:-}" = 1 ]; then
  say "LOOKOUT_RESET_NETWORK=1: the web server goes back to the default ports. Remove the setting again afterwards."
  (cd /app && if [ $ROOT = 1 ]; then setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups --no-new-privs node /app/server.js reset-network; else node /app/server.js reset-network; fi)
fi
cd /app
run node /app/server.js
