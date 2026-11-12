'use strict';
// Climate sensors: a Hue Bridge (paired with its link button, certificate pinned), Home Assistant
// (thermostats and sensors, °F too), a Shelly read when awake and one that pushes, and Zigbee2MQTT
// through a small MQTT broker; names, rooms, devices and limits; alerts for warm, cold, battery and
// silence; the history; °F; removing a source. The mocks live here.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
const CERTS = process.env.MOCK_CERT_DIR;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
let csrf = '';
async function req(method, p, body) {
  const h = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) };
  const r = await fetch(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const json = (res, code, o) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));

// --- a Hue Bridge: the key only after the link button is pressed ---
let pressed = false;
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString().slice(0, 19);
https.createServer({ key: fs.readFileSync(path.join(CERTS, 'key.pem')), cert: fs.readFileSync(path.join(CERTS, 'cert.pem')) }, (q, res) => {
  if (q.method === 'POST' && q.url === '/api') return json(res, 200, pressed ? [{ success: { username: 'hue-key-123' } }] : [{ error: { type: 101, address: '', description: 'link button not pressed' } }]);
  if (q.url === '/api/hue-key-123/sensors') return json(res, 200, {
    1: { type: 'Daylight', name: 'Daylight', state: { daylight: true } },
    5: { type: 'ZLLPresence', name: 'Hall sensor', productname: 'Hue motion sensor', uniqueid: '00:17:88:01:02:00:aa:01-02-0406', state: { presence: true, lastupdated: ago(0.01) }, config: { battery: 80, reachable: true } },
    6: { type: 'ZLLLightLevel', name: 'Hue ambient light sensor 1', uniqueid: '00:17:88:01:02:00:aa:01-02-0400', state: { lightlevel: 20001, lastupdated: ago(0.01) }, config: { battery: 80, reachable: true } },
    7: { type: 'ZLLTemperature', name: 'Hue temperature sensor 1', uniqueid: '00:17:88:01:02:00:aa:01-02-0402', state: { temperature: 2150, lastupdated: ago(0.02) }, config: { battery: 80, reachable: true } },
    8: { type: 'ZLLPresence', name: 'Shed sensor', productname: 'Hue outdoor motion sensor', uniqueid: '00:17:88:01:02:00:bb:02-02-0406', state: { presence: false, lastupdated: ago(10) }, config: { battery: 9, reachable: false } },
    9: { type: 'ZLLTemperature', name: 'Hue temperature sensor 2', uniqueid: '00:17:88:01:02:00:bb:02-02-0402', state: { temperature: 450, lastupdated: ago(10) }, config: { battery: 9, reachable: false } },
  });
  if (q.url.startsWith('/api/') && q.url.endsWith('/sensors')) return json(res, 200, [{ error: { type: 1, address: '/', description: 'unauthorized user' } }]);
  json(res, 404, {});
}).listen(18491, '127.0.0.1');

// --- Home Assistant: a thermostat and its humidity, a garage in °F with motion ---
http.createServer((q, res) => {
  if (q.headers.authorization !== 'Bearer ha-token') return json(res, 401, { message: 'Unauthorized' });
  if (q.url !== '/api/states') return json(res, 404, {});
  const t = new Date().toISOString();
  json(res, 200, [
    { entity_id: 'climate.living_room', state: 'heat', last_updated: t, attributes: { friendly_name: 'Living room', current_temperature: 20.5, temperature: 22, hvac_action: 'heating' } },
    { entity_id: 'sensor.living_room_humidity', state: '45', last_updated: t, attributes: { friendly_name: 'Living room Humidity', device_class: 'humidity', unit_of_measurement: '%' } },
    { entity_id: 'sensor.garage_temperature', state: '39.2', last_updated: t, attributes: { friendly_name: 'Garage Temperature', device_class: 'temperature', unit_of_measurement: '°F' } },
    { entity_id: 'binary_sensor.garage_motion', state: 'on', last_updated: t, attributes: { friendly_name: 'Garage Motion', device_class: 'motion' } },
    { entity_id: 'sensor.house_power', state: '512', last_updated: t, attributes: { device_class: 'power', unit_of_measurement: 'W' } },
    { entity_id: 'sensor.broken_temperature', state: 'unavailable', last_updated: t, attributes: { device_class: 'temperature' } },
  ]);
}).listen(18493, '127.0.0.1');

