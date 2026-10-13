# Homelab Lookout: how to use it

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

- **At the top:** how many faults and things to watch (or **All normal**), and a sentence about the rest.
- **Needs you:** one row per problem, worst first, with how long it has been going on. Click a row to open that device. A connection that stops answering is listed after it has failed for 2 minutes (a single slow or missed reading doesn't count). The same findings drive the alerts. When nothing is wrong it says **All systems normal**.
  - **Snooze** (signed in as admin): the clock button at the end of a row hides it from the top of Home and from the wall display for **1 day** or **1 week**, for everyone. The device itself keeps showing the problem, alerts are still sent, and the snooze ends early if a warning turns into a fault. **N snoozed · Show** under the list shows them again; the bell button on a snoozed row ends the snooze.
- **Power** and **Internet**, two big cards with a large number and a glowing graph of the last hours (amber for power, teal for the network):
  - **Power** opens the details: today, this month, the month forecast, cost per day, the last 30 days, the yearly figures, and a button to the full **Energy report**. The graph range in the details (**24 h / 7 d / 30 d**) is remembered per browser; the cards on Home always show the last 24 hours.
  - **Internet** comes from the UniFi console (up or down, latency, clients on Wi-Fi and wired) and opens the gateway. The bars show the traffic going through the connection right now against your last speed test (*142 of 684 Mbps*), and the graph shows the last 24 hours of traffic: download as the filled area, upload as the thin line (point at it for both values at that time). Next to the heading is your **internet provider** with its logo: what the console reports, or the name you set in *Admin → Dashboard & look*. The card also shows your **public IP** (only to people who are signed in; never on a public dashboard).
  - When the public IP changes, a teal **Public IP changed** row (old → new) appears at the top of Home and on the wall display. An admin closes it with **×**, for everyone; it stays in the **Log**.
- **Devices:** a tile per device, drawn as it looks (its rack front, or its shape for access points, cameras and desktop NAS), grouped *In the rack* and *Elsewhere*. Each tile has one status (**OK**, **Warning**, **Fault** or **Offline**), its worst problem or its model, and one key number. Click a tile to open its **details** (from the right, or from the bottom on a phone):
  - its problems first, then up to eight numbers
  - every connection's full view: fans, power supplies, pools, disks, ports, UPS battery, graphs (hover for value and time)
  - **Server sheet** (its Docs page), **Update available**, and **Edit in Admin**
  - on a **Proxmox** server: its storage, ZFS pools, the disks with their SMART health and SSD wear, and the last backup job. Click a VM or container in the table to open its network and disk graphs, its filesystems and its address. These details are read every 5 minutes; a full disk or storage, a degraded pool, a failing disk or a failed backup job shows under **Needs you**.
- **At the bottom**, one quiet line: services up, VMs running and updates, each a link. Services and VMs can also be shown as tiles or a list (Admin → Dashboard & look).
- **Rack** (in the top bar): the rack drawn to scale. On a wide screen the chosen device's details stand beside it.
- **Customize** (signed in): drag tiles into another order, and use the eye to hide one from Home. It stays in the rack and in search. **Save** keeps it on the server, so it's the same everywhere.

### Rack

The rack is drawn to scale, like the real hardware, with live lights: the drives your servers really have (blanks for empty bays, amber when a drive is about to fail), switch ports lit by link and PoE, power buttons. A device with a problem gets a red or amber outline. The names stand beside it. **Realistic / Schematic** switches to a plain view with names, status and power inside the blocks. Click a device to open its details. Devices outside the rack are listed below it.

### Patch cables

On the **Rack** page, **Cables** shows or hides the patch cables in this browser (off at first). When you are signed in, **Patch** lets you draw them: click a port on a switch, gateway or patch panel, then the port at the other end. Pick the colour first in the bar above the rack. Click a cable to change its colour, give it a label (shown when you point at it) or **Remove** it; **Done** leaves patch mode. Every change is in the Log. Removing a device or panel from the rack removes its cables. The wall display shows them when **Patch cables** is ticked under Customize → Rack panel.

### Wall display

**Wall display** (top right on Home, or **More** on a phone) is one screen for a tablet or TV on the wall, at `/wall`. It never scrolls, and is readable from across the room:
- the headline (*2 faults, 1 to watch* or *All systems normal*), and top right your logo and title beside the clock
- the buttons (Home, search, look, Customize, full screen) fade out after a few seconds when nobody touches the screen, and so does the mouse pointer; touch the screen, move the mouse or press a key to bring them back
- **Needs you:** one problem at a time, eight seconds each (point at it to pause), with the full list beside it
- power now with its graph, the internet, the rack, and the services

**Customize** (the sliders button at the top, only when you're signed in) changes the wall for every screen that shows it, with a live preview:
- tick the panels to show (Needs you, All problems, Power, Internet, Rack, and a **Devices** panel), move them up and down, and make each **Normal**, **Wide** (two columns), **Tall** (two rows) or **Big** (both)
- the logo and title, the clock and the VM count in the top bar
- the services along the bottom: the same as Home, ones you pick, or none
- the Devices panel: every device, or the ones you pick

**Default layout** brings back the original wall.

Tap anything to open it on Home. The full-screen button keeps the screen awake where the browser allows it. For a wall tablet, sign in once with **Remember this device for viewing**: it then shows the wall without a password and can't change anything.

### The look on this device

The **palette** button (top right, or **More** on a phone) changes the look **on this device only**: **Auto / Dark / Light**, eight more themes, and an **accent** colour. Everyone else keeps the owner's look, which is set in Admin → Dashboard & look. **Use the owner's look** goes back.

### Services

- Cards grouped as you like. Click a card to open the app. The dot shows up/down, and hovering shows the response time.
- Up to four numbers per card, e.g. what's queued, wanted, streaming or failed.
- Virtual machines and containers have their own page, **VMs** (below).

### VMs

Every VM and container on your Proxmox hosts, one row each: status, CPU, memory, disk, network traffic and **last backup**. On a phone it is under **More**.

- **Search** by name, ID, address or OS, and filter **Running**, **Stopped** or **Backup** (no backup, or one older than the limit).
- The disk is a container's own disk, or for a VM with the QEMU guest agent its fullest filesystem. The address under the name comes from the guest agent too.
- **Last backup** is the newest backup Proxmox has of the VM on any backup storage, including Proxmox Backup Server. *None* means none was found.
- Click a row for the details: OS, addresses, size, graphs of CPU, memory, network and disk activity, every filesystem, the backups (newest, where, how many, verified), and **Open in Proxmox** (signed in only).
- The details also show the VM's **backup job** from Proxmox (its schedule, e.g. *monthly*, and its storage) and when it runs next, or *In no backup job*.
- A VM is **overdue** when it has no backup newer than its job's interval plus a day: a monthly job allows 32 days, a weekly one 8. A VM in no job (backed up by hand) uses the limit under *Admin → Alerts → Backup failed* (35 days unless you change it). Overdue raises a *Backup failed* warning. A VM that has never been backed up is shown, not alerted.
- Under the list, **Backups looked for on** names every backup storage and how many backups it held (or why it couldn't be read), so a *None* can be checked against Proxmox.

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
- A Proxmox row counts the **Proxmox packages** (pve-manager, kernel, QEMU…) that have a newer version. Plain Debian updates aren't included: Proxmox only shows those to tokens that may change the node, and the dashboard's token is read-only on purpose.

### Log

**Log** in the menu (admin only) lists everything that changed, newest first, grouped by day: every change in Admin and Docs (with what changed, e.g. *Title: Homelab → My Lab*, and who did it), devices found, problems starting and clearing, notifications sent, snoozes, the public IP and its changes, sign-ins and failed sign-ins, update checks, backups and restarts. Filter by category or search, and **Download CSV** for the current filter. Entries are kept for a year and are included in backups. Passwords and keys are never written to it; at most it says that one was changed.

### User guide

The illustrated user guide (a PDF with sample data) opens from the **document button** beside Search in the top bar, from **More → User guide (PDF)** on a phone, or by searching for *guide*. Anyone who can see the dashboard can open it, at `/guide.pdf`.

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
| Proxmox | Proxmox VE | A user `dashboard@pve` with role **PVEAuditor** and an API token (commands in the README). To see inside VMs: the QEMU guest agent in each VM, and the token allowed to ask it (README). | User = token ID (e.g. `dashboard@pve!monitor`), secret = token UUID |
| TrueNAS 25.04+ | TrueNAS | An API key for a user with *Read-only Administrator* | User name, API key |
| Synology | Synology DSM | DSM → Control Panel → Terminal & SNMP → **SNMPv3**, protocol SHA, privacy AES | User, passwords, then **Fetch engine ID** |
| UniFi | UniFi OS consoles (UDM, Cloud Gateway) | A local *View Only* user without MFA (UniFi OS → Admins & Users) | User, password |
| SNMPv3 | Switches and routers (Cisco, Aruba, MikroTik, Netgear…), QNAP, UPS network cards (APC, Eaton) | A read-only SNMPv3 user with SHA and AES | User, passwords, then **Fetch engine ID** |
| NUT | A USB UPS, through the machine it's plugged into | NUT with `upsd` listening on the network (`LISTEN` in upsd.conf) | Address of that machine, the UPS name from ups.conf. No password: only values are read. |
| Omada | TP-Link Omada gateways, switches and access points | A local *Viewer* account on the Omada controller | User, password; after **Test**, pick which Omada device this is (or the whole controller) |
| Shelly | Shelly smart plugs, Gen 1 and Gen 2 and newer (Plus Plug S, Plug S Gen3…) | Nothing, if the plug has no login. Gen 1 can have a password; on Gen 2 and newer, keep the login off | Host or IP. Only reads the power (plain HTTP on your network); never switches the plug. |
| Tasmota | Plugs flashed with Tasmota | Nothing, or its web password | Host or IP, and the web password if it has one. |
| Home Assistant power sensor | Any plug or meter Home Assistant already reads (Tapo, Kasa, Zigbee, a P1 meter…) | A long-lived access token (your profile in Home Assistant → Security) | Home Assistant's URL, the sensor's **Entity ID** (in watts or kilowatts, e.g. `sensor.nas_plug_power`) and the token. |
| Ping | Anything without an API: a printer, a Raspberry Pi, an access point of another brand | Nothing; it only has to answer ping | Host or IP (no port). The device is *Online* while it answers, with its response time; when it stops, *Device offline* alerts as for any other connection. |

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
| **Integration: Proxmox VE** | Pick your Proxmox device under **Numbers from**. The card shows VMs running, CPU and memory, and the **Link** is filled in with the Proxmox web address, so it's one click from Services. |
| **Status check** | **Web page**: the connection URL answers (any status below 500). **Ping**: the host answers ping. **TCP port**: something listens on the port, e.g. SSH on 22 or a database on 5432; for services that have no web page. The response time is kept as history. |
| **Integration** and its key | Over plain `http://` the key travels unencrypted on your network; the form warns you. |

Press **Test**, then choose the **Numbers on the card** (up to four), then **Save service**.

**Certificates:** for an `https://` connection URL the dashboard also reads when the certificate expires (also self-signed and pinned ones). Two weeks before, the service gets a warning under **Needs you**; the last three days it is critical. It is a *Service down* alert, so it is sent where those go.

**Infrastructure cards** (the *Infrastructure* group in the Integration list):

| Integration | Numbers from | What it shows |
|---|---|---|
| **TrueNAS** | A TrueNAS device you added, or its own `https://` URL and API key | Alerts, unhealthy pools, space used and free, uptime |
| **Synology DSM** | A Synology device you added (SNMP), or DSM's own login (URL like `https://nas:5001`, a user without 2-step verification; space only shows for administrators) | Volume used, CPU, memory, uptime, temperature, disk warnings |
| **UniFi Network** | A UniFi console you added, or its own `https://` URL and a local View Only account | Clients, WAN, devices offline, latency and speed test, cameras |
| **UPS (NUT)** | A NUT or SNMP UPS you added, or a NUT server's address and UPS name | Charge, runtime, load, mains or battery |
| **PeaNUT** | PeaNUT's URL and the UPS name (a login only if PeaNUT has one) | The same as UPS |
| **Tailscale** | A read-only **API access token** from the Tailscale admin console (Settings → Keys). No URL needed; it asks `api.tailscale.com` | Devices online, keys expiring within 14 days, updates available |

With **Numbers from** set to a device, the card uses what the dashboard already reads from it: no second password is stored, and the connection URL is optional (it only adds an up/down check). A UPS card on its own connection or PeaNUT shows *on battery* and *battery low* under **Needs you**; Tailscale shows keys that have expired or expire within 14 days.

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
   - **iMessage (Sendblue)**: API key ID and secret key from the Sendblue dashboard, your Sendblue line, and up to 10 phone numbers with country code (+47…). Phones without iMessage get an SMS. Each alert is one message per number, which counts toward your Sendblue plan.

   Press **Test** before saving.
2. **What to send where** has a row per alert: offline, service down, hardware fault, storage problem, temperature, storage almost full, TrueNAS alerts, high power, check-in missed, and failed backup. For each one, choose the channels and a wait time, so short blips stay quiet.
3. Choose whether to **Also send a message when an alert clears**, and whether to **Remind while still active**.

**Active now** shows current alerts and **Recent notifications** shows what was sent. At most 30 messages go to one channel per hour.

#### Check-ins (backups and cron jobs)

A check-in catches the job that silently stopped running, which no other check can see.

1. **Add check-in**: a name, how often the job runs (**Expected every**), how late it may be (**Grace time**) and, if you like, the device it runs on.
2. Open **Address and how to use it** and copy the address into the end of the job, for example in crontab:
   `0 3 * * * /usr/local/bin/backup.sh && curl -fsS -m 10 --retry 3 http://192.168.1.140:8080/ping/… || curl -fsS -m 10 --retry 3 http://192.168.1.140:8080/ping/…/fail`
3. The check-in is **OK** while the job calls in time, **Late** after the period, and **Missed** after the grace time as well. Calling `…/fail` reports a failure at once. Both raise **Check-in missed** under **Needs you** and as an alert.

The address works over plain HTTP too, so `curl` needs no trusted certificate. Anyone who knows it can check in, so keep it like a password; **Edit → New address** replaces it. **Reset** forgets a missed or failed check-in.

#### Maintenance

**Plan maintenance** for work you know about: choose **Everything**, or the devices, services and check-ins it covers, and when: **Starting now** (for 30 minutes to a day), **Once** (from–to), or **Every week** (days, start time and length, in Norwegian time).

While it is on, problems on what it covers are listed on Home as *Maintenance* but muted. They don't count as faults, no alerts are sent, and the time doesn't count against uptime. A device tile and a service card say **Maintenance**. **End now** stops it early; for a weekly window, only this time.

### Power & cost

- **Plan:** *Norgespris* or *spot price* with your price area, plus VAT, supplier markup and subsidy.
- **Grid tariff (nettleie):** day and night/weekend rates and when the day starts and ends, *Elavgift*, the Enova fee, and the fixed monthly costs. Copy them from your grid company's price page (the grid company).
- **Include estimated power in cost** decides whether estimated devices count, or only measured ones (Redfish, smart plugs and PoE).
- **Where each device's power comes from** is set on the device (Admin → Devices → the device → **Power reading from**): *Automatic* takes Redfish, then a smart plug, then the estimate. Choose the plug instead of Redfish, only the estimate, or *Not counted* (for example when one plug feeds several devices: count it on one and set the others to *Not counted*). Each device is counted once, so a server with both an iDRAC and a plug is never counted twice. PoE stays counted on the switch that delivers it.

### Dashboard & look

**Status page**: a public page at `/status` showing only whether your services are up, with their uptime over the last 90 days (30 days on a phone) and any planned maintenance. No links, addresses, devices or VMs. Switch it on with **Show the status page to everyone**. It works while the dashboard itself stays private, so you can give people the status page instead of making the whole dashboard public. Services with a status check are listed, in the groups from the Services page.

- **Title**, **Internet provider** (leave empty to use the name the UniFi console reports) and **Refresh interval**.
- **Provider logo:** **Automatic** looks up who owns your public IP in the internet registry (RDAP), finds the provider's website there and uses its icon (**Find again** retries; a failed lookup is retried after a week). If it picks the wrong one or none, use **Upload**, **Link** (paste an https link to the image; the dashboard keeps a copy) or **None**.
- **Make the dashboard public (viewable without login).** Keep this **off** (see [Keeping it safe](#4-keeping-it-safe)).
- **Services on Home:** **One line with the count** at the bottom of Home (the default), **Tiles**, a **Compact list** (one row each), **Only the ones that are down**, or **Off** (they stay on the Services tab). The wall display follows the same choice. To leave out a single service, untick **Show on Home** on that service. Untick **A service that is down shows under "Needs you"** to keep services out of Home's alerts and the top summary as well; notifications from the Alerts tab are not changed.
- **VMs and containers:** choose where they show besides the **VMs** page (**On Home**, **In the Proxmox server's details** as a table, **As a count on the server in the rack**) and what with (**Stopped ones too**, **CPU**, **Memory**, **Uptime**). On Home they are one line with the count at the bottom, unless you tick **On Home as a section with names and numbers**.
- **Theme** (21, including Auto: the classics like Nord and Dracula, plus Graphite, OLED Black for wall screens, Deep Ocean, Forest, Ember, Rosé Pine, Synthwave, Arctic, Sandstone and High Contrast) and **Accent**: the **default look for everyone**. Each viewer can still pick their own on their device with the palette button.
- **Logo:** **Default**, a **Built-in icon** in one of eight colours, or an **Image** (upload PNG, JPEG, WebP or SVG up to 1 MB, or search the icon library). It is shown in the top bar, on the sign-in page and as the browser tab icon. SVG files with scripts or links to other files are refused.
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
