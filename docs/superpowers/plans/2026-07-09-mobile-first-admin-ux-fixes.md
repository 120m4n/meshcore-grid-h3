# Mobile-first + consistencia visual en /admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corregir tres defectos de UX/UI confirmados visualmente: (1) 4 de
las 5 vistas no tienen meta viewport y el header queda tapado por el mapa
en pantallas angostas, (2) el contenido de `/admin` está pegado al borde
izquierdo por falta de padding en `<main>` y sus tablas no son responsive,
(3) los botones de acción en `/admin` (Editar, Guardar, Cancelar, Revertir,
Generar código, Aprobar, Rechazar) no usan el sistema de diseño existente
(`.btn-secondary`/`.btn-danger`) y quedan con el estilo default del
navegador, además de amontonarse sin espaciado en mobile.

**Architecture:** Los tres defectos son puramente CSS/markup — sin cambios
de lógica ni de API. Fix 1 reemplaza un offset en píxeles hardcodeado
(`#map { top: 56px }`) por un layout flex-column en `body`, que hace que
el mapa ocupe el espacio restante debajo del topbar sin importar cuántas
filas ocupe el nav. Fix 2 agrega una regla `main { padding }` genérica
(inofensiva para las páginas que ya usan `.form-container`, por
especificidad CSS) y envuelve las tablas en un contenedor con scroll
horizontal. Fix 3 agrega una clase de tamaño compacto (`.btn-sm`) y un
wrapper de spacing (`.table-actions`) reutilizando los colores/family ya
definidos en `.btn-secondary`/`.btn-danger`, sin inventar un sistema de
botones nuevo.

**Tech Stack:** Astro 4 + CSS plano (sin framework de componentes) en
`apps/web`. Sin test runner — verificación por build (`npm run build`) +
captura visual con Playwright (mismo patrón ya usado en
`docs/MANUAL_TESTING.md`), no hay suite de tests automatizada en este
proyecto.

## Global Constraints

- No agregar dependencias nuevas a `package.json`.
- No tocar `apps/api` — los tres defectos son 100% frontend.
- Mantener la paleta/tipografía existente (`--accent`, `--font-display`,
  etc. definidos en `:root` de `global.css`) — no introducir colores o
  fuentes nuevas.
- Cada task debe dejar `npm run build` pasando antes de pasar a la
  siguiente.
- Verificación visual con Playwright a 375px de ancho (el caso más
  angosto razonable, ver capturas de diagnóstico de esta sesión) y a
  1200px (desktop, chequeo de regresión).
- Actualizar `docs/MANUAL_TESTING.md` al final con los pasos de
  verificación mobile-first, seudo-código.

---

### Task 1: Meta viewport faltante + header tapado por el mapa en mobile

**Diagnóstico confirmado esta sesión (capturas Playwright a 375px):**
Solo `apps/web/src/pages/index.astro` tiene
`<meta name="viewport" content="width=device-width, initial-scale=1.0" />`
— `login.astro`, `register.astro`, `reportar.astro` y `admin/index.astro`
NO la tienen, lo que hace que un navegador móvil real renderice esas 4
páginas en un viewport virtual de ~980px y las escale hacia abajo (texto y
botones minúsculos, requiere pinch-zoom) — un defecto más fundamental que
cualquier ajuste de CSS, y no visible en capturas de Playwright con
`viewport: {width: 375}` porque Playwright fija el viewport CSS
directamente sin pasar por el mecanismo de meta viewport.

Además, en `index.astro`, `#map` usa `position: absolute; top: 56px;`
— un offset fijo que asume que `.topbar` mide siempre una fila. En mobile
el `<nav>` del topbar hace `flex-wrap: wrap` a 2+ filas (confirmado en
captura: 3 botones ya wrappean a 375px, incluso deslogueado), y el mapa
(posicionado en absoluto desde y=56px) queda tapando esa segunda fila de
botones — se ven cortados/inaccesibles.

