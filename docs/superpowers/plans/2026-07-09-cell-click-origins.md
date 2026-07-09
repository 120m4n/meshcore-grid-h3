# Áreas de plus code al hacer click en una celda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Al hacer click en una celda H3 real del mapa público, dibujar
las áreas de plus code (nivel 10, ~13m) que originaron sus reportes
aprobados, deduplicadas por área.

**Architecture:** Un endpoint público nuevo `GET /api/v1/cells/:h3_index/origins`
lee `reports.lat`/`lon` de los reportes aprobados de esa celda, calcula
el plus code nivel 10 de cada uno con la librería OLC ya presente en el
proyecto, deduplica por código y devuelve el bounding box de cada área
única. El frontend dispara esta consulta en el mismo click que ya abre
el popup de score, y dibuja un rectángulo Leaflet por área en una capa
dedicada que se reemplaza en cada click.

**Tech Stack:** Go 1.22 + Gin + `database/sql` + `github.com/google/open-location-code/go`
(ya es dependencia — no se agrega nada nuevo) en `apps/api`; Astro 4 +
TypeScript + Leaflet en `apps/web`.

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-09-cell-click-origins-design.md`.
- Endpoint **público, sin auth** — decisión explícita del brainstorming, no
  agregar `RequireAuth`/`RequireAdmin`.
- El nivel 10 se calcula **siempre desde `reports.lat`/`reports.lon`**,
  nunca desde `input_raw`, sin importar `input_method`.
- No hay "reporte ganador" por celda — se devuelven **todas las áreas
  únicas**, deduplicadas por código de plus code.
- Sin metadata agregada por área (sin conteo de reportes colapsados).
- No se agrega ninguna dependencia nueva a `go.mod` ni a `package.json`
  — `github.com/google/open-location-code/go` (`olc.Encode`/`olc.Decode`)
  ya está vendorizada y en uso (`apps/api/internal/h3util/h3.go`).
- No hay suite de tests automatizada en este proyecto (ver `CLAUDE.md` /
  el plan anterior de esta serie) — verificación manual con curl y
  navegador headless, mismo patrón ya establecido.
- Sin migraciones nuevas: el schema no cambia.

---

### Task 1: Backend — endpoint `GET /cells/:h3_index/origins`

**Files:**
- Modify: `apps/api/internal/models/models.go` (agregar struct `CellOrigin` al final del archivo)
- Modify: `apps/api/internal/handlers/cell_handler.go` (agregar método `Origins` e import de `olc`)
- Modify: `apps/api/internal/router/router.go:34` (agregar la ruta nueva, pública, junto a `GET /cells`)

**Interfaces:**
- Consumes: `olc.Encode(lat, lng float64, codeLen int) string` y `olc.Decode(code string) (olc.CodeArea, error)` con `CodeArea{LatLo, LngLo, LatHi, LngHi float64; Len int}` — ambos ya existen en `github.com/google/open-location-code/go`, usados hoy en `apps/api/internal/h3util/h3.go` (import como `olc "github.com/google/open-location-code/go"`).
- Produces: `func (h *CellHandler) Origins(c *gin.Context)` — responde `200 []models.CellOrigin` (array vacío si no hay reportes aprobados para ese `h3_index`). `models.CellOrigin{PlusCode string; LatLo, LatHi, LngLo, LngHi float64}` con tags JSON `plus_code`, `lat_lo`, `lat_hi`, `lng_lo`, `lng_hi` — Task 2 replica estos mismos nombres de campo en el cliente TypeScript.

- [ ] **Step 1: Agregar el struct `CellOrigin` a `models.go`**

Al final de `apps/api/internal/models/models.go`, después de `CreateReportInput`:

```go
type CellOrigin struct {
	PlusCode string  `json:"plus_code"`
	LatLo    float64 `json:"lat_lo"`
	LatHi    float64 `json:"lat_hi"`
	LngLo    float64 `json:"lng_lo"`
	LngHi    float64 `json:"lng_hi"`
}
```

- [ ] **Step 2: Implementar `Origins` en `cell_handler.go`**

Reemplazar el contenido completo de `apps/api/internal/handlers/cell_handler.go`:

```go
package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	olc "github.com/google/open-location-code/go"

	"meshcore-map/api/internal/models"
)

type CellHandler struct {
	DB *sql.DB
}

