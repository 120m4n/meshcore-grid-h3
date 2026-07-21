# Tracking GPS en vivo + toggle de modo prueba — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar las lecturas GPS puntuales (`getCurrentPosition`) por
un tracking continuo (`watchPosition`) con filtro anti-drift, en el mapa
(modo prueba) y en `/reportar` (botón "Usar mi ubicación"); y convertir
el botón "Activar modo prueba" en un toggle que solo prende/apaga la
interacción de click sobre el mapa, sin tocar el GPS ni el punto dibujado
una vez arrancados.

**Architecture:** Un módulo nuevo y agnóstico de Leaflet,
`apps/web/src/lib/geoWatch.ts`, encapsula `watchPosition` + el filtro de
precisión/distancia mínima y expone la última posición aceptada. El mapa
(`map/geolocation.ts`, `map/testCells.ts`, `map/realCells.ts`,
`mapPage.ts`) lo consume para dibujar un punto que vive indefinidamente
una vez arrancado, separando el registro del listener de click (una sola
vez) del flag `isTestModeEnabled()` que el toggle prende/apaga.
`/reportar` (`reportPage.ts`) lo consume directamente para actualizar
lat/lon en vivo, deteniéndolo cuando cambia el método, se envía el
reporte, o el usuario edita los campos a mano.

**Tech Stack:** Astro 4 + TypeScript vanilla + Leaflet 1.9 (sin framework
de UI) en `apps/web`. Sin dependencias nuevas.

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-21-geolocation-live-tracking-design.md`.
- No hay suite de tests automatizada en este proyecto (`package.json` no
  tiene tests configurados — ver `CLAUDE.md`). Este plan usa
  **verificación manual con `npm run build`, un script Node desechable
  para la lógica pura, y el panel "Sensors" de Chrome DevTools** para
  simular movimiento/errores GPS en el navegador — no introduce ningún
  framework de testing nuevo (fuera de alcance).
- Mecanismo de consulta frecuente: `navigator.geolocation.watchPosition`
  únicamente. Nunca `setInterval` + `getCurrentPosition`.
- Filtro anti-drift: `MAX_ACCURACY_M = 50` (metros); se descarta una
  lectura si su `accuracy` es peor que ese umbral, o si la distancia
  movida respecto a la última posición aceptada es menor que la
  `accuracy` de la nueva lectura. Sin promedio móvil/EMA.
- El toggle de "modo prueba" (no-admin) solo prende/apaga la interacción
  de click sobre el mapa (crear celda de prueba + copiar al
  portapapeles). El watch de GPS y el punto dibujado, una vez
  arrancados, **nunca se detienen** desde el toggle.
- `/reportar` sí detiene su watch (a diferencia del mapa) al cambiar de
  método, al enviar el reporte con éxito, o al editar lat/lon a mano.
- Flujo de admin sin cambios: sigue sin botón, modo prueba siempre
  activo, sin GPS.
- Todo el código nuevo sigue el estilo y los patrones exactos ya
  existentes en cada archivo tocado (comentarios solo donde el porqué no
  es obvio, sin abstracciones nuevas más allá de lo que pide esta
  feature).

---

### Task 1: Módulo `geoWatch.ts` (filtro anti-drift + watch)

**Files:**
- Create: `apps/web/src/lib/geoWatch.ts`

**Interfaces:**
- Produces: `MAX_ACCURACY_M: number`; `haversineMeters(a: {lat:number,lon:number}, b: {lat:number,lon:number}): number`; `shouldAcceptFix(prev: GeolocationPosition | null, next: GeolocationPosition): boolean`; `getLastKnownPosition(): GeolocationPosition | null`; `watchFilteredPosition(onUpdate: (pos: GeolocationPosition) => void, onError?: (err: GeolocationPositionError) => void): () => void`.
- Consumes: nada (módulo sin dependencias del proyecto, solo APIs del navegador).

- [ ] **Step 1: Crear `apps/web/src/lib/geoWatch.ts`**

```ts
// Consulta de geolocalización en vivo (watchPosition) con filtro
// anti-drift: descarta lecturas de mala precisión o que caen dentro del
// círculo de incertidumbre de la última posición aceptada, para que el
// punto no "tiemble" con el ruido normal del GPS estando quieto. Ver
// docs/superpowers/specs/2026-07-21-geolocation-live-tracking-design.md.

export const MAX_ACCURACY_M = 50;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function shouldAcceptFix(
  prev: GeolocationPosition | null,
  next: GeolocationPosition,
): boolean {
  if (next.coords.accuracy > MAX_ACCURACY_M) return false;
  if (!prev) return true;
  const distance = haversineMeters(
    { lat: prev.coords.latitude, lon: prev.coords.longitude },
    { lat: next.coords.latitude, lon: next.coords.longitude },
  );
  return distance >= next.coords.accuracy;
}

