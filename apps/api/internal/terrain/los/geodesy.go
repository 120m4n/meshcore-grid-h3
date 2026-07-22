package los

import "math"

const earthRadiusM = 6371000.0

// Destination calcula el punto (lat, lon) tras recorrer distanceM
// metros en línea recta desde (lat, lon) con azimut azimuthDeg (0 =
// norte, sentido horario). Aproximación esférica (no elipsoide/Vincenty):
// suficiente para el rango del MVP, acotado a max_distance_m <= 100 km
// por validación (ver simulator.go).
func Destination(lat, lon, azimuthDeg, distanceM float64) (float64, float64) {
	if distanceM == 0 {
		return lat, lon
	}
	phi1 := lat * math.Pi / 180
	lambda1 := lon * math.Pi / 180
	theta := azimuthDeg * math.Pi / 180
	delta := distanceM / earthRadiusM

	phi2 := math.Asin(math.Sin(phi1)*math.Cos(delta) + math.Cos(phi1)*math.Sin(delta)*math.Cos(theta))
	lambda2 := lambda1 + math.Atan2(
		math.Sin(theta)*math.Sin(delta)*math.Cos(phi1),
		math.Cos(delta)-math.Sin(phi1)*math.Sin(phi2),
	)

	return phi2 * 180 / math.Pi, lambda2 * 180 / math.Pi
}

// CurvatureDropM calcula cuánto "cae" el terreno respecto a una línea
// recta horizontal desde el origen, a distanceM metros, por curvatura
// terrestre. refractionK reduce esa caída (la atmósfera estándar dobla
// la línea de vista hacia el suelo, "extendiendo" el horizonte
// efectivo): caída_efectiva = caída_geométrica * (1 - refractionK).
// refractionK=0 → sin corrección atmosférica (peor caso); valores más
// altos → más alcance efectivo antes de que algo bloquee.
func CurvatureDropM(distanceM, refractionK float64) float64 {
	geometric := (distanceM * distanceM) / (2 * earthRadiusM)
	return geometric * (1 - refractionK)
}
