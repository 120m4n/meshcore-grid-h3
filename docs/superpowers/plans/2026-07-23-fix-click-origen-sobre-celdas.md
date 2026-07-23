# Fix: elegir origen LOS 360° debe funcionar sobre celdas activas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que "Elegir origen en el mapa" (simulación LOS 360°) capture las
coordenadas del click aunque el click caiga sobre el polígono de una celda
activa (o de prueba), en vez de disparar el popup de info/reporte de esa
celda.

**Architecture:** El polígono de cada celda (`realCells.ts`, `testCells.ts`)
registra su propio `polygon.on('click', ...)` que hace
`L.DomEvent.stopPropagation(e)` — esto evita que el click llegue al
`map.on('click', ...)` de `radialSimulation.ts` donde vive hoy toda la
lógica de "elegir origen". Se expone el estado de picking
(`isPickingOrigin()`) y la acción de fijar origen (`pickOriginAt(lat,
lon)`) desde `radialSimulation.ts`, y cada handler de click de celda los
consulta *primero*: si se está eligiendo origen, fija el origen y corta —
ni popup de info, ni alta/baja de celda de prueba, ni copiar mensaje de
reporte.

**Tech Stack:** Astro 4 + TypeScript vanilla + Leaflet, sin framework de
componentes (`apps/web/src/lib/map/*.ts`).

## Global Constraints

- No hay test runner configurado en `apps/web` (`package.json` no tiene
  scripts de test) — verificación manual con `npm run build` +
  navegador, siguiendo el patrón ya usado en otros planes de este repo.
- No tocar el modelo de datos ni el backend — este es un fix puramente
  de orden de eventos en el cliente.
- `L.DomEvent.stopPropagation(e)` en cada `polygon.on('click', ...)`
  existente se mantiene (sigue siendo necesario para que un click sobre
  una celda real no dispare también la lógica de creación/baja de celda
  de prueba en modo prueba) — el fix agrega una rama *antes* de esa
  lógica, no la reemplaza.
- `polygon.bindPopup(...)` registra su propio listener interno de
  `click` (que abre el popup) *antes* de que el código de la app
  registre su `polygon.on('click', ...)`. Como Leaflet dispara los
  listeners de un mismo evento en orden de registro, el popup **ya se
  abrió** para cuando nuestro handler corre — por eso el fix llama
  `polygon.closePopup()` explícitamente en vez de asumir que con "no
  abrirlo" alcanza.

---

### Task 1: Exponer `isPickingOrigin()` / `pickOriginAt()` desde `radialSimulation.ts`

**Files:**
- Modify: `apps/web/src/lib/map/radialSimulation.ts:24-35`

**Interfaces:**
- Consumes: nada nuevo (usa el `pickingOrigin`/`onOriginPicked`/`setOriginMarker` ya existentes en el mismo archivo).
- Produces: `isPickingOrigin(): boolean`, `pickOriginAt(lat: number, lon: number): void` — ambos exportados, consumidos por Task 2 y Task 3.

- [x] **Step 1: Reemplazar el bloque `enableOriginPicking` + `map.on('click', ...)`**

Reemplazar (líneas 24-35):

```ts
export function enableOriginPicking(callback: (lat: number, lon: number) => void) {
  pickingOrigin = true;
  onOriginPicked = callback;
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!pickingOrigin) return;
  pickingOrigin = false;
  setOriginMarker(e.latlng.lat, e.latlng.lng);
  onOriginPicked?.(e.latlng.lat, e.latlng.lng);
  onOriginPicked = null;
});
```

por:

```ts
export function enableOriginPicking(callback: (lat: number, lon: number) => void) {
  pickingOrigin = true;
  onOriginPicked = callback;
}

// Expuesto para que los handlers de click de las capas de celdas
// (realCells.ts, testCells.ts) puedan ceder el paso a la selección de
// origen antes de correr su propia lógica (popup de info, alta/baja de
// celda de prueba) — sin esto, un polygon.on('click', ...) que hace
// L.DomEvent.stopPropagation(e) nunca deja llegar el click hasta acá.
export function isPickingOrigin(): boolean {
  return pickingOrigin;
}

export function pickOriginAt(lat: number, lon: number) {
  pickingOrigin = false;
  setOriginMarker(lat, lon);
  onOriginPicked?.(lat, lon);
  onOriginPicked = null;
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!pickingOrigin) return;
  pickOriginAt(e.latlng.lat, e.latlng.lng);
});
```

