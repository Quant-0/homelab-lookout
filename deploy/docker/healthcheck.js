'use strict';
// Docker's health check: does the dashboard answer on its HTTPS (or HTTP) port? Any answer counts;
// the certificate is the dashboard's own, so it isn't checked here.
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

// the address and first-start ports the entrypoint chose
const [host = '127.0.0.1', httpsPort, httpPort] = fs.readFileSync('/tmp/lookout-run', 'utf8').trim().split(' ');
let server = {};
try {
  server = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR || '/data'}/config.json`, 'utf8')).settings?.server || {};
} catch {
  /* first start: the defaults */
}
const httpsOn = server.https?.enabled !== false;
const port = httpsOn ? server.https?.port || Number(httpsPort) || 8443 : server.http?.port || Number(httpPort) || 8080;
const lib = httpsOn ? https : http;
const req = lib.get({ host, port, path: '/login', rejectUnauthorized: false, timeout: 4000, headers: { Host: `${host.includes(':') ? `[${host}]` : host}:${port}` } }, (res) => {
  res.resume();
  process.exit(res.statusCode < 500 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
