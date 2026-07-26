package los

import "math"

// demCoverageGapMarker marca, en Sample.ElevM, un punto fuera de
// cobertura del DEM (ver Simulator.fetchElevations) — NaN para que
// nunca se confunda con una elevación real válida en una comparación
// numérica.
var demCoverageGapMarker = math.NaN()

type Sample struct {
	DistanceM float64
	Lat       float64
	Lon       float64
	ElevM     float64
}

// LinkStatus clasifica el resultado de un rayo evaluado. Con la zona
// de Fresnel en juego, "no bloqueado geométricamente" ya no alcanza
// para decir que el enlace sirve: puede estar geométricamente despejado
// y aun así degradado si invade más del 40% de la primera zona de
// Fresnel (ver fresnelClearanceThresholdPct en fresnel.go).
type LinkStatus string

const (
	LinkStatusClear    LinkStatus = "clear"
	LinkStatusDegraded LinkStatus = "degraded"
	LinkStatusBlocked  LinkStatus = "blocked"
)

type Ray struct {
	AngleDeg        float64
	EndLat          float64
	EndLon          float64
	DistanceM       float64
	LinkStatus      LinkStatus
	FresnelClearPct float64
	CollisionLat    float64
	CollisionLon    float64
	CollisionElevM  float64
}

// EvaluateRay recorre samples en orden creciente de distancia y
// devuelve el primer punto donde el enlace deja de ser "clear" (sin
// altura de destino: el objetivo es el primer obstáculo/degradación a
// lo largo del rayo, no un enlace punto-a-punto con antena en ambos
// extremos). Con earthCurvature activo, la altura efectiva de cada
// muestra para comparar es ElevM - CurvatureDropM(distancia,
// refractionK): la Tierra "cae" bajo la línea recta a medida que crece
// la distancia, así que un terreno lejano necesita ser más alto para
// bloquear.
//
// Con fresnelCompensation == false, el comportamiento es el LOS puro de
// siempre: LinkStatusBlocked si el terreno alcanza o supera la línea
// horizontal desde originElevM, sin estado degraded posible (paridad
// exacta con el comportamiento previo a esta feature).
//
// Con fresnelCompensation == true, cada muestra evalúa el enlace contra
// una línea "compensada" (originElevM + HeightCompensationM(distancia,
// 915MHz, compensationFactor)) — la altura de antena efectiva sube con
// la distancia recorrida, siguiendo el radio de Fresnel esperado ahí.
// Un obstáculo que ni siquiera esa línea compensada logra despejar es
// LinkStatusBlocked; uno que la línea despeja geométricamente pero con
// menos de fresnelClearanceThresholdPct % del radio de Fresnel libre es
// LinkStatusDegraded.
//
// Un ElevM == NaN marca un punto fuera de cobertura DEM — el rayo se
// trunca ahí (LinkStatusClear, DistanceM = distancia de ese punto) sin
// evaluar Fresnel/colisión ahí (no hay terreno confiable con qué
// comparar).
func EvaluateRay(angleDeg, originElevM float64, samples []Sample, earthCurvature bool, refractionK float64, fresnelCompensation bool, compensationFactor float64) Ray {
	lastClearPct := 100.0

	for _, s := range samples {
		if math.IsNaN(s.ElevM) {
			return Ray{
				AngleDeg:   angleDeg,
				EndLat:     s.Lat,
				EndLon:     s.Lon,
				DistanceM:  s.DistanceM,
				LinkStatus: LinkStatusClear,
			}
		}

		effectiveElevM := s.ElevM
		if earthCurvature {
			effectiveElevM -= CurvatureDropM(s.DistanceM, refractionK)
		}

		if !fresnelCompensation {
			if effectiveElevM >= originElevM {
				return Ray{
					AngleDeg:       angleDeg,
					EndLat:         s.Lat,
					EndLon:         s.Lon,
					DistanceM:      s.DistanceM,
					LinkStatus:     LinkStatusBlocked,
					CollisionLat:   s.Lat,
					CollisionLon:   s.Lon,
					CollisionElevM: s.ElevM,
				}
			}
			continue
		}

		r := FresnelRadiusM(s.DistanceM, defaultFrequencyMHz)
		hExtra := compensationFactor * r
		clearanceM := (originElevM + hExtra) - effectiveElevM

		pct := 100.0
		if r > 0 {
			pct = (clearanceM / r) * 100
		}
		lastClearPct = pct

		if clearanceM <= 0 {
			return Ray{
				AngleDeg:        angleDeg,
				EndLat:          s.Lat,
				EndLon:          s.Lon,
				DistanceM:       s.DistanceM,
				LinkStatus:      LinkStatusBlocked,
				FresnelClearPct: pct,
				CollisionLat:    s.Lat,
				CollisionLon:    s.Lon,
				CollisionElevM:  s.ElevM,
			}
		}
		if pct < fresnelClearanceThresholdPct {
			return Ray{
				AngleDeg:        angleDeg,
				EndLat:          s.Lat,
				EndLon:          s.Lon,
				DistanceM:       s.DistanceM,
				LinkStatus:      LinkStatusDegraded,
				FresnelClearPct: pct,
				CollisionLat:    s.Lat,
				CollisionLon:    s.Lon,
				CollisionElevM:  s.ElevM,
			}
		}
	}

	last := samples[len(samples)-1]
	result := Ray{
		AngleDeg:   angleDeg,
		EndLat:     last.Lat,
		EndLon:     last.Lon,
		DistanceM:  last.DistanceM,
		LinkStatus: LinkStatusClear,
	}
	if fresnelCompensation {
		result.FresnelClearPct = lastClearPct
	}
	return result
}
