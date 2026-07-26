# Frente de onda (ángulo inicial/final) en LOS 360° — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un parámetro "frente de onda" (ángulo inicial/final,
defaults `0`/`360`) al simulador LOS radial, que acota el barrido de
rayos a ese arco. Validación `end > start` en el frontend (previa, para
no llegar a pegarle al backend con un request inválido) y también en el
backend (defensa en profundidad).

**Architecture:** El azimut interno no cambia (`0°=Norte, horario`, ver
`geodesy.go: Destination`) — el frente de onda es un sub-rango de ese
mismo barrido. Backend: `RadialSimulationRequest`/`SimulationInput`
ganan `start_angle_deg`/`end_angle_deg`; `ValidateRequest` aplica
defaults y valida; `Simulator.Run` genera rayos solo en `[start, end)`.
Frontend: dos inputs nuevos en el panel LOS 360°, validados client-side
antes de llamar `runRadialSimulation`; `estimateTotalPoints` y
`drawRays` (con el fix del polígono de cobertura para arcos parciales)
actualizados para el nuevo rango.

**Tech Stack:** Go 1.22 + Gin (`apps/api`); Astro 4 + TypeScript
vanilla + Leaflet (`apps/web`).

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-23-wavefront-angle-design.md`.
- Regla de negocio: `end_angle_deg > start_angle_deg` siempre (no se
  soportan arcos que envuelven el norte, ej. `start=350, end=10`).
- Rango válido de cada ángulo: `[0, 360]`.
- **Validación en el frontend antes de llamar al backend** (pedido
  explícito del usuario, para no saturarlo con requests que se van a
  rechazar) — el backend mantiene la misma validación como defensa en
  profundidad, no se elimina de `validate.go`.
- Defaults `0`/`360` deben reproducir exactamente el comportamiento
  actual (barrido completo) — verificar que ningún test existente
  cambie de resultado por esto.
- Todo el código nuevo sigue el estilo ya existente en cada archivo
  (tests table-driven en Go, mismo patrón de lectura de inputs
  numéricos + `showToast` en el frontend).

---

### Task 1: Backend — `models.RadialSimulationRequest` + `los.SimulationInput`

**Files:**
- Modify: `apps/api/internal/models/models.go:138-147`
- Modify: `apps/api/internal/terrain/los/simulator.go:23-32`

**Interfaces:**
- Produces: `models.RadialSimulationRequest.StartAngleDeg *float64`, `.EndAngleDeg *float64` (JSON `start_angle_deg`/`end_angle_deg`); `los.SimulationInput.StartAngleDeg float64`, `.EndAngleDeg float64` — consumidos por Task 2 (`ValidateRequest`) y Task 3 (`Simulator.Run`).

- [x] **Step 1: Agregar los campos a `RadialSimulationRequest`**

En `apps/api/internal/models/models.go`, reemplazar:

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
}
```

por:

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

- [x] **Step 2: Agregar los campos a `SimulationInput`**

En `apps/api/internal/terrain/los/simulator.go`, reemplazar:

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
}
```

por:

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

- [x] **Step 3: Verificar que compila (todavía no hay usos rotos)**

```bash
cd apps/api
go build ./...
```

Expected: sin errores (los structs solo ganaron campos opcionales/con
zero-value, nada los usa todavía).

- [ ] **Step 4: Commit**

```bash
git add apps/api/internal/models/models.go apps/api/internal/terrain/los/simulator.go
git commit -m "$(cat <<'EOF'
feat(api): agregar start_angle_deg/end_angle_deg a los structs de LOS radial

Preparación para acotar el barrido de rayos a un arco (frente de onda)
en vez de siempre los 360° completos.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend — `ValidateRequest` aplica defaults y valida el arco

**Files:**
- Modify: `apps/api/internal/terrain/los/validate.go`
- Modify: `apps/api/internal/terrain/los/validate_test.go`

