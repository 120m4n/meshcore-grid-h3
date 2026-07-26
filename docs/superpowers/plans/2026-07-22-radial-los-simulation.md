# Simulación radial 360° LOS (colisión topográfica) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Endpoint `POST /api/v1/simulations/radial` que, dado un origen y una
altura de antena, calcula 360° de rayos con la distancia a la que cada uno
choca contra el terreno (o alcanza el máximo configurado), y una capa
Leaflet en el frontend que dibuja esos rayos como un radar.

**Architecture:** Módulo Go nuevo y aislado (`internal/terrain/los`) sin
tocar `reports`/`cell_agg`. Elevación resuelta contra una API DEM HTTP de
un solo punto (`POST http://localhost:8000/elevation`), con un pool de
goroutines acotado y un tope duro de muestras totales por simulación
(ver Decisión de diseño 2 abajo). Detección de colisión: rayo horizontal
desde el origen, comparado contra el perfil de terreno ajustado por
curvatura terrestre. Frontend: nueva capa `radialLayer` + panel flotante
de parámetros, mismo patrón que `cellLayer`/`testLayer`.

**Tech Stack:** Go 1.22 (stdlib `net/http`, sin nuevas dependencias),
Astro + Leaflet + TypeScript vanilla (sin nuevas dependencias).

## Decisiones de diseño (resueltas con el usuario antes de este plan)

1. **`origin_height_m`** = altura de antena sobre el terreno local, NO
   msnm absoluta. La elevación efectiva del origen se calcula como
   `DEM(origin_lat, origin_lon) + origin_height_m`.
2. **Presupuesto de muestreo**: el DEM es una API HTTP de un solo punto
   (medido: ~15-20ms/llamada, ~250 req/s con 50 llamadas concurrentes
   vía curl). Los defaults *sugeridos originalmente* en el spec kit
   (`angle_step_deg=2`, `max_distance_m=15000`, `sample_step_m=30` →
   180 rayos × 500 muestras = 90 000 llamadas DEM) tardarían decenas de
   segundos — incompatible con un endpoint síncrono. Se resuelve así:
   - El endpoint sigue siendo síncrono (200 directo, sin job/polling).
   - Se valida `rays * samples_per_ray <= MaxTotalSamples` (8000) y se
     rechaza con `400` si el request lo excede.
   - Los defaults que expone el frontend se ajustan para el MVP:
     `angle_step_deg=5` (72 rayos), `max_distance_m=8000`,
     `sample_step_m=100` (80 muestras/rayo) → 5760 muestras, cómodo bajo
     el tope de 8000.
   - Las llamadas al DEM dentro de una simulación se resuelven en
     paralelo con un pool acotado a 24 goroutines concurrentes.
3. **Cobertura DEM parcial**: si el ORIGEN cae fuera de cobertura DEM →
   `422 dem_coverage_insufficient` para todo el request. Si un punto
   *intermedio* de un rayo cae fuera de cobertura (borde de la región
   cubierta), ese rayo individual se trunca ahí (`collided:false`,
   `distance_m` = distancia del último punto válido) en vez de fallar
   toda la simulación — un solo rayo cerca del borde no debe tumbar el
   resultado de los otros 71.
4. **Autenticación**: el endpoint queda público (sin JWT), igual que
   `GET /cells` y `GET /cells/:h3_index/origins` — es una visualización
   superpuesta de solo lectura/cómputo, no toca datos persistidos. Se le
   agrega un rate limit dedicado más estricto (30/hora, burst 5) porque
   cada llamada es costosa contra el DEM, a diferencia de una simple
   lectura de `cell_agg`.

## Global Constraints

- No se modifica `reports`, `cell_agg`, `cell_overrides` ni ninguna
  migración existente — módulo nuevo y aislado.
- Sin nuevas dependencias Go ni npm (geodesia esférica y HTTP client de
  stdlib alcanzan para el rango del MVP, ≤100 km).
- `apps/api` usa Gin + `database/sql` inline; este módulo no introduce
  una capa de repositorio/servicio nueva, sigue el patrón de handlers
  existente (`internal/handlers/*.go` con structs inyectados a mano en
  `router.go`).
- Español en comentarios/mensajes de error orientados a producto,
  siguiendo la convención ya establecida en el repo.

---

## Backend

### Task 1: Config — URL del backend DEM

**Files:**
- Modify: `apps/api/internal/config/config.go`

**Interfaces:**
- Produces: `Config.DemAPIURL string`, `Config.DemSourceLabel string`,
  `Config.DemResolutionM float64` — consumidos por `router.New` en el
  Task 7 para construir el `HTTPElevationProvider` y el `SimulationHandler`.

- [ ] **Step 1: Agregar campos y wiring de env vars**

Reemplazar el contenido completo de `apps/api/internal/config/config.go`:

```go
package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port           string
	DBPath         string
	JWTSecret      string
	H3Resolution   int
	WebOrigin      string
	DemAPIURL      string
	DemSourceLabel string
	DemResolutionM float64
}

func Load() Config {
	res, err := strconv.Atoi(getEnv("H3_RESOLUTION", "8"))
	if err != nil {
		res = 8
	}
	demResM, err := strconv.ParseFloat(getEnv("DEM_RESOLUTION_M", "30"), 64)
	if err != nil {
		demResM = 30
	}
	return Config{
		Port:           getEnv("PORT", "8080"),
		DBPath:         getEnv("DB_PATH", "/data/meshcore.db"),
		JWTSecret:      getEnv("JWT_SECRET", "change-me-in-production"),
		H3Resolution:   res,
		WebOrigin:      getEnv("WEB_ORIGIN", "http://localhost:4321"),
		DemAPIURL:      getEnv("DEM_API_URL", "http://localhost:8000"),
		DemSourceLabel: getEnv("DEM_SOURCE_LABEL", "local-dem-api"),
		DemResolutionM: demResM,
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
```

`DemSourceLabel`/`DemResolutionM` son honestos, no inventados: no
sabemos qué dataset exacto sirve `localhost:8000/elevation`, así que el
default (`"local-dem-api"`, 30m) es explícitamente genérico y
configurable por env — no se copia el `"copernicus-glo30-v2024-1"` del
ejemplo del spec porque sería un dato falso.

- [ ] **Step 2: Verificar que compila**

Run: `cd apps/api && go build ./...`
Expected: sin errores (nadie más usa `config.Config` con inicialización
posicional que rompería al agregar campos, ya que `config.Load()` es el
único constructor usado en todo el repo).

- [ ] **Step 3: Commit**

```bash
git add apps/api/internal/config/config.go
git commit -m "feat(api): agregar config de DEM API para simulación LOS radial"
```

---

### Task 2: Geodesia pura — destino por azimut+distancia y caída por curvatura

**Files:**
- Create: `apps/api/internal/terrain/los/geodesy.go`
- Test: `apps/api/internal/terrain/los/geodesy_test.go`

**Interfaces:**
- Produces: `Destination(lat, lon, azimuthDeg, distanceM float64) (float64, float64)`,
  `CurvatureDropM(distanceM, refractionK float64) float64` — usados por
  `Simulator.Run` (Task 5) y `EvaluateRay` (Task 4).

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/api/internal/terrain/los/geodesy_test.go`:

```go
package los

import (
	"math"
	"testing"
)

func almostEqual(a, b, tol float64) bool {
	return math.Abs(a-b) <= tol
}

func TestDestinationNorth(t *testing.T) {
	// 1 grado de latitud en el ecuador ≈ earthRadiusM * (π/180) metros.
	distanceM := earthRadiusM * math.Pi / 180
	lat, lon := Destination(0, 0, 0, distanceM)
	if !almostEqual(lat, 1.0, 1e-6) {
		t.Errorf("lat = %v, want ~1.0", lat)
	}
	if !almostEqual(lon, 0.0, 1e-6) {
		t.Errorf("lon = %v, want ~0.0", lon)
	}
}

func TestDestinationEast(t *testing.T) {
	distanceM := earthRadiusM * math.Pi / 180
	lat, lon := Destination(0, 0, 90, distanceM)
	if !almostEqual(lat, 0.0, 1e-6) {
		t.Errorf("lat = %v, want ~0.0", lat)
	}
	if !almostEqual(lon, 1.0, 1e-6) {
		t.Errorf("lon = %v, want ~1.0", lon)
	}
}

func TestDestinationZeroDistanceIsNoop(t *testing.T) {
	lat, lon := Destination(7.1193, -73.1227, 45, 0)
	if !almostEqual(lat, 7.1193, 1e-9) || !almostEqual(lon, -73.1227, 1e-9) {
		t.Errorf("Destination con distancia 0 debe devolver el mismo punto, got (%v, %v)", lat, lon)
	}
}

func TestCurvatureDropZeroAtOrigin(t *testing.T) {
	if d := CurvatureDropM(0, 0.13); d != 0 {
		t.Errorf("CurvatureDropM(0, k) = %v, want 0", d)
	}
}

