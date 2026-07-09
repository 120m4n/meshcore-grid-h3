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

	r.Use(cors.New(cors.Config{
		AllowAllOrigins: true, // ajustar a dominio real del frontend en producción
		AllowMethods:    []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:    []string{"Origin", "Content-Type", "Authorization"},
		MaxAge:          12 * time.Hour,
	}))

	authH := &handlers.AuthHandler{DB: db, Cfg: cfg}
	reportH := &handlers.ReportHandler{DB: db, Cfg: cfg}
	cellH := &handlers.CellHandler{DB: db}
	adminH := &handlers.AdminHandler{DB: db}

	v1 := r.Group("/api/v1")
	{
		v1.POST("/auth/register", authH.Register)
		v1.POST("/auth/login", authH.Login)
		v1.GET("/cells", cellH.List)

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
			}
		}
	}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	return r
}
