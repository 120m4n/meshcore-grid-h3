# Tracking GPS en vivo + toggle de modo prueba

## Contexto

Hoy la geolocalización se consulta con `getCurrentPosition` de una sola
vez, en tres puntos distintos:

- `apps/web/src/lib/map/geolocation.ts` (`getCurrentGeoPosition`,
  compartida por el mapa).
- `apps/web/src/lib/mapPage.ts`: al activar "modo prueba" (usuario
  no-admin), una lectura única centra el mapa y dibuja el punto.
- `apps/web/src/lib/map/testCells.ts`: cada click sobre el mapa en modo
  prueba (no-admin) vuelve a pedir una lectura fresca, para probar "estoy
  parado acá ahora mismo" antes de aceptar la celda.
- `apps/web/src/lib/reportPage.ts`: el botón "Usar mi ubicación"
  (`btn-geo`) en `/reportar` llena los campos lat/lon una sola vez.

El pedido: una vez activada la geolocalización, debe consultarse de
forma frecuente y representarse en el mapa (no una foto fija), evitando
que el punto "tiemble" por ruido normal del GPS (drift). Además, el
botón "Activar modo prueba" debe pasar de una activación de un solo
sentido (se oculta tras usarse) a un toggle.

## Decisiones tomadas en brainstorming

- **Alcance:** se aplica tanto al mapa (modo prueba, no-admin) como a
  `/reportar` (botón "Usar mi ubicación").
- **Mecanismo de consulta frecuente:** `navigator.geolocation.watchPosition`
  nativo, no polling con `setInterval` + `getCurrentPosition` — el
  navegador empuja lecturas nuevas solo, es más eficiente en batería y
  es el patrón estándar para "ubicación en vivo" en mapas.
- **Anti-drift:** filtro por precisión + distancia mínima. Se descarta
  una lectura si:
  - `coords.accuracy` es peor que un umbral (`MAX_ACCURACY_M`, 50m); o
  - la distancia movida respecto a la última posición aceptada es menor
    que la precisión reportada de la nueva lectura (el "salto" cabe
    dentro del círculo de incertidumbre anterior → es ruido, no
    movimiento real).
  No se usa promedio móvil/EMA: agregaría lag real cuando el usuario sí
  se mueve y no resuelve el caso de lecturas de baja precisión (las
  seguiría promediando).
- **Validación al click en `testCells.ts` y `realCells.ts`:** se usa la
  última posición aceptada del watch en curso (`getLastKnownPosition()`),
  no se fuerza una lectura puntual adicional por click. El watch ya
  empuja lecturas frescas y filtradas constantemente, así que sirve como
  prueba de presencia sin el costo de una nueva consulta GPS por cada
  click. Esto aplica en dos lugares con el mismo patrón: el click sobre
  el mapa vacío para crear una celda de prueba (`testCells.ts`) y el
  click sobre una celda real ya reportada para encadenar otro reporte
  desde otra ubicación física dentro del mismo hexágono
  (`realCells.ts`, dentro de `loadCells`) — ambos hoy llaman
  `getCurrentGeoPosition()` puntualmente y pasan a leer
  `getLastKnownPosition()`.
- **Toggle de "modo prueba" (no-admin):**
  - El botón permanece **siempre visible** (no se oculta tras el primer
    uso) y cambia de texto según el estado: "Activar modo prueba" ↔
    "Desactivar modo prueba".
  - El **primer** clic en "Activar": pide el fix GPS inicial; si se
    obtiene, arranca el watch (con el filtro anti-drift) y lo deja
    corriendo **indefinidamente** (no se detiene al desactivar),
    centra el mapa, dibuja el punto de ubicación, habilita la
    interacción de click sobre el mapa.
  - Los clics **siguientes** del botón solo alternan si el click sobre
    el mapa crea/copia una celda de prueba — **no tocan** el watch de
    GPS ni el punto dibujado, que quedan activos de forma permanente
    una vez arrancados.
  - Al desactivar, las celdas de prueba ya creadas **no se borran** —
    siguen visibles; solo se apaga la interacción de click (crear celda
    + copiar mensaje al portapapeles).
  - Admin no cambia: sigue sin este botón, modo prueba siempre activo,
    sin GPS.
  - Requiere separar "registrar el listener `map.on('click', ...)`" (una
    sola vez, al cargar la página) de "activar/desactivar la
    interacción" (flag `isTestModeEnabled()` chequeada adentro del
    handler) — hoy `enableTestMode()` hace ambas cosas juntas y
    llamarla dos veces duplicaría el listener.
