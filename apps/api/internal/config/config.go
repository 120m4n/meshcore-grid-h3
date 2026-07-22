package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port           string
	DBPath         string
	JWTSecret      string
	H3Resolution   int
	WebOrigin      string
	DemAPIURL      string
	DemSourceLabel string
	DemResolutionM float64
}

func Load() Config {
	res, err := strconv.Atoi(getEnv("H3_RESOLUTION", "8"))
	if err != nil {
		res = 8
	}
	demResM, err := strconv.ParseFloat(getEnv("DEM_RESOLUTION_M", "30"), 64)
	if err != nil {
		demResM = 30
	}
	return Config{
		Port:           getEnv("PORT", "8080"),
		DBPath:         getEnv("DB_PATH", "/data/meshcore.db"),
		JWTSecret:      getEnv("JWT_SECRET", "change-me-in-production"),
		H3Resolution:   res,
		WebOrigin:      getEnv("WEB_ORIGIN", "http://localhost:4321"),
		DemAPIURL:      getEnv("DEM_API_URL", "http://localhost:8000"),
		DemSourceLabel: getEnv("DEM_SOURCE_LABEL", "local-dem-api"),
		DemResolutionM: demResM,
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