**Interfaces:**
- Consumes: `models.RadialSimulationRequest.StartAngleDeg/.EndAngleDeg` (Task 1).
- Produces: `SimulationInput.StartAngleDeg/.EndAngleDeg` poblados con defaults `0`/`360` o los valores validados.

- [x] **Step 1: Agregar la validación del arco en `ValidateRequest`**

En `apps/api/internal/terrain/los/validate.go`, después del bloque que
resuelve `earthCurvature` (antes de `rayCount := int(math.Ceil(360 / angleStep))`):

```go
	earthCurvature := true
	if req.EarthCurvature != nil {
		earthCurvature = *req.EarthCurvature
	}

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

- [x] **Step 2: Usar el arco en vez de 360 fijo para el tope de muestras**

Reemplazar:

```go
	rayCount := int(math.Ceil(360 / angleStep))
```

por:

```go
	rayCount := int(math.Ceil((endAngle - startAngle) / angleStep))
```

(la línea `samplesPerRay := int(math.Ceil(maxDist / sampleStep))` y el
resto del chequeo de `MaxTotalSamples` no cambian.)

- [x] **Step 3: Incluir el arco en el `SimulationInput` devuelto**

Reemplazar:

```go
	return SimulationInput{
		OriginLat: lat, OriginLon: lon, OriginHeightM: heightM,
		AngleStepDeg: angleStep, MaxDistanceM: maxDist, SampleStepM: sampleStep,
		EarthCurvature: earthCurvature, RefractionK: refractionK,
	}, nil
```

por:

```go
	return SimulationInput{
		OriginLat: lat, OriginLon: lon, OriginHeightM: heightM,
		AngleStepDeg: angleStep, MaxDistanceM: maxDist, SampleStepM: sampleStep,
		EarthCurvature: earthCurvature, RefractionK: refractionK,
		StartAngleDeg: startAngle, EndAngleDeg: endAngle,
	}, nil
```

- [x] **Step 4: Agregar tests en `validate_test.go`**

Al final del archivo:

```go
func TestValidateRequestWavefrontDefaultsApplied(t *testing.T) {
	in, err := ValidateRequest(validRequest())
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if in.StartAngleDeg != 0 {
		t.Errorf("StartAngleDeg default = %v, want 0", in.StartAngleDeg)
	}
	if in.EndAngleDeg != 360 {
		t.Errorf("EndAngleDeg default = %v, want 360", in.EndAngleDeg)
	}
}

func TestValidateRequestWavefrontEndMustBeGreaterThanStart(t *testing.T) {
	req := validRequest()
	req.StartAngleDeg = f(180)
	req.EndAngleDeg = f(180)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con end_angle_deg == start_angle_deg")
	}

	req.EndAngleDeg = f(90)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con end_angle_deg < start_angle_deg")
	}
}

func TestValidateRequestWavefrontOutOfRange(t *testing.T) {
	req := validRequest()
	req.StartAngleDeg = f(-10)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con start_angle_deg fuera de [0, 360]")
	}

	req = validRequest()
	req.EndAngleDeg = f(400)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con end_angle_deg fuera de [0, 360]")
	}
}

