package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// RateLimit limita requests por IP con un token bucket independiente
// por visitante — estado en memoria, pensado para un solo contenedor
// (ver infra/docker-compose.yml). Si el servicio corre en más de una
// réplica algún día, cada una tendría su propio límite independiente;
// no es un problema hoy.
func RateLimit(r rate.Limit, burst int) gin.HandlerFunc {
	var mu sync.Mutex
	visitors := make(map[string]*visitor)

	go func() {
		for range time.Tick(10 * time.Minute) {
			mu.Lock()
			for ip, v := range visitors {
				if time.Since(v.lastSeen) > 30*time.Minute {
					delete(visitors, ip)
				}
			}
			mu.Unlock()
		}
	}()

	return func(c *gin.Context) {
		ip := c.ClientIP()

		mu.Lock()
		v, ok := visitors[ip]
		if !ok {
			v = &visitor{limiter: rate.NewLimiter(r, burst)}
			visitors[ip] = v
		}
		v.lastSeen = time.Now()
		allowed := v.limiter.Allow()
		mu.Unlock()

		if !allowed {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "demasiadas solicitudes, esperá un momento"})
			return
		}
		c.Next()
	}
}

// PerHour construye un rate.Limit a partir de "n por hora" — más legible
// en el call site del router que un float de tokens/segundo.
func PerHour(n int) rate.Limit {
	return rate.Limit(float64(n) / 3600)
}
