# Homelab dashboard

A dashboard for Dell iDRAC (Redfish), Proxmox VE and TrueNAS, with estimates and logs of power cost for Norway (spot price or Norgespris, plus grid tariff).

It is built from one Node.js server file (`server.js`, Node 18+) plus static HTML/CSS/JS in `public/`. There are no npm dependencies.

## What it shows

- **iDRAC**: power draw (W), PSU status, temperatures, and fans. Each fan spins at a rate proportional to its RPM (6000 rpm = 1 rotation/s).
- **Proxmox**: nodes (CPU, memory, root disk, uptime) on the Overview; VMs/containers with their status on the Services page.
- **TrueNAS**: system info, pools (usage, health) and active alerts. It uses JSON-RPC 2.0 over WebSocket (`wss://host/api/current`) and requires TrueNAS 25.04 or newer.
- **Synology** (any DSM model, via SNMPv3): temperature, system/fan/power status, CPU/RAM, volumes, storage pools, and disks with health and temperature.
- **UniFi** (UniFi OS consoles such as the UDM Pro): WAN/internet status, clients, and every adopted device (gateway, switches, APs) with CPU/RAM, temperatures, PoE per port and uptime.
- **Devices**: everything is organised around physical devices (server, NAS, switch, patch panel…).
  - A device has a name, a type, a place in the rack and its monitoring connections. E.g. "Orion" = iDRAC + Proxmox node, all added in one form, with **Test** before saving.
  - The dashboard shows one widget per device, with a section per connection.
  - Switches and access points found through a UniFi console appear as devices automatically. Deleting one hides it; it isn't re-created.
- **Rack**: the right third of the dashboard shows your rack (1–60 U) with live faceplates:
  - switch ports lit by link and PoE, NAS bays by disk health, and servers with status LEDs and watts;
  - click a device to jump to its widget; devices outside the rack (e.g. access points) are listed below it.
  - Edit it in Admin → Devices: drag to move, double-click an empty U to add.
- **Services** tab on the dashboard (Homepage-style): grouped cards with icon, link, live status (up/down; response time on hover) and up to 4 numbers from the app.
  - Proxmox **VMs and containers** are listed here too, with CPU, memory and uptime. The Overview keeps each node's health and links here.
  - **Customize** (as admin): drag services between groups and groups up or down, rename groups, set the number of columns per group, and hide services. Keyboard: focus a service and use the arrow keys.
  - 28 integrations: Jellyfin, Emby, Plex, Tautulli, Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, Overseerr/Jellyseerr, qBittorrent, Transmission, SABnzbd, Pi-hole (v5/v6), AdGuard Home, Nginx Proxy Manager, Traefik, Home Assistant, Nextcloud, Immich, Paperless-ngx, Uptime Kuma, Grafana, Portainer, Speedtest Tracker, Prometheus, authentik, plus **Custom JSON API** for anything else.
  - Icons come from the [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) library (downloaded once by the server and served locally) or are uploaded.
- **Docs** tab (always requires login, even with a public dashboard), edited in place:
  - Server sheets: automatic facts (model, service tag, CPU/RAM, PSUs, disks, VMs, rack position, management IPs, switch port) plus your notes.
  - Network plan: networks and IP reservations, importable from UniFi, plus the live UniFi client list.
  - Switch ports: what is connected to each port.
  - Topology diagram drawn from UniFi uplinks.
  - Your own Markdown pages.
  - The menu has collapsible groups (remembered per browser). With **Edit menu** you create, rename and reorder groups and drag sheets and pages between them (or use the arrow keys). Network stays its own group.
  - Not meant for passwords: link to your password manager instead.
- **History graphs**: small graphs in the widgets and service cards, with the value and time on hover and a **24 h / 7 d / 30 d** choice in the top bar (remembered per browser).
  - Recorded: total measured power; iDRAC watts, inlet and hottest temperature; Proxmox node CPU and memory; Synology temperature, CPU and memory; TrueNAS load; UniFi device CPU, temperature, clients and PoE draw.
  - Stored in `history.json` in the data directory: 1-minute averages for 25 hours, 15-minute averages for 8 days, 2-hour averages for 92 days. That's roughly 75 kB per graph once full. Graphs for removed devices are dropped after 30 days.
  - Only numbers are kept (no names or addresses). The graphs follow the dashboard's visibility: they need login unless the dashboard is public.
