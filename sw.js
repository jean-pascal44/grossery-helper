// Service worker "réseau d'abord" : toujours la dernière version en ligne,
// et l'application reste utilisable hors-ligne (magasin sans réseau) depuis le cache.
const CACHE = 'grossery-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('peerjs.com')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: url.origin === self.location.origin })
          .then((r) => r || Response.error()))
  );
});
