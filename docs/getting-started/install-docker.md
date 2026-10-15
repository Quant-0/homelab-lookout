# Install with Docker

Homelab Lookout as a container: with Docker Compose, or as a **Portainer stack**, with nothing to set up on the server by hand. Prefer a plain service without containers? See [Install directly on Linux](install-linux.md).

## What you need

- **Linux with Docker 24 or newer** (Docker Compose v2 is included), or Portainer on such a machine, or Podman. Both **amd64** (PCs, servers, VMs) and **arm64** (Raspberry Pi 4/5, 64-bit OS) work.
- About 150 MB of memory and 300 MB of disk, plus what history and backups grow to.
- Lookout uses the **host's network** (see [Why the host network](#why-the-host-network)). That works on Linux, including Synology's Container Manager and Unraid. It doesn't work in Docker Desktop on Mac or Windows.

## 1. The image

The image is public on GitHub's container registry: `ghcr.io/quant-0/homelab-lookout`. Docker, Portainer and Podman pull it without any login or token.

| Tag | What |
|---|---|
| `:latest` | The newest **release** (what the compose file uses) |
| `:1.2.3`, `:1.2` | One release, or the newest of its 1.2 line |
| `:edge` | The newest change on `main`, before it is released: for trying things out |
| `:sha-<commit>` | One exact build |

Each image is built by GitHub Actions from this repository, and comes with a signed build attestation. With the GitHub CLI you can check that an image really was built here, from this repository's code:

```sh
gh attestation verify oci://ghcr.io/quant-0/homelab-lookout:latest -R Quant-0/homelab-lookout
```

## 2. Deploy it

The compose file is [`docker-compose.yml`](../../docker-compose.yml) in the repository. The same file works both ways:

- **Portainer:** *Stacks → Add stack*. Name it `lookout`, choose *Web editor*, paste the file, and **Deploy the stack**.
- **Docker Compose:** download it into a folder of its own, and start it there:
  ```sh
  mkdir -p /opt/lookout && cd /opt/lookout
  curl -fsSLO https://raw.githubusercontent.com/Quant-0/homelab-lookout/main/docker-compose.yml
  docker compose up -d
  ```

The parts you may want to change before the first start:

```yaml
    environment:
      LOOKOUT_HOST: ""          # the server's LAN address, e.g. 192.168.1.20
      LOOKOUT_NAMES: ""         # more names for the certificate, e.g. lookout.home.arpa
      LOOKOUT_HTTPS_PORT: "8443"
      LOOKOUT_HTTP_PORT: "8080"
    volumes:
      - /opt/lookout/data:/data
      - /opt/lookout/key:/key
```

