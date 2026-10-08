# Plan de migración: Leaflet → MapLibre GL JS

> **Documento agnóstico** — Este documento define el plan completo de
> migración, los archivos afectados, los pasos de implementación y los
> criterios de aceptación. Está escrito para ser ejecutado directamente
> por un agente de codificación sin intervención manual adicional.

---

## 1. Motivación

| Criterio | Leaflet 1.x | MapLibre GL JS 4.x |
|---|---|---|
| Renderizado | Canvas 2D / SVG | WebGL 2 |
| Estilo de tiles | Solo raster | Raster **y** vectoriales (MVT/PMTiles) |
| Animaciones | Nativas limitadas | Fluidas (60 fps) |
| 3D / extrusión | No | Sí (`fill-extrusion`) |
| Bundle (gzip) | ~42 KB | ~250 KB |
| Licencia | BSD-2 | BSD-3 (fork abierto de Mapbox GL JS v1) |
| Última versión estable | 1.9.4 | 4.x |
| Soporte H3 polygons client-side | Vía `L.polygon` | Vía fuentes GeoJSON (`addSource`/`addLayer`) |

MapLibre GL JS permite:
- Tiles vectoriales de alta densidad para Santander (menos datos transferidos).
- Zoom suave (inertia), inclinación 3D y rotación sin costo adicional.
- Estilos de mapa propios (JSON) en vez de depender de CDN externos.
- Base para integrar PMTiles locales en el futuro (sin servidor de tiles).

El backend Go, la lógica de H3, la API y las migraciones de base de datos
**no se tocan** en esta migración.

---

## 2. Alcance

### Dentro del alcance

- Reemplazar la dependencia `leaflet` + `@types/leaflet` por `maplibre-gl`.
- Reescribir `apps/web/src/lib/mapPage.ts` usando la API de MapLibre.
- Reescribir el mini-mapa en `apps/web/src/lib/reportPage.ts`.
- Actualizar `apps/web/src/pages/index.astro` (import de CSS).
- Actualizar `apps/web/src/pages/reportar.astro` (import de CSS).
- Eliminar selectores CSS específicos de Leaflet en `global.css` y
  agregar sus equivalentes para MapLibre.
- Mantener `mapBounds.ts` y `colors.ts` sin cambios (agnósticos de librería).
- Mantener toda la lógica de celdas de prueba (`TEST_STORAGE_KEY`,
  `loadTestCells`, `saveTestCells`, etc.) y de negocio (`getCells`,
  `colorForScore`, `latLngToCell`, `cellToBoundary`).

### Fuera del alcance

- Cambio de tiles base (se mantienen CartoDB Dark y OSM Light).
- Tiles vectoriales propios (queda como mejora futura).
- Cambios al backend Go (`apps/api`).
- Cambios a `infra/` o Docker Compose.
- Agregar tests automatizados.

---

## 3. Inventario de archivos afectados

```
apps/web/
├── package.json                         # CAMBIAR dependencias
├── src/
│   ├── pages/
│   │   ├── index.astro                  # CAMBIAR import CSS
│   │   └── reportar.astro               # CAMBIAR import CSS
│   ├── lib/
│   │   ├── mapPage.ts                   # REESCRIBIR (núcleo del mapa)
│   │   └── reportPage.ts                # REESCRIBIR (mini-mapa picker)
│   └── styles/
│       └── global.css                   # ACTUALIZAR selectores de popup
```

Archivos que **no cambian**:

```
apps/web/src/lib/mapBounds.ts   # CENTER / SANTANDER_BOUNDS / H3_RESOLUTION
apps/web/src/lib/colors.ts      # colorForScore (puro, sin deps de mapa)
apps/web/src/lib/api.ts         # getCells / createReport (HTTP puro)
apps/web/src/lib/toast.ts       # showToast (DOM puro)
apps/web/src/lib/adminPage.ts
apps/web/src/lib/loginPage.ts
apps/web/src/lib/registerPage.ts
apps/web/src/pages/admin/index.astro
apps/web/src/pages/login.astro
apps/web/src/pages/register.astro
apps/api/                        # sin cambios
infra/                           # sin cambios
```