func TestCurvatureDropIncreasesWithDistance(t *testing.T) {
	d1 := CurvatureDropM(1000, 0.13)
	d2 := CurvatureDropM(10000, 0.13)
	if d2 <= d1 {
		t.Errorf("la caída por curvatura debe crecer con la distancia: d1=%v d2=%v", d1, d2)
	}
}

func TestCurvatureDropRefractionReducesDrop(t *testing.T) {
	noRefraction := CurvatureDropM(10000, 0)
	withRefraction := CurvatureDropM(10000, 0.13)
	want := noRefraction * 0.87
	if !almostEqual(withRefraction, want, 1e-6) {
		t.Errorf("CurvatureDropM(10000, 0.13) = %v, want %v (87%% de %v)", withRefraction, want, noRefraction)
	}
	if withRefraction >= noRefraction {
		t.Errorf("refraction_k > 0 debe reducir la caída efectiva")
	}
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/terrain/los/... -run TestDestination -v`
Expected: FAIL — `undefined: Destination`, `undefined: earthRadiusM` (el
paquete `los` todavía no existe).

- [ ] **Step 3: Implementación mínima**

Crear `apps/api/internal/terrain/los/geodesy.go`:

```go
package los

import "math"

const earthRadiusM = 6371000.0

// Destination calcula el punto (lat, lon) tras recorrer distanceM
// metros en línea recta desde (lat, lon) con azimut azimuthDeg (0 =
// norte, sentido horario). Aproximación esférica (no elipsoide/Vincenty):
// suficiente para el rango del MVP, acotado a max_distance_m <= 100 km
// por validación (ver simulator.go).
func Destination(lat, lon, azimuthDeg, distanceM float64) (float64, float64) {
	if distanceM == 0 {
		return lat, lon
	}
	phi1 := lat * math.Pi / 180
	lambda1 := lon * math.Pi / 180
	theta := azimuthDeg * math.Pi / 180
	delta := distanceM / earthRadiusM

	phi2 := math.Asin(math.Sin(phi1)*math.Cos(delta) + math.Cos(phi1)*math.Sin(delta)*math.Cos(theta))
	lambda2 := lambda1 + math.Atan2(
		math.Sin(theta)*math.Sin(delta)*math.Cos(phi1),
		math.Cos(delta)-math.Sin(phi1)*math.Sin(phi2),
	)

	return phi2 * 180 / math.Pi, lambda2 * 180 / math.Pi
}

// CurvatureDropM calcula cuánto "cae" el terreno respecto a una línea
// recta horizontal desde el origen, a distanceM metros, por curvatura
// terrestre. refractionK reduce esa caída (la atmósfera estándar dobla
// la línea de vista hacia el suelo, "extendiendo" el horizonte
// efectivo): caída_efectiva = caída_geométrica * (1 - refractionK).
// refractionK=0 → sin corrección atmosférica (peor caso); valores más
// altos → más alcance efectivo antes de que algo bloquee.
func CurvatureDropM(distanceM, refractionK float64) float64 {
	geometric := (distanceM * distanceM) / (2 * earthRadiusM)
	return geometric * (1 - refractionK)
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `cd apps/api && go test ./internal/terrain/los/... -v`
Expected: PASS (todos los `TestDestination*` y `TestCurvatureDrop*`)

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/terrain/los/geodesy.go apps/api/internal/terrain/los/geodesy_test.go
git commit -m "feat(api): geodesia esférica y caída por curvatura para simulación LOS"
```

---

### Task 3: Detección de colisión por rayo (pura, sin HTTP)

**Files:**
- Create: `apps/api/internal/terrain/los/ray.go`
- Test: `apps/api/internal/terrain/los/ray_test.go`

**Interfaces:**
- Consumes: `CurvatureDropM` (Task 2).
- Produces: `type Sample struct{ DistanceM, Lat, Lon, ElevM float64 }`,
  `type Ray struct{ AngleDeg, EndLat, EndLon, DistanceM float64; Collided bool; CollisionLat, CollisionLon, CollisionElevM float64 }`,
  `EvaluateRay(angleDeg, originElevM float64, samples []Sample, earthCurvature bool, refractionK float64) Ray`
  — usados por `Simulator.Run` (Task 5) y por el mapeo de respuesta del
  handler (Task 6).

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/api/internal/terrain/los/ray_test.go`:

```go
package los

import "testing"

func TestEvaluateRayNoObstacleReachesMaxDistance(t *testing.T) {
	samples := []Sample{
		{DistanceM: 1000, Lat: 7.12, Lon: -73.12, ElevM: 800},
		{DistanceM: 2000, Lat: 7.13, Lon: -73.12, ElevM: 810},
		{DistanceM: 3000, Lat: 7.14, Lon: -73.12, ElevM: 820},
	}
	ray := EvaluateRay(45, 1000, samples, false, 0)
	if ray.Collided {
		t.Fatalf("no debería colisionar: terreno (max 820) siempre bajo el origen (1000)")
	}
	if ray.DistanceM != 3000 {
		t.Errorf("DistanceM = %v, want 3000 (última muestra)", ray.DistanceM)
	}
	if ray.EndLat != 7.14 || ray.EndLon != -73.12 {
		t.Errorf("EndLat/EndLon deben ser los de la última muestra")
	}
}

func TestEvaluateRayCollidesAtFirstBlockingSample(t *testing.T) {
	samples := []Sample{
		{DistanceM: 1000, Lat: 7.12, Lon: -73.12, ElevM: 900},  // bajo el origen (1000), no bloquea
		{DistanceM: 2000, Lat: 7.13, Lon: -73.12, ElevM: 1500}, // sobre el origen, bloquea acá
		{DistanceM: 3000, Lat: 7.14, Lon: -73.12, ElevM: 2000}, // nunca se llega
	}
	ray := EvaluateRay(45, 1000, samples, false, 0)
	if !ray.Collided {
		t.Fatalf("debería colisionar en la muestra de 2000m (elev 1500 >= origen 1000)")
	}
	if ray.DistanceM != 2000 {
		t.Errorf("DistanceM = %v, want 2000 (primer punto que bloquea)", ray.DistanceM)
	}
	if ray.CollisionElevM != 1500 {
		t.Errorf("CollisionElevM = %v, want 1500", ray.CollisionElevM)
	}
}

func TestEvaluateRayCurvatureExtendsReach(t *testing.T) {
	// Un cerro de 1050m a 5000m bloquearía sin curvatura (origen 1000)
	// pero con curvatura activa la elevación efectiva baja por debajo
	// del origen y el rayo debe pasar de largo.
	samples := []Sample{
		{DistanceM: 5000, Lat: 7.15, Lon: -73.12, ElevM: 1050},
	}
	withoutCurvature := EvaluateRay(0, 1000, samples, false, 0)
	if !withoutCurvature.Collided {
		t.Fatalf("sin curvatura, 1050 >= 1000 debe colisionar")
	}

	withCurvature := EvaluateRay(0, 1000, samples, true, 0.13)
	drop := CurvatureDropM(5000, 0.13)
	if drop <= 50 {
		t.Fatalf("test mal calibrado: la caída (%v) debe superar el margen de 50m del cerro", drop)
	}
	if withCurvature.Collided {
		t.Errorf("con curvatura, la elevación efectiva (1050 - %.1f) debe quedar bajo el origen (1000)", drop)
	}
}

func TestEvaluateRayTruncatesAtDemCoverageGap(t *testing.T) {
	samples := []Sample{
		{DistanceM: 1000, Lat: 7.12, Lon: -73.12, ElevM: 900},
		{DistanceM: 2000, Lat: 7.13, Lon: -73.12, ElevM: demCoverageGapMarker},
		{DistanceM: 3000, Lat: 7.14, Lon: -73.12, ElevM: 2000},
	}
	ray := EvaluateRay(45, 1000, samples, false, 0)
	if ray.Collided {
		t.Fatalf("un punto fuera de cobertura DEM no es una colisión topográfica")
	}
	if ray.DistanceM != 2000 {
		t.Errorf("DistanceM = %v, want 2000 (el rayo se trunca donde empieza el hueco de cobertura)", ray.DistanceM)
	}
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/terrain/los/... -run TestEvaluateRay -v`
Expected: FAIL — `undefined: Sample`, `undefined: EvaluateRay`, `undefined: demCoverageGapMarker`

- [ ] **Step 3: Implementación mínima**

Crear `apps/api/internal/terrain/los/ray.go`:

```go
package los

import "math"

// demCoverageGapMarker marca, en Sample.ElevM, un punto fuera de
// cobertura del DEM (ver Simulator.fetchElevations) — NaN para que
// nunca se confunda con una elevación real válida en una comparación
// numérica.
var demCoverageGapMarker = math.NaN()

type Sample struct {
	DistanceM float64
	Lat       float64
	Lon       float64
	ElevM     float64
}

type Ray struct {
	AngleDeg       float64
	EndLat         float64
	EndLon         float64
	DistanceM      float64
	Collided       bool
	CollisionLat   float64
	CollisionLon   float64
	CollisionElevM float64
}

// EvaluateRay recorre samples en orden creciente de distancia y
// devuelve el primer punto donde el terreno alcanza o supera la altura
// de un rayo horizontal que sale del origen a originElevM (sin altura
// de destino: el objetivo es el primer obstáculo topográfico, no un
// enlace punto-a-punto con antena en ambos extremos). Con
// earthCurvature activo, la altura efectiva de cada muestra para
// comparar es ElevM - CurvatureDropM(distancia, refractionK): la Tierra
// "cae" bajo la línea recta a medida que crece la distancia, así que un
// terreno lejano necesita ser más alto para bloquear.
//
// Un ElevM == NaN marca un punto fuera de cobertura DEM — el rayo se
// trunca ahí (Collided=false, DistanceM = distancia de ese punto) sin
// tratarlo como colisión topográfica.
func EvaluateRay(angleDeg, originElevM float64, samples []Sample, earthCurvature bool, refractionK float64) Ray {
	for _, s := range samples {
		if math.IsNaN(s.ElevM) {
			return Ray{
				AngleDeg:  angleDeg,
				EndLat:    s.Lat,
				EndLon:    s.Lon,
				DistanceM: s.DistanceM,
				Collided:  false,
			}
		}

		effectiveElevM := s.ElevM
		if earthCurvature {
			effectiveElevM -= CurvatureDropM(s.DistanceM, refractionK)
		}

		if effectiveElevM >= originElevM {
			return Ray{
				AngleDeg:       angleDeg,
				EndLat:         s.Lat,
				EndLon:         s.Lon,
				DistanceM:      s.DistanceM,
				Collided:       true,
				CollisionLat:   s.Lat,
				CollisionLon:   s.Lon,
				CollisionElevM: s.ElevM,
			}
		}
	}

	last := samples[len(samples)-1]
	return Ray{
		AngleDeg:  angleDeg,
		EndLat:    last.Lat,
		EndLon:    last.Lon,
		DistanceM: last.DistanceM,
		Collided:  false,
	}
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `cd apps/api && go test ./internal/terrain/los/... -v`
Expected: PASS (geodesy + ray, todos los tests anteriores siguen en verde)

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/terrain/los/ray.go apps/api/internal/terrain/los/ray_test.go
git commit -m "feat(api): detección de colisión LOS por rayo horizontal"
```

---

### Task 4: Cliente HTTP del DEM (`ElevationProvider`)

**Files:**
- Create: `apps/api/internal/terrain/los/elevation.go`
- Test: `apps/api/internal/terrain/los/elevation_test.go`

**Interfaces:**
- Produces: `type ElevationProvider interface{ ElevationAt(ctx, lat, lon float64) (float64, error) }`,
  `type DemCoverageError struct{ Message string }`,
  `type DemUnavailableError struct{ Cause error }`,
  `NewHTTPElevationProvider(baseURL string) *HTTPElevationProvider`
  — usados por `Simulator` (Task 5) y `router.go` (Task 7).

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/api/internal/terrain/los/elevation_test.go`. Usa
`httptest.Server` para simular la API DEM real confirmada manualmente
(`POST /elevation` con `{"lat":..,"lon":..}` → `{"elevation":..}` en
200, o `{"error":"..."}` en 400 para puntos fuera de Colombia):

```go
package los

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPElevationProviderSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Lat, Lon float64 }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Lat != 4.6097 || body.Lon != -74.0817 {
			t.Errorf("body inesperado: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]float64{
			"elevation": 2581, "lat": body.Lat, "lon": body.Lon,
		})
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	elev, err := p.ElevationAt(context.Background(), 4.6097, -74.0817)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if elev != 2581 {
		t.Errorf("elev = %v, want 2581", elev)
	}
}

