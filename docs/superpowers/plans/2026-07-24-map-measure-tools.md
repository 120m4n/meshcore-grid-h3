# Barra de herramientas de medición (ruler + arc) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar al mapa una barra de herramientas (patrón web component) con dos herramientas de medición: `ruler` (distancia en metros/km) y `arc` (rumbo en grados, 0° = norte, sentido horario).

**Architecture:** Dos custom elements (`<mc-tool-button>`, `<mc-map-toolbar>`) actúan como UI fina montada como un `L.Control` de Leaflet; toda la lógica de interacción con el mapa (clicks, cálculo de distancia/rumbo, dibujo) vive en un módulo nuevo `apps/web/src/lib/map/measureTools.ts`, siguiendo el mismo patrón que `radialSimulation.ts`/`coordSearch.ts`.

**Tech Stack:** Astro 4, TypeScript (strict), Leaflet 1.9, custom elements/Shadow DOM nativos (sin librería). Sin test runner ni linter configurados en `apps/web`.

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-24-map-measure-tools-spec-kit.md` — cualquier ambigüedad se resuelve releyendo ese documento.
- `apps/web/package.json` no tiene test runner ni linter — no existe `npm test`. La verificación de cada tarea es manual: `npm run dev` (puerto 4321) + interacción real en el navegador, igual criterio que el resto del frontend (ver CLAUDE.md: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete").
- `apps/web/tsconfig.json` extiende `astro/tsconfigs/strict` — todo archivo `.ts` nuevo debe tipar explícitamente (sin `any` implícito).
- Convención de rumbo: **0° = norte, sentido horario** — misma convención que `Destination()` en `apps/api/internal/terrain/los/geodesy.go`. No usar ninguna otra convención (ni matemática estándar 0°=este/antihorario) en ningún cálculo o label de este feature.
- Acceso público, sin sesión, para la toolbar y ambas herramientas.
- Ninguna tarea de este plan toca `apps/api` ni `infra/data/meshcore.db` — feature 100% frontend.
- Seguir el patrón existente: lógica de mapa en módulos `apps/web/src/lib/map/*.ts` que consumen el singleton `map` exportado por `map/setup.ts`; nunca crear una segunda instancia de `L.Map`.

---

### Task 1: Web components (`mc-tool-button`, `mc-map-toolbar`) montados como control del mapa

**Files:**
- Create: `apps/web/src/lib/map/webcomponents/mc-tool-button.ts`
- Create: `apps/web/src/lib/map/webcomponents/mc-map-toolbar.ts`
- Modify: `apps/web/src/lib/map/setup.ts`

**Interfaces:**
- Produces: custom element `<mc-tool-button tool="ruler"|"arc">` con propiedad `active: boolean` (getter/setter, refleja atributo `active`) y propiedad de solo lectura `tool: 'ruler' | 'arc'`; dispara `CustomEvent<{ tool: 'ruler' | 'arc' }>` tipo `'mc-tool-toggle'` (`bubbles: true, composed: true`) al hacer clic.
- Produces: custom element `<mc-map-toolbar>` que renderiza los dos `<mc-tool-button>` en su Shadow DOM.
- Produces: `rulerLayer`, `arcLayer` exportados desde `map/setup.ts` (usados por Task 2 en adelante).
- Consumes: ninguno (primera tarea del plan).

- [ ] **Step 1: Crear `mc-tool-button.ts`**

```ts
// apps/web/src/lib/map/webcomponents/mc-tool-button.ts
const ICONS: Record<string, string> = {
  ruler: '📏',
  arc: '🧭',
};

const LABELS: Record<string, string> = {
  ruler: 'Regla — medir distancia',
  arc: 'Rumbo — medir ángulo desde el norte',
};

export class McToolButton extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['tool', 'active'];
  }

  private button: HTMLButtonElement;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 30px;
          height: 30px;
          padding: 0;
          background: var(--surface-raised, #16283d);
          color: var(--text, #e7edf2);
          border: none;
          border-bottom: 1px solid var(--border, #24384f);
          font-size: 1rem;
          line-height: 1;
          cursor: pointer;
        }
        button:last-of-type { border-bottom: none; }
        button:hover { background: rgba(52, 215, 192, 0.12); }
        button.active {
          background: var(--accent, #34d7c0);
          color: var(--accent-text, #06211d);
        }
      </style>
      <button type="button"></button>
    `;
    this.button = shadow.querySelector('button')!;
    this.button.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('mc-tool-toggle', {
          detail: { tool: this.tool },
          bubbles: true,
          composed: true,
        })
      );
    });
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    this.render();
  }

  get tool(): 'ruler' | 'arc' {
    return this.getAttribute('tool') === 'arc' ? 'arc' : 'ruler';
  }

  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    if (value) this.setAttribute('active', '');
    else this.removeAttribute('active');
  }

  private render(): void {
    const tool = this.tool;
    this.button.textContent = ICONS[tool];
    this.button.title = LABELS[tool];
    this.button.setAttribute('aria-label', LABELS[tool]);
    this.button.setAttribute('aria-pressed', String(this.active));
    this.button.classList.toggle('active', this.active);
  }
}

customElements.define('mc-tool-button', McToolButton);

declare global {
  interface HTMLElementTagNameMap {
    'mc-tool-button': McToolButton;
  }
}
```

- [ ] **Step 2: Crear `mc-map-toolbar.ts`**

```ts
// apps/web/src/lib/map/webcomponents/mc-map-toolbar.ts
import './mc-tool-button.ts';

export class McMapToolbar extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          border-radius: 4px;
          overflow: hidden;
          border: 1px solid var(--border-bright, #345070);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
        }
      </style>
      <mc-tool-button tool="ruler"></mc-tool-button>
      <mc-tool-button tool="arc"></mc-tool-button>
    `;
  }
}

customElements.define('mc-map-toolbar', McMapToolbar);

declare global {
  interface HTMLElementTagNameMap {
    'mc-map-toolbar': McMapToolbar;
  }
}
```

- [ ] **Step 3: Montar la toolbar como `L.Control` y agregar las capas nuevas en `setup.ts`**

Editar `apps/web/src/lib/map/setup.ts`: agregar el import y, al final del archivo (después de la línea `export const radialLayer = ...`), agregar:

```ts
import './webcomponents/mc-map-toolbar.ts';
```

(agregar este import junto a los demás imports, arriba del archivo — no dentro del bloque de capas).

Y al final del archivo:

```ts
export const rulerLayer = L.layerGroup().addTo(map);
export const arcLayer = L.layerGroup().addTo(map);

// Control propio para la barra de herramientas de medición — 'topleft'
// porque 'topright' ya lo usa el selector de capas base. Apila debajo
// del control de zoom nativo (+/-), que Leaflet agrega automáticamente
// a ese mismo rincón antes de que este código corra.
const MeasureToolbarControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd(): HTMLElement {
    const toolbar = document.createElement('mc-map-toolbar');
    // Sin esto, un clic en los botones de la toolbar también llegaría a
    // map.on('click', ...) (measureTools.ts lo agrega en la Task 2) y
    // se interpretaría como un punto de medición sobre el mapa.
    L.DomEvent.disableClickPropagation(toolbar);
    return toolbar;
  },
});
new MeasureToolbarControl().addTo(map);
```

- [ ] **Step 4: Verificación manual — la toolbar aparece y dispara eventos**

```bash
cd apps/web && npm run dev
```

Abrir `http://localhost:4321/` en el navegador.

Expected: en la esquina superior izquierda del mapa, debajo del control de zoom (+/-), aparece un recuadro oscuro con dos botones: 📏 y 🧭.

En la consola del navegador (DevTools), pegar:

```js
document.addEventListener('mc-tool-toggle', (e) => console.log('tool-toggle', e.detail));
```

Hacer clic en el botón 📏: la consola debe mostrar `tool-toggle {tool: 'ruler'}`. Hacer clic en 🧭: debe mostrar `tool-toggle {tool: 'arc'}`. (Los botones todavía no cambian de aspecto al hacer clic — eso se conecta en la Task 2.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/map/webcomponents/mc-tool-button.ts apps/web/src/lib/map/webcomponents/mc-map-toolbar.ts apps/web/src/lib/map/setup.ts
git commit -m "feat(web): agregar web components de la toolbar de medición al mapa"
```

---

### Task 2: `measureTools.ts` — máquina de estados de activación + cancelación con Esc

**Files:**
- Create: `apps/web/src/lib/map/measureTools.ts`
- Modify: `apps/web/src/lib/mapPage.ts`

**Interfaces:**
- Consumes: `map`, `rulerLayer`, `arcLayer` de `./setup.ts` (Task 1); tipo global `HTMLElementTagNameMap['mc-tool-button']` (Task 1, vía `document.querySelectorAll('mc-tool-button')`).
- Produces: `activateRuler(): void`, `activateArc(): void`, `deactivateMeasureTool(): void`, `isMeasuring(): boolean`, `handleMeasureClick(lat: number, lon: number): void` — usados por Task 3 (exclusión con LOS 360°) y Task 6 (guardas en capas de celdas).

- [ ] **Step 1: Crear `measureTools.ts` con el estado de activación (sin dibujo todavía)**

```ts
// apps/web/src/lib/map/measureTools.ts
import L from 'leaflet';
import { map, rulerLayer, arcLayer } from './setup.ts';

export type MeasureTool = 'ruler' | 'arc';

let activeTool: MeasureTool | null = null;
let pendingPointA: L.LatLng | null = null;

export function isMeasuring(): boolean {
  return activeTool !== null;
}

export function deactivateMeasureTool(): void {
  activeTool = null;
  pendingPointA = null;
  syncToolButtons();
}

function setActiveTool(tool: MeasureTool): void {
  if (activeTool === tool) {
    deactivateMeasureTool();
    return;
  }
  activeTool = tool;
  pendingPointA = null;
  syncToolButtons();
}

export function activateRuler(): void {
  setActiveTool('ruler');
}

export function activateArc(): void {
  setActiveTool('arc');
}

function syncToolButtons(): void {
  document.querySelectorAll('mc-tool-button').forEach((el) => {
    el.active = el.tool === activeTool;
  });
}

// El dibujo real (distancia/rumbo) llega en las Tasks 4 y 5 — por ahora
// el segundo clic solo cierra el modo, para poder verificar la máquina
// de estados de forma aislada.
export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  if (pendingPointA === null) {
    pendingPointA = L.latLng(lat, lon);
    return;
  }
  deactivateMeasureTool();
}

map.on('click', (e: L.LeafletMouseEvent) => {
  handleMeasureClick(e.latlng.lat, e.latlng.lng);
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (!isMeasuring()) return;
  deactivateMeasureTool();
});

// rulerLayer/arcLayer todavía no se usan en esta tarea — el import
// deliberadamente los trae ya para que las Tasks 4/5 no tengan que
// tocar esta línea de imports.
void rulerLayer;
void arcLayer;
```

- [ ] **Step 2: Conectar la toolbar en `mapPage.ts`**

Editar `apps/web/src/lib/mapPage.ts`, agregar cerca de los demás imports (arriba del archivo):

```ts
import { activateRuler, activateArc } from './map/measureTools.ts';
```

Y agregar, junto al resto de wiring de nivel superior (por ejemplo después de `initCoordSearch();`):

```ts
document.addEventListener('mc-tool-toggle', (e: Event) => {
  const { tool } = (e as CustomEvent<{ tool: 'ruler' | 'arc' }>).detail;
  if (tool === 'ruler') activateRuler();
  else activateArc();
});
```

- [ ] **Step 3: Verificación manual — toggle visual y Esc**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`:

1. Clic en 📏: el botón debe iluminarse (fondo turquesa `--accent`). Expected: sí.
2. Clic de nuevo en 📏: debe apagarse. Expected: sí.
3. Clic en 📏, luego clic en 🧭 (sin volver a tocar 📏): 📏 se apaga y 🧭 se enciende. Expected: sí (un solo botón activo a la vez).
4. Con 🧭 encendido, presionar `Esc`: se apaga. Expected: sí.
5. Con 🧭 encendido, hacer clic en el mapa (punto A) y luego clic de nuevo en el mapa (punto B): el botón se apaga solo después del segundo clic. Expected: sí, sin dibujar nada todavía (llega en Task 5).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/measureTools.ts apps/web/src/lib/mapPage.ts
git commit -m "feat(web): máquina de estados de activación de las herramientas de medición"
```

---

### Task 3: Exclusión mutua con "Elegir origen" de la simulación LOS 360°

**Files:**
- Modify: `apps/web/src/lib/map/radialSimulation.ts`
- Modify: `apps/web/src/lib/map/measureTools.ts`

**Interfaces:**
- Produces (en `radialSimulation.ts`): `cancelOriginPicking(): void` — nuevo export.
- Consumes (en `measureTools.ts`): `cancelOriginPicking` de `./radialSimulation.ts`.
- Consumes (en `radialSimulation.ts`): `deactivateMeasureTool` de `./measureTools.ts`.

Nota de diseño: esto crea un import circular entre `radialSimulation.ts` y
`measureTools.ts`. Es seguro porque ninguno de los dos módulos llama a la
función importada del otro en el nivel superior del archivo — ambas
llamadas ocurren dentro de manejadores de eventos (`activateOrigin...`,
`setActiveTool`), que solo se ejecutan después de que ambos módulos ya
terminaron de cargar. Vite/ESM resuelve esto sin problema (mismo
mecanismo que ya usan `testCells.ts`/`realCells.ts` importando
`isPickingOrigin`/`pickOriginAt` de `radialSimulation.ts`).

- [ ] **Step 1: Agregar `cancelOriginPicking` a `radialSimulation.ts`**

En `apps/web/src/lib/map/radialSimulation.ts`, agregar el import al tope del archivo:

```ts
import { deactivateMeasureTool } from './measureTools.ts';
```

Modificar `enableOriginPicking` (línea 24 actual) para que cancele una medición en curso al activarse:

```ts
export function enableOriginPicking(callback: (lat: number, lon: number) => void) {
  deactivateMeasureTool();
  pickingOrigin = true;
  onOriginPicked = callback;
}
```

Agregar, después de `isPickingOrigin` (línea 34-36 actual), el export nuevo:

```ts
// Cancela una selección de origen en curso SIN completar el punto — a
// diferencia de pickOriginAt(), no llama a onOriginPicked. Lo usa
// measureTools.ts para garantizar exclusión mutua en el otro sentido:
// activar ruler/arc mientras se está eligiendo origen debe cancelar esa
// selección, no dejarla "colgada" esperando un clic que ahora va a
// interpretarse como punto de medición.
export function cancelOriginPicking(): void {
  pickingOrigin = false;
  onOriginPicked = null;
}
```

- [ ] **Step 2: Llamar `cancelOriginPicking()` al activar una herramienta de medición**

En `apps/web/src/lib/map/measureTools.ts`, agregar el import al tope:

```ts
import { cancelOriginPicking } from './radialSimulation.ts';
```

Modificar `setActiveTool` para cancelar la selección de origen antes de activar:

```ts
function setActiveTool(tool: MeasureTool): void {
  if (activeTool === tool) {
    deactivateMeasureTool();
    return;
  }
  cancelOriginPicking();
  activeTool = tool;
  pendingPointA = null;
  syncToolButtons();
}
```

- [ ] **Step 3: Verificación manual — exclusión en ambos sentidos**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`:

1. Clic en "Elegir origen en el mapa" (panel LOS 360°, aparece el toast "Hacé clic en el mapa para fijar el origen"). Sin hacer clic en el mapa todavía, clic en 📏 (toolbar). Expected: 📏 se enciende. Ahora hacer clic en el mapa: Expected: el campo "Origen" del panel LOS 360° sigue mostrando "— clic en el mapa —" (no se fijó ningún origen) — el clic se consumió como punto A de la regla, no como origen.
2. Clic en 📏 para activarla. Sin hacer clic en el mapa, clic en "Elegir origen en el mapa". Expected: 📏 se apaga. Hacer clic en el mapa: Expected: el campo "Origen" se actualiza con las coordenadas del clic (funciona igual que antes de este cambio).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/radialSimulation.ts apps/web/src/lib/map/measureTools.ts
git commit -m "feat(web): exclusión mutua entre medición y selección de origen LOS 360°"
```

---

### Task 4: Herramienta ruler — cálculo de distancia y dibujo

**Files:**
- Modify: `apps/web/src/lib/map/radialSimulation.ts`
- Modify: `apps/web/src/lib/map/measureTools.ts`

**Interfaces:**
- Produces (en `radialSimulation.ts`): exporta `formatDistance` (ya existe como función privada, línea 108 actual — solo se le agrega `export`).
- Consumes (en `measureTools.ts`): `formatDistance` de `./radialSimulation.ts`.

- [ ] **Step 1: Exportar `formatDistance` desde `radialSimulation.ts`**

En `apps/web/src/lib/map/radialSimulation.ts`, cambiar:

```ts
function formatDistance(distanceM: number): string {
```

por:

```ts
export function formatDistance(distanceM: number): string {
```

(sin otro cambio — la función ya formatea `< 1000 m` en metros enteros y `>= 1000 m` en km con 2 decimales).

- [ ] **Step 2: Dibujar la medición de ruler en `measureTools.ts`**

Agregar el import al tope de `apps/web/src/lib/map/measureTools.ts`:

```ts
import { formatDistance } from './radialSimulation.ts';
```

Agregar la función de dibujo (antes de `handleMeasureClick`):

```ts
function drawRuler(a: L.LatLng, b: L.LatLng): void {
  rulerLayer.clearLayers(); // reemplaza la medición anterior de ruler
  const distanceM = map.distance(a, b);
  L.polyline([a, b], { color: '#f1c40f', weight: 2, opacity: 0.85 })
    .bindTooltip(formatDistance(distanceM), {
      permanent: true,
      direction: 'center',
      className: 'measure-tooltip',
    })
    .addTo(rulerLayer)
    .openTooltip();
}
```

Modificar `handleMeasureClick` para llamar `drawRuler` cuando `activeTool === 'ruler'`:

```ts
export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  const point = L.latLng(lat, lon);
  if (pendingPointA === null) {
    pendingPointA = point;
    return;
  }
  if (activeTool === 'ruler') drawRuler(pendingPointA, point);
  deactivateMeasureTool();
}
```

Eliminar las dos líneas `void rulerLayer; void arcLayer;` agregadas como placeholder en la Task 2 (ya están en uso real).

- [ ] **Step 3: Estilo del label — agregar `.measure-tooltip` a `global.css`**

En `apps/web/src/styles/global.css`, agregar (cerca de las reglas `.leaflet-popup-*` existentes, línea ~423 en adelante):

```css
/* Label de las herramientas de medición (ruler/arc) — mismo lenguaje
   visual oscuro que los popups de Leaflet ya restyleados arriba. */