let lastAccepted: GeolocationPosition | null = null;

export function getLastKnownPosition(): GeolocationPosition | null {
  return lastAccepted;
}

export function watchFilteredPosition(
  onUpdate: (pos: GeolocationPosition) => void,
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!shouldAcceptFix(lastAccepted, pos)) return;
      lastAccepted = pos;
      onUpdate(pos);
    },
    (err) => {
      onError?.(err);
      if (err.code === err.PERMISSION_DENIED) {
        navigator.geolocation.clearWatch(watchId);
      }
    },
    { enableHighAccuracy: true },
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
```

- [ ] **Step 2: Verificar la lógica pura con un script Node desechable**

Node 22+ ejecuta `.ts` directamente (type stripping), sin necesidad de
`ts-node` ni `tsx`. Crear un archivo temporal:

```bash
cat > /Users/120m4n/GitHub/meshcore-grid-h3/apps/web/verify-geowatch.ts << 'EOF'
import { haversineMeters, shouldAcceptFix, MAX_ACCURACY_M } from './src/lib/geoWatch.ts';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

const bucaramanga = { lat: 7.1193, lon: -73.1227 };
const oneHundredMetersNorth = { lat: 7.1202, lon: -73.1227 };
const dist = haversineMeters(bucaramanga, oneHundredMetersNorth);
assert(dist > 95 && dist < 105, `haversineMeters ~100m real, dio ${dist.toFixed(1)}m`);

function fakePosition(lat: number, lon: number, accuracy: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON() { return this; },
    },
    timestamp: Date.now(),
    toJSON() { return this; },
  } as GeolocationPosition;
}

assert(
  shouldAcceptFix(null, fakePosition(7.1193, -73.1227, 20)) === true,
  'primera lectura siempre se acepta',
);
assert(
  shouldAcceptFix(fakePosition(7.1193, -73.1227, 20), fakePosition(7.11931, -73.1227, 20)) === false,
  'jitter de ~1m con accuracy 20m se descarta (drift)',
);
assert(
  shouldAcceptFix(fakePosition(7.1193, -73.1227, 20), fakePosition(7.1202, -73.1227, 20)) === true,
  'movimiento real de ~100m con accuracy 20m se acepta',
);
assert(
  shouldAcceptFix(fakePosition(7.1193, -73.1227, 20), fakePosition(7.1202, -73.1227, 80)) === false,
  `lectura con accuracy peor que MAX_ACCURACY_M (${MAX_ACCURACY_M}m) se descarta`,
);

console.log('geoWatch.ts: todas las verificaciones pasaron');
EOF
cd /Users/120m4n/GitHub/meshcore-grid-h3/apps/web && node verify-geowatch.ts
```

Expected: cuatro líneas `ok: ...` más `haversineMeters ~100m real, dio
XX.Xm`, terminando en `geoWatch.ts: todas las verificaciones pasaron`,
sin `FAIL`.

- [ ] **Step 3: Borrar el script desechable**

```bash
rm /Users/120m4n/GitHub/meshcore-grid-h3/apps/web/verify-geowatch.ts
```

- [ ] **Step 4: Commit**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3
git add apps/web/src/lib/geoWatch.ts
git commit -m "feat(web): módulo geoWatch con filtro anti-drift para watchPosition"
```

---

### Task 2: Integración en el mapa (geolocalización en vivo + toggle de modo prueba)

**Files:**
- Modify: `apps/web/src/lib/map/geolocation.ts` (agregar `startLiveUserLocation`, re-exportar `getLastKnownPosition`)
- Modify: `apps/web/src/lib/map/testCells.ts` (separar registro del listener de `map.on('click', ...)` del toggle; usar `getLastKnownPosition()` en vez de `getCurrentGeoPosition()`)
- Modify: `apps/web/src/lib/map/realCells.ts` (mismo cambio de `getCurrentGeoPosition()` → `getLastKnownPosition()` en el click de celda real)
- Modify: `apps/web/src/lib/mapPage.ts` (el botón pasa a llamar `toggleTestMode()` y actualizar su propio texto)

