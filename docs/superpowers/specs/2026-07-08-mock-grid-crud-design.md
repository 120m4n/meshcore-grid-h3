# Mock CRUD de grids H3 en el mapa (frontend-only)

## Propósito

Herramienta de desarrollo para prototipar/probar la interacción visual
"crear celda → aparece en el mapa" / "eliminar celda → desaparece del
mapa" sin depender del backend Go ni del flujo real de
reportes+aprobación admin. Vive enteramente en `apps/web`, no toca
`apps/api` ni `cell_agg`.

No es parte del producto público: no se linkea desde la navegación de
`index.astro`, se accede directo por URL (`/mock-grid`).

## Alcance

**Dentro de alcance:**
- Crear una celda H3 individual haciendo clic en un punto vacío del mapa.
- Eliminar una celda existente haciendo clic sobre su hexágono.
- Persistir las celdas creadas en `localStorage` entre recargas.
- Botón "Reset" que borra todas las celdas mock.

**Fuera de alcance:**
- Cualquier llamada a la API real (`GET/POST /api/v1/...`).
- Auth/roles (es una herramienta de desarrollo, sin protección).
- Conjuntos/áreas de celdas (cada clic crea exactamente una celda).
- Formulario de edición de campos (el score se asigna automáticamente).

## Arquitectura

```
apps/web/src/
  lib/
    colors.ts       (nuevo — extraído, compartido)
    api.ts           (sin cambios)
    mapPage.ts        (modificado — usa lib/colors.ts)
  mock/
    grid-store.ts    (nuevo)
    grid-map.ts      (nuevo)
  pages/
    mock-grid.astro  (nuevo — única ruta)
    index.astro       (sin cambios funcionales)
```

Astro solo enruta páginas desde `src/pages/`; por eso la carpeta de
soporte del mock (`src/mock/`) vive fuera de `src/pages/` y solo
`mock-grid.astro` es una ruta real. Sigue el mismo patrón que
`mapPage.ts`: lógica en un módulo `.ts` importado vía
`<script src="...">`, no inline. Un `<script type="module">` inline en
un `.astro` no resuelve specifiers de paquetes npm como `h3-js`/
`leaflet` (Vite solo procesa el grafo de módulos a partir de un
`<script src="archivo-local">`); usar un archivo `.ts` externo evita
ese problema, igual que se corrigió en `index.astro`/`mapPage.ts`.

### `src/lib/colors.ts` (nuevo, extraído de `mapPage.ts`)

```ts
export function colorForScore(scorePct: number): string {
  // rojo (0%) -> amarillo (50%) -> verde (100%)
  if (scorePct >= 66) return '#2ecc71';
  if (scorePct >= 33) return '#f1c40f';
  return '#e74c3c';
}
```

`mapPage.ts` se actualiza para importar esta función en vez de
definirla localmente (elimina la duplicación que introduciría el mock).

### `src/mock/grid-store.ts` (nuevo)

CRUD sobre `localStorage`, clave `meshcore:mock-grid-cells`.

```ts
export interface MockGridCell {
  h3_index: string;
  score_pct: number;
  created_at: string; // ISO
}

export function listCells(): MockGridCell[];
export function addCell(h3Index: string, scorePct: number): MockGridCell;
export function removeCell(h3Index: string): void;
export function clearAll(): void;
```

- `addCell` es idempotente por `h3_index`: si la celda ya existe, no
  duplica (actualiza el registro existente).
- Persistencia vía `JSON.stringify`/`JSON.parse` sobre
  `localStorage.getItem/setItem`. Si `localStorage` no está disponible
  o el JSON está corrupto, `listCells()` devuelve `[]` (no lanza).

### `src/mock/grid-map.ts` (nuevo)

Inicializa Leaflet igual que `mapPage.ts` (mismo `CENTER`,
`SANTANDER_BOUNDS`, `minZoom`/`maxZoom`, tile layer OSM), pero:

- Al montar, pinta todas las celdas de `listCells()`.
- `map.on('click', (e) => { ... })`:
  1. Calcula `latLngToCell(e.latlng.lat, e.latlng.lng, 8)` (resolución 8,
     igual al default `H3_RESOLUTION` del backend).
  2. Si esa celda YA está pintada en el mapa (existe en el layer
     group) → `removeCell(h3Index)` + quita el polígono del mapa.
  3. Si NO existe → `score_pct` aleatorio (`Math.random() * 100`) →
     `addCell(h3Index, scorePct)` + pinta el polígono nuevo con
     `colorForScore`.
- Cada polígono tiene un popup con `h3_index`, `score_pct` y
  `created_at` (formateado con `toLocaleString('es-CO')`, igual que el
  mapa real).
- Botón `#btn-reset` (en la página) → `clearAll()` + limpia la capa del
  mapa.

Reutiliza el mismo layer group + patrón de renderizado que
`mapPage.ts` (un `L.layerGroup()` que se repuebla), para minimizar
divergencia de estilo entre el mapa real y el mock.

### `src/pages/mock-grid.astro` (nuevo)

Estructura mínima: header simple ("Mock Grid CRUD — dev only"), botón
`#btn-reset`, `<div id="map">` (mismo CSS `#map` de `global.css`,
reutilizado), y `<script src="../mock/grid-map.ts"></script>`.

## Flujo de datos

```
clic en mapa
  → grid-map.ts calcula h3_index
  → ¿existe en localStorage (grid-store)?
       sí → removeCell() → quitar polígono del layer
       no → addCell(score aleatorio) → pintar polígono en el layer
```

No hay red, no hay backend, no hay estado compartido entre pestañas
más allá de lo que `localStorage` sincroniza nativamente (no se
implementa el evento `storage` para multi-pestaña; fuera de alcance).

## Manejo de errores

- `localStorage` inaccesible (modo privado estricto, cuota excedida):
  `grid-store.ts` atrapa la excepción en `addCell`/`clearAll` y hace
  `console.warn`, sin romper la interacción del mapa (la celda se
  pinta igual en memoria para esa sesión, aunque no persista).
- Clic fuera de `SANTANDER_BOUNDS`: Leaflet ya restringe el pan/zoom a
  esos bounds (`maxBoundsViscosity: 1.0`), por lo que no debería ser
  alcanzable; no se agrega validación adicional.

## Verificación

- `npm run build` en `apps/web` compila sin errores (mismo check que
  ya se corre para el resto de páginas).
- Prueba manual con navegador headless (mismo patrón usado para
  verificar el fix del mapa real): navegar a `/mock-grid`, clic en un
  punto → aparece hexágono coloreado + popup; clic de nuevo sobre ese
  hexágono → desaparece; recargar página → la celda restante persiste;
  clic en "Reset" → mapa queda vacío.
- Sin test automatizado (el proyecto no tiene suite de tests
  configurada, ver `CLAUDE.md`).
