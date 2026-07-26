# Spec — compensación de altura por zona de Fresnel en la simulación radial LOS

## 1) Contexto

`apps/api/internal/terrain/los` (spec kit previo:
`2026-07-22-radial-los-spec-kit.md`) simula un barrido radial 360° de
line-of-sight geométrico puro: cada rayo compara la elevación del
terreno (ajustada por curvatura terrestre, opcional) contra una línea
recta horizontal desde la altura de origen, y reporta `Collided`
true/false. Ese spec kit excluyó explícitamente el modelo Fresnel del
MVP ("Modelo RF avanzado... Fresnel"). Este documento cubre esa
extensión: para un enlace 915 MHz (monopolo Meshtastic/MeshCore), un
obstáculo puede no cruzar la línea recta y aun así degradar la señal si
invade más del 40% de la primera zona de Fresnel — la regla de
ingeniería RF estándar exige ≥60% de esa zona despejada.

## 2) Alcance

Incluye: paquete `los` (Go) — nuevo archivo `fresnel.go`, cambios en
`ray.go`, `validate.go`, `simulator.go` — y el contrato de
`models.RadialSimulationRequest`/`Response` + `simulation_handler.go`.

Excluye (por decisión explícita en esta ronda): actualización del
frontend (`apps/web/src/lib/map/radialSimulation.ts` sigue leyendo
`collided` sin cambios; una tarea separada agregará el tercer color
para "degraded"). El contrato de respuesta se diseña para que ese
frontend actual siga funcionando sin tocarlo (ver sección 4).

## 3) Frecuencia: constante, no parámetro

915 MHz queda fijo como constante interna del paquete
(`defaultFrequencyMHz = 915.0` en `fresnel.go`) — es la banda de
MeshCore/Meshtastic en Colombia, no hace falta parametrizarla en la API
por ahora.

## 4) Contrato de datos

### 4.1 Request — nuevos campos opcionales en `RadialSimulationRequest`

```go
FresnelCompensation *bool    `json:"fresnel_compensation"` // default true
CompensationFactor  *float64 `json:"compensation_factor"`  // default 0.6, rango [0.5, 0.7]
```

`fresnel_compensation=false` desactiva toda la lógica de esta feature:
el rayo vuelve exactamente al comportamiento LOS puro binario de antes
(sin estado "degraded" posible), igual patrón que el flag existente
`earth_curvature`.

### 4.2 Response — nuevos campos en `RadialSimulationRay`

```go
LinkStatus      string  `json:"link_status"`       // "clear" | "degraded" | "blocked"
FresnelClearPct float64 `json:"fresnel_clear_pct"` // % del radio de Fresnel completo despejado en el punto crítico del rayo
Collided        bool    `json:"collided"`          // derivado: link_status != "clear"
```

`collided` se sigue calculando en el handler (no en `los.Ray`) para que
el frontend actual, sin tocar, siga pintando rojo/verde — ahora un
rayo `degraded` también sale rojo ahí, hasta que se implemente el
tercer color en una tarea aparte.

### 4.3 Metadata — nuevo campo en `RadialSimulationMetadata`

```go
FresnelTable []FresnelTablePoint `json:"fresnel_table"`
// { distance_m, fresnel_radius_m, height_extra_m }
```

Tabla de referencia calculada una sola vez por respuesta (no por
rayo), en 21 puntos equiespaciados de `0` a `max_distance_m` (20
intervalos), usando `compensation_factor` efectivo de la request. Se
calcula siempre que la simulación corre, independientemente de
`fresnel_compensation` — es información de referencia para el usuario,
no depende de si se aplicó a la evaluación de rayos.

## 5) Algoritmo

### 5.1 `fresnel.go` (funciones puras, sin estado)

```go
const defaultFrequencyMHz = 915.0
const defaultCompensationFactor = 0.6
const fresnelClearanceThresholdPct = 60.0
const speedOfLightMPerS = 299792458.0

// FresnelRadiusM: radio de la primera zona de Fresnel en el punto medio
// de un enlace hipotético de longitud distanceM, a frequencyMHz.
// r = sqrt(λ·D/4), con λ = c/f.
func FresnelRadiusM(distanceM, frequencyMHz float64) float64

// HeightCompensationM: h_extra = factor · FresnelRadiusM(distanceM, frequencyMHz)
func HeightCompensationM(distanceM, frequencyMHz, factor float64) float64
```