**Interfaces:**
- Consumes: `watchFilteredPosition`, `getLastKnownPosition` de `../geoWatch.ts` (Task 1); `isTestModeEnabled`, `setTestModeEnabled`, `realIndexes` de `./state.ts` (sin cambios); `map`, `testLayer`, `userLocationLayer` de `./setup.ts` (sin cambios); `MAX_ZOOM` de `../mapBounds.ts` (sin cambios).
- Produces: `map/geolocation.ts` → `startLiveUserLocation(onError?: (err: GeolocationPositionError) => void): () => void`, re-exporta `getLastKnownPosition(): GeolocationPosition | null`. `map/testCells.ts` → `initTestMode(isAdmin: boolean): void` (reemplaza a `enableTestMode`), `toggleTestMode(): Promise<void>`.

- [ ] **Step 1: Reescribir `apps/web/src/lib/map/geolocation.ts`**

```ts
import L from 'leaflet';
import { userLocationLayer } from './setup.ts';
import { watchFilteredPosition, getLastKnownPosition } from '../geoWatch.ts';

export { getLastKnownPosition };

export function getCurrentGeoPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
    });
  });
}

// Punto GPS del usuario: dibuja al instante cuando se valida
// geolocalización (activación de modo prueba y cada relectura durante
// un click). Círculo exterior = radio de precisión reportado por el
// navegador (pos.coords.accuracy, en metros) — cuanto más grande, más
// incierta es la posición.
export function renderUserLocation(pos: GeolocationPosition) {
  const { latitude, longitude, accuracy } = pos.coords;
  userLocationLayer.clearLayers();
  // interactive: false — el punto suele caer justo sobre la celda real
  // donde el usuario está parado (es el caso de uso central del modo
  // prueba); sin esto, el dot capturaba el click y la celda de abajo
  // nunca llegaba a recibirlo.
  L.circle([latitude, longitude], {
    radius: Math.abs(accuracy),
    color: '#1a73e8',
    weight: 1.5,
    fillColor: '#ffffff',
    fillOpacity: 0.35,
    interactive: false,
  }).addTo(userLocationLayer);
  L.circleMarker([latitude, longitude], {
    radius: 7,
    color: '#ffffff',
    weight: 2,
    fillColor: '#1a73e8',
    fillOpacity: 1,
    interactive: false,
  }).addTo(userLocationLayer);
}

// Arranca el watch de geolocalización en vivo: cada lectura aceptada
// (filtrada por geoWatch.ts) redibuja el punto. Se deja corriendo
// indefinidamente mientras dure la página — el toggle de modo prueba
// no lo detiene, ver spec 2026-07-21-geolocation-live-tracking-design.md.
export function startLiveUserLocation(
  onError?: (err: GeolocationPositionError) => void,
): () => void {
  return watchFilteredPosition(renderUserLocation, onError);
}
```

- [ ] **Step 2: Reescribir `apps/web/src/lib/map/testCells.ts`**