- **Alerts** (Admin → Alerts): messages to **ntfy**, **Telegram**, **Discord** and **e-mail (SMTP)**. You can add several channels of each kind and tick which alerts go to which channel.
  - Alerts: device offline, service down, hardware fault (PSUs, fans, system health), storage problem (degraded pools, failing disks), high temperature, storage almost full, TrueNAS alerts, high power draw (off by default), and failed automatic backups.
  - Each alert has a *wait* time, so short blips stay quiet. A message is also sent when the problem clears, and optionally a reminder while it lasts. Several alerts at once go out as one message per channel, with at most 30 messages per channel per hour.
  - When a host stops answering, its other alerts (e.g. a degraded pool) are kept as they are, not reported as resolved. Deleting a device drops its alerts without a "resolved" message.
  - Tokens, passwords and webhook URLs are encrypted and write-only, like device credentials, and bound to where they are sent: changing the server or user without retyping deletes them.
  - E-mail uses TLS or STARTTLS before logging in (refused if the server doesn't offer it). ntfy and SMTP can pin a certificate fingerprint. Discord messages can't mention anyone.
- **Admin** is organised in tabs: Devices, Services, Alerts, Power & cost, Dashboard, Appearance, Backup, Account.
- **Power cost**:
  - Price plans: spot price per price area (NO1–NO5, from [hvakosterstrommen.no](https://www.hvakosterstrommen.no/strompris-api)), or Norgespris (40 øre/kWh excl. VAT, 50 incl.).
  - Optional supplier markup and strømstøtte.
  - Grid tariff with day/night energy rates.
  - Estimated cost per day/month/year at the current draw.
  - Actual logged usage, from integrating iDRAC readings into hourly buckets, priced at the time of use.

- **Appearance**:
  - 11 themes: Auto (follows the OS), Light, Dark, Nord, Dracula, Catppuccin Mocha/Latte, Solarized Dark/Light, Gruvbox Dark and Tokyo Night.
  - Backgrounds: 6 built-in gradients, or upload your own (JPEG/PNG/WebP, max 10 MB).
  - Sliders for blur, dimming and card opacity (frosted glass).
- **Layout**: press **Customize** on the dashboard (as admin) to drag widgets on a 12-column grid. You can resize them from the corner, hide and re-show them, "fit height" to their content, or reset everything. The layout is saved on the server, so it's the same on every device. On phones the widgets stack in one column.

Multiple hosts of each type are supported. The server polls hosts every *refresh interval* and the browser reads the cached results. Logging therefore continues while no browser is open.

## Security model

| Concern | How it is handled |
|---|---|
| Access | Login is required for everything except the login page and its CSS/JS. The dashboard can optionally be made public, but `/admin` and all admin APIs always need a session. |
| Secrets at rest | AES-256-GCM. The AAD binds each ciphertext to the host's id, type, address, username and TLS pin. The key is stored outside the repo in `/etc/homelab-dashboard/secret.key` (root 0600) and passed in via systemd `LoadCredential=`. The server refuses to start if the key or data dir is inside the app directory, or if the key file is group/world readable. |
| Secrets in transit to the browser | Never. Secret fields are write-only. APIs only return `hasSecret: true/false`, and no page or script contains secrets. |
| Changing a host | If the address, username or TLS pin changes and the secret is not entered again, the stored secret is deleted. |
| Self-signed certs | Per-host SHA-256 certificate pinning. The TLS handshake completes and the fingerprint is compared before any byte (including credentials) is written. "Fetch certificate" only performs a handshake. |
| Passwords | scrypt (N=2^15, r=8, p=1). Unknown usernames take the same time as known ones. |
| Brute force | Per-IP lockout after 5 failures, plus a global lockout after 20. Lockouts grow exponentially up to 1 h. |
| Sessions | Random 256-bit id, in memory only. Cookie is `HttpOnly; SameSite=Strict`, plus `Secure` and the `__Host-` prefix over HTTPS. A session is bound to the protocol it was created on, so an HTTPS session is never accepted over HTTP. 2 h idle and 12 h absolute timeout. Changing the password revokes other sessions. |
| CSRF | Per-session token in `X-CSRF-Token` on every state-changing request. `Origin` / `Sec-Fetch-Site` are also checked, and request bodies must be JSON. |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; …`. No inline scripts, no inline styles, DOM built without `innerHTML`. Also sends `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `Cache-Control: no-store`. |
| Uploaded images | Accepted only if the content is really JPEG/PNG/WebP (SVG is rejected). EXIF/XMP/IPTC metadata, PNG text chunks and comments are stripped on upload, keeping only JPEG orientation. Files are stored 0600 under random ids and served with `nosniff`, under the same access rules as the dashboard. |
| SNMPv3 (Synology) | authPriv only: HMAC-SHA-96/SHA-256-192 plus AES-128; passwords never leave the server. The agent's engine ID is pinned and checked before any authenticated message is sent, so a device impersonating the NAS gets nothing to attack offline. Responses that fail the HMAC check are dropped. |
| Services | API keys/passwords are encrypted and write-only like device secrets; bound to the service URL (changing it without re-entering deletes the key). Over plain `http://` the admin page warns that the key travels unencrypted. Links (`href`) must be http(s); cards open them with `noopener noreferrer`. Connection URLs are never sent to the browser. |
| Docs | Login always required. Markdown is rendered to DOM nodes (no `innerHTML`): HTML in documents is shown as text, and only http(s)/mailto links are created. UniFi network settings are reduced to safe fields (no PPPoE/VPN secrets). |
| Network exposure | Refuses `0.0.0.0` / `::` and any non-private address. The `Host` header is checked against an allow-list to block DNS rebinding. |
| OS | Runs as the dedicated `homelab-dash` system user (no shell). Code is root-owned and read-only for the service. The data dir is 0700. The unit is sandboxed: `ProtectSystem=strict`, `ProtectHome`, no capabilities, syscall filter, etc. |

## Install (as root)

```sh
sudo sh deploy/install.sh --host 192.168.1.140   # or 127.0.0.1
```

The script:

1. Installs Debian's `nodejs` and `openssl` if needed.
2. Creates the `homelab-dash` user.
3. Copies the app to `/opt/homelab-dashboard`.
4. Generates the encryption key.
5. Creates a **local CA** and a server certificate.
6. Asks for the admin password.
7. Enables `homelab-dashboard.service`.

Re-run it to deploy updates (or allow deploys, below). Review the diff first: the installed code runs with access to your secrets.

| Option | |
|---|---|
| `--reset-admin` | Set a new admin password |
| `--renew-cert` | Issue a new server certificate now. It is also renewed automatically when it has less than 30 days left, or when `--host` changes. |
| `--low-ports` / `--no-low-ports` | Allow or disallow ports below 1024 (e.g. 443) |
| `--reset-network` | Put HTTP/HTTPS back on the default ports if you locked yourself out |
| `--allow-deploy USER` / `--no-allow-deploy` | Let USER deploy updates without you (see below), or remove that again |

Logs: `journalctl -u homelab-dashboard`

### Deploying updates without re-running the installer

```sh
sudo sh deploy/install.sh --host 192.168.1.140 --allow-deploy claude   # once
sudo -n /usr/local/sbin/homelab-dashboard-deploy                       # then, as claude
```

`--allow-deploy` installs a root-owned deploy command and one sudoers line that lets that user run only this command, with no arguments. The command:

- takes the **committed `main` branch** of the repository, never uncommitted files. git runs as the repository owner and only file contents are copied: symlinks and unusual paths abort the deploy;
- replaces only `server.js` and `public/` in `/opt/homelab-dashboard`, and syntax-checks `server.js` as the service user first;
- restarts the service and waits for it to listen. If it doesn't come up, the previous version is put back;
- logs the commit to the journal (`journalctl -t homelab-dashboard-deploy`) and writes it to `/opt/homelab-dashboard/VERSION`.

The systemd unit, config, key and certificates are never changed by it: the command says when `install.sh` is needed. Note what this permission means: whoever can deploy can change the code that holds your credentials. Today that's also true in practice whenever you run `install.sh` with new code.

### HTTPS and the local CA

The dashboard listens on **https://HOST:8443** by default, and on **http://HOST:8080** with a redirect to HTTPS. In Admin → Dashboard → Web server you can turn HTTP and HTTPS on or off, change their ports, and choose whether HTTP redirects or serves. A new port is opened before the old one is closed, so a port that can't be used never takes the dashboard offline.

The certificates live in `/etc/homelab-dashboard/tls/`. The CA key is readable by root only; the service only gets the server certificate and key, through systemd credentials.

Import the CA certificate once on each device to get rid of browser warnings. Download it from `/ca.crt`, or use the button in Admin, and compare the fingerprint the installer prints. The CA is *name-constrained* to this server's /24 network, 127.0.0.1 and its host names, so it can't vouch for any other website, even if its key leaked.

### Reaching it over Tailscale / WireGuard

- **Bound to the VM's internal IP** (reached via WireGuard or a subnet router): browse to `https://<ip>:8443/`.
- **Bound to 127.0.0.1 with Tailscale on the VM**: run `tailscale serve --bg --https=443 http://127.0.0.1:8080` with HTTP set to *serve*. Then add the MagicDNS name to `ALLOWED_HOSTS` and set `COOKIE_SECURE=1` in `/etc/homelab-dashboard/env`.

## Backups

In Admin → Backup:

- **Download now:** one encrypted `.hldb` file with your own passphrase. It contains settings, devices and their credentials, services, alert channels, docs, energy and graph history, and uploaded images.
- **Restore** from such a file, or from a local copy. The current state is first saved as a local copy. The admin login and port settings are only restored if you tick them.
- **Automatic backups:** daily at a time you choose, keeping the last N copies on this server plus on each destination:
  - **Folder:** mount a NAS share (NFS/SMB) on `/var/backups/homelab-dashboard`, the only path outside the data directory the service can write. Admin shows example `/etc/fstab` lines.
  - **S3-compatible:** Backblaze B2, Wasabi, Cloudflare R2, MinIO, AWS. Uses AWS Signature V4 and HTTPS, with optional certificate pinning.
  - **rsync over SSH** to any machine with rsync (e.g. the DS418 with its rsync service). The app generates the SSH key and you add the public key to the target's `authorized_keys`. The private key is stored encrypted and only decrypted into the service's private `/tmp` during a run. The target's host key is pinned: a different key is refused.

How the file is encrypted: secrets are decrypted with the server key and travel inside the passphrase-encrypted file (scrypt + AES-256-GCM). A backup therefore restores on a fresh install with a new server key, and the server key itself never leaves the server. For security, the app never runs custom commands, only the fixed `rsync`/`ssh`/`ssh-keygen` binaries with validated arguments.

## Credentials for the devices (read-only is enough)

- **iDRAC**: create a local user with the *Read Only* role.
- **Proxmox**: use a token with the `PVEAuditor` role. In the admin UI, the username is the full token ID (e.g. `dashboard@pve!monitor`) and the secret is the token UUID.
  ```sh
  pveum user add dashboard@pve
  pveum acl modify / --users dashboard@pve --roles PVEAuditor
  pveum user token add dashboard@pve monitor --privsep 0
  ```
- **Synology**: DSM → Control Panel → Terminal & SNMP → SNMP. Enable the **SNMPv3** service with a user, protocol **SHA** (or SHA-256), and privacy **AES** with its own password. In Admin, use "Fetch engine ID from device" to pin the NAS's engine ID; authenticated requests are only sent if it matches.
- **UniFi**: create a local user on the console (UniFi OS → Admins & Users) with the **View Only** role for Network and no MFA ("Restrict to local access only"). The session is kept in memory only. After a failed login the dashboard waits 15 minutes before trying again, so the account isn't locked.
- **TrueNAS 25.04+**: create an API key for a user with the *Read-only Administrator* role. Enter that user's name as the username. TrueNAS revokes keys that are used over plain `ws://`; this app only uses `wss://`.

## Development

```sh
DATA_DIR=/tmp/hd-data HOST=127.0.0.1 PORT=8080 node server.js set-admin admin
DATA_DIR=/tmp/hd-data HOST=127.0.0.1 PORT=8080 node server.js
```

`DATA_DIR` must be outside the repository. In dev the key is generated as `$DATA_DIR/secret.key` (0600).

## Tests

```sh
node test/run.js              # end-to-end API suites (~400 checks)
node test/run.js --ui         # also browser tests (needs Playwright)
node test/run.js --verbose    # print every check
```

No npm packages needed: the runner generates a throwaway certificate, starts mock devices (iDRAC, Proxmox, TrueNAS, UniFi OS) and mock service APIs (all 28 integrations), and runs each suite against its own fresh server and data directory. The SNMPv3 suite runs against a real net-snmp agent if `snmpd` is installed (`apt install snmpd`, or set `SNMPD=/path/to/snmpd`) and is skipped otherwise.
