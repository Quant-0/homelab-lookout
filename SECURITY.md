# Security

Homelab Lookout holds passwords to people's servers, NAS and network gear, so security reports are very welcome.

## Reporting a problem

Please **don't open a public issue** for a security problem. Report it privately instead: on GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. Only the maintainer sees the report.

Helpful things to include:

- what an attacker could do, and from where (the network, a signed-in viewer, a device that answers polls, …);
- the version (Admin → Server shows the commit) and how it runs (Docker or directly on Linux);
- steps to reproduce it, ideally against sample data.

You'll get an answer as soon as possible. A fix goes out as a new image and commit, and the report is credited unless you'd rather not be named.

## Supported versions

Only the newest version on `main` (the image's `:latest` tag) gets fixes. Update with `docker compose pull && docker compose up -d`, Portainer's *Pull and redeploy*, or by running the installer again.

## How it is protected

The security model is described in [docs/configuration/security.md](docs/configuration/security.md), and what the container adds in [Install with Docker](docs/getting-started/install-docker.md#how-it-is-protected).
