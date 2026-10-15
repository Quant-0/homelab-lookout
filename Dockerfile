# Homelab Lookout as a container image. Built by .github/workflows/docker.yml for amd64 and arm64.
# How to run it: docker-compose.yml and docs/getting-started/install-docker.md.
#
# The base image is pinned by digest, so a build uses exactly the Node.js and Alpine it was tested
# with; update the digest (and test) to move to a newer one.
FROM docker.io/library/node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

# openssl: the local CA and certificate on first start; iputils-ping: ping checks; rsync and
# openssh-client: backups to rsync over SSH; setpriv: dropping root after the first steps;
# tini: passes signals on and reaps child processes (started after the switch, as the app user)
RUN apk add --no-cache openssl iputils-ping rsync openssh-client setpriv tini \
 && addgroup -g 10001 lookout \
 && adduser -D -H -u 10001 -G lookout -s /sbin/nologin lookout \
 && mkdir -p /data /key /backups \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY server.js /app/server.js
COPY public /app/public
COPY deploy/docker/entrypoint.sh /usr/local/bin/lookout-entrypoint
COPY deploy/docker/healthcheck.js /app/healthcheck.js

# What Admin → Server shows: the commit this was built from, and when
ARG LOOKOUT_COMMIT=0000000000000000000000000000000000000000
ARG LOOKOUT_BUILT=
RUN printf '%s\n%s\n' "$LOOKOUT_COMMIT" "${LOOKOUT_BUILT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" > /app/VERSION \
 && chmod 0755 /usr/local/bin/lookout-entrypoint \
 && chmod -R a+rX,go-w /app

ENV LOOKOUT_CONTAINER=1 \
    DATA_DIR=/data \
    KEY_FILE=/key/secret.key \
    BACKUP_DIR=/backups \
    NODE_ENV=production

EXPOSE 8443 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["/usr/local/bin/lookout-entrypoint"]
