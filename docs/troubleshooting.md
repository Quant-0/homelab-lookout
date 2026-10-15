# Troubleshooting

| What you see | What to do |
|---|---|
| A certificate warning | The CA isn't imported on this device, or you used an address the certificate doesn't cover. See [First steps](getting-started/first-steps.md) |
| No *Install app* option | Trust the certificate first. On an iPhone it has to be Safari |
| *Can't reach the dashboard* in the app | You're not at home or on your VPN, or the name doesn't resolve there. It opens by itself when it is back |
| *Unknown host* (421) | You opened it by a name it doesn't know: set the Dashboard address in Admin → Server, or add the name to `ALLOWED_HOSTS` |
| *Too many failed attempts* | Wait the time shown; it doubles with each failure, up to an hour |
| Asked for the password again | The sign-in ran out or was signed out, or the password changed. Risky changes ask after 15 minutes |
| Signed out after setting up a proxy | Expected once: a session made over http doesn't carry over to https |
| A device says *Offline* | Admin → Devices → open it → **Test** shows why: a changed certificate (*fingerprint mismatch*), a changed password, a UniFi console waiting 15 minutes after a failed login, or a device that is really down |
| A service is red but works | Check its Connection URL and status check in Admin → Services, and press Test |
| Alerts don't arrive | Admin → Alerts → **Send test** on the channel; check the alert's row ticks that channel, and that the device isn't muted or in maintenance |
| Push doesn't turn on | On iPhone, use the installed app, not Safari; the browser must allow notifications for the site; some browsers (Brave) block push by default |
| Acknowledge links don't open | Set the Dashboard address to one your phone can reach |
| Passkeys aren't offered | They need a Dashboard address with a domain name, and you must open the dashboard on that address |
| The app icon is old | Press Save under Look, then remove the app and add it again |
| A graph is missing | Graphs appear a few minutes after a device is added; the forecast needs a week |
| An agent says *not reporting* | On the machine: `sudo lookout-agent test` shows the error (a wrong address, an untrusted certificate, a changed token) |
| Backups show *None* | The token may not see the backup storage's files: give it *PVEDatastoreAuditor*; *Backups looked for on* under the VM list says where it looked |
| Excel shows one column | Use the *Excel (NO)* download |
| The dashboard doesn't start after a change | The deploy rolls back by itself; details: `journalctl -u homelab-dashboard -n 50` |

## Useful commands

| Task | Directly on Linux | Docker |
|---|---|---|
| The log, live | `journalctl -u homelab-dashboard -f` | `docker logs -f lookout` (Portainer: the container → Logs) |
| Past deploys | `journalctl -t homelab-dashboard-deploy` | Not needed: each image is one commit |
| Which version runs | `cat /opt/homelab-dashboard/VERSION`, or Admin → Server | Admin → Server |
| Restart (sign-ins survive) | `sudo systemctl restart homelab-dashboard` | `docker restart lookout` |
| Forgot the admin password | `sudo sh deploy/install.sh --reset-admin` | `docker exec -it -u 10001 lookout node /app/server.js set-admin admin`, then restart |
| Locked out after changing ports | `sudo sh deploy/install.sh --reset-network` | Start once with `LOOKOUT_RESET_NETWORK: "1"` |
| Renew the certificate | Renewed 30 days before by the installer; or `sudo sh deploy/install.sh --renew-cert` | Renewed on start when 30 days are left |

Every problem, change and sign-in is in the **Log**, and every problem's start and end under **Incidents**: often the quickest way to find out what happened and when.
