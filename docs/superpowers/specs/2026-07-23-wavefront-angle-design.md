# Frente de onda (ángulo inicial/final) en la simulación LOS 360° — Design Spec

**Goal:** agregar al simulador LOS radial un parámetro "frente de onda"
compuesto de ángulo inicial y ángulo final (defaults `0`/`360`), que
acota el barrido de rayos a ese arco en vez de siempre simular el
círculo completo. Validar siempre `end_angle_deg > start_angle_deg`.

**Referencia angular:** sin cambios respecto al criterio ya documentado
en `geodesy.go: Destination` — `0° = Norte, sentido horario`. El frente
de onda es un sub-rango de ese mismo barrido (confirmado con el
usuario); no hace falta ninguna conversión de convención.

**Non-goals:**
- No soporta arcos que "envuelven" el norte (ej. `start=350, end=10`)
  — la regla `end > start` los excluye por diseño, tal como se pidió.
- No cambia el significado de `angle_step_deg` ni ningún otro parámetro
  existente.
- (Actualizado a pedido del usuario) El frontend SÍ valida antes de
  llamar al backend — ver sección "Validación en el frontend" más abajo.
  El backend (`validate.go`) se mantiene como defensa en profundidad
  (cualquier otro cliente de la API, o una request manual, sigue
  protegido), pero el flujo normal desde `/` nunca dispara una request
  con un frente de onda inválido.

## Backend (`apps/api`)

### `internal/models/models.go` — `RadialSimulationRequest`

Agregar dos campos opcionales, mismo patrón puntero que el resto (para
distinguir "no vino en el JSON" de "vino en 0"):

```go
type RadialSimulationRequest struct {
	OriginLat      *float64 `json:"origin_lat"`
	OriginLon      *float64 `json:"origin_lon"`
	OriginHeightM  *float64 `json:"origin_height_m"`
	AngleStepDeg   *float64 `json:"angle_step_deg"`
	MaxDistanceM   *float64 `json:"max_distance_m"`
	SampleStepM    *float64 `json:"sample_step_m"`
	EarthCurvature *bool    `json:"earth_curvature"`
	RefractionK    *float64 `json:"refraction_k"`
	StartAngleDeg  *float64 `json:"start_angle_deg"`
	EndAngleDeg    *float64 `json:"end_angle_deg"`
}
```

### `internal/terrain/los/simulator.go` — `SimulationInput`

```go
type SimulationInput struct {
	OriginLat      float64
	OriginLon      float64
	OriginHeightM  float64
	AngleStepDeg   float64
	MaxDistanceM   float64
	SampleStepM    float64
	EarthCurvature bool
	RefractionK    float64
	StartAngleDeg  float64
	EndAngleDeg    float64
}
```

`Simulator.Run` genera el barrido en el arco `[StartAngleDeg,
EndAngleDeg)` en vez de `[0, 360)`:

```go
rayCount := int(math.Ceil((in.EndAngleDeg - in.StartAngleDeg) / in.AngleStepDeg))
...
angle := in.StartAngleDeg + float64(i)*in.AngleStepDeg
```

Con los defaults `0`/`360`, esto genera exactamente el mismo barrido
que hoy — comportamiento retrocompatible cuando no se manda el campo
nuevo.

### `internal/terrain/los/validate.go` — `ValidateRequest`

```go
startAngle := 0.0
if req.StartAngleDeg != nil {
	startAngle = *req.StartAngleDeg
}
endAngle := 360.0
if req.EndAngleDeg != nil {
	endAngle = *req.EndAngleDeg
}
if startAngle < 0 || startAngle > 360 {
	return SimulationInput{}, fmt.Errorf("start_angle_deg debe estar en [0, 360]")
}
if endAngle < 0 || endAngle > 360 {
	return SimulationInput{}, fmt.Errorf("end_angle_deg debe estar en [0, 360]")
}
if endAngle <= startAngle {
	return SimulationInput{}, fmt.Errorf("end_angle_deg debe ser mayor que start_angle_deg")
}
```

El cálculo de `rayCount`/tope `MaxTotalSamples` (más abajo en la misma
función) cambia de `360 / angleStep` a `(endAngle - startAngle) /
angleStep`, y `SimulationInput{...}` incluye `StartAngleDeg: startAngle,
EndAngleDeg: endAngle`.

`internal/handlers/simulation_handler.go` no cambia — ya pasa `in`
completo a `ValidateRequest` y `simInput` completo a `sim.Run`, ambos
por valor/struct, sin mapeo campo por campo de la request.

## Frontend (`apps/web`)

### `src/lib/api.ts`

```ts
export interface RadialSimulationRequest {
  origin_lat: number;
  origin_lon: number;
  origin_height_m: number;
  angle_step_deg: number;
  max_distance_m: number;
  sample_step_m: number;
  earth_curvature: boolean;
  refraction_k?: number;
  start_angle_deg: number;
  end_angle_deg: number;
}
```

