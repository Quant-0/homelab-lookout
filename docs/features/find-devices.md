# Find devices

**Admin → Devices → Find devices** scans your own networks and lists what it recognises, so you can add it in a couple of clicks.

## How it works

1. It suggests the dashboard's own network (e.g. `192.168.1.0/24`). Add others, like a management network where the iDRACs live (`192.168.2.0/24`). Only private ranges, up to 1024 addresses in all.
2. **Scan** knocks on the ports homelab gear uses (a TCP connect), then looks once at what answers. It never tries a password.
3. The results list each address that answered, with its name from UniFi or DNS, and what was recognised:
   - **Add device** opens the device form with the right connection and address filled in;
   - **Add service** opens the service form with the URL and integration;
   - what you already have is marked **Added**;
   - anything else can be added as a device that answers ping.

You still enter the login in the form. A scan runs only when you press Scan, one at a time, and it is noted in the Log.

## What it recognises

| Devices | Apps |
|---|---|
| Proxmox VE, TrueNAS, UniFi and Omada consoles, iDRAC / iLO / XClarity and other Redfish controllers, Synology DSM, QNAP, NUT servers (with the UPS name), Docker socket proxies, Shelly and Tasmota plugs | Jellyfin, Emby, Plex, Sonarr, Radarr, Lidarr, Prowlarr, Bazarr, Seerr (Overseerr, Jellyseerr), qBittorrent, Transmission, SABnzbd, Tautulli, Portainer, Home Assistant, Pi-hole, AdGuard Home, Nginx Proxy Manager, Traefik, Nextcloud, Immich, Paperless-ngx, Uptime Kuma, Grafana, Prometheus, authentik, Speedtest Tracker |

It follows an app's redirects to its sign-in page (which often carries its name), trusts the page title before the page text (a sign-in page may mention other apps), ignores styles and scripts, and asks a few apps' own public endpoints when the page names nothing (TrueNAS's API versions, Seerr's status, Redfish's root, Docker's version).

## Ports it knocks on

22, 80, 81, 443, 2283, 2375, 3000, 3001, 3493, 5000, 5001, 5055, 6767, 7878, 8000, 8006, 8007, 8080, 8096, 8123, 8686, 8989, 9000, 9090, 9443, 9696, 32400.

A /24 takes about half a minute. Some firewalls and IDS (UniFi's threat management, for example) may notice a scan; that is expected.