- [x] **Step 2: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: build termina sin errores de tipo (nadie más usa
`pickingOrigin`/`onOriginPicked` directo todavía, así que este paso no
puede romper nada más).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/map/radialSimulation.ts
git commit -m "$(cat <<'EOF'
refactor(web): exponer isPickingOrigin/pickOriginAt desde radialSimulation

Preparación para que los click handlers de celdas (activas y de prueba)
puedan ceder el paso a la selección de origen LOS 360° antes de correr
su propia lógica de popup/reporte.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `realCells.ts` — priorizar la selección de origen sobre el click de una celda activa

**Files:**
- Modify: `apps/web/src/lib/map/realCells.ts:1-70`

**Interfaces:**
- Consumes: `isPickingOrigin()`, `pickOriginAt(lat, lon)` (Task 1).
- Produces: comportamiento en runtime — click sobre una celda activa mientras se está eligiendo origen fija el origen, no abre el popup de info ni encadena reporte.

- [x] **Step 1: Agregar el import**

En `apps/web/src/lib/map/realCells.ts`, después de la línea 11
(`import { copyReportMessage } from './reportMessage.ts';`):

```ts
import { isPickingOrigin, pickOriginAt } from './radialSimulation.ts';
```

- [x] **Step 2: Agregar la rama de picking al inicio del handler**

Reemplazar el `polygon.on('click', (e) => { ... })` actual (líneas 51-70):

```ts
      polygon.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        showCellOrigins(cell.h3_index); // ver info siempre, sin importar dónde esté parado

        // Encadenar el reporte: una celda ya reportada puede seguir
        // sumando reportes desde otras ubicaciones físicas dentro del
        // mismo hexágono — si el modo prueba está activo y el GPS
        // confirma que el usuario está parado en ESTA celda, copiar el
        // mensaje igual que al crear una celda de prueba nueva.
        if (!isTestModeEnabled()) return;
        if (isAdmin) {
          copyReportMessage(e.latlng.lat, e.latlng.lng);
          return;
        }
        const pos = getLastKnownPosition();
        if (!pos) return; // solo navegando el mapa, sin GPS no hay nada más que hacer
        const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
        if (userH3 !== cell.h3_index) return; // viendo la celda, pero no parado ahí
        copyReportMessage(pos.coords.latitude, pos.coords.longitude);
      });
```

por:

```ts
      polygon.on('click', (e) => {
        L.DomEvent.stopPropagation(e);

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

        showCellOrigins(cell.h3_index); // ver info siempre, sin importar dónde esté parado

        // Encadenar el reporte: una celda ya reportada puede seguir
        // sumando reportes desde otras ubicaciones físicas dentro del
        // mismo hexágono — si el modo prueba está activo y el GPS
        // confirma que el usuario está parado en ESTA celda, copiar el
        // mensaje igual que al crear una celda de prueba nueva.
        if (!isTestModeEnabled()) return;
        if (isAdmin) {
          copyReportMessage(e.latlng.lat, e.latlng.lng);
          return;
        }
        const pos = getLastKnownPosition();
        if (!pos) return; // solo navegando el mapa, sin GPS no hay nada más que hacer
        const userH3 = latLngToCell(pos.coords.latitude, pos.coords.longitude, H3_RESOLUTION);
        if (userH3 !== cell.h3_index) return; // viendo la celda, pero no parado ahí
        copyReportMessage(pos.coords.latitude, pos.coords.longitude);
      });
```

- [x] **Step 3: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/realCells.ts
git commit -m "$(cat <<'EOF'
fix(web): permitir elegir origen LOS 360° sobre una celda activa

Un click sobre el polígono de una celda activa mientras se está
eligiendo origen fijaba el popup de info (y encadenaba reporte en modo
prueba) en vez de capturar las coordenadas para la simulación.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `testCells.ts` — mismo fix sobre celdas de prueba (consistencia)

