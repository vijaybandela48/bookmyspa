// sw.js — minimal service worker. Two jobs: (1) satisfy PWA installability
// criteria (required for the Play Store TWA path), (2) make static assets
// (CSS/JS/icons) load instantly on repeat visits. API calls and pages always
// go to the network first, since booking data must never be stale.

const CACHE_NAME = 'spabook-static-v1';
const STATIC_ASSETS = ['/css/style.css', '/js/api.js', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or non-GET requests — booking/availability data must be live.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

  // Cache-first for known static assets; network for everything else (HTML pages, uploads).
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