**Files:**
- Modify: `apps/web/src/pages/login.astro`
- Modify: `apps/web/src/pages/register.astro`
- Modify: `apps/web/src/pages/reportar.astro`
- Modify: `apps/web/src/pages/admin/index.astro`
- Modify: `apps/web/src/styles/global.css`

**Interfaces:** Ninguna — cambios de markup/CSS puros, sin funciones ni
tipos nuevos.

- [ ] **Step 1: Agregar meta viewport a las 4 páginas que no la tienen**

En `apps/web/src/pages/login.astro`, la línea 5 actual es:

```astro
<head><meta charset="UTF-8" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Ingresar — MeshCore Santander</title></head>
```

Reemplazar por:

```astro
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Ingresar — MeshCore Santander</title></head>
```

En `apps/web/src/pages/register.astro`, la línea 5 actual es:

```astro
<head><meta charset="UTF-8" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Registro — MeshCore Santander</title></head>
```

Reemplazar por:

```astro
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Registro — MeshCore Santander</title></head>
```

En `apps/web/src/pages/reportar.astro`, las líneas 6-10 actuales son:

```astro
<head>
  <meta charset="UTF-8" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>Reportar conectividad — MeshCore Santander</title>
</head>
```

Reemplazar por:

```astro
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <title>Reportar conectividad — MeshCore Santander</title>
</head>
```

En `apps/web/src/pages/admin/index.astro`, la línea 5 actual es:

```astro
<head><meta charset="UTF-8" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Moderación — MeshCore Santander</title></head>
```

Reemplazar por:

```astro
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Moderación — MeshCore Santander</title></head>
```

(`index.astro` ya tiene esta meta tag desde antes — no tocar.)

- [ ] **Step 2: Layout flex para que el mapa no dependa de un offset fijo**

En `apps/web/src/styles/global.css`, la regla actual (cerca de la línea
44):

```css
html, body {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--text);
}
```

Reemplazar por:

```css
html, body {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--text);
}

/* topbar + contenido en columna: el mapa (única página con contenido de
   altura fija en vez de largo natural) usa flex:1 para ocupar el resto
   del viewport sin un offset en píxeles fijo. Antes #map tenía
   "top: 56px" hardcodeado asumiendo que .topbar mide siempre una fila —
   en mobile el nav hace wrap a 2+ filas y el mapa (position:absolute)
   quedaba tapando esa segunda fila de botones. En el resto de las
   páginas (formularios, admin) esto no cambia nada visible: <main>
   sigue con su alto natural de contenido, no estirado, porque no tiene
   flex explícito (default flex: 0 1 auto). */
body {
  display: flex;
  flex-direction: column;
}
```

Luego, la regla `#map` actual (cerca de la línea 179):

```css
#map {
  position: absolute;
  top: 56px;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg);
}
```

Reemplazar por:

```css
#map {
  flex: 1;
  min-height: 0; /* sin esto, un flex item en columna puede no encogerse
    por debajo de su alto de contenido intrínseco */
  position: relative; /* Leaflet posiciona sus panes internos (tiles,
    controles) en absolute relativo a este contenedor */
  background: var(--bg);
}
```

`.legend` y `.brand-overlay` (siblings de `#map`, `position: absolute`
anclados por `bottom`, no `top`) no necesitan cambios: siguen resolviendo
contra el viewport (body sigue en `position: static`, `display:flex` no
crea un containing block nuevo) y su ancla inferior es correcta sin
importar cuánto mida `.topbar`.

- [ ] **Step 3: Verificar que el build pase**

```bash
cd apps/web
npm run build
```

Expected: termina sin errores, 5 páginas generadas.

- [ ] **Step 4: Verificación visual con Playwright — mobile y desktop**