```ts
import L from 'leaflet';
import { cellToBoundary, latLngToCell } from 'h3-js';
import { showToast } from '../toast.ts';
import { colorForScore } from '../colors.ts';
import { formatDateTimeBogota } from '../datetime.ts';
import { H3_RESOLUTION, MAX_ZOOM } from '../mapBounds.ts';
import { map, testLayer } from './setup.ts';
import { realIndexes, isTestModeEnabled, setTestModeEnabled } from './state.ts';
import {
  getCurrentGeoPosition,
  getLastKnownPosition,
  renderUserLocation,
  startLiveUserLocation,
} from './geolocation.ts';
import { copyReportMessage } from './reportMessage.ts';

// ============ celdas de prueba (mock, solo localStorage) ============
// No toca el backend ni cell_agg real. Sirve para probar la interacción
// "crear celda → aparece en el mapa" / "eliminar celda → desaparece"
// directamente sobre el mapa público, sin flujo de reportes+aprobación.
const TEST_STORAGE_KEY = 'meshcore:test-cells';

interface TestCell {
  h3_index: string;
  score_pct: number;
  created_at: string;
}

function loadTestCells(): TestCell[] {
  try {
    const raw = localStorage.getItem(TEST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTestCells(cells: TestCell[]) {
  try {
    localStorage.setItem(TEST_STORAGE_KEY, JSON.stringify(cells));
  } catch {
    // localStorage no disponible (modo privado, cuota) — la celda
    // igual queda pintada en memoria para esta sesión.
  }
}

function renderTestCell(cell: TestCell) {
  const boundary = cellToBoundary(cell.h3_index);
  const polygon = L.polygon(boundary, {
    color: '#34d7c0',
    weight: 1.5,
    dashArray: '4 3', // punteado marca visualmente "temporal/prueba"
    fillColor: colorForScore(cell.score_pct),
    fillOpacity: 0.45,
  }).addTo(testLayer);

  polygon.bindPopup(`
    <strong>Celda de prueba (temporal):</strong> ${cell.h3_index}<br/>
    <strong>Creada:</strong> ${formatDateTimeBogota(cell.created_at)}<br/>
    <em>Clic de nuevo sobre la celda para quitarla</em>
  `);
  polygon.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    removeTestCell(cell.h3_index);
  });
}

function renderAllTestCells() {
  testLayer.clearLayers();
  loadTestCells().forEach(renderTestCell);
}

function addTestCell(h3Index: string) {
  const cells = loadTestCells();
  if (cells.some((c) => c.h3_index === h3Index)) return;
  cells.push({ h3_index: h3Index, score_pct: 100, created_at: new Date().toISOString() });
  saveTestCells(cells);
  renderAllTestCells();
}

function removeTestCell(h3Index: string) {
  saveTestCells(loadTestCells().filter((c) => c.h3_index !== h3Index));
  renderAllTestCells();
}

function clearTestCells() {
  saveTestCells([]);
  renderAllTestCells();
}

let isAdminMode = false;
let hasStartedLiveWatch = false;

// Click sobre el mapa vacío: crea/quita una celda de prueba. Gatea todo
// con isTestModeEnabled() — el toggle de "Activar/Desactivar modo
// prueba" solo mueve este flag, nunca detiene el GPS ni redibuja nada.
async function handleMapClick(e: L.LeafletMouseEvent) {
  if (!isTestModeEnabled()) return;
  const h3Index = latLngToCell(e.latlng.lat, e.latlng.lng, H3_RESOLUTION);
  if (realIndexes.has(h3Index)) return; // no pisar datos reales aprobados

  const isTestCell = loadTestCells().some((c) => c.h3_index === h3Index);
  if (isTestCell) {
    removeTestCell(h3Index);
    return;
  }

  if (isAdminMode) {
    addTestCell(h3Index);
    copyReportMessage(e.latlng.lat, e.latlng.lng);
    return;
  }

  // usuario normal: la última posición del watch en curso sirve de
  // prueba de presencia, sin pedir una lectura GPS puntual por click.
  const pos = getLastKnownPosition();
  if (!pos) {
    showToast('No se pudo obtener tu ubicación GPS', 'error');
    return;
  }
  const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
  if (userH3 !== h3Index) {
    showToast('Solo podés reportar la celda donde estás parado ahora mismo', 'error');
    return;
  }
  addTestCell(h3Index);
  copyReportMessage(pos.coords.latitude, pos.coords.longitude);
}

// Registro único: se llama una sola vez al cargar la página, para
// cualquier usuario. Admin queda con el modo prueba activo de una (sin
// GPS, como hoy); no-admin arranca desactivado hasta que use el botón
// (ver toggleTestMode).
export function initTestMode(isAdmin: boolean) {
  isAdminMode = isAdmin;
  map.on('click', handleMapClick);

  if (isAdmin) {
    setTestModeEnabled(true);
    document.getElementById('btn-clear-test')!.hidden = false;
    document.getElementById('btn-clear-test')!.addEventListener('click', clearTestCells);
  } else {
    setTestModeEnabled(false);
  }
  renderAllTestCells();
}

// Toggle del botón "Activar/Desactivar modo prueba" (no-admin). Solo la
// primera vez que se activa pide el fix GPS inicial y arranca el watch
// en vivo — queda corriendo indefinidamente; los toggles siguientes
// solo prenden/apagan la interacción de click.
export async function toggleTestMode(): Promise<void> {
  if (isTestModeEnabled()) {
    setTestModeEnabled(false);
    showToast('Modo prueba desactivado');
    return;
  }

  if (!hasStartedLiveWatch) {
    let firstPos: GeolocationPosition;
    try {
      firstPos = await getCurrentGeoPosition();
    } catch {
      showToast('No se pudo activar el modo prueba sin acceso a tu ubicación', 'error');
      return;
    }
    hasStartedLiveWatch = true;
    renderUserLocation(firstPos);
    map.setView([firstPos.coords.latitude, firstPos.coords.longitude], Math.min(16, MAX_ZOOM));
    startLiveUserLocation((err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showToast('Se perdió el acceso a tu ubicación GPS', 'error');
      }
    });
  }
  setTestModeEnabled(true);
  showToast('Modo prueba activado');
}
```

- [ ] **Step 3: Actualizar el click handler de celda real en `apps/web/src/lib/map/realCells.ts`**

Reemplazar el import de la línea 10:

```ts
import { getCurrentGeoPosition, renderUserLocation } from './geolocation.ts';
```

por:

