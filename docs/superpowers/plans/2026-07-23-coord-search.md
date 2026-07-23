# Buscador de coordenadas en el mapa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un panel al mapa público que permita pegar/tipear
`lat,lon` (ej. `7.12,-73.13`) y navegar el mapa a ese punto, dejando un
marcador que se reemplaza en cada búsqueda nueva.

**Architecture:** Módulo nuevo `apps/web/src/lib/map/coordSearch.ts`
(mismo patrón que `radialSimulation.ts`/`testCells.ts`): encapsula el
parseo/sanitización del input, la navegación (`map.flyTo`) y el manejo
del único marcador (`L.CircleMarker`), sin exponer estado hacia afuera.
Panel flotante nuevo en `index.astro` con input + botón "Ir",
inicializado una sola vez desde `mapPage.ts`.

**Tech Stack:** Astro 4 + TypeScript vanilla + Leaflet, sin framework de
componentes (`apps/web/src/lib/map/*.ts`).

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-23-coord-search-design.md`.
- No hay test runner en `apps/web` — verificación manual con `npm run build` + navegador.
- Regex de formato idéntico al ya usado en `reportPage.ts:85`
  (`LAT_LON_PASTE`), por consistencia — no inventar un parser nuevo.
- Rango válido: dentro de `SANTANDER_BOUNDS` (`mapBounds.ts`), no el
  rango universal de lat/lon — coordenadas numéricamente válidas pero
  fuera de Santander se rechazan igual.
- Zoom fijo `16` al navegar (no relativo al zoom actual).
- El componente es público (sin auth), mismo criterio que el panel LOS 360°.

---

### Task 1: Crear `coordSearch.ts`

**Files:**
- Create: `apps/web/src/lib/map/coordSearch.ts`

**Interfaces:**
- Consumes: `map` (`./setup.ts`), `showToast(message: string, type: 'success'|'error')` (`../toast.ts`), `SANTANDER_BOUNDS` (`../mapBounds.ts`).
- Produces: `export function initCoordSearch(): void` — consumido por Task 3.

- [x] **Step 1: Escribir el archivo completo**

```ts
import L from 'leaflet';
import { showToast } from '../toast.ts';
import { SANTANDER_BOUNDS } from '../mapBounds.ts';
import { map } from './setup.ts';

// Mismo formato que LAT_LON_PASTE en reportPage.ts:85 — un solo par
// "lat,lon" separado por coma, sin soportar Plus Codes ni direcciones.
const LAT_LON_FORMAT = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

// Zoom fijo al navegar, igual al que usa geolocalización en vivo
// (testCells.ts) para consistencia visual entre "ir a mi ubicación" e
// "ir a estas coordenadas".
const TARGET_ZOOM = 16;

let searchMarker: L.CircleMarker | null = null;

// Incrementado en cada búsqueda válida — el callback de moveend de una
// búsqueda vieja se descarta si para cuando corre ya hay una más nueva
// en vuelo (flyTo interrumpido por un segundo pegado rápido).
let searchToken = 0;

function goToCoords(rawText: string) {
  const text = rawText.trim();
  const match = text.match(LAT_LON_FORMAT);
  if (!match) {
    showToast('Formato inválido — usá lat,lon (ej: 7.12,-73.13)', 'error');
    return;
  }

  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  const [[minLat, minLon], [maxLat, maxLon]] = SANTANDER_BOUNDS;
  if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
    showToast('Coordenadas fuera del área de Santander', 'error');
    return;
  }

  const token = ++searchToken;
  map.flyTo([lat, lon], TARGET_ZOOM);
  map.once('moveend', () => {
    if (token !== searchToken) return; // una búsqueda más nueva ya interrumpió esta animación
    if (searchMarker) {
      map.removeLayer(searchMarker);
    }
    searchMarker = L.circleMarker([lat, lon], {
      radius: 7,
      color: '#ffffff',
      weight: 2,
      fillColor: '#e67e22',
      fillOpacity: 0.9,
    }).addTo(map);
  });
}

export function initCoordSearch() {
  const input = document.getElementById('coord-input') as HTMLInputElement;
  const btnGo = document.getElementById('btn-coord-go') as HTMLButtonElement;

  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text')?.trim();
    if (!text || !LAT_LON_FORMAT.test(text)) return;
    e.preventDefault();
    input.value = text;
    goToCoords(text);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    goToCoords(input.value);
  });

  btnGo.addEventListener('click', () => {
    goToCoords(input.value);
  });
}
```

- [x] **Step 2: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: falla porque `#coord-input`/`#btn-coord-go` todavía no existen
en ningún `.astro` — es esperable, `initCoordSearch()` no se llama
todavía (Task 3). El build en sí (compilación TS/Astro) debe pasar sin
errores de tipo; el `getElementById` con cast no falla en build time.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/map/coordSearch.ts
git commit -m "$(cat <<'EOF'
feat(web): agregar coordSearch.ts para navegar a lat,lon en el mapa

Encapsula sanitización del formato lat,lon, navegación (flyTo) y
manejo del marcador único que se reemplaza en cada búsqueda.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Markup del panel + estilos

**Files:**
- Modify: `apps/web/src/pages/index.astro` (agregar el panel después de `<div id="map"></div>`, antes de `.radar-panel`)
- Modify: `apps/web/src/styles/global.css` (agregar `.coord-panel` y afines, después del bloque `#radar-progress-label { color: var(--text-dim); }`)

**Interfaces:**
- Produces: elementos DOM `#coord-panel`, `#coord-input`, `#btn-coord-go` que Task 1's `initCoordSearch()` (llamado en Task 3) consume.

