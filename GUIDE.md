# Homelab dashboard: how to use it

The dashboard runs on **lookout** and lives at **https://192.168.1.140:8443**. It shows your servers, NAS, network, services and power cost in one place. It only *reads*: nothing on the dashboard can switch off, restart or update a device.

This guide is for using it day to day. The technical details (installation, the security design, every option) are in [README.md](README.md).

**Contents**

1. [First time on a new device](#1-first-time-on-a-new-device)
2. [Everyday use](#2-everyday-use)
3. [Setting things up in Admin](#3-setting-things-up-in-admin)
4. [Keeping it safe](#4-keeping-it-safe)
5. [Maintenance on lookout](#5-maintenance-on-lookout)
6. [When something doesn't work](#6-when-something-doesnt-work)

---

## 1. First time on a new device

### Trust the certificate (once per device)

The dashboard uses its own small certificate authority (a "local CA"). Until a device trusts it, the browser shows a warning and won't let you install the app.

1. Download the CA: **https://192.168.1.140:8443/ca.crt**, or **Admin → System → Web server → Download CA certificate**.
2. Check that its fingerprint matches **Local CA fingerprint** under **Admin → System → Web server → Certificate** (on a device you already trust). This stops someone on the network from slipping you a different CA.
3. Import it:

| Device | How |
|---|---|
| iPhone / iPad | Open the file → Settings → *Profile Downloaded* → Install. Then Settings → General → About → **Certificate Trust Settings** → turn it on. |
| Android | Settings → Security → Encryption & credentials → Install a certificate → **CA certificate**. |
| Windows | Double-click → Install Certificate → Local Machine → "Trusted Root Certification Authorities". |
| macOS | Double-click → Keychain Access (System) → open the certificate → Trust → "Always Trust". |
| Linux | Copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`. In Firefox: Settings → Certificates → Import. |

The CA can only vouch for this server (its network and its host names), so trusting it doesn't let it impersonate other websites.

### Sign in

Open **https://192.168.1.140:8443** and sign in with the admin account. After 5 wrong passwords you have to wait: 30 seconds at first, doubling up to an hour. A login lasts 2 hours without use and 12 hours at most, and ends when the dashboard restarts.

Away from home, the same address works through Tailscale.

### Install it as an app on your phone

1. Trust the certificate first (above).
2. **Android (Chrome):** open the dashboard → menu ⋮ → **Install app**.
   **iPhone (Safari):** open the dashboard → Share → **Add to Home Screen**.
   **PC (Chrome or Edge):** the install icon at the right end of the address bar.
3. Open the app and sign in with **Remember this device for viewing** ticked. On an iPhone, sign in *inside* the app: home-screen apps don't share Safari's login.

The app opens on Home. When the dashboard can't be reached, the app shows **Can't reach the dashboard** with a **Try again** button. It opens the page by itself once the dashboard answers again. Nothing from the dashboard is stored on the phone, only that screen.

**What "Remember this device for viewing" means:** for 30 days that device can *look at* Home, the rack, Services, Energy, Docs, Updates and the wall display without the password. It can't change anything: Admin, edit buttons and *Check now* ask for the password. **Log out** on the device makes the server forget it. Tick it only on your own devices.

---

## 2. Everyday use

The pages are in the **bar at the top**: **Home · Rack · Services · Energy · Docs · Updates**, with **Search**, the **look** button (palette), **Admin** and **Log out** on the right. On a tablet the tabs show only icons; on a phone the pages are in the **tab bar** at the bottom (Home, Rack, Services, Energy), and **More** has Docs, Updates, the wall display, the look, Admin and Log out. Docs and Updates appear when you're signed in or on a remembered device. **Search** (or **Ctrl K**, or **/**) finds almost anything.

### Home

- **The summary line** at the top: faults, things to watch, power now, the internet, devices online, services up and updates. Each one is a shortcut.
- **Needs you:** a card per problem, worst first, with how long it has been going on. Click a card to open that device. The same findings drive the alerts. When nothing is wrong it says **All systems normal**.
- **Power** and **Internet**, two big tiles with a graph of the last hours:
  - **Power** opens the details: today, this month, the month forecast, cost per day, the last 30 days, the yearly figures, and a button to the full **Energy report**. The graph range (**24 h / 7 d / 30 d**) is remembered per browser.
  - **Internet** comes from the UniFi console (speed test, latency, clients) and opens the gateway.
- **Devices:** a tile per device, grouped *In the rack* and *Elsewhere*. Each tile has one status (**OK**, **Warning**, **Fault** or **Offline**), its worst problem or its model, and one key number. Click a tile to open its **details** (from the right, or from the bottom on a phone):
  - its problems first, then up to eight numbers
  - every connection's full view: fans, power supplies, pools, disks, ports, UPS battery, graphs (hover for value and time)
  - **Server sheet** (its Docs page), **Update available**, and **Edit in Admin**
- **Services** (down ones first) and **Virtual machines** per Proxmox node, with links to the Services page.
- **Customize** (signed in): drag tiles into another order, and use the eye to hide one from Home. It stays in the rack and in search. **Save** keeps it on the server, so it's the same everywhere.

### Rack

The rack is drawn to scale, like the real hardware, with live lights: the drives your servers really have (blanks for empty bays, amber when a drive is about to fail), switch ports lit by link and PoE, power buttons. A device with a problem gets a red or amber outline. The names stand beside it. **Realistic / Schematic** switches to a plain view with names, status and power inside the blocks. Click a device to open its details. Devices outside the rack are listed below it.

### Wall display

**Wall display** (top right on Home, or **More** on a phone) is one screen for a tablet or TV on the wall, at `/wall`. It never scrolls, and is readable from across the room:
- the headline (*2 faults, 1 to watch* or *All systems normal*) and a clock
- **Needs you:** one problem at a time, eight seconds each (point at it to pause), with the full list beside it
- power now with its graph, the internet, the rack, and the services

Tap anything to open it on Home. The full-screen button keeps the screen awake where the browser allows it. For a wall tablet, sign in once with **Remember this device for viewing**: it then shows the wall without a password and can't change anything.

### The look on this device

The **palette** button (top right, or **More** on a phone) changes the look **on this device only**: **Auto / Dark / Light**, eight more themes, and an **accent** colour. Everyone else keeps the owner's look, which is set in Admin → Dashboard & look. **Use the owner's look** goes back.

### Services

- Cards grouped as you like. Click a card to open the app. The dot shows up/down, and hovering shows the response time.
- Up to four numbers per card, e.g. what's queued, wanted, streaming or failed.
- **Virtual machines & containers** from Proxmox are listed here too, with CPU, memory and uptime.

### Energy report

Open it from the power card's **Report** link, or search for "energy".

- **Month / Year** switches between a month by day and a year by month. **‹ ›** step back and forward, and the dropdown lists periods with data.
- The three tiles show **Used** (compared with the period before), **Cost** and **Average price**.
- Hover a bar for that day or month. **Show as table** gives the same numbers as a table.
- **Per device** shows how much each device used, split into measured and estimated. Per-device logging started on 3 October 2026; earlier periods only have the total.
- **Downloads:**
  - **Excel (NO)**: opens directly in Norwegian Excel (semicolons, decimal commas, æøå intact).
  - **CSV**: for other tools (commas, decimal points).
  - Per day for any period, and per month when you view a year. Each file ends with the per-device totals.

### Docs

Your documentation, edited in place:

- **Server sheets.** The dashboard fills in model, service tag, CPU/RAM, disks, VMs, rack position, IPs and switch port, and you add notes (**Edit notes**).
- **Network plan.** Networks and IP reservations, importable from UniFi, plus the live client list.
- **Switch ports** and a **topology** diagram drawn from UniFi.
- **Pages.** Your own pages in Markdown (`# heading`, `**bold**`, `- list`, `[link](https://…)`):
  - **New page** creates one; **Edit** changes it.
  - **History** keeps the last 50 versions (saves within 10 minutes count as one). It shows what changed, and **Restore this version** brings an old one back.
  - A deleted page goes to **Recently deleted** (the last 50) and can be restored with its history.
- **Menu.** Click a group name to fold it. **Edit menu** creates, renames and reorders groups, and moves sheets and pages between them.

Docs are **not for passwords**: link to your password manager instead.

### Updates

One list of what can be updated: Proxmox packages, TrueNAS and its apps, UniFi firmware, Synology DSM and most services. Each row shows the installed and the new version, with release notes.

- It's checked every night at 04:00. **Check now** checks right away (once a minute at most).
- **Nothing is ever installed from the dashboard.** Update on the device itself, then press **Check now**.
- *Not allowed* on a Proxmox row means the read-only token isn't allowed to list packages on that Proxmox version.

### Search

Press **Ctrl K** or **/** anywhere. It finds:
- services, VMs and devices
- Docs sheets and pages, including text inside pages
- IP reservations
- settings

Use ↑ ↓ to choose, **Enter** to open and **Esc** to close.

---

## 3. Setting things up in Admin

**Admin** (top right, or **More** on a phone) has six tabs: **Devices · Services · Alerts · Power & cost · Dashboard & look · System**.

> **Passwords, tokens and keys are entered here and nowhere else.** They're stored encrypted and never shown again. A form only says whether a secret is set. To change one, type the new one. If you change a device's address or user name without retyping the secret, the old secret is deleted, so it's never sent anywhere new.

### Devices

**Add device** opens the **catalog** in three steps: choose the **brand** (UniFi, Cisco, Dell, HPE, Lenovo, Supermicro, Synology, QNAP, TrueNAS, MikroTik, TP-Link Omada, Netgear, APC, Eaton, Raspberry Pi, mini PCs, generic), then the **type** (gateway, switch, access point, NAS or recorder, camera, UPS, power…), then the **model**. A brand with only one type skips step two, and **Search** finds a model from any step. Every model is drawn as it looks: its front in the rack, or its shape for access points, desktop gateways, cameras and the like. Choosing one shows its size, its ports and bays, how it's read live and what you need to set up on it. **Add this device** fills in the type, brand and model, height, front, drive bays, a typical power draw and the right connection; then give it a name and fill in the connection. **Any other device** starts with an empty form.

The whole **UniFi** range is there (about 90 models): every gateway, switch, access point, Protect recorder and camera, UPS and power device. Network devices appear by themselves once their console is added, and are then drawn as their model. **UniFi Protect** is read through the same console account (give it View Only access to Protect too): cameras appear by themselves, with online/offline, recording and last motion, and a camera that goes offline shows up under *Needs you*.

The other brands are drawn the same way, model by model: Synology and QNAP (desktop and rack), TrueNAS, Cisco (Catalyst and CBS), HPE Aruba, MikroTik, TP-Link Omada, Netgear, APC, Eaton and CyberPower UPSes, mini PCs, Raspberry Pi and tower servers, each in its own colours and with its real ports, bays and displays.

The device form: name, type, **brand and model**, and where it sits:
- **In the rack**, with height and lowest U
- **Outside the rack**, e.g. a ceiling access point
- **Not placed**

**Look** and **Drive bays** choose how it's drawn; *Auto* picks from the brand and model, or from what the device reports.

**Add connection** for each way to read the device. Use **read-only** accounts everywhere:

| Connection | For | What to create on the device | In the form |
|---|---|---|---|
| Redfish | Dell iDRAC, HPE iLO, Lenovo XClarity, Supermicro BMC | A local user with a read-only role | Address, user, password |
| Proxmox | Proxmox VE | A user `dashboard@pve` with role **PVEAuditor** and an API token (commands in the README) | User = token ID (e.g. `dashboard@pve!monitor`), secret = token UUID |
| TrueNAS 25.04+ | TrueNAS | An API key for a user with *Read-only Administrator* | User name, API key |
| Synology | Synology DSM | DSM → Control Panel → Terminal & SNMP → **SNMPv3**, protocol SHA, privacy AES | User, passwords, then **Fetch engine ID** |
| UniFi | UniFi OS consoles (UDM, Cloud Gateway) | A local *View Only* user without MFA (UniFi OS → Admins & Users) | User, password |
| SNMPv3 | Switches and routers (Cisco, Aruba, MikroTik, Netgear…), QNAP, UPS network cards (APC, Eaton) | A read-only SNMPv3 user with SHA and AES | User, passwords, then **Fetch engine ID** |
| NUT | A USB UPS, through the machine it's plugged into | NUT with `upsd` listening on the network (`LISTEN` in upsd.conf) | Address of that machine, the UPS name from ups.conf. No password: only values are read. |
| Omada | TP-Link Omada gateways, switches and access points | A local *Viewer* account on the Omada controller | User, password; after **Test**, pick which Omada device this is (or the whole controller) |

The SNMP connection reads standard values only: the ports (up, speed, traffic), CPU, memory and storage, and for a UPS its battery, runtime, load and output. A UPS running on battery, with a low battery or one that needs replacing shows up under *Needs you*.

**Certificates.** Most devices have self-signed certificates. Choose **Pin SHA-256 fingerprint (self-signed)**, press **Fetch certificate**, and if you can, compare the fingerprint with the one shown on the device itself. The dashboard checks it *before* sending the password. If the certificate changes later (firmware update, renewal), the device stops answering with *"fingerprint mismatch; nothing was sent"*. Check why, then fetch and save the new fingerprint.

Press **Test** before **Save device**.

More on devices:
- **Estimated power (W)** for devices without a power sensor (switch, NAS, router). Whether estimates count in the cost is set under Power & cost.
- **Switches and access points** found through UniFi appear by themselves. Deleting one hides it.
- **The rack:**
  - Set its size and numbering at the top of the tab.
  - Drag devices and panels to move them, and click one to edit it.
  - Double-click an empty U, or use **Add panel…**, for blank panels, patch panels, shelves and cable management. These have no name and don't appear in Docs.
  - A desktop NAS like the DS418 goes on a **shelf**: put the shelf at one U and the NAS in the units right above it (4 U for a DS418), with **Look** set to *Synology DiskStation*.
  - **Drive bays** on *Automatic* follow the drives the management controller reports. Change it if your server has a different backplane than the drives suggest.

### Services

**Add service** opens a form with these fields:

| Field | What to enter |
|---|---|
| **Name**, **Group**, **Description** | What shows on the card. |
| **Link** | What opens when you click the card. |
| **Runs on** | Which device it runs on. |
| **Icon** | Search the icon library, upload your own (JPEG/PNG/WebP), or use a letter. |
| **Connection URL** | For the status check and numbers. Can differ from the link, e.g. an internal address. |
| **Integration** and its key | Over plain `http://` the key travels unencrypted on your network; the form warns you. |

Press **Test**, then choose the **Numbers on the card** (up to four), then **Save service**.

To arrange the page, press **Customize** on the Services page:
- drag services between groups, and move groups up and down
- rename groups and set the columns per group
- hide services

### Alerts

1. Under **Channels**, add where messages go:
   - **ntfy**: server (ntfy.sh or your own), a random topic name, and a token if needed
   - **Telegram**: bot token and chat ID ("How to get a bot token and chat ID" explains it)
   - **Discord**: webhook URL
   - **E-mail**: SMTP server, encryption (TLS or STARTTLS; a login is never sent unencrypted), user, password, from and to

   Press **Test** before saving.
2. **What to send where** has a row per alert: offline, service down, hardware fault, storage problem, temperature, storage almost full, TrueNAS alerts, high power, and failed backup. For each one, choose the channels and a wait time, so short blips stay quiet.
3. Choose whether to **Also send a message when an alert clears**, and whether to **Remind while still active**.

**Active now** shows current alerts and **Recent notifications** shows what was sent. At most 30 messages go to one channel per hour.

### Power & cost

- **Plan:** *Norgespris* or *spot price* with your price area, plus VAT, supplier markup and subsidy.
- **Grid tariff (nettleie):** day and night/weekend rates and when the day starts and ends, *Elavgift*, the Enova fee, and the fixed monthly costs. Copy them from your grid company's price page (the grid company).
- **Include estimated power in cost** decides whether estimated devices count, or only measured ones (Redfish and PoE).

### Dashboard & look

- **Title** and **Refresh interval**.
- **Make the dashboard public (viewable without login).** Keep this **off** (see [Keeping it safe](#4-keeping-it-safe)).
- **Theme** (21, including Auto: the classics like Nord and Dracula, plus Graphite, OLED Black for wall screens, Deep Ocean, Forest, Ember, Rosé Pine, Synthwave, Arctic, Sandstone and High Contrast) and **Accent**: the **default look for everyone**. Each viewer can still pick their own on their device with the palette button.
- **Background** (built-in gradients or your own image), blur, dimming and card opacity. **Revert** undoes changes you haven't saved.
- **Layout:** press **Customize** on Home to reorder and hide device tiles. It's saved on the server, so it's the same everywhere.

### System

- **Web server:** ports for HTTPS and HTTP. Keep *HTTP does* = **Redirect to HTTPS**. **Certificate** shows the names it covers, when it expires and the CA fingerprint.
- **Install as an app:** the same steps as in part 1.
- **Download or restore a backup:**
  - **Download now** gives one encrypted file with *everything*, including all passwords. Choose a passphrase of at least 12 characters and keep it in your password manager. Without it the file can't be opened.
  - **Restore** reads such a file. The current state is saved as a local copy first. The admin login and web server ports are only restored if you tick them.
- **Automatic backups:** a daily time, how many copies to keep, and a passphrase.
- **Destinations**, where automatic backups also go:
  - **Folder:** a NAS share mounted on `/var/backups/homelab-dashboard` ("How to mount a share from the DS418 there").
  - **S3** (Backblaze B2, Wasabi, R2, MinIO…).
  - **rsync over SSH:** save the destination, generate the SSH key, add the public key to the target's `authorized_keys`, then **Fetch host key** → **Trust this host key** → **Test**.
- **Local copies** are on lookout: download, restore or delete them.
- **Admin password:** changing it signs out every other session and remembered device.
- **Remembered devices** lists every device ticked *Remember this device*, with browser, last use and address. **Sign out** forgets one; **Sign out all** forgets all of them.

---

## 4. Keeping it safe

This is what the safety check found worth doing in daily use.

**Settings**
- **Keep the dashboard private** (*Make the dashboard public* off). Public mode shows Home, the rack, the wall display, Services and the Energy report to anyone who can reach the server. Home hides addresses and versions, but the Services page still shows links and error messages.
- **Read-only accounts** for every device and service. Then even a leaked secret can't change anything.
- **Pin fingerprints** for self-signed certificates, and don't just re-fetch when one changes: find out why first.
- **HTTPS only:** keep HTTP on *Redirect to HTTPS*. *Serve* sends logins in plain text.

**Devices and logins**
- **Remember devices only on your own phone or PC.** If one is lost: **Admin → System → Remembered devices → Sign out**, or change the password, which signs out all others.
- **Change the admin password** if you think someone saw it. Use one you don't use anywhere else.
- **Lockouts:** after 5 wrong passwords, logins from that address wait 30 seconds at first, up to an hour. After 20 failures from anywhere, everyone waits.

**Backups**
- **Store the backup passphrase in your password manager.** A backup holds every password the dashboard knows.
- **Only restore your own backups.** A restore replaces everything.

**lookout itself**
- **Before running `sudo sh deploy/install.sh`**, look at what changed, because it runs as root:
  `git -C /path/to/lookout-homelab log -p -- deploy/`
- **The deploy permission.** The `claude` user may run one command as root, `sudo -n /usr/local/sbin/homelab-dashboard-deploy`. It copies the committed code and restarts the service. That means whoever controls that user (the coding assistant) can change the code that holds your device passwords.
  - When you're not working on the dashboard, you can turn it off: `sudo sh deploy/install.sh --no-allow-deploy`
  - Turn it back on with: `sudo sh deploy/install.sh --allow-deploy claude`
- **Keep lookout updated** (`sudo apt update && sudo apt upgrade`). Node.js comes from Debian, and the dashboard has no other dependencies.
- **Now and then, look at the log** for failed logins and errors: `journalctl -u homelab-dashboard --since today`

---

## 5. Maintenance on lookout

| What | Where |
|---|---|
| Program | `/opt/homelab-dashboard` (root-owned; `VERSION` says which commit) |
| Data: settings, encrypted secrets, docs, history | `/var/lib/homelab-dashboard` (service user only, 0700) |
| Encryption key, address settings, certificates | `/etc/homelab-dashboard` (root only) |
| Folder backups | `/var/backups/homelab-dashboard` |

| Task | Command |
|---|---|
| See the log live | `journalctl -u homelab-dashboard -f` |
| See past deploys | `journalctl -t homelab-dashboard-deploy` |
| Which version runs | `cat /opt/homelab-dashboard/VERSION` |
| Restart (ends logins; remembered devices stay) | `sudo systemctl restart homelab-dashboard` |
| Deploy the committed code | `sudo -n /usr/local/sbin/homelab-dashboard-deploy` (as claude). It rolls back by itself if the new version doesn't start. |
| Forgot the admin password | `sudo sh deploy/install.sh --reset-admin` |
| Locked out after changing ports | `sudo sh deploy/install.sh --reset-network` |
| Renew the certificate | Valid for 825 days. Admin warns 30 days before; then run `sudo sh deploy/install.sh` (or `--renew-cert`). |

**Moving to a new server:** download a backup → install on the new machine → restore it, ticking *Also restore the admin login* if you want the same password. Devices keep their secrets because they travel inside the encrypted backup. Import the new server's CA on your devices.

---

## 6. When something doesn't work

| What you see | What to do |
|---|---|
| The browser warns about the certificate | The CA isn't imported on this device, or you used an address the certificate doesn't cover. Use **https://192.168.1.140:8443**. |
| No "Install app" option | The certificate isn't trusted yet (part 1), or you're on HTTP. On iPhone it has to be Safari. |
| The app says *Can't reach the dashboard* | You're not at home or on Tailscale. It opens by itself when the connection is back. |
| *Too many failed attempts. Try again in … s* | Wait the time shown. The wait doubles with each new failure, up to an hour. |
| The phone asks for the password again | The 30 days ran out, the device was signed out, or the password changed. Sign in again with *Remember this device* ticked. |
| A device card says **Offline** or shows an error | Admin → Devices → open the device → **Test** shows the reason. Common reasons: a changed certificate (*fingerprint mismatch*), a changed password, or UniFi waiting 15 minutes after a failed login. |
| A service shows down but works in the browser | Check its **Connection URL** in Admin → Services and press **Test**. |
| Alerts don't arrive | Admin → Alerts → **Test** on the channel, and look under **Recent notifications**. Check that the alert's row ticks that channel. |
| A graph is missing | Graphs appear once there is data, a few minutes after adding a device. |
| An Excel file shows everything in one column | Use the **Excel (NO)** download. |
| Per-device energy is empty for an old month | Per-device logging started on 3 October 2026. |
| The dashboard doesn't start after a change | The deploy rolls back by itself. For details: `journalctl -u homelab-dashboard -n 50`. |