```ts
import { getLastKnownPosition, renderUserLocation } from './geolocation.ts';
```

Y reemplazar el bloque (líneas 65-74 del archivo original):

```ts
        let pos: GeolocationPosition;
        try {
          pos = await getCurrentGeoPosition();
        } catch {
          return; // solo navegando el mapa, sin GPS no hay nada más que hacer
        }
        renderUserLocation(pos);
        const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
        if (userH3 !== cell.h3_index) return; // viendo la celda, pero no parado ahí
        copyReportMessage(pos.coords.latitude, pos.coords.longitude);
```

por:

```ts
        const pos = getLastKnownPosition();
        if (!pos) return; // solo navegando el mapa, sin GPS no hay nada más que hacer
        const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
        if (userH3 !== cell.h3_index) return; // viendo la celda, pero no parado ahí
        copyReportMessage(pos.coords.latitude, pos.coords.longitude);
```

(el `polygon.on('click', async (e) => {...})` puede dejar de ser `async`
si TypeScript no se queja de una función `async` sin ningún `await`
adentro — no es obligatorio quitarlo, pero si el linter/editor lo marca,
quitar `async` de la firma es válido ya que no queda ningún `await` en
esa rama.)

- [ ] **Step 4: Reescribir `apps/web/src/lib/mapPage.ts`**

```ts
import { loadCells } from './map/realCells.ts';
import { initTestMode, toggleTestMode } from './map/testCells.ts';
import { isTestModeEnabled } from './map/state.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
// admin siempre tiene modo prueba; un usuario normal lo desbloquea
// aceptando geolocalización (ver btn-enable-test más abajo).
const isAdmin = localStorage.getItem('role') === 'admin';

initTestMode(isAdmin);

if (!isAdmin) {
  const btnEnableTest = document.getElementById('btn-enable-test') as HTMLButtonElement;
  btnEnableTest.hidden = false;
  btnEnableTest.addEventListener('click', async () => {
    if (!navigator.geolocation) {
      showToast('Tu navegador no soporta geolocalización', 'error');
      return;
    }
    await toggleTestMode();
    btnEnableTest.textContent = isTestModeEnabled()
      ? 'Desactivar modo prueba'
      : 'Activar modo prueba';
  });
}

loadCells(isAdmin);

// Mostrar/ocultar nav según sesión
if (token) {
  document.getElementById('nav-report')!.hidden = false;
  const navLogin = document.getElementById('nav-login')!;
  navLogin.textContent = 'Salir';
  navLogin.addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.clear();
    location.reload();
  });
}
if (isAdmin) {
  document.getElementById('nav-admin')!.hidden = false;
}
```

- [ ] **Step 5: Build limpio**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3/apps/web && npm run build
```

Expected: `[build] Complete!` sin errores, `5 page(s) built`.

- [ ] **Step 6: Verificación manual en navegador (mapa, usuario no-admin)**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3/apps/web
echo "PUBLIC_API_URL=http://localhost:8080" > .env   # si no existe ya
npm run dev
```

Con la API corriendo en `:8080` (docker `infra-api-1` o `go run
./cmd/api`), abrir `http://localhost:4321/` con una sesión no-admin
(token de un usuario `role=user` en `localStorage`). Abrir Chrome
DevTools → menú `⋮` → More tools → **Sensors** → Location → "Custom
location...", cargar unas coordenadas dentro de Santander (p.ej.
`7.1193, -73.1227`).

1. Click en "Activar modo prueba" → el navegador pide permiso, el punto
   azul aparece en el mapa, el botón cambia a "Desactivar modo prueba".
2. En el panel Sensors, mover la coordenada ~1 metro (p.ej.
   `7.11931, -73.1227`) → el punto **no** debe moverse (jitter dentro
   del radio de precisión, filtrado).
3. Mover la coordenada claramente (p.ej. `7.1202, -73.1227`, ~100m) → el
   punto se redibuja en la nueva posición.
4. Click en "Desactivar modo prueba" → el botón cambia de texto, un
   click sobre el mapa ya no crea celdas de prueba ni copia nada al
   portapapeles — pero el punto azul sigue actualizándose si se sigue
   moviendo la coordenada en Sensors.
5. Click en "Activar modo prueba" de nuevo → sin pedir permiso otra vez,
   el click sobre el mapa vuelve a crear celdas de prueba.