func (h *CellHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT h3_index, score_pct, report_count, last_report_at
		FROM cell_agg
		ORDER BY h3_index
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar celdas"})
		return
	}
	defer rows.Close()

	cells := []models.CellAggregate{}
	for rows.Next() {
		var cell models.CellAggregate
		if err := rows.Scan(&cell.H3Index, &cell.ScorePct, &cell.ReportCount, &cell.LastReportAt); err != nil {
			continue
		}
		cells = append(cells, cell)
	}

	c.JSON(http.StatusOK, cells)
}

// Origins devuelve las áreas de plus code (nivel 10, ~13m) que
// originaron los reportes aprobados de una celda, deduplicadas por
// código — si dos reportes caen en el mismo código de 10 dígitos
// (ej. mismo edificio), se cuentan una sola vez. Siempre se calcula
// desde reports.lat/lon, nunca desde input_raw, sin importar
// input_method: reports.lat/lon existen para el 100% de los reportes
// (se resuelven al guardar, ver ReportHandler.Create).
func (h *CellHandler) Origins(c *gin.Context) {
	h3Index := c.Param("h3_index")

	rows, err := h.DB.Query(`
		SELECT lat, lon FROM reports
		WHERE h3_index = ? AND status = 'approved'
	`, h3Index)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar los orígenes de la celda"})
		return
	}
	defer rows.Close()

	seen := map[string]struct{}{}
	origins := []models.CellOrigin{}
	for rows.Next() {
		var lat, lon float64
		if err := rows.Scan(&lat, &lon); err != nil {
			continue
		}
		code := olc.Encode(lat, lon, 10)
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}

		area, err := olc.Decode(code)
		if err != nil {
			continue
		}
		origins = append(origins, models.CellOrigin{
			PlusCode: code,
			LatLo:    area.LatLo,
			LatHi:    area.LatHi,
			LngLo:    area.LngLo,
			LngHi:    area.LngHi,
		})
	}

	c.JSON(http.StatusOK, origins)
}
```

- [ ] **Step 3: Registrar la ruta pública**

En `apps/api/internal/router/router.go`, línea 34, cambiar:

```go
		v1.GET("/cells", cellH.List)
```

por:

```go
		v1.GET("/cells", cellH.List)
		v1.GET("/cells/:h3_index/origins", cellH.Origins)
```

(Se agrega fuera del grupo `authed`, junto a `GET /cells` — pública, sin
auth, por decisión explícita del spec.)

- [ ] **Step 4: Verificar que compila**

```bash
cd apps/api
go build ./... && go vet ./...
```

Expected: sin output, exit code 0.

- [ ] **Step 5: Verificación manual end-to-end con curl**

```bash
cd apps/api
rm -f /tmp/meshcore-origins-test.db
DB_PATH=/tmp/meshcore-origins-test.db go run ./cmd/api &
sleep 2

TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"origintest@example.com","password":"TestPass123!","display_name":"Origin Test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

sqlite3 /tmp/meshcore-origins-test.db "UPDATE users SET role='admin' WHERE email='origintest@example.com';"

ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"origintest@example.com","password":"TestPass123!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