// --- a Shelly H&T Gen 3, awake (USB powered) ---
http.createServer((q, res) => {
  if (q.url === '/shelly') return json(res, 200, { id: 'shellyhtg3-abc', gen: 3, model: 'S3SN-0U12A', name: 'Bedroom H&T' });
  if (q.url === '/rpc/Shelly.GetStatus') return json(res, 200, { 'temperature:0': { id: 0, tC: 19.4, tF: 66.9 }, 'humidity:0': { id: 0, rh: 51.2 }, 'devicepower:0': { battery: { V: 3.1, percent: 90 } }, sys: {} });
  json(res, 404, {});
}).listen(18492, '127.0.0.1');

// --- an MQTT broker with Zigbee2MQTT's messages ---
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags, body.length]), body]); // bodies under 128 bytes
const publish = (topic, payload, qos = 0) => packet(3, qos << 1, Buffer.concat([str(topic), qos ? Buffer.from([0, 7]) : Buffer.alloc(0), Buffer.from(JSON.stringify(payload))]));
let mqttLogins = [];
net.createServer((sock) => {
  sock.on('data', (d) => {
    const type = d[0] >> 4;
    if (type === 1) {
      // CONNECT: protocol name (6), level, flags, keepalive, client id, user name, password
      let i = 2 + 6 + 1;
      const flags = d[i];
      i += 3;
      const read = () => { const n = d.readUInt16BE(i); const s = d.subarray(i + 2, i + 2 + n).toString(); i += 2 + n; return s; };
      read();
      const user = flags & 0x80 ? read() : null;
      const pass = flags & 0x40 ? read() : null;
      mqttLogins.push({ user, pass });
      sock.write(Buffer.from([0x20, 2, 0, user === 'lookout' && pass === 'mqtt-pass' ? 0 : 5]));
      if (pass !== 'mqtt-pass') sock.end();
    }
    if (type === 8) {
      sock.write(Buffer.from([0x90, 3, 0, 1, 0]));
      sock.write(Buffer.concat([
        publish('z2m/office_sensor', { temperature: 23.4, humidity: 38, battery: 70, linkquality: 80 }),
        publish('z2m/radiator', { local_temperature: 19, current_heating_setpoint: 21, system_mode: 'heat', running_state: 'heat' }),
        publish('z2m/bridge', { state: 'online' }),
        publish('z2m/plug', { power: 10 }),
        publish('z2m/office_sensor/availability', { state: 'online', temperature: 99 }),
        publish('z2m/qos_sensor', { temperature: 10.5 }, 1),
      ]));
    }
  });
  sock.on('error', () => {});
}).listen(18883, '127.0.0.1');