func TestHTTPElevationProviderCoverageError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "The point is not contained in the Colombia polygon.",
		})
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	_, err := p.ElevationAt(context.Background(), 0, 0)
	var coverageErr *DemCoverageError
	if !errors.As(err, &coverageErr) {
		t.Fatalf("esperaba *DemCoverageError, got %T: %v", err, err)
	}
}

func TestHTTPElevationProviderServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	_, err := p.ElevationAt(context.Background(), 4.6, -74.0)
	var unavailableErr *DemUnavailableError
	if !errors.As(err, &unavailableErr) {
		t.Fatalf("esperaba *DemUnavailableError, got %T: %v", err, err)
	}
}

func TestHTTPElevationProviderConnectionRefused(t *testing.T) {
	p := NewHTTPElevationProvider("http://127.0.0.1:1") // puerto que nadie escucha
	_, err := p.ElevationAt(context.Background(), 4.6, -74.0)
	var unavailableErr *DemUnavailableError
	if !errors.As(err, &unavailableErr) {
		t.Fatalf("esperaba *DemUnavailableError, got %T: %v", err, err)
	}
}
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/terrain/los/... -run TestHTTPElevationProvider -v`
Expected: FAIL — `undefined: NewHTTPElevationProvider`, `undefined: DemCoverageError`, `undefined: DemUnavailableError`

- [ ] **Step 3: Implementación mínima**

Crear `apps/api/internal/terrain/los/elevation.go`:

```go
package los

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ElevationProvider resuelve la elevación (msnm) de un punto. Interfaz
// separada de HTTPElevationProvider para poder inyectar un fake en
// tests de Simulator/handler sin levantar un servidor HTTP real.
type ElevationProvider interface {
	ElevationAt(ctx context.Context, lat, lon float64) (float64, error)
}

// DemCoverageError: el DEM respondió que el punto está fuera de su área
// de cobertura (confirmado contra la API real: 400 con
// {"error":"The point is not contained in the Colombia polygon."}).
type DemCoverageError struct{ Message string }

func (e *DemCoverageError) Error() string { return e.Message }

// DemUnavailableError: el servicio DEM no respondió (red caída,
// timeout, 5xx) — distinto de "punto sin datos".
type DemUnavailableError struct{ Cause error }

func (e *DemUnavailableError) Error() string {
	return fmt.Sprintf("DEM backend no disponible: %v", e.Cause)
}
func (e *DemUnavailableError) Unwrap() error { return e.Cause }

type HTTPElevationProvider struct {
	BaseURL string
	Client  *http.Client
}

func NewHTTPElevationProvider(baseURL string) *HTTPElevationProvider {
	return &HTTPElevationProvider{
		BaseURL: baseURL,
		Client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: maxConcurrentElevationRequests,
			},
		},
	}
}

type elevationRequestBody struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type elevationResponseBody struct {
	Elevation float64 `json:"elevation"`
}

type elevationErrorBody struct {
	Error string `json:"error"`
}

func (p *HTTPElevationProvider) ElevationAt(ctx context.Context, lat, lon float64) (float64, error) {
	payload, err := json.Marshal(elevationRequestBody{Lat: lat, Lon: lon})
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/elevation", bytes.NewReader(payload))
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := p.Client.Do(req)
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusOK {
		var body elevationResponseBody
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			return 0, &DemUnavailableError{Cause: err}
		}
		return body.Elevation, nil
	}

	var errBody elevationErrorBody
	_ = json.NewDecoder(res.Body).Decode(&errBody)
	if errBody.Error == "" {
		errBody.Error = fmt.Sprintf("DEM respondió %d", res.StatusCode)
	}

	if res.StatusCode == http.StatusBadRequest {
		return 0, &DemCoverageError{Message: errBody.Error}
	}
	return 0, &DemUnavailableError{Cause: fmt.Errorf("%s (status %d)", errBody.Error, res.StatusCode)}
}
```

`maxConcurrentElevationRequests` se define en `simulator.go` (Task 5,
escrito a continuación) — este archivo lo referencia pero Go resuelve
constantes de paquete sin importar el orden de archivos, así que no
rompe la compilación aunque `simulator.go` no exista todavía... **salvo
que**: para que este Task compile de forma aislada antes del Task 5,
agregar la constante acá mismo:

```go
// al final de elevation.go
const maxConcurrentElevationRequests = 24
```

(Task 5 la reutiliza, no la redefine.)

- [ ] **Step 4: Correr y verificar que pasa**

Run: `cd apps/api && go test ./internal/terrain/los/... -v`
Expected: PASS — incluye los tests con servidor real fallando por
conexión rechazada (`TestHTTPElevationProviderConnectionRefused` no
depende de red externa, solo de que nadie escuche el puerto 1 en
localhost).

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/terrain/los/elevation.go apps/api/internal/terrain/los/elevation_test.go
git commit -m "feat(api): cliente HTTP del DEM con manejo de cobertura y disponibilidad"
```

---

### Task 5: Simulador — generación de rayos, pool de concurrencia, ensamblado de respuesta

**Files:**
- Create: `apps/api/internal/terrain/los/simulator.go`
- Test: `apps/api/internal/terrain/los/simulator_test.go`

**Interfaces:**
- Consumes: `Destination`, `CurvatureDropM` (Task 2), `Sample`, `Ray`,
  `EvaluateRay` (Task 3), `ElevationProvider`, `DemCoverageError`,
  `DemUnavailableError` (Task 4).
