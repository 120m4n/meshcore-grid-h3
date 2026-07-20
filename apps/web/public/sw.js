// Service worker de caché para la app MeshCore.
//
// Estrategias:
//   - Tiles de mapa (OSM / CARTO): cache-first — los tiles rara vez cambian
//     y son el mayor consumo de ancho de banda en 3G/LTE.
//   - App shell (JS/CSS de /_astro/): cache-first con actualización
//     en background — los archivos tienen hash de contenido, así que una
//     URL nueva es siempre un recurso nuevo; la versión anterior sigue
//     funcionando sin bloquear la carga mientras el SW se actualiza.
//   - GET /api/v1/cells: stale-while-revalidate — muestra el mapa
//     inmediatamente con datos de caché y refresca en background;
//     garantiza que la app cargue en modo offline/slow con datos recientes.
//   - Todo lo demás pasa directo a la red sin tocar el caché.

const CACHE_VERSION = 'v2';
const CACHE_TILES = `meshcore-tiles-${CACHE_VERSION}`;
const CACHE_SHELL = `meshcore-shell-${CACHE_VERSION}`;
const CACHE_API   = `meshcore-api-${CACHE_VERSION}`;

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'basemaps.cartocdn.com',
];

// Máxima antigüedad aceptable para la caché de cells (10 minutos).
// Pasado ese tiempo, aunque haya un valor en caché se fuerza una
// petición fresca antes de devolver respuesta (no stale-while-revalidate).
const CELLS_MAX_AGE_MS = 10 * 60 * 1000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_TILES && n !== CACHE_SHELL && n !== CACHE_API)
          .map((n) => caches.delete(n))
      )
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

function isShellRequest(url) {
  try {
    const { pathname } = new URL(url);
    // Astro emite todos los assets con hash bajo /_astro/
    return pathname.startsWith('/_astro/');
  } catch {
    return false;
  }
}

function isCellsRequest(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === '/api/v1/cells';
  } catch {
    return false;
  }
}

// Cache-first: sirve desde caché, guarda si no estaba.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

// Stale-while-revalidate con TTL: si el valor en caché tiene menos de
// CELLS_MAX_AGE_MS lo devuelve de inmediato y refresca en background;
// si es más viejo (o no existe) espera la red antes de responder.
async function staleWhileRevalidate(request, cacheName, maxAgeMs) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const isStale = (() => {
    if (!cached) return true;
    const date = cached.headers.get('sw-cached-at');
    if (!date) return true;
    return Date.now() - Number(date) > maxAgeMs;
  })();

  const networkFetch = fetch(request).then(async (res) => {
    if (res.ok) {
      // Añadir cabecera de timestamp para controlar el TTL.
      const headers = new Headers(res.headers);
      headers.set('sw-cached-at', String(Date.now()));
      const stamped = new Response(await res.clone().arrayBuffer(), {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
      cache.put(request, stamped);
    }
    return res;
  }).catch(() => null);

  if (!isStale && cached) {
    // Refresca en background sin bloquear la respuesta.
    void networkFetch;
    return cached;
  }

  // Cache vacío o muy viejo: esperar la red; si falla, devolver el
  // valor obsoleto si existe (mejor algo que error en offline).
  const fresh = await networkFetch;
  if (fresh && fresh.ok) return fresh;
  if (cached) return cached;
  return fresh || new Response('Network error', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const { url } = req;

  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(req, CACHE_TILES));
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(cacheFirst(req, CACHE_SHELL));
    return;
  }

  if (isCellsRequest(url)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_API, CELLS_MAX_AGE_MS));
    return;
  }
});