func TestValidateRequestWavefrontPartialArcAppliesToBudget(t *testing.T) {
	req := validRequest() // 72 rayos x 80 muestras = 5760 <= 8000 con 360° completos
	req.StartAngleDeg = f(0)
	req.EndAngleDeg = f(90) // ahora solo 18 rayos x 80 = 1440
	in, err := ValidateRequest(req)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if in.StartAngleDeg != 0 || in.EndAngleDeg != 90 {
		t.Errorf("StartAngleDeg/EndAngleDeg = %v/%v, want 0/90", in.StartAngleDeg, in.EndAngleDeg)
	}
}
```

- [x] **Step 5: Correr los tests**

```bash
cd apps/api
go test ./internal/terrain/los/... -run TestValidateRequest -v
```

Expected: todos los `TestValidateRequest*` (los existentes y los 4
nuevos) pasan.

- [x] **Step 6: `go build`/`go vet` completos**

```bash
cd apps/api
go build ./... && go vet ./...
```

Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add apps/api/internal/terrain/los/validate.go apps/api/internal/terrain/los/validate_test.go
git commit -m "$(cat <<'EOF'
feat(api): validar y aplicar defaults de start_angle_deg/end_angle_deg

Defaults 0/360 (barrido completo, retrocompatible). Valida rango
[0,360] de cada ángulo y end_angle_deg > start_angle_deg. El tope de
MaxTotalSamples ahora usa el arco (end-start) en vez de 360 fijo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Backend — `Simulator.Run` genera solo el arco pedido

**Files:**
- Modify: `apps/api/internal/terrain/los/simulator.go`
- Modify: `apps/api/internal/terrain/los/simulator_test.go`

**Interfaces:**
- Consumes: `SimulationInput.StartAngleDeg/.EndAngleDeg` (Task 1).

- [x] **Step 1: Cambiar el barrido de rayos en `Run`**

En `apps/api/internal/terrain/los/simulator.go`, reemplazar:

```go
	rayCount := int(math.Ceil(360 / in.AngleStepDeg))
```

por:

```go
	rayCount := int(math.Ceil((in.EndAngleDeg - in.StartAngleDeg) / in.AngleStepDeg))
```

y reemplazar:

```go
	for i := 0; i < rayCount; i++ {
		angle := float64(i) * in.AngleStepDeg
```

por:

```go
	for i := 0; i < rayCount; i++ {
		angle := in.StartAngleDeg + float64(i)*in.AngleStepDeg
```

(el resto de `Run` — `angles[i] = angle`, generación de puntos,
`fetchElevations`, `EvaluateRay` — no cambia.)

- [x] **Step 2: Actualizar los 4 `SimulationInput{...}` existentes en `simulator_test.go`**

**Importante:** `SimulationInput` ahora tiene `EndAngleDeg`, que sin
setear queda en el zero-value de Go (`0.0`) — con `StartAngleDeg` en
`0` también, `rayCount := ceil((0-0)/angleStep) = 0`, es decir **cero
rayos**, rompiendo los asserts existentes de `len(resp.Rays)`. Hay que
agregar `EndAngleDeg: 360` a los 4 literales ya existentes:

En `TestSimulatorRunFlatTerrainNeverCollides`, reemplazar:

```go
	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 30,
		AngleStepDeg: 90, MaxDistanceM: 1000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
	}
```

por:

```go
	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 30,
		AngleStepDeg: 90, MaxDistanceM: 1000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
	}
```

En `TestSimulatorRunOriginOutOfCoverageFails`, reemplazar:

```go
	in := SimulationInput{
		OriginLat: 0, OriginLon: 0, AngleStepDeg: 90,
		MaxDistanceM: 500, SampleStepM: 500, EarthCurvature: false, RefractionK: 0.13,
	}
```

por:

```go
	in := SimulationInput{
		OriginLat: 0, OriginLon: 0, AngleStepDeg: 90,
		MaxDistanceM: 500, SampleStepM: 500, EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
	}
```

En `TestSimulatorRunPartialCoverageTruncatesOnlyAffectedRay`, reemplazar:

```go
	in := SimulationInput{
		OriginLat: 0, OriginLon: -73.21, OriginHeightM: 10,
		AngleStepDeg: 180, MaxDistanceM: 20000, SampleStepM: 5000, // 2 rayos: 0° (norte) y 180° (sur)
		EarthCurvature: false, RefractionK: 0.13,
	}
```

por:

```go
	in := SimulationInput{
		OriginLat: 0, OriginLon: -73.21, OriginHeightM: 10,
		AngleStepDeg: 180, MaxDistanceM: 20000, SampleStepM: 5000, // 2 rayos: 0° (norte) y 180° (sur)
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
	}
