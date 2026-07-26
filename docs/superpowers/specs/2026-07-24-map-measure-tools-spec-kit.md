# Spec kit — barra de herramientas de medición (ruler + arc) sobre el mapa

## 1) Contexto y estado actual del repo

- Frontend actual: Astro + Leaflet, sin build de componentes — cada
  página es JS vanilla con lógica de mapa repartida en módulos
  `apps/web/src/lib/map/*.ts` que consumen el singleton `map` exportado
  por `map/setup.ts`, más capas (`L.layerGroup`) dedicadas por feature
  (`cellLayer`, `testLayer`, `originsLayer`, `userLocationLayer`,
  `radialLayer`).
- No hay web components (`customElements`) en el repo hoy — este es el
  primer uso del patrón. `apps/web/src/styles/global.css` define tokens
  de color como custom properties en `:root` (`--accent`, `--surface`,
  `--border`, etc.), que sí atraviesan el límite de Shadow DOM y pueden
  reusarse sin duplicarlos.
- Precedente de modo de interacción exclusivo sobre el mapa: la
  simulación LOS 360° (`radialSimulation.ts`) expone
  `isPickingOrigin()`/`pickOriginAt()`, que los demás handlers de click
  (`testCells.ts:handleMapClick`, click sobre celdas) consultan primero
  para cederle el paso — no hay un árbitro central de "quién tiene el
  click", cada handler se autoexcluye consultando el flag del otro.
- Convención de rumbo/azimut ya establecida en el backend
  (`apps/api/internal/terrain/los/geodesy.go:Destination`): **0° = norte,
  sentido horario** — cualquier ángulo mostrado en el frontend debe usar
  la misma convención para no confundir al usuario que ya vio ese
  criterio en el panel LOS 360°.

Conclusión: la feature se implementa como módulo nuevo 100% frontend
(sin cambios de API/DB), sin romper `reports`, `cell_agg` ni los flujos
de moderación, LOS 360°, modo prueba o búsqueda por coordenadas
existentes.

## 2) Objetivo funcional

Agregar una barra de herramientas sobre el mapa con dos herramientas de
medición:

- **ruler**: el usuario marca dos puntos sobre el mapa y ve la distancia
  entre ellos en metros/kilómetros.
- **arc**: el usuario marca dos puntos sobre el mapa y ve el rumbo
  (ángulo respecto al norte, sentido horario) del segundo punto visto
  desde el primero.

Ambas herramientas y su contenedor (la barra) se implementan con el
patrón **web component** (custom elements + Shadow DOM).

## 3) Definiciones clave

- **Rumbo (bearing) inicial**: ángulo, medido en sentido horario desde
  el norte geográfico (0°), del rayo que va del punto A al punto B sobre
  una esfera — misma semántica que `azimuthDeg` en `Destination()`
  (backend), pero calculado en el cliente sin llamar al backend.
- **Modo de medición activo**: estado exclusivo (`ninguno | ruler | arc`)
  que determina qué hace el próximo click sobre el mapa. Solo una
  herramienta de medición puede estar activa a la vez, y es mutuamente
  excluyente con "Elegir origen en el mapa" (LOS 360°).
- **Medición**: un par de puntos (A, B) ya confirmados, con su línea y
  label dibujados. Cada herramienta conserva como máximo una medición
  visible propia (ver §4, se reemplaza en cada uso).

## 4) Alcance (MVP)

Incluye:

- Control Leaflet (`L.Control`, `position: 'topleft'`) con el custom
  element `<mc-map-toolbar>` como contenido.
- Dos botones de herramienta como custom element `<mc-tool-button
  tool="ruler">` / `<mc-tool-button tool="arc">`.
- Activación: un clic en el botón arma el modo; primer clic en el mapa
  fija el punto A; segundo clic fija el punto B, dibuja línea + label, y
  desactiva el modo automáticamente (vuelve a estado "ninguno").
- Cancelación de un punto A pendiente: `Esc`, o un nuevo clic sobre el
  botón de la herramienta ya activa (toggle on/off).
- Cada nueva medición de una herramienta reemplaza la anterior de esa
  misma herramienta; ruler y arc son independientes entre sí (medir con
  arc no borra una medición de ruler ya dibujada, y viceversa).
- Acceso público, sin sesión — mismo criterio que el panel LOS 360° y el
  buscador de coordenadas (`GET /cells` también es público).