create_and_approve() {
  local lat=$1 lon=$2
  local id=$(curl -s -X POST http://localhost:8080/api/v1/reports \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d "{\"lat\":$lat,\"lon\":$lon,\"signal_quality\":\"buena\",\"message\":\"origin test\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  curl -s -X PATCH http://localhost:8080/api/v1/admin/reports/$id \
    -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -d '{"status":"approved"}' > /dev/null
  echo $id
}

# Punto base
create_and_approve 7.119349 -73.122741
# Punto "cercano" (~3m) — debe caer en el MISMO plus code nivel 10 que el base
create_and_approve 7.119379 -73.122741
# Punto "lejano" (~66m, todavía dentro del mismo hexágono H3 res 8 de ~460m)
# — debe caer en un plus code DISTINTO
create_and_approve 7.119949 -73.122741

H3_INDEX=$(curl -s "http://localhost:8080/api/v1/admin/reports?status=approved" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['h3_index'])")

echo "--- h3_index de los 3 reportes (deben ser iguales) ---"
curl -s "http://localhost:8080/api/v1/admin/reports?status=approved" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c "import sys,json; [print(r['h3_index']) for r in json.load(sys.stdin)]"

echo "--- GET /cells/$H3_INDEX/origins ---"
curl -s "http://localhost:8080/api/v1/cells/$H3_INDEX/origins" \
  | python3 -m json.tool

echo "--- GET sobre un h3_index sin reportes ---"
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:8080/api/v1/cells/8866089b09fffff/origins"

kill %1
rm -f /tmp/meshcore-origins-test.db
```

Expected:
- Los 3 reportes tienen el mismo `h3_index` (confirma que los 3 puntos caen en el mismo hexágono). **Si no coinciden**, es un caso de borde geográfico (el punto cayó justo en el límite de un hexágono) — ajustar los deltas de lat/lon (achicar el del punto "cercano", achicar/mover el del "lejano") y repetir hasta que los 3 coincidan.
- `GET /cells/$H3_INDEX/origins` devuelve un array con **exactamente 2 elementos** (el punto base y el "cercano" colapsan al mismo `plus_code`; el "lejano" es un área distinta). Si devuelve 3, el delta "cercano" fue demasiado grande — achicarlo. Si devuelve 1, el delta "lejano" fue demasiado chico — agrandarlo (sin salirse del mismo `h3_index`).
- Cada elemento tiene `plus_code`, `lat_lo`, `lat_hi`, `lng_lo`, `lng_hi` numéricos, con `lat_lo < lat_hi` y `lng_lo < lng_hi`.
- `GET` sobre un `h3_index` sin reportes: `HTTP 200` con `[]`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/internal/models/models.go apps/api/internal/handlers/cell_handler.go apps/api/internal/router/router.go
git commit -m "$(cat <<'EOF'
feat(api): agregar GET /cells/:h3_index/origins

Devuelve las áreas de plus code nivel 10 que originaron los reportes
aprobados de una celda, deduplicadas por código, siempre calculadas
desde reports.lat/lon. Endpoint público, sin dependencias nuevas.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — cliente HTTP `getCellOrigins`

**Files:**
- Modify: `apps/web/src/lib/api.ts` (agregar interface y función al final del archivo)

**Interfaces:**
- Consumes: `apiFetch(path: string, options: RequestInit)` (ya existe en el mismo archivo).
- Produces: `interface CellOrigin { plus_code: string; lat_lo: number; lat_hi: number; lng_lo: number; lng_hi: number }` y `getCellOrigins(h3Index: string): Promise<CellOrigin[]>` — Task 3 importa ambos.

- [ ] **Step 1: Agregar la interface y la función**

Al final de `apps/web/src/lib/api.ts`:

```ts
export interface CellOrigin {
  plus_code: string;
  lat_lo: number;
  lat_hi: number;
  lng_lo: number;
  lng_hi: number;
}

export function getCellOrigins(h3Index: string): Promise<CellOrigin[]> {
  return apiFetch(`/api/v1/cells/${h3Index}/origins`);
}
```

- [ ] **Step 2: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: termina sin errores.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(web): agregar cliente getCellOrigins al API client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — dibujar las áreas al hacer click en una celda real

**Files:**
- Modify: `apps/web/src/lib/mapPage.ts`

**Interfaces:**
- Consumes: `getCellOrigins(h3Index: string): Promise<CellOrigin[]>` (Task 2), `CellOrigin` (Task 2) — importados desde `./api.ts`. Reutiliza `L` (Leaflet), `map`, y el patrón de capa (`L.layerGroup().addTo(map)`) ya presentes en este archivo.
- Produces: comportamiento en runtime — click en una celda real dibuja rectángulos de sus áreas de origen en una capa `originsLayer`, reemplazando los de la celda anterior; `loadCells()` (llamado por carga inicial y por "Actualizar mapa") también limpia esta capa.

- [ ] **Step 1: Actualizar el import de `api.ts`**

En `apps/web/src/lib/mapPage.ts`, la línea:

```ts
import { getCells } from './api.ts';
```

cambiar por:

```ts
import { getCells, getCellOrigins } from './api.ts';
```

- [ ] **Step 2: Agregar la capa `originsLayer`**

Justo después de la línea existente:

```ts
let cellLayer = L.layerGroup().addTo(map);
let testLayer = L.layerGroup().addTo(map);
```

agregar:

```ts
let originsLayer = L.layerGroup().addTo(map);
```

- [ ] **Step 3: Limpiar `originsLayer` en cada `loadCells()`**

Dentro de `async function loadCells() { ... }`, la línea inicial:

```ts
  cellLayer.clearLayers();
  realIndexes.clear();
```

cambiar por:

```ts
  cellLayer.clearLayers();
  originsLayer.clearLayers();
  realIndexes.clear();
```

- [ ] **Step 4: Agregar la función `showCellOrigins` y conectarla al click**

Dentro de `mapPage.ts`, agregar esta función nueva justo después del cierre de `async function loadCells() { ... }` (antes de la sección `const TEST_STORAGE_KEY = ...`):

```ts
async function showCellOrigins(h3Index: string) {
  originsLayer.clearLayers();
  try {
    const origins = await getCellOrigins(h3Index);
    for (const origin of origins) {
      L.rectangle(
        [
          [origin.lat_lo, origin.lng_lo],
          [origin.lat_hi, origin.lng_hi],
        ],
        { color: '#34d7c0', weight: 2, fillOpacity: 0.25 }
      ).addTo(originsLayer);
    }
  } catch (err) {
    console.error('Error cargando orígenes de la celda:', err);
  }
}
```

Luego, dentro de `loadCells()`, cambiar la línea:

```ts
      polygon.on('click', (e) => L.DomEvent.stopPropagation(e));
```

por:

```ts
      polygon.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        showCellOrigins(cell.h3_index);
      });
