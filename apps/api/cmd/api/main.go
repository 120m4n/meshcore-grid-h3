package main

import (
	"log"

	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/db"
	"meshcore-map/api/internal/router"
)

func main() {
	cfg := config.Load()

	sqlDB, err := db.Connect(cfg.DBPath)
	if err != nil {
		log.Fatalf("no se pudo abrir la base de datos SQLite (%s): %v", cfg.DBPath, err)
	}
	defer sqlDB.Close()

	if err := db.Migrate(sqlDB); err != nil {
		log.Fatalf("no se pudieron aplicar migraciones: %v", err)
	}

	r := router.New(sqlDB, cfg)

	log.Printf("API escuchando en :%s (db=%s, H3 resolution=%d)", cfg.Port, cfg.DBPath, cfg.H3Resolution)
	if err := r.Run(":" + cfg.Port); err != nil {
		log.Fatalf("error al iniciar servidor: %v", err)
	}
}
