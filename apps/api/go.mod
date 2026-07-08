module meshcore-map/api

go 1.22

require (
	github.com/gin-gonic/gin v1.10.0
	github.com/gin-contrib/cors v1.7.2
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/google/open-location-code/go v0.0.0-20220920021254-ee9c9d05f2f5
	github.com/google/uuid v1.6.0
	github.com/mattn/go-sqlite3 v1.14.22
	github.com/uber/h3-go/v4 v4.1.1
	golang.org/x/crypto v0.24.0
)

// Ejecutar `go mod tidy` para resolver versiones exactas y sumas de checksum:
// este go.mod se entrega como punto de partida, no fue compilado en este entorno
// (sandbox sin acceso a proxy.golang.org).
//
// mattn/go-sqlite3 requiere cgo (CGO_ENABLED=1); compila su propio SQLite
// vendorizado, sin dependencias del sistema ni extensiones espaciales.