---

## 4. Instrucciones de implementación

### Paso 1 — Actualizar dependencias

```bash
cd apps/web
npm uninstall leaflet @types/leaflet
npm install maplibre-gl
```

`maplibre-gl` incluye sus propias declaraciones TypeScript; no se necesita
paquete `@types/` separado.

**Resultado esperado en `package.json`:**

```json
"dependencies": {
  "astro": "^4.15.0",
  "maplibre-gl": "^4.x.x",
  "h3-js": "^4.1.0"
}
```

### Paso 2 — Actualizar imports de CSS en las páginas Astro

**`apps/web/src/pages/index.astro`** — reemplazar:

```astro
import 'leaflet/dist/leaflet.css';
```

por:

```astro
import 'maplibre-gl/dist/maplibre-gl.css';
```

**`apps/web/src/pages/reportar.astro`** — misma sustitución.

### Paso 3 — Reescribir `mapPage.ts`

Criterios que la nueva implementación **debe** cumplir sin excepción:

1. **Bounds y zoom**: mismos valores que en `mapBounds.ts`
   (`CENTER`, `SANTANDER_BOUNDS`, `H3_RESOLUTION`).
2. **Capas base**: CartoDB Dark (default) y OSM Light, con control de
   capas en la esquina superior derecha.
3. **Hexágonos reales**: fuente GeoJSON `'cells'` con capa `'cells-fill'`
   para relleno y `'cells-outline'` para borde. Los polígonos se
   construyen con `cellToBoundary` de `h3-js` (igual que ahora).
4. **Color de relleno**: usar `colorForScore(cell.score_pct)`.
5. **Popup**: misma información (h3_index, score_pct, report_count,
   last_report_at) con `new maplibregl.Popup()`.
6. **Celdas de prueba**: misma lógica de `localStorage` ya existente;
   fuente GeoJSON separada `'test-cells'`.
7. **Clic en mapa**: mismo comportamiento (crear/quitar celda de prueba).
8. **Service Worker**: registro de `/sw.js` sin cambios.
9. **Botones**: `btn-refresh` y `btn-clear-test` con el mismo
   comportamiento.
10. **Auth nav**: lógica de `localStorage.getItem('token'/'role')`
    idéntica.

**API de MapLibre a usar** (referencia rápida):

```ts
import maplibregl from 'maplibre-gl';

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] }, // estilo base inline
  center: [CENTER[1], CENTER[0]],                  // [lon, lat] — ojo el orden
  zoom: 13,
  minZoom: 9,
  maxZoom: 14,
  maxBounds: [
    [SANTANDER_BOUNDS[0][1], SANTANDER_BOUNDS[0][0]],  // [lon, lat] SW
    [SANTANDER_BOUNDS[1][1], SANTANDER_BOUNDS[1][0]],  // [lon, lat] NE
  ],
});

// Añadir capa raster (tiles CartoDB Dark)
map.on('load', () => {
  map.addSource('carto-dark', {
    type: 'raster',
    tiles: ['https://{a-d}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'],
    tileSize: 256,
    attribution: '© OpenStreetMap contributors © CARTO',
  });
  map.addLayer({ id: 'carto-dark', type: 'raster', source: 'carto-dark' });

  // Fuente de celdas reales (se actualiza con setData en loadCells)
  map.addSource('cells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'cells-fill',
    type: 'fill',
    source: 'cells',
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.55 },
  });
  map.addLayer({
    id: 'cells-outline',
    type: 'line',
    source: 'cells',
    paint: { 'line-color': '#345070', 'line-width': 1 },
  });

  // Fuente de celdas de prueba (igual, datos en localStorage)
  map.addSource('test-cells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // ...

  loadCells();
  renderAllTestCells();
});
```

