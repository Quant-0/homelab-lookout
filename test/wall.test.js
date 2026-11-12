'use strict';
// Wall layouts: the default one and named ones (/wall?layout=…), the grid, text size and spacing,
// each kind of panel with its options, what is refused, the graph series, an older layout read
// as the default, devices and services that go away, and deleting a layout.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:18080';
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
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

(async () => {
  await req('POST', '/api/login', { username: 'admin', password: 'correct horse battery' });
  csrf = (await req('GET', '/api/session')).json.csrf;
  let d = (await req('GET', '/api/dashboard')).json;
  ok(d.walls.length === 1 && d.wall.slug === 'default' && d.wall.cols === 3 && d.wall.rows === 0 && d.wall.scale === 100 && d.wall.panels.map((p) => p.type).join() === 'spot,power,rack,list,net', 'one default layout: 3 columns, the usual panels');
  const dev = (await req('POST', '/api/admin/devices', { name: 'atlas', kind: 'server', location: 'rack', u: 10, height: 2 })).json.device;
  const svc = (await req('POST', '/api/admin/services', { name: 'Wiki', group: 'Apps', icon: { kind: 'letter' }, connection: null, integration: null })).json.service;

  // a named layout with every new kind of panel
  const kitchen = {
    slug: 'kitchen', name: 'Kitchen tablet', cols: 4, rows: 3, scale: 130, gap: 'roomy',
    top: { logo: false, clock: true, vmCount: false }, services: { show: true, list: [svc.id] },
    panels: [
      { type: 'clock', w: 2, h: 1, opts: { date: true, seconds: true } },
      { type: 'device', w: 1, h: 2, title: 'The server', opts: { deviceId: dev.id } },
      { type: 'service', opts: { serviceId: svc.id } },
      { type: 'graph', w: 2, opts: { key: 'power:total', range: '7d', unit: 'W', label: 'Power draw' } },
      { type: 'note', title: '', opts: { text: 'Wi-Fi: Guests\nPassword: on the fridge', size: 'large' } },
      { type: 'power', opts: { range: '30d', show: ['chart', 'price', 'bogus'] } },
      { type: 'spot', opts: { seconds: 20 } },
    ],
  };
  let r = await req('PUT', '/api/admin/wall', kitchen);
  const k = r.json?.layout;
  ok(r.status === 200 && k.slug === 'kitchen' && k.cols === 4 && k.rows === 3 && k.scale === 130 && k.gap === 'roomy' && r.json.walls.length === 2, 'a named layout: 4 columns, 3 rows, larger text, more space');
  ok(k.panels.length === 7 && k.panels.every((p) => /^[A-Za-z0-9_-]+$/.test(p.uid)) && new Set(k.panels.map((p) => p.uid)).size === 7, 'each panel gets its own id');
  ok(k.panels[0].w === 2 && k.panels[1].title === 'The server' && k.panels[4].title === '' && k.panels[2].title === null, 'sizes and titles: its own, none, or the usual');
  ok(k.panels[5].opts.range === '30d' && k.panels[5].opts.show.join() === 'chart,price' && k.panels[6].opts.seconds === 20 && k.panels[4].opts.text.includes('\n'), 'each panel\'s options are kept, unknown ones dropped');
  ok(k.top.logo === false && k.services.list[0] === svc.id, 'the top bar and the services picked');
  d = (await req('GET', '/api/dashboard')).json;
  ok(d.walls.map((l) => l.slug).join() === 'default,kitchen' && d.wall.slug === 'default', 'the dashboard sends every layout, and the default one as before');

  // what is refused
  const bad = async (change, what, re) => {
    const res = await req('PUT', '/api/admin/wall', { ...kitchen, ...change });
    ok(res.status === 400 && (!re || re.test(res.json.error)), `refused: ${what}${res.json?.error ? ` (${res.json.error})` : ''}`);
  };
  await bad({ slug: 'Kitchen!' }, 'an address with capitals or signs', /lowercase/);
  await bad({ cols: 7 }, '7 columns');
  await bad({ panels: [{ type: 'evil' }] }, 'an unknown panel', /Unknown/);
  await bad({ panels: [{ type: 'power' }, { type: 'power' }] }, 'two power panels', /once/);
  await bad({ panels: [{ type: 'clock', w: 5 }] }, 'wider than the grid');
  await bad({ panels: [{ type: 'device', opts: { deviceId: 'nope' } }] }, 'a device that doesn\'t exist', /device/);
  await bad({ panels: [{ type: 'graph', opts: { key: 'not-a-series' } }] }, 'a graph of nothing', /graph/);
  await bad({ scale: 300 }, 'text at 300 %');
  r = await req('PUT', '/api/admin/wall', { ...kitchen, panels: [{ type: 'clock' }, { type: 'clock' }, { type: 'note', opts: { text: 'a' } }, { type: 'note', opts: { text: 'b' } }] });
  ok(r.status === 200 && r.json.layout.panels.length === 4, 'clocks, notes, graphs and single devices can be there more than once');

  // the graph series
  const series = (await req('GET', '/api/admin/wall/series')).json.series;
  ok(series.some((x) => x.key === 'power:total' && x.unit === 'W'), `the graph panel lists the series this dashboard keeps (${series.length})`);

  // devices and services that go away leave the layouts with them
  await req('PUT', '/api/admin/wall', kitchen);
  await req('DELETE', `/api/admin/devices/${dev.id}`);
  d = (await req('GET', '/api/dashboard')).json;
  ok(!d.walls.find((l) => l.slug === 'kitchen').panels.some((p) => p.type === 'device'), 'a removed device\'s panel goes away');

  // deleting a layout; the default one stays
  r = await req('DELETE', '/api/admin/wall/kitchen');
  ok(r.status === 200 && r.json.walls.length === 1, 'a named layout can be deleted');
  r = await req('DELETE', '/api/admin/wall/default');
  ok(r.status === 400, 'the default one stays');
  r = await req('PUT', '/api/admin/wall', { reset: true });
  ok(r.status === 200 && r.json.wall.panels.length === 5, 'reset: the default panels again');
  ok((await fetch(`${BASE}/api/admin/wall/series`)).status === 401, 'a stranger gets nothing');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL WALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
