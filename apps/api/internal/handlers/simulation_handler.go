package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/models"
	"meshcore-map/api/internal/terrain/los"
)

type SimulationHandler struct {
	Elevation      los.ElevationProvider
	DemSourceLabel string
	DemResolutionM float64
}

// Radial implementa POST /api/v1/simulations/radial (spec kit sección
// 5). Sin auth (mismo criterio que GET /cells: visualización de solo
// lectura/cómputo, no toca datos persistidos) pero con rate limit
// dedicado más estricto en router.go por el costo de cada llamada al DEM.
func (h *SimulationHandler) Radial(c *gin.Context) {
	var in models.RadialSimulationRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	simInput, err := los.ValidateRequest(in)
	if err != nil {
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	sim := &los.Simulator{
		Elevation:      h.Elevation,
		DemSourceLabel: h.DemSourceLabel,
		DemResolutionM: h.DemResolutionM,
	}

	result, err := sim.Run(c.Request.Context(), simInput)
	if err != nil {
		var coverageErr *los.DemCoverageError
		var unavailableErr *los.DemUnavailableError
		switch {
		case errors.As(err, &coverageErr):
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error": "dem_coverage_insufficient", "message": coverageErr.Message,
			})
		case errors.As(err, &unavailableErr):
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "dem_backend_unavailable", "message": unavailableErr.Error(),
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "simulation_failed", "message": err.Error(),
			})
		}
		return
	}

	rays := make([]models.RadialSimulationRay, len(result.Rays))
	for i, r := range result.Rays {
		rays[i] = models.RadialSimulationRay{
			AngleDeg: r.AngleDeg, EndLat: r.EndLat, EndLon: r.EndLon,
			DistanceM: r.DistanceM,
			// Collided se deriva de LinkStatus, no viene de los.Ray — el
			// frontend actual todavía no distingue degraded de blocked,
			// así que ambos cuentan como colisión ahí.
			Collided:        r.LinkStatus != los.LinkStatusClear,
			LinkStatus:      string(r.LinkStatus),
			FresnelClearPct: r.FresnelClearPct,
			CollisionLat:    r.CollisionLat, CollisionLon: r.CollisionLon,
			CollisionElevM: r.CollisionElevM,
		}
	}

	fresnelTable := make([]models.FresnelTablePoint, len(result.Metadata.FresnelTable))
	for i, p := range result.Metadata.FresnelTable {
		fresnelTable[i] = models.FresnelTablePoint{
			DistanceM: p.DistanceM, FresnelRadiusM: p.FresnelRadiusM, HeightExtraM: p.HeightExtraM,
		}
	}

	c.JSON(http.StatusOK, models.RadialSimulationResponse{
		Rays: rays,
		Metadata: models.RadialSimulationMetadata{
			DemSource: result.Metadata.DemSource, DemResolutionM: result.Metadata.DemResolutionM,
			ComputeMs: result.Metadata.ComputeMs, FresnelTable: fresnelTable,
		},
	})
}