- Produces: `type SimulationInput struct{...}`,
  `type Metadata struct{...}`, `type Response struct{ Rays []Ray; Metadata Metadata }`,
  `const MaxTotalSamples = 8000`,
  `type Simulator struct{ Elevation ElevationProvider; DemSourceLabel string; DemResolutionM float64 }`
  con método `Run(ctx, in SimulationInput) (*Response, error)`
  — usados por `ValidateRequest` (Task 6) y el handler (Task 7).

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/api/internal/terrain/los/simulator_test.go`. Usa un
`ElevationProvider` fake (función) para no depender de red:

```go
package los

import (
	"context"
	"errors"
	"testing"
)

type fakeElevationProvider struct {
	// elevAt devuelve la elevación para (lat, lon); por defecto un
	// terreno plano a 500m si no hay entrada específica.
	elevAt func(lat, lon float64) (float64, error)
	calls  int
}

func (f *fakeElevationProvider) ElevationAt(_ context.Context, lat, lon float64) (float64, error) {
	f.calls++
	if f.elevAt != nil {
		return f.elevAt(lat, lon)
	}
	return 500, nil
}

func TestSimulatorRunFlatTerrainNeverCollides(t *testing.T) {
	fake := &fakeElevationProvider{elevAt: func(lat, lon float64) (float64, error) { return 500, nil }}
	sim := &Simulator{Elevation: fake, DemSourceLabel: "test-dem", DemResolutionM: 30}

	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 30,
		AngleStepDeg: 90, MaxDistanceM: 1000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 4 { // 360/90
		t.Fatalf("len(Rays) = %d, want 4", len(resp.Rays))
	}
	for _, ray := range resp.Rays {
		if ray.Collided {
			t.Errorf("rayo a %v° no debería colisionar contra terreno plano bajo el origen", ray.AngleDeg)
		}
		if ray.DistanceM != 1000 {
			t.Errorf("rayo a %v°: DistanceM = %v, want 1000", ray.AngleDeg, ray.DistanceM)
		}
	}
	if resp.Metadata.DemSource != "test-dem" {
		t.Errorf("Metadata.DemSource = %v, want test-dem", resp.Metadata.DemSource)
	}
}

func TestSimulatorRunOriginOutOfCoverageFails(t *testing.T) {
	fake := &fakeElevationProvider{
		elevAt: func(lat, lon float64) (float64, error) {
			return 0, &DemCoverageError{Message: "fuera de cobertura"}
		},
	}
	sim := &Simulator{Elevation: fake}
	in := SimulationInput{
		OriginLat: 0, OriginLon: 0, AngleStepDeg: 90,
		MaxDistanceM: 500, SampleStepM: 500, EarthCurvature: false, RefractionK: 0.13,
	}
	_, err := sim.Run(context.Background(), in)
	var coverageErr *DemCoverageError
	if !errors.As(err, &coverageErr) {
		t.Fatalf("esperaba *DemCoverageError cuando el ORIGEN está fuera de cobertura, got %v", err)
	}
}

func TestSimulatorRunPartialCoverageTruncatesOnlyAffectedRay(t *testing.T) {
	// El origen y todo punto con lon <= -73.2 tienen cobertura; más allá
	// (lon > -73.2) simula "fuera de Colombia". Con azimuth 90 (este),
	// Destination incrementa lon con la distancia, así que ese rayo
	// específico se queda sin cobertura antes de llegar a max_distance_m.
	fake := &fakeElevationProvider{
		elevAt: func(lat, lon float64) (float64, error) {
			if lon > -73.2 {
				return 0, &DemCoverageError{Message: "fuera de cobertura"}
			}
			return 500, nil
		},
	}
	sim := &Simulator{Elevation: fake}
	in := SimulationInput{
		OriginLat: 0, OriginLon: -73.21, OriginHeightM: 10,
		AngleStepDeg: 180, MaxDistanceM: 20000, SampleStepM: 5000, // 2 rayos: 0° (norte) y 180° (sur)
		EarthCurvature: false, RefractionK: 0.13,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 2 {
		t.Fatalf("len(Rays) = %d, want 2", len(resp.Rays))
	}
	// Ninguno de los 2 rayos (norte/sur) cambia longitud significativamente,
	// así que ambos deben mantenerse dentro de cobertura y llegar a max_distance_m.
	for _, ray := range resp.Rays {
		if ray.Collided {
			t.Errorf("rayo a %v° no debería marcar colisión topográfica (era corte de cobertura o nada)", ray.AngleDeg)
		}
	}
}

func TestSimulatorRunAppliesOriginHeightAboveTerrain(t *testing.T) {
	// Origen sobre terreno a 500m, antena de 5m: originElevM=505.
	// Un "cerro" de 505m exactos a 500m de distancia debe bloquear.
	fake := &fakeElevationProvider{
		elevAt: func(lat, lon float64) (float64, error) {
			return 500, nil
		},
	}
	sim := &Simulator{Elevation: fake}
	in := SimulationInput{
		OriginLat: 7.0, OriginLon: -73.0, OriginHeightM: 5,
		AngleStepDeg: 360, MaxDistanceM: 500, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
	}
	resp, _ := sim.Run(context.Background(), in)
	if len(resp.Rays) != 1 {
		t.Fatalf("len(Rays) = %d, want 1 (angle_step_deg=360 → 1 rayo)", len(resp.Rays))
	}
	if !resp.Rays[0].Collided {
		t.Errorf("terreno a 500 == originElevM (500+5=505 > 500... en realidad terreno 500 < 505, no debería colisionar)")
	}
}
```

> Nota para quien implemente: el último test
> (`TestSimulatorRunAppliesOriginHeightAboveTerrain`) verifica el caso
> *no*-colisión (terreno 500 queda bajo origen 505) — el nombre del
> `t.Errorf` describe la aserción, no un resultado esperado de colisión.
> Si al correrlo falla, revisar que `OriginHeightM` se está sumando a la
> elevación del ORIGEN (no de cada muestra).

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/terrain/los/... -run TestSimulator -v`
Expected: FAIL — `undefined: Simulator`, `undefined: SimulationInput`

- [ ] **Step 3: Implementación mínima**

Crear `apps/api/internal/terrain/los/simulator.go`:

```go
package los

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// MaxTotalSamples acota rays * samples-por-rayo de una simulación. El
// DEM es una API HTTP de un solo punto (~15-20ms/llamada medido contra
// el servicio real) — sin este tope, defaults grandes de
// angle_step_deg/sample_step_m/max_distance_m tardarían decenas de
// segundos, incompatible con un endpoint síncrono. Ver ValidateRequest
// (models_validation.go) para el rechazo con 400 cuando se excede.
const MaxTotalSamples = 8000

// maxConcurrentElevationRequests: definida en elevation.go, reutilizada
// acá para el pool de goroutines que resuelve elevaciones en paralelo.

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

type Metadata struct {
	DemSource      string
	DemResolutionM float64
	ComputeMs      int64
}

type Response struct {
	Rays     []Ray
	Metadata Metadata
}

type Simulator struct {
	Elevation      ElevationProvider
	DemSourceLabel string
	DemResolutionM float64
}

type point struct{ lat, lon float64 }

func (s *Simulator) Run(ctx context.Context, in SimulationInput) (*Response, error) {
	start := time.Now()

	rayCount := int(math.Ceil(360 / in.AngleStepDeg))
	samplesPerRay := int(math.Ceil(in.MaxDistanceM / in.SampleStepM))

	distances := make([]float64, samplesPerRay)
	for j := 0; j < samplesPerRay; j++ {
		d := float64(j+1) * in.SampleStepM
		if d > in.MaxDistanceM {
			d = in.MaxDistanceM
		}
		distances[j] = d
	}

	angles := make([]float64, rayCount)
	// points[0] = origen; points[1+i*samplesPerRay+j] = muestra j del rayo i.
	points := make([]point, 1+rayCount*samplesPerRay)
	points[0] = point{in.OriginLat, in.OriginLon}
	for i := 0; i < rayCount; i++ {
		angle := float64(i) * in.AngleStepDeg
		angles[i] = angle
		for j := 0; j < samplesPerRay; j++ {
			lat, lon := Destination(in.OriginLat, in.OriginLon, angle, distances[j])
			points[1+i*samplesPerRay+j] = point{lat, lon}
		}
	}

	elevations, err := s.fetchElevations(ctx, points)
	if err != nil {
		return nil, err
	}

	originElevM := elevations[0] + in.OriginHeightM

	rays := make([]Ray, rayCount)
	for i := 0; i < rayCount; i++ {
		samples := make([]Sample, samplesPerRay)
		for j := 0; j < samplesPerRay; j++ {
			idx := 1 + i*samplesPerRay + j
			samples[j] = Sample{
				DistanceM: distances[j],
				Lat:       points[idx].lat,
				Lon:       points[idx].lon,
				ElevM:     elevations[idx],
			}
		}
		rays[i] = EvaluateRay(angles[i], originElevM, samples, in.EarthCurvature, in.RefractionK)
	}

	return &Response{
		Rays: rays,
		Metadata: Metadata{
			DemSource:      s.DemSourceLabel,
			DemResolutionM: s.DemResolutionM,
			ComputeMs:      time.Since(start).Milliseconds(),
		},
	}, nil
}

// fetchElevations resuelve todos los puntos en paralelo, acotado a
// maxConcurrentElevationRequests llamadas simultáneas (evita saturar el
// DEM de un solo punto con miles de goroutines a la vez). points[0] es
// siempre el origen: un error ahí (de cobertura o de disponibilidad)
// aborta toda la simulación. Un DemCoverageError en un punto que NO es
// el origen no aborta nada — se marca con NaN para que EvaluateRay
// trunque ese rayo puntual ahí. Un DemUnavailableError en cualquier
// punto sí aborta toda la simulación (el DEM está caído, reintentar no
// tiene sentido a mitad de un sweep).
func (s *Simulator) fetchElevations(ctx context.Context, points []point) ([]float64, error) {
	elevations := make([]float64, len(points))
	errs := make([]error, len(points))

	sem := make(chan struct{}, maxConcurrentElevationRequests)
	var wg sync.WaitGroup
	for i, p := range points {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, p point) {
			defer wg.Done()
			defer func() { <-sem }()
			elev, err := s.Elevation.ElevationAt(ctx, p.lat, p.lon)
			elevations[i] = elev
			errs[i] = err
		}(i, p)
	}
	wg.Wait()

	if errs[0] != nil {
		return nil, fmt.Errorf("origen: %w", errs[0])
	}

	for i, err := range errs {
		if err == nil {
			continue
		}
		var unavailableErr *DemUnavailableError
		if errors.As(err, &unavailableErr) {
			return nil, err
		}
		// DemCoverageError en un punto intermedio: truncar ese rayo ahí.
		elevations[i] = demCoverageGapMarker
	}
	return elevations, nil
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `cd apps/api && go test ./internal/terrain/los/... -v`
Expected: PASS (todos los tests del paquete `los`: geodesy, ray,
elevation, simulator)

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/terrain/los/simulator.go apps/api/internal/terrain/los/simulator_test.go
git commit -m "feat(api): simulador LOS radial con pool de concurrencia acotado"
```

---

### Task 6: DTOs de request/response + validación (tope de muestreo incluido)

**Files:**
- Modify: `apps/api/internal/models/models.go`
- Create: `apps/api/internal/terrain/los/validate.go`
- Test: `apps/api/internal/terrain/los/validate_test.go`

**Interfaces:**
- Consumes: `MaxTotalSamples`, `SimulationInput` (Task 5).
- Produces: `models.RadialSimulationRequest`, `models.RadialSimulationRay`,
  `models.RadialSimulationMetadata`, `models.RadialSimulationResponse`,
  `los.ValidateRequest(req models.RadialSimulationRequest) (SimulationInput, error)`
  — usados por el handler (Task 7).

- [ ] **Step 1: Agregar los DTOs a `models.go`**

Agregar al final de `apps/api/internal/models/models.go` (no tocar el
resto del archivo):

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

type RadialSimulationRay struct {
	AngleDeg       float64 `json:"angle_deg"`
	EndLat         float64 `json:"end_lat"`
	EndLon         float64 `json:"end_lon"`
	DistanceM      float64 `json:"distance_m"`
	Collided       bool    `json:"collided"`
	CollisionLat   float64 `json:"collision_lat"`
	CollisionLon   float64 `json:"collision_lon"`
	CollisionElevM float64 `json:"collision_elev_m"`
}

type RadialSimulationMetadata struct {
	DemSource      string  `json:"dem_source"`
	DemResolutionM float64 `json:"dem_resolution_m"`
	ComputeMs      int64   `json:"compute_ms"`
}

type RadialSimulationResponse struct {
	Rays     []RadialSimulationRay    `json:"rays"`
	Metadata RadialSimulationMetadata `json:"metadata"`
}
```

Se usan punteros en el request (mismo patrón que `CreateReportInput.Lat`)
para distinguir "campo ausente" de "campo en 0" — necesario porque
`origin_lat`/`origin_lon` pueden ser legítimamente 0 en teoría, y varios
campos tienen default de sistema si se omiten (`origin_height_m=0`,
`earth_curvature=true`, `refraction_k=0.13`).

`collision_lat`/`collision_lon`/`collision_elev_m` se serializan siempre
(sin `omitempty`) — en 0 cuando `collided=false`. Es una simplificación
deliberada del MVP frente al ejemplo del spec (que solo muestra el caso
`collided:true`); documentarlo así evita ambigüedad para el frontend.

- [ ] **Step 2: Escribir el test de validación que falla**

Crear `apps/api/internal/terrain/los/validate_test.go`:

```go
package los

import (
	"testing"

	"meshcore-map/api/internal/models"
)

func f(v float64) *float64 { return &v }
func b(v bool) *bool       { return &v }

func validRequest() models.RadialSimulationRequest {
	return models.RadialSimulationRequest{
		OriginLat: f(7.1193), OriginLon: f(-73.1227),
		AngleStepDeg: f(5), MaxDistanceM: f(8000), SampleStepM: f(100),
	}
}

func TestValidateRequestDefaultsApplied(t *testing.T) {
	in, err := ValidateRequest(validRequest())
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if in.RefractionK != 0.13 {
		t.Errorf("RefractionK default = %v, want 0.13", in.RefractionK)
	}
	if !in.EarthCurvature {
		t.Errorf("EarthCurvature default = %v, want true", in.EarthCurvature)
	}
	if in.OriginHeightM != 0 {
		t.Errorf("OriginHeightM default = %v, want 0", in.OriginHeightM)
	}
}

func TestValidateRequestMissingRequiredField(t *testing.T) {
	req := validRequest()
	req.OriginLat = nil
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con origin_lat ausente")
	}
}

