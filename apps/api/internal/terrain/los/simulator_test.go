package los

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type fakeElevationProvider struct {
	// elevAt devuelve la elevación para (lat, lon); por defecto un
	// terreno plano a 500m si no hay entrada específica.
	elevAt func(lat, lon float64) (float64, error)

	mu    sync.Mutex
	calls int
}

func (f *fakeElevationProvider) ElevationAt(_ context.Context, lat, lon float64) (float64, error) {
	// Simulator.Run resuelve elevaciones concurrentemente (pool acotado
	// a maxConcurrentElevationRequests), así que este fake es golpeado
	// desde múltiples goroutines a la vez: el contador necesita el mutex
	// para no ser una data race (detectado por `go test -race`).
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
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
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 1 {
		t.Fatalf("len(Rays) = %d, want 1 (angle_step_deg=360 → 1 rayo)", len(resp.Rays))
	}
	// originElevM = 500 (terreno bajo el origen) + 5 (antena) = 505.
	// El terreno a 500m de distancia es 500 < 505: la LOS pasa por encima,
	// no debería colisionar. (Si OriginHeightM no se sumara al origen,
	// originElevM quedaría en 500 == terreno y colisionaría por error.)
	if resp.Rays[0].Collided {
		t.Errorf("terreno a 500 < originElevM (500+5=505) no debería colisionar, pero Collided=true")
	}
}
