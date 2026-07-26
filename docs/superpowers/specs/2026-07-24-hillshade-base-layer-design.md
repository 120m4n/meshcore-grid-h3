# Spec — capa base "Hillshade" (Esri World Hillshade)

## 1) Contexto

`apps/web/src/lib/map/setup.ts` ya define 3 capas base intercambiables
(CARTO Light, OSM Black, OSM) cableadas en un `L.control.layers(...)`
de selección única (radio), con CARTO Light como default
(`cartoLight.addTo(map)`). El objetivo es sumar una cuarta opción de
relieve sombreado ("hillshade"), gratis/abierta, sin cambiar el
default ni ningún otro comportamiento del mapa.

## 2) Alcance

Incluye: `apps/web/src/lib/map/setup.ts` (nuevo tile layer + entrada en
el control de capas) y `apps/web/public/sw.js` (host nuevo en
`TILE_HOSTS` para paridad de cacheo offline con los otros 3 basemaps).
Excluye: cualquier cambio a `mapBounds.ts`, zoom/bounds del mapa, o al
default actual (CARTO Light sigue siendo el que carga al abrir la app).

## 3) Fuente de datos

Esri World Hillshade (servicio público de ArcGIS Online, sin API key):

```
https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}
```

Nota: el REST tile scheme de Esri usa `{z}/{y}/{x}` (no `{z}/{x}/{y}`
como los otros 3 basemaps OSM/CARTO) — hay que respetar ese orden en
la URL del `L.tileLayer`. Atribución: `Esri, USGS, NOAA`.

## 4) Cambios

### 4.1 `apps/web/src/lib/map/setup.ts`

```ts
const hillshade = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Esri, USGS, NOAA', maxZoom: 13 }
);
```

`maxZoom: 13` porque el servicio de Esri no tiene tiles nativos más
allá de zoom 13 — con `MAX_ZOOM` del proyecto en 14, Leaflet hace
upscale automático del último nivel nativo en vez de pedir un tile
inexistente. Se agrega al objeto de `L.control.layers(...)` con la
etiqueta `"Hillshade"`:

```ts
L.control.layers(
  { 'CARTO Light': cartoLight, 'OSM Black': osmBlack, 'OSM': osmLight, 'Hillshade': hillshade },
  undefined,
  { position: 'topright' }
).addTo(map);
```

**No** se llama `hillshade.addTo(map)` — queda seleccionable en el
control pero no se carga por default; `cartoLight.addTo(map)` (línea
existente) no cambia.

### 4.2 `apps/web/public/sw.js`

`TILE_HOSTS` gana `'server.arcgisonline.com'`, mismo criterio que los
2 hosts ya cacheados (`tile.openstreetmap.org`,
`basemaps.cartocdn.com`) — cache-first offline para las 4 capas base
por igual.

## 5) Testing

Sin test runner en `apps/web`. Verificación manual: `npm run build`
(chequeo de tipos), luego en el navegador — abrir el selector de
capas, confirmar que "Hillshade" aparece como cuarta opción, que
seleccionarlo carga el mosaico de relieve sombreado, y que el mapa
sigue abriendo con CARTO Light por default sin tocar nada.

## 6) Criterios de aceptación

- El mapa sigue abriendo con CARTO Light (sin cambios de default).
- "Hillshade" aparece en el control de capas y, al seleccionarlo,
  carga tiles de Esri correctamente (sin tiles rotos/404 por el orden
  de `{z}/{y}/{x}`).
- `server.arcgisonline.com` cae bajo cache-first en `sw.js`, igual que
  los otros 3 basemaps.
- `npm run build` sigue compilando sin errores.
