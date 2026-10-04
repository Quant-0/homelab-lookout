'use strict';
// Service worker for the installed app. It only keeps the offline screen and the public files it
// needs (style, icon); pages and API data are never cached, so nothing about the lab is stored on
// the device. Pages always come from the server; when it can't be reached, the offline screen.
const CACHE = 'hd-shell-2';
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
