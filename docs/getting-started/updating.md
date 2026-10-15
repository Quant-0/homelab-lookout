# Updating

## A new version

Pull the new code and run the installer again; it keeps your data:

```sh
cd lookout-homelab
git pull
sudo sh deploy/install.sh --host 192.168.1.20
```

Look at what changed first (`git log -p`): the installed code runs with access to your device passwords.

## Deploying without the installer

If someone (a second account, or an assistant working as that user) deploys new versions for you, give that user one narrow permission instead of full sudo:

```sh
sudo sh deploy/install.sh --host 192.168.1.20 --allow-deploy deployer   # once, as you
sudo -n /usr/local/sbin/homelab-dashboard-deploy                        # then, as deployer
```

The deploy command:

- takes the **committed `main` branch** of the repository, never uncommitted files; git runs as the repository's owner and only file contents are copied (symlinks and odd paths abort the deploy);
- replaces only `server.js` and `public/`, after checking `server.js` as the service user;
- restarts the service and waits until it listens; if it doesn't come up, the previous version is put back;
- logs the commit (`journalctl -t homelab-dashboard-deploy`) and writes it to `/opt/homelab-dashboard/VERSION`.

It never touches the systemd unit, the key or the certificates; it says when the installer is needed. Remember what the permission means: whoever can deploy can change the code that holds your passwords. Turn it off when you don't need it: `sudo sh deploy/install.sh --no-allow-deploy`.

## Node.js

**Admin → Server** shows the Node.js version and when its security fixes end. The installer uses Node.js 24 LTS. To move an existing install to a newer Node.js by hand:

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install nodejs
sudo systemctl restart homelab-dashboard
```

## Packages without full sudo

`deploy/allow-packages.sh USER` lets the deploying user keep the server's packages current without full sudo. It installs `/usr/local/sbin/homelab-pkg` and one sudoers line that allows only:

| Command | What |
|---|---|
| `sudo -n homelab-pkg install NAME…` | Only packages on the owner's list (`/etc/homelab-pkg/allowed`), from the signed repositories already set up |
| `sudo -n homelab-pkg upgrade` | `apt-get update` and upgrade; restarts the dashboard if Node.js changed |
| `sudo -n homelab-pkg setup-nodesource-24` | Adds the NodeSource 24 repository once, after checking its key against a pinned fingerprint |
| `sudo -n homelab-pkg list` | Shows the list |

Only the owner changes the list, with their own password: `sudo homelab-pkg allow NAME` or `disallow NAME`. Every run is logged (`journalctl -t homelab-pkg`). Remove the permission with `sudo sh deploy/allow-packages.sh --remove`.

## The Linux agents

Agents on other machines are never updated by the dashboard. When **Admin → Devices → Linux agents** says a newer agent is available, run `sudo lookout-agent update` on each machine. See [Linux agents](../features/linux-agents.md).
