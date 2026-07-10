package router

import (
	"database/sql"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/handlers"
	"meshcore-map/api/internal/middleware"
)

func New(db *sql.DB, cfg config.Config) *gin.Engine {
	r := gin.Default()

	corsCfg := cors.Config{
		AllowMethods: []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Origin", "Content-Type", "Authorization"},
		MaxAge:       12 * time.Hour,
	}
	if cfg.WebOrigin == "*" {
		corsCfg.AllowAllOrigins = true // escape hatch explícito, ver config.WebOrigin
	} else {
		corsCfg.AllowOrigins = []string{cfg.WebOrigin}
	}
	r.Use(cors.New(corsCfg))

	// Techo general por IP sobre toda la API pública — no es un límite
	// pensado para molestar uso normal (el mapa ya tiene su propio TTL
	// de 45min en el frontend), es un freno a scraping/DDoS básico.
	r.Use(middleware.RateLimit(middleware.PerHour(300), 60))

	// Límite más estricto específico para los endpoints de auth/registro
	// — son los que más importa frenar contra abuso automatizado.
	authRateLimit := middleware.RateLimit(middleware.PerHour(10), 5)

	authH := &handlers.AuthHandler{DB: db, Cfg: cfg}
	reportH := &handlers.ReportHandler{DB: db, Cfg: cfg}
	cellH := &handlers.CellHandler{DB: db}
	adminH := &handlers.AdminHandler{DB: db}
	inviteH := &handlers.InviteHandler{DB: db}

	v1 := r.Group("/api/v1")
	{
		v1.POST("/auth/register", authRateLimit, authH.Register)
		v1.POST("/auth/login", authRateLimit, authH.Login)
		v1.POST("/auth/invite-codes/validate", authRateLimit, inviteH.Validate)
		v1.GET("/cells", cellH.List)
		v1.GET("/cells/:h3_index/origins", cellH.Origins)

		authed := v1.Group("")
		authed.Use(middleware.RequireAuth(cfg.JWTSecret))
		{
			authed.GET("/me", authH.Me)
			authed.POST("/reports", reportH.Create)

			admin := authed.Group("/admin")
			admin.Use(middleware.RequireAdmin())
			{
				admin.GET("/reports", adminH.ListReports)
				admin.PATCH("/reports/:id", adminH.ReviewReport)
				admin.GET("/export.csv", adminH.ExportCSV)
				admin.DELETE("/cells/:h3_index", adminH.DeleteCell)
				admin.PATCH("/cells/:h3_index/score", adminH.UpdateCellScore)
				admin.DELETE("/cells/:h3_index/score", adminH.RevertCellScore)
				admin.POST("/invite-codes", inviteH.Generate)
				admin.GET("/invite-codes", inviteH.List)
			}
		}
	}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	return r
}
