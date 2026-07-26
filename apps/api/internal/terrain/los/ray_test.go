package los

import "testing"

func TestEvaluateRayNoObstacleReachesMaxDistance(t *testing.T) {
	samples := []Sample{
		{DistanceM: 1000, Lat: 7.12, Lon: -73.12, ElevM: 800},
		{DistanceM: 2000, Lat: 7.13, Lon: -73.12, ElevM: 810},
		{DistanceM: 3000, Lat: 7.14, Lon: -73.12, ElevM: 820},
	}
	ray := EvaluateRay(45, 1000, samples, false, 0, false, 0)
	if ray.LinkStatus != LinkStatusClear {
		t.Fatalf("LinkStatus = %v, want clear: terreno (max 820) siempre bajo el origen (1000)", ray.LinkStatus)
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
	ray := EvaluateRay(45, 1000, samples, false, 0, false, 0)
	if ray.LinkStatus != LinkStatusBlocked {
		t.Fatalf("LinkStatus = %v, want blocked: elev 1500 >= origen 1000 en la muestra de 2000m", ray.LinkStatus)
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
	withoutCurvature := EvaluateRay(0, 1000, samples, false, 0, false, 0)
	if withoutCurvature.LinkStatus != LinkStatusBlocked {
		t.Fatalf("sin curvatura, 1050 >= 1000 debe bloquear, got %v", withoutCurvature.LinkStatus)
	}

	withCurvature := EvaluateRay(0, 1000, samples, true, 0.13, false, 0)
	drop := CurvatureDropM(30000, 0.13)
	if drop <= 50 {
		t.Fatalf("test mal calibrado: la caída (%v) debe superar el margen de 50m del cerro", drop)
	}
	if withCurvature.LinkStatus == LinkStatusBlocked {
		t.Errorf("con curvatura, la elevación efectiva (1050 - %.1f) debe quedar bajo el origen (1000)", drop)
	}
}

func TestEvaluateRayTruncatesAtDemCoverageGap(t *testing.T) {
	samples := []Sample{
		{DistanceM: 1000, Lat: 7.12, Lon: -73.12, ElevM: 900},
		{DistanceM: 2000, Lat: 7.13, Lon: -73.12, ElevM: demCoverageGapMarker},
		{DistanceM: 3000, Lat: 7.14, Lon: -73.12, ElevM: 2000},
	}
	ray := EvaluateRay(45, 1000, samples, false, 0, false, 0)
	if ray.LinkStatus != LinkStatusClear {
		t.Fatalf("un punto fuera de cobertura DEM no es una colisión topográfica, got %v", ray.LinkStatus)
	}
	if ray.DistanceM != 2000 {
		t.Errorf("DistanceM = %v, want 2000 (el rayo se trunca donde empieza el hueco de cobertura)", ray.DistanceM)
	}
}

func TestEvaluateRayFresnelCompensationDisabledNeverDegrades(t *testing.T) {
	// Terreno geométricamente despejado (799 < origen 800) pero que,
	// activada la compensación, no llegaría al 60% de zona de Fresnel
	// libre. Con fresnelCompensation=false debe seguir siendo "clear":
	// paridad exacta con el comportamiento LOS puro previo a esta
	// feature.
	samples := []Sample{
		{DistanceM: 5000, Lat: 7.12, Lon: -73.12, ElevM: 799},
	}
	ray := EvaluateRay(0, 800, samples, false, 0, false, 0)
	if ray.LinkStatus != LinkStatusClear {
		t.Fatalf("LinkStatus = %v, want clear (fresnel_compensation desactivado nunca degrada)", ray.LinkStatus)
	}
}

func TestEvaluateRayFresnelDegradedWhenClearanceBelowThreshold(t *testing.T) {
	// r(5000m, 915MHz) ≈ 20.24m. Con factor 0.6, hExtra ≈ 12.14m, línea
	// compensada ≈ 812.14. Terreno a 805 deja clearance ≈ 7.14m, que es
	// ~35% de 20.24m (< 60%) — geométricamente despejado pero degradado.
	r := FresnelRadiusM(5000, defaultFrequencyMHz)
	samples := []Sample{
		{DistanceM: 5000, Lat: 7.12, Lon: -73.12, ElevM: 805},
	}
	ray := EvaluateRay(0, 800, samples, false, 0, true, 0.6)
	if ray.LinkStatus != LinkStatusDegraded {
		t.Fatalf("LinkStatus = %v, want degraded (fresnel radius=%.2f)", ray.LinkStatus, r)
	}
	if ray.FresnelClearPct < 0 || ray.FresnelClearPct >= fresnelClearanceThresholdPct {
		t.Errorf("FresnelClearPct = %v, want in [0, %v)", ray.FresnelClearPct, fresnelClearanceThresholdPct)
	}
}

func TestEvaluateRayFresnelBlockedEvenWithCompensation(t *testing.T) {
	// Terreno muy por encima del origen: ni siquiera la línea
	// compensada con h_extra lo despeja.
	samples := []Sample{
		{DistanceM: 5000, Lat: 7.12, Lon: -73.12, ElevM: 900},
	}
	ray := EvaluateRay(0, 800, samples, false, 0, true, 0.6)
	if ray.LinkStatus != LinkStatusBlocked {
		t.Fatalf("LinkStatus = %v, want blocked", ray.LinkStatus)
	}
}

func TestEvaluateRayFresnelClearWhenAboveThreshold(t *testing.T) {
	// Terreno muy por debajo del origen: clearance sobra para el 60%
	// de zona de Fresnel exigido.
	samples := []Sample{
		{DistanceM: 5000, Lat: 7.12, Lon: -73.12, ElevM: 700},
	}
	ray := EvaluateRay(0, 800, samples, false, 0, true, 0.6)
	if ray.LinkStatus != LinkStatusClear {
		t.Fatalf("LinkStatus = %v, want clear", ray.LinkStatus)
	}
	if ray.FresnelClearPct < fresnelClearanceThresholdPct {
		t.Errorf("FresnelClearPct = %v, want >= %v", ray.FresnelClearPct, fresnelClearanceThresholdPct)
	}
}
