package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port         string
	DBPath       string
	JWTSecret    string
	H3Resolution int
	// WebOrigin restringe CORS al dominio real del frontend. "*" es un
	// escape hatch explícito para dev local (equivale al viejo
	// AllowAllOrigins) — no usar en producción.
	WebOrigin string
}

func Load() Config {
	res, err := strconv.Atoi(getEnv("H3_RESOLUTION", "8"))
	if err != nil {
		res = 8
	}
	return Config{
		Port:         getEnv("PORT", "8080"),
		DBPath:       getEnv("DB_PATH", "/data/meshcore.db"),
		JWTSecret:    getEnv("JWT_SECRET", "change-me-in-production"),
		H3Resolution: res,
		WebOrigin:    getEnv("WEB_ORIGIN", "http://localhost:4321"),
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
