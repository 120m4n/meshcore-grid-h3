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
