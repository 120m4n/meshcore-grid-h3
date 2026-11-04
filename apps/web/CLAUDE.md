# CLAUDE.md — apps/web

Guía específica del frontend (Astro). Ver también el `CLAUDE.md` raíz
del repo para contexto general y la política de preservación de datos.

## Commands

```bash
cd apps/web
npm install
npm run dev       # :4321, usa PUBLIC_API_URL de apps/web/.env
npm run build      # build estático a dist/
npm run preview
```

Sin linter/formatter ni tests configurados en `package.json`.

## Architecture

### Sin build de componentes, JS vanilla por página

Cada `.astro` en `src/pages/` es una página standalone con su propio
`<script type="module">` inline que manipula el DOM directamente (sin
React/Vue/frameworks de UI). `src/lib/api.ts` es el único cliente HTTP
compartido — centraliza `fetch`, agrega el JWT desde `localStorage`
(`token`/`role`) y lanza en cualquier respuesta no-2xx. Auth state vive
solo en `localStorage`, chequeado ad-hoc al inicio del script de cada
página (`reportar.astro` y `admin/index.astro` redirigen si falta
token/role). `PUBLIC_API_URL` se inyecta en build time (Astro
`import.meta.env`), fijado por Docker build arg en producción.

### Geolocalización en vivo, no lecturas puntuales

`src/lib/geoWatch.ts` envuelve `navigator.geolocation.watchPosition`
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

### Punto de ubicación con botón 📍 y Kalman

El botón 📍 del toolbar (`toggleUserLocation` en `map/geolocation.ts`) es
el único que pide la ubicación — nunca al cargar la página —, sin
depender del modo prueba (que, al activarse, también la enciende). Dibuja el punto + círculo de error (`accuracy` filtrado, en metros) con
`lib/kalman.ts`. Va por su propio `watchPosition` (sin el tope de 50 m de
`geoWatch.ts`); el watch de `geoWatch.ts` sigue siendo el único que valida
presencia para reportar. El punto es imán (`snapToMeasureTarget`) de ruler
y compass, junto con las repetidoras. Chequeo: `node
--experimental-strip-types src/lib/kalmanCheck.mjs`.

### Punto temporal compartido (`map/tempPoint.ts`)

`tempPointsLayer` guarda un único punto, alimentado por «Ir a coordenadas»,
pulsación larga (500 ms, touch events propios) y shift+click; se ajusta a
una repetidora cercana. Los polígonos de celdas detienen la propagación del
click, por eso llaman a `handleShiftClick` ellos mismos.

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

### Actualización del mapa es manual, no reactiva

`index.astro` carga celdas una vez al entrar y de nuevo solo al pulsar
"Actualizar mapa" (`btn-refresh`) — deliberadamente sin WebSocket ni
polling.

### Acotamiento geográfico

El mapa Leaflet está fijado a Santander/Bucaramanga (`maxBounds`,
`minZoom=9`, `maxZoom=14`) — es un mapa de referencia regional, no de
navegación general; cualquier cambio a bounds/zoom en `index.astro` debe
respetar ese propósito.

### Referencia visual: `image_mock_base.png`

`image_mock_base.png` (raíz del repo) es un mockup de **orientación**
de cómo se ve la app con un mapa base tipo satélite (hexágonos H3
coloreados por señal sobre imagería satelital, leyenda de cobertura,
branding MeshCore). Es guía de estilo/composición, no el objetivo
pixel-perfect a replicar — no implica que el mapa base actual (tiles
OSM estándar) deba cambiar a satélite salvo que se pida explícitamente.

### `/decoder`: decoder público de `tv` (sin login)

`src/pages/decoder.astro` + `src/lib/tvPage.ts` decodifican en el
navegador la salida del comando `tv 0` / `tv <since>` de un repeater
MeshCore (vectores v3 base64url; v1 se acepta con aviso de deprecado): una pestaña por línea válida (máx. 6),
pestaña «Todas» que junta las del mismo sensor, tabla, gráficas SVG con
promedio y mín/máx, y copia de CSV / siguiente consulta. Es pública:
no importa `api.ts`, no lee `token` ni llama a la API, y su enlace
«Decoder TV» en la topbar de `index.astro` queda fuera de la lógica de
auth de `mapPage.ts`. Las preferencias (gráficas on/off, hora local) se
guardan en `localStorage` bajo `meshcore-web.tv-decoder.prefs`.

`src/lib/tv/` (`decoder.ts`, `tabs.ts`, `chart.ts`) es una **copia** de
`tools/tv_decoder/tv_decoder.ts` y `tools/tv_edge_ext/` del repo MeshCore
(120m4n/MeshCore-HJ7RMN); cada archivo indica en su cabecera el commit de
origen y las diferencias. No se editan aquí: para actualizarlos, copiar de
MeshCore y reaplicar esas diferencias. `node src/lib/tv/check.mjs` valida la
copia (decoder, tabs, chart). El alfabeto del vector está pensado para pegarse en
Telegram/WhatsApp: `~` (tachado) ya no lo emite el firmware y aquí solo se
acepta para vectores viejos. **Riesgo menor abierto:** `_` (de base64url) es
cursiva en WhatsApp (`_texto_`); dentro de una palabra normalmente no se
activa, por eso se dejó. Si aparecen cursivas, cambiarlo exige una nueva
`FORMAT_VERSION` en MeshCore y actualizar esta copia. Los estilos de la página viven en un
`<style is:global>` de `decoder.astro` bajo `.tv-page`, porque el SVG de las
gráficas se crea dinámicamente y los estilos con scope de Astro no le
aplican; ahí se revierten reglas globales (`label` en columna, `input` de
44px, `table`/`td` con borde).


### Capa de repetidoras (`map/repeaters.ts`)

Lee `/data/MeshAzimuth-repetidores.json` (array de `{name, hashPrefix,
latitude, longitude, ...}`) una vez al cargar el mapa, lo valida
(`map/repeatersParse.ts`, ítems inválidos se descartan con `console.warn`),
lo convierte a GeoJSON `Point` y lo dibuja en un `markerClusterGroup`
(`repeatersLayer` en `setup.ts`, sin límites de zoom, overlay
«Repetidoras» en el control de capas). Si el archivo o la carpeta no
existen, no pasa nada. En Docker, `infra/web-data/` se monta read-only en
`/usr/share/nginx/html/data` (no usar `infra/data/`: ahí vive
`meshcore.db`); en dev, `apps/web/public/data/`. Chequeo:
`node --experimental-strip-types src/lib/map/repeatersCheck.mjs`.
