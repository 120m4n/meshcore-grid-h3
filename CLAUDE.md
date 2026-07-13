# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mapa de disponibilidad de red MeshCore en Santander (Colombia): celdas H3
coloreadas por calidad de señal, alimentadas por reportes de usuarios
moderados por administradores. Monorepo con dos apps independientes
(`apps/api` en Go, `apps/web` en Astro) más `infra/` para el despliegue
conjunto vía Docker Compose.

## Preservación de datos — no negociable

Cualquier cambio (migraciones, refactors de esquema, scripts de
mantenimiento, cambios de formato de fechas u otros campos, etc.) debe
preservar los datos ya existentes en `infra/data/meshcore.db`. Nada de
pérdida ni corrupción de datos reales, ni siquiera temporal.

En la práctica:

- Las migraciones (`internal/db/migrations/*.sql`) son siempre aditivas
  e idempotentes (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD
  COLUMN` con guarda) — nunca un `DROP`/`DELETE`/reescritura destructiva
  de una tabla con filas existentes sin antes respaldarlas.
- Si un cambio requiere transformar datos ya guardados (p.ej. un formato
  de fecha), la migración/script debe reescribir las filas existentes al
  nuevo formato, no limitarse a cambiar el `DEFAULT` para las filas
  nuevas dejando las viejas inconsistentes.
- Antes de cualquier operación irreversible sobre `infra/data/meshcore.db`
  (en local o en el host de producción), sacar una copia
  (`cp meshcore.db meshcore.db.bak-$(date +%Y%m%d%H%M%S)`) y confirmarlo
  explícitamente en la conversación antes de proceder.
- Ante la duda entre una solución que toca datos ya persistidos y una
  que no, preferir la que no los toca (ver el fix de zona horaria: se
  resolvió en el frontend, sin migrar filas existentes).

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

Crear el primer admin (no existe endpoint de promoción, es deliberado).
El registro requiere un `invite_code` válido en `invite_codes` — para el
primerísimo usuario, ese código no lo generó ningún admin (todavía no
existe ninguno), así que se inserta a mano una sola vez:

```bash
sqlite3 infra/data/meshcore.db \
  "INSERT INTO invite_codes (code, created_by, expires_at)
   VALUES ('BOOTSTRAP', 'system', datetime('now', '+1 day'));"
```

Registrarse en `/register` con ese código (`BOOTSTRAP`, sin distinguir
mayúsculas/minúsculas), y luego promoverlo:

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'tu-email@dominio.com';"
```

Cualquier admin generado a partir de ahí ya puede generar sus propios
códigos desde `/admin` — no hace falta repetir el insert manual salvo
para ese primer usuario.

Si el contenedor `api` ya estaba corriendo cuando corriste el `UPDATE`, el
login puede seguir devolviendo el rol viejo por un rato: el bind mount
de SQLite con Docker Desktop no siempre refleja escrituras hechas desde
el host a una conexión ya abierta dentro del contenedor. `docker restart
infra-api-1` (o `docker compose restart api`) fuerza a reabrir el
archivo y ver el cambio.

Esta misma inconsistencia se observó una vez justo después de un
`docker restart infra-api-1` en una ruta de escritura normal de la API
(no solo en un `UPDATE` hecho desde el host): la primera petición
devolvió 500 y la segunda, idéntica, funcionó. No es exclusivo del flujo
de promoción de admin — si una escritura falla inmediatamente después de
un restart del contenedor `api`, reintentar antes de asumir un bug de
lógica.

### nginx: rutas limpias necesitan `apps/web/nginx.conf` propio

Astro genera cada página como carpeta (`/login/index.html`,
`/register/index.html`, etc). El `default.conf` de la imagen base
`nginx:1.27-alpine` no trae `try_files`: al pedir `/login` (sin slash)
nginx lo resuelve como directorio y responde **301** a `/login/` usando
`$host`, que en nginx nunca incluye el puerto. En un host expuesto en
puerto no estándar (p.ej. `localhost:8081`) el navegador termina
siguiendo el redirect a `http://localhost/login/` (puerto 80 implícito)
y no resuelve — se ve como si la ruta directa/reload no funcionara.
`apps/web/nginx.conf` (copiado a `/etc/nginx/conf.d/default.conf` en el
Dockerfile) usa `try_files $uri $uri.html $uri/index.html =404;` para
servir el archivo directo sin pasar por ese redirect. Si agregás rutas
nuevas o cambiás el output de Astro, verificá con `curl -I` que no
vuelva un 301 con puerto faltante en el `Location`.

## Architecture

### Backend: capas estándar Gin, sin framework de inyección de dependencias

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

### Referencia visual: `image_mock_base.png`

`image_mock_base.png` (raíz del repo) es un mockup de **orientación**
de cómo se ve la app con un mapa base tipo satélite (hexágonos H3
coloreados por señal sobre imagería satelital, leyenda de cobertura,
branding MeshCore). Es guía de estilo/composición, no el objetivo
pixel-perfect a replicar — no implica que el mapa base actual (tiles
OSM estándar) deba cambiar a satélite salvo que se pida explícitamente.
