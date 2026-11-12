# Climate sensors

Temperature, humidity and thermostats, on Home under **Climate** (a tile per sensor, by room), on the wall display, and on the device a sensor belongs to. Lookout only reads them: it never changes a thermostat or a setting.

Add them in **Admin → Devices → Climate sensors → Add a source**:

| Source | What it reads | How it connects |
|---|---|---|
| **Philips Hue Bridge** | Hue motion sensors (indoor and outdoor): temperature, motion, light level and battery, as one sensor each; other Zigbee temperature and humidity sensors paired to the bridge | Enter the bridge's IP address (the Hue app: Settings → My Hue system), save, then **press the round link button on the bridge and click Pair** within 30 seconds. The bridge's own certificate is pinned when paired |
| **Home Assistant** | Every temperature and humidity sensor, motion sensors, and thermostats (`climate.` entities: the temperature now, the one set, the mode and whether it heats). Sensors with the same name (`living_room_temperature`, `living_room_humidity`) become one. °F is turned into °C | The address and a long-lived access token (your profile → Security) |
| **Shelly** | Shelly H&T (all generations) and Shellies with temperature add-ons: temperature, humidity, battery | A Shelly that is always on (USB powered): its address. A battery H&T sleeps between readings, so leave the address empty and let it **push** to the address Lookout shows (below) |
| **MQTT (Zigbee2MQTT)** | Every Zigbee device Zigbee2MQTT reports with a temperature or humidity: sensors and radiator thermostats (now, set to, mode, heating) | The broker (`host:1883`, or 8883 with TLS), user name, password and Zigbee2MQTT's base topic (`zigbee2mqtt`). Lookout stays connected and reads `<base>/<device>` |

Passwords, tokens and the Hue key are stored encrypted and never shown again.

## Shelly H&T that push

A Shelly without an address gets its own secret address, `https://lookout.example.com/climate/push/<token>`:

- **Gen 1** H&T: Settings → Actions (or *Report sensor values*) → this address. It sends `?hum=…&temp=…&id=…` itself.
- **Gen 2 and newer**: Settings → Webhooks, one on temperature change with `?temp=${ev.tC}` added to the address, and one on humidity change with `?hum=${ev.rh}`.

Each sensor that pushes with its own `id` is a sensor of its own. Anyone with the address can send readings for that source, so keep it to your network.

## The sensors

Below the sources, every sensor that has been read, with:

- **Name** and **Room**: how it shows on Home (grouped by room) and the wall.
- **Device**: the device it belongs to, such as the server whose room it measures. The device's details then show it, and its alerts are on that device.
- **Too cold below** / **Too warm above**: limits for alerts, in the unit chosen (°C or °F, at the top of the card).
- **Show**: untick to leave it off Home, the wall and the alerts.

Click a tile on Home for the details: the temperature and humidity with their graphs (24 hours to two years, like any graph), the thermostat, motion, light, battery, its limits, and when it was last heard from.

## Alerts

The **Room climate** rule on the Alerts tab:

- warmer or colder than a sensor's own limits (critical 5 degrees past the limit);
- the battery at or below a level (15 % unless changed);
- a sensor silent for some hours (6 unless changed);
- a source that doesn't answer (the bridge, Home Assistant, a Shelly or the broker).

On the wall display, tick **Climate** in Customize for a panel with every sensor.