```bash
npm run preview &
sleep 2
node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const pages = ['/', '/login', '/register', '/reportar', '/admin'];

  for (const width of [375, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    await context.route('**/api/v1/cells', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.route('**/api/v1/admin/reports*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.route('**/api/v1/admin/invite-codes', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.addInitScript(() => { localStorage.setItem('token','fake'); localStorage.setItem('role','admin'); });
    const page = await context.newPage();
    for (const path of pages) {
      await page.goto('http://localhost:4321' + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.screenshot({ path: \`/tmp/mobile_fix_\${width}\${path.replace(/\//g,'_') || '_index'}.png\`, fullPage: true });
    }
    await context.close();
  }
  await browser.close();
})();
"
pkill -f "astro preview"
```

Expected en las capturas de 375px: en `/`, todos los botones del nav
(Ingresar/Activar modo prueba/Actualizar mapa, o el set completo si hay
sesión admin) son completamente visibles, ninguno queda tapado por el
mapa — si el nav ocupa 2 filas, el mapa arranca debajo de la segunda fila,
no de la primera. En las 5 páginas, el texto se ve a tamaño legible sin
necesidad de zoom (confirma que la meta viewport surte efecto).
Expected en las capturas de 1200px: idénticas a como se veían antes de
este fix (regresión visual = cero cambios en desktop).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/login.astro apps/web/src/pages/register.astro \
  apps/web/src/pages/reportar.astro apps/web/src/pages/admin/index.astro \
  apps/web/src/styles/global.css
git commit -m "$(cat <<'EOF'
fix(web): meta viewport faltante + header tapado por el mapa en mobile

login/register/reportar/admin no tenían <meta name="viewport">, dejando
esas 4 páginas renderizadas en un viewport virtual de ~980px en
navegadores móviles reales (texto/botones minúsculos, requiere
pinch-zoom) — no detectable con Playwright a un viewport CSS fijo, solo
visible en dispositivo real o emulación con meta viewport activa.

Además #map usaba un offset "top: 56px" hardcodeado asumiendo que el
topbar mide siempre una fila; en mobile el nav hace wrap a 2+ filas y
el mapa (position:absolute) tapaba esa segunda fila de botones.
Reemplazado por layout flex-column en body + #map con flex:1, robusto a
cualquier altura de topbar sin magic numbers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Padding del `<main>` de admin + tablas con scroll horizontal en mobile

**Diagnóstico confirmado esta sesión (captura Playwright, admin a 375px y
1200px):** "Reportes pendientes", "No hay reportes pendientes.", "Celdas
activas", "Filtrar por plus code", "Códigos de invitación" y "Generar
código" están pegados al borde izquierdo del viewport. Causa: `<main>` en
`apps/web/src/pages/admin/index.astro` no tiene ninguna clase, y no existe
ninguna regla CSS que apunte a un `main` sin clase en `global.css` — las
otras 3 páginas con formulario usan `<main class="form-container">`, que
sí trae su propio `padding: 1rem`. Además las 3 tablas de admin
(`reports-table`, `cells-table`, `invite-codes-table`) no tienen wrapper
de scroll: en mobile, con 6 columnas, la tabla fuerza el ancho de toda la
página y rompe el layout horizontal (confirmado en captura del Task de
edición inline, sección de diagnóstico).

**Files:**
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/pages/admin/index.astro`

**Interfaces:** Ninguna — CSS/markup puro.

- [ ] **Step 1: Padding genérico para `<main>`**

En `apps/web/src/styles/global.css`, ubicar el bloque de `.form-container`
(cerca de la línea 320) y agregar la regla nueva **antes** de ese bloque:

```css
/* padding base para cualquier <main> sin clase propia (hoy solo
   /admin) — .form-container (login/registro/reportar) ya trae su
   propio padding con mayor especificidad (selector de clase > de
   elemento), así que esta regla no le cambia nada a esas páginas. */
main {
  padding: 1.25rem 1.25rem 2rem;
}

