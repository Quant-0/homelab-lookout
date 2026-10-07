'use strict';
// Plain-HTTP mock of the service APIs, one per path prefix: http://127.0.0.1:18090/<integration>/...
const http = require('node:http');
const KEY = 'svc-key-123';
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const basicOk = (req) => req.headers.authorization === 'Basic ' + Buffer.from(`admin:${KEY}`).toString('base64');
let piholeLogins = 0;

const routes = {
  // like Jellyfin 10.11+: the old X-Emby-Token header is refused
  jellyfin(req, res, p) {
    if (req.headers.authorization !== `MediaBrowser Token="${KEY}"`) return send(res, 401, {});
    return routes.emby(req, res, p, null, true);
  },
  emby(req, res, p, q, authed) {
    if (!authed && req.headers['x-emby-token'] !== KEY) return send(res, 401, {});
    if (p === '/Items/Counts') return send(res, 200, { MovieCount: 812, SeriesCount: 97, EpisodeCount: 4211, SongCount: 0 });
    if (p === '/Sessions') return send(res, 200, [{ NowPlayingItem: { Name: 'x' } }, { NowPlayingItem: { Name: 'y' } }, {}]);
  },
  plex(req, res, p) {
    if (req.headers['x-plex-token'] !== KEY) return send(res, 401, {});
    if (p === '/status/sessions') return send(res, 200, { MediaContainer: { size: 1 } });
    if (p === '/library/sections') return send(res, 200, { MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }, { key: '3', type: 'artist' }] } });
    if (p.startsWith('/library/sections/1/all')) return send(res, 200, { MediaContainer: { totalSize: 640 } });
    if (p.startsWith('/library/sections/2/all')) return send(res, 200, { MediaContainer: { totalSize: 55 } });
    if (p === '/updater/status') return send(res, 200, { MediaContainer: { canInstall: false, Release: [{ version: '1.41.3.9314-a0bfb8370', added: 'New things' }] } });
  },
  tautulli(req, res, p, q) {
    if (q.get('apikey') !== KEY) return send(res, 200, { response: { result: 'error' } });
    if (q.get('cmd') === 'update_check') return send(res, 200, { response: { result: 'success', data: { update: false } } });
    return send(res, 200, { response: { data: { stream_count: '2', stream_count_transcode: 1, total_bandwidth: 24500 } } });
  },
  sonarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v3/series') return send(res, 200, new Array(42).fill({}));
    if (p.startsWith('/api/v3/wanted/missing')) return send(res, 200, { totalRecords: 17 });
    if (p.startsWith('/api/v3/queue')) return send(res, 200, { totalRecords: 3 });
    if (p === '/api/v3/update') return send(res, 200, [{ version: '4.0.11.2680', installed: false, installable: true, latest: true }, { version: '4.0.10.2544', installed: true, installable: false }]);
  },
  radarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v3/movie') return send(res, 200, [{ hasFile: true }, { hasFile: true }, { hasFile: false }]);
    if (p.startsWith('/api/v3/wanted/missing')) return send(res, 200, { totalRecords: 1 });
    if (p.startsWith('/api/v3/queue')) return send(res, 200, { totalRecords: 0 });
    if (p === '/api/v3/update') return send(res, 200, [{ version: '5.14.0.9383', installed: true, installable: false, latest: true }]);
  },
  lidarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v1/artist') return send(res, 200, [{}, {}]);
    if (p.startsWith('/api/v1/wanted/missing')) return send(res, 200, { totalRecords: 9 });
    if (p.startsWith('/api/v1/queue')) return send(res, 200, { totalRecords: 1 });
    if (p === '/api/v1/update') return send(res, 200, [{ version: '2.8.2.4493', installed: true, latest: true }]);
  },
  prowlarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v1/indexer') return send(res, 200, [{ enable: true }, { enable: true }, { enable: false }]);
    if (p === '/api/v1/indexerstats') return send(res, 200, { indexers: [{ numberOfGrabs: 10, numberOfQueries: 300, numberOfFailedQueries: 2 }, { numberOfGrabs: 5, numberOfQueries: 120, numberOfFailedQueries: 1 }] });
    if (p === '/api/v1/update') return send(res, 200, [{ version: '1.28.2.4885', installed: false, latest: true }, { version: '1.27.0.4852', installed: true }]);
  },
  bazarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p.startsWith('/api/episodes/wanted')) return send(res, 200, { total: 12 });
    if (p.startsWith('/api/movies/wanted')) return send(res, 200, { total: 4 });
  },
  overseerr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 403, {});
    if (p === '/api/v1/request/count') return send(res, 200, { pending: 2, processing: 1, approved: 30, available: 25, total: 58 });
    if (p === '/api/v1/status') return send(res, 200, { version: '2.1.0', commitTag: 'v2.1.0', updateAvailable: true, commitsBehind: 0 });
  },
  qbittorrent(req, res, p) {
    if (p === '/api/v2/auth/login') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const f = new URLSearchParams(b);
        if (!req.headers.referer) return send(res, 401, 'Fails.');
        const name = req.headers.referer.includes('/qbittorrent5') ? 'QBT_SID_8080' : 'SID';
        if (f.get('username') === 'admin' && f.get('password') === KEY) return send(res, 200, 'Ok.', { 'Set-Cookie': name + '=qbsid123; HttpOnly; path=/' });
        send(res, 200, 'Fails.');
      });
      return true;
    }
    if (!/(^|; )(SID|QBT_SID_8080)=qbsid123/.test(req.headers.cookie || '')) return send(res, 403, 'Forbidden');
    if (p === '/api/v2/transfer/info') return send(res, 200, { dl_info_speed: 5242880, up_info_speed: 1048576 });
    if (p === '/api/v2/torrents/info') return send(res, 200, [{ state: 'downloading' }, { state: 'stalledDL' }, { state: 'uploading' }, { state: 'stalledUP' }, { state: 'pausedUP' }]);
  },
  transmission(req, res, p) {
    if (p !== '/transmission/rpc') return;
    if (!basicOk(req)) return send(res, 401, 'Unauthorized');
    if (req.headers['x-transmission-session-id'] !== 'tsid') return send(res, 409, 'Conflict', { 'X-Transmission-Session-Id': 'tsid' });
    return send(res, 200, { arguments: { downloadSpeed: 2000000, uploadSpeed: 300000, activeTorrentCount: 4, torrentCount: 20 }, result: 'success' });
  },
  sabnzbd(req, res, p, q) {
    if (q.get('apikey') !== KEY) return send(res, 200, { status: false, error: 'API Key Incorrect' });
    return send(res, 200, { queue: { kbpersec: '1024.5', noofslots: 3, timeleft: '0:12:30' } });
  },
  // Synology DSM's Web API: login for a session ID, then three reads (the storage one for administrators)
  synology(req, res, p) {
    if (p !== '/webapi/entry.cgi' || req.method !== 'POST') return;
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const f = new URLSearchParams(b);
      const fail = (code) => send(res, 200, { success: false, error: { code } });
      if (f.get('api') === 'SYNO.API.Auth') return f.get('account') === 'dsmview' && f.get('passwd') === KEY ? send(res, 200, { success: true, data: { sid: 'DSMSID' } }) : fail(400);
      if (f.get('_sid') !== 'DSMSID') return fail(119);
      if (f.get('api') === 'SYNO.Core.System.Utilization') return send(res, 200, { success: true, data: { cpu: { user_load: 7, system_load: 3, other_load: 1 }, memory: { real_usage: 42, total_real: 8000000 } } });
      if (f.get('api') === 'SYNO.Core.System') return send(res, 200, { success: true, data: { up_time: '100:30:15', sys_temp: 41, model: 'DS418' } });
      if (f.get('api') === 'SYNO.Storage.CGI.Storage') return send(res, 200, { success: true, data: { volumes: [{ vol_path: '/volume1', size: { total: '4000000000000', used: '1000000000000' } }], disks: [{ overview_status: 'normal' }, { overview_status: 'warning' }] } });
      fail(103);
    });
    return true;
  },
  // PeaNUT: the NUT variables of one UPS as JSON
  peanut(req, res, p) {
    if (p === '/api/v1/devices/rackups') return send(res, 200, { 'ups.status': 'OB DISCHRG', 'battery.charge': 55, 'battery.runtime': 1200, 'ups.load': 31, 'device.model': 'Back-UPS' });
    if (p.startsWith('/api/v1/devices/')) return send(res, 404, { error: 'not found' });
  },
  // Tailscale's API (TAILSCALE_API_URL points here in the tests)
  tailscale(req, res, p) {
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { message: 'API token invalid' });
    if (p === '/api/v2/tailnet/-/devices?fields=all') {
      const day = 86400000;
      const iso = (ms) => new Date(Date.now() + ms).toISOString();
      return send(res, 200, { devices: [
        { hostname: 'lookout', connectedToControl: true, expires: iso(100 * day), updateAvailable: false },
        { hostname: 'laptop', connectedToControl: true, expires: iso(5 * day), updateAvailable: true },
        { hostname: 'phone', connectedToControl: false, expires: iso(-day) },
        { hostname: 'nas', connectedToControl: true, keyExpiryDisabled: true, expires: '0001-01-01T00:00:00Z' },
      ] });
    }
  },
  pihole(req, res, p) {
    if (p === '/api/auth' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        piholeLogins++;
        const ok = JSON.parse(b || '{}').password === KEY;
        send(res, ok ? 200 : 401, { session: { valid: ok, sid: ok ? 'phsid' : null } });
      });
      return true;
    }
    if (p === '/api/info/version') {
      if (req.headers['x-ftl-sid'] !== 'phsid') return send(res, 401, {});
      return send(res, 200, { version: { core: { local: { version: 'v6.0.4' }, remote: { version: 'v6.0.5' } }, web: { local: { version: 'v6.0.1' }, remote: { version: 'v6.0.1' } }, ftl: { local: { version: 'v6.0.3' }, remote: { version: 'v6.0.3' } } } });
    }
    if (p === '/api/stats/summary') {
      if (req.headers['x-ftl-sid'] !== 'phsid') return send(res, 401, {});
      return send(res, 200, { queries: { total: 54000, blocked: 8100, percent_blocked: 15 }, gravity: { domains_being_blocked: 210000 } });
    }
  },
  pihole5(req, res, p, q) {
    if (p === '/api/auth') return send(res, 404, 'Not found');
    if (p === '/admin/api.php' && q.get('auth') === KEY && q.has('versions')) return send(res, 200, { core_update: false, web_update: false, FTL_update: true, core_current: 'v5.18.3', core_latest: 'v5.18.3', web_current: 'v5.21', web_latest: 'v5.21', FTL_current: 'v5.25.1', FTL_latest: 'v5.25.2' });
    if (p === '/admin/api.php' && q.get('auth') === KEY) return send(res, 200, { dns_queries_today: 900, ads_blocked_today: 90, ads_percentage_today: 10, domains_being_blocked: 100000 });
  },
  adguard(req, res, p) {
    if (!basicOk(req)) return send(res, 401, {});
    if (p === '/control/stats') return send(res, 200, { num_dns_queries: 20000, num_blocked_filtering: 3000, avg_processing_time: 0.0123 });
    if (p === '/control/status') return send(res, 200, { version: 'v0.107.54' });
    if (p === '/control/version.json' && req.method === 'POST') return send(res, 200, { new_version: 'v0.107.55', announcement_url: 'https://github.com/AdguardTeam/AdGuardHome/releases/tag/v0.107.55', can_autoupdate: true });
  },
  npm(req, res, p) {
    if (p === '/api/tokens' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b || '{}');
        if (j.identity === 'admin@example.com' && j.secret === KEY) return send(res, 200, { token: 'npmtoken', expires: 'x' });
        send(res, 401, { error: { message: 'Invalid' } });
      });
      return true;
    }
    if (req.headers.authorization !== 'Bearer npmtoken') return send(res, 401, {});
    if (p === '/api/nginx/proxy-hosts') return send(res, 200, [{ enabled: true }, { enabled: true }, { enabled: false }]);
  },
  traefik(req, res, p) {
    if (p === '/api/overview') return send(res, 200, { http: { routers: { total: 14, errors: 1 }, services: { total: 12, errors: 0 }, middlewares: { total: 5 } } });
  },
  homeassistant(req, res, p) {
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, {});
    if (p === '/api/states') return send(res, 200, [
      { entity_id: 'person.alice', state: 'home' }, { entity_id: 'person.bob', state: 'not_home' },
      { entity_id: 'light.kitchen', state: 'on' }, { entity_id: 'light.hall', state: 'off' }, { entity_id: 'switch.fan', state: 'on' }, { entity_id: 'sensor.temp', state: '21' },
      { entity_id: 'update.home_assistant_core_update', state: 'on', attributes: { title: 'Home Assistant Core', installed_version: '2026.9.3', latest_version: '2026.10.0', release_url: 'https://www.home-assistant.io/blog/' } },
      { entity_id: 'update.home_assistant_operating_system_update', state: 'off', attributes: { title: 'Home Assistant Operating System', installed_version: '16.2', latest_version: '16.2' } }]);
  },
  nextcloud(req, res, p) {
    if (req.headers['nc-token'] !== KEY || req.headers['ocs-apirequest'] !== 'true') return send(res, 401, {});
    if (p.startsWith('/ocs/v2.php/apps/serverinfo/api/v1/info')) return send(res, 200, { ocs: { data: { activeUsers: { last24hours: 3 }, nextcloud: { storage: { num_files: 123456 }, system: { freespace: 1.5e12, cpuload: [0.42, 0.3, 0.2] } } } } });
  },
  immich(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/server/statistics') return send(res, 404, {});
    if (p === '/api/server-info/statistics') return send(res, 200, { photos: 30000, videos: 1200, usage: 512e9, usageByUser: [{}, {}] });
  },
  paperless(req, res, p) {
    if (req.headers.authorization !== `Token ${KEY}`) return send(res, 401, {});
    if (p === '/api/statistics/') return send(res, 200, { documents_total: 1500, documents_inbox: 7 });
    if (p === '/api/remote_version/') return send(res, 200, { version: 'v2.18.4', update_available: false });
  },
  uptimekuma(req, res, p) {
    if (p === '/api/status-page/heartbeat/homelab') return send(res, 200, {
      heartbeatList: { 1: [{ status: 0 }, { status: 1 }], 2: [{ status: 1 }], 3: [{ status: 0 }] },
      uptimeList: { '1_24': 0.99, '2_24': 1, '3_24': 0.5 },
    });
  },
  grafana(req, res, p) {
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, {});
    if (p === '/api/admin/stats') return send(res, 200, { dashboards: 12, datasources: 3, alerts: 4, users: 2 });
  },
  portainer(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/endpoints') return send(res, 200, [{ Id: 2 }]);
    if (p === '/api/system/version') return send(res, 200, { ServerVersion: '2.21.4', LatestVersion: '2.27.1', UpdateAvailable: true });
    if (p.startsWith('/api/endpoints/2/docker/containers/json')) return send(res, 200, [{ State: 'running' }, { State: 'running' }, { State: 'exited' }]);
  },
  speedtest(req, res, p) {
    if (p === '/api/v1/results/latest') {
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, {});
      return send(res, 200, { data: { download_bits: 912000000, upload_bits: 487000000, ping: 7.4 } });
    }
  },
  prometheus(req, res, p) {
    if (p.startsWith('/api/v1/targets')) return send(res, 200, { data: { activeTargets: [{ health: 'up' }, { health: 'up' }, { health: 'down' }] } });
  },
  authentik(req, res, p) {
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 403, {});
    if (p.startsWith('/api/v3/core/users/')) return send(res, 200, { pagination: { count: 5 } });
    if (p === '/api/v3/admin/version/') return send(res, 200, { version_current: '2025.8.1', version_latest: '2025.8.1', outdated: false });
    if (p.includes('action=login_failed')) return send(res, 200, { pagination: { count: 2 } });
    if (p.startsWith('/api/v3/events/events/')) return send(res, 200, { pagination: { count: 14 } });
  },
  custom(req, res, p) {
    if (p === '/stats' && req.headers['x-token'] === KEY) return send(res, 200, { data: { users: 7, nested: { up: 'yes' } }, list: [1, 2] });
    if (p === '/stats') return send(res, 401, {});
  },
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const [, name, ...rest] = u.pathname.split('/');
  const p = '/' + rest.join('/');
  const route = routes[name === 'qbittorrent5' ? 'qbittorrent' : name];
  if (name === '__stats') return send(res, 200, { piholeLogins });
  if (!route) return send(res, 404, {});
  const handled = route(req, res, p + (u.search && !['tautulli', 'sabnzbd', 'pihole5'].includes(name) ? u.search : ''), u.searchParams);
  if (!handled && !res.headersSent) send(res, 404, { error: 'not found', path: p });
}).listen(18090, '127.0.0.1', () => console.log('services mock on 18090'));
