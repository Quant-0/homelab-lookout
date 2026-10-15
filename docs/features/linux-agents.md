# Linux agents

A **Lookout agent** is a small shell script on a VM, a container or any Linux machine (a Raspberry Pi, a VPS) that reports, once a minute, what Proxmox can't see from outside:

| | Proxmox alone | With the agent |
|---|---|---|
| Memory | Proxmox's view: the file cache counts as used | What Linux uses, the cache and swap |
| CPU | % of the VM | Also load, time waiting for disk, steal |
| Disks | Filesystems only with the QEMU guest agent; only the root disk of a container | Every filesystem, with inodes |
| Services | – | Every **failed** systemd service, and the ones you list that must be running |
| Updates | – | Pending apt/dnf updates, security fixes, and whether it needs a **reboot** |
| Also | – | Temperatures, the busiest processes, kernel and OS |

It only reads and reports; it never runs anything the dashboard sends, and it never updates itself.

## Install

1. **Admin → Devices → Linux agents → Add agent**.
2. Choose what it runs on: a **VM or container** from Proxmox (its data then shows in that VM's details), an existing **device**, or **a new device**.
3. Optionally list **services that must be running** (`nginx docker pihole-FTL`), how often it reports, and whether it looks for updates.
4. **Create** shows the install command. Run it on the machine (it needs `curl`, `systemd` and sudo):

```sh
curl -fsS https://lookout.example.com/agent/install.sh | sudo sh -s -- --id <id> --token <token>
```

The command holds the machine's own token, shown only once. On a dashboard with its own (local CA) certificate, the command first downloads the CA and checks it by its fingerprint before trusting it.

The installer creates a system user `lookout-agent`, puts the agent in `/usr/local/bin/lookout-agent` and its settings in `/etc/lookout-agent/agent.conf`, and starts a systemd timer (`lookout-agent.timer`, a sandboxed oneshot service). The first report is sent right away.

## On the machine

| Command | |
|---|---|
| `sudo lookout-agent status` | When it last reported, its settings, and whether a newer agent is available |
| `sudo lookout-agent test` | Report now and show the dashboard's answer |
| `sudo lookout-agent watch add nginx` | Also watch a service (`watch remove`, `watch list`) |
| `sudo lookout-agent update` | Install the newest agent from the dashboard |
| `sudo lookout-agent uninstall` | Remove everything, and tell the dashboard |

`/etc/lookout-agent/agent.conf`:

```sh
URL=https://lookout.example.com
ID=…
TOKEN=…
CA=                 # the dashboard's CA file, when it has its own certificate
INTERVAL=60         # seconds between reports
WATCH="nginx"       # services to watch, added to the ones on the panel
UPDATES=yes         # look for pending updates (every 6 hours)
```

## On the panel

The agent's **Edit** form changes the services to watch, the interval and update checks; the agent picks them up with its next report. It also shows the commands again. **New token** makes a fresh install command (the old token stops working). **Remove** deletes the agent here; run `sudo lookout-agent uninstall` on the machine too.

## What it raises

| Alert | When |
|---|---|
| *Linux machine (agent)* | A service failed, a watched one stopped, security updates are waiting, or it needs a reboot |
| *Storage almost full* | A filesystem over the limit, out of inodes, or filling up within 30 days |
| *High temperature* | A sensor over the limit |
| *Device offline* | No report for three intervals (unless its VM is stopped) |

Its pending updates are listed on the **Updates** page with the packages.

## Security

- Each agent has its own token; only its SHA-256 is stored.
- The agent runs as its own user with `NoNewPrivileges` and `ProtectSystem=strict`; it can read and send, not change the system.
- It never executes anything from the dashboard's answer (just the interval, the services to watch and whether to check updates), and it is only updated when you run `update`. A compromised dashboard can't run code on your machines.
- Every field in a report is checked by the dashboard (types, lengths, unit names, list sizes).
