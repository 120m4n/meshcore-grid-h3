# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mapa de disponibilidad de red MeshCore en Santander (Colombia): celdas H3
coloreadas por calidad de señal, alimentadas por reportes de usuarios
moderados por administradores. Monorepo con dos apps independientes
(`apps/api` en Go, `apps/web` en Astro) más `infra/` para el despliegue
conjunto vía Docker Compose. No es un repo git (no `.git` presente).

## Commands

### Backend (`apps/api`, Go 1.22, módulo `meshcore-map/api`)

```bash
cd apps/api
go mod tidy                        # requiere acceso a proxy.golang.org
DB_PATH=./meshcore.db go run ./cmd/api   # sirve en :8080 por defecto
go build -o /out/api ./cmd/api
go vet ./...
```

Requiere `CGO_ENABLED=1` (mattn/go-sqlite3 compila SQLite vía cgo; solo
necesita un compilador C, sin dependencias del sistema).

No hay suite de tests todavía (`go test ./...` no encontrará nada útil).

### Frontend (`apps/web`, Astro 4 + Leaflet + h3-js)

```bash
cd apps/web
npm install
npm run dev       # :4321, usa PUBLIC_API_URL de apps/web/.env
npm run build      # build estático a dist/
npm run preview
```

Sin linter/formatter ni tests configurados en `package.json`.

### Despliegue (docker-compose)

```bash
cd infra
cp .env.example .env    # editar JWT_SECRET, PUBLIC_API_URL, dominios
docker compose up -d --build
```

Levanta `api` (Go binario + volumen `./data` bind-mounted, DB en
`infra/data/meshcore.db`) y `web` (build estático servido por nginx).
Las migraciones embebidas corren automáticamente al arrancar el backend
(`internal/db/migrate.go`) — no hay paso manual de init de DB.

Crear el primer admin (no existe endpoint de promoción, es deliberado):

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'tu-email@dominio.com';"
```

## Architecture

### Backend: capas estándar Gin, sin framework de inyección de dependencias

`cmd/api/main.go` conecta la DB, corre migraciones y construye el router.
`internal/router/router.go` es el único lugar donde se cablean rutas —
inyecta `*sql.DB` y `config.Config` directo en cada handler (sin interfaces
de repositorio ni capa de servicio separada). Los handlers hacen SQL
inline con `database/sql`. Grupos de rutas en `/api/v1`:

- Públicas: `POST /auth/register`, `POST /auth/login`, `GET /cells`.
- Autenticadas (`middleware.RequireAuth`, JWT en header `Authorization: Bearer`):
  `GET /me`, `POST /reports`.
- Admin (además `middleware.RequireAdmin`, chequea claim `role` del JWT):
  `GET /admin/reports`, `PATCH /admin/reports/:id`, `GET /admin/export.csv`.

### El dato clave: `reports` (historial) vs `cell_agg` (materializada, lo que ve el público)

Cada envío de reporte queda como fila permanente en `reports` con estado
`pending`. Solo cuando un admin hace `PATCH /admin/reports/:id` con
`approved`/`rejected` (`AdminHandler.ReviewReport` en `admin_handler.go`),
el backend recalcula `cell_agg` para esa celda H3 en
`recomputeCellAggregate` — promedia `signal_quality` de los reportes
aprobados de esa celda a un `score_pct` 0-100, o borra la fila si ya no
queda ninguno aprobado. `GET /cells` (consumido por el mapa) lee
únicamente `cell_agg`, nunca agrega en caliente sobre `reports`. Si tocas
la lógica de scoring o agregación, este es el único punto de recálculo —
no hay triggers de SQLite ni cron.

### H3 siempre se recalcula en el servidor

`internal/h3util/h3.go` es la única fuente de verdad para resolver
lat/lon → índice H3. `ReportHandler.Create` nunca confía en un
`h3_index` que pudiera mandar el cliente: siempre llama
`h3util.CellFromLatLon` con la resolución de `Config.H3Resolution`
(env `H3_RESOLUTION`, default 8). Entrada acepta coords O plus code
(`open-location-code`), nunca ambos — `ResolveLatLon` decide cuál usar.

### Sin extensión espacial en SQLite — geometría como texto plano

`cell_agg.geom_wkt` es un `TEXT` con un `POLYGON((lon lat, ...))`
calculado en Go desde el boundary del hexágono H3
(`h3util.CellBoundaryWKT`), no una columna espacial de SQLite. Solo se
usa para `GET /admin/export.csv` (para quien necesite abrir las celdas en
QGIS vía "Añadir capa de texto delimitado"). El mapa Leaflet en el
frontend recalcula el boundary del hexágono client-side con `h3-js`
(`h3.cellToBoundary`), no consume `geom_wkt`.

### Migraciones

`internal/db/migrations/*.sql` se embeben con `//go:embed` y se aplican
en orden alfabético en cada arranque (`db.Migrate`), sin tabla de versión
ni framework de migraciones — cada archivo debe ser idempotente
(`CREATE TABLE IF NOT EXISTS`). Nueva migración = nuevo archivo numerado
`000N_*.sql`.

### Frontend: sin build de componentes, JS vanilla por página

Cada `.astro` en `src/pages/` es una página standalone con su propio
`<script type="module">` inline que manipula el DOM directamente (sin
React/Vue/frameworks de UI). `src/lib/api.ts` es el único cliente HTTP
compartido — centraliza `fetch`, agrega el JWT desde `localStorage`
(`token`/`role`) y lanza en cualquier respuesta no-2xx. Auth state vive
solo en `localStorage`, chequeado ad-hoc al inicio del script de cada
página (`reportar.astro` y `admin/index.astro` redirigen si falta
token/role). `PUBLIC_API_URL` se inyecta en build time (Astro
`import.meta.env`), fijado por Docker build arg en producción.

### Actualización del mapa es manual, no reactiva

`index.astro` carga celdas una vez al entrar y de nuevo solo al pulsar
"Actualizar mapa" (`btn-refresh`) — deliberadamente sin WebSocket ni
polling.

### Acotamiento geográfico

El mapa Leaflet está fijado a Santander/Bucaramanga (`maxBounds`,
`minZoom=9`, `maxZoom=14`) — es un mapa de referencia regional, no de
navegación general; cualquier cambio a bounds/zoom en `index.astro` debe
respetar ese propósito.
