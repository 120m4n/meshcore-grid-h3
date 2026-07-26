# Spec — estado visual "degraded" en el frontend del radar LOS 360°

## 1) Contexto

El backend (`apps/api`, ver
`docs/superpowers/specs/2026-07-24-fresnel-height-compensation-design.md`)
ya devuelve, por cada rayo de `/api/v1/simulations/radial`, un
`link_status` de tres valores (`clear`/`degraded`/`blocked`) y un
`fresnel_clear_pct`, además del `collided` legado (derivado como
`link_status != "clear"`, mantenido solo por compatibilidad). El
frontend (`apps/web/src/lib/map/radialSimulation.ts`) todavía solo lee
`collided` y pinta cada rayo rojo o verde — un rayo `degraded` hoy se
ve idéntico a uno `blocked`. Este spec cierra esa brecha.

## 2) Alcance

Incluye: `apps/web/src/lib/api.ts` (tipos), `apps/web/src/lib/map/
radialSimulation.ts` (color + popup), `apps/web/src/pages/index.astro`
(leyenda nueva). Excluye: cualquier control nuevo en el panel de
parámetros (`fresnel_compensation`/`compensation_factor` siguen sin
exponerse, mismo criterio ya aplicado a `earth_curvature`/
`refraction_k` — corren siempre con los defaults del backend). Excluye
también cualquier cambio al polígono de cobertura (queda uniforme,
ignora `link_status`) y cualquier uso de `fresnel_table` en esta ronda.

## 3) Contrato de datos (frontend)

`apps/web/src/lib/api.ts` — cambios aditivos, no rompen nada:

```ts
export interface RadialSimulationRay {
  angle_deg: number;
  end_lat: number;
  end_lon: number;
  distance_m: number;
  link_status: 'clear' | 'degraded' | 'blocked';
  fresnel_clear_pct: number;
  collided: boolean; // legado, ya no se lee en el frontend, se mantiene por si algo más lo usa
  collision_lat: number;
  collision_lon: number;
  collision_elev_m: number;
}

export interface RadialSimulationResponse {
  rays: RadialSimulationRay[];
  metadata: {
    dem_source: string;
    dem_resolution_m: number;
    compute_ms: number;
    fresnel_table: Array<{ distance_m: number; fresnel_radius_m: number; height_extra_m: number }>;
  };
}
```

## 4) `radialSimulation.ts`

- Nueva constante `COLOR_DEGRADED = '#e67e22'` (naranja), junto a las
  existentes `COLOR_COLLIDED = '#e74c3c'` (rojo) y
  `COLOR_CLEAR = '#2ecc71'` (verde) — deliberadamente distinto del
  amarillo `#f1c40f` que ya usa la leyenda de "Cobertura de señal" (otro
  panel, no relacionado), para que las dos leyendas en pantalla no se
  confundan entre sí.
- En `drawRays()`, la línea `color: ray.collided ? COLOR_COLLIDED :
  COLOR_CLEAR` se reemplaza por una función `colorForStatus(status)`
  que resuelve los 3 casos.
- El popup por rayo gana una tercera rama para `degraded`:
  `Señal degradada — {fresnel_clear_pct.toFixed(0)}% de zona de Fresnel
  libre (mín. 60%)`, manteniendo el formato existente de
  ángulo/longitud arriba. `blocked` conserva el texto actual
  ("Colisión con terreno"); `clear` conserva "Alcance máximo".
- `ray.collided` deja de leerse en este archivo (queda en el tipo, sin
  uso).

## 5) `index.astro`

Nueva leyenda estática, mismo patrón de markup
(`legend`/`legend-title`/`legend-row`/`legend-swatch`) que la leyenda
de "Cobertura de señal" ya existente, ubicada dentro de `radar-panel`
después de `radar-panel-actions`:

```html
<div class="legend">
  <div class="legend-title">Estado del enlace</div>
  <div class="legend-row"><span class="legend-swatch" style="background:#2ecc71"></span>Despejado</div>
  <div class="legend-row"><span class="legend-swatch" style="background:#e67e22"></span>Degradado (Fresnel)</div>
  <div class="legend-row"><span class="legend-swatch" style="background:#e74c3c"></span>Bloqueado</div>
</div>
```

## 6) Testing

`apps/web` no tiene test runner configurado (confirmado en CLAUDE.md).
Verificación manual: `npm run dev`, correr una simulación radial real
(el mismo origen/parámetros usados para la verificación end-to-end del
backend en esta sesión, contra el DEM real) y confirmar visualmente los
3 colores, el popup de un rayo degraded, y la leyenda nueva.

## 7) Criterios de aceptación

- Un rayo `degraded` se ve naranja `#e67e22`, distinto de rojo/verde.
- El popup de un rayo `degraded` muestra el `fresnel_clear_pct`.
- La leyenda nueva aparece en el panel del radar con los 3 colores.
- Ningún control nuevo se agrega al panel de parámetros.
- El polígono de cobertura no cambia de comportamiento.
- `npm run build` sigue compilando sin errores de tipos.