```

(Esta línea vive dentro del `for (const cell of cells)` de `loadCells()` — `cell.h3_index` ya está en scope, es el mismo identificador que usa el resto del bloque para `realIndexes.add`, `cellToBoundary`, etc.)

- [ ] **Step 5: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/mapPage.ts
git commit -m "$(cat <<'EOF'
feat(web): dibujar áreas de plus code al hacer click en una celda

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Verificación end-to-end completa (Docker Compose + navegador)

**Files:** ninguno (solo verificación, sin cambios de código).

- [ ] **Step 1: Rebuild y levantar el stack completo**

```bash
cd infra
docker compose down
docker compose up -d --build
```

Expected: `infra-api-1` y `infra-web-1` corriendo.

- [ ] **Step 2: Crear datos de prueba (3 reportes: 2 colapsan, 1 distinto)**

Repetir el flujo del Task 1 / Step 5 contra `http://localhost:8080`
(el puerto publicado por `infra/docker-compose.yml`), usando la cuenta
de prueba documentada en `docs/MANUAL_TESTING.md`
(`plantest@example.com` / `TestPass123!`) en vez de crear una nueva. Si
la cuenta ya existe y ya es admin, solo hace falta loguearse
(`POST /auth/login`) para obtener el token — no volver a registrar.

- [ ] **Step 3: Verificación visual en navegador headless**

```bash
node -e "
const { chromium } = require('/Users/120m4n/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BASE = 'http://localhost:8081';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Click en la celda de prueba (ajustar coordenadas de pantalla si el mapa cambió de zoom/centro)
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-120m4n-GitHub-meshcore-grid-h3/f255e364-0819-4eae-adcd-f9245ffa80d3/scratchpad/origins_click1.png', fullPage: true });

  await browser.close();
})();
"
```

Expected: el screenshot muestra, dentro del hexágono clickeado, uno o
más rectángulos finos de borde teal (`#34d7c0`) además del popup de
score que ya existía. Si el click no cae sobre una celda real (el mapa
no tiene datos ahí), ajustar las coordenadas de `page.mouse.click` para
apuntar al hexágono creado en el Step 2, o usar
`page.evaluate` para disparar el evento `click` de Leaflet directamente
sobre el polígono conocido.

- [ ] **Step 4: Confirmar que "Actualizar mapa" limpia las áreas**

```bash
node -e "
const { chromium } = require('/Users/120m4n/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BASE = 'http://localhost:8081';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForTimeout(800);
  await page.click('#btn-refresh');
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-120m4n-GitHub-meshcore-grid-h3/f255e364-0819-4eae-adcd-f9245ffa80d3/scratchpad/origins_after_refresh.png', fullPage: true });
  await browser.close();
})();
"
```

Expected: el screenshot ya no muestra los rectángulos teal (la capa
`originsLayer` se limpió en `loadCells()`).

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-3.