- [ ] **Step 7: Commit**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3
git add apps/web/src/lib/map/geolocation.ts apps/web/src/lib/map/testCells.ts apps/web/src/lib/map/realCells.ts apps/web/src/lib/mapPage.ts
git commit -m "feat(web): tracking GPS en vivo + toggle de modo prueba en el mapa"
```

---

### Task 3: Integración en `/reportar` (ubicación en vivo en lat/lon)

**Files:**
- Modify: `apps/web/src/lib/reportPage.ts` (full file rewrite)

**Interfaces:**
- Consumes: `watchFilteredPosition` de `./geoWatch.ts` (Task 1).
- Produces: sin exports nuevos (script de página, sin módulo consumido por otros archivos).

- [ ] **Step 1: Reescribir `apps/web/src/lib/reportPage.ts`**

```ts
import L from 'leaflet';
// ?url fuerza a Vite a devolver la URL cruda como string — sin el
// sufijo, el plugin de assets de Astro envuelve el import en un objeto
// {src, width, height, ...} y Leaflet termina pidiendo "[object Object]".
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png?url';
import markerIcon from 'leaflet/dist/images/marker-icon.png?url';
import markerShadow from 'leaflet/dist/images/marker-shadow.png?url';
import { createReport } from './api.ts';
import { CENTER, SANTANDER_BOUNDS, MIN_ZOOM, MAX_ZOOM } from './mapBounds.ts';
import { showToast } from './toast.ts';
import { watchFilteredPosition } from './geoWatch.ts';

// Vite reescribe las rutas de assets al bundlear — el _getIconUrl por
// defecto de Leaflet asume rutas relativas al HTML servido y rompe en
// build (404 de marker-icon-2x.png/marker-shadow.png). Se reconfigura
// con las URLs ya resueltas por el bundler.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

if (!localStorage.getItem('token')) {
  window.location.href = '/login';
}

const MESSAGE_MAX = 120;

const latInput = document.getElementById('lat') as HTMLInputElement;
const lonInput = document.getElementById('lon') as HTMLInputElement;

// ============ ubicación en vivo (declarado antes de syncFieldVisibility, que lo usa) ============
const btnGeo = document.getElementById('btn-geo') as HTMLButtonElement;
const BTN_GEO_LABEL = btnGeo.textContent!;
let stopGeoWatch: (() => void) | null = null;

function stopLiveLocation() {
  stopGeoWatch?.();
  stopGeoWatch = null;
  btnGeo.textContent = BTN_GEO_LABEL;
}

// ============ toggle entre los 3 métodos de ubicación ============
const radios = document.querySelectorAll<HTMLInputElement>('input[name="input_method"]');
function currentMethod(): string {
  return document.querySelector<HTMLInputElement>('input[name="input_method"]:checked')!.value;
}
function syncFieldVisibility() {
  const method = currentMethod();
  document.getElementById('coords-fields')!.hidden = method !== 'coords';
  document.getElementById('pluscode-fields')!.hidden = method !== 'pluscode';
  document.getElementById('mapclick-fields')!.hidden = method !== 'mapclick';
  if (method === 'mapclick') ensurePickerMap();
  if (method !== 'coords') stopLiveLocation();
}
radios.forEach((r) => r.addEventListener('change', syncFieldVisibility));

btnGeo.addEventListener('click', () => {
  if (stopGeoWatch) return; // ya está en vivo, no arrancar un segundo watch
  btnGeo.textContent = 'Ubicación en vivo…';
  stopGeoWatch = watchFilteredPosition(
    (pos) => {
      latInput.value = String(pos.coords.latitude);
      lonInput.value = String(pos.coords.longitude);
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        showToast('No se pudo activar la ubicación en vivo: permiso denegado.', 'error');
        stopLiveLocation();
      }
    },
  );
});

// una edición manual de lat/lon corta el watch para no pisar la
// corrección del usuario con la próxima lectura del GPS. Asignar
// `.value` por script (como hace el watch arriba) no dispara 'input',
// así que este listener solo reacciona a ediciones reales del usuario.
latInput.addEventListener('input', stopLiveLocation);
lonInput.addEventListener('input', stopLiveLocation);

// pegar "lat,lon" en el campo de latitud separa ambos valores en sus
// respectivos campos, en vez de dejar el texto crudo en un input numérico.
const LAT_LON_PASTE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
latInput.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')?.trim();
  if (!text) return;
  const match = text.match(LAT_LON_PASTE);
  if (!match) return;
  e.preventDefault();
  latInput.value = match[1];
  lonInput.value = match[2];
});

// ============ mini-mapa "clic en el mapa" (carga perezosa) ============
let pickerMap: L.Map | null = null;
let pickerMarker: L.Marker | null = null;

