# Security

Homelab Lookout holds passwords to your servers, NAS and network, so it is built to be safe by default. This page describes how, and the habits that keep it that way.

## The model

| Concern | How it is handled |
|---|---|
| **Access** | A sign-in for everything except the sign-in page, the app shell (manifest, service worker, offline screen, icons and their CSS/JS) and what you choose to make public. `/admin` and every admin API always need a full sign-in |
| **Secrets at rest** | AES-256-GCM. Each ciphertext is bound (AAD) to its connection's id, type, address, user and certificate pin. The key lives outside the app in `/etc/homelab-dashboard/secret.key` (root, 0600) and reaches the service through systemd credentials. The server refuses to start if the key or data are inside the app folder or the key is readable by others |
| **Secrets and the browser** | Never sent: secret fields are write-only, APIs only say whether one is set |
| **Changing a connection** | A new address, user or certificate pin without the secret typed again deletes the stored secret, so it is never sent somewhere new |
| **Self-signed certificates** | Per-connection SHA-256 pinning; the fingerprint is checked before any byte (including a password) is written |
| **Passwords** | scrypt (N=2^15, r=8, p=1); unknown user names take as long as known ones |
| **Brute force** | Per-address lockout after 5 failures and a global one after 20, growing to an hour; shared by the sign-in, password confirmation and passkeys |
| **Sessions** | A random 256-bit token; only its SHA-256 is stored (`sessions.json`, 0600). `HttpOnly; SameSite=Strict`, plus `Secure` and `__Host-` over HTTPS; a session only works on the protocol it was made on. Normal: 2 h idle, 12 h at most. *Keep me signed in*: 7 days idle, 30 at most. A new password signs everyone else out |
| **Step-up** | Risky changes (web server, backups, alert channels, the dashboard address and proxies, making things public, passkeys, metrics tokens, undoing a change or going back in the configuration history) need the password or a passkey in the last 15 minutes |
| **Configuration history** | `config-history.json` (0600) keeps secrets as stored (encrypted); the browser only gets descriptions of changes. The admin account, passkeys, sessions and the web server's ports are not in it, so undo can't lock you out |
| **Passkeys** | WebAuthn on the Dashboard address's domain only; user verification required; one-use, two-minute challenges tied to their purpose and used up before anything else is checked; the origin, the RP ID hash and the sign counter are checked |
| **Remembered devices** | Opt-in, view-only, 30 days; a separate token (only its hash stored, left out of backups), signed out by a new password |
| **CSRF** | A per-session token on every change; `Origin` and `Sec-Fetch-Site` are checked; request bodies must be JSON |
| **CSP and headers** | `default-src 'none'; script-src 'self'; style-src 'self'`; no inline scripts or styles, pages built without `innerHTML`; `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` |
| **Network** | Refuses to listen on `0.0.0.0` or a public address; the `Host` header is checked against an allow-list (DNS rebinding); `X-Forwarded-*` only from listed reverse proxies |
| **Open endpoints** | What answers without a sign-in (check-ins, the status page, the guide, acknowledge links, agent reports) is limited per address and minute |
| **Acknowledge links** | One per incident, signed with a key derived from the server key; the page asks before it acknowledges |
| **Push** | Messages encrypted for each device (RFC 8291); the server signs with a VAPID key derived from its own key; only known push services are accepted |
| **SNMPv3** | authPriv only (SHA + AES); the agent's engine ID is pinned before any authenticated message |
| **Docker** | Never the socket: a read-only proxy; a container's environment is dropped |
| **Metrics** | `/metrics` and `/metrics.json` need a token made in Admin (hash stored) and answer only to the addresses listed with it; read-only, names and numbers only |
| **Linux agents** | Own token per machine (hash stored), report-only, never runs what it receives, never updates itself |
| **Uploads and backups** | Images must really be JPEG/PNG/WebP (metadata stripped); SVG logos without scripts or links; a restored backup is checked like input |
| **Docs** | Markdown rendered without `innerHTML`; only http(s) and mailto links |
| **The container** | Runs as uid 10001 after a short root start (folders, key, certificate), with `no-new-privileges`, a read-only image and no capabilities but `NET_RAW`; the CA key stays root's; no secrets in the compose file; the key in its own folder, apart from the data. See [Install with Docker](../getting-started/install-docker.md#how-it-is-protected) |
| **First admin** | Without an admin account, the setup page needs a one-time code from the server's log (new on every start, locked out like sign-in, gone once the account exists) |
| **The service** | Runs as `homelab-dash` (no shell) from root-owned, read-only code, data in a 0700 folder, sandboxed (`ProtectSystem=strict`, `ProtectHome`, no capabilities, syscall filter) |

It never changes a device: there is no button that restarts, switches off or updates hardware, and updates are never installed.

## Good habits

| Do | Why |
|---|---|
| Keep the dashboard private | Public mode shows your lab to anyone who can reach it. Share the status page instead |
| Use read-only accounts everywhere | Then even a leaked secret can't change anything |
| Pin fingerprints, and find out why when one changes | The password only goes to the device you trusted |
| Keep HTTP on *Redirect to HTTPS* | *Serve* sends sign-ins in plain text |
| Keep signed in only on your own devices | If one is lost, sign it out under *Signed-in browsers* |
| Use a unique admin password, or passkeys | Change it if someone may have seen it |
| Treat check-in, acknowledge and webhook addresses like passwords | Anyone who has one can use it |
| Use a socket proxy for Docker | Never give the dashboard the Docker socket |
| Store the backup passphrase in a password manager | A backup holds every password the dashboard knows |
| Restore only your own backups | A restore replaces everything |
| Look at the Log now and then | Failed sign-ins and unexpected changes show there |
| Review changes before installing them | The installed code runs with access to your secrets |
| Keep Node.js and the system updated | Admin → Server shows when Node.js support ends |
