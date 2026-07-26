package los

import "math"

// defaultFrequencyMHz fija la banda de MeshCore/Meshtastic en Colombia
// (915 MHz) como constante interna — no es parámetro de la API porque
// el proyecto no simula otro hardware.
const defaultFrequencyMHz = 915.0

// defaultCompensationFactor: fracción del radio de Fresnel que se suma
// a la altura de origen como compensación (ver HeightCompensationM).
// Parametrizable por request en [0.5, 0.7] (ver ValidateRequest).
const defaultCompensationFactor = 0.6

// fresnelClearanceThresholdPct: regla de ingeniería RF estándar — un
// enlace necesita al menos 60% de la primera zona de Fresnel despejada
// para considerarse utilizable sin degradación relevante. Fija, no
// parametrizable (a diferencia de defaultCompensationFactor).
const fresnelClearanceThresholdPct = 60.0

const speedOfLightMPerS = 299792458.0

// FresnelRadiusM calcula el radio (m) de la primera zona de Fresnel en
// el punto medio de un enlace hipotético de longitud distanceM, a
// frequencyMHz: r = sqrt(λ·D/4), con λ = c/f (fórmula estándar de
// radio en el punto medio, caso particular de r_n = sqrt(n·λ·d1·d2/D)
// con d1=d2=D/2 y n=1).
//
// Un rayo de este simulador no tiene receptor fijo (barre hasta un
// obstáculo o hasta max_distance_m), así que EvaluateRay llama a esta
// función con distanceM = distancia recorrida hasta el sample
// evaluado, tratando ese punto como si fuera el receptor de un enlace
// de esa longitud — el radio de Fresnel exigido crece con la distancia
// recorrida, igual que describe el algoritmo de compensación.
func FresnelRadiusM(distanceM, frequencyMHz float64) float64 {
	if distanceM <= 0 {
		return 0
	}
	freqHz := frequencyMHz * 1e6
	wavelengthM := speedOfLightMPerS / freqHz
	return math.Sqrt(wavelengthM * distanceM / 4)
}

// HeightCompensationM calcula h_extra = factor · FresnelRadiusM(...) —
// la altura adicional sobre el origen configurado que compensaría la
// zona de Fresnel esperada a esa distancia.
func HeightCompensationM(distanceM, frequencyMHz, factor float64) float64 {
	return factor * FresnelRadiusM(distanceM, frequencyMHz)
}
