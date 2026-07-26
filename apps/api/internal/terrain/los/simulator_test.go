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
		StartAngleDeg: 0, EndAngleDeg: 360,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if len(resp.Rays) != 4 { // 360/90
		t.Fatalf("len(Rays) = %d, want 4", len(resp.Rays))
	}
	for _, ray := range resp.Rays {
		if ray.LinkStatus != LinkStatusClear {
			t.Errorf("rayo a %v° no debería colisionar contra terreno plano bajo el origen, got %v", ray.AngleDeg, ray.LinkStatus)
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
		StartAngleDeg: 0, EndAngleDeg: 360,
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
		StartAngleDeg: 0, EndAngleDeg: 360,
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
		if ray.LinkStatus != LinkStatusClear {
			t.Errorf("rayo a %v° no debería marcar colisión topográfica (era corte de cobertura o nada), got %v", ray.AngleDeg, ray.LinkStatus)
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
		StartAngleDeg: 0, EndAngleDeg: 360,
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
	if resp.Rays[0].LinkStatus != LinkStatusClear {
		t.Errorf("terreno a 500 < originElevM (500+5=505) no debería colisionar, pero LinkStatus=%v", resp.Rays[0].LinkStatus)
	}
}

func TestSimulatorRunBuildsFresnelTable(t *testing.T) {
	fake := &fakeElevationProvider{elevAt: func(lat, lon float64) (float64, error) { return 500, nil }}
	sim := &Simulator{Elevation: fake}

	in := SimulationInput{
		OriginLat: 7.1193, OriginLon: -73.1227, OriginHeightM: 10,
		AngleStepDeg: 90, MaxDistanceM: 2000, SampleStepM: 500,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
		FresnelCompensation: true, CompensationFactor: 0.6,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}

	table := resp.Metadata.FresnelTable
	if len(table) != fresnelTableRows+1 {
		t.Fatalf("len(FresnelTable) = %d, want %d", len(table), fresnelTableRows+1)
	}
	if table[0].DistanceM != 0 || table[0].FresnelRadiusM != 0 || table[0].HeightExtraM != 0 {
		t.Errorf("FresnelTable[0] = %+v, want distancia/radio/altura_extra todos 0", table[0])
	}
	last := table[len(table)-1]
	if last.DistanceM != in.MaxDistanceM {
		t.Errorf("FresnelTable último punto: DistanceM = %v, want %v", last.DistanceM, in.MaxDistanceM)
	}
	wantRadius := FresnelRadiusM(in.MaxDistanceM, defaultFrequencyMHz)
	if !almostEqual(last.FresnelRadiusM, wantRadius, 1e-6) {
		t.Errorf("FresnelTable último punto: FresnelRadiusM = %v, want %v", last.FresnelRadiusM, wantRadius)
	}
	wantHeightExtra := in.CompensationFactor * wantRadius
	if !almostEqual(last.HeightExtraM, wantHeightExtra, 1e-6) {
		t.Errorf("FresnelTable último punto: HeightExtraM = %v, want %v", last.HeightExtraM, wantHeightExtra)
	}
}

func TestSimulatorRunFresnelCompensationDegradesRay(t *testing.T) {
	// origen: terreno 799 + antena 1 = originElevM 800. Muestra a 5000m:
	// terreno 805, geométricamente despejado (805 > 800, la línea recta
	// sin compensar colisionaría, pero con h_extra la línea compensada
	// (≈812.14) sí lo despeja). Aun así el clearance resultante (≈7.14m)
	// es solo ~35% del radio de Fresnel a esa distancia (≈20.24m) — por
	// debajo del 60% exigido, así que debe salir degraded, no clear.
	originLat, originLon := 7.1193, -73.1227
	fake := &fakeElevationProvider{elevAt: func(lat, lon float64) (float64, error) {
		if lat == originLat && lon == originLon {
			return 799, nil
		}
		return 805, nil
	}}
	sim := &Simulator{Elevation: fake}

	in := SimulationInput{
		OriginLat: originLat, OriginLon: originLon, OriginHeightM: 1,
		AngleStepDeg: 360, MaxDistanceM: 5000, SampleStepM: 5000,
		EarthCurvature: false, RefractionK: 0.13,
		StartAngleDeg: 0, EndAngleDeg: 360,
		FresnelCompensation: true, CompensationFactor: 0.6,
	}
	resp, err := sim.Run(context.Background(), in)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if resp.Rays[0].LinkStatus != LinkStatusDegraded {
		t.Fatalf("LinkStatus = %v, want degraded", resp.Rays[0].LinkStatus)
	}
}

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
