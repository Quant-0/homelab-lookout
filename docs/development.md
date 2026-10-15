# Development and tests

## Layout

```
server.js              everything on the server: collectors, alerts, history, API, pages (one file)
public/                pages (*.html), styles (css/), scripts (js/), fonts, icons, the agent (agent/)
deploy/                install.sh, the deploy command, the systemd unit, homelab-pkg
deploy/docker/         the container's entrypoint.sh and healthcheck.js
Dockerfile             the image; docker-compose.yml runs it (also as a Portainer stack)
.github/workflows/     docker.yml: tests the image on pull requests, publishes it on merges
docs/                  this documentation; docs/guide is the PDF guide's source
test/                  run.js (the runner), *.test.js (API suites), ui/*.ui.js (browser suites), mocks/
```

No npm packages and no build step: `server.js` uses only Node's built-in modules, and the pages are plain HTML, CSS and JavaScript. DOM is always built with `textContent` and attributes, never `innerHTML`.

## Running it

```sh
DATA_DIR=/tmp/lookout-data HOST=127.0.0.1 PORT=8080 node server.js set-admin admin
DATA_DIR=/tmp/lookout-data HOST=127.0.0.1 PORT=8080 node server.js
```

`DATA_DIR` must be outside the repository.

## Tests

```sh
node test/run.js              # the API suites, including the security sweep
node test/run.js --ui         # also the browser suites (needs Playwright)
node test/run.js --only agent # only suites whose file name contains "agent"
node test/run.js --verbose    # print every check
```

The runner makes a throwaway certificate, starts mock devices (Redfish, Proxmox, TrueNAS, UniFi OS, Omada, NUT) and mock service APIs (all integrations), and runs each suite against its own fresh server and data folder. The SNMPv3 suite runs against a real `snmpd` if installed (`SNMPD=/path/to/snmpd`), and the rsync suite needs `rsync` and `sshd`. About 1,500 checks in all.

### The container image

```sh
docker build -t lookout:test .
sudo node test/container.smoke.js lookout:test                 # or, rootless:
podman build --format docker -t localhost/lookout:test . && ENGINE=podman node test/container.smoke.js localhost/lookout:test
```

`test/container.smoke.js` starts the image the way `docker-compose.yml` does (host network on 127.0.0.1:18443, read-only, the same capabilities) and checks:

- who runs what (uid 10001, only `NET_RAW`, no-new-privs) and the folders' owners and modes;
- the setup page and its code; that it survives a restart; resetting the admin password with `docker exec`;
- that a copy of the data folder without the key can't decrypt the stored passwords;
- that it runs as another user given with `--user`.

GitHub Actions runs it on every pull request (`.github/workflows/docker.yml`), after building for amd64 and arm64.

The **security sweep** (`test/security.test.js`) reads every route from `server.js` and checks each one as a stranger, as a view-only device, and without a CSRF token or from another site. A new route must be added to its list, or the test says so.

## The PDF guide

```sh
node docs/guide/shots.js "$PWD/docs/guide/img" "$(cat logo.svg)"   # screenshots of a sample lab on port 18080
node docs/guide/pdf.js "$PWD/docs/guide/guide.html" public/guide/homelab-lookout-guide.pdf
```

Both need Playwright with Chromium. The screenshots come from a lab of mock devices and sample names, never real data.

## Sample data

Everything in this repository uses sample names and addresses: `192.168.1.x` and `192.168.2.x`, `example.com`, servers called *atlas*, *vault*, *titan* and *orion*. Keep it that way.