func TestValidateRequestOutOfRangeLat(t *testing.T) {
	req := validRequest()
	req.OriginLat = f(91)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con origin_lat fuera de [-90, 90]")
	}
}

func TestValidateRequestAngleStepOutOfRange(t *testing.T) {
	req := validRequest()
	req.AngleStepDeg = f(46)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con angle_step_deg fuera de (0, 45]")
	}
}

func TestValidateRequestSampleBudgetExceeded(t *testing.T) {
	req := validRequest()
	// 360 rayos (angle_step_deg=1) x 3000 muestras (max_distance_m=15000, sample_step_m=5)
	// = 1 080 000, muy por encima de MaxTotalSamples.
	req.AngleStepDeg = f(1)
	req.MaxDistanceM = f(15000)
	req.SampleStepM = f(5)
	_, err := ValidateRequest(req)
	if err == nil {
		t.Fatal("esperaba error de presupuesto de muestreo excedido")
	}
}

func TestValidateRequestAtBudgetLimitPasses(t *testing.T) {
	req := validRequest() // 72 rayos x 80 muestras = 5760 <= 8000
	if _, err := ValidateRequest(req); err != nil {
		t.Fatalf("request dentro del presupuesto no debería fallar: %v", err)
	}
}

func TestValidateRequestRefractionKOutOfRange(t *testing.T) {
	req := validRequest()
	req.RefractionK = f(0.9)
	if _, err := ValidateRequest(req); err == nil {
		t.Fatal("esperaba error con refraction_k fuera de [0, 0.5]")
	}
}
```

- [ ] **Step 3: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/terrain/los/... -run TestValidateRequest -v`
Expected: FAIL — `undefined: ValidateRequest`

- [ ] **Step 4: Implementación mínima**

Crear `apps/api/internal/terrain/los/validate.go`:

