'use strict';
// Service worker for the installed app. It only keeps the offline screen and the public files it
// needs (style, icon); pages and API data are never cached, so nothing about the lab is stored on
// the device. Pages always come from the server; when it can't be reached, the offline screen.
const CACHE = 'hd-shell-3';
const SHELL = ['/offline', '/static/css/style.css', '/static/js/offline.js', '/static/favicon.svg', '/static/fonts/inter-5.3.0.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return (await event.preloadResponse) || (await fetch(req));
      } catch {
        return (await caches.match('/offline')) || Response.error();
      }
    })());
    return;
  }
  // The offline screen's own files: from the network when possible (so they stay current), the
  // stored copy otherwise. Everything else is left to the browser.
  if (SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(url.pathname, copy)));
      }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || Response.error())));
  }
});

// Push: an alert from the dashboard (Admin → Alerts → Push to the app). The message is encrypted
// for this browser; it carries the title, the text and, for one open problem, its acknowledge link.
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(d.title || d.site || 'Homelab Lookout', {
    body: d.body || '',
    icon: '/logo',
    tag: d.ack ? `ack-${d.ack.split('?')[0]}` : undefined,
    requireInteraction: d.severity === 'critical',
    data: { url: d.url || '/', ack: d.ack || null },
    actions: d.ack ? [{ action: 'ack', title: 'Acknowledge' }] : [],
  }));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  const { url, ack } = n.data || {};
  const open = async (to) => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w && to === '/') return w.focus();
    return self.clients.openWindow(to);
  };
  if (event.action === 'ack' && ack) {
    // straight from the notification: the same form the acknowledge page sends
    const u = new URL(ack, self.location.origin);
    event.waitUntil(fetch(u.pathname, {
      method: 'POST', referrerPolicy: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: u.searchParams.get('t') || '' }),
    }).then((r) => (r.ok ? self.registration.showNotification('Acknowledged', { body: n.title, icon: '/logo', tag: n.tag, silent: true }) : open(ack))).catch(() => open(ack)));
    return;
  }
  event.waitUntil(open(url || '/'));
});
