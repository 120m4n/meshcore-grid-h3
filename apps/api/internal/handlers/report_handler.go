package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/h3util"
	"meshcore-map/api/internal/models"
)

type ReportHandler struct {
	DB  *sql.DB
	Cfg config.Config
}

// Create recibe {lat,lon} o {plus_code}, NUNCA confía en un h3_index
// enviado por el cliente: siempre se recalcula aquí.
func (h *ReportHandler) Create(c *gin.Context) {
	var in models.CreateReportInput
	if err := c.ShouldBindJSON(&in); err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	lat, lon, err := h3util.ResolveLatLon(in.Lat, in.Lon, in.PlusCode)
	if err != nil {
		respondError(c, http.StatusBadRequest, "coordenadas o plus code inválidos")
		return
	}

	inputMethod := "coords"
	inputRaw := ""
	if in.Lat == nil || in.Lon == nil {
		inputMethod = "pluscode"
		inputRaw = *in.PlusCode
	}

	cellIndex := h3util.CellFromLatLon(lat, lon, h.Cfg.H3Resolution)
	userID, _ := c.Get("user_id")

	reportID := uuid.NewString()
	_, err = h.DB.Exec(
		`INSERT INTO reports
		 (id, h3_index, h3_resolution, lat, lon, input_method, input_raw,
		  reporter_id, signal_quality, message, status)
		 VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
		reportID, cellIndex, h.Cfg.H3Resolution, lat, lon, inputMethod, inputRaw,
		userID, in.SignalQuality, in.Message,
	)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo guardar el reporte")
		return
	}

	if in.ReporterDisplayName != nil {
		if name := strings.TrimSpace(*in.ReporterDisplayName); name != "" {
			// best-effort: si falla, el reporte ya quedó guardado igual;
			// la revisión admin simplemente mostrará "Anónimo".
			_, _ = h.DB.Exec(
				`INSERT INTO report_display_names (report_id, display_name) VALUES (?, ?)`,
				reportID, name,
			)
		}
	}

	networkType := in.NetworkType
	if networkType == "" {
		networkType = models.NetDesconocido
	}
	// best-effort: si falla, el reporte ya quedó guardado; el admin verá
	// 'desconocido' al no encontrar fila en report_network_types.
	if _, err := h.DB.Exec(
		`INSERT INTO report_network_types (report_id, network_type) VALUES (?, ?)`,
		reportID, networkType,
	); err != nil {
		log.Printf("WARN report_network_types insert failed for report %s: %v", reportID, err)
	}

	c.JSON(http.StatusCreated, gin.H{
		"id":       reportID,
		"h3_index": cellIndex,
		"status":   "pending",
		"message":  "Reporte enviado, queda pendiente de revisión por un administrador.",
	})
}