(async () => {
  await sleep(300);
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  const dash = async () => (await req('GET', '/api/dashboard')).json;
  ok((await dash()).climate === null, 'nothing set up: no Climate on Home');
  ok((await req('GET', '/api/admin/alerts')).json.types.climate?.label === 'Room climate', 'Alerts has a Room climate rule');
  const sensor = async (name) => (await dash()).climate.sensors.find((x) => x.name === name);

  // --- Hue: saved, then paired with the link button ---
  let r = await req('POST', '/api/admin/climate/sources', { type: 'hue', name: 'Hue', address: 'not an address!' });
  ok(r.status === 400, 'a bridge address must look like one');
  r = await req('POST', '/api/admin/climate/sources', { type: 'hue', name: 'Hue', address: '127.0.0.1:18491' });
  const hue = r.json.id;
  ok(r.status === 201 && r.json.sources[0].paired === false, 'a Hue Bridge is saved, not paired yet');
  r = await req('POST', `/api/admin/climate/sources/${hue}/test`, {});
  ok(/press the link button/.test(r.json.sources[0].error || ''), 'unpaired, it says to press the link button');
  r = await req('POST', `/api/admin/climate/sources/${hue}/pair`, {});
  ok(r.status === 200 && r.json.waiting === true, 'Pair before the button is pressed: waiting');
  pressed = true;
  r = await req('POST', `/api/admin/climate/sources/${hue}/pair`, {});
  ok(r.json.paired === true && r.json.sources[0].paired && r.json.sources[0].count === 2, 'after the button: paired, two sensors found');
  ok(!JSON.stringify(r.json).includes('hue-key-123') && !JSON.stringify((await req('GET', '/api/admin/config')).json).includes('hue-key-123'), 'the bridge\'s key is never sent back');
  let x = await sensor('Hall sensor');
  ok(x && x.temp === 21.5 && x.motion === true && x.lux === 100 && x.battery === 80 && x.model === 'Hue motion sensor' && x.source === 'hue' && !x.stale, `the motion sensor's parts as one sensor: 21.5 °C, motion, 100 lux, 80 % battery (${JSON.stringify(x && { t: x.temp, l: x.lux })})`);
  const shed = await sensor('Shed sensor');
  ok(shed && shed.temp === 4.5 && shed.stale && shed.reachable === false, 'a sensor not heard from for hours is stale');

  // --- Home Assistant ---
  r = await req('POST', '/api/admin/climate/sources', { type: 'hass', name: 'HA', address: 'http://127.0.0.1:18493', secret: 'ha-token' });
  const ha = r.json.id;
  await req('POST', `/api/admin/climate/sources/${ha}/test`, {});
  x = await sensor('Living room');
  ok(x && x.temp === 20.5 && x.target === 22 && x.heating === true && x.mode === 'heat' && x.humidity === 45 && x.model === 'Thermostat', 'a thermostat: 20.5 °C now, set to 22, heating, with its humidity sensor');
  x = await sensor('Garage');
  ok(x && x.temp === 4 && x.motion === true, 'a sensor in °F becomes °C (39.2 °F = 4 °C), with its motion sensor');
  ok(!(await dash()).climate.sensors.some((y) => /power|broken/i.test(y.name)), 'power and unavailable sensors are left out');

  // --- Shelly: read when awake, and one that pushes ---
  r = await req('POST', '/api/admin/climate/sources', { type: 'shelly', name: 'Bedroom', address: '127.0.0.1:18492' });
  await req('POST', `/api/admin/climate/sources/${r.json.id}/test`, {});
  x = await sensor('Bedroom H&T');
  ok(x && x.temp === 19.4 && x.humidity === 51.2 && x.battery === 90, 'a Shelly H&T Gen 3: temperature, humidity and battery');
  r = await req('POST', '/api/admin/climate/sources', { type: 'shelly', name: 'Bathroom' });
  const pushUrl = r.json.sources.find((y) => y.name === 'Bathroom').pushUrl;
  ok(/\/climate\/push\/[A-Za-z0-9_-]{32}$/.test(pushUrl || ''), 'a Shelly without an address gets a push address');
  const pushPath = new URL(pushUrl).pathname;
  r = await fetch(`${BASE}${pushPath}?hum=62&temp=17.5`);
  ok(r.status === 200, 'a Gen 1 report URL push is taken');
  await fetch(`${BASE}${pushPath}?temp=18`);
  x = await sensor('Bathroom');
  ok(x && x.temp === 18 && x.humidity === 62, 'the next push updates the temperature and keeps the humidity');
  ok((await fetch(`${BASE}/climate/push/${'x'.repeat(32)}?temp=1`)).status === 404, 'a wrong push address is unknown');
  ok((await fetch(`${BASE}${pushPath}?foo=1`)).status === 400, 'a push without readings is refused');

  // --- MQTT: Zigbee2MQTT ---
  r = await req('POST', '/api/admin/climate/sources', { type: 'mqtt', name: 'Zigbee', address: '127.0.0.1:18883', username: 'lookout', secret: 'wrong', base: 'z2m' });
  const mq = r.json.id;
  await sleep(800);
  r = await req('GET', '/api/admin/climate');
  ok(/refused the user name or password/.test(r.json.sources.find((y) => y.id === mq).error || ''), 'a wrong MQTT password: the broker refuses it');
  await req('PUT', `/api/admin/climate/sources/${mq}`, { name: 'Zigbee', address: '127.0.0.1:18883', username: 'lookout', secret: 'mqtt-pass', base: 'z2m' });
  await sleep(800);
  x = await sensor('office_sensor');
  ok(x && x.temp === 23.4 && x.humidity === 38 && x.battery === 70 && x.source === 'mqtt', 'a Zigbee sensor from its topic');
  x = await sensor('radiator');
  ok(x && x.temp === 19 && x.target === 21 && x.heating === true && x.mode === 'heat', 'a radiator thermostat: now, set to, heating');
  const names = (await dash()).climate.sensors.map((y) => y.name);
  ok(!names.includes('bridge') && !names.includes('plug') && names.includes('qos_sensor'), 'the bridge topic, devices without a temperature and deeper topics are left out; QoS 1 messages are read');
  ok(mqttLogins.at(-1).pass === 'mqtt-pass' && !JSON.stringify((await req('GET', '/api/admin/climate')).json).includes('mqtt-pass'), 'the password goes to the broker, never back to the page');

  // --- names, rooms, devices, limits, and the alerts ---
  const all = (await dash()).climate.sensors;
  const hall = all.find((y) => y.name === 'Hall sensor');
  const devId = (await dash()).devices[0]?.id || (await req('POST', '/api/admin/devices', { name: 'atlas', kind: 'server', location: 'rack', u: 10, height: 2 })).json.device.id;
  r = await req('PUT', '/api/admin/climate/sensors', { key: hall.key, name: 'Server room', room: 'Basement', deviceId: devId, max: 21, min: 10 });
  ok(r.status === 200, 'a sensor gets a name, a room, a device and limits');
  r = await req('PUT', '/api/admin/climate/sensors', { key: hall.key, min: 25, max: 20 });
  ok(r.status === 400 && /lower/.test(r.json.error), 'the cold limit must be below the warm one');
  r = await req('PUT', '/api/admin/climate/sensors', { key: 'nope:x', name: 'x' });
  ok(r.status === 400, 'an unknown sensor is refused');
  let d = await dash();
  x = d.climate.sensors.find((y) => y.key === hall.key);
  ok(x.name === 'Server room' && x.room === 'Basement' && x.deviceId === devId && x.customName, 'shown with its own name, room and device');
  let a = d.attention.find((y) => y.key === `climate:${hall.key}:hot`);
  ok(a && a.severity === 'warning' && /is 21.5 °C/.test(a.text) && a.deviceId === devId, `too warm: under Needs you, on its device (${a?.subject}: ${a?.text})`);
  ok(d.attention.some((y) => y.key.endsWith(':battery') && /9 %/.test(y.text)), 'a low battery (9 %) is a warning');
  ok(d.attention.some((y) => y.key.endsWith(':silent') && /stopped reporting/.test(y.text)), 'a sensor silent for 10 hours: stopped reporting');
  await req('PUT', '/api/admin/climate/settings', { unit: 'F' });
  a = (await dash()).attention.find((y) => y.key === `climate:${hall.key}:hot`);
  ok(/70\.7 °F/.test(a?.text || '') && (await dash()).climate.unit === 'F', 'in °F when chosen (21.5 °C = 70.7 °F)');
  await req('PUT', '/api/admin/climate/settings', { unit: 'C' });
  await req('PUT', '/api/admin/climate/sensors', { key: shed.key, hidden: true });
  d = await dash();
  ok(!d.climate.sensors.some((y) => y.key === shed.key) && !d.attention.some((y) => y.key.startsWith(`climate:${shed.key}`)), 'a hidden sensor leaves Home and raises nothing');
  ok((await req('GET', '/api/admin/climate')).json.sensors.some((y) => y.key === shed.key && y.hidden), 'Admin still lists it, to show it again');

  // --- the history, and the wall ---
  const h = await req('GET', `/api/history?range=24h&keys=${encodeURIComponent(`${x.hist}:temp`)}`);
  ok(h.json.series[`${x.hist}:temp`]?.length >= 1, 'temperature is kept for the graphs');
  ok(d.wall.panels.some((p) => p.id === 'climate') && d.wall.hidden.includes('climate'), 'the wall has a Climate panel, hidden at first');

  // --- a source that stops answering, then removed ---
  r = await req('POST', '/api/admin/climate/sources', { type: 'shelly', name: 'Gone', address: '127.0.0.1:18499' });
  await req('POST', `/api/admin/climate/sources/${r.json.id}/test`, {});
  ok((await dash()).attention.some((y) => y.key === `climate:${r.json.id}:source` && /Gone is not answering/.test(y.text)), 'a source that doesn\'t answer is under Needs you');
  r = await req('DELETE', `/api/admin/climate/sources/${hue}`);
  d = await dash();
  ok(r.status === 200 && !d.climate.sensors.some((y) => y.source === 'hue') && !Object.keys((await req('GET', '/api/admin/config')).json).includes('hue-key-123'), 'removing a source removes its sensors and their settings');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CLIMATE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