- **`/reportar` sí detiene el watch** (a diferencia del mapa) cuando:
  - el radio cambia a "Plus Code" o "Clic en el mapa";
  - el reporte se envía con éxito (mismo punto donde ya se llama
    `syncFieldVisibility()` tras el reset);
  - el usuario edita a mano los campos lat/lon (para no pisar su
    corrección con el próximo fix del watch).
  No hay mapa persistente en el modo "Coordenadas GPS" de `/reportar`,
  así que "representarse" ahí es la actualización en vivo de los propios
  campos lat/lon, no un dibujo — el botón indica visualmente que está en
  modo "en vivo" (ej. cambia su texto a "Ubicación en vivo…") mientras el
  watch está activo.

## Arquitectura

**Nuevo módulo** `apps/web/src/lib/geoWatch.ts` (sin dependencia de
Leaflet, usable tanto por el mapa como por `/reportar`):

- `haversineMeters(a, b)`: helper puro, distancia en metros entre dos
  coordenadas.
- `watchFilteredPosition(onUpdate, onError): () => void`:
  - envuelve `navigator.geolocation.watchPosition` con
    `enableHighAccuracy: true`;
  - aplica el filtro de precisión + distancia mínima descrito arriba
    antes de invocar `onUpdate`;
  - guarda la última posición aceptada en closure, expuesta vía
    `getLastKnownPosition(): GeolocationPosition | null` (export del
    mismo módulo, no por instancia — solo hay un watch activo a la vez
    en cada página);
  - devuelve una función `stop()` que llama a
    `navigator.geolocation.clearWatch(id)`.
  - errores: `PERMISSION_DENIED` se propaga a `onError` y detiene el
    watch (`clearWatch` interno); `POSITION_UNAVAILABLE`/`TIMEOUT` se
    propagan a `onError` pero el watch sigue vivo (son transitorios).

**`apps/web/src/lib/map/geolocation.ts`:**

- Se agrega `startLiveUserLocation(): () => void`, que llama a
  `watchFilteredPosition` de `geoWatch.ts` y en cada actualización
  aceptada vuelve a llamar `renderUserLocation(pos)` (ya existente,
  redibuja el punto). Devuelve el `stop()` del watch subyacente (aunque
  en el flujo del mapa nunca se invoca, según la decisión de dejarlo
  corriendo indefinidamente — se expone por higiene/testeo, no por uso
  actual).
- Se re-exporta `getLastKnownPosition` de `geoWatch.ts` para que
  `testCells.ts` y `realCells.ts` lo usen en sus click handlers.
- `getCurrentGeoPosition` (el `getCurrentPosition` puntual actual) se
  mantiene sin cambios — sigue siendo el mecanismo del primer fix antes
  de arrancar el watch.

**`apps/web/src/lib/map/state.ts`:** sin cambios de forma (ya expone
`isTestModeEnabled`/`setTestModeEnabled`); se sigue usando igual, ahora
consultada además desde el listener único de click.

**`apps/web/src/lib/map/testCells.ts`:**

- El registro `map.on('click', ...)` se mueve a una función que se
  invoca **una sola vez** desde `mapPage.ts` al cargar la página (para
  todos los usuarios). El handler arranca chequeando
  `isTestModeEnabled()`; si es `false`, retorna sin hacer nada.
- Dentro del handler, la rama no-admin deja de hacer
  `await getCurrentGeoPosition()`; en su lugar lee
  `getLastKnownPosition()` (síncrono). Si todavía no hay ninguna
  posición aceptada (el watch no dio su primer fix), muestra el mismo
  toast de error que hoy usa para el caso de fallo de GPS.
- `enableTestMode(isAdmin)` cambia de propósito: pasa a ser el registro
  inicial que corre **una vez, siempre, para cualquier usuario**
  (listener de click + `renderAllTestCells()` + botón "Limpiar pruebas"
  solo si `isAdmin`). Para admin, esta misma función deja
  `setTestModeEnabled(true)` de una vez (sin GPS, como hoy). Para
  no-admin, arranca con `isTestModeEnabled()` en `false`.
- Se agrega una función nueva `toggleTestMode()`, que es lo que
  efectivamente prende/apaga `isTestModeEnabled()` para no-admin — solo
  la primera vez que se activa, dispara además el fix inicial + arranca
  el watch. Admin nunca llama a `toggleTestMode()` (no tiene botón).

**`apps/web/src/lib/map/realCells.ts`:** el click handler sobre una
celda real ya reportada (dentro de `loadCells`, la rama que encadena un
reporte adicional cuando el modo prueba está activo) tiene el mismo
patrón que `testCells.ts`: deja de hacer `await getCurrentGeoPosition()`
y en su lugar lee `getLastKnownPosition()` (síncrono); si no hay ninguna
posición aceptada todavía, mantiene el comportamiento silencioso actual
(`return` sin toast — es solo navegación del mapa, no un intento
explícito de reportar).