- Exclusión mutua con `isPickingOrigin()` (LOS 360°): activar
  ruler/arc cancela una selección de origen en curso, y viceversa.

Excluye (MVP):

- Persistencia de mediciones (recargar la página las borra, igual que
  `radialLayer`/`testLayer` hoy).
- Mediciones múltiples simultáneas por herramienta (una sola medición
  visible por herramienta, ver arriba).
- Edición de un punto ya confirmado (mover A o B después de fijado) —
  para corregir, se rehace la medición completa.
- Snapping a celdas H3, reportes o marcadores existentes.
- Unidades imperiales (pies/millas) — solo métrico.
- Atajos de teclado más allá de `Esc`.

## 5) Contrato de componentes (web components)

### 5.1 `<mc-map-toolbar>`

- Contenedor Shadow DOM, sin atributos propios en el MVP.
- Slotea o instancia internamente los dos `<mc-tool-button>`.
- Se monta como contenido de un `L.Control` custom
  (`onAdd()` retorna el elemento raíz del custom element).

### 5.2 `<mc-tool-button>`

Atributos:

| Atributo | Tipo | Requerido | Notas |
|---|---|---:|---|
| `tool` | `"ruler" \| "arc"` | Sí | identifica la herramienta; fija ícono y label accesible |
| `active` | boolean (presencia) | No | reflejado por el componente, controla el estilo "presionado" |

Eventos:

| Evento | Tipo | Cuándo | Detail |
|---|---|---|---|
| `mc-tool-toggle` | `CustomEvent`, `bubbles: true, composed: true` | clic en el botón | `{ tool: 'ruler' \| 'arc' }` |

`mapPage.ts` escucha `mc-tool-toggle` en `document` (o en el elemento
`<mc-map-toolbar>`) y decide activar/desactivar llamando a las
funciones exportadas de `measureTools.ts` — el propio componente no
sabe nada de Leaflet.

### 5.3 `measureTools.ts` (no es web component, es el módulo de lógica)

```ts
export function activateRuler(): void;
export function activateArc(): void;
export function deactivateMeasureTool(): void; // no-op si ya está en "ninguno"
export function isMeasuring(): boolean; // true si ruler o arc están armados
```

Responsabilidades:

- Un único `map.on('click', ...)` que despacha según el modo activo.
- Guarda el punto A pendiente en memoria (variable de módulo, igual
  patrón que `pickingOrigin`/`onOriginPicked` en `radialSimulation.ts`).
- Al confirmar el punto B: calcula distancia (ruler) o rumbo (arc),
  dibuja línea + label en `rulerLayer`/`arcLayer`, y vuelve a "ninguno".
- Expone la desactivación por `Esc` (listener `keydown` a nivel
  `document`, solo actúa si `isMeasuring()`).
- Debe consultar/ceder ante `isPickingOrigin()` (import desde
  `radialSimulation.ts`) igual que hoy lo hacen `testCells.ts` y los
  handlers de click de celdas; simétricamente, activar ruler/arc debe
  cancelar un `isPickingOrigin()` en curso.

## 6) Matriz de parámetros y fórmulas

| Herramienta | Fórmula | Fuente | Salida / formato label |
|---|---|---|---|
| ruler | `map.distance(A, B)` (haversine, Leaflet built-in) | cliente, sin red | `< 1000 m`: metros enteros; `>= 1000 m`: km con 2 decimales — mismo criterio que `formatDistance()` en `radialSimulation.ts:108` |
| arc | rumbo inicial: `θ = atan2(sin Δλ·cos φ2, cos φ1·sin φ2 − sin φ1·cos φ2·cos Δλ)`, normalizado a `[0, 360)` | cliente, sin red | grados enteros, `°`, 0 = norte, sentido horario — misma convención que `Destination()` (backend) |

Ninguna de las dos fórmulas requiere llamar al backend ni al DEM — son
cálculo geométrico puro sobre las coordenadas de los dos clics.

## 7) Diseño técnico propuesto

### 7.1 Nuevos archivos

- `apps/web/src/lib/map/webcomponents/mc-map-toolbar.ts` — define
  `customElements.define('mc-map-toolbar', ...)`.
- `apps/web/src/lib/map/webcomponents/mc-tool-button.ts` — define
  `customElements.define('mc-tool-button', ...)`.
- `apps/web/src/lib/map/measureTools.ts` — lógica de Leaflet (clicks,
  dibujo, fórmulas), análogo a `radialSimulation.ts`/`coordSearch.ts`.

