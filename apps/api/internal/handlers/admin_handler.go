package handlers

import (
	"database/sql"
	"encoding/csv"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/h3util"
	"meshcore-map/api/internal/models"
)

type AdminHandler struct {
	DB *sql.DB
}

// ListReports acepta ?status=pending|approved|rejected (opcional, si se omite trae todo).
func (h *AdminHandler) ListReports(c *gin.Context) {
	status := c.Query("status")

	query := `
		SELECT r.id, r.h3_index, r.h3_resolution, r.lat, r.lon, r.input_method,
		       r.input_raw, r.reporter_id, u.display_name, rdn.display_name,
		       r.signal_quality, r.message, r.status, r.reviewed_by,
		       r.reviewed_at, r.created_at
		FROM reports r
		JOIN users u ON u.id = r.reporter_id
		LEFT JOIN report_display_names rdn ON rdn.report_id = r.id`
	args := []any{}
	if status != "" {
		query += " WHERE r.status = ?"
		args = append(args, status)
	}
	query += " ORDER BY r.created_at DESC"

	rows, err := h.DB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar reportes"})
		return
	}
	defer rows.Close()

	reports := []models.Report{}
	for rows.Next() {
		var r models.Report
		var displayName sql.NullString
		if err := rows.Scan(&r.ID, &r.H3Index, &r.H3Resolution, &r.Lat, &r.Lon,
			&r.InputMethod, &r.InputRaw, &r.ReporterID, &r.ReporterName, &displayName,
			&r.SignalQuality, &r.Message, &r.Status, &r.ReviewedBy, &r.ReviewedAt,
			&r.CreatedAt); err != nil {
			continue
		}
		if displayName.Valid {
			r.ReporterDisplayName = &displayName.String
		}
		reports = append(reports, r)
	}

	c.JSON(http.StatusOK, reports)
}

type reviewInput struct {
	Status string `json:"status" binding:"required,oneof=approved rejected"`
}

func (h *AdminHandler) ReviewReport(c *gin.Context) {
	id := c.Param("id")
	adminID, _ := c.Get("user_id")

	var in reviewInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var h3Index string
	if err := h.DB.QueryRow(`SELECT h3_index FROM reports WHERE id = ?`, id).Scan(&h3Index); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "reporte no encontrado"})
		return
	}

	res, err := h.DB.Exec(`
		UPDATE reports
		SET status = ?, reviewed_by = ?, reviewed_at = datetime('now')
		WHERE id = ?`, in.Status, adminID, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo actualizar el reporte"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "reporte no encontrado"})
		return
	}

	// Recalcula la agregación materializada (score_pct + geom_wkt)
	// para la celda afectada, sin importar si fue aprobado o rechazado
	// (un rechazo puede sacar la última pieza que sostenía el promedio).
	if err := recomputeCellAggregate(h.DB, h3Index); err != nil {
		// No abortamos la respuesta por esto: el estado del reporte ya quedó
		// consistente; el mapa se corrige en el próximo recompute exitoso.
		c.JSON(http.StatusOK, gin.H{
			"id": id, "status": in.Status,
			"warning": "reporte actualizado, pero falló el recálculo de la celda: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"id": id, "status": in.Status})
}

// recomputeCellAggregate recalcula score_pct/report_count/last_report_at
// y la geometría (geom) para una celda H3, a partir de sus reportes
// aprobados. Si ya no quedan reportes aprobados, elimina la fila.
func recomputeCellAggregate(sqlDB *sql.DB, h3Index string) error {
	var (
		scorePct     sql.NullFloat64
		reportCount  int
		lastReportAt sql.NullString
	)
	err := sqlDB.QueryRow(`
		SELECT
			AVG(CASE signal_quality
				WHEN 'sin_cobertura' THEN 0
				WHEN 'debil' THEN 1
				WHEN 'buena' THEN 2
				WHEN 'excelente' THEN 3
			END) / 3.0 * 100,
			COUNT(*),
			MAX(created_at)
		FROM reports
		WHERE h3_index = ? AND status = 'approved'
	`, h3Index).Scan(&scorePct, &reportCount, &lastReportAt)
	if err != nil {
		return err
	}

	if reportCount == 0 {
		_, err := sqlDB.Exec(`DELETE FROM cell_agg WHERE h3_index = ?`, h3Index)
		return err
	}

	wkt, err := h3util.CellBoundaryWKT(h3Index)
	if err != nil {
		return err
	}

	_, err = sqlDB.Exec(`
		INSERT INTO cell_agg (h3_index, score_pct, report_count, last_report_at, geom_wkt)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(h3_index) DO UPDATE SET
			score_pct = excluded.score_pct,
			report_count = excluded.report_count,
			last_report_at = excluded.last_report_at,
			geom_wkt = excluded.geom_wkt
	`, h3Index, scorePct.Float64, reportCount, lastReportAt.String, wkt)
	return err
}

// DeleteCell revoca todos los reportes aprobados de una celda H3,
// dejándola sin reportes aprobados. recomputeCellAggregate se encarga
// de borrar la fila de cell_agg cuando el conteo llega a 0 — mismo
// mecanismo que ya dispara ReviewReport, sin lógica de agregación nueva.
func (h *AdminHandler) DeleteCell(c *gin.Context) {
	h3Index := c.Param("h3_index")
	adminID, _ := c.Get("user_id")

	res, err := h.DB.Exec(`
		UPDATE reports
		SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
		WHERE h3_index = ? AND status = 'approved'`, adminID, h3Index)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo revocar los reportes de la celda"})
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "no hay celda activa con ese h3_index"})
		return
	}

	if err := recomputeCellAggregate(h.DB, h3Index); err != nil {
		c.JSON(http.StatusOK, gin.H{
			"h3_index": h3Index, "reports_revoked": n,
			"warning": "reportes revocados, pero falló el recálculo de la celda: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"h3_index": h3Index, "reports_revoked": n})
}

// ExportCSV expone cell_agg como CSV con una columna WKT, para que
// alguien que realmente necesite verlo en QGIS use
// "Añadir capa de texto delimitado" con esa columna como geometría.
// Esto mantiene el motor de datos operativo sin dependencias espaciales.
func (h *AdminHandler) ExportCSV(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT h3_index, score_pct, report_count, last_report_at, geom_wkt
		FROM cell_agg ORDER BY h3_index
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo exportar"})
		return
	}
	defer rows.Close()

	c.Header("Content-Type", "text/csv")
	c.Header("Content-Disposition", "attachment; filename=cell_agg.csv")

	w := csv.NewWriter(c.Writer)
	_ = w.Write([]string{"h3_index", "score_pct", "report_count", "last_report_at", "WKT"})
	for rows.Next() {
		var h3Index, lastReportAt, wkt string
		var scorePct float64
		var reportCount int
		if err := rows.Scan(&h3Index, &scorePct, &reportCount, &lastReportAt, &wkt); err != nil {
			continue
		}
		_ = w.Write([]string{
			h3Index, strconv.FormatFloat(scorePct, 'f', 2, 64),
			strconv.Itoa(reportCount), lastReportAt, wkt,
		})
	}
	w.Flush()
}
