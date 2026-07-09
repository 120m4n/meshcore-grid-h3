// Service worker de cache-first para tiles de mapa (OSM claro + oscuro).
// No cachea nada más — cualquier request que no matchee un tile pasa
// directo a la red sin pasar por el cache.
const CACHE_NAME = 'meshcore-tiles-v1';
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'basemaps.cartocdn.com',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  try {
    const { hostname } = new URL(url);
    return TILE_HOSTS.some((h) => hostname.endsWith(h));
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !isTileRequest(req.url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