- [x] **Step 1: Agregar el panel en `index.astro`**

En `apps/web/src/pages/index.astro`, inmediatamente después de
`<div id="map"></div>` y antes de `<div class="radar-panel" id="radar-panel">`:

```astro
  <div class="coord-panel" id="coord-panel">
    <div class="coord-panel-title">Ir a coordenadas</div>
    <div class="coord-panel-row">
      <input type="text" id="coord-input" placeholder="lat,lon (ej: 7.12,-73.13)" />
      <button class="btn-sm btn-secondary" id="btn-coord-go" type="button">Ir</button>
    </div>
  </div>
```

- [x] **Step 2: Agregar `.coord-panel` a `global.css`**

En `apps/web/src/styles/global.css`, inmediatamente después del bloque:

```css
#radar-progress-label {
  color: var(--text-dim);
}
```

agregar:

```css

/* HUD flotante "ir a coordenadas" — mismo lenguaje visual que
   .legend/.radar-panel. Ubicado arriba a la izquierda, por debajo del
   control de zoom nativo de Leaflet (top-left por defecto) para no
   superponerse. */
.coord-panel {
  position: absolute;
  z-index: 500;
  left: 0.9rem;
  top: 5rem;
  width: 220px;
  background: rgba(16, 29, 46, 0.92);
  border: 1px solid var(--border-bright);
  border-radius: 6px;
  padding: 0.7rem 0.8rem;
  font-family: var(--font-display);
  font-size: 0.7rem;
  color: var(--text-dim);
  backdrop-filter: blur(4px);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.coord-panel-title {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text);
}
.coord-panel-row {
  display: flex;
  gap: 0.4rem;
}
.coord-panel-row input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-bright);
  border-radius: 4px;
  color: var(--text);
  padding: 0.3rem 0.4rem;
  font-size: 0.75rem;
}
```

- [x] **Step 3: Verificar que el build de Astro no rompe**

```bash
cd apps/web
npm run build
```

Expected: termina con `dist/` generado, sin errores.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/src/styles/global.css
git commit -m "$(cat <<'EOF'
feat(web): agregar markup y estilos del panel "Ir a coordenadas"

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire — llamar `initCoordSearch()` desde `mapPage.ts`

**Files:**
- Modify: `apps/web/src/lib/mapPage.ts`

**Interfaces:**
- Consumes: `initCoordSearch()` (Task 1).

- [x] **Step 1: Agregar el import**

En `apps/web/src/lib/mapPage.ts`, junto a los demás imports de `./map/*`:

```ts
import { initCoordSearch } from './map/coordSearch.ts';
```

- [x] **Step 2: Llamar la función de init**

Inmediatamente después de la línea `initTestMode(isAdmin);`:

```ts
initTestMode(isAdmin);
initCoordSearch();
```

- [x] **Step 3: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/mapPage.ts
git commit -m "$(cat <<'EOF'
feat(web): inicializar el buscador de coordenadas en el mapa

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verificación manual en navegador

**Files:** ninguno (solo verificación).

- [x] **Step 1: Levantar el frontend en dev**

```bash
cd apps/web
npm run dev
```

- [x] **Step 2: Casos a verificar**

1. Pegar `7.12,-73.13` en `#coord-input` → el mapa vuela ahí (zoom 16) y,
   al terminar la animación, aparece un marcador naranja con borde
   blanco en ese punto exacto.
2. Pegar una segunda coordenada distinta, ej. `7.00,-73.00` → el
   marcador anterior desaparece, aparece uno nuevo en el lugar correcto
   (nunca dos marcadores a la vez).
3. Tipear manualmente `6.95,-72.90` (sin pegar) y presionar Enter →
   mismo comportamiento que pegar.
4. Con el input lleno, click en el botón "Ir" → mismo comportamiento.
5. Pegar texto inválido: `hola`, `7.12`, `7.12;-73.13` → toast "Formato
   inválido — usá lat,lon (ej: 7.12,-73.13)", sin navegar ni tocar el
   marcador existente.
6. Pegar coordenadas numéricamente válidas pero fuera de Santander, ej.
   `4.60,-74.08` (Bogotá) → toast "Coordenadas fuera del área de
   Santander", sin navegar.
7. Confirmar visualmente que `#coord-panel` no se superpone con el
   control de zoom (+/-) de Leaflet en la esquina superior izquierda del
   mapa; ajustar `top` en `.coord-panel` si hiciera falta.

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-3.


## Nota de verificación (post-implementación)

`top: 5rem` en `.coord-panel` (como estaba escrito originalmente en este
plan) se superponía con el control de zoom nativo de Leaflet
(`.leaflet-control-zoom`, bbox real `y: 62–126px`) — confirmado con
Playwright (`boundingBox()` de ambos elementos se solapaba en
`y: 80–126`). Ajustado a `top: 8.5rem` en `global.css`, con lo que el
panel arranca en `y: 136px`, limpio debajo del control de zoom. Se
verificaron con Playwright headless: paste válido → marcador único en
el punto correcto; segunda búsqueda → mismo marcador reposicionado (no
duplicado, confirmado por conteo de `path.leaflet-interactive` y por
las coordenadas SVG idénticas ya que el mapa recentra el punto al medio
del viewport en ambos casos); texto inválido → toast "Formato
inválido..." sin nuevo marcador; coordenadas fuera de Santander (Bogotá)
→ toast "Coordenadas fuera del área de Santander" sin nuevo marcador.
