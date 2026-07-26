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

	// Rate limits de la propia API (no del DEM) — ver
	// middleware.RateLimit/PerHour, que ya reciben estos valores como
	// parámetros. Antes hardcodeados en router.go; ahora configurables
	// sin rebuild, mismo patrón que DemMaxRequestsPerSec.
	GeneralRateLimitPerHour     int
	GeneralRateLimitBurst       int
	AuthRateLimitPerHour        int
	AuthRateLimitBurst          int
	SimulationsRateLimitPerHour int
	SimulationsRateLimitBurst   int
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

	generalRateLimitPerHour := parseIntEnv("GENERAL_RATE_LIMIT_PER_HOUR", 300)
	generalRateLimitBurst := parseIntEnv("GENERAL_RATE_LIMIT_BURST", 60)
	authRateLimitPerHour := parseIntEnv("AUTH_RATE_LIMIT_PER_HOUR", 10)
	authRateLimitBurst := parseIntEnv("AUTH_RATE_LIMIT_BURST", 5)
	simulationsRateLimitPerHour := parseIntEnv("SIMULATIONS_RATE_LIMIT_PER_HOUR", 30)
	// Default 3, no 5: el rate limit de /simulations/radial corre antes
	// del handler, así que consume un token en cada intento (incluida
	// una validación fallida o un 422 de cobertura DEM, no solo una
	// corrida exitosa). Un burst de 5 permitía a un solo visitante
	// disparar 5 simulaciones largas de golpe, compitiendo todas por el
	// mismo presupuesto global de DemMaxRequestsPerSec (el
	// HTTPElevationProvider es una única instancia compartida entre
	// requests, ver router.go) y degradando el tiempo de espera de
	// otros usuarios. 3 alcanza para una corrida + un reintento tras un
	// error de validación, sin habilitar ese abuso.
	simulationsRateLimitBurst := parseIntEnv("SIMULATIONS_RATE_LIMIT_BURST", 3)

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

		GeneralRateLimitPerHour:     generalRateLimitPerHour,
		GeneralRateLimitBurst:       generalRateLimitBurst,
		AuthRateLimitPerHour:        authRateLimitPerHour,
		AuthRateLimitBurst:          authRateLimitBurst,
		SimulationsRateLimitPerHour: simulationsRateLimitPerHour,
		SimulationsRateLimitBurst:   simulationsRateLimitBurst,
	}
}

func parseIntEnv(key string, fallback int) int {
	v, err := strconv.Atoi(getEnv(key, strconv.Itoa(fallback)))
	if err != nil {
		return fallback
	}
	return v
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