**`apps/web/src/pages/index.astro`:** sin cambios — el botón
`btn-enable-test` ya arranca `hidden` en el markup y ya es
`mapPage.ts` quien hace `btnEnableTest.hidden = false` únicamente en la
rama no-admin (admin nunca lo muestra). Ese comportamiento se mantiene
igual; lo único nuevo es que, una vez visible, el texto se actualiza
desde JS en cada toggle en vez de ocultarse tras el primer uso.

**`apps/web/src/lib/mapPage.ts`:**

- Reemplaza el `addEventListener('click', async () => {...})` de un solo
  uso sobre `btn-enable-test` por un handler que llama a
  `toggleTestMode()` (de `testCells.ts`) en cada click, y actualiza el
  texto del botón según el estado devuelto/consultado
  (`isTestModeEnabled()`).
- El registro único del listener del mapa (antes disperso dentro del
  flujo de activación) pasa a ejecutarse siempre al cargar la página,
  tanto para admin como no-admin.

**`apps/web/src/lib/reportPage.ts`:**

- `btn-geo` arranca `watchFilteredPosition` de `geoWatch.ts`
  directamente (sin pasar por `map/geolocation.ts`, no hay Leaflet acá).
  Cada actualización aceptada escribe `latInput.value`/`lonInput.value`.
- Se guarda el `stop()` devuelto en una variable de módulo
  (`let stopGeoWatch: (() => void) | null = null`).
- Se llama `stopGeoWatch?.()` (y se limpia la variable) en tres puntos:
  - dentro de `syncFieldVisibility()` cuando el método deja de ser
    `coords`;
  - después del `reset()` tras un envío exitoso (mismo bloque donde ya
    se llama `syncFieldVisibility()`);
  - en un listener `input` nuevo sobre `latInput`/`lonInput` que detecta
    edición manual (se ignora el primer `input` disparado
    programáticamente por el propio watch — se distingue con un flag
    simple tipo `isProgrammaticUpdate`, seteado a `true` justo antes de
    escribir `value` y a `false` en el siguiente tick).
- Mientras el watch está activo, el botón cambia su texto a "Ubicación
  en vivo…" (o similar) y vuelve a "Usar mi ubicación" al detenerse.

## Fuera de alcance (explícitamente descartado)

- Botón separado "Detener ubicación en vivo" — se descartó a favor de
  que el corte sea automático según contexto (ver decisiones arriba).
- Promedio móvil/EMA sobre las coordenadas — se descartó a favor del
  filtro de precisión + distancia mínima.
- Forzar una lectura puntual adicional en cada click de `testCells.ts`
  además del watch — se descartó, se usa la última posición del watch.
- Cambios al flujo de admin (sigue sin botón, sin GPS, siempre activo).
- Persistencia entre reloads de página del estado del toggle o del
  watch — cada carga de página (`.astro`) arranca de cero, no hay
  router client-side que lo requiera.

## Verificación

Sin suite de tests frontend (`package.json` no tiene tests
configurados) — verificación manual con el panel "Sensors" de Chrome
DevTools (permite simular coordenadas y desplazamiento):

1. `npm run build` limpio en `apps/web` tras los cambios.
2. Mapa, no-admin: click en "Activar modo prueba" → confirmar que pide
   permiso, dibuja el punto, y el botón cambia a "Desactivar modo
   prueba". Simular un desplazamiento pequeño (menor a la precisión
   reportada) → el punto no debe moverse. Simular un desplazamiento
   real → el punto se actualiza.
3. Alternar el botón varias veces → confirmar que el click sobre el
   mapa se habilita/deshabilita en consecuencia, pero el punto GPS
   sigue actualizándose todo el tiempo, incluso con el botón en
   "Activar modo prueba" (desactivado).
4. `/reportar`, método "Coordenadas GPS" → click en "Usar mi
   ubicación" → confirmar que lat/lon se actualizan solos al simular
   movimiento. Cambiar a "Plus Code" → confirmar que el watch se corta
   (dejar de simular movimiento y verificar que ya no llega ningún
   update a los campos, que quedan ocultos pero sin seguir cambiando en
   el DOM). Editar a mano lat/lon tras activar el GPS → confirmar que
   el valor manual no se pisa con la siguiente lectura del watch.
5. Simular `PERMISSION_DENIED` desde DevTools en ambos flujos →
   confirmar el toast de error y que no quede ningún watch colgado
   (sin logs de actualización después del error).
