// sw.js — makes BookMySpa installable (PWA / Play Store TWA) and gives an
// offline fallback for static assets. NETWORK-FIRST: users always get the
// latest CSS/JS after a deploy; the cache is only used when offline.
const CACHE_NAME = 'bookmyspa-static-v2';
const STATIC_ASSETS = ['/css/style.css', '/js/api.js', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(STATIC_ASSETS)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET' || !STATIC_ASSETS.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
