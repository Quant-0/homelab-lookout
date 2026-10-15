# Installation

Homelab Lookout runs in one of two ways. Both run the same program, with the same features and the same security; only how it is installed and updated differs.

| | [**Docker**](install-docker.md) (or a Portainer stack) | [**Directly on Linux**](install-linux.md) (a systemd service) |
|---|---|---|
| Good when | You already run containers, or manage the server with Portainer | You want a small VM, an LXC container or a Raspberry Pi just for Lookout |
| Runs on | Any Linux with Docker 24+ or Podman, amd64 or arm64 (Raspberry Pi 4/5) | Debian 12/13 or Ubuntu 22.04+ with systemd |
| Install | Paste the compose file into Portainer, or `docker compose up -d` | `sudo sh deploy/install.sh --host YOUR-SERVER-IP` from the repository |
| First admin account | The setup page, with a code from the container's log | The installer asks for it |
| Updates | Pull the new image and recreate (Portainer: *Pull and redeploy*) | `git pull` and run the installer again, or the deploy command |
| Your data | Two host folders: `/opt/lookout/data` and `/opt/lookout/key` | `/var/lib/homelab-dashboard`, and the key in `/etc/homelab-dashboard` |
| Hardening | Its own user (uid 10001), read-only image, all capabilities dropped but ping's | Its own system user, read-only code, a sandboxed systemd unit with a syscall filter |
| Where it comes from | The public image `ghcr.io/quant-0/homelab-lookout`, built from this repository | A clone of this repository |

Some things are the same either way:

- **A private address.** Lookout listens on a private address only, like `192.168.1.20` (or `127.0.0.1` behind a proxy on the same machine), never on a public one or on all network cards at once.
- **Access to your devices.** Lookout must be able to reach their management interfaces: iDRAC or iLO, Proxmox, the NAS, the UniFi console, and so on.
- **HTTPS.** Both make a local certificate authority and an HTTPS certificate on the first start. To open the dashboard without warnings, [import the CA once](first-steps.md) on each device, or put a [reverse proxy](reverse-proxy.md) with a public certificate in front.
- **Moving between them.** **Admin → Backups → Download now** on one, and **Restore** on the other. Devices keep their passwords; tick *Also restore the admin login* to keep yours.

Next: [First steps](first-steps.md): signing in, trusting the certificate, installing the app.
