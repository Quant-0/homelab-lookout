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
  jellyfin(req, res, p) {
    if (req.headers['x-emby-token'] !== KEY) return send(res, 401, {});
    if (p === '/Items/Counts') return send(res, 200, { MovieCount: 812, SeriesCount: 97, EpisodeCount: 4211, SongCount: 0 });
    if (p === '/Sessions') return send(res, 200, [{ NowPlayingItem: { Name: 'x' } }, { NowPlayingItem: { Name: 'y' } }, {}]);
  },
  plex(req, res, p) {
    if (req.headers['x-plex-token'] !== KEY) return send(res, 401, {});
    if (p === '/status/sessions') return send(res, 200, { MediaContainer: { size: 1 } });
    if (p === '/library/sections') return send(res, 200, { MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }, { key: '3', type: 'artist' }] } });
    if (p.startsWith('/library/sections/1/all')) return send(res, 200, { MediaContainer: { totalSize: 640 } });
    if (p.startsWith('/library/sections/2/all')) return send(res, 200, { MediaContainer: { totalSize: 55 } });
  },
  tautulli(req, res, p, q) {
    if (q.get('apikey') !== KEY) return send(res, 200, { response: { result: 'error' } });
    return send(res, 200, { response: { data: { stream_count: '2', stream_count_transcode: 1, total_bandwidth: 24500 } } });
  },
  sonarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v3/series') return send(res, 200, new Array(42).fill({}));
    if (p.startsWith('/api/v3/wanted/missing')) return send(res, 200, { totalRecords: 17 });
    if (p.startsWith('/api/v3/queue')) return send(res, 200, { totalRecords: 3 });
  },
  radarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v3/movie') return send(res, 200, [{ hasFile: true }, { hasFile: true }, { hasFile: false }]);
    if (p.startsWith('/api/v3/wanted/missing')) return send(res, 200, { totalRecords: 1 });
    if (p.startsWith('/api/v3/queue')) return send(res, 200, { totalRecords: 0 });
  },
  lidarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v1/artist') return send(res, 200, [{}, {}]);
    if (p.startsWith('/api/v1/wanted/missing')) return send(res, 200, { totalRecords: 9 });
    if (p.startsWith('/api/v1/queue')) return send(res, 200, { totalRecords: 1 });
  },
  prowlarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p === '/api/v1/indexer') return send(res, 200, [{ enable: true }, { enable: true }, { enable: false }]);
    if (p === '/api/v1/indexerstats') return send(res, 200, { indexers: [{ numberOfGrabs: 10, numberOfQueries: 300, numberOfFailedQueries: 2 }, { numberOfGrabs: 5, numberOfQueries: 120, numberOfFailedQueries: 1 }] });
  },
  bazarr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 401, {});
    if (p.startsWith('/api/episodes/wanted')) return send(res, 200, { total: 12 });
    if (p.startsWith('/api/movies/wanted')) return send(res, 200, { total: 4 });
  },
  overseerr(req, res, p) {
    if (req.headers['x-api-key'] !== KEY) return send(res, 403, {});
    if (p === '/api/v1/request/count') return send(res, 200, { pending: 2, processing: 1, approved: 30, available: 25, total: 58 });
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
    if (p === '/api/stats/summary') {
      if (req.headers['x-ftl-sid'] !== 'phsid') return send(res, 401, {});
      return send(res, 200, { queries: { total: 54000, blocked: 8100, percent_blocked: 15 }, gravity: { domains_being_blocked: 210000 } });
    }
  },
  pihole5(req, res, p, q) {
    if (p === '/api/auth') return send(res, 404, 'Not found');
    if (p === '/admin/api.php' && q.get('auth') === KEY) return send(res, 200, { dns_queries_today: 900, ads_blocked_today: 90, ads_percentage_today: 10, domains_being_blocked: 100000 });
  },
  adguard(req, res, p) {
    if (!basicOk(req)) return send(res, 401, {});
    if (p === '/control/stats') return send(res, 200, { num_dns_queries: 20000, num_blocked_filtering: 3000, avg_processing_time: 0.0123 });
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
      { entity_id: 'light.kitchen', state: 'on' }, { entity_id: 'light.hall', state: 'off' }, { entity_id: 'switch.fan', state: 'on' }, { entity_id: 'sensor.temp', state: '21' }]);
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