| Setting | Meaning |
|---|---|
| `LOOKOUT_HOST` | The address Lookout listens on, and the one its certificate is made for. Empty: the host's first private address on a real network card (Docker's and VPN interfaces are skipped). Set it when the server has more than one, so the right one is used. |
| `LOOKOUT_NAMES` | Extra DNS names for the dashboard's own certificate, comma-separated. They also go into the local CA, so set them **before the first start** (see [Certificates](#certificates)). Not needed when a reverse proxy provides the certificate. |
| `LOOKOUT_HTTPS_PORT`, `LOOKOUT_HTTP_PORT` | The ports on the first start. Change them later in **Admin → Server → Web server**. Use ports from 1024 up; for 443, put a reverse proxy in front. |
| `ALLOWED_HOSTS` | More host names the dashboard answers on (rarely needed: the *Dashboard address* set in Admin and `LOOKOUT_NAMES` are added by themselves). |
| `LOOKOUT_RESET_NETWORK=1` | Puts the web server back on the default ports, if a port change locked you out. Start once with it, then remove it. |
| `LOOKOUT_UID`, `LOOKOUT_GID` | Run as another uid and gid than 10001 (see [Folders and permissions](#folders-and-permissions)). |

## 3. The first start

Open the container's log: in Portainer, *Containers → lookout → Logs*, or `docker logs lookout`. It shows:

```
lookout: listening on 192.168.1.20 (found by itself; set LOOKOUT_HOST to choose)
lookout: made a new encryption key in /key/secret.key
lookout: made a local CA: /key/tls/ca.crt (SHA-256 A5:45:B0:…)
lookout: issued the server certificate for IP:192.168.1.20,DNS:myserver

  No admin account yet. Open https://192.168.1.20:8443/setup
  and enter this setup code: TFCJT-75SQX
  (it changes on every restart)
```

1. Open the address. The browser warns about the certificate, because it is the dashboard's own; continue this once.
2. On **Create the admin account**, enter the setup code, a user name and a password of at least 12 characters.
3. You are signed in and in Admin. The setup page is gone for good.

The setup code is there so that nobody else on your network can claim the dashboard between its start and your first visit: only someone who can read the server's logs has it.

Then go on with [First steps](first-steps.md): importing the CA so the warning goes away, installing the app, and adding devices.

## Folders and permissions

Everything Lookout keeps lives in two host folders. Everything else is thrown away on each update.

| Host folder | In the container | Holds |
|---|---|---|
| `/opt/lookout/data` | `/data` | Settings, devices and their (encrypted) passwords, history, energy, the Log, incidents, docs, sign-ins and passkeys, uploaded images, local backup copies |
| `/opt/lookout/key` | `/key` | The encryption key (`secret.key`), the local CA and the server certificate (`tls/`) |
| *(optional)* a NAS share | `/backups` | Folder backups (Admin → Backups → Folder) |

**Why two folders?** Every password Lookout stores for your devices is encrypted with the key. If you copy, back up or sync the data folder on its own, the copy can't be decrypted without the key. So keep the key folder out of the same file backup. You don't need it for Lookout's own backups (Admin → Backups), which are encrypted with their own passphrase and restore anywhere.

**Who owns what.** You don't have to prepare the folders: Docker creates them, and on each start the container:

- gives the data folder to its user, uid 10001, with mode `0700`;
- makes the key folder root's (`0750`), with `secret.key` (`0600`) readable only by the app;
- keeps the CA's private key root's (`0600`), so the app itself can't read it.

Only after that does it switch to uid 10001 for good.

**A NAS share, or a host where root can't change owners** (NFS with root squash, for example):

- either give the folders to uid 10001 on the NAS;
- or run the container as a user that already owns them. Add `user: "1000:1000"` (that user's uid and gid) to the service in the compose file. The steps that need root are then skipped, and the CA key belongs to that user.

**Podman** (rootless or not) doesn't create missing folders: make them first with `mkdir -p /opt/lookout/data /opt/lookout/key`.

## Why the host network

With Docker's default bridge network, Lookout would sit on a private network inside Docker. Then:

- **Find devices** would only see Docker's own network, not your LAN.
- **The sign-in lockout and the Log** would see Docker's address for every visitor, not the real one.
- **SNMP traps and replies, ping and the UniFi discovery** would all go through Docker's address translation.

With `network_mode: host` it is on your LAN like any program on the server. In return, it shares the server's network cards. So Lookout listens only on `LOOKOUT_HOST` (or the address it found), never on all of them, and it refuses public addresses.

## How it is protected

What the container adds to [Lookout's own security](../configuration/security.md):

| | |
|---|---|
| **Not root** | Lookout runs as uid 10001. Root is only used for a moment at start (folders, key, certificate), then given up for good (`setpriv`, `no-new-privileges`) |
| **Capabilities** | All are dropped. The compose file adds back only what the first seconds need (`CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `SETUID`, `SETGID`), and the running app keeps only `NET_RAW`, for ping |
| **Read-only image** | `read_only: true`: only `/data`, `/key` and a small `/tmp` in memory can be written, so nothing can change the program |
| **No secrets in the stack** | The compose file holds no passwords or keys. That matters, because Portainer shows a stack's settings to everyone who can open it |
| **No Docker socket** | Lookout never gets the socket. To show containers, it reads Docker through a read-only socket proxy, as it always has (see [VMs and containers](../features/vms-and-containers.md)) |
| **What's in the image** | Node.js 24 on Alpine Linux (pinned to an exact image), plus `openssl`, `ping`, `rsync`, `ssh`, `setpriv` and `tini`. Lookout has no npm packages, so there is no third-party JavaScript in it |
| **Where it is built** | By GitHub Actions from this repository on every merge to `main`. Every pull request first builds it for amd64 and arm64 and starts it the way the compose file does, with checks (`test/container.smoke.js`) |

What Docker can't protect against: anyone who is root on the host, or in its `docker` group (which amounts to the same), can read both folders, the key included. Keep that group, and access to Portainer, to people you would trust with the server itself.

## Certificates

The first start makes a **local CA**, valid 10 years, and a server certificate, valid 825 days, the most Apple devices accept, in `/key/tls`.

- The CA may only vouch for this server's `/24` network, `127.0.0.1`, the host's name and the names in `LOOKOUT_NAMES`. So even someone with its key couldn't impersonate other sites.
- The server certificate is renewed on start when less than 30 days are left, or when the address or names changed.
- **A name added later** isn't in the CA. The log then warns that browsers won't accept the certificate for that name.
  - To fix it: delete `ca.*` in the key folder's `tls/` and restart. The devices that imported the old CA then import the new one, once.
  - Or use a [reverse proxy](reverse-proxy.md) with a public certificate for names, which is what most people do.
- Download the CA in **Admin → Server → Certificate**. The fingerprint in the log is what to compare when importing it.

## Updating

A new **release** is published as `:latest` (and `:1.2.3`). **Updates** in the dashboard says when there is one, with what's new and these steps:

- **Portainer:** *Stacks → lookout → Editor → Update the stack*, with **Re-pull image and redeploy** on.
- **Docker Compose:** `docker compose pull && docker compose up -d` in the compose file's folder.
- **To stay on a version,** use `image: ghcr.io/quant-0/homelab-lookout:1.2.3` instead of `:latest`. **Admin → Server** shows the version, commit and build time of the running image.

Your data and settings are kept. A new image never changes the folders, apart from fixing their owners.

Watchtower can update it automatically. Updating by hand lets you read what changed first.

## Everyday tasks

| Task | How |
|---|---|
| See the log | Portainer: the container → *Logs*; or `docker logs -f lookout` |
| Reset the admin password | `docker exec -it -u 10001 lookout node /app/server.js set-admin admin`, then restart the container. The `-u 10001` matters: as root the file would be root's, and Lookout couldn't read it |
| Locked out by a port change | Add `LOOKOUT_RESET_NETWORK: "1"`, redeploy, remove it again |
| Back up | **Admin → Backups**: encrypted files, locally and to a NAS, S3 or rsync. Keep a copy of the key folder somewhere safe and separate, for restoring the data folder itself |
| Move to another server | Copy both folders over (or use Admin → Backups → Restore), then deploy the same stack there |
| From the Linux install to Docker | On the old one: **Admin → Backups → Download now**. Deploy the stack, create the admin, then **Restore** the file there (tick *Also restore the admin login*) |

## Troubleshooting

| What you see | What to do |
|---|---|
| `could not find this machine's LAN address` | Set `LOOKOUT_HOST` to the server's LAN IP |
| `HOST … is not a loopback/private address` | `LOOKOUT_HOST` must be a private address (10.x, 172.16–31.x, 192.168.x, 100.64–127.x for Tailscale) |
| `EADDRINUSE` in the log | Another program uses 8443 or 8080: change `LOOKOUT_HTTPS_PORT` / `LOOKOUT_HTTP_PORT` before the first start, or in Admin later |
| `… is not writable for uid …` | With `user:` set, the host folders must belong to that user (`chown -R 1000:1000 /opt/lookout`) |
| `pull access denied` / `manifest unknown` | Check the image name: `ghcr.io/quant-0/homelab-lookout:latest` (all lowercase) |
| Ping checks always fail | The container needs `NET_RAW` (in `cap_add`) |
| The container is *unhealthy* | Its health check calls the dashboard on its own address; look at the log for why it isn't answering |

More in [Troubleshooting](../troubleshooting.md).