.measure-tooltip {
  background: rgba(16, 29, 46, 0.92);
  color: var(--text);
  border: 1px solid var(--border-bright);
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 0.75rem;
  padding: 0.15rem 0.4rem;
}
.measure-tooltip::before {
  display: none; /* oculta la flechita default de Leaflet tooltip */
}
```

- [ ] **Step 4: Verificación manual — medir distancia**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`:

1. Clic en 📏, luego dos clics en el mapa separados por una distancia visible. Expected: aparece una línea amarilla entre los dos puntos con un label mostrando la distancia (ej. "1.24 km" o "350 m" según la distancia real).
2. Repetir la medición (clic en 📏, dos clics nuevos en otro lugar). Expected: la línea y el label anteriores desaparecen, solo queda la medición nueva.
3. Hacer una medición de arc (sin haber tocado ruler) — no debe existir todavía dibujo real para arc, se agrega en la Task 5; confirmar que no rompe nada (el segundo clic solo cierra el modo, sin errores en consola).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/map/radialSimulation.ts apps/web/src/lib/map/measureTools.ts apps/web/src/styles/global.css
git commit -m "feat(web): dibujar medición de distancia de la herramienta ruler"
```

---

### Task 5: Herramienta arc — cálculo de rumbo y dibujo

**Files:**
- Modify: `apps/web/src/lib/map/measureTools.ts`

**Interfaces:**
- Consumes: ninguno nuevo (usa `L`, `arcLayer` ya importados).
- Produces: función interna `initialBearingDeg(a: L.LatLng, b: L.LatLng): number` (0-360, 0 = norte, sentido horario) — uso interno de este módulo, no se exporta fuera del archivo.

- [ ] **Step 1: Agregar el cálculo de rumbo y el dibujo de arc**

En `apps/web/src/lib/map/measureTools.ts`, agregar (junto a `drawRuler`):

```ts
// Rumbo inicial (initial bearing) del segmento A→B sobre una esfera,
// normalizado a [0, 360). Misma convención que Destination() en el
// backend (apps/api/internal/terrain/los/geodesy.go): 0 = norte,
// sentido horario.
function initialBearingDeg(a: L.LatLng, b: L.LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}