Ambas están definidas para `distanceM <= 0 → 0` (sin división por
cero); en la práctica nunca se llaman con `distanceM == 0` porque la
primera muestra de cada rayo está a `sample_step_m` del origen
(mínimo 5m por validación existente).

### 5.2 `EvaluateRay` — integración

Cada rayo se sigue evaluando en orden creciente de distancia. En cada
muestra, tras aplicar el ajuste de curvatura existente
(`effectiveElevM`), la lógica se bifurca:

- **`fresnelCompensation == false`**: comportamiento idéntico al actual
  — `effectiveElevM >= originElevM` → `LinkStatusBlocked` (con
  `CollisionLat/Lon/ElevM`), si no continúa. Nunca hay `degraded`.

- **`fresnelCompensation == true`**: por muestra se calcula
  `r := FresnelRadiusM(d, 915)`, `hExtra := factor·r`,
  `clearanceM := (originElevM + hExtra) - effectiveElevM`,
  `pct := clearanceM/r·100` (100 si `r<=0`).
  - `clearanceM <= 0` → `LinkStatusBlocked` (terreno alcanza o supera
    la línea ya compensada — bloqueo físico incluso subiendo la
    antena).
  - `pct < 60` → `LinkStatusDegraded` (línea geométricamente
    despejada, pero <60% de la zona de Fresnel libre — señal
    degradada, no un bloqueo duro).
  - si no, continúa al siguiente sample.

Si el rayo agota todas las muestras sin bloquear/degradar,
`LinkStatusClear` con `FresnelClearPct` del último sample evaluado
(el más restrictivo del rayo, ya que el radio de Fresnel crece con la
distancia).

Un `NaN` de cobertura DEM sigue truncando el rayo igual que hoy
(`LinkStatusClear`, sin evaluar Fresnel en ese punto — no hay dato de
terreno confiable ahí).

### 5.3 Interacción con `earth_curvature`

Independiente: la curvatura ajusta `effectiveElevM` (el terreno cae
con la distancia); Fresnel ajusta `originElevM` con `hExtra` (la línea
sube con la distancia). Ambos se acumulan sin condicionarse entre sí.

## 6) Validación (`validate.go`)

- `compensation_factor` opcional, default `0.6`; si está presente debe
  estar en `[0.5, 0.7]` (400 si no).
- `fresnel_compensation` opcional, default `true`.
- Sin nuevo tope de `MaxTotalSamples`: esta feature es cálculo puro
  sobre elevaciones ya obtenidas, no agrega llamadas al DEM.

## 7) Testing

- `fresnel_test.go` (nuevo): `FresnelRadiusM`/`HeightCompensationM`
  contra valores calculados a mano (λ≈0.3278m a 915MHz).
- `ray_test.go`: tests existentes pasan `fresnelCompensation=false`
  (preservan semántica actual sin cambios); nuevos casos para
  `degraded` (clearance geométrico OK, <60% Fresnel), `blocked` con
  compensación (terreno supera incluso la línea con h_extra), y
  confirmar que `fresnel_compensation=false` nunca produce `degraded`.
- `simulator_test.go`: verificar `Metadata.FresnelTable` (21 puntos,
  extremos en `0` y `max_distance_m`).
- `validate_test.go`: rango de `compensation_factor`, defaults.
- `simulation_handler_test.go`: `collided` derivado correctamente para
  `degraded` y `blocked`; forma JSON de los campos nuevos.

## 8) Criterios de aceptación

- `go vet ./...` y `go test ./...` (paquete `los` + `handlers`) pasan.
- Con `fresnel_compensation=false`, el comportamiento y JSON de rayos
  es indistinguible del actual salvo por los campos nuevos presentes
  con valores neutrales (`link_status` derivado de `collided` viejo,
  `fresnel_clear_pct: 0`).
- No se toca `apps/web` en esta ronda.