function ensurePickerMap() {
  if (pickerMap) return;
  pickerMap = L.map('map-picker', {
    center: CENTER,
    zoom: 11,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    maxBounds: SANTANDER_BOUNDS,
    maxBoundsViscosity: 1.0,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
  }).addTo(pickerMap);

  pickerMap.on('click', (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;
    latInput.value = String(lat);
    lonInput.value = String(lng);
    if (pickerMarker) {
      pickerMarker.setLatLng(e.latlng);
    } else {
      pickerMarker = L.marker(e.latlng).addTo(pickerMap!);
    }
    const confirm = document.getElementById('picker-confirm')!;
    confirm.textContent = `Ubicación seleccionada: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });

  // el contenedor estaba oculto (display:none) al crear el mapa —
  // Leaflet mide el tamaño mal en ese caso, hay que recalcular.
  setTimeout(() => pickerMap!.invalidateSize(), 0);
}

// ============ contador de caracteres de la observación ============
const messageInput = document.getElementById('message') as HTMLTextAreaElement;
const messageCount = document.getElementById('message-count')!;
function updateMessageCount() {
  messageCount.textContent = `${messageInput.value.length}/${MESSAGE_MAX}`;
}
messageInput.addEventListener('input', updateMessageCount);
updateMessageCount();

// ============ submit ============
const submitBtn = document.querySelector<HTMLButtonElement>('#report-form button[type="submit"]')!;
const submitLabel = submitBtn.textContent!;

document.getElementById('report-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const method = currentMethod();

  if (method === 'mapclick' && (!latInput.value || !lonInput.value)) {
    showToast('Hacé clic en el mini-mapa para elegir la ubicación.', 'error');
    return;
  }

  const displayName = (document.getElementById('reporter_display_name') as HTMLInputElement).value.trim();

  const payload: Parameters<typeof createReport>[0] = {
    signal_quality: (document.getElementById('signal_quality') as HTMLSelectElement).value,
    message: messageInput.value,
  };
  const networkTypeEl = document.getElementById('network_type') as HTMLSelectElement | null;
  if (networkTypeEl?.value) payload.network_type = networkTypeEl.value;
  if (displayName) payload.reporter_display_name = displayName;

  if (method === 'pluscode') {
    payload.plus_code = (document.getElementById('plus_code') as HTMLInputElement).value;
  } else {
    payload.lat = parseFloat(latInput.value);
    payload.lon = parseFloat(lonInput.value);
  }

  submitBtn.disabled = true;
  submitBtn.setAttribute('aria-busy', 'true');
  submitBtn.textContent = 'Enviando…';
  try {
    await createReport(payload);
    showToast('Reporte enviado. Pendiente de aprobación.', 'success');
    (document.getElementById('report-form') as HTMLFormElement).reset();
    syncFieldVisibility();
    stopLiveLocation();
    updateMessageCount();
  } catch (err: any) {
    showToast(err.message || 'No se pudo enviar el reporte.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.removeAttribute('aria-busy');
    submitBtn.textContent = submitLabel;
  }
});
```

- [ ] **Step 2: Build limpio**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3/apps/web && npm run build
```

Expected: `[build] Complete!` sin errores, `5 page(s) built`.

- [ ] **Step 3: Verificación manual en navegador (`/reportar`)**

Con `npm run dev` corriendo (Task 2, Step 6) y sesión autenticada
(`localStorage.token` de cualquier usuario), abrir
`http://localhost:4321/reportar`. Panel Sensors de Chrome DevTools con
una coordenada custom cargada.

1. Método "Coordenadas GPS" (default) → click en "Usar mi ubicación" →
   el botón cambia a "Ubicación en vivo…", los campos lat/lon se llenan.
2. Mover la coordenada en Sensors → los campos lat/lon se actualizan
   solos, sin volver a tocar el botón.
3. Cambiar el radio a "Plus Code" → el botón vuelve a decir "Usar mi
   ubicación"; seguir moviendo la coordenada en Sensors y confirmar que
   los campos lat/lon (ahora ocultos) ya no cambian — abrir DevTools
   Console y correr `document.getElementById('lat').value` antes/después
   de mover Sensors para confirmar que quedó fijo.
4. Volver a "Coordenadas GPS", click en "Usar mi ubicación" de nuevo,
   luego escribir a mano un valor distinto en el campo latitud → el
   botón vuelve a "Usar mi ubicación" (el watch se cortó) y el valor
   escrito a mano no se pisa aunque se siga moviendo Sensors.
5. Activar de nuevo "Usar mi ubicación", completar el resto del form y
   enviar el reporte → tras el toast de éxito, confirmar que el botón
   volvió a "Usar mi ubicación" (con DevTools Console:
   `document.getElementById('btn-geo').textContent`).

- [ ] **Step 4: Commit**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3
git add apps/web/src/lib/reportPage.ts
git commit -m "feat(web): ubicación en vivo con anti-drift en el botón 'Usar mi ubicación'"
```

---

### Task 4: Verificación cruzada, manejo de errores y documentación

**Files:**
- Modify: `CLAUDE.md` (agregar una sección breve documentando el diseño, siguiendo el patrón ya usado para el resto de las decisiones de arquitectura no obvias del proyecto)

**Interfaces:**
- Consumes: todo lo de Tasks 1-3.
- Produces: nada nuevo — este task es verificación + documentación.

- [ ] **Step 1: Simular `PERMISSION_DENIED` en el mapa**

Con `npm run dev` corriendo, en Chrome DevTools → Sensors → Location →
elegir **"Location unavailable"** (simula que el navegador deniega/no
puede dar la ubicación). En `http://localhost:4321/` (no-admin, modo
prueba aún no activado en esta sesión):

1. Click en "Activar modo prueba" → toast de error ("No se pudo activar
   el modo prueba sin acceso a tu ubicación"), el botón se mantiene en
   "Activar modo prueba" (no cambia a "Desactivar").
2. Volver Sensors a una coordenada válida y click en "Activar modo
   prueba" de nuevo → esta vez sí activa correctamente (confirma que el
   fallo anterior no dejó ningún estado corrupto que bloquee reintentar).

- [ ] **Step 2: Simular `PERMISSION_DENIED` en `/reportar`**

En `http://localhost:4321/reportar`, con Sensors en "Location
unavailable":

1. Click en "Usar mi ubicación" → toast de error ("No se pudo activar
   la ubicación en vivo: permiso denegado."), el botón vuelve a "Usar mi
   ubicación" (no queda trabado en "Ubicación en vivo…").
2. Volver Sensors a una coordenada válida y click en "Usar mi ubicación"
   de nuevo → activa correctamente.

- [ ] **Step 3: Confirmar que el flujo de admin no cambió**

Con una sesión `role=admin` en `localStorage`, abrir
`http://localhost:4321/`:

1. No debe aparecer el botón "Activar modo prueba" (sigue oculto).
2. Debe aparecer "Limpiar pruebas".
3. Click directo sobre cualquier celda vacía del mapa → crea una celda
   de prueba y copia el mensaje al portapapeles, sin pedir GPS ni pasar
   por ningún toggle.

- [ ] **Step 4: Agregar sección a `CLAUDE.md`**

Insertar, después de la sección `### Sin extensión espacial en SQLite —
geometría como texto plano` (o la sección de arquitectura de frontend
más cercana al tema — el implementador puede ubicarla junto a las demás
secciones de `apps/web` en el archivo), un bloque nuevo:

```markdown
### Geolocalización en vivo, no lecturas puntuales

`apps/web/src/lib/geoWatch.ts` envuelve `navigator.geolocation.watchPosition`
con un filtro anti-drift (descarta lecturas con `accuracy` peor que
`MAX_ACCURACY_M` o que caen dentro del círculo de incertidumbre de la
última posición aceptada) y expone `getLastKnownPosition()`. Tanto el
mapa (`map/geolocation.ts`, modo prueba) como `/reportar` (botón "Usar mi
ubicación") lo consumen — ninguno de los dos vuelve a usar
`getCurrentPosition` puntual para validar dónde está parado el usuario;
en el mapa, los clicks de `testCells.ts`/`realCells.ts` leen la última
posición del watch en vez de pedir un fix GPS nuevo por click. En el
mapa el watch queda corriendo indefinidamente una vez arrancado (nunca
lo detiene el toggle); en `/reportar` sí se detiene al cambiar de
método, al enviar el reporte, o si el usuario edita lat/lon a mano.

### "Activar modo prueba" es un toggle que no toca el GPS

El botón (no-admin) alterna únicamente si el click sobre el mapa
crea/copia una celda de prueba (`isTestModeEnabled()` en
`map/state.ts`) — no prende ni apaga el watch de geolocalización ni el
punto dibujado, que quedan activos de forma permanente desde la primera
activación. `map/testCells.ts` separa el registro del listener
`map.on('click', ...)` (una sola vez, `initTestMode`) del toggle en sí
(`toggleTestMode`) para evitar registrar el listener más de una vez.
Admin no usa este botón: su modo prueba sigue siempre activo, sin GPS,
igual que antes de esta feature.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/120m4n/GitHub/meshcore-grid-h3
git add CLAUDE.md
git commit -m "docs: documentar geolocalización en vivo y el toggle de modo prueba"
```
