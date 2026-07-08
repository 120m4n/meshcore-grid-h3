package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

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
