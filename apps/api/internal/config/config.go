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
	DemAPIURL            string
	DemSourceLabel       string
	DemResolutionM       float64
	DemMaxRequestsPerSec float64
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
	// 0 = sin límite (comportamiento previo): el pool de concurrencia de
	// Simulator dispara hasta 24 llamadas a la vez sin espaciarlas, lo
	// que puede disparar el rate limit propio del backend DEM aun con un
	// presupuesto total razonable. Configurar DEM_MAX_REQUESTS_PER_SEC
	// para espaciar las llamadas salientes una vez que el límite real del
	// DEM esté definido del lado de esa API.
	demMaxReqPerSec, err := strconv.ParseFloat(getEnv("DEM_MAX_REQUESTS_PER_SEC", "0"), 64)
	if err != nil {
		demMaxReqPerSec = 0
	}
	return Config{
		Port:                 getEnv("PORT", "8080"),
		DBPath:               getEnv("DB_PATH", "/data/meshcore.db"),
		JWTSecret:            getEnv("JWT_SECRET", "change-me-in-production"),
		H3Resolution:         res,
		WebOrigin:            getEnv("WEB_ORIGIN", "http://localhost:4321"),
		DemAPIURL:            getEnv("DEM_API_URL", "http://localhost:8000"),
		DemSourceLabel:       getEnv("DEM_SOURCE_LABEL", "local-dem-api"),
		DemResolutionM:       demResM,
		DemMaxRequestsPerSec: demMaxReqPerSec,
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