> **Nota sobre orden de coordenadas**: Leaflet usa `[lat, lon]`; MapLibre
> usa `[lon, lat]` (estándar GeoJSON). `cellToBoundary` de `h3-js`
> devuelve `[lat, lon]` — hay que invertir cada par al construir el
> GeoJSON.
>
> ```ts
> const coords = cellToBoundary(h3Index).map(([lat, lon]) => [lon, lat]);
> // cerrar el anillo:
> coords.push(coords[0]);
> ```

**GeoJSON Feature por celda:**

```ts
function cellToFeature(cell: CellData): GeoJSON.Feature {
  const coords = cellToBoundary(cell.h3_index).map(([lat, lon]) => [lon, lat]);
  coords.push(coords[0]); // cerrar anillo
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: {
      h3_index:       cell.h3_index,
      score_pct:      cell.score_pct,
      report_count:   cell.report_count,
      last_report_at: cell.last_report_at,
      color:          colorForScore(cell.score_pct),
    },
  };
}
```

**Popup al hacer clic en la capa:**

```ts
map.on('click', 'cells-fill', (e) => {
  const props = e.features![0].properties;
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(`
      <strong>Celda:</strong> ${props.h3_index}<br/>
      <strong>Conectividad:</strong> ${props.score_pct.toFixed(0)}%<br/>
      <strong>Reportes:</strong> ${props.report_count}<br/>
      <strong>Último reporte:</strong> ${new Date(props.last_report_at).toLocaleString('es-CO')}
    `)
    .addTo(map);
});
map.on('mouseenter', 'cells-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'cells-fill', () => { map.getCanvas().style.cursor = ''; });
```

**Control de capas base** (sustituto del `L.control.layers`):

MapLibre no trae un control de capas built-in tan sencillo como el de
Leaflet. Implementar un toggle HTML simple en la barra superior o usar
el paquete `@maplibre/maplibre-gl-geocoder` si se quiere mantener el
control visual. La opción mínima es un `<select>` en el topbar que llame
`map.setLayoutProperty('osm-light', 'visibility', 'none'/'visible')`.

### Paso 4 — Reescribir el mini-mapa en `reportPage.ts`

El mini-mapa picker sigue la misma lógica pero con la API de MapLibre.
Aspectos clave:

1. Usar el mismo estilo de tiles CartoDB Dark.
2. `map.on('click', (e) => { lat = e.lngLat.lat; lon = e.lngLat.lng; })`.
3. El marcador de posición puede ser un `maplibregl.Marker()` en vez de
   `L.marker`.
4. Llamar `map.resize()` en vez de `pickerMap.invalidateSize()` tras
   mostrar el contenedor oculto.

