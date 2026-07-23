# Buscador de coordenadas en el mapa — Design Spec

**Goal:** agregar un componente al mapa público que permita pegar/tipear un
par `lat,lon` (ej. `7.12,-73.13`) y navegar el mapa a ese punto, dejando un
marcador que se reemplaza en cada búsqueda nueva.

**Audiencia:** público — mismo criterio que el panel "Simulación LOS 360°"
(visualización/navegación de solo lectura, no requiere sesión ni rol
admin).

**Non-goals (fuera de alcance de esta feature):**
- No resuelve direcciones ni nombres de lugar, solo pares numéricos.
- No parsea Plus Codes ni URLs de Google Maps — únicamente el formato
  `lat,lon` (mismo criterio que el `LAT_LON_PASTE` ya usado en el form de
  reporte, `reportPage.ts:85`).
- El marcador no es interactivo (sin popup, sin click handler, sin drag).
- No persiste entre recargas de página (no hay `localStorage` involucrado
  — a diferencia de las celdas de prueba).

## Arquitectura

Módulo nuevo `apps/web/src/lib/map/coordSearch.ts`, mismo patrón que
`radialSimulation.ts`/`testCells.ts`: encapsula estado propio (el
marcador actual) y expone una única función de inicialización
`initCoordSearch()`, llamada una vez desde `mapPage.ts` — sin exportar
estado mutable hacia afuera (a diferencia de `radialSimulation.ts`, que sí
tuvo que exponer `isPickingOrigin`/`pickOriginAt` para que otros módulos
cedieran el paso; acá no hay ese conflicto porque este componente no
compite por el evento de click del mapa, solo por su propio input).

**Files:**
- Crear: `apps/web/src/lib/map/coordSearch.ts`
- Modificar: `apps/web/src/pages/index.astro` (markup del panel)
- Modificar: `apps/web/src/styles/global.css` (`.coord-panel` y afines)
- Modificar: `apps/web/src/lib/mapPage.ts` (import + llamada a `initCoordSearch()`)

## Sanitización (vive dentro del componente, no en el caller)

```ts
const LAT_LON_FORMAT = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
```

Mismo regex que `reportPage.ts:85` (`LAT_LON_PASTE`), por consistencia
con el único otro lugar del proyecto que ya parsea este formato.

Reglas, en orden:
1. `text.trim()` antes de matchear (tolera espacios al principio/final).
2. Si no matchea `LAT_LON_FORMAT` → inválido, toast de error, no navega.
3. Si matchea, `parseFloat` de cada grupo → `lat`, `lon`.
4. Si `lat`/`lon` caen fuera de `SANTANDER_BOUNDS` (`mapBounds.ts`:
   `[[5.65, -74.45], [8.35, -72.50]]`) → válido como número pero fuera de
   rango, toast distinto, no navega. Este chequeo ya cubre los rangos
   universales (-90..90 / -180..180) al ser un subconjunto estricto, así
   que no hace falta una validación separada de rango global.
5. Si pasa ambos chequeos → navega y coloca marcador.

## UI

Panel flotante nuevo `.coord-panel` en `index.astro`, mismo lenguaje
visual que `.legend`/`.radar-panel` (fondo `rgba(16, 29, 46, 0.92)`,
borde `var(--border-bright)`, `backdrop-filter: blur(4px)`,
`font-family: var(--font-display)`). Posición: arriba a la izquierda del
mapa, por debajo del control de zoom nativo de Leaflet (que vive
top-left por defecto) para no superponerse — análogo a por qué
`.radar-panel` usa `top: 7rem` del lado derecho (debajo del control de
capas).

```html
<div class="coord-panel" id="coord-panel">
  <div class="coord-panel-title">Ir a coordenadas</div>
  <div class="coord-panel-row">
    <input type="text" id="coord-input" placeholder="lat,lon (ej: 7.12,-73.13)" />
    <button class="btn-sm btn-secondary" id="btn-coord-go" type="button">Ir</button>
  </div>
</div>
```

CSS nuevo (`global.css`), reutilizando tokens ya existentes (mismo
patrón que `.radar-field input`, sin inventar nuevos valores de color):

```css
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

(El valor exacto de `top: 5rem` se confirma visualmente en la
verificación manual — el objetivo es "debajo del control de zoom", no un
píxel exacto.)

## Interacción / flujo de datos

Una única función interna `goToCoords(rawText: string)` en
`coordSearch.ts` implementa los pasos de sanitización de arriba y, si
son válidos, navega + coloca marcador. Tres disparadores, los tres
llaman a `goToCoords`:

1. **Paste** sobre `#coord-input`: si `e.clipboardData.getData('text').trim()`
   matchea `LAT_LON_FORMAT` completo, `e.preventDefault()`, se asigna el
   valor al input y se llama `goToCoords` de inmediato (sin esperar
   Enter) — es el caso pedido explícitamente ("al pegar... se centra").
   Si no matchea (texto parcial, con etiquetas, etc.), se deja el paste
   normal para que el usuario pueda editarlo a mano.
2. **Enter** (`keydown`, `key === 'Enter'`) sobre `#coord-input`: llama
   `goToCoords(input.value)`.
3. **Click** en `#btn-coord-go`: llama `goToCoords(input.value)`.

### Navegación y marcador

```ts
const TARGET_ZOOM = 16;
let searchMarker: L.CircleMarker | null = null;
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
  if (lat < SANTANDER_BOUNDS[0][0] || lat > SANTANDER_BOUNDS[1][0] ||
      lon < SANTANDER_BOUNDS[0][1] || lon > SANTANDER_BOUNDS[1][1]) {
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
```

El `token` incremental evita que una segunda búsqueda disparada mientras
la primera todavía está animando (`flyTo` interrumpido) termine
colocando el marcador de la búsqueda vieja — solo el callback de
`moveend` correspondiente al `token` más reciente dibuja.

## Error handling

- Formato inválido (no matchea `lat,lon`) → toast de error, sin tocar el
  mapa ni el marcador existente.
- Fuera de `SANTANDER_BOUNDS` → toast de error distinto, sin tocar el
  mapa ni el marcador existente (deliberado: consistente con que el mapa
  es de referencia regional, ver `CLAUDE.md` sección "Acotamiento
  geográfico").
- Búsqueda válida mientras hay un marcador previo → se borra el viejo y
  se coloca el nuevo (nunca coexisten dos).

## Testing / verificación

Sin test runner en `apps/web` — verificación manual:
1. `npm run build` sin errores de tipo.
2. En navegador: pegar `7.12,-73.13` en el input → el mapa vuela ahí,
   zoom 16, aparece el marcador naranja al terminar la animación.
3. Pegar una segunda coordenada distinta → el marcador viejo desaparece,
   aparece uno nuevo en el lugar correcto.
4. Tipear manualmente (sin pegar) y presionar Enter → mismo
   comportamiento.
5. Click en "Ir" con el input ya lleno → mismo comportamiento.
6. Pegar texto inválido (`"hola"`, `"7.12"`, `"7.12;-73.13"`) → toast de
   formato inválido, sin navegar ni tocar el marcador existente.
7. Pegar coordenadas válidas mas fuera de Santander (ej. `4.60,-74.08` —
   Bogotá) → toast de "fuera del área de Santander", sin navegar.
