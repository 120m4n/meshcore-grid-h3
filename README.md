# MeshCore Map — Santander

Mapa de disponibilidad de red MeshCore usando celdas H3, con reportes de
conectividad enviados por usuarios y moderados por administradores.

## Stack

- **Frontend**: Astro (build estático) + Leaflet + h3-js, servido con nginx.
- **Backend**: Go + Gin, JWT (golang-jwt), bcrypt, h3-go/v4, open-location-code (plus codes).
- **DB**: SQLite plano (archivo único, sin extensiones espaciales, sin servicio de red separado).
- **Infra**: Docker Compose + Traefik (labels incluidas, reemplazar hosts).

## Arranque local (desarrollo)

```bash
# Backend
cd apps/api
go mod tidy        # requiere acceso a proxy.golang.org
DB_PATH=./meshcore.db go run ./cmd/api

# Frontend
cd apps/web
npm install
npm run dev
```

Backend por defecto en `:8080`, frontend en `:4321`
(`PUBLIC_API_URL=http://localhost:8080` en `apps/web/.env`).

## Despliegue (docker-compose)

```bash
cd infra
cp .env.example .env    # editar JWT_SECRET, PUBLIC_API_URL, dominios
docker compose up -d --build
```

Esto levanta `api` y `web`. El backend, al arrancar, ejecuta las
migraciones embebidas (`internal/db/migrate.go`) — no hay paso manual
de init de DB.

El archivo `meshcore.db` queda en `infra/data/meshcore.db` en el host
(bind mount, no volumen anónimo).

### Ver las celdas en QGIS (solo si hace falta)

La base operativa no tiene extensión espacial — es una decisión
deliberada para mantener el build liviano y sin fricciones. La columna
`geom_wkt` en `cell_agg` guarda el polígono como texto plano
(`POLYGON((lon lat, ...))`), calculado desde el boundary de H3 en Go.

Cuando alguien realmente necesite verlo en QGIS:

1. `GET /api/v1/admin/export.csv` (requiere JWT de admin) descarga un CSV
   con columnas `h3_index, score_pct, report_count, last_report_at, WKT`.
2. En QGIS: `Capa → Añadir capa → Añadir capa de texto delimitado...`
3. Seleccionar el CSV, tipo de geometría "Geometría WKT", campo `WKT`.

Sin tocar el motor de datos operativo ni añadir dependencias al backend.

### Crear el primer admin

No hay endpoint de "promover a admin" (decisión deliberada: evitar
escalación de privilegios vía API). Tras registrar un usuario normal:

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'tu-email@dominio.com';"
```

## Decisiones de diseño (resumen)

- **Resolución H3 = 8** (configurable vía `H3_RESOLUTION`), coherente con
  celdas de ejemplo tipo `8866089b05fffff`.
- El **h3_index se recalcula siempre en el backend**, nunca se confía en
  el valor que pudiera mandar el cliente.
- **Historial completo de reportes**: cada envío queda como fila; al
  aprobar/rechazar, el backend recalcula una tabla materializada
  (`cell_agg`, con `geom_wkt` como texto plano) para esa celda — el mapa
  público lee esa tabla, no agrega en caliente sobre `reports`. Sin
  extensión espacial: el WKT se genera en Go desde el boundary de H3 y
  solo se usa si alguien exporta a QGIS.
- **Moderación**: todo reporte nace `pending`; solo un admin cambia el
  estado a `approved`/`rejected` vía `PATCH /api/v1/admin/reports/:id`.
- **Actualización del mapa**: manual (botón "Actualizar mapa" + carga
  inicial), sin WebSocket, según lo definido contigo.
- **Acotamiento geográfico**: `maxBounds` a la caja de Santander,
  `minZoom=9`, `maxZoom=14`, centrado en Bucaramanga — mapa de referencia,
  no de navegación.

## Pendientes / siguientes pasos sugeridos

- Rate limiting en `POST /reports` (evitar spam de un mismo usuario/celda).
- Backup del `.db`: al ser archivo único, un cron simple con `sqlite3 .backup`
  (o copiar el archivo en modo WAL checkpoint) es suficiente — no requiere
  herramientas de replicación como con Postgres.
- Tests de integración para `h3util` (casos borde de plus codes cortos).
- Panel admin: filtros por celda/fecha, no solo `pending`.
- Alinear con tu stack habitual: CrowdSec + Authelia delante de Traefik,
  Grafana/Loki para observabilidad del API.