```ts
import maplibregl from 'maplibre-gl';

let pickerMap: maplibregl.Map | null = null;
let pickerMarker: maplibregl.Marker | null = null;

function ensurePickerMap() {
  if (pickerMap) return;
  pickerMap = new maplibregl.Map({
    container: 'map-picker',
    style: {
      version: 8,
      sources: {
        'carto-dark': {
          type: 'raster',
          tiles: ['https://{a-d}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'],
          tileSize: 256,
        },
      },
      layers: [{ id: 'carto-dark', type: 'raster', source: 'carto-dark' }],
    },
    center: [CENTER[1], CENTER[0]],
    zoom: 11,
    minZoom: 9,
    maxZoom: 14,
    maxBounds: [
      [SANTANDER_BOUNDS[0][1], SANTANDER_BOUNDS[0][0]],
      [SANTANDER_BOUNDS[1][1], SANTANDER_BOUNDS[1][0]],
    ],
  });
  pickerMap.on('click', (e) => {
    const { lat, lng } = e.lngLat;
    latInput.value = String(lat);
    lonInput.value = String(lng);
    if (pickerMarker) {
      pickerMarker.setLngLat([lng, lat]);
    } else {
      pickerMarker = new maplibregl.Marker().setLngLat([lng, lat]).addTo(pickerMap!);
    }
    document.getElementById('picker-confirm')!.textContent =
      `Ubicación seleccionada: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });
  setTimeout(() => pickerMap!.resize(), 0);
}
```

### Paso 5 — Actualizar `global.css`

Eliminar todos los selectores prefijados con `.leaflet-` y reemplazarlos
con los equivalentes de MapLibre:

| Leaflet (remover) | MapLibre (agregar) |
|---|---|
| `.leaflet-popup-content-wrapper` | `.maplibregl-popup-content` |
| `.leaflet-popup-tip` | `.maplibregl-popup-tip` |
| `.leaflet-popup-content` | `.maplibregl-popup-content` (hereda) |
| `.leaflet-container a.leaflet-popup-close-button` | `.maplibregl-popup-close-button` |
| `.leaflet-bar a` | `.maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out` |
| `.leaflet-control-layers` | control personalizado (ver paso 3) |

Los estilos de forma/color en los bloques `.leaflet-popup-*` aplican
directamente a los equivalentes de MapLibre con ajuste de nombre de clase.

### Paso 6 — Verificar el build

```bash
cd apps/web
npm run build
```

No deben aparecer errores de TypeScript ni de Vite. Si `maplibre-gl`
requiere configuración adicional de Vite para el worker (en versiones 4.x
usa un Web Worker interno), agregar en `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  server: { port: 4321 },
  vite: {
    optimizeDeps: {
      include: ['maplibre-gl'],
    },
  },
});
```

### Paso 7 — Prueba manual de humo

Con `npm run dev` activo:

1. Abrir `http://localhost:4321` — el mapa debe cargar con tiles oscuros.
2. Hacer clic en una zona vacía — debe aparecer un hexágono punteado.
3. Hacer clic sobre el hexágono — debe desaparecer.
4. Pulsar "Actualizar mapa" — debe limpiar celdas de prueba y pedir al API.
5. Abrir `/reportar` y seleccionar "Clic en el mapa" — el mini-mapa debe
   aparecer y el clic debe rellenar los campos de lat/lon.

---

## 5. Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Bundle más grande (+200 KB) | Alta | Analizar impacto con `npm run build -- --reporter`. Evaluar carga diferida. |
| API `[lon, lat]` vs `[lat, lon]` | Alta | El step 3 documenta explícitamente la inversión con `.map(([lat, lon]) => [lon, lat])`. |
| Worker interno de MapLibre con Vite | Media | El paso 6 documenta la config de `optimizeDeps`. |
| `maxBounds` con formato diferente | Media | El step 3 documenta la conversión de `[[lat,lon],[lat,lon]]` → `[[lon,lat],[lon,lat]]`. |
| Control de capas sin equivalente directo | Baja | El step 3 propone un `<select>` HTML como alternativa mínima. |
| Service Worker caché de tiles CartoDB | Baja | Las URLs de tiles CartoDB no cambian; el SW existente sigue funcionando. |

---

## 6. Criterios de aceptación

- [ ] `npm run build` en `apps/web` finaliza sin errores.
- [ ] El mapa principal (`/`) carga hexágonos de la API y permite crear/quitar celdas de prueba.
- [ ] El mini-mapa en `/reportar` permite seleccionar ubicación con clic.
- [ ] No hay referencia a `leaflet` en ningún archivo de `apps/web/src`.
- [ ] `global.css` no contiene selectores `.leaflet-*`.
- [ ] Los bounds geográficos siguen acotados a Santander.
- [ ] `mapBounds.ts` y `colors.ts` no fueron modificados.

---

## 7. Mejoras opcionales post-migración

Estas no son parte del alcance de esta migración pero se habilitan por
el cambio a MapLibre:

- **PMTiles**: servir tiles vectoriales de Santander desde el mismo
  contenedor Go (cero dependencia de CDN externo).
- **Estilos propios**: estilo JSON de mapa de marca MeshCore (colores
  de la paleta `global.css`) en vez de CartoDB.
- **3D ligero**: extrusión de hexágonos por `score_pct` con
  `fill-extrusion-height`.
- **Animación de carga**: transición suave de opacidad al aparecer las
  celdas desde la API.

---

*Documento generado: 2026-07-09 — MeshCore Grid H3 / apps/web*