function drawArc(a: L.LatLng, b: L.LatLng): void {
  arcLayer.clearLayers(); // reemplaza la medición anterior de arc
  const bearingDeg = initialBearingDeg(a, b);
  L.polyline([a, b], { color: '#9b59b6', weight: 2, opacity: 0.85 })
    .bindTooltip(`${bearingDeg.toFixed(0)}°`, {
      permanent: true,
      direction: 'center',
      className: 'measure-tooltip',
    })
    .addTo(arcLayer)
    .openTooltip();
}
```

Modificar `handleMeasureClick` para llamar `drawArc` cuando corresponda:

```ts
export function handleMeasureClick(lat: number, lon: number): void {
  if (activeTool === null) return;
  const point = L.latLng(lat, lon);
  if (pendingPointA === null) {
    pendingPointA = point;
    return;
  }
  if (activeTool === 'ruler') drawRuler(pendingPointA, point);
  else drawArc(pendingPointA, point);
  deactivateMeasureTool();
}
```

- [ ] **Step 2: Verificación manual — rumbo correcto en los 4 puntos cardinales**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`, usar el buscador de coordenadas (panel "Ir a coordenadas") para ubicarse en un punto de referencia conocido, por ejemplo `7.1193,-73.1227`.

1. Clic en 🧭. Clic en el punto de referencia (A). Clic en un punto claramente al NORTE de A (más arriba en el mapa, misma longitud aprox.). Expected: label ≈ `0°` (tolerancia ±5° por el clic manual).
2. Repetir con B al ESTE de A (misma latitud aprox., más a la derecha). Expected: label ≈ `90°`.
3. Repetir con B al SUR de A. Expected: label ≈ `180°`.
4. Repetir con B al OESTE de A. Expected: label ≈ `270°`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/map/measureTools.ts
git commit -m "feat(web): dibujar medición de rumbo de la herramienta arc"
```

---

### Task 6: Precedencia de clicks sobre celdas (reales y de prueba) mientras se está midiendo

**Files:**
- Modify: `apps/web/src/lib/map/realCells.ts`
- Modify: `apps/web/src/lib/map/testCells.ts`

**Interfaces:**
- Consumes: `isMeasuring`, `handleMeasureClick` de `./measureTools.ts` (Task 2/4/5).

Contexto: `polygon.on('click', ...)` en ambos archivos llama
`L.DomEvent.stopPropagation(e)`, así que un clic sobre una celda NUNCA
llega al `map.on('click', ...)` de `measureTools.ts`. Sin esta tarea, medir
con un punto sobre una celda coloreada abriría el popup de la celda (o
crearía/borraría una celda de prueba) en vez de registrar el punto de
medición — mismo problema que ya resuelve el chequeo de `isPickingOrigin()`
que ambos archivos ya tienen, agregado con el mismo patrón.

- [ ] **Step 1: Guarda en `realCells.ts`**

En `apps/web/src/lib/map/realCells.ts`, agregar el import junto a los demás (línea 12 actual):

```ts
import { isMeasuring, handleMeasureClick } from './measureTools.ts';
```

Modificar el handler `polygon.on('click', ...)` (línea 52 actual) agregando el chequeo ANTES del bloque de `isPickingOrigin()`:

```ts
      polygon.on('click', (e) => {
        L.DomEvent.stopPropagation(e);

        if (isMeasuring()) {
          polygon.closePopup();
          handleMeasureClick(e.latlng.lat, e.latlng.lng);
          return;
        }

        // Eligiendo origen para la simulación LOS 360°: bindPopup ya
        // abrió el popup de info (su listener de click corrió antes que
        // este), así que hay que cerrarlo a mano en vez de solo "no
        // abrirlo". Corta acá — nada de info de celda ni de reporte
        // mientras se está fijando el origen.
        if (isPickingOrigin()) {
          polygon.closePopup();
          pickOriginAt(e.latlng.lat, e.latlng.lng);
          return;
        }
```

(el resto del handler queda igual).

- [ ] **Step 2: Guarda en `testCells.ts`**

En `apps/web/src/lib/map/testCells.ts`, agregar el import junto a los demás (línea 16 actual):

```ts
import { isMeasuring, handleMeasureClick } from './measureTools.ts';
```

Modificar `renderTestCell` (el handler `polygon.on('click', ...)`, línea 63 actual):

```ts
  polygon.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (isMeasuring()) {
      polygon.closePopup();
      handleMeasureClick(e.latlng.lat, e.latlng.lng);
      return;
    }
    if (isPickingOrigin()) {
      polygon.closePopup();
      pickOriginAt(e.latlng.lat, e.latlng.lng);
      return;
    }
    removeTestCell(cell.h3_index);
  });
