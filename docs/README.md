# Homelab Lookout documentation

Start with **Getting started**, then read about the features you use. Every page uses sample names and addresses (`192.168.1.x`, `lookout.example.com`, servers called *atlas* and *vault*); use your own.

## Getting started
- [Installation](getting-started/installation.md): Docker or directly on Linux, side by side
- [Install with Docker](getting-started/install-docker.md): Portainer stacks, the image, settings, folders and permissions, updates, security
- [Install directly on Linux](getting-started/install-linux.md): the installer and its options, where things live, environment
- [First steps](getting-started/first-steps.md): signing in, trusting the certificate, installing the app, passkeys
- [Reverse proxy and a domain name](getting-started/reverse-proxy.md): Nginx Proxy Manager, Caddy, Traefik, nginx, Tailscale, Cloudflare Tunnel
- [Updating](getting-started/updating.md): new versions, Node.js, packages

## Features
- [Home, rack and wall display](features/home-and-wall.md)
- [Devices and connections](features/devices.md): the catalog, every connection type, credentials, dependencies, per-device alerts
- [Find devices](features/find-devices.md): scanning your networks
- [Services and the status page](features/services.md): cards, status checks, integrations
- [VMs and containers](features/vms-and-containers.md): Proxmox guests, backups, Docker and Portainer
- [Linux agents](features/linux-agents.md): what Proxmox can't see from outside
- [Alerts and incidents](features/alerts.md): channels, push, webhooks, acknowledging
- [Check-ins and maintenance](features/checkins-and-maintenance.md)
- [Power and energy](features/energy.md): power sources, prices, the energy report
- [History and the monthly report](features/history-and-reports.md): graphs, the report, the storage forecast
- [Metrics for Prometheus, Grafana and Home Assistant](features/metrics.md): tokens, the Prometheus config, Home Assistant sensors, every metric
- [Docs, Updates, Log and undo](features/docs-updates-log.md): docs pages, update checks, the change log, and the configuration history with undo

## Configuration
- [Admin overview](configuration/admin.md): every Admin tab
- [Backups](configuration/backups.md)
- [Security](configuration/security.md): the security model and good habits

## Other
- [Troubleshooting](troubleshooting.md)
- [Development and tests](development.md)
- [The PDF user guide's source](guide/)