### `src/pages/index.astro`

Dos inputs nuevos dentro de `#radar-panel`, después del campo "Paso
angular (°)":

```astro
<div class="radar-field">
  <label>Frente de onda (°)</label>
  <div class="radar-field-row">
    <input type="number" id="radar-start-angle" value="0" min="0" max="360" step="1" />
    <input type="number" id="radar-end-angle" value="360" min="0" max="360" step="1" />
  </div>
</div>
```

`.radar-field-row` nuevo en `global.css` (mismo criterio que
`.coord-panel-row`, ya existente): `display: flex; gap: 0.4rem;` con
`input { flex: 1; min-width: 0; }` para que los dos quepan lado a lado
en el ancho fijo de 220px del panel.

### `src/lib/mapPage.ts`

Lee `#radar-start-angle`/`#radar-end-angle` junto con los demás campos
numéricos ya leídos en el handler de `btnRunRadial`, y los agrega al
objeto pasado a `runRadialSimulation`.

### `src/lib/map/radialSimulation.ts`

- `estimateTotalPoints` gana dos parámetros (`startAngleDeg`,
  `endAngleDeg`) y calcula `rayCount = Math.ceil((endAngleDeg -
  startAngleDeg) / angleStepDeg)` en vez de `360 / angleStepDeg`, para
  que la barra de progreso estimada siga siendo precisa con un arco
  parcial.
- `drawRays` recibe también `startAngleDeg`/`endAngleDeg` como
  parámetros explícitos (vienen del mismo `input: RadialSimulationRequest`
  que `runRadialSimulation` ya tiene disponible en el call site — no se
  derivan de `result.rays`, para no depender de que el primer/último
  rayo devuelto coincida exactamente con los extremos pedidos). Si el
  arco no es el círculo completo (`!(start === 0 && end === 360)`),
  antepone el punto de origen a `boundaryPoints` antes de armar el
  polígono. Así el polígono de cobertura sale como un sector (dos lados
  rectos desde el origen + el arco) en vez de una "lente" que corta en
  línea recta entre los dos extremos del arco. Con el círculo completo
  (default), el comportamiento no cambia — sigue aproximando un anillo
  sin pasar por el origen.

## Validación en el frontend (antes de llamar al backend)

A pedido explícito del usuario: las validaciones se hacen en el
frontend de forma previa, para no llegar a disparar una request al
backend con un frente de onda inválido (evita saturarlo con requests
que se van a rechazar igual).

En `mapPage.ts`, dentro del handler de `btnRunRadial` (que ya lee
`heightM`/`angleStepDeg`/`maxDistanceM`/`sampleStepM` de sus inputs
correspondientes antes de armar el request), se agregan las lecturas de
`startAngleDeg`/`endAngleDeg` y un chequeo que corta *antes* de armar
`totalPoints`/llamar `runRadialSimulation`:

```ts
const startAngleDeg = Number((document.getElementById('radar-start-angle') as HTMLInputElement).value);
const endAngleDeg = Number((document.getElementById('radar-end-angle') as HTMLInputElement).value);

if (
  Number.isNaN(startAngleDeg) || Number.isNaN(endAngleDeg) ||
  startAngleDeg < 0 || startAngleDeg > 360 ||
  endAngleDeg < 0 || endAngleDeg > 360 ||
  endAngleDeg <= startAngleDeg
) {
  showToast('Frente de onda inválido: el ángulo final debe ser mayor que el inicial, ambos entre 0 y 360', 'error');
  return;
}
```

Si pasa, sigue el flujo actual sin cambios (calcular `totalPoints` con
los dos ángulos nuevos, mostrar la barra de progreso, llamar
`runRadialSimulation` con el payload completo). El backend
(`validate.go`) sigue teniendo la misma regla como defensa en
profundidad, pero en el uso normal desde `/` nunca la ve fallar.

## Testing

- **Backend:** extender `validate_test.go` (defaults `0`/`360` cuando
  se omiten, `end <= start` rechazado, fuera de `[0,360]` rechazado) y
  `simulator_test.go` (arco parcial genera el subconjunto correcto de
  rayos — ej. `start=0, end=90, step=30` → ángulos `0, 30, 60`
  únicamente), siguiendo el estilo table-driven ya usado en ambos
  archivos. `go build ./... && go vet ./...` como mínimo.
- **Frontend:** sin test runner — verificación manual en navegador:
  correr una simulación con arco parcial (ej. `0`-`90`) y confirmar que
  solo se dibujan rayos en ese rango y que el polígono sale como sector
  (no como lente); confirmar que dejar los defaults `0`/`360` reproduce
  el comportamiento actual sin cambios visibles.
