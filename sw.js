/* Sommyart: Bike RUSH service worker.
   Pages: network first (new versions arrive on next launch), cached copy when offline.
   Big static files (engine, music, icons): cached once, kept across game updates. */
const VERSION = '2.12.0';
const PAGES = 'br-pages';
const STATIC = 'br-static-1';
const STATIC_FILES = ['three.min.js', 'coasting.mp3', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const st = await caches.open(STATIC);
    for (const f of STATIC_FILES) {
      if (!(await st.match(f))) { try { await st.add(f); } catch (err) {} }
    }
    const pg = await caches.open(PAGES);
    try { const r = await fetch('./', { cache: 'no-cache' }); if (r.ok) await pg.put('./', r); } catch (err) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== PAGES && k !== STATIC) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isPage(req, url) {
  return req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/news.json') || url.pathname.endsWith('.apk') || url.pathname.startsWith('/download') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/leaderboard')) return;
  if (url.pathname.endsWith('/ads/ads.json')) {
    e.respondWith((async () => {
      const pg = await caches.open(PAGES);
      try { const r = await fetch(url.pathname, { cache: 'no-store' }); if (r.ok) pg.put('ads.json', r.clone()); return r; }
      catch (err) { const c = await pg.match('ads.json'); if (c) return c; throw err; }
    })());
    return;
  }
  if (isPage(req, url)) {
    e.respondWith((async () => {
      const pg = await caches.open(PAGES);
      const net = fetch(req, { cache: 'no-cache' }).then((r) => { if (r.ok) pg.put('./', r.clone()); return r; });
      const timeout = new Promise((res) => setTimeout(() => res(null), 4000));
      try {
        const first = await Promise.race([net, timeout]);
        if (first) return first;
        const cached = await pg.match('./');
        return cached || await net;
      } catch (err) {
        const cached = await pg.match('./');
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const st = await caches.open(STATIC);
    const hit = await st.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok && r.status === 200) st.put(req, r.clone());
    return r;
  })());
});

/* New-track alerts (sent by api/push when a release adds tracks). */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New tracks on Bike RUSH!', {
    body: d.body || 'Tap to ride the new tracks.', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'tracks', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