```

En `TestSimulatorRunAppliesOriginHeightAboveTerrain`, reemplazar:

```go
	in := SimulationInput{
		OriginLat: 7.0, OriginLon: -73.0, OriginHeightM: 5,
		AngleStepDeg: 360, MaxDistanceM: 500, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
	}
```

por:

```go
	in := SimulationInput{
		OriginLat: 7.0, OriginLon: -73.0, OriginHeightM: 5,
		AngleStepDeg: 360, MaxDistanceM: 500, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
	}
```

- [x] **Step 3: Agregar un test nuevo de arco parcial**

Al final de `simulator_test.go`:

```go
func TestSimulatorRunPartialArcGeneratesOnlyRequestedRays(t *testing.T) {
	fake := &fakeElevationProvider{elevAt: func(lat, lon float64) (float64, error) { return 500, nil }}
	sim := &Simulator{Elevation: fake}

	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 10,
		AngleStepDeg: 30, MaxDistanceM: 1000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 90,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 3 { // (90-0)/30 = 3: ángulos 0, 30, 60
		t.Fatalf("len(Rays) = %d, want 3", len(resp.Rays))
	}
	wantAngles := []float64{0, 30, 60}
	for i, ray := range resp.Rays {
		if ray.AngleDeg != wantAngles[i] {
			t.Errorf("Rays[%d].AngleDeg = %v, want %v", i, ray.AngleDeg, wantAngles[i])
		}
	}
}

func TestSimulatorRunPartialArcWithNonZeroStart(t *testing.T) {
	fake := &fakeElevationProvider{elevAt: func(lat, lon float64) (float64, error) { return 500, nil }}
	sim := &Simulator{Elevation: fake}

	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 10,
		AngleStepDeg: 45, MaxDistanceM: 1000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 90, EndAngleDeg: 180,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 2 { // (180-90)/45 = 2: ángulos 90, 135
		t.Fatalf("len(Rays) = %d, want 2", len(resp.Rays))
	}
	wantAngles := []float64{90, 135}
	for i, ray := range resp.Rays {
		if ray.AngleDeg != wantAngles[i] {
			t.Errorf("Rays[%d].AngleDeg = %v, want %v", i, ray.AngleDeg, wantAngles[i])
		}
	}
}
```

- [x] **Step 4: Correr todos los tests de `los`**

```bash
cd apps/api
go test ./internal/terrain/los/... -v
```

Expected: todos pasan, incluidos los 4 existentes (ahora con
`EndAngleDeg: 360` explícito) y los 2 nuevos de arco parcial.

- [x] **Step 5: `go build`/`go vet` completos**

```bash
cd apps/api
go build ./... && go vet ./...
```

Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/api/internal/terrain/los/simulator.go apps/api/internal/terrain/los/simulator_test.go
git commit -m "$(cat <<'EOF'
feat(api): Simulator.Run genera rayos solo dentro del arco pedido

StartAngleDeg/EndAngleDeg acotan el barrido en vez de siempre 0-360.
Actualiza los SimulationInput{} de los tests existentes con
EndAngleDeg: 360 explícito (el zero-value de Go rompía rayCount al
quedar en 0/0) y agrega tests de arco parcial con/sin start != 0.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Backend — verificación de la API completa (endpoint end-to-end)

**Files:** ninguno (solo verificación).

- [x] **Step 1: Levantar el servidor y probar el endpoint con curl**

```bash
cd apps/api
rm -f /tmp/meshcore-wavefront-test.db
DB_PATH=/tmp/meshcore-wavefront-test.db go run ./cmd/api &
sleep 2

echo "--- arco parcial válido (0-90, step 30 -> 3 rayos) ---"
curl -s -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{"origin_lat":7.1193,"origin_lon":-73.1227,"angle_step_deg":30,"max_distance_m":1000,"sample_step_m":500,"start_angle_deg":0,"end_angle_deg":90}' \
  | python3 -m json.tool

