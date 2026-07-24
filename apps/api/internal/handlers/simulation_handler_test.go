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
		// angle_step_deg=90 violaría la cota (0, 45] de los.ValidateRequest
		// (ver validate.go / validate_test.go, Task 5) — 45 es el máximo
		// válido, y produce ceil(360/45) = 8 rayos. sample_step_m=500
		// también excedía la cota [5, 250]; 200 es válido y sigue dejando
		// max_distance_m/sample_step_m dentro del tope de MaxTotalSamples.
		AngleStepDeg: ptr(45.0), MaxDistanceM: ptr(1000.0), SampleStepM: ptr(200.0),
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
	if len(resp.Rays) != 8 {
		t.Errorf("len(Rays) = %d, want 8", len(resp.Rays))
	}
	if resp.Metadata.DemSource != "test-dem" {
		t.Errorf("Metadata.DemSource = %v, want test-dem", resp.Metadata.DemSource)
	}
	if len(resp.Metadata.FresnelTable) != 21 {
		t.Errorf("len(Metadata.FresnelTable) = %d, want 21", len(resp.Metadata.FresnelTable))
	}
	for _, ray := range resp.Rays {
		if ray.LinkStatus == "" {
			t.Errorf("rayo a %v°: link_status vacío", ray.AngleDeg)
		}
		if ray.Collided != (ray.LinkStatus != "clear") {
			t.Errorf("rayo a %v°: collided=%v inconsistente con link_status=%v", ray.AngleDeg, ray.Collided, ray.LinkStatus)
		}
	}
}

// fakeElevationByPoint distingue el punto de origen (para poder fijar
// originElevM exacto) de los demás puntos muestreados — necesario para
// construir escenarios "degraded" deterministas donde origen y muestra
// tienen elevaciones de terreno distintas.
type fakeElevationByPoint struct {
	originLat, originLon float64
	originElev           float64
	sampleElev           float64
}

func (f *fakeElevationByPoint) ElevationAt(_ context.Context, lat, lon float64) (float64, error) {
	if lat == f.originLat && lon == f.originLon {
		return f.originElev, nil
	}
	return f.sampleElev, nil
}

func TestRadialSimulationDegradedLinkStillMarkedCollidedForCompat(t *testing.T) {
	// origen: terreno 799 + antena 1 = originElevM 800. Única muestra
	// (max_distance_m == sample_step_m == 200m): terreno 801, es decir
	// 1m por encima de esa línea base — geométricamente despejado sin
	// compensar (801 > 800 en línea recta bloquearía, pero la línea
	// compensada la despeja). r(200m, 915MHz) ≈ 4.05m, h_extra (factor
	// 0.6) ≈ 2.43m: clearance ≈ 2.43-1 = 1.43m, ~35% de r (< 60%) — debe
	// salir degraded, no clear. El frontend actual solo entiende
	// collided bool, así que debe seguir viendo true acá.
	originLat, originLon := 7.1193, -73.1227
	h := &SimulationHandler{
		Elevation: &fakeElevationByPoint{
			originLat: originLat, originLon: originLon,
			originElev: 799, sampleElev: 801,
		},
	}
	r := setupSimulationRouter(h)

	body, _ := json.Marshal(models.RadialSimulationRequest{
		OriginLat: ptr(originLat), OriginLon: ptr(originLon), OriginHeightM: ptr(1.0),
		AngleStepDeg: ptr(45.0), MaxDistanceM: ptr(200.0), SampleStepM: ptr(200.0),
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
	if len(resp.Rays) != 8 { // ceil(360/45)
		t.Fatalf("len(Rays) = %d, want 8", len(resp.Rays))
	}
	for _, ray := range resp.Rays {
		if ray.LinkStatus != "degraded" {
			t.Fatalf("rayo a %v°: link_status = %q, want degraded", ray.AngleDeg, ray.LinkStatus)
		}
		if !ray.Collided {
			t.Errorf("rayo a %v°: collided = false, want true (compat: degraded también cuenta como colisión)", ray.AngleDeg)
		}
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
		AngleStepDeg: ptr(45.0), MaxDistanceM: ptr(1000.0), SampleStepM: ptr(200.0),
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
