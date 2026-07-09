package h3util

import (
	"errors"
	"fmt"
	"strings"

	olc "github.com/google/open-location-code/go"
	"github.com/uber/h3-go/v4"
)

// ErrInvalidInput se retorna cuando no se pudo resolver lat/lon a partir
// de las entradas del usuario (ni coords ni plus code válidos).
var ErrInvalidInput = errors.New("se requiere lat/lon válidos o un plus code válido")

// ResolveLatLon determina las coordenadas finales a partir de las dos
// formas de entrada soportadas por el formulario de reporte.
func ResolveLatLon(lat, lon *float64, plusCode *string) (float64, float64, error) {
	if lat != nil && lon != nil {
		return *lat, *lon, nil
	}
	if plusCode != nil && *plusCode != "" {
		area, err := olc.Decode(*plusCode)
		if err != nil {
			return 0, 0, err
		}
		lat, lng := area.Center()
		return lat, lng, nil
	}
	return 0, 0, ErrInvalidInput
}

// CellFromLatLon calcula el índice H3 (string) para una coordenada dada,
// a la resolución configurada del sistema.
func CellFromLatLon(lat, lon float64, resolution int) string {
	cell := h3.LatLngToCell(h3.LatLng{Lat: lat, Lng: lon}, resolution)
	return cell.String()
}

// CellBoundary retorna los vértices del hexágono (lat,lon) para uso interno.
func CellBoundary(h3Index string) ([][2]float64, error) {
	cell := h3.Cell(h3.IndexFromString(h3Index))
	if !cell.IsValid() {
		return nil, fmt.Errorf("índice H3 inválido: %s", h3Index)
	}
	boundary := cell.Boundary()
	points := make([][2]float64, 0, len(boundary))
	for _, v := range boundary {
		points = append(points, [2]float64{v.Lat, v.Lng})
	}
	return points, nil
}

// CellBoundaryWKT retorna el polígono del hexágono en formato WKT
// (SRID 4326 implícito), almacenado como texto plano en cell_agg.geom_wkt
// y usado solo si alguien exporta a QGIS (ver AdminHandler.ExportCSV).
func CellBoundaryWKT(h3Index string) (string, error) {
	points, err := CellBoundary(h3Index)
	if err != nil {
		return "", err
	}
	coords := make([]string, 0, len(points)+1)
	for _, p := range points {
		// WKT es lon lat (x y), h3-go retorna Lat,Lng
		coords = append(coords, fmt.Sprintf("%f %f", p[1], p[0]))
	}
	// cerrar el anillo repitiendo el primer punto
	if len(coords) > 0 {
		coords = append(coords, coords[0])
	}
	return fmt.Sprintf("POLYGON((%s))", strings.Join(coords, ", ")), nil
}
