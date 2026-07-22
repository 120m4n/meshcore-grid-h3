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
	// Un cerro de 1050m a 30km bloquearía sin curvatura (origen 1000)
	// pero con curvatura activa la elevación efectiva baja por debajo
	// del origen y el rayo debe pasar de largo.
	samples := []Sample{
		{DistanceM: 30000, Lat: 7.15, Lon: -73.12, ElevM: 1050},
	}
	withoutCurvature := EvaluateRay(0, 1000, samples, false, 0)
	if !withoutCurvature.Collided {
		t.Fatalf("sin curvatura, 1050 >= 1000 debe colisionar")
	}

	withCurvature := EvaluateRay(0, 1000, samples, true, 0.13)
	drop := CurvatureDropM(30000, 0.13)
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