/* ============ formularios (login/registro/reportar/admin) ============ */
.form-container {
  max-width: 480px;
  margin: 2rem auto;
  padding: 1rem;
  ...
```

(Dejar el resto de `.form-container` sin cambios — solo se agrega la
regla `main { padding: ... }` inmediatamente antes.)

- [ ] **Step 2: Envolver las 3 tablas de admin con scroll horizontal**

En `apps/web/src/styles/global.css`, agregar esta regla nueva junto a las
reglas existentes de `table`/`th`/`td` (cerca de la línea 492):

```css
/* wrapper de scroll horizontal — evita que una tabla ancha (ej.
   6 columnas de "Celdas activas") fuerce el ancho de toda la página en
   mobile; el scroll queda contenido dentro de la tabla, no en el body. */
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```

En `apps/web/src/pages/admin/index.astro`, envolver cada uno de los 3
`<table>` con `<div class="table-scroll">`. El archivo completo queda:

```astro
---
import '../../styles/global.css';
---
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Moderación — MeshCore Santander</title></head>
<body>
  <header class="topbar">
    <h1>Moderación</h1>
    <nav><a href="/">Volver al mapa</a></nav>
  </header>

  <main>
    <h2 class="section-title">Reportes pendientes</h2>
    <div class="table-scroll">
      <table id="reports-table">
        <thead>
          <tr>
            <th>Celda H3</th><th>Quién reporta</th><th>Calidad</th>
            <th>Mensaje</th><th>Fecha</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p id="status" class="hint"></p>

    <h2 class="section-title">Celdas activas</h2>
    <label>Filtrar por plus code
      <input type="text" id="cells-filter" placeholder="p.ej. 869876XV+GX" autocomplete="off" />
    </label>
    <div class="table-scroll">
      <table id="cells-table">
        <thead>
          <tr>
            <th>Celda H3</th><th>Plus code</th><th>Señal</th><th>Reportes</th><th>Última actualización</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p id="cells-status" class="hint"></p>

    <h2 class="section-title">Códigos de invitación</h2>
    <button id="btn-generate-invite" class="btn-secondary">Generar código</button>
    <div class="table-scroll">
      <table id="invite-codes-table">
        <thead>
          <tr>
            <th>Código</th><th>Estado</th><th>Creado</th><th>Expira / usado</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <p id="invite-codes-status" class="hint"></p>
  </main>

  <script src="../../lib/adminPage.ts"></script>
</body>
</html>
```

(Nota: `class="btn-secondary"` en `#btn-generate-invite` ya está incluido
arriba — es parte de este Step para no dejar el archivo en un estado
intermedio inconsistente; el resto de las clases de botones se agregan en
el Task 3 vía `adminPage.ts`, que genera HTML dinámicamente y no vive en
este archivo `.astro`.)

- [ ] **Step 3: Verificar build**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 4: Verificación visual con Playwright**

```bash
npm run preview &
sleep 2
node -e "
const { chromium } = require('playwright');
const H3 = '8866089b3dfffff';
const CELLS = JSON.stringify([{ h3_index: H3, score_pct: 80, report_count: 3, last_report_at: new Date().toISOString(), plus_code: '67V84VCH+GM', manual_override: false }]);
(async () => {
  const browser = await chromium.launch();
  for (const width of [375, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/api/v1/cells', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: CELLS }));
    await context.route('**/api/v1/admin/reports*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.route('**/api/v1/admin/invite-codes', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.addInitScript(() => { localStorage.setItem('token','fake'); localStorage.setItem('role','admin'); });
    const page = await context.newPage();
    await page.goto('http://localhost:4321/admin', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: \`/tmp/admin_padding_\${width}.png\`, fullPage: true });
    await context.close();
  }
  await browser.close();
})();
"
pkill -f "astro preview"
```

