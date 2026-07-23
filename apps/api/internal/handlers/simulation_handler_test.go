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
