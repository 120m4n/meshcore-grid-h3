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
