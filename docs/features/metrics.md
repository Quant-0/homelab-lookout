# Metrics for Prometheus, Grafana and Home Assistant

Homelab Lookout can hand what it measures to other programs. Prometheus can store it, so Grafana can draw it. Home Assistant can use it in dashboards and automations.

| Address | For | Format |
|---|---|---|
| `/metrics` | Prometheus (and so Grafana) | Prometheus text format |
| `/metrics.json` | Home Assistant's REST sensors, or your own scripts | A short JSON summary |

Both are **read-only**. They never contain addresses, user names or passwords, only names and numbers.

## Making a token

**Admin → Server → Metrics** (direct link: `/admin#metrics`). Make one token per program:

1. **Name**: what reads it, e.g. *Prometheus*.
2. **Used from**: the IP address of that machine, e.g. `192.168.1.30`, or a range like `192.168.1.0/24`. Separate several with commas. From any other address the token is refused, even if someone has it.
3. **Make token**. The token is shown **once**, together with a ready-made Prometheus config and Home Assistant YAML, both with the token filled in. If it gets lost, remove it and make a new one.

The list shows each token's addresses and when it was last read, and from where. **Change** edits the name and addresses. **Remove** stops it at once. Making, changing and removing a token asks for your password if you haven't typed it in the last 15 minutes. These changes go into the Log and the [configuration history](docs-updates-log.md#configuration-history-and-undo).

Behind a [reverse proxy](../getting-started/reverse-proxy.md) that is listed under *Reverse proxies*, the address checked is the real client's (from `X-Forwarded-For`), not the proxy's.

## Prometheus and Grafana

Add a job to `prometheus.yml` (Admin gives you this with your token and address filled in):

```yaml
scrape_configs:
  - job_name: homelab-lookout
    scrape_interval: 30s
    scheme: https
    authorization:
      credentials: <id>.<token>
    tls_config:
      ca_file: /etc/prometheus/lookout-ca.crt
    static_configs:
      - targets: ['lookout.example.com:8443']
```

- **HTTPS:** download the dashboard's CA certificate (Admin → Server → Certificate → **Download CA certificate**) and point `ca_file` at it. Behind a reverse proxy with a public certificate you don't need `tls_config`.
- Polling more often than every 30 seconds gives nothing new: the dashboard itself reads devices every 10–60 seconds.
- In Grafana, add Prometheus as a data source and search for `lookout_`.

Example queries:

| What | PromQL |
|---|---|
| Power now, everything | `lookout_power_watts_total` |
| Power per server | `lookout_power_watts` |
| How full each storage is | `lookout_storage_used_bytes / lookout_storage_size_bytes` |
| Storage that is full within 30 days | `lookout_storage_days_until_full < 30` |
| Services that are down | `lookout_service_up == 0` |
| Hottest sensor per server | `max by (device) (lookout_temperature_celsius)` |
| UPS on battery | `lookout_ups_on_battery == 1` |
| Problems now | `sum(lookout_problems)` |

### What `/metrics` contains

Every value has a `device` label (the device's name in Lookout), plus more labels where they apply.

| Metric | Labels | What |
|---|---|---|
| `lookout_info` | `version` | Always 1 |
| `lookout_device_up` | `device`, `kind` | 1 when any of the device's connections answers |
| `lookout_connection_up`, `…_last_ok_timestamp_seconds` | `connection` (idrac, proxmox, …) | Each connection's last poll |
| `lookout_power_watts` | `source` (idrac, shelly, tasmota, hass) | Measured power per device |
| `lookout_power_watts_total` | | Everything measured (plus estimates if switched on) |
| `lookout_energy_kwh`, `lookout_energy_cost` | `period` (today, month, year), `currency` | Energy and its cost so far |
| `lookout_electricity_price_per_kwh` | `currency` | The price now, all included |
| `lookout_temperature_celsius` | `sensor` | iDRAC/iLO sensors, Synology, agents |
| `lookout_fan_rpm`, `lookout_fan_percent` | `fan` | Server fans |
| `lookout_psu_healthy`, `lookout_hardware_healthy` | `psu` | 1 when the server reports OK |
| `lookout_storage_used_bytes`, `…_size_bytes`, `…_days_until_full` | `storage` | Pools, volumes, Proxmox storage, VM disks, agent filesystems; the forecast from the last 60 days |
| `lookout_cpu_ratio`, `lookout_memory_used_bytes`, `…_total_bytes`, `lookout_load1` | `node` for Proxmox | Proxmox nodes, NAS, SNMP devices |
| `lookout_guest_up`, `lookout_guest_cpu_ratio`, `lookout_guest_memory_*`, `lookout_guest_network_*`, `lookout_guest_disk_*` | `node`, `vmid`, `guest`, `type` | Proxmox VMs and containers |
| `lookout_ups_*` | | On battery, charge, runtime, load, output, input voltage |
| `lookout_ping_seconds` | | Ping connections |
| `lookout_container_up`, `…_restarts`, `…_cpu_ratio`, `…_memory_used_bytes` | `container` | Docker and Portainer |
| `lookout_network_device_*` | `network_device` | UniFi and Omada access points and switches: up, CPU, memory, clients, PoE, temperature |
| `lookout_internet_up`, `…_latency_seconds`, `…_receive_bits_per_second`, `…_transmit_bits_per_second` | | From the UniFi gateway |
| `lookout_service_up`, `…_response_seconds`, `…_certificate_expiry_timestamp_seconds` | `service` | Services' status checks |
| `lookout_problems` | `severity` | Problems now, as under *Needs you* |
| `lookout_problems_muted` | | Of those, muted, behind another outage or in maintenance |
| `lookout_checkin_up`, `…_last_timestamp_seconds` | `checkin` | Check-ins |
| `lookout_agent_*` | `agent` | Linux agents: up, CPU, load, memory, swap, uptime, pending updates, reboot needed, failed units, watched services |

## Home Assistant

Home Assistant reads `/metrics.json` with REST sensors. Admin gives you the YAML. Put the token in `secrets.yaml`:

```yaml
lookout_metrics: "Bearer <id>.<token>"
```

and the sensors in `configuration.yaml`:

```yaml
rest:
  - resource: https://lookout.example.com/metrics.json
    scan_interval: 30
    headers:
      Authorization: !secret lookout_metrics
    sensor:
      - name: Lookout power
        value_template: "{{ value_json.power.watts }}"
        unit_of_measurement: W
        device_class: power
      - name: Lookout problems
        value_template: "{{ value_json.problems.critical + value_json.problems.warning }}"
        json_attributes_path: "$.problems"
        json_attributes: [list]
    binary_sensor:
      - name: Lookout services all up
        value_template: "{{ value_json.services.down == 0 }}"
```

Restart Home Assistant. With the dashboard's own certificate, either add its CA to Home Assistant, or go through a reverse proxy with a public certificate.

The JSON looks like this. Names become keys: *Core Switch* becomes `core_switch`, and a second device with the same name gets `_2`.

```json
{
  "generated_at": "2026-10-15T18:00:00.000Z",
  "problems": { "critical": 0, "warning": 1, "list": [{ "severity": "warning", "subject": "vault", "text": "storage tank is 91 % full" }] },
  "power": { "watts": 312.5, "price_now": 1.42, "today_kwh": 5.1, "today_cost": 7.3, "month_kwh": 101.2, "month_cost": 140.5, "currency": "NOK" },
  "services": { "up": 11, "down": 0, "jellyfin": { "name": "Jellyfin", "up": true, "ms": 12 } },
  "internet": { "up": true, "latency_ms": 9, "down_mbps": 3.2, "up_mbps": 0.4 },
  "devices": {
    "atlas": { "name": "atlas", "kind": "server", "up": true, "problems": 0, "watts": 168, "temp_max": 61 },
    "ups": { "name": "UPS", "kind": "ups", "up": true, "problems": 0, "ups": { "on_battery": false, "charge": 100, "runtime_min": 42, "load": 23 } }
  }
}
```

So `{{ value_json.devices.atlas.up }}` is atlas's status, and `{{ value_json.devices.ups.ups.on_battery }}` can start an automation when the power goes.

## Security

- A token works only for `/metrics` and `/metrics.json`, and only from its addresses. It can't sign in, read the admin pages or change anything.
- From an address no token lists, the answer is *403* before any token is looked at.
- Only a hash of each token is stored. It travels in the `Authorization` header, so use HTTPS (or a trusted network) between Prometheus or Home Assistant and the dashboard.
- Requests are limited per address and minute, like the other endpoints that need no sign-in.