```go
package los

import (
	"fmt"
	"math"

	"meshcore-map/api/internal/models"
)

const defaultRefractionK = 0.13

// ValidateRequest normaliza models.RadialSimulationRequest (DTO con
// punteros, para distinguir "ausente" de "cero") a SimulationInput
// (valores concretos), aplicando los rangos de la sección 5.3 del spec
// kit y el tope de MaxTotalSamples (ver simulator.go, Decisión de
// diseño 2 del plan).
func ValidateRequest(req models.RadialSimulationRequest) (SimulationInput, error) {
	if req.OriginLat == nil || req.OriginLon == nil || req.AngleStepDeg == nil ||
		req.MaxDistanceM == nil || req.SampleStepM == nil {
		return SimulationInput{}, fmt.Errorf(
			"origin_lat, origin_lon, angle_step_deg, max_distance_m y sample_step_m son obligatorios",
		)
	}

	lat, lon := *req.OriginLat, *req.OriginLon
	angleStep, maxDist, sampleStep := *req.AngleStepDeg, *req.MaxDistanceM, *req.SampleStepM

	if lat < -90 || lat > 90 {
		return SimulationInput{}, fmt.Errorf("origin_lat debe estar en [-90, 90]")
	}
	if lon < -180 || lon > 180 {
		return SimulationInput{}, fmt.Errorf("origin_lon debe estar en [-180, 180]")
	}
	if angleStep <= 0 || angleStep > 45 {
		return SimulationInput{}, fmt.Errorf("angle_step_deg debe estar en (0, 45]")
	}
	if maxDist < 100 || maxDist > 100000 {
		return SimulationInput{}, fmt.Errorf("max_distance_m debe estar en [100, 100000]")
	}
	if sampleStep < 5 || sampleStep > 250 {
		return SimulationInput{}, fmt.Errorf("sample_step_m debe estar en [5, 250]")
	}

	heightM := 0.0
	if req.OriginHeightM != nil {
		heightM = *req.OriginHeightM
	}
	if heightM < 0 || heightM > 9000 {
		return SimulationInput{}, fmt.Errorf("origin_height_m debe estar en [0, 9000]")
	}

	refractionK := defaultRefractionK
	if req.RefractionK != nil {
		refractionK = *req.RefractionK
	}
	if refractionK < 0 || refractionK > 0.5 {
		return SimulationInput{}, fmt.Errorf("refraction_k debe estar en [0, 0.5]")
	}

	earthCurvature := true
	if req.EarthCurvature != nil {
		earthCurvature = *req.EarthCurvature
	}

	rayCount := int(math.Ceil(360 / angleStep))
	samplesPerRay := int(math.Ceil(maxDist / sampleStep))
	total := rayCount * samplesPerRay
	if total > MaxTotalSamples {
		return SimulationInput{}, fmt.Errorf(
			"angle_step_deg=%.2f, max_distance_m=%.0f y sample_step_m=%.0f implican %d muestras (%d rayos x %d por rayo), por encima del tope de %d — aumentá angle_step_deg/sample_step_m o reducí max_distance_m",
			angleStep, maxDist, sampleStep, total, rayCount, samplesPerRay, MaxTotalSamples,
		)
	}

	return SimulationInput{
		OriginLat: lat, OriginLon: lon, OriginHeightM: heightM,
		AngleStepDeg: angleStep, MaxDistanceM: maxDist, SampleStepM: sampleStep,
		EarthCurvature: earthCurvature, RefractionK: refractionK,
	}, nil
}
```

- [ ] **Step 5: Correr y verificar que pasa**

Run: `cd apps/api && go test ./internal/terrain/los/... -v`
Expected: PASS (todo el paquete `los`)

- [ ] **Step 6: Commit**

```bash
git add apps/api/internal/models/models.go apps/api/internal/terrain/los/validate.go apps/api/internal/terrain/los/validate_test.go
git commit -m "feat(api): DTOs y validación de simulación LOS radial con tope de muestreo"
```

---

### Task 7: Handler HTTP + registro de ruta

**Files:**
- Create: `apps/api/internal/handlers/simulation_handler.go`
- Test: `apps/api/internal/handlers/simulation_handler_test.go`
- Modify: `apps/api/internal/router/router.go`

**Interfaces:**
- Consumes: `models.RadialSimulationRequest/Response` (Task 6),
  `los.ValidateRequest`, `los.Simulator`, `los.ElevationProvider`,
  `los.DemCoverageError`, `los.DemUnavailableError` (Tasks 4-6),
  `config.Config.DemAPIURL/DemSourceLabel/DemResolutionM` (Task 1).
- Produces: `SimulationHandler.Radial(c *gin.Context)` registrado en
  `POST /api/v1/simulations/radial`.

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/api/internal/handlers/simulation_handler_test.go`. Reutiliza
un `ElevationProvider` fake local (no exportado desde `los`, se define
acá mismo) para no depender de red real:

```go
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/models"
	"meshcore-map/api/internal/terrain/los"
)

type fakeElevation struct {
	elev float64
	err  error
}

func (f *fakeElevation) ElevationAt(_ context.Context, lat, lon float64) (float64, error) {
	return f.elev, f.err
}

func setupSimulationRouter(h *SimulationHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/v1/simulations/radial", h.Radial)
	return r
}

func TestRadialSimulationSuccess(t *testing.T) {
	h := &SimulationHandler{
		Elevation:      &fakeElevation{elev: 500},
		DemSourceLabel: "test-dem",
		DemResolutionM: 30,
	}
	r := setupSimulationRouter(h)

	body, _ := json.Marshal(models.RadialSimulationRequest{
		OriginLat: ptr(7.1193), OriginLon: ptr(-73.1227),
		AngleStepDeg: ptr(90.0), MaxDistanceM: ptr(1000.0), SampleStepM: ptr(500.0),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/simulations/radial", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp models.RadialSimulationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("respuesta inválida: %v", err)
	}
	if len(resp.Rays) != 4 {
		t.Errorf("len(Rays) = %d, want 4", len(resp.Rays))
	}
	if resp.Metadata.DemSource != "test-dem" {
		t.Errorf("Metadata.DemSource = %v, want test-dem", resp.Metadata.DemSource)
	}
}

func TestRadialSimulationValidationError(t *testing.T) {
	h := &SimulationHandler{Elevation: &fakeElevation{elev: 500}}
	r := setupSimulationRouter(h)

	body, _ := json.Marshal(models.RadialSimulationRequest{
		OriginLat: ptr(999.0), OriginLon: ptr(-73.1227), // lat inválida
		AngleStepDeg: ptr(5.0), MaxDistanceM: ptr(8000.0), SampleStepM: ptr(100.0),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/simulations/radial", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestRadialSimulationDemCoverageError(t *testing.T) {
	h := &SimulationHandler{
		Elevation: &fakeElevation{err: &los.DemCoverageError{Message: "fuera de cobertura"}},
	}
	r := setupSimulationRouter(h)

	body, _ := json.Marshal(models.RadialSimulationRequest{
		OriginLat: ptr(0.0), OriginLon: ptr(0.0),
		AngleStepDeg: ptr(90.0), MaxDistanceM: ptr(1000.0), SampleStepM: ptr(500.0),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/simulations/radial", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422, body = %s", w.Code, w.Body.String())
	}
	var errResp map[string]string
	json.Unmarshal(w.Body.Bytes(), &errResp)
	if errResp["error"] != "dem_coverage_insufficient" {
		t.Errorf(`error = %q, want "dem_coverage_insufficient"`, errResp["error"])
	}
}

func ptr(v float64) *float64 { return &v }
```

`los.DemCoverageError` (Task 4) se usa directamente como el error que
devuelve el `ElevationProvider` fake — el `errors.As` del handler
(Task 7 Step 3) lo reconoce porque es el tipo real, no un doble de test.

- [ ] **Step 2: Correr y verificar que falla**

Run: `cd apps/api && go test ./internal/handlers/... -run TestRadialSimulation -v`
Expected: FAIL — `undefined: SimulationHandler`

- [ ] **Step 3: Implementación mínima**

Crear `apps/api/internal/handlers/simulation_handler.go`:

```go
package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/models"
	"meshcore-map/api/internal/terrain/los"
)

type SimulationHandler struct {
	Elevation      los.ElevationProvider
	DemSourceLabel string
	DemResolutionM float64
}

// Radial implementa POST /api/v1/simulations/radial (spec kit sección
// 5). Sin auth (mismo criterio que GET /cells: visualización de solo
// lectura/cómputo, no toca datos persistidos) pero con rate limit
// dedicado más estricto en router.go por el costo de cada llamada al DEM.
func (h *SimulationHandler) Radial(c *gin.Context) {
	var in models.RadialSimulationRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	simInput, err := los.ValidateRequest(in)
	if err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	sim := &los.Simulator{
		Elevation:      h.Elevation,
		DemSourceLabel: h.DemSourceLabel,
		DemResolutionM: h.DemResolutionM,
	}

	result, err := sim.Run(c.Request.Context(), simInput)
	if err != nil {
		var coverageErr *los.DemCoverageError
		var unavailableErr *los.DemUnavailableError
		switch {
		case errors.As(err, &coverageErr):
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error": "dem_coverage_insufficient", "message": coverageErr.Message,
			})
		case errors.As(err, &unavailableErr):
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "dem_backend_unavailable", "message": unavailableErr.Error(),
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "simulation_failed", "message": err.Error(),
			})
		}
		return
	}

	rays := make([]models.RadialSimulationRay, len(result.Rays))
	for i, r := range result.Rays {
		rays[i] = models.RadialSimulationRay{
			AngleDeg: r.AngleDeg, EndLat: r.EndLat, EndLon: r.EndLon,
			DistanceM: r.DistanceM, Collided: r.Collided,
			CollisionLat: r.CollisionLat, CollisionLon: r.CollisionLon,
			CollisionElevM: r.CollisionElevM,
		}
	}

	c.JSON(http.StatusOK, models.RadialSimulationResponse{
		Rays: rays,
		Metadata: models.RadialSimulationMetadata{
			DemSource: result.Metadata.DemSource, DemResolutionM: result.Metadata.DemResolutionM,
			ComputeMs: result.Metadata.ComputeMs,
		},
	})
}
```

- [ ] **Step 4: Correr y verificar que el handler pasa**

Run: `cd apps/api && go test ./internal/handlers/... -run TestRadialSimulation -v`
Expected: PASS

- [ ] **Step 5: Registrar la ruta en `router.go`**

En `apps/api/internal/router/router.go`, agregar el import y el wiring.
Reemplazar:

```go
	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/handlers"
	"meshcore-map/api/internal/middleware"
)
```

por:

```go
	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/handlers"
	"meshcore-map/api/internal/middleware"
	"meshcore-map/api/internal/terrain/los"
)
```

Reemplazar:

```go
	inviteH := &handlers.InviteHandler{DB: db}
