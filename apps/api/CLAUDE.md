# CLAUDE.md — apps/api

Guía específica del backend (Go). Ver también el `CLAUDE.md` raíz del
repo para contexto general y la política de preservación de datos.

## Commands

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

## Architecture

### Capas estándar Gin, sin framework de inyección de dependencias

`cmd/api/main.go` conecta la DB, corre migraciones y construye el router.
`internal/router/router.go` es el único lugar donde se cablean rutas —
inyecta `*sql.DB` y `config.Config` directo en cada handler (sin interfaces
de repositorio ni capa de servicio separada). Los handlers hacen SQL
inline con `database/sql`. Grupos de rutas en `/api/v1`:

- Públicas: `POST /auth/register`, `POST /auth/login`,
  `POST /auth/invite-codes/validate`, `GET /cells`.
- Autenticadas (`middleware.RequireAuth`, JWT en header `Authorization: Bearer`):
  `GET /me`, `POST /reports`.
- Admin (además `middleware.RequireAdmin`, chequea claim `role` del JWT):
  `GET /admin/reports`, `PATCH /admin/reports/:id`, `GET /admin/export.csv`,
  `POST /admin/invite-codes`, `GET /admin/invite-codes`,
  `PATCH /admin/cells/:h3_index/score`, `DELETE /admin/cells/:h3_index/score`.

### Registro por invitación, no abierto

`POST /auth/register` exige un `invite_code` válido (8 chars, un solo
uso, TTL 72h) — no existe registro walk-in. `InviteHandler.Generate`
(admin-only) crea códigos; `InviteHandler.Validate` (público) los
pre-valida sin consumirlos, para que el form de `/register` muestre los
campos de cuenta solo después de un código bueno. El consumo real pasa
dentro de la misma transacción que el `INSERT INTO users` en
`AuthHandler.Register` (`UPDATE ... WHERE used_at IS NULL`) — evita que
dos registros concurrentes gasten el mismo código dos veces. Además hay
un honeypot (`website`, campo oculto fuera de pantalla en el form real)
y rate limiting por IP en memoria (`middleware.RateLimit`, sin Redis —
pensado para un solo contenedor) sobre `/auth/*` y de forma más laxa
sobre toda `/api/v1`. `WEB_ORIGIN` (env) reemplaza el viejo
`AllowAllOrigins: true` de CORS; `WEB_ORIGIN=*` es el escape hatch
explícito para dev local.

### Override manual de `score_pct` por un admin — "fijado", no una escritura de una sola vez

`PATCH /admin/cells/:h3_index/score` (`AdminHandler.UpdateCellScore`)
deja que un admin corrija a mano la intensidad de señal mostrada de una
celda (0-100%). No es un simple `UPDATE` puntual: la fila se guarda en
`cell_overrides` (tabla nueva, no una columna en `cell_agg` — ver
`0004_cell_overrides.sql`) y `recomputeCellAggregate` la respeta en
cada recálculo posterior — aprobar/rechazar otro reporte de esa celda
YA NO pisa el valor fijado, aunque sí sigue actualizando
`report_count`/`last_report_at` con datos reales (son informativos, no
lo que se está corrigiendo). `DELETE /admin/cells/:h3_index/score`
borra el override y fuerza un recálculo inmediato — puede hacer
desaparecer la celda del mapa si no le quedan reportes aprobados
reales, mismo comportamiento que si nunca hubiera tenido override.

### `plus_code` en `cell_agg`: calculado al servir, no una columna

Cada fila de `GET /cells` incluye `plus_code` — el plus code (nivel 10)
del **centro geográfico de la celda H3**, no el de ningún reporte en
particular (una celda puede tener reportes aprobados en varias
ubicaciones/plus codes distintos, ver `GET /cells/:h3/origins`, así que
no hay un origen "canónico" entre ellos). Se calcula al vuelo en
`CellHandler.List` vía `h3util.CellPlusCode` (puro, determinístico a
partir del h3_index) — no vive en la tabla `cell_agg`. Es más fácil de
recordar/tipear que un h3_index, así que la tabla "Celdas activas" de
`/admin` lo usa como campo de filtro.

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
