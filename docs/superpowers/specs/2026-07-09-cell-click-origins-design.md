# Áreas de plus code al hacer click en una celda

## Contexto

Hoy, al hacer click en una celda H3 real del mapa público
(`apps/web/src/lib/mapPage.ts`), se abre un popup con el score
agregado (`score_pct`, `report_count`, `last_report_at`) — un dato
difuso, ligado a un hexágono de ~460m de lado (resolución 8). El
usuario pidió agregar, en el mismo click, la ubicación exacta de origen
de los reportes que sostienen esa celda: si el reporte se originó como
coordenadas GPS, calcular el plus code equivalente a nivel 10 (~13m de
lado) en el backend, y dibujarlo sobre el mapa.

## Decisiones tomadas en brainstorming

- **Es pública, sin auth.** Se evaluó explícitamente el trade-off de
  privacidad (nivel 10 ≈ precisión de "casa específica", más fino que
  el hexágono actual) y el usuario decidió mantenerlo público: es
  información de utilidad comunitaria y el reportero ya acepta que su
  reporte sea visible al enviarlo.
- **No hay "un ganador por celda", hay deduplicación por área.** Una
  celda puede tener varios reportes aprobados; en vez de elegir uno
  (ej. el más reciente), se devuelven **todas las áreas de plus code
  nivel 10 distintas** entre esos reportes — si dos reportes caen en el
  mismo código de 10 dígitos (ej. misma oficina), se cuentan una sola
  vez para no repintar el mismo cuadrado dos veces.
- **Sin metadata agregada por área.** No se cuenta cuántos reportes
  colapsaron en cada área — solo se dibuja el área. El score de calidad
  sigue viviendo únicamente en el color de la celda H3 completa.
- **Siempre se recalcula el nivel 10 desde `reports.lat`/`reports.lon`**,
  sin importar si el reporte se originó como `coords` o `pluscode`.
  `reports.lat`/`lon` ya existen para el 100% de los reportes (se
  resuelven al guardar, ver `ReportHandler.Create`), así que no hace
  falta distinguir `input_method` — un solo cálculo, precisión
  consistente para deduplicar. Esto simplifica el pedido original (que
  planteaba ramificar "si es GPS calcula, si no reusa el que ya tenía").
- **Se dispara con el mismo click que ya abre el popup**, sin botón
  aparte.
- **No se acumulan entre clicks.** Cada click en una celda real
  reemplaza los cuadrados dibujados por el click anterior (una sola
  capa reutilizable), igual que el patrón ya usado para `testLayer`.

## Backend (`apps/api`)

**Nuevo endpoint público:** `GET /api/v1/cells/:h3_index/origins`,
registrado junto a `GET /cells` en `internal/router/router.go` (fuera
del grupo `authed` — sin auth, mismo nivel de acceso que `GET /cells`).

**Nuevo handler** `CellHandler.Origins` en
`apps/api/internal/handlers/cell_handler.go`:

1. `SELECT lat, lon FROM reports WHERE h3_index = ? AND status = 'approved'`.
2. Para cada fila, `olc.Encode(lat, lon, 10)` (paquete
   `github.com/google/open-location-code/go`, ya es dependencia del
   proyecto — usado hoy en `h3util.ResolveLatLon` para `Decode`; este
   endpoint usa `Encode`, que ya expone la firma
   `func Encode(lat, lng float64, codeLen int) string` sin necesidad de
   ningún wrapper nuevo).
3. Deduplicar por el string del código (un `map[string]struct{}` o
   equivalente) — cada código único se procesa una sola vez.
4. Por cada código único, `olc.Decode(code)` da el `CodeArea` con
   `LatLo`/`LatHi`/`LngLo`/`LngHi` (bounding box exacto del área).
5. Responder `200` con un array (posiblemente vacío si la celda no
   tiene reportes aprobados —p.ej. fue borrada después de que el mapa
   cargó):

```json
[
  {"plus_code": "8687XVXV+GX", "lat_lo": 7.1192, "lat_hi": 7.1193, "lng_lo": -73.1228, "lng_hi": -73.1227}
]
```

No se toca `cell_agg`, `recomputeCellAggregate`, el schema ni ninguna
migración — es una lectura nueva sobre datos que ya existen en
`reports`. No se agrega ninguna dependencia nueva a `go.mod`.

## Frontend (`apps/web`)

**`src/lib/api.ts`:** una función nueva,

```ts
export interface CellOrigin {
  plus_code: string;
  lat_lo: number;
  lat_hi: number;
  lng_lo: number;
  lng_hi: number;
}

export function getCellOrigins(h3Index: string): Promise<CellOrigin[]> {
  return apiFetch(`/api/v1/cells/${h3Index}/origins`);
}
```

**`src/lib/mapPage.ts`:**

- Nueva capa `let originsLayer = L.layerGroup().addTo(map);`, mismo
  patrón que `cellLayer`/`testLayer` ya existentes.
- El `polygon.on('click', ...)` que hoy solo hace
  `L.DomEvent.stopPropagation(e)` dentro de `loadCells()` (celdas
  reales) se extiende: además de detener la propagación, llama
  `originsLayer.clearLayers()` y luego `getCellOrigins(cell.h3_index)`;
  por cada área devuelta, dibuja
  `L.rectangle([[lat_lo, lng_lo], [lat_hi, lng_hi]], {...}).addTo(originsLayer)`
  con un estilo visualmente distinto de la celda H3 (más fino, color de
  acento) para que se lea como "detalle dentro de la celda", no como
  otra celda.
- `originsLayer.clearLayers()` también se llama al inicio de
  `loadCells()` (mismo momento en que se limpia `cellLayer`), para que
  un refresco de mapa no deje cuadrados de una celda que ya no existe o
  cambió.
- Sin cambios a la interacción de celdas de prueba (`testLayer`,
  `addTestCell`/`removeTestCell`) ni al click handler del mapa vacío —
  esta feature solo afecta el click sobre celdas reales.

## Fuera de alcance (explícitamente descartado)

- Endpoint restringido a admin — se evaluó y se descartó, es público.
- Selección de "un solo reporte representativo" por celda — se
  reemplazó por deduplicación de áreas.
- Contador de reportes colapsados por área.
- Botón separado para disparar la consulta — es automático con el
  click existente.
- Acumulación de cuadrados de múltiples celdas a la vez.

## Verificación

1. `apps/api`: `go build ./...` y `go vet ./...` limpios.
2. Backend manual con curl: aprobar 2 reportes en la misma celda con
   coordenadas GPS distintas pero dentro del mismo edificio (deben
   colapsar a 1 área) y un tercero en otra esquina de la celda (debe
   dar una 2ª área distinta); `GET /cells/:h3_index/origins` devuelve
   exactamente 2 elementos. `GET` sobre un `h3_index` sin reportes
   aprobados devuelve `[]`.
3. `apps/web`: `npm run build` limpio.
4. E2E con navegador headless: cargar el mapa, click en una celda real,
   confirmar que aparecen rectángulos dentro del hexágono además del
   popup de score; click en otra celda real, confirmar que los
   rectángulos anteriores desaparecen y aparecen los nuevos; click en
   "Actualizar mapa", confirmar que los rectángulos se limpian.