echo "--- end <= start (debe rechazar 400) ---"
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{"origin_lat":7.1193,"origin_lon":-73.1227,"angle_step_deg":30,"max_distance_m":1000,"sample_step_m":500,"start_angle_deg":180,"end_angle_deg":90}'

echo "--- sin start/end (defaults 0/360, comportamiento actual) ---"
curl -s -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{"origin_lat":7.1193,"origin_lon":-73.1227,"angle_step_deg":90,"max_distance_m":1000,"sample_step_m":500}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['rays']), 'rayos')"

kill %1
rm -f /tmp/meshcore-wavefront-test.db
```

Expected:
- Primer curl: `200` con `4` claves de metadata y `3` elementos en `rays` (ángulos `0`, `30`, `60`).
- Segundo curl: `HTTP 400` con `{"error":"end_angle_deg debe ser mayor que start_angle_deg"}`.
- Tercer curl: `4 rayos` (`360/90`), igual que antes de este cambio.

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-3.

---

### Task 5: Frontend — tipos y payload (`api.ts`)

**Files:**
- Modify: `apps/web/src/lib/api.ts:166-175`

**Interfaces:**
- Produces: `RadialSimulationRequest.start_angle_deg: number`, `.end_angle_deg: number` — consumidos por Task 8 (`mapPage.ts`).

- [x] **Step 1: Agregar los campos a la interfaz**

Reemplazar:

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
}
```

por:

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

- [x] **Step 2: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: falla — `runRadialSimulation` (Task 8) todavía arma el
objeto sin `start_angle_deg`/`end_angle_deg`, así que TypeScript debería
marcar el literal como incompleto. Es esperable hasta Task 8.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(web): agregar start_angle_deg/end_angle_deg a RadialSimulationRequest

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Frontend — markup y estilos del campo "Frente de onda"

**Files:**
- Modify: `apps/web/src/pages/index.astro`
- Modify: `apps/web/src/styles/global.css`

**Interfaces:**
- Produces: elementos DOM `#radar-start-angle`, `#radar-end-angle` que Task 8 (`mapPage.ts`) consume.

- [x] **Step 1: Agregar los inputs en `index.astro`**

Inmediatamente después del campo:

```astro
    <div class="radar-field">
      <label for="radar-angle-step">Paso angular (°)</label>
      <input type="number" id="radar-angle-step" value="5" min="1" max="45" step="1" />
    </div>
```

agregar:

```astro
    <div class="radar-field">
      <label>Frente de onda (°)</label>
      <div class="radar-field-row">
        <input type="number" id="radar-start-angle" value="0" min="0" max="360" step="1" title="Ángulo inicial" />
        <input type="number" id="radar-end-angle" value="360" min="0" max="360" step="1" title="Ángulo final" />
      </div>
    </div>
```

- [x] **Step 2: Agregar `.radar-field-row` a `global.css`**

En `apps/web/src/styles/global.css`, inmediatamente después del bloque:

```css
.radar-field input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-bright);
  border-radius: 4px;
  color: var(--text);
  padding: 0.3rem 0.4rem;
  font-size: 0.75rem;
}
```

agregar:

```css
.radar-field-row {
  display: flex;
  gap: 0.4rem;
}
.radar-field-row input {
  flex: 1;
  min-width: 0;
}
```

- [x] **Step 3: Verificar que el build de Astro no rompe**

```bash
cd apps/web
npm run build
```

Expected: sin errores (el markup nuevo es HTML válido, sin scripts que lo referencien todavía).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/src/styles/global.css
git commit -m "$(cat <<'EOF'
feat(web): agregar campo "Frente de onda" al panel LOS 360°

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Frontend — `radialSimulation.ts` (estimación de progreso + polígono de cobertura)

**Files:**
- Modify: `apps/web/src/lib/map/radialSimulation.ts`

