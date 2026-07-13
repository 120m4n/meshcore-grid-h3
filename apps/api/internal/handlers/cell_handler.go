package handlers

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	olc "github.com/google/open-location-code/go"

	"meshcore-map/api/internal/h3util"
	"meshcore-map/api/internal/models"
)

const defaultCellPageSize = 100

// columnas ordenables de la tabla "Celdas activas" — plus_code no es
// columna SQL (se calcula desde h3_index), así que el ordenamiento se
// hace en Go sobre el slice ya armado, junto con el filtro por q.
var cellSortFields = map[string]func(a, b models.CellAggregate) bool{
	"h3_index":       func(a, b models.CellAggregate) bool { return a.H3Index < b.H3Index },
	"plus_code":      func(a, b models.CellAggregate) bool { return a.PlusCode < b.PlusCode },
	"score_pct":      func(a, b models.CellAggregate) bool { return a.ScorePct < b.ScorePct },
	"last_report_at": func(a, b models.CellAggregate) bool { return a.LastReportAt < b.LastReportAt },
}

type CellHandler struct {
	DB *sql.DB
}

// List lee la tabla materializada cell_agg (recalculada por AdminHandler
// cada vez que se aprueba/rechaza un reporte). Es la misma tabla que
// consume tanto el mapa público como la tabla "Celdas activas" del
// admin (mismo endpoint, sin duplicar query) — de ahí que también
// exponga manual_override, aunque el mapa público lo ignore.
// plus_code se calcula al vuelo desde el h3_index (h3util.CellPlusCode),
// no se guarda en cell_agg (ver 0004_cell_overrides.sql).
//
// Sin query param "page", responde el array plano completo de siempre
// (el mapa público lo llama así — necesita TODAS las celdas para pintar
// los hexágonos, nunca solo una página). Con "page", filtra por "q"
// (substring de plus_code, usado por el filtro de la tabla admin), ordena
// por sort_by/order (default h3_index/asc; ver cellSortFields) y pagina,
// devolviendo models.CellPage. El total de celdas activas de una red mesh
// regional es chico, así que filtrar/ordenar/paginar en memoria en Go es
// más simple que armarlo en SQL (plus_code no es columna de la tabla).
func (h *CellHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT c.h3_index, c.score_pct, c.report_count, c.last_report_at,
		       co.h3_index IS NOT NULL AS manual_override
		FROM cell_agg c
		LEFT JOIN cell_overrides co ON co.h3_index = c.h3_index
		ORDER BY c.h3_index
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar celdas"})
		return
	}
	defer rows.Close()

	cells := []models.CellAggregate{}
	for rows.Next() {
		var cell models.CellAggregate
		if err := rows.Scan(&cell.H3Index, &cell.ScorePct, &cell.ReportCount, &cell.LastReportAt, &cell.ManualOverride); err != nil {
			continue
		}
		if code, err := h3util.CellPlusCode(cell.H3Index); err == nil {
			cell.PlusCode = code
		}
		cells = append(cells, cell)
	}

	pageParam := c.Query("page")
	if pageParam == "" {
		c.JSON(http.StatusOK, cells)
		return
	}

	page, err := strconv.Atoi(pageParam)
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "page debe ser un entero >= 1"})
		return
	}

	pageSize := defaultCellPageSize
	if ps := c.Query("page_size"); ps != "" {
		v, err := strconv.Atoi(ps)
		if err != nil || v < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "page_size debe ser un entero >= 1"})
			return
		}
		pageSize = v
	}

	if q := strings.TrimSpace(c.Query("q")); q != "" {
		query := strings.ToUpper(q)
		filtered := make([]models.CellAggregate, 0, len(cells))
		for _, cell := range cells {
			if strings.Contains(strings.ToUpper(cell.PlusCode), query) {
				filtered = append(filtered, cell)
			}
		}
		cells = filtered
	}

	sortBy := c.DefaultQuery("sort_by", "h3_index")
	less, ok := cellSortFields[sortBy]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sort_by inválido"})
		return
	}
	order := c.DefaultQuery("order", "asc")
	if order != "asc" && order != "desc" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "order debe ser asc o desc"})
		return
	}
	sort.SliceStable(cells, func(i, j int) bool {
		if order == "desc" {
			return less(cells[j], cells[i])
		}
		return less(cells[i], cells[j])
	})

	total := len(cells)
	start := min((page-1)*pageSize, total)
	end := min(start+pageSize, total)

	c.JSON(http.StatusOK, models.CellPage{
		Items:    cells[start:end],
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	})
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
