package handlers

import (
	"database/sql"
	"encoding/csv"
	"net/http"
	"strconv"
	"time"

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
		respondError(c, http.StatusInternalServerError, "no se pudo consultar reportes")
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
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	var h3Index string
	if err := h.DB.QueryRow(`SELECT h3_index FROM reports WHERE id = ?`, id).Scan(&h3Index); err != nil {
		respondError(c, http.StatusNotFound, "reporte no encontrado")
		return
	}

	res, err := h.DB.Exec(`
		UPDATE reports
		SET status = ?, reviewed_by = ?, reviewed_at = datetime('now')
		WHERE id = ?`, in.Status, adminID, id)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo actualizar el reporte")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		respondError(c, http.StatusNotFound, "reporte no encontrado")
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
// aprobados. Si ya no quedan reportes aprobados Y no hay un override
// manual activo, elimina la fila.
//
// Si hay un override manual (cell_overrides, ver AdminHandler.UpdateCellScore),
// score_pct queda "fijado" al valor del admin — no lo pisa el promedio
// automático — pero report_count/last_report_at siguen reflejando los
// reportes reales (son datos informativos, no lo que se está corrigiendo).
// Una celda overridden con 0 reportes reales NO se borra: el admin la
// quiso visible con ese score a propósito.
// sqlExecutor abstrae *sql.DB y *sql.Tx (ambos implementan Exec/QueryRow
// con esta firma) — recomputeCellAggregate corre suelta en ReviewReport
// (que tolera un fallo de recálculo sin deshacer el estado del reporte,
// ver comentario ahí) y dentro de una transacción en
// UpdateCellScore/RevertCellScore, donde el override y el recálculo
// deben quedar atómicos.
type sqlExecutor interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
}

func recomputeCellAggregate(db sqlExecutor, h3Index string) error {
	var overrideScore sql.NullFloat64
	err := db.QueryRow(`SELECT score_pct FROM cell_overrides WHERE h3_index = ?`, h3Index).Scan(&overrideScore)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	overridden := err == nil

	var (
		scorePct     sql.NullFloat64
		reportCount  int
		lastReportAt sql.NullString
	)
	err = db.QueryRow(`
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

	if reportCount == 0 && !overridden {
		_, err := db.Exec(`DELETE FROM cell_agg WHERE h3_index = ?`, h3Index)
		return err
	}

	finalScore := scorePct.Float64
	if overridden {
		finalScore = overrideScore.Float64
	}
	finalLastReportAt := lastReportAt.String
	if !lastReportAt.Valid {
		// overridden pero sin reportes reales: no hay MAX(created_at)
		// real que mostrar, se usa "ahora" como último toque conocido.
		finalLastReportAt = time.Now().UTC().Format("2006-01-02 15:04:05")
	}

	wkt, err := h3util.CellBoundaryWKT(h3Index)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		INSERT INTO cell_agg (h3_index, score_pct, report_count, last_report_at, geom_wkt)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(h3_index) DO UPDATE SET
			score_pct = excluded.score_pct,
			report_count = excluded.report_count,
			last_report_at = excluded.last_report_at,
			geom_wkt = excluded.geom_wkt
	`, h3Index, finalScore, reportCount, finalLastReportAt, wkt)
	return err
}

type updateCellScoreInput struct {
	ScorePct float64 `json:"score_pct" binding:"required,min=0,max=100"`
}

// UpdateCellScore fija manualmente el score_pct de una celda — un admin
// puede corregir la intensidad de señal mostrada sin depender del
// promedio automático de reportes. Queda "fijado" (ver cell_overrides)
// hasta que se revierte explícitamente con RevertCellScore.
func (h *AdminHandler) UpdateCellScore(c *gin.Context) {
	h3Index := c.Param("h3_index")
	adminID, _ := c.Get("user_id")

	var in updateCellScoreInput
	if err := c.ShouldBindJSON(&in); err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	// El override y el recálculo de cell_agg quedan atómicos: si el
	// recompute falla, no queremos un override guardado que el mapa
	// público todavía no refleja.
	tx, err := h.DB.Begin()
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo iniciar la transacción")
		return
	}
	defer tx.Rollback() //nolint:errcheck // no-op si ya hubo Commit

	_, err = tx.Exec(`
		INSERT INTO cell_overrides (h3_index, score_pct, updated_by, updated_at)
		VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT(h3_index) DO UPDATE SET
			score_pct = excluded.score_pct,
			updated_by = excluded.updated_by,
			updated_at = excluded.updated_at
	`, h3Index, in.ScorePct, adminID)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo guardar el override")
		return
	}

	if err := recomputeCellAggregate(tx, h3Index); err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo aplicar el override: " + err.Error())
		return
	}

	if err := tx.Commit(); err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo confirmar el override")
		return
	}

	c.JSON(http.StatusOK, gin.H{"h3_index": h3Index, "score_pct": in.ScorePct, "manual_override": true})
}

// RevertCellScore borra el override manual y vuelve a dejar el score_pct
// de la celda en manos del promedio automático de reportes aprobados
// (puede incluso hacer desaparecer la celda si no le quedan reportes
// reales — mismo comportamiento que si nunca hubiera tenido override).
func (h *AdminHandler) RevertCellScore(c *gin.Context) {
	h3Index := c.Param("h3_index")

	// Mismo razonamiento que UpdateCellScore: borrar el override y
	// recalcular cell_agg deben quedar atómicos.
	tx, err := h.DB.Begin()
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo iniciar la transacción")
		return
	}
	defer tx.Rollback() //nolint:errcheck // no-op si ya hubo Commit

	res, err := tx.Exec(`DELETE FROM cell_overrides WHERE h3_index = ?`, h3Index)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo revertir el override")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		respondError(c, http.StatusNotFound, "esa celda no tiene un override activo")
		return
	}

	if err := recomputeCellAggregate(tx, h3Index); err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo recalcular la celda: " + err.Error())
		return
	}

	if err := tx.Commit(); err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo confirmar el revert")
		return
	}

	c.JSON(http.StatusOK, gin.H{"h3_index": h3Index, "manual_override": false})
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
		respondError(c, http.StatusInternalServerError, "no se pudo revocar los reportes de la celda")
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		respondError(c, http.StatusNotFound, "no hay celda activa con ese h3_index")
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
		respondError(c, http.StatusInternalServerError, "no se pudo exportar")
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
