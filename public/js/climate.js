'use strict';
// Climate on Home, on a device and on the wall display: temperature, humidity and thermostats from
// a Hue Bridge, Home Assistant, Shelly sensors or Zigbee2MQTT (Admin → Devices → Climate sensors).
// The data comes with /api/dashboard as `climate` (null when nothing is set up). Read only.

const Climate = (() => {
  const { el, fmt } = HD;
  let unit = 'C';
  const temp = (c, d = 1) => (c === null || c === undefined ? '–' : `${fmt.n(unit === 'F' ? c * 1.8 + 32 : c, d)}°`);
  const unitLabel = () => (unit === 'F' ? '°F' : '°C');
  const ago = (ms) => fmt.ago(ms);
  const SOURCE_NAMES = { hue: 'Hue', hass: 'Home Assistant', shelly: 'Shelly', mqtt: 'Zigbee2MQTT' };

  // Its state: too warm or cold for its own limits, silent, or fine
  function stateOf(x) {
    if (x.stale || x.reachable === false) return 'off';
    if (x.temp !== null && ((x.max !== null && x.temp > x.max) || (x.min !== null && x.temp < x.min))) return 'warning';
    return 'good';
  }

  // the small facts under the temperature
  function facts(x) {
    return [
      x.humidity !== null ? el('span', null, HD.icon('droplet'), `${fmt.n(x.humidity)} %`) : null,
      x.target !== null ? el('span', { title: `Set to ${temp(x.target)}${x.mode ? `, ${x.mode}` : ''}` }, x.heating ? HD.icon('flame', 'flame') : null, `→ ${temp(x.target)}`) : null,
      x.motion ? el('span', { class: 'cl-motion', title: 'Motion now' }, HD.icon('activity'), 'Motion') : null,
      x.battery !== null && x.battery <= 20 ? el('span', { class: 'warning-text', title: `Battery ${x.battery} %` }, HD.icon('battery-low'), `${x.battery} %`) : null,
    ].filter(Boolean);
  }

  // one tile per sensor, grouped by room
  function card(c, onOpen) {
    unit = c.unit;
    const rooms = new Map();
    for (const x of c.sensors) rooms.set(x.room || '', [...(rooms.get(x.room || '') || []), x]);
    const failing = c.sources.filter((s) => s.ok === false);
    return el('div', { class: 'clim' },
      failing.length ? el('p', { class: 'small warning-text', text: failing.map((s) => `${s.name}: ${s.error}`).join(' · ') }) : null,
      c.sensors.length ? [...rooms].map(([room, list]) => el('div', { class: 'clim-room' },
        room ? el('h3', { class: 'clim-room-name', text: room }) : null,
        el('div', { class: 'clim-tiles' }, list.map((x) => {
          const t = el('button', { type: 'button', class: `clim-tile ${stateOf(x)}`, 'aria-label': `${x.name}, ${temp(x.temp)}` },
            el('span', { class: 'clim-name' }, el('span', { class: `dot ${stateOf(x)}` }), x.name),
            el('span', { class: 'clim-temp' }, x.temp !== null ? temp(x.temp) : x.humidity !== null ? `${fmt.n(x.humidity)} %` : '–'),
            el('span', { class: 'clim-facts' }, facts(x)));
          t.addEventListener('click', () => onOpen(x.key));
          return t;
        })))) : el('p', { class: 'small muted', text: 'No sensors yet: waiting for the first readings.' }));
  }

  // the details of one sensor, with its graphs
  function detail(c, key, devices = [], loggedIn = false) {
    unit = c.unit;
    const x = c.sensors.find((y) => y.key === key);
    if (!x) return el('p', { class: 'muted', text: 'This sensor is no longer reported.' });
    const dev = devices.find((d) => d.id === x.deviceId);
    const kv = [
      ['Temperature', x.temp !== null ? temp(x.temp) : null],
      ['Humidity', x.humidity !== null ? `${fmt.n(x.humidity, 1)} %` : null],
      ['Set to', x.target !== null ? `${temp(x.target)}${x.mode ? ` (${x.mode})` : ''}` : null],
      ['Heating', x.heating === null ? null : x.heating ? 'Yes' : 'No'],
      ['Motion', x.motion === null ? null : x.motion ? 'Now' : 'None'],
      ['Light', x.lux !== null ? `${fmt.n(x.lux)} lux` : null],
      ['Battery', x.battery !== null ? `${x.battery} %` : null],
      ['Limits', x.min !== null || x.max !== null ? [x.min !== null ? `cold below ${temp(x.min)}` : null, x.max !== null ? `warm above ${temp(x.max)}` : null].filter(Boolean).join(', ') : null],
      ['Last reading', ago(x.at)],
      ['From', `${x.sourceName} (${SOURCE_NAMES[x.source]})${x.model ? ` · ${x.model}` : ''}`],
    ].filter(([, v]) => v !== null);
    return el('article', { class: 'detail clim-card' },
      el('header', { class: 'd-head' },
        el('span', { class: 'tile-icon' }, HD.icon(x.target !== null ? 'flame' : 'thermometer')),
        el('div', { class: 't' }, el('h2', { text: x.name }), el('p', { text: [x.room, dev ? `at ${dev.name}` : null].filter(Boolean).join(' · ') || 'Climate sensor' })),
        HD.status(stateOf(x) === 'off' ? 'Silent' : stateOf(x) === 'warning' ? 'Outside its limits' : 'OK', stateOf(x) === 'off' ? '' : stateOf(x))),
      x.stale ? el('div', { class: 'callout warning' }, el('b', { text: 'No new readings' }), el('span', { class: 'small', text: `The last one was ${ago(x.at)}.` })) : null,
      el('div', { class: 'big-num' }, x.temp !== null ? temp(x.temp) : '–', x.humidity !== null ? el('small', { text: `${fmt.n(x.humidity)} % humidity` }) : null),
      el('div', { class: 'sect-head' }, HD.rangeTabs()),
      el('div', { class: 'sparks' }, [x.temp !== null ? HD.sparkSlot(`${x.hist}:temp`, { label: 'Temperature', unit: ' °C', decimals: 1 }) : null, x.humidity !== null ? HD.sparkSlot(`${x.hist}:hum`, { label: 'Humidity', unit: ' %', decimals: 0 }) : null].filter(Boolean)),
      el('div', { class: 'kv' }, kv.map(([k, v]) => el('div', null, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })))),
      loggedIn ? el('div', { class: 'detail-actions' }, dev ? el('a', { class: 'button', href: `/#device-${dev.id}` }, HD.icon('server'), dev.name) : null, el('a', { class: 'button ghost', href: '/admin#climate' }, HD.icon('pencil'), 'Edit in Admin')) : null);
  }

  // on a device's details: the sensors tied to it
  function deviceSection(c, deviceId) {
    if (!c) return null;
    unit = c.unit;
    const list = c.sensors.filter((x) => x.deviceId === deviceId);
    if (!list.length) return null;
    return el('section', { class: 'd-climate' }, el('h4', { text: 'Climate' }),
      el('ul', null, list.map((x) => el('li', null, el('span', { class: `dot ${stateOf(x)}` }), el('span', { text: x.name }), el('strong', { class: 'num', text: x.temp !== null ? temp(x.temp) : '–' }), el('span', { class: 'small muted', text: [x.humidity !== null ? `${fmt.n(x.humidity)} %` : null, x.stale ? 'silent' : ago(x.at)].filter(Boolean).join(' · ') })))));
  }

  // the wall: every sensor with its temperature, as many as fit
  function wallPanel(box, c) {
    unit = c.unit;
    box.onclick = () => (location.href = '/#climate');
    box.replaceChildren(
      el('div', { class: 'lbl' }, HD.icon('thermometer'), 'Climate', el('span', { class: 'r', text: unitLabel() })),
      el('ul', { class: 'clim-wall' }, c.sensors.map((x) => el('li', { class: stateOf(x) },
        el('span', { class: `dot ${stateOf(x)}` }),
        el('b', { text: x.room && !x.name.toLowerCase().includes(x.room.toLowerCase()) ? `${x.room} · ${x.name}` : x.name }),
        el('span', { class: 'small', text: x.humidity !== null ? `${fmt.n(x.humidity)} %` : '' }),
        el('strong', { class: 'num' }, x.target !== null && x.heating ? HD.icon('flame', 'flame') : null, x.temp !== null ? temp(x.temp) : '–')))));
  }

  return { card, detail, deviceSection, wallPanel, stateOf, temp };
})();
