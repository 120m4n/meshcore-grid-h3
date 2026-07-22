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
		t.Errorf("CurvatureDropM(10000, 0.13) = %v, want %v (87%% of %v)", withRefraction, want, noRefraction)
	}
	if withRefraction >= noRefraction {
		t.Errorf("refraction_k > 0 debe reducir la caída efectiva")
	}
}
