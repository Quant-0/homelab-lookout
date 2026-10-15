# Reverse proxy and a domain name

The dashboard works on its own address (`https://192.168.1.20:8443`). Putting it behind a reverse proxy with a domain name, like `https://lookout.example.com`, gives you:

- a **public certificate** (Let's Encrypt): no local CA to import on every phone;
- **passkeys**, which need a domain name;
- one address for everything: the app, links in alert messages, push notifications and the Linux agents.

The IP address keeps working either way.

## On the dashboard

**Admin → Server → Address & reverse proxy**:

- **Dashboard address**: the name people use, e.g. `https://lookout.example.com`. The dashboard then answers on that name, and links in messages, push and passkeys use it. If the dashboard's own certificate doesn't cover the name, saving says so (a proxy with its own certificate is fine).
- **Reverse proxies**: the proxy's IP address (or a range like `192.168.1.0/28`). Only connections from these may say who the visitor is (`X-Forwarded-For`) and that they came over https (`X-Forwarded-Proto`). From anywhere else those headers are ignored, so nobody can fake their address to get around the sign-in lockout.
- **This connection** shows what the server sees of your own visit: your address, the name and http/https, and what doesn't add up. A proxy that isn't listed yet gets a **Trust** button.
- **Setting up a proxy** has copy-ready instructions for each proxy below, filled in with your own address and port.

After the proxy starts saying *https*, you sign in once more: a session made over plain http is never carried over to https.

## Point the proxy at the HTTPS port

Forward to **`https://192.168.1.20:8443`**. The HTTP port redirects to HTTPS, which would make the proxy go in circles. The proxy doesn't need to check the dashboard's self-signed certificate.

## Nginx Proxy Manager

1. **Hosts → Proxy Hosts → Add Proxy Host**: Domain Names `lookout.example.com`, Scheme **https**, Forward Hostname `192.168.1.20`, Forward Port `8443`. Websockets and Cache Assets: off.
2. **SSL**: request a Let's Encrypt certificate; turn on **Force SSL** and HTTP/2.
3. NPM sends `X-Forwarded-For` and `X-Forwarded-Proto` by itself.

## Caddy

```
lookout.example.com {
  reverse_proxy https://192.168.1.20:8443 {
    transport http {
      tls_insecure_skip_verify
    }
  }
}
```

## Traefik (file provider)

```yaml
http:
  routers:
    lookout:
      rule: "Host(`lookout.example.com`)"
      entryPoints: [websecure]
      tls:
        certResolver: letsencrypt
      service: lookout
  services:
    lookout:
      loadBalancer:
        servers:
          - url: "https://192.168.1.20:8443"
        serversTransport: lookout-tls
  serversTransports:
    lookout-tls:
      insecureSkipVerify: true
```

## nginx

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name lookout.example.com;
  ssl_certificate     /etc/letsencrypt/live/lookout.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/lookout.example.com/privkey.pem;
  client_max_body_size 64m;

  location / {
    proxy_pass https://192.168.1.20:8443;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Tailscale serve

On the machine the dashboard runs on:

```sh
tailscale serve --bg --https=443 https+insecure://192.168.1.20:8443
```

`https+insecure` tells Tailscale not to check the dashboard's own certificate. Use the machine's Tailscale name (`lookout.your-tailnet.ts.net`) as the Dashboard address, and trust the machine's own address (`192.168.1.20`) as the reverse proxy: that is where Tailscale's connections come from. Only devices in your tailnet can open it.

## Cloudflare Tunnel

In `config.yml` of cloudflared (or the same in the Zero Trust dashboard):

```yaml
ingress:
  - hostname: lookout.example.com
    service: https://192.168.1.20:8443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

Trust the address of the machine cloudflared runs on. This puts the dashboard on the internet: protect it with **Cloudflare Access** (a login before the dashboard).

## Only let the proxy in

Let only the proxy and your own computers reach port 8443 on the dashboard's machine (a firewall rule), so nobody goes around the proxy.

## DNS

The name must point to the proxy (or, without a proxy, to the dashboard). Away from home over Tailscale or WireGuard, your devices must use the DNS server that knows the name (in Tailscale: *split DNS* for your domain).
