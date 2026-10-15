# Install directly on Linux

Homelab Lookout as a hardened **systemd service** on a Debian or Ubuntu machine: no Docker, and the installer sets up everything. Prefer containers? See [Install with Docker](install-docker.md). Not sure which? [Installation](installation.md) compares the two.

## Requirements

- **Debian 12/13 or Ubuntu 22.04+** (anything with systemd and apt works), on a VM, an LXC container or a Raspberry Pi. It needs very little: about 100 MB of memory.
- A **private address** for the dashboard to listen on (for example `192.168.1.20`), or `127.0.0.1` behind a proxy on the same machine. It refuses to listen on `0.0.0.0` or a public address.
- **Node.js 18 or newer**, with a release that still gets security fixes (Node 24 LTS recommended; graph history is kept in SQLite from 22.5). The installer adds Node.js 24 from NodeSource if the system's own is older than 22.
- Network access from the dashboard to your devices (management controllers, Proxmox, NAS, UniFi console…).

There are no npm packages to install and no build step.

## Install

```sh
git clone https://github.com/<you>/homelab-lookout.git
cd homelab-lookout
sudo sh deploy/install.sh --host 192.168.1.20
```

The installer:

1. installs `nodejs` (24 LTS from NodeSource when needed) and `openssl`;
2. creates the `homelab-dash` system user (no shell, no home);
3. copies the app to `/opt/homelab-dashboard` (root-owned, read-only for the service);
4. generates the encryption key in `/etc/homelab-dashboard/secret.key`;
5. creates a **local certificate authority** and a server certificate for the address and the machine's names;
6. asks for the admin user name and a password (at least 12 characters);
7. installs and starts `homelab-dashboard.service`.

It prints the address and the CA's fingerprint. Open `https://192.168.1.20:8443` and go on with [First steps](first-steps.md).

If no admin account was made (the installer was run without a terminal, for example), the first page you open is **Create the admin account**. It asks for a one-time setup code, which the service writes to its log: `sudo journalctl -u homelab-dashboard | grep "setup code"`. The code changes on every restart and stops working once the account exists. `node server.js set-admin` works too.

## Installer options

| Option | What it does |
|---|---|
| `--host ADDRESS` | The private address to listen on (or `127.0.0.1`) |
| `--port N` | The HTTP port (default 8080; HTTPS is 8443). Both can be changed later in Admin |
| `--allowed-hosts a,b` | Extra host names to answer on |
| `--reset-admin` | Set a new admin password (signs everyone out) |
| `--renew-cert` | Issue a new server certificate now. It is also renewed when less than 30 days are left, or when `--host` changes |
| `--low-ports` / `--no-low-ports` | Allow ports below 1024 (like 443) for the service, or take that away |
| `--reset-network` | Put HTTP and HTTPS back on the default ports if a port change locked you out |
| `--allow-deploy USER` / `--no-allow-deploy` | Let USER deploy new versions without full sudo (see [Updating](updating.md)) |

Run the installer again at any time; it keeps your data and settings.

## Where things live

| What | Where |
|---|---|
| The program | `/opt/homelab-dashboard` (`VERSION` says which commit runs) |
| Data: settings, encrypted secrets, docs, history, incidents | `/var/lib/homelab-dashboard` (service user only, 0700) |
| Encryption key, environment, certificates | `/etc/homelab-dashboard` (root only) |
| Backups to a mounted share | `/var/backups/homelab-dashboard` |
| Logs | `journalctl -u homelab-dashboard` |

## Ports

By default the dashboard listens on **HTTPS 8443** and **HTTP 8080**, where HTTP only redirects to HTTPS (except check-ins, which also work over plain HTTP). Change them in **Admin → Server → Web server**. A new port is opened before the old one is closed, so a port that can't be used never takes the dashboard offline.

## Running it by hand (development)

```sh
DATA_DIR=/tmp/lookout-data HOST=127.0.0.1 PORT=8080 node server.js set-admin admin
DATA_DIR=/tmp/lookout-data HOST=127.0.0.1 PORT=8080 node server.js
```

`DATA_DIR` must be outside the repository; the key is then generated as `$DATA_DIR/secret.key`. See [Development](../development.md).

## Environment settings

`/etc/homelab-dashboard/env` (read by the service) can hold:

| Variable | Meaning |
|---|---|
| `HOST`, `PORT`, `HTTPS_PORT` | Where to listen (normally set by the installer and Admin) |
| `ALLOWED_HOSTS` | Extra host names the dashboard answers on, comma-separated (the *Dashboard address* in Admin is added by itself) |
| `COOKIE_SECURE=1` | Mark cookies secure even over HTTP (behind a TLS proxy on the same machine) |
| `HISTORY_JSON=1` | Keep graph history in `history.json` instead of SQLite |
| `OPEN_LIMIT_PER_MIN` | Requests per address and minute for what answers without a sign-in (default 120) |