Expected: en ambos anchos, "Reportes pendientes", "No hay reportes
pendientes.", "Celdas activas", "Filtrar por plus code", "Códigos de
invitación" y "Generar código" tienen separación visible respecto al
borde izquierdo del viewport (no pegados). A 375px, la tabla "Celdas
activas" (la más ancha, 6 columnas) puede desbordar horizontalmente
*dentro de su propio contenedor* con scroll — pero el resto de la página
(inputs, botones, títulos) NO se corre ni fuerza scroll horizontal del
body completo.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/global.css apps/web/src/pages/admin/index.astro
git commit -m "$(cat <<'EOF'
fix(web): padding de <main> en /admin + tablas con scroll horizontal

<main> en admin/index.astro no tenía ninguna clase ni regla CSS propia
(a diferencia de .form-container en login/registro/reportar), dejando
todo el contenido pegado al borde izquierdo. Se agrega un padding base
para cualquier <main> sin clase (no afecta a .form-container por
especificidad) y se envuelven las 3 tablas en un contenedor con
overflow-x:auto para que no rompan el layout horizontal en mobile.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Sistema de botones consistente en `/admin` (Editar, Guardar, Cancelar, Revertir, Aprobar, Rechazar)

**Diagnóstico confirmado esta sesión (captura Playwright, tabla "Celdas
activas" en modo edición, desktop y mobile):** Los botones generados
dinámicamente en `apps/web/src/lib/adminPage.ts` (Editar, Guardar,
Cancelar, Revertir a automático, y también Aprobar/Rechazar en la tabla
de reportes pendientes — mismo defecto de código, sin confirmar
visualmente porque la tabla estaba vacía en la captura) no llevan ninguna
clase CSS: caen al estilo default gris del navegador en vez de usar
`.btn-secondary`/`.btn-danger` ya definidos en `global.css` (mismos que
sí usa "Eliminar", que se ve correctamente temático). Es un problema de
estilos, no de lógica — el defecto es "falta la clase", no un bug de
comportamiento. Adicionalmente, en mobile, "Guardar"/"Cancelar" dentro de
la celda "Acciones" wrappean a 2 líneas sin espaciado entre sí (se tocan),
un problema de layout separado que se resuelve con un wrapper flex.

**Files:**
- Modify: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/lib/adminPage.ts`

**Interfaces:**
- Consumes: clases ya existentes `.btn-secondary`, `.btn-danger` (definidas
  en `global.css`, min-height 44px pensado para CTAs de formulario — muy
  altas para 3-4 botones por fila de tabla).
- Produces: clase nueva `.btn-sm` (modificador de tamaño, se combina con
  `.btn-secondary`/`.btn-danger`) y `.table-actions` (wrapper flex con
  gap), ambas consumidas solo por el HTML generado en `adminPage.ts`.

- [ ] **Step 1: Clase `.btn-sm` (variante compacta) y `.table-actions` (wrapper de spacing)**

En `apps/web/src/styles/global.css`, agregar esta regla nueva
inmediatamente después del bloque `.btn-danger` existente (cerca de la
línea 440, después de `.btn-danger:hover { background: rgba(231, 76, 60, 0.12); }`):

```css
/* variante compacta de .btn-secondary/.btn-danger para celdas de tabla
   densas (3-4 acciones por fila) — mismo color/family, min-height más
   chico que el de un CTA de formulario (44px es demasiado alto ahí). */
.btn-sm {
  min-height: 32px;
  padding: 0.35rem 0.6rem;
  font-size: 0.68rem;
}

/* wrapper de spacing para botones de acción dentro de una celda de
   tabla — evita que se toquen entre sí al wrappear en mobile. */
.table-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
```

- [ ] **Step 2: Aplicar las clases en `adminPage.ts` — tabla de reportes pendientes**

En `apps/web/src/lib/adminPage.ts`, la función `load()` tiene este bloque
(línea ~29-31):

```ts
        <td>
          <button data-id="${r.id}" data-action="approved">Aprobar</button>
          <button data-id="${r.id}" data-action="rejected">Rechazar</button>
        </td>`;
```

Reemplazar por:

```ts
        <td>
          <div class="table-actions">
            <button class="btn-secondary btn-sm" data-id="${r.id}" data-action="approved">Aprobar</button>
            <button class="btn-danger btn-sm" data-id="${r.id}" data-action="rejected">Rechazar</button>
          </div>
        </td>`;
```

- [ ] **Step 3: Aplicar las clases en `adminPage.ts` — tabla de celdas activas**

En la misma archivo, la función `renderCellsTable()` tiene este bloque
(línea ~64-72):

```ts
    const scoreCell = isEditing
      ? `<input type="number" min="0" max="100" step="1" value="${Math.round(cell.score_pct)}" id="score-input-${cell.h3_index}" style="width:5rem" />`
      : `${Math.round(cell.score_pct)}%${cell.manual_override ? ' <span class="hint" title="Fijado a mano por un admin">(manual)</span>' : ''}`;
    const actionsCell = isEditing
      ? `<button data-action="save" data-h3="${cell.h3_index}">Guardar</button>
         <button data-action="cancel" data-h3="${cell.h3_index}">Cancelar</button>`
      : `<button data-action="edit" data-h3="${cell.h3_index}">Editar</button>
         ${cell.manual_override ? `<button data-action="revert" data-h3="${cell.h3_index}">Revertir a automático</button>` : ''}
         <button class="btn-danger" data-action="delete" data-h3="${cell.h3_index}">Eliminar</button>`;
```

Reemplazar por:

```ts
    const scoreCell = isEditing
      ? `<input type="number" min="0" max="100" step="1" value="${Math.round(cell.score_pct)}" id="score-input-${cell.h3_index}" style="width:5rem" />`
      : `${Math.round(cell.score_pct)}%${cell.manual_override ? ' <span class="hint" title="Fijado a mano por un admin">(manual)</span>' : ''}`;
    const actionsCell = isEditing
      ? `<div class="table-actions">
           <button class="btn-secondary btn-sm" data-action="save" data-h3="${cell.h3_index}">Guardar</button>
           <button class="btn-secondary btn-sm" data-action="cancel" data-h3="${cell.h3_index}">Cancelar</button>
         </div>`
      : `<div class="table-actions">
           <button class="btn-secondary btn-sm" data-action="edit" data-h3="${cell.h3_index}">Editar</button>
           ${cell.manual_override ? `<button class="btn-secondary btn-sm" data-action="revert" data-h3="${cell.h3_index}">Revertir a automático</button>` : ''}
           <button class="btn-danger btn-sm" data-action="delete" data-h3="${cell.h3_index}">Eliminar</button>
         </div>`;
```

- [ ] **Step 4: Verificar build**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 5: Verificación visual con Playwright — estado de edición activo**

```bash
npm run preview &
sleep 2
node -e "
const { chromium } = require('playwright');
const H3 = '8866089b3dfffff';
const CELLS = JSON.stringify([{ h3_index: H3, score_pct: 80, report_count: 3, last_report_at: new Date().toISOString(), plus_code: '67V84VCH+GM', manual_override: false }]);
(async () => {
  const browser = await chromium.launch();
  for (const width of [375, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/api/v1/cells', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: CELLS }));
    await context.route('**/api/v1/admin/reports*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.route('**/api/v1/admin/invite-codes', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await context.addInitScript(() => { localStorage.setItem('token','fake'); localStorage.setItem('role','admin'); });
    const page = await context.newPage();
    await page.goto('http://localhost:4321/admin', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.click('button[data-action=edit]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: \`/tmp/admin_buttons_\${width}.png\`, fullPage: true });
    await context.close();
  }
  await browser.close();
})();
"
pkill -f "astro preview"
```

Expected: "Editar"/"Guardar"/"Cancelar"/"Eliminar"/"Generar código" se ven
con el mismo lenguaje visual que el resto de la app (borde teal o rojo
según corresponda, fuente monospace, mismo alto entre sí) — no el botón
gris default del navegador. En 375px, los botones de "Acciones" tienen
espacio visible entre sí, sin tocarse, y wrappean en varias líneas de
forma prolija si no entran en una sola fila.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/global.css apps/web/src/lib/adminPage.ts
git commit -m "$(cat <<'EOF'
fix(web): aplicar sistema de botones existente a las acciones de /admin

Editar, Guardar, Cancelar, Revertir a automático, Aprobar y Rechazar
caían al estilo default del navegador por no tener ninguna clase CSS
— "Eliminar" era el único que ya usaba .btn-danger. Se agrega .btn-sm
(variante compacta de .btn-secondary/.btn-danger para celdas de tabla
densas) y .table-actions (wrapper flex con gap, evita que los botones
se toquen al wrappear en mobile).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Actualizar `docs/MANUAL_TESTING.md` con verificación mobile-first

**Files:**
- Modify: `docs/MANUAL_TESTING.md`

**Interfaces:** Ninguna — solo documentación.

- [ ] **Step 1: Agregar sección de pruebas mobile-first**

En `docs/MANUAL_TESTING.md`, agregar esta sección nueva al final del
archivo (después de la última sección existente, "7. Casos de error
generales"):

```markdown
## 8. Mobile-first (viewport angosto)

Requiere devtools del navegador con modo responsive/device toolbar
(Chrome/Firefox: F12 → ícono de celular), o un teléfono real.

1. Con devtools en modo responsive, fijar el ancho en 375px (iPhone SE)
   y recargar http://localhost:8081/.
2. **Esperado:** el texto se ve a tamaño legible sin necesidad de hacer
   zoom manual (confirma que la meta viewport está activa) — antes de
   este fix, `/login`, `/register`, `/reportar` y `/admin` se veían
   "zoomeados" a un ancho virtual de ~980px.
3. Sin login, verificar que los botones "Ingresar" y "Actualizar mapa"
   del nav sean completamente visibles y clickeables.
4. **Esperado:** ningún botón queda tapado por el mapa, sin importar si
   el nav ocupa una o dos filas.
5. Loguearse como admin y volver a http://localhost:8081/.
6. **Esperado:** con más botones en el nav (Reportar/Salir/Admin/Activar
   modo prueba/Actualizar mapa), el nav puede ocupar 2+ filas — todos
   siguen siendo visibles y clickeables, el mapa arranca debajo de la
   última fila del nav.
7. Ir a http://localhost:8081/admin en 375px.
8. **Esperado:** "Reportes pendientes", "Celdas activas", "Filtrar por
   plus code", "Códigos de invitación" y los textos de estado vacío
   tienen separación visible del borde izquierdo — no pegados al margen.
9. Con al menos una celda activa cargada, verificar que la tabla
   "Celdas activas" pueda hacer scroll horizontal *dentro de su propio
   recuadro* sin forzar scroll horizontal de toda la página.
10. Click **Editar** en una fila.
11. **Esperado:** el botón tiene el mismo estilo visual (borde teal,
    fuente monospace) que el resto de los botones de la app — no el
    gris default del navegador. "Guardar"/"Cancelar" tienen espacio
    entre sí, no se tocan.
12. Repetir los pasos 1-11 en `/login`, `/register` y `/reportar`.
13. **Esperado:** ninguna de las 3 páginas requiere zoom para leer el
    texto, y los formularios se ven con el mismo padding que siempre
    tuvieron (regresión = cero cambios en estas 3 páginas, ya estaban
    bien).
```

- [ ] **Step 2: Commit**

```bash
git add docs/MANUAL_TESTING.md
git commit -m "$(cat <<'EOF'
docs: agregar sección de pruebas mobile-first a MANUAL_TESTING.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