**Interfaces:**
- Consumes: nada nuevo (usa lo que ya recibe `RadialSimulationRequest`/`RadialSimulationResponse`).
- Produces: `estimateTotalPoints(startAngleDeg, endAngleDeg, angleStepDeg, maxDistanceM, sampleStepM)` — firma nueva, consumida por Task 8.

- [x] **Step 1: Actualizar `estimateTotalPoints`**

Reemplazar:

```ts
export function estimateTotalPoints(angleStepDeg: number, maxDistanceM: number, sampleStepM: number): number {
  const rayCount = Math.ceil(360 / angleStepDeg);
  const samplesPerRay = Math.ceil(maxDistanceM / sampleStepM);
  return rayCount * samplesPerRay + 1;
}
```

por:

```ts
export function estimateTotalPoints(
  startAngleDeg: number,
  endAngleDeg: number,
  angleStepDeg: number,
  maxDistanceM: number,
  sampleStepM: number
): number {
  const rayCount = Math.ceil((endAngleDeg - startAngleDeg) / angleStepDeg);
  const samplesPerRay = Math.ceil(maxDistanceM / sampleStepM);
  return rayCount * samplesPerRay + 1;
}
```

- [x] **Step 2: Pasar el arco a `drawRays` desde `runRadialSimulation`**

Reemplazar:

```ts
    const result = await simulateRadialLOS(input, activeController.signal);
    drawRays(input.origin_lat, input.origin_lon, result);
```

por:

```ts
    const result = await simulateRadialLOS(input, activeController.signal);
    drawRays(input.origin_lat, input.origin_lon, input.start_angle_deg, input.end_angle_deg, result);
```

- [x] **Step 3: Actualizar `drawRays` — firma + fix del polígono para arcos parciales**

Reemplazar:

```ts
function drawRays(originLat: number, originLon: number, result: RadialSimulationResponse) {
  // Limpia solo los rayos previos; el marcador de origen se conserva
  // (se reposiciona más abajo) para no perder de vista dónde se está
  // parado entre una simulación y la siguiente.
  const toRemove: L.Layer[] = [];
  radialLayer.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) toRemove.push(layer);
  });
  toRemove.forEach((layer) => radialLayer.removeLayer(layer));

  if (boundaryPolygon) {
    radialLayer.removeLayer(boundaryPolygon);
    boundaryPolygon = null;
  }

  setOriginMarker(originLat, originLon);

  // result.rays viene en orden angular creciente desde el backend (0°,
  // angle_step_deg, 2*angle_step_deg, ...) — se puede usar directo como
  // anillo del polígono de cobertura sin reordenar.
  const boundaryPoints: L.LatLngExpression[] = [];
  for (const ray of result.rays) {
```

por:

```ts
function drawRays(
  originLat: number,
  originLon: number,
  startAngleDeg: number,
  endAngleDeg: number,
  result: RadialSimulationResponse
) {
  // Limpia solo los rayos previos; el marcador de origen se conserva
  // (se reposiciona más abajo) para no perder de vista dónde se está
  // parado entre una simulación y la siguiente.
  const toRemove: L.Layer[] = [];
  radialLayer.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) toRemove.push(layer);
  });
  toRemove.forEach((layer) => radialLayer.removeLayer(layer));

  if (boundaryPolygon) {
    radialLayer.removeLayer(boundaryPolygon);
    boundaryPolygon = null;
  }

  setOriginMarker(originLat, originLon);

  // result.rays viene en orden angular creciente desde el backend (0°,
  // angle_step_deg, 2*angle_step_deg, ...) — se puede usar directo como
  // anillo del polígono de cobertura sin reordenar. Con un frente de
  // onda parcial (no 0-360 completo) se antepone el origen al anillo
  // para que el polígono salga como un sector (dos lados rectos desde
  // el origen + el arco) en vez de una "lente" que corta en línea recta
  // entre los dos extremos del arco.
  const isFullCircle = startAngleDeg === 0 && endAngleDeg === 360;
  const boundaryPoints: L.LatLngExpression[] = isFullCircle ? [] : [[originLat, originLon]];
  for (const ray of result.rays) {
```