### 7.2 Cambios en archivos existentes

- `map/setup.ts`: agrega `rulerLayer` y `arcLayer` (`L.layerGroup().addTo(map)`),
  y el `L.Control` que monta `<mc-map-toolbar>` en `position: 'topleft'`.
- `mapPage.ts`: importa los custom elements (efecto de registro), y el
  listener de `mc-tool-toggle` que llama a `activateRuler`/`activateArc`/
  `deactivateMeasureTool`.
- `testCells.ts` (`handleMapClick`) y los `polygon.on('click', ...)` de
  celdas reales/de prueba: agregan un chequeo temprano de
  `isMeasuring()` (import desde `measureTools.ts`), mismo patrón que ya
  usan con `isPickingOrigin()`.
- `radialSimulation.ts` (`enableOriginPicking`): al activarse, llama
  `deactivateMeasureTool()` para garantizar exclusión mutua en el
  sentido opuesto.

### 7.3 Estilo

- Shadow DOM por componente, con un `<style>` interno que consume
  `var(--accent)`, `var(--surface)`, `var(--border)`, etc. definidos en
  `:root` (`global.css`) — no se duplican valores de color.
- Estado `active` de `<mc-tool-button>` se refleja visualmente con el
  mismo tono de acento (`--accent`) que ya usan otros controles activos
  del mapa (marcador de origen LOS 360°, botón "Detener").

## 8) Riesgos y decisiones abiertas

1. **Iconografía de los botones**: pendiente definir el set de íconos
   (emoji vs SVG inline) — no bloquea el contrato de componentes, se
   resuelve en implementación.
2. **Posición del label del rumbo cuando la línea es muy corta**: con A y
   B casi superpuestos, el label puede quedar ilegible por falta de
   espacio — se decide en implementación (offset fijo vs `L.Tooltip`
   `direction: 'auto'`).
3. **Doble tap en mobile**: el flujo "clic A, clic B" asume mouse; en
   touch, dos taps rápidos deberían funcionar igual con los eventos de
   Leaflet (`click` normaliza tap), pero no hay dispositivo táctil real
   incluido en el plan de verificación de este spec kit — queda como
   riesgo a validar manualmente antes de mergear.
4. **Nombre final del topleft control vs otros controles futuros**: si
   más adelante se agregan más herramientas, `<mc-map-toolbar>` debería
   escalar sin rediseño — el contrato de §5 ya lo permite (agregar más
   `<mc-tool-button>` hijos), pero no se pre-construye esa extensibilidad
   más allá de lo que el MVP necesita.

## 9) Criterios de aceptación (spec kit)

- Contrato de componentes (atributos/eventos de `<mc-map-toolbar>` y
  `<mc-tool-button>`) cerrado y sin ambigüedad.
- Fórmulas de distancia y rumbo definidas, y el rumbo usa la misma
  convención (0° = norte, horario) que `Destination()` en el backend.
- Flujo de activación/cancelación (clic botón → clic A → clic B → label;
  `Esc`/re-clic cancela) sin casos sin definir.
- Exclusión mutua con LOS 360° (`isPickingOrigin()`) definida en ambos
  sentidos.
- La propuesta no requiere cambios de API/DB y no afecta datos
  persistidos actuales (`reports`, `cell_agg`).

## 10) Plan de verificación para implementación futura

- Prueba manual: activar ruler, medir dos puntos conocidos del mapa,
  verificar que la distancia mostrada sea razonable (comparar contra
  una medición externa aproximada).
- Prueba manual: activar arc entre dos puntos alineados norte-sur/este-
  oeste, verificar que el rumbo sea 0°/180°/90°/270° según corresponda.
- Prueba manual: cancelar con `Esc` a mitad de medición, confirmar que
  no queda un punto A "fantasma" en la siguiente activación.
- Prueba manual: activar ruler mientras "Elegir origen" (LOS 360°) está
  armado, confirmar que se cancela la selección de origen y el próximo
  clic pasa a ser el punto A del ruler (y viceversa).
- Prueba manual: con modo prueba activo (admin o usuario), confirmar que
  un clic con ruler/arc activo NO crea/borra una celda de prueba.
- Prueba visual: estilos de `<mc-tool-button>` en tema oscuro (único
  tema del sitio) coherentes con el resto de botones (`.btn-sm`,
  `.btn-secondary`).