> No fue mencionado explícitamente en el pedido (que habla de "celdas
> activas"), pero el polígono de una celda de prueba tiene exactamente el
> mismo patrón (`bindPopup` + `on('click', ...)` con
> `stopPropagation`) — sin este task, elegir origen sobre una celda de
> prueba se rompe igual que hoy se rompe sobre una celda activa. Incluido
> por consistencia; se puede descartar sin afectar Task 1/2 si se
> prefiere acotar el fix solo a celdas activas.

**Files:**
- Modify: `apps/web/src/lib/map/testCells.ts:47-66`

**Interfaces:**
- Consumes: `isPickingOrigin()`, `pickOriginAt(lat, lon)` (Task 1).
- Produces: comportamiento en runtime — click sobre una celda de prueba mientras se está eligiendo origen fija el origen, no la remueve.

- [x] **Step 1: Agregar el import**

En `apps/web/src/lib/map/testCells.ts`, después de la línea 15
(`import { copyReportMessage } from './reportMessage.ts';`):

```ts
import { isPickingOrigin, pickOriginAt } from './radialSimulation.ts';
```

- [x] **Step 2: Agregar la rama de picking al inicio del handler**

Reemplazar (líneas 62-65):

```ts
  polygon.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    removeTestCell(cell.h3_index);
  });
```

por:

```ts
  polygon.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (isPickingOrigin()) {
      polygon.closePopup();
      pickOriginAt(e.latlng.lat, e.latlng.lng);
      return;
    }
    removeTestCell(cell.h3_index);
  });
```

- [x] **Step 3: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/testCells.ts
git commit -m "$(cat <<'EOF'
fix(web): permitir elegir origen LOS 360° sobre una celda de prueba

Mismo fix que en realCells.ts, por consistencia: el polígono de una
celda de prueba también intercepta el click con stopPropagation antes
de que llegue al listener de selección de origen.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verificación manual en navegador

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Levantar el frontend en dev**

```bash
cd apps/web
npm run dev
```

- [ ] **Step 2: Verificación visual**

1. Abrir el mapa, asegurarse de que haya al menos una celda activa
   visible (real o de prueba, vía "Activar modo prueba").
2. Click en "Elegir origen en el mapa".
3. Click directamente sobre el polígono de una celda activa.

Expected: aparece/mueve el marcador turquesa de origen en ese punto, el
label de origen en el panel se actualiza con esas coordenadas, **no**
se abre el popup de info de la celda ni se dispara ningún toast de
reporte.

4. Repetir el click sobre esa misma celda *sin* estar en modo "elegir
   origen".

Expected: comportamiento de siempre — se abre el popup de info (y, en
modo prueba, la lógica de reporte encadenado si corresponde).

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-3.

---

## Hallazgo relacionado (fuera de alcance de este plan)

Durante la investigación se detectó un problema adyacente, no pedido
explícitamente: `testCells.ts` registra su propio `map.on('click',
handleMapClick)` (dentro de `initTestMode`), un listener *separado* del
`map.on('click', ...)` de `radialSimulation.ts`. Ambos escuchan el mismo
evento `click` del mapa (no hay `stopPropagation` entre ellos porque
ninguno es hijo del otro — son dos listeners independientes sobre el
mismo `map`). Como el módulo `radialSimulation.ts` se evalúa antes de
que `mapPage.ts` llame a `initTestMode()`, su listener **siempre**
corre primero.

Consecuencia: si un admin (que tiene el modo prueba activo de forma
permanente) hace click en un punto *vacío* del mapa para elegir origen,
`radialSimulation` fija el origen correctamente, pero acto seguido
`handleMapClick` (que no sabe nada de "elegir origen") también procesa
ese mismo click como si fuera un click normal de modo prueba — puede
terminar creando una celda de prueba falsa y copiando un mensaje de
reporte en ese punto.

Arreglarlo bien requiere más cuidado que los Tasks 1-3: como
`pickOriginAt` apaga `pickingOrigin` de forma síncrona y
`handleMapClick` corre *después* dentro del mismo click, un simple
`if (isPickingOrigin()) return;` al inicio de `handleMapClick` no
alcanza (para cuando se evalúa, el flag ya está en `false`). Haría falta
diferir el apagado del flag (p.ej. con `queueMicrotask`) o centralizar
ambos listeners en un solo punto de entrada — un cambio de diseño más
delicado que el fix pedido. Se deja fuera de este plan; avisar si se
quiere abordar aparte.
