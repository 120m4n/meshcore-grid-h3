package los

import "testing"

func TestFresnelRadiusZeroAtZeroDistance(t *testing.T) {
	if r := FresnelRadiusM(0, defaultFrequencyMHz); r != 0 {
		t.Errorf("FresnelRadiusM(0, f) = %v, want 0", r)
	}
}

func TestFresnelRadiusNegativeDistanceIsZero(t *testing.T) {
	if r := FresnelRadiusM(-100, defaultFrequencyMHz); r != 0 {
		t.Errorf("FresnelRadiusM(-100, f) = %v, want 0", r)
	}
}

func TestFresnelRadiusKnownValueAt915MHz(t *testing.T) {
	// λ = c/f ≈ 299792458 / 915e6 ≈ 0.327642 m.
	// r(1000m) = sqrt(λ*1000/4) ≈ sqrt(81.91) ≈ 9.0505 m.
	got := FresnelRadiusM(1000, defaultFrequencyMHz)
	want := 9.0505
	if !almostEqual(got, want, 1e-3) {
		t.Errorf("FresnelRadiusM(1000, 915) = %v, want ~%v", got, want)
	}
}

func TestFresnelRadiusGrowsWithSqrtDistance(t *testing.T) {
	// r(4d) debe ser 2x r(d) (crece con la raíz cuadrada de la distancia).
	r1 := FresnelRadiusM(1000, defaultFrequencyMHz)
	r4 := FresnelRadiusM(4000, defaultFrequencyMHz)
	if !almostEqual(r4, r1*2, 1e-6) {
		t.Errorf("FresnelRadiusM(4000) = %v, want %v (2x FresnelRadiusM(1000)=%v)", r4, r1*2, r1)
	}
}

func TestFresnelRadiusHigherFrequencyShrinksRadius(t *testing.T) {
	r915 := FresnelRadiusM(5000, 915)
	r2400 := FresnelRadiusM(5000, 2400)
	if r2400 >= r915 {
		t.Errorf("a mayor frecuencia (menor λ) el radio de Fresnel debe ser menor: r915=%v r2400=%v", r915, r2400)
	}
}

func TestHeightCompensationIsFactorTimesRadius(t *testing.T) {
	r := FresnelRadiusM(2000, defaultFrequencyMHz)
	got := HeightCompensationM(2000, defaultFrequencyMHz, 0.6)
	want := 0.6 * r
	if !almostEqual(got, want, 1e-9) {
		t.Errorf("HeightCompensationM(2000, f, 0.6) = %v, want %v", got, want)
	}
}

func TestHeightCompensationZeroAtZeroDistance(t *testing.T) {
	if h := HeightCompensationM(0, defaultFrequencyMHz, 0.6); h != 0 {
		t.Errorf("HeightCompensationM(0, f, 0.6) = %v, want 0", h)
	}
}