(el resto del cuerpo de `drawRays` — el `L.polyline(...)`, el push a
`boundaryPoints`, y el bloque final de `L.polygon(...)` — no cambia.)

- [x] **Step 4: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sigue fallando por `mapPage.ts` (Task 8 todavía no actualizó
las llamadas a `estimateTotalPoints`/`runRadialSimulation`) — esperable
hasta el próximo task.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/map/radialSimulation.ts
git commit -m "$(cat <<'EOF'
feat(web): acotar estimateTotalPoints/drawRays al frente de onda

estimateTotalPoints usa (end-start)/angleStep en vez de 360/angleStep
para que la barra de progreso siga siendo precisa con un arco parcial.
drawRays antepone el origen al anillo del polígono de cobertura cuando
el arco no es 0-360 completo, para que salga como sector en vez de
lente.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Frontend — `mapPage.ts` lee, valida (client-side) y envía el frente de onda

**Files:**
- Modify: `apps/web/src/lib/mapPage.ts`

**Interfaces:**
- Consumes: `estimateTotalPoints(startAngleDeg, endAngleDeg, angleStepDeg, maxDistanceM, sampleStepM)` (Task 7), `RadialSimulationRequest.start_angle_deg/.end_angle_deg` (Task 5).

- [x] **Step 1: Leer los inputs y validar antes de armar el request**

Reemplazar dentro del handler de `btnRunRadial`:

```ts
  const heightM = Number((document.getElementById('radar-height') as HTMLInputElement).value);
  const angleStepDeg = Number((document.getElementById('radar-angle-step') as HTMLInputElement).value);
  const maxDistanceM = Number((document.getElementById('radar-max-distance') as HTMLInputElement).value);
  const sampleStepM = Number((document.getElementById('radar-sample-step') as HTMLInputElement).value);

  const totalPoints = estimateTotalPoints(angleStepDeg, maxDistanceM, sampleStepM);
```

por:

```ts
  const heightM = Number((document.getElementById('radar-height') as HTMLInputElement).value);
  const angleStepDeg = Number((document.getElementById('radar-angle-step') as HTMLInputElement).value);
  const maxDistanceM = Number((document.getElementById('radar-max-distance') as HTMLInputElement).value);
  const sampleStepM = Number((document.getElementById('radar-sample-step') as HTMLInputElement).value);
  const startAngleDeg = Number((document.getElementById('radar-start-angle') as HTMLInputElement).value);
  const endAngleDeg = Number((document.getElementById('radar-end-angle') as HTMLInputElement).value);

  // Validado acá, antes de llamar al backend, para no disparar una
  // request que se va a rechazar igual (validate.go tiene la misma
  // regla como defensa en profundidad, no como primera línea).
  if (
    Number.isNaN(startAngleDeg) || Number.isNaN(endAngleDeg) ||
    startAngleDeg < 0 || startAngleDeg > 360 ||
    endAngleDeg < 0 || endAngleDeg > 360 ||
    endAngleDeg <= startAngleDeg
  ) {
    showToast('Frente de onda inválido: el ángulo final debe ser mayor que el inicial, ambos entre 0 y 360', 'error');
    return;
  }

  const totalPoints = estimateTotalPoints(startAngleDeg, endAngleDeg, angleStepDeg, maxDistanceM, sampleStepM);
```

- [x] **Step 2: Agregar los campos al payload de `runRadialSimulation`**

Reemplazar:

```ts
  const outcome = await runRadialSimulation({
    origin_lat: pickedOrigin.lat,
    origin_lon: pickedOrigin.lon,
    origin_height_m: heightM,
    angle_step_deg: angleStepDeg,
    max_distance_m: maxDistanceM,
    sample_step_m: sampleStepM,
    earth_curvature: true,
  });
```

