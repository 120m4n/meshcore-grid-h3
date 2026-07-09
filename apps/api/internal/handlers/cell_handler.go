package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	olc "github.com/google/open-location-code/go"

	"meshcore-map/api/internal/models"
)

type CellHandler struct {
	DB *sql.DB
}

// List lee la tabla materializada cell_agg (recalculada por AdminHandler
// cada vez que se aprueba/rechaza un reporte). Es la misma tabla que
// public, sin tocar la columna geom_wkt (esa solo se usa para export CSV/QGIS).
func (h *CellHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT h3_index, score_pct, report_count, last_report_at
		FROM cell_agg
		ORDER BY h3_index
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar celdas"})
		return
	}
	defer rows.Close()

	cells := []models.CellAggregate{}
	for rows.Next() {
		var cell models.CellAggregate
		if err := rows.Scan(&cell.H3Index, &cell.ScorePct, &cell.ReportCount, &cell.LastReportAt); err != nil {
			continue
		}
		cells = append(cells, cell)
	}

	c.JSON(http.StatusOK, cells)
}

// Origins devuelve las áreas de plus code (nivel 10, ~13m) que
// originaron los reportes aprobados de una celda, deduplicadas por
// código — si dos reportes caen en el mismo código de 10 dígitos
// (ej. mismo edificio), se cuentan una sola vez. Siempre se calcula
// desde reports.lat/lon, nunca desde input_raw, sin importar
// input_method: reports.lat/lon existen para el 100% de los reportes
// (se resuelven al guardar, ver ReportHandler.Create).
func (h *CellHandler) Origins(c *gin.Context) {
	h3Index := c.Param("h3_index")

	rows, err := h.DB.Query(`
		SELECT lat, lon FROM reports
		WHERE h3_index = ? AND status = 'approved'
	`, h3Index)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar los orígenes de la celda"})
		return
	}
	defer rows.Close()

	seen := map[string]struct{}{}
	origins := []models.CellOrigin{}
	for rows.Next() {
		var lat, lon float64
		if err := rows.Scan(&lat, &lon); err != nil {
			continue
		}
		code := olc.Encode(lat, lon, 10)
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}

		area, err := olc.Decode(code)
		if err != nil {
			continue
		}
		origins = append(origins, models.CellOrigin{
			PlusCode: code,
			LatLo:    area.LatLo,
			LatHi:    area.LatHi,
			LngLo:    area.LngLo,
			LngHi:    area.LngHi,
		})
	}

	c.JSON(http.StatusOK, origins)
}