```

También modificar `handleMapClick` (línea 116 actual, el manejador de clicks del modo prueba sobre el mapa vacío) para que ceda el paso — este SÍ recibe el evento vía `map.on('click', ...)` (no hay `stopPropagation` de por medio en un click sobre mapa vacío), así que sin esta guarda, un clic de medición sobre una celda vacía en modo prueba crearía una celda de prueba ADEMÁS de registrar el punto:

```ts
async function handleMapClick(e: L.LeafletMouseEvent) {
  if (isMeasuring()) return; // measureTools.ts ya procesó este clic vía su propio map.on('click')
  if (!isTestModeEnabled()) return;
```

- [ ] **Step 3: Verificación manual — medir sobre celdas y en modo prueba**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`:

1. Con al menos una celda real visible en el mapa (o activar modo prueba y crear una): clic en 📏, clic en un punto vacío (A), clic directo sobre el polígono de la celda (B). Expected: se dibuja la línea+label de distancia; NO se abre el popup de info de la celda.
2. Como admin (o con modo prueba activo): clic en 🧭, clic en punto A, clic en punto B sobre una zona vacía del mapa. Expected: se dibuja el rumbo; NO se crea una celda de prueba nueva en el punto B.
3. Sin ninguna herramienta de medición activa: clic normal sobre una celda real. Expected: comportamiento sin cambios (abre popup / copia mensaje de reporte según corresponda) — confirma que la guarda no rompió el flujo existente.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/realCells.ts apps/web/src/lib/map/testCells.ts
git commit -m "fix(web): ceder precedencia a la medición activa sobre clicks de celdas"
```

---

### Task 7: Pase final de verificación manual (checklist de aceptación del spec kit)

**Files:** ninguno (solo verificación, sin cambios de código).

- [ ] **Step 1: Correr el checklist completo de la sección 10 del spec kit**

```bash
cd apps/web && npm run dev
```

En `http://localhost:4321/`, confirmar cada punto (todos deberían ya estar cubiertos por las verificaciones de las Tasks 1-6, este paso es el repaso integrado en una sola sesión de navegador, sin recargar entre pasos):

1. Medir con ruler dos puntos conocidos del mapa → distancia razonable.
2. Medir con arc en las 4 direcciones cardinales → 0°/90°/180°/270°.
3. Cancelar con `Esc` a mitad de medición (punto A puesto, sin B) → no queda un punto A "fantasma" al reactivar la misma herramienta.
4. Activar ruler mientras "Elegir origen" (LOS 360°) está armado → se cancela la selección de origen; y en el sentido opuesto, "Elegir origen" cancela una medición armada.
5. Con modo prueba activo, medir sobre una zona vacía del mapa → NO crea/borra una celda de prueba.
6. Estilo de `<mc-tool-button>` (tema oscuro) coherente visualmente con `.btn-sm`/`.btn-secondary` del resto del sitio (incluye estado hover y estado activo).
7. `npm run build` (desde `apps/web`) termina sin errores.
8. Riesgo abierto del spec kit (§8, punto 3): doble tap en un dispositivo táctil real para armar el punto A y B — no verificable en este entorno de desarrollo (sin dispositivo táctil). Dejar explícitamente pendiente de validación manual antes de mergear a `master`; avisar al usuario en el resumen final en vez de darlo por probado.

```bash
npm run build
```

Expected: build completa sin errores (Astro + Vite/esbuild sobre los archivos nuevos, sin verificación de tipos estricta — ver Global Constraints).

- [ ] **Step 2: Si todo el checklist pasa, no hay commit adicional — el trabajo ya quedó commiteado en las Tasks 1-6.**

Si algún punto falla, volver a la task correspondiente, corregir, y hacer un commit `fix(web): ...` puntual antes de dar por cerrada esta tarea.