```

por:

```go
	inviteH := &handlers.InviteHandler{DB: db}
	simH := &handlers.SimulationHandler{
		Elevation:      los.NewHTTPElevationProvider(cfg.DemAPIURL),
		DemSourceLabel: cfg.DemSourceLabel,
		DemResolutionM: cfg.DemResolutionM,
	}
```

Reemplazar:

```go
		v1.GET("/cells", cellH.List)
		v1.GET("/cells/:h3_index/origins", cellH.Origins)
```

por:

```go
		v1.GET("/cells", cellH.List)
		v1.GET("/cells/:h3_index/origins", cellH.Origins)
		v1.POST("/simulations/radial", middleware.RateLimit(middleware.PerHour(30), 5), simH.Radial)
```

- [ ] **Step 6: Verificar que todo compila y los tests siguen pasando**

Run: `cd apps/api && go build ./... && go vet ./... && go test ./...`
Expected: sin errores, todos los tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/internal/handlers/simulation_handler.go apps/api/internal/handlers/simulation_handler_test.go apps/api/internal/router/router.go
git commit -m "feat(api): endpoint POST /api/v1/simulations/radial"
```

---

### Task 8: Verificación manual del backend contra el DEM real

**Files:** ninguno (solo verificación)

- [ ] **Step 1: Levantar el backend con el DEM real ya corriendo en :8000**

Run:
```bash
cd apps/api
DB_PATH=./meshcore.db DEM_API_URL=http://localhost:8000 go run ./cmd/api
```

- [ ] **Step 2: Simulación válida contra un punto real de Santander**

Run (en otra terminal):
```bash
curl -s -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{
    "origin_lat": 7.1193, "origin_lon": -73.1227, "origin_height_m": 15,
    "angle_step_deg": 5, "max_distance_m": 8000, "sample_step_m": 100,
    "earth_curvature": true, "refraction_k": 0.13
  }' | python3 -m json.tool | head -40
```
Expected: `200`, `rays` con 72 elementos, `metadata.compute_ms` en el
orden de unos pocos segundos (no minutos) — si tarda más de ~10s, medir
si es la latencia real del DEM o un bug del pool de concurrencia.

- [ ] **Step 3: Origen fuera de cobertura (fuera de Colombia)**

Run:
```bash
curl -s -w '\n%{http_code}\n' -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{"origin_lat":0,"origin_lon":0,"angle_step_deg":90,"max_distance_m":1000,"sample_step_m":500}'
```
Expected: `422` con `{"error":"dem_coverage_insufficient", ...}`

- [ ] **Step 4: Presupuesto de muestreo excedido**

Run:
```bash
curl -s -w '\n%{http_code}\n' -X POST http://localhost:8080/api/v1/simulations/radial \
  -H "Content-Type: application/json" \
  -d '{"origin_lat":7.1193,"origin_lon":-73.1227,"angle_step_deg":1,"max_distance_m":15000,"sample_step_m":5}'
```
Expected: `400` con mensaje mencionando el tope de `MaxTotalSamples`

No hay commit en este task (solo verificación).

---

## Frontend

### Task 9: Cliente API — tipos y función `simulateRadialLOS`

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Produces: `RadialSimulationRequest`, `RadialSimulationRay`,
  `RadialSimulationResponse` (tipos), `simulateRadialLOS(input)` —
  usados por `map/radialSimulation.ts` (Task 10).

- [ ] **Step 1: Agregar al final de `apps/web/src/lib/api.ts`**

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

export interface RadialSimulationRay {
  angle_deg: number;
  end_lat: number;
  end_lon: number;
  distance_m: number;
  collided: boolean;
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
  };
}

// Endpoint público (sin JWT), igual que getCells — visualización de
// solo lectura/cómputo, ver spec kit docs/superpowers/specs/2026-07-22-radial-los-spec-kit.md.
export function simulateRadialLOS(input: RadialSimulationRequest): Promise<RadialSimulationResponse> {
  return apiFetch('/api/v1/simulations/radial', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
```

- [ ] **Step 2: Verificar que Astro sigue compilando**

Run: `cd apps/web && npm run build`
Expected: build exitoso, sin errores de TypeScript.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): cliente API para simulación LOS radial"
```

---

### Task 10: Capa Leaflet — dibujo de rayos y selección de origen

**Files:**
- Modify: `apps/web/src/lib/map/setup.ts`
- Create: `apps/web/src/lib/map/radialSimulation.ts`

**Interfaces:**
- Consumes: `map`, capas existentes (`setup.ts`); `simulateRadialLOS`,
  `RadialSimulationRequest`, `RadialSimulationResponse` (Task 9);
  `showToast` (`toast.ts`, ya existe).
- Produces: `radialLayer` (capa nueva), `enableOriginPicking(callback)`,
  `runRadialSimulation(input)`, `clearRadialSimulation()` — usados por
  `mapPage.ts`/`index.astro` (Task 11).

- [ ] **Step 1: Agregar la capa nueva en `setup.ts`**

Al final de `apps/web/src/lib/map/setup.ts`, agregar:

```ts
export const radialLayer = L.layerGroup().addTo(map);
```

- [ ] **Step 2: Crear `apps/web/src/lib/map/radialSimulation.ts`**

```ts
import L from 'leaflet';
import { simulateRadialLOS } from '../api.ts';
import type { RadialSimulationRequest, RadialSimulationResponse } from '../api.ts';
import { showToast } from '../toast.ts';
import { map, radialLayer } from './setup.ts';

const COLOR_COLLIDED = '#e74c3c';
const COLOR_CLEAR = '#2ecc71';

let originMarker: L.CircleMarker | null = null;
let pickingOrigin = false;
let onOriginPicked: ((lat: number, lon: number) => void) | null = null;

// Activa el modo "elegir origen": el próximo click sobre el mapa fija
// el punto de origen de la simulación y llama callback(lat, lon) — el
// panel de parámetros (index.astro) usa esto para llenar los campos
// lat/lon sin que el usuario tenga que tipearlos a mano.
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

function setOriginMarker(lat: number, lon: number) {
  if (originMarker) {
    originMarker.setLatLng([lat, lon]);
  } else {
    originMarker = L.circleMarker([lat, lon], {
      radius: 6,
      color: '#34d7c0',
      fillColor: '#34d7c0',
      fillOpacity: 0.9,
    }).addTo(radialLayer);
  }
}

export async function runRadialSimulation(input: RadialSimulationRequest) {
  try {
    const result = await simulateRadialLOS(input);
    drawRays(input.origin_lat, input.origin_lon, result);
  } catch (err) {
    console.error('Error simulando LOS radial:', err);
    showToast(err instanceof Error ? err.message : 'Error simulando LOS radial', 'error');
  }
}

function drawRays(originLat: number, originLon: number, result: RadialSimulationResponse) {
  // Limpia solo los rayos previos; el marcador de origen se conserva
  // (se reposiciona más abajo) para no perder de vista dónde se está
  // parado entre una simulación y la siguiente.
  const toRemove: L.Layer[] = [];
  radialLayer.eachLayer((layer) => {
    if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) toRemove.push(layer);
  });
  toRemove.forEach((layer) => radialLayer.removeLayer(layer));

  setOriginMarker(originLat, originLon);

  for (const ray of result.rays) {
    L.polyline(
      [
        [originLat, originLon],
        [ray.end_lat, ray.end_lon],
      ],
      { color: ray.collided ? COLOR_COLLIDED : COLOR_CLEAR, weight: 1.5, opacity: 0.75 }
    ).addTo(radialLayer);
  }
}

export function clearRadialSimulation() {
  radialLayer.clearLayers();
  originMarker = null;
}
```

`L.CircleMarker` extiende `L.Circle`/`L.Path`, no `L.Polyline` —
`instanceof L.Polyline` en `drawRays` no lo captura, así que el filtro
de "borrar solo rayos" no borra el marcador de origen por accidente.

- [ ] **Step 3: Verificar tipos (Astro build)**

Run: `cd apps/web && npm run build`
Expected: build exitoso.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/map/setup.ts apps/web/src/lib/map/radialSimulation.ts
git commit -m "feat(web): capa Leaflet para simulación LOS radial"
```

---

### Task 11: Panel de control UI en `index.astro`

**Files:**
- Modify: `apps/web/src/pages/index.astro`
- Modify: `apps/web/src/lib/mapPage.ts`
- Modify: `apps/web/src/styles/global.css`

**Interfaces:**
- Consumes: `enableOriginPicking`, `runRadialSimulation`,
  `clearRadialSimulation` (Task 10).

- [ ] **Step 1: Agregar el panel HTML en `index.astro`**

En `apps/web/src/pages/index.astro`, insertar el panel justo antes del
`<div class="legend">` existente:

```html
  <div class="radar-panel" id="radar-panel">
    <div class="radar-panel-title">Simulación LOS 360°</div>
    <button class="btn-sm btn-secondary" id="btn-pick-origin" type="button">Elegir origen en el mapa</button>
    <div class="radar-field">
      <label for="radar-origin">Origen</label>
      <span id="radar-origin">— clic en el mapa —</span>
    </div>
    <div class="radar-field">
      <label for="radar-height">Altura de antena (m)</label>
      <input type="number" id="radar-height" value="15" min="0" max="9000" step="1" />
    </div>
    <div class="radar-field">
      <label for="radar-angle-step">Paso angular (°)</label>
      <input type="number" id="radar-angle-step" value="5" min="1" max="45" step="1" />
    </div>
    <div class="radar-field">
      <label for="radar-max-distance">Distancia máx. (m)</label>
      <input type="number" id="radar-max-distance" value="8000" min="100" max="100000" step="100" />
    </div>
    <div class="radar-field">
      <label for="radar-sample-step">Paso de muestreo (m)</label>
      <input type="number" id="radar-sample-step" value="100" min="5" max="250" step="5" />
    </div>
    <div class="radar-panel-actions">
      <button class="btn-sm btn-secondary" id="btn-run-radial" type="button" disabled>Simular</button>
      <button class="btn-sm btn-danger" id="btn-clear-radial" type="button">Limpiar</button>
    </div>
  </div>

```

- [ ] **Step 2: Estilos en `global.css`**

Agregar después del bloque `.legend-swatch { ... }` en
`apps/web/src/styles/global.css`:

```css
/* HUD flotante de la simulación LOS radial — mismo lenguaje visual que
   .legend (fondo/borde/blur), del lado derecho para no competir con la
   leyenda de cobertura (izquierda) ni el control de capas de Leaflet
   (top-right, dentro del mapa, no del viewport). */
.radar-panel {
  position: absolute;
  z-index: 500;
  right: 0.9rem;
  top: 4.5rem;
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
  gap: 0.5rem;
}
.radar-panel-title {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text);
}
.radar-field {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.radar-field input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border-bright);
  border-radius: 4px;
  color: var(--text);
  padding: 0.3rem 0.4rem;
  font-size: 0.75rem;
}
.radar-panel-actions {
  display: flex;
  gap: 0.4rem;
}
.radar-panel-actions .btn-sm {
  flex: 1;
}
```

Si al verificar visualmente (Task 12) el panel se solapa con el control
de capas de Leaflet (top-right dentro de `#map`), ajustar `top`/`right`
acá — no es una decisión bloqueante, es un ajuste de píxeles.

