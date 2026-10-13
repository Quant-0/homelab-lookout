# Homelab Lookout

A homelab dashboard for servers (Redfish: Dell iDRAC, HPE iLO, Lenovo XClarity, Supermicro), Proxmox VE, TrueNAS, Synology, UniFi and Omada networks, any SNMPv3 switch, router, NAS or UPS card, and UPSes through NUT, with estimates and logs of power cost for Norway (spot price or Norgespris, plus grid tariff).

It is built from one Node.js server file (`server.js`, Node 18+; use a supported release, Node 24 LTS recommended) plus static HTML/CSS/JS in `public/`. There are no npm dependencies.

**How to use it day to day: see [GUIDE.md](GUIDE.md).** This README covers what it does, the security design, installation and development.

## What it shows

- **Redfish** (Dell iDRAC, HPE iLO, Lenovo XClarity, Supermicro BMC): power draw (W), PSU status, temperatures, and fans. Each fan spins at a rate proportional to its RPM (6000 rpm = 1 rotation/s). The drives in the front bays (model, size, health, "predicted to fail") are read from Redfish every 15 minutes: they're drawn in the rack, listed on the Docs sheet, and a failing drive raises a *Storage problem* alert.
- **Proxmox**: nodes (CPU, memory, root disk, uptime), storage, ZFS pools, SMART health and SSD wear of the node's disks, and the last backup job (`vzdump`); VMs and containers on their own page with their status, CPU and memory history, network and disk traffic, a container's disk use, the newest backup of each (from every backup storage, also Proxmox Backup Server, with an alert when it gets too old), and with the QEMU guest agent the filesystems, addresses and OS inside a VM.
- **Check-ins** (dead man's switch): a backup or cron job calls its own secret URL (`/ping/<token>`, also over plain HTTP; `…/fail` and `…/start` too). Missing it past the period and grace time, or reporting a failure, raises *Check-in missed*.
- **Maintenance windows**: once or weekly (Oslo time), for everything or chosen devices, services and check-ins. Their problems show as maintenance, send no alerts and don't count against uptime.
- **Status page**: an optional public page at `/status` with each checked service's state and 90 days of uptime, and planned maintenance. Nothing else: no links, addresses or hardware. It works with a private dashboard.
- **Smart plugs**: Shelly (Gen 1, and Gen 2+ without login), Tasmota, or any power sensor in Home Assistant (with a token). Each device has one power source (*Power reading from*: automatic, Redfish, the plug, the estimate or not counted), so nothing is counted twice in the power total and cost.
- **Ping**: devices without an API (a printer, a Pi) as online/offline with their response time; services can be checked by ping or TCP port instead of a web page, and an `https://` service warns two weeks before its certificate expires.
- **TrueNAS**: system info, pools (usage, health) and active alerts. It uses JSON-RPC 2.0 over WebSocket (`wss://host/api/current`) and requires TrueNAS 25.04 or newer.
- **Synology** (any DSM model, via SNMPv3): temperature, system/fan/power status, CPU/RAM, volumes, storage pools, and disks with health and temperature.
- **UniFi** (UniFi OS consoles such as the UDM Pro): WAN/internet status, clients, and every adopted device (gateway, switches, APs) with CPU/RAM, temperatures, PoE per port and uptime.
- **UniFi Protect** (same console and account, with View Only access to Protect): cameras with online state, recording and last motion, and recording storage. Cameras become devices by themselves; an offline camera raises an alert.
- **Any SNMPv3 device** (Cisco, HPE Aruba, MikroTik, Netgear, QNAP, UPS network cards from APC and Eaton…), with standard MIBs only: ports (up, speed, traffic per port from the counters), CPU, memory and storage (HOST-RESOURCES), and UPS battery, runtime, load, output and input (UPS-MIB, RFC 1628).
- **NUT**: a USB UPS through Network UPS Tools on the machine it's plugged into. Only `LIST VAR` is sent; no login, nothing secret.
- **Omada** controllers (software, OC200/OC300): gateways, switches and access points with status, clients, CPU/RAM, PoE and firmware. A device can be bound to one Omada device; otherwise it shows the whole controller.
- **UPS alerts**: on battery, low battery, battery needs replacing.
- **Home**: a summary line (faults, power, internet, devices online, services, updates), then **Needs you**, a card per problem (the same findings the alerts use, whether or not they notify), big tiles for **Power** and the **Internet**, a tile per device (one status: OK, Warning, Fault, Offline; its worst problem; one key number), services and VMs. A tile opens the **details drawer** (a bottom sheet on phones) with the full view per connection; fixed facts such as service tag and firmware are on the device's Docs sheet. **Customize** reorders and hides tiles.
- **Wall display** (`/wall`): one screen for a tablet or TV that never scrolls: a headline, one problem at a time in a spotlight (8 s each), power with its graph, the internet, the rack and the services, a clock, and full screen with the screen kept awake where allowed.
- **Device catalog**: Admin → Add device: brand → type → model, ~180 models drawn as they look (all of UniFi, plus Synology, QNAP, Cisco, Aruba, MikroTik, Omada, Netgear, APC, Eaton, CyberPower, servers and mini PCs), from (UniFi, Cisco, Dell, HPE, Lenovo, Supermicro, Synology, QNAP, TrueNAS, MikroTik, TP-Link Omada, Netgear, APC, Eaton, Raspberry Pi, mini PCs, generic). A model fills in the type, brand/model, height, rack front, drive bays, typical power and the connection to add, and says what to set up on the device.
- **Devices**: everything is organised around physical devices (server, NAS, switch, patch panel…).
  - A device has a name, a type, a place in the rack and its monitoring connections. E.g. "Orion" = iDRAC + Proxmox node, all added in one form, with **Test** before saving.
  - The dashboard shows one widget per device, with a section per connection.
  - Switches and access points found through a UniFi console appear as devices automatically. Deleting one hides it; it isn't re-created.
- **Rack** (its own view, `/#rack`): your rack (1–60 U), **drawn to scale**: a 19″ front is 482.6 mm wide and 1 U is 44.45 mm, so every device keeps its real proportions at any size. Two views, switched in the rack's header and remembered per browser:
  - **Realistic**: fronts modelled on the real hardware, with live LEDs, and the names beside the rack instead of on the fronts;
  - **Schematic**: flat blocks in the theme's colours with icon, name, status and one number;
  - fronts chosen from the brand and model (chosen in Admin, or reported by the device): HPE ProLiant, Lenovo ThinkSystem and Supermicro servers with their own colours, Dell PowerEdge 13th gen (R630/R730, with the LCD showing watts) and 14th gen (R640/R740, with the fault icons for power and temperature), UniFi Dream Machine Pro and Switch 24 PoE (touchscreen, ports lit by link and PoE), other UniFi and generic switches, Synology RackStation and DiskStation (a DiskStation stands on a shelf at its real size), and generic servers. Dell servers show the drives the iDRAC reports in their bays (blanks where a bay is empty, amber for a warning) and pick the bay layout from them. Each device's front and drive-bay layout can be changed in Admin → Devices;
  - **passive items** without a name: blank, vented and brush panels, cable management, patch panels (12/24/48 ports) and shelves. Add them from "Add panel" or by double-clicking an empty U. They are not devices, so they don't appear in the docs or as widgets. Blank panels, patch panels and shelves that were devices before are converted automatically;
  - click a device to jump to its widget; devices outside the rack (e.g. access points) are listed below it.
  - Edit it in Admin → Devices: drag to move, double-click an empty U to add.
- **Services** tab on the dashboard (Homepage-style): grouped cards with icon, link, live status (up/down; response time on hover) and up to 4 numbers from the app, in one row. Each integration shows the 2–3 numbers that say something is waiting for you (queued, wanted, streams, pending, failed); pick others per service in Admin after a Test.
  - Proxmox **VMs and containers** are listed here too, with CPU, memory and uptime. Home keeps each node's health and links here.
  - **Customize** (as admin): drag services between groups and groups up or down, rename groups, set the number of columns per group, and hide services. Keyboard: focus a service and use the arrow keys.
  - 34 integrations: Jellyfin, Emby, Plex, Tautulli, Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, Overseerr/Jellyseerr, qBittorrent, Transmission, SABnzbd, Pi-hole (v5/v6), AdGuard Home, Nginx Proxy Manager, Traefik, Home Assistant, Nextcloud, Immich, Paperless-ngx, Uptime Kuma, Grafana, Portainer, Speedtest Tracker, Prometheus, authentik, TrueNAS, Synology DSM, UniFi Network, UPS (NUT), PeaNUT, Tailscale (the first four can use a device you already added instead of a second login), plus **Custom JSON API** for anything else.
  - Icons come from the [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) library (downloaded once by the server and served locally) or are uploaded.
- **Docs** tab (always requires login, even with a public dashboard), edited in place:
  - Server sheets: automatic facts (model, service tag, CPU/RAM, PSUs, disks, VMs, rack position, management IPs, switch port) plus your notes.
  - Network plan: networks and IP reservations, importable from UniFi, plus the live UniFi client list.
  - Switch ports: what is connected to each port.
  - Topology diagram drawn from UniFi uplinks.
  - Your own Markdown pages, each with a **history**: the last 50 versions (saves within ten minutes count as one), with the changes since each version highlighted, the page as it was, and Restore. Deleted pages go to **Recently deleted** (the last 50) and can be restored with their history. Both are part of backups.
  - The menu has collapsible groups (remembered per browser). With **Edit menu** you create, rename and reorder groups and drag sheets and pages between them (or use the arrow keys). Network stays its own group.
  - Not meant for passwords: link to your password manager instead.
- **History graphs**: small graphs on the device cards and in their Details, with the value and time on hover and a **24 h / 7 d / 30 d** choice in the power card (remembered per browser). A graph appears once it has data.
  - Recorded: total measured power; iDRAC watts, inlet and hottest temperature; Proxmox node CPU and memory; Synology temperature, CPU and memory; TrueNAS load; UniFi device CPU, temperature, clients and PoE draw.
  - 1-minute averages for 25 hours, 15-minute averages for 8 days, 2-hour averages for 92 days. Graphs for removed devices are dropped after 30 days. On Node 22.5 and newer they are stored in `history.db` in the data directory (SQLite, built into Node): a point is added when its minute, quarter or two hours are over, and nothing is rewritten. On older Node it's `history.json`, rewritten every 5 minutes (roughly 75 kB per graph once full). An existing `history.json` is moved into the database once (and kept as `history.json.imported`). Backups contain the history either way.
  - Only numbers are kept (no names or addresses). The graphs follow the dashboard's visibility: they need login unless the dashboard is public.
- **Alerts** (Admin → Alerts): messages to **ntfy**, **Telegram**, **Discord**, **e-mail (SMTP)** and **iMessage through Sendblue** (SMS where the phone has no iMessage). You can add several channels of each kind and tick which alerts go to which channel.
  - Alerts: device offline, service down, hardware fault (PSUs, fans, system health), storage problem (degraded pools, failing disks), high temperature, storage almost full, TrueNAS alerts, high power draw (off by default), and failed automatic backups.
  - Each alert has a *wait* time, so short blips stay quiet. A message is also sent when the problem clears, and optionally a reminder while it lasts. Several alerts at once go out as one message per channel, with at most 30 messages per channel per hour.
  - When a host stops answering, its other alerts (e.g. a degraded pool) are kept as they are, not reported as resolved. Deleting a device drops its alerts without a "resolved" message.
  - Tokens, passwords and webhook URLs are encrypted and write-only, like device credentials, and bound to where they are sent: changing the server or user without retyping deletes them.
  - E-mail uses TLS or STARTTLS before logging in (refused if the server doesn't offer it). ntfy and SMTP can pin a certificate fingerprint. Discord messages can't mention anyone.
- **Updates** (logged in only): one list of what can be updated, with the installed and the new version, release notes, and the package list for Proxmox. Checked once a night (04:00) and with "Check now": Proxmox pending packages, TrueNAS and its apps, Sonarr, Radarr, Lidarr, Prowlarr, Seerr, Pi-hole, Paperless-ngx, authentik, Portainer, Home Assistant, Tautulli, Plex and AdGuard Home. UniFi firmware and Synology DSM come with every refresh. Home shows the count, and a device's details say "Update available". Nothing is ever installed from the dashboard. A public dashboard shows visitors no versions at all.
  - Proxmox updates are read with the read-only token: the Proxmox packages (pve-manager, kernel, QEMU…) with their installed and newest versions, from the node's own package lists. Plain Debian updates aren't shown, because Proxmox only lists those to tokens that may change the node (Sys.Modify).
- **Search**: press **Ctrl K** (or **/**) on any page to find services, VMs, devices, Docs sheets and pages (also text inside pages), IP reservations and settings. Docs and settings only show up when you're logged in.
- **Install as an app** (PWA) on a phone or PC: Chrome/Edge offer *Install app*; on an iPhone use Safari's *Share → Add to Home Screen*. The device must trust the local CA first (Admin → Server → Web server). The app opens on Home in its own window. When the dashboard can't be reached (away from home without Tailscale), it shows a *Can't reach the dashboard* screen and opens the page again once the dashboard answers. Only that screen and its style, script and icon are stored on the device; no pages or data are cached.
- **Remember this device for viewing**: a box at sign-in, meant for the app on a phone. For 30 days after signing in, that device can view Home, the rack, the wall display, Services, Energy, Docs and Updates without the password, even after the 2-hour session ends or the server restarts. It can't change anything: Admin, edit buttons and *Check now* ask for the password. **Log out** on the device forgets it. Admin → Sign-in & security lists remembered devices (browser, last used, from which address) and can sign them out one by one or all at once. Changing the password signs out all of them except the one you're using.
- **Admin** is organised in ten tabs in three groups: *Monitoring* (Devices, Services, Alerts, Check-ins & maintenance), *Dashboard* (Dashboard, Look, Power & cost) and *System* (Backups, Sign-in & security, Server). On a phone they are one menu.
- **Power cost**:
  - Price plans: spot price per price area (NO1–NO5, from [hvakosterstrommen.no](https://www.hvakosterstrommen.no/strompris-api)), or Norgespris (40 øre/kWh excl. VAT, 50 incl.).
  - Optional supplier markup and strømstøtte.
  - Grid tariff with day/night energy rates.
  - Estimated cost per day/month/year at the current draw.
  - Actual logged usage, from integrating Redfish readings into hourly buckets, priced at the time of use.
  - All in one card: the draw now with its graph, today, this month and a forecast for the month; the 30-day chart appears once there are two days of data, and yearly figures are under Details.
  - **Energy report** (the card's *Report* link, or search "energy"): a month by day or a year by month, with kWh, cost and average price compared with the period before, and how much each device used. Per-device figures are logged from when this version was installed; earlier hours have only the total. The page follows the dashboard: private means login, public means visitors see it too.
  - **CSV export** from the report, per day or (for a year) per month, in two formats: *Excel (NO)* uses semicolons, decimal commas and a BOM, so Norwegian Excel opens it directly with æøå intact; *CSV* uses commas and decimal points for other tools. Each file ends with the per-device totals. Names that start with `=`, `+`, `-` or `@` are written so a spreadsheet can't run them as formulas.

- **Look**: crisp and dark-first, with a bar at the top on wide screens (icons only on tablets) and a tab bar at the bottom on phones, like an app. The Inter font and Lucide icons are served by the dashboard itself, so nothing is fetched from elsewhere (licences in `public/licenses/`).
- **Appearance**:
  - 21 themes: Auto (follows the OS), Light, Dark, Nord, Dracula, Catppuccin Mocha/Latte, Solarized Dark/Light, Gruvbox Dark, Tokyo Night, Graphite, OLED Black, Deep Ocean, Forest, Ember, Rosé Pine, Synthwave, Arctic, Sandstone and High Contrast, and 8 accent colours (or the theme's own).
  - The owner picks the default in Admin; each viewer can pick their own theme and accent on their device with the palette button (kept in that browser only).
  - Backgrounds: 6 built-in gradients, or upload your own (JPEG/PNG/WebP, max 10 MB).
  - Sliders for blur, dimming and card opacity (frosted glass).
- **Layout**: press **Customize** on Home (as admin) to drag device tiles into another order and hide the ones you don't need there. It's saved on the server, so it's the same on every device.

Multiple hosts of each type are supported. The server polls hosts every *refresh interval* and the browser reads the cached results. Logging therefore continues while no browser is open.

## Security model

| Concern | How it is handled |
|---|---|
| Access | Login is required for everything except the login page, the app's manifest, service worker, offline screen and icons, and their CSS/JS. The dashboard can optionally be made public, but `/admin` and all admin APIs always need a session (a remembered device is not enough). |
| Secrets at rest | AES-256-GCM. The AAD binds each ciphertext to the host's id, type, address, username and TLS pin. The key is stored outside the repo in `/etc/homelab-dashboard/secret.key` (root 0600) and passed in via systemd `LoadCredential=`. The server refuses to start if the key or data dir is inside the app directory, or if the key file is group/world readable. |
| Secrets in transit to the browser | Never. Secret fields are write-only. APIs only return `hasSecret: true/false`, and no page or script contains secrets. |
| Changing a host | If the address, username or TLS pin changes and the secret is not entered again, the stored secret is deleted. |
| Self-signed certs | Per-host SHA-256 certificate pinning. The TLS handshake completes and the fingerprint is compared before any byte (including credentials) is written. "Fetch certificate" only performs a handshake. |
| Passwords | scrypt (N=2^15, r=8, p=1). Unknown usernames take the same time as known ones. |
| Brute force | Per-IP lockout after 5 failures, plus a global lockout after 20. Lockouts grow exponentially up to 1 h. The "current password" on Change password counts towards the same lockout. |
| Sessions | Random 256-bit token. Only its SHA-256 is stored (`sessions.json`, 0600), so sessions survive restarts but the file can't be used to sign in; sessions from an earlier password are dropped when loaded. Cookie is `HttpOnly; SameSite=Strict`, plus `Secure` and the `__Host-` prefix over HTTPS. A session is bound to the protocol it was created on. Normal: 2 h idle, 12 h absolute. "Keep me signed in": 7 days idle, 30 days absolute. At most 20 at a time. Admin → Sign-in & security lists them and signs them out. Changing the password revokes the others. |
| Step-up | However long the session, risky changes need the password typed in the last 15 minutes: the web server, backup download/restore/settings/destinations and local backup files, alert channels, and making the dashboard or the status page public. The confirmation (`POST /api/reauth`) shares the login lockout and is logged. |
| Remembered devices | Opt-in at sign-in. A separate random 256-bit token in its own cookie (same flags, `__Host-hd_device` over HTTPS), valid for 30 days from sign-in and only for reading. An allow-list of read routes; every write, every admin API and `/admin` ask for the password. `remembered.json` (0600) holds only the SHA-256 of each token, so the file can't be used to sign in, and it's left out of backups. Tokens are tied to the current password: a new password (in Admin or with `set-admin`) signs them out. At most 20; log out on the device, or Admin → Sign-in & security, removes one. |
| Installed app | The manifest, service worker, offline screen and icons are public and say nothing about the lab. Without a login the app is just called "Homelab Lookout". The service worker caches only that public shell, never pages or API responses. Pages always come from the server. CSP allows only our own manifest and worker (`manifest-src 'self'; worker-src 'self'`). |
| CSRF | Per-session token in `X-CSRF-Token` on every state-changing request. `Origin` / `Sec-Fetch-Site` are also checked, and request bodies must be JSON. |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; …`. No inline scripts, no inline styles, DOM built without `innerHTML`. Also sends `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and `Cache-Control: no-store`. |
| Restoring a backup | Everything in the file is checked again as if it were entered now: images get their type from their content (JPEG/PNG/WebP only, metadata stripped), settings go through the same validation as Admin (a section that fails gets the defaults), service links must be http(s). Theme names and stored image types are checked once more where they're written into a page or sent. A backup is AES-256-GCM with a key from your passphrase (scrypt), so nobody can change one without the passphrase. |
| Uploaded images | Accepted only if the content is really JPEG/PNG/WebP (SVG is rejected). EXIF/XMP/IPTC metadata, PNG text chunks and comments are stripped on upload, keeping only JPEG orientation. Files are stored 0600 under random ids and served with `nosniff`, under the same access rules as the dashboard. |
| SNMPv3 (Synology and any other device) | authPriv only: HMAC-SHA-96/SHA-256-192 plus AES-128; passwords never leave the server. The agent's engine ID is pinned and checked before any authenticated message is sent, so a device impersonating it gets nothing to attack offline. Responses that fail the HMAC check are dropped. |
| NUT | Plain TCP, read-only: one `LIST VAR` command, no login, so there is no secret to store or to leak. |
| Omada | HTTPS with the same pinning as the other HTTPS devices; the Viewer session lives in memory only, with a 15-minute pause after a failed login. |
| Look | The owner's theme and accent come from fixed lists, checked again before they go into a page. A viewer's own look is kept in their browser (`localStorage`) and only changes attributes on their own page. |
| Services | API keys/passwords are encrypted and write-only like device secrets; bound to the service URL (changing it without re-entering deletes the key). Over plain `http://` the admin page warns that the key travels unencrypted. Links (`href`) must be http(s); cards open them with `noopener noreferrer`. Connection URLs are never sent to the browser. |
| Docs | Login always required. Markdown is rendered to DOM nodes (no `innerHTML`): HTML in documents is shown as text, and only http(s)/mailto links are created. UniFi network settings are reduced to safe fields (no PPPoE/VPN secrets). |
| Backup restore | A backup file is treated as input: connections, backup destinations, alert channels, check-ins, maintenance windows, settings and images are checked like changes made in Admin, and what doesn't pass is left out (so a tampered file can't hand `rsync` or `ssh` an option, or a folder outside the backup directory). |
| Open endpoints | What answers without a sign-in (check-ins at `/ping/…`, the status page, the guide) is limited to 120 requests per address and minute. Check-ins are the only thing served over plain HTTP when HTTP redirects; that is decided on the normalized path. |
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

### Updating Node.js

Use a Node.js release that still gets security fixes; **Admin → Server** shows the version and when its support ends. Debian 13 ships Node.js 20, whose support ended in April 2026. `install.sh` installs Node.js 24 LTS from NodeSource when it finds anything older than 22; on a server that is already installed, do it by hand:

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install nodejs
node --version   # v24.x
sudo systemctl restart homelab-dashboard
```

After the restart the graph history moves from `history.json` into `history.db` by itself.

### Packages without full sudo

`deploy/allow-packages.sh USER` lets the user who deploys (or an assistant working as that user) keep the server's packages up to date without full sudo. It installs `/usr/local/sbin/homelab-pkg` and one sudoers line that allows exactly:

- `sudo -n homelab-pkg install NAME…`: only packages on the owner's list (`/etc/homelab-pkg/allowed`), only from the signed repositories already set up; no files, versions or apt options
- `sudo -n homelab-pkg upgrade`: `apt-get update` and upgrade of what is installed (the dashboard is restarted if Node.js changed)
- `sudo -n homelab-pkg setup-nodesource-24`: adds the NodeSource 24 repository once, after checking its signing key against a pinned fingerprint
- `sudo -n homelab-pkg list`

The list starts with what the dashboard uses (nodejs, rsync, openssh-client, iputils-ping, openssl, ca-certificates, curl, gnupg). Only the owner changes it, with their own password: `sudo homelab-pkg allow NAME` or `disallow NAME`. Every run is logged (`journalctl -t homelab-pkg`). Remove the permission with `sudo sh deploy/allow-packages.sh --remove`.

```sh
sudo sh deploy/allow-packages.sh claude
```

### HTTPS and the local CA

The dashboard listens on **https://HOST:8443** by default, and on **http://HOST:8080** with a redirect to HTTPS. In Admin → Server → Web server you can turn HTTP and HTTPS on or off, change their ports, and choose whether HTTP redirects or serves. A new port is opened before the old one is closed, so a port that can't be used never takes the dashboard offline.

The certificates live in `/etc/homelab-dashboard/tls/`. The CA key is readable by root only; the service only gets the server certificate and key, through systemd credentials.

Import the CA certificate once on each device to get rid of browser warnings. Download it from `/ca.crt`, or use the button in Admin, and compare the fingerprint the installer prints. The CA is *name-constrained* to this server's /24 network, 127.0.0.1 and its host names, so it can't vouch for any other website, even if its key leaked.

### Reaching it over Tailscale / WireGuard

- **Bound to the VM's internal IP** (reached via WireGuard or a subnet router): browse to `https://<ip>:8443/`.
- **Bound to 127.0.0.1 with Tailscale on the VM**: run `tailscale serve --bg --https=443 http://127.0.0.1:8080` with HTTP set to *serve*. Then add the MagicDNS name to `ALLOWED_HOSTS` and set `COOKIE_SECURE=1` in `/etc/homelab-dashboard/env`.

## Backups

In Admin → Backups:

- **Download now:** one encrypted `.hldb` file with your own passphrase. It contains settings, devices and their credentials, services, alert channels, docs, energy and graph history, and uploaded images.
- **Restore** from such a file, or from a local copy. The current state is first saved as a local copy. The admin login and port settings are only restored if you tick them.
- **Automatic backups:** daily at a time you choose, keeping the last N copies on this server plus on each destination:
  - **Folder:** mount a NAS share (NFS/SMB) on `/var/backups/homelab-dashboard`, the only path outside the data directory the service can write. Admin shows example `/etc/fstab` lines.
  - **S3-compatible:** Backblaze B2, Wasabi, Cloudflare R2, MinIO, AWS. Uses AWS Signature V4 and HTTPS, with optional certificate pinning.
  - **rsync over SSH** to any machine with rsync (e.g. the DS418 with its rsync service). The app generates the SSH key and you add the public key to the target's `authorized_keys`. The private key is stored encrypted and only decrypted into the service's private `/tmp` during a run. The target's host key is pinned: a different key is refused.

How the file is encrypted: secrets are decrypted with the server key and travel inside the passphrase-encrypted file (scrypt + AES-256-GCM). A backup therefore restores on a fresh install with a new server key, and the server key itself never leaves the server. For security, the app never runs custom commands, only the fixed `rsync`/`ssh`/`ssh-keygen` binaries with validated arguments.

## Credentials for the devices (read-only is enough)

- **Redfish** (iDRAC, iLO, XClarity, Supermicro): create a local user with a read-only role (*Read Only* on iDRAC, *Login* only on iLO).
- **Proxmox**: use a token with the `PVEAuditor` role. In the admin UI, the username is the full token ID (e.g. `dashboard@pve!monitor`) and the secret is the token UUID.
  ```sh
  pveum user add dashboard@pve
  pveum acl modify / --users dashboard@pve --roles PVEAuditor
  pveum user token add dashboard@pve monitor --privsep 0
  ```
  That covers nodes, guests, storage, ZFS pools, SMART health of the node's disks and backup jobs. To also see **inside VMs** (disk use per filesystem, addresses, OS), install `qemu-guest-agent` in each VM, switch on *QEMU Guest Agent* under the VM's Options, and allow the token to ask the agent. On Proxmox 9 that is a read-only privilege:
  ```sh
  pveum role add GuestAgentAudit --privs VM.GuestAgent.Audit
  pveum acl modify /vms --users dashboard@pve --roles GuestAgentAudit
  ```
  Proxmox 8 has no such privilege; there it is `VM.Monitor`, which also opens the QEMU monitor of each VM. Grant that only if you accept it. Containers need none of this: their disk use comes with the guest list.
- **Synology**: DSM → Control Panel → Terminal & SNMP → SNMP. Enable the **SNMPv3** service with a user, protocol **SHA** (or SHA-256), and privacy **AES** with its own password. In Admin, use "Fetch engine ID from device" to pin the NAS's engine ID; authenticated requests are only sent if it matches.
- **UniFi**: create a local user on the console (UniFi OS → Admins & Users) with the **View Only** role for Network and no MFA ("Restrict to local access only"). The session is kept in memory only. After a failed login the dashboard waits 15 minutes before trying again, so the account isn't locked.
- **SNMPv3** (switches, routers, QNAP, UPS network cards): a user with authentication (SHA or SHA-256) and privacy (AES), read-only view. Pin the engine ID like for Synology.
- **NUT**: on the machine the UPS is plugged into, let `upsd` listen on the network (`LISTEN 0.0.0.0 3493` in upsd.conf, or its LAN address) and allow the dashboard's address. The dashboard only lists the variables; it never logs in.
- **Omada**: a local account with the *Viewer* role on the controller. Same session handling and 15-minute backoff as UniFi.
- **TrueNAS 25.04+**: create an API key for a user with the *Read-only Administrator* role. Enter that user's name as the username. TrueNAS revokes keys that are used over plain `ws://`; this app only uses `wss://`.

## Development

```sh
DATA_DIR=/tmp/hd-data HOST=127.0.0.1 PORT=8080 node server.js set-admin admin
DATA_DIR=/tmp/hd-data HOST=127.0.0.1 PORT=8080 node server.js
```

`DATA_DIR` must be outside the repository. In dev the key is generated as `$DATA_DIR/secret.key` (0600).

## Tests

```sh
node test/run.js              # end-to-end API suites, including the security sweep
node test/run.js --ui         # also browser tests (needs Playwright); 820 checks in all
node test/run.js --verbose    # print every check
```

No npm packages needed: the runner generates a throwaway certificate, starts mock devices (Redfish, Proxmox, TrueNAS, UniFi OS, Omada, a NUT server) and mock service APIs (all 34 integrations), and runs each suite against its own fresh server and data directory. The SNMPv3 suite runs against a real net-snmp agent if `snmpd` is installed (`apt install snmpd`, or set `SNMPD=/path/to/snmpd`) and is skipped otherwise.
