// ──────────────────────────────────────────────
// EduCore service worker (Phase 8.7)
//
// Scope of ambition, deliberately:
//   • offline app shell — navigations fall back to the cached /offline page
//     so a corridor with no wifi shows the app, not a dinosaur
//   • pass-through for everything else — API calls, RSC payloads and static
//     assets go to the network untouched
//
// NOT cached: API responses. Offline attendance does NOT live here — it is
// an IndexedDB outbox owned by the attendance screen (see
// src/lib/offline-attendance.ts). The SW's only job is the shell.
// ──────────────────────────────────────────────

const CACHE = 'educore-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, '/icons/icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Navigations only; everything else (API, RSC, assets) is pass-through.
  if (req.mode !== 'navigate') return;

  event.respondWith(
    fetch(req).catch(() =>
      caches.match(OFFLINE_URL).then(
        (cached) =>
          cached ||
          new Response('<h1>Offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } }),
      ),
    ),
  );
});
