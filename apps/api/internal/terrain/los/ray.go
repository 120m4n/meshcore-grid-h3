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

type Ray struct {
	AngleDeg       float64
	EndLat         float64
	EndLon         float64
	DistanceM      float64
	Collided       bool
	CollisionLat   float64
	CollisionLon   float64
	CollisionElevM float64
}

// EvaluateRay recorre samples en orden creciente de distancia y
// devuelve el primer punto donde el terreno alcanza o supera la altura
// de un rayo horizontal que sale del origen a originElevM (sin altura
// de destino: el objetivo es el primer obstáculo topográfico, no un
// enlace punto-a-punto con antena en ambos extremos). Con
// earthCurvature activo, la altura efectiva de cada muestra para
// comparar es ElevM - CurvatureDropM(distancia, refractionK): la Tierra
// "cae" bajo la línea recta a medida que crece la distancia, así que un
// terreno lejano necesita ser más alto para bloquear.
//
// Un ElevM == NaN marca un punto fuera de cobertura DEM — el rayo se
// trunca ahí (Collided=false, DistanceM = distancia de ese punto) sin
// tratarlo como colisión topográfica.
func EvaluateRay(angleDeg, originElevM float64, samples []Sample, earthCurvature bool, refractionK float64) Ray {
	for _, s := range samples {
		if math.IsNaN(s.ElevM) {
			return Ray{
				AngleDeg:  angleDeg,
				EndLat:    s.Lat,
				EndLon:    s.Lon,
				DistanceM: s.DistanceM,
				Collided:  false,
			}
		}

		effectiveElevM := s.ElevM
		if earthCurvature {
			effectiveElevM -= CurvatureDropM(s.DistanceM, refractionK)
		}

		if effectiveElevM >= originElevM {
			return Ray{
				AngleDeg:       angleDeg,
				EndLat:         s.Lat,
				EndLon:         s.Lon,
				DistanceM:      s.DistanceM,
				Collided:       true,
				CollisionLat:   s.Lat,
				CollisionLon:   s.Lon,
				CollisionElevM: s.ElevM,
			}
		}
	}

	last := samples[len(samples)-1]
	return Ray{
		AngleDeg:  angleDeg,
		EndLat:    last.Lat,
		EndLon:    last.Lon,
		DistanceM: last.DistanceM,
		Collided:  false,
	}
}