por:

```ts
  const outcome = await runRadialSimulation({
    origin_lat: pickedOrigin.lat,
    origin_lon: pickedOrigin.lon,
    origin_height_m: heightM,
    angle_step_deg: angleStepDeg,
    max_distance_m: maxDistanceM,
    sample_step_m: sampleStepM,
    earth_curvature: true,
    start_angle_deg: startAngleDeg,
    end_angle_deg: endAngleDeg,
  });
```

- [x] **Step 3: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores — cierra el ciclo de tipos abierto en Tasks 5 y 7.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/mapPage.ts
git commit -m "$(cat <<'EOF'
feat(web): validar y enviar el frente de onda en la simulación LOS 360°

Valida start_angle_deg/end_angle_deg en el cliente (rango [0,360] y
end > start) antes de llamar al backend, mostrando un toast de error
sin disparar ninguna request si falla.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Verificación manual end-to-end en navegador

**Files:** ninguno (solo verificación).

- [x] **Step 1: Levantar backend + frontend**

```bash
cd apps/api && DB_PATH=/tmp/meshcore-wavefront-e2e.db go run ./cmd/api &
cd apps/web && npm run dev &
```

- [x] **Step 2: Casos a verificar en el navegador**

1. Elegir origen en el mapa, dejar "Frente de onda" en los defaults
   `0`/`360`, simular → comportamiento idéntico al actual (rayos en
   círculo completo, polígono como anillo).
2. Cambiar a `0`/`90`, simular → solo se dibujan rayos entre esos dos
   ángulos; el polígono de cobertura sale como un sector que toca el
   marcador de origen (no como una lente).
3. Poner `end_angle_deg` menor o igual a `start_angle_deg` (ej.
   `180`/`90`) y hacer click en "Simular" → toast de error inmediato
   ("Frente de onda inválido..."), **sin** que se dispare ninguna
   request de red (confirmar en la pestaña Network del navegador que
   no sale ningún `POST /simulations/radial`).
4. Poner un valor fuera de `[0, 360]` (ej. `400`) → mismo toast de
   error, sin request.

- [x] **Step 3: Apagar los servidores**

```bash
kill %1 %2
rm -f /tmp/meshcore-wavefront-e2e.db
```

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-8.


## Nota de verificación (post-implementación)

Backend: los 31 tests de `internal/terrain/los/...` pasan (incluye los
2 nuevos de arco parcial con ángulos exactos verificados). Verificación
manual del endpoint con curl: arco inválido (`end<=start`) y fuera de
rango (`>360`) devuelven `400` con el mensaje esperado; un arco válido
(`0-90`) llega hasta el fetch al DEM (falla ahí solo porque no hay un
servicio DEM corriendo en este sandbox — `dem_backend_unavailable`, no
relacionado con este cambio).

Frontend: verificado con Playwright headless contra `npm run dev` +
`go run ./cmd/api` reales. Confirmado en la request real enviada al
backend (interceptando `POST /simulations/radial`):
- Defaults sin tocar el campo → `start_angle_deg:0, end_angle_deg:360`.
- `end_angle_deg <= start_angle_deg` (ej. `180`/`90`) → toast de error,
  **cero** requests de red (bloqueado client-side, tal como pediste).
- Fuera de `[0,360]` (ej. `400`) → mismo comportamiento, cero requests.
- Arco válido `0`-`90` → exactamente un request con
  `start_angle_deg:0, end_angle_deg:90` en el body.

No se pudo verificar visualmente el dibujo de rayos/polígono de
cobertura (requiere un servicio DEM real, no disponible en este
sandbox) — esa lógica de conteo/ángulo de rayos está cubierta
exhaustivamente por los tests de Go (`TestSimulatorRunPartialArc*`).