- [ ] **Step 3: Wiring en `mapPage.ts`**

Agregar en `apps/web/src/lib/mapPage.ts`, después del import existente
de `showToast`:

```ts
import { enableOriginPicking, runRadialSimulation, clearRadialSimulation } from './map/radialSimulation.ts';
```

Y al final del archivo (después del bloque `if (isAdmin) { ... }`
existente), agregar:

```ts
// Panel de simulación LOS 360° — disponible para cualquier visitante,
// mismo criterio que el mapa público (GET /cells): visualización de
// solo lectura/cómputo, no requiere sesión.
let pickedOrigin: { lat: number; lon: number } | null = null;

const radarOriginLabel = document.getElementById('radar-origin')!;
const btnPickOrigin = document.getElementById('btn-pick-origin') as HTMLButtonElement;
const btnRunRadial = document.getElementById('btn-run-radial') as HTMLButtonElement;
const btnClearRadial = document.getElementById('btn-clear-radial') as HTMLButtonElement;

btnPickOrigin.addEventListener('click', () => {
  showToast('Hacé clic en el mapa para fijar el origen', 'info');
  enableOriginPicking((lat, lon) => {
    pickedOrigin = { lat, lon };
    radarOriginLabel.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    btnRunRadial.disabled = false;
  });
});

btnRunRadial.addEventListener('click', () => {
  if (!pickedOrigin) return;
  const heightM = Number((document.getElementById('radar-height') as HTMLInputElement).value);
  const angleStepDeg = Number((document.getElementById('radar-angle-step') as HTMLInputElement).value);
  const maxDistanceM = Number((document.getElementById('radar-max-distance') as HTMLInputElement).value);
  const sampleStepM = Number((document.getElementById('radar-sample-step') as HTMLInputElement).value);

  runRadialSimulation({
    origin_lat: pickedOrigin.lat,
    origin_lon: pickedOrigin.lon,
    origin_height_m: heightM,
    angle_step_deg: angleStepDeg,
    max_distance_m: maxDistanceM,
    sample_step_m: sampleStepM,
    earth_curvature: true,
  });
});

btnClearRadial.addEventListener('click', () => {
  clearRadialSimulation();
  pickedOrigin = null;
  radarOriginLabel.textContent = '— clic en el mapa —';
  btnRunRadial.disabled = true;
});
```

`showToast` acepta un tercer argumento de tipo — verificar en
`apps/web/src/lib/toast.ts` que `'info'` es un tipo válido (si solo
soporta `'error'`, usar el valor por defecto sin ese argumento).

- [ ] **Step 4: Verificar en navegador**

Run:
```bash
cd apps/api && DB_PATH=./meshcore.db DEM_API_URL=http://localhost:8000 go run ./cmd/api &
cd apps/web && npm run dev
```

Abrir `http://localhost:4321`, verificar:
1. El panel "Simulación LOS 360°" aparece sin solaparse con la leyenda
   ni el control de capas.
2. "Elegir origen en el mapa" + clic en el mapa → aparece un punto
   turquesa y las coordenadas se llenan.
3. "Simular" con los defaults → aparecen ~72 líneas radiales en rojo
   (colisión) o verde (alcance máximo) en unos pocos segundos.
4. "Limpiar" borra las líneas y el punto de origen.

Si el paso 3 tarda más de ~10s o falla, revisar Task 8 (verificación
backend) antes de asumir que el bug está en el frontend.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/src/lib/mapPage.ts apps/web/src/styles/global.css
git commit -m "feat(web): panel de control para simulación LOS radial"
```

---

## Self-Review (completado antes de entregar el plan)

**Cobertura del spec:**
- Endpoint + contrato request/response (5.1-5.4) → Tasks 6-7. ✓
- Reglas de validación (5.3) → Task 6 (`ValidateRequest`). ✓
- Errores API 400/422/429/500/503 (5.5) → Task 7 (`Radial` handler +
  `RateLimit` en router). ✓ (`429` lo cubre el middleware existente, no
  requiere código nuevo).
- Matriz de parámetros/límites (6) → Task 6. ✓
- Backend: paquete `terrain/los`, `Simulator.Run`, `ElevationProvider`
  (7.1) → Tasks 2-5. ✓
- Router/handler (7.2) → Task 7. ✓
- Frontend: capa `radialLayer`, UI de parámetros, colores diferenciados
  (7.3) → Tasks 9-11. ✓
- Decisión de `z` (10.1) → resuelta y documentada arriba, aplicada en
  `Simulator.Run` (`originElevM := elevations[0] + in.OriginHeightM`). ✓
- Trade-off precisión/latencia (10.2) → resuelto con `MaxTotalSamples`
  + pool de concurrencia (Task 5-6). ✓
- Curvatura/refracción (10.3) → implementada en MVP, no diferida a fase
  2 (Task 2-3). ✓
- Cobertura DEM insuficiente (10.4) → distinción origen vs. punto
  intermedio (Task 5, `fetchElevations`). ✓
- Dependencia de servicio externo (10.5) → `DemUnavailableError` → 503
  (Task 4, 7). ✓
- No afecta `reports`/`cell_agg` (11) → ningún task toca esas tablas o
  sus migraciones. ✓
- Plan de verificación (12): unitarios de geometría/colisión → Tasks
  2-3; integración con DEM real → Task 8; prueba visual frontend → Task
  11 Step 4. Benchmark por combinaciones de parámetros queda fuera del
  MVP (no bloqueante, se puede agregar después con datos reales de uso).

**Placeholders:** ninguno — todo paso de código trae el código completo,
sin "TODO" ni "similar al task anterior".

**Consistencia de tipos:** `Sample`, `Ray`, `SimulationInput`, `Response`,
`Metadata` (paquete `los`) y `models.RadialSimulation*` (DTOs) usan los
mismos nombres de campo en todos los tasks que los referencian; revisado
cruzando Tasks 3, 5, 6, 7.

## Execution Handoff

Plan completo y guardado en
`docs/superpowers/plans/2026-07-22-radial-los-simulation.md`. Dos
opciones de ejecución:

**1. Subagent-Driven (recomendado)** — despacho un subagente fresco por
task, con revisión entre tasks e iteración rápida.

**2. Inline Execution** — ejecuto los tasks en esta misma sesión con
`executing-plans`, por lotes con checkpoints de revisión.

¿Cuál preferís?
