# Eliminar celda activa del mapa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que un admin elimine del mapa público una celda H3 ya
activa, revocando en bulk sus reportes aprobados.

**Architecture:** Un endpoint nuevo `DELETE /api/v1/admin/cells/:h3_index`
revoca (`status='rejected'`) todos los reportes `approved` de esa celda y
reutiliza la función `recomputeCellAggregate` ya existente (que borra la
fila de `cell_agg` cuando el conteo de aprobados llega a 0). El admin
consume esto desde una tabla nueva "Celdas activas" en `/admin`, poblada
con el `GET /cells` público que ya existe — no hace falta un GET nuevo.

**Tech Stack:** Go 1.22 + Gin + `database/sql` (mattn/go-sqlite3) en
`apps/api`; Astro 4 + TypeScript vanilla (sin framework de UI) en
`apps/web`.

## Global Constraints

- Spec de referencia: `docs/superpowers/specs/2026-07-09-delete-active-cell-design.md`.
- No hay suite de tests automatizada en este proyecto (`go test ./...`
  no encuentra nada útil; `package.json` no tiene tests configurados —
  ver `CLAUDE.md`). Este plan usa **verificación manual con curl y
  navegador headless** en vez de tests automatizados, siguiendo el
  patrón ya establecido en el resto del proyecto. No introducir un
  framework de testing nuevo como parte de esta feature (fuera de
  alcance).
- Sin migraciones nuevas: el schema no cambia.
- Sin sistema de puntos: `score_pct` sigue siendo el promedio actual sin
  ningún cambio de cálculo.
- Todo el código nuevo sigue el estilo y los patrones exactos ya
  existentes en cada archivo tocado (mismo estilo de manejo de errores
  en Go, mismo patrón `tbody`/`load()` en TypeScript).

---

### Task 1: Backend — endpoint `DELETE /admin/cells/:h3_index`

**Files:**
- Modify: `apps/api/internal/handlers/admin_handler.go` (agregar método `DeleteCell` al final del archivo, después de `recomputeCellAggregate`)
- Modify: `apps/api/internal/router/router.go:20` (agregar `"DELETE"` a `AllowMethods` de CORS)
- Modify: `apps/api/internal/router/router.go:47` (agregar la ruta nueva al grupo `admin`)

**Interfaces:**
- Consumes: `recomputeCellAggregate(sqlDB *sql.DB, h3Index string) error` (ya existe en `admin_handler.go`, sin cambios).
- Produces: `func (h *AdminHandler) DeleteCell(c *gin.Context)` — responde `200 {"h3_index": string, "reports_revoked": int64}` en éxito, `404 {"error": string}` si no había reportes aprobados para ese `h3_index`, `500 {"error": string}` en fallo de la query de revocación.

- [ ] **Step 1: Levantar el servidor y confirmar que la ruta no existe todavía**

```bash
cd apps/api
DB_PATH=/tmp/meshcore-plan-test.db go run ./cmd/api &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:8080/api/v1/admin/cells/8866089b05fffff
```

Expected: `404` (gin responde 404 porque la ruta no está registrada — es
el mismo 404 genérico de Gin, no el de nuestro handler todavía).

```bash
kill %1
```

- [ ] **Step 2: Implementar `DeleteCell` en `admin_handler.go`**

Agregar al final del archivo (después del cierre de `recomputeCellAggregate`, antes de `ExportCSV` o después — el orden en el archivo no importa, colocarlo después de `recomputeCellAggregate` mantiene el código de esta feature junto):

```go
// DeleteCell revoca todos los reportes aprobados de una celda H3,
// dejándola sin reportes aprobados. recomputeCellAggregate se encarga
// de borrar la fila de cell_agg cuando el conteo llega a 0 — mismo
// mecanismo que ya dispara ReviewReport, sin lógica de agregación nueva.
func (h *AdminHandler) DeleteCell(c *gin.Context) {
	h3Index := c.Param("h3_index")
	adminID, _ := c.Get("user_id")

	res, err := h.DB.Exec(`
		UPDATE reports
		SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
		WHERE h3_index = ? AND status = 'approved'`, adminID, h3Index)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo revocar los reportes de la celda"})
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "no hay celda activa con ese h3_index"})
		return
	}

	if err := recomputeCellAggregate(h.DB, h3Index); err != nil {
		c.JSON(http.StatusOK, gin.H{
			"h3_index": h3Index, "reports_revoked": n,
			"warning": "reportes revocados, pero falló el recálculo de la celda: " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"h3_index": h3Index, "reports_revoked": n})
}
```

- [ ] **Step 3: Registrar la ruta y habilitar DELETE en CORS**

En `apps/api/internal/router/router.go`, línea 20, cambiar:

```go
		AllowMethods:    []string{"GET", "POST", "PATCH", "OPTIONS"},
```

por:

```go
		AllowMethods:    []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
```

En el mismo archivo, dentro del bloque `admin { ... }` (línea 44-48), agregar la ruta nueva después de `ExportCSV`:

```go
			{
				admin.GET("/reports", adminH.ListReports)
				admin.PATCH("/reports/:id", adminH.ReviewReport)
				admin.GET("/export.csv", adminH.ExportCSV)
				admin.DELETE("/cells/:h3_index", adminH.DeleteCell)
			}
```

- [ ] **Step 4: Verificar que compila**

```bash
cd apps/api
go build ./... && go vet ./...
```

Expected: sin output, exit code 0.

- [ ] **Step 5: Verificación manual end-to-end con curl**

```bash
cd apps/api
rm -f /tmp/meshcore-plan-test.db
DB_PATH=/tmp/meshcore-plan-test.db go run ./cmd/api &
sleep 2

# Registrar usuario y quedarse con su token
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest@example.com","password":"TestPass123!","display_name":"Plan Test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Promover a admin directo en la DB de prueba
sqlite3 /tmp/meshcore-plan-test.db "UPDATE users SET role='admin' WHERE email='plantest@example.com';"

# Re-loguear para que el JWT lleve role=admin
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"plantest@example.com","password":"TestPass123!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Crear un reporte (coords en Bucaramanga) y aprobarlo
REPORT_ID=$(curl -s -X POST http://localhost:8080/api/v1/reports \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"lat":7.119349,"lon":-73.122741,"signal_quality":"buena","message":"prueba plan"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

H3_INDEX=$(curl -s http://localhost:8080/api/v1/admin/reports?status=pending \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['h3_index'])")

curl -s -X PATCH http://localhost:8080/api/v1/admin/reports/$REPORT_ID \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"status":"approved"}'

echo "--- GET /cells antes del delete ---"
curl -s http://localhost:8080/api/v1/cells

echo "--- DELETE /admin/cells/$H3_INDEX ---"
curl -s -w "\nHTTP %{http_code}\n" -X DELETE \
  http://localhost:8080/api/v1/admin/cells/$H3_INDEX \
  -H "Authorization: Bearer $ADMIN_TOKEN"

echo "--- GET /cells después del delete ---"
curl -s http://localhost:8080/api/v1/cells

echo "--- GET /admin/reports?status=rejected ---"
curl -s "http://localhost:8080/api/v1/admin/reports?status=rejected" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

echo "--- DELETE de nuevo sobre la misma celda (ya sin aprobados) ---"
curl -s -w "\nHTTP %{http_code}\n" -X DELETE \
  http://localhost:8080/api/v1/admin/cells/$H3_INDEX \
  -H "Authorization: Bearer $ADMIN_TOKEN"

kill %1
rm -f /tmp/meshcore-plan-test.db
```

Expected:
- `GET /cells` antes del delete: array con 1 elemento, `h3_index` igual a `$H3_INDEX`.
- `DELETE`: `HTTP 200` con `{"h3_index":"...","reports_revoked":1}`.
- `GET /cells` después del delete: `[]`.
- `GET /admin/reports?status=rejected`: incluye el reporte con `id=$REPORT_ID`.
- Segundo `DELETE`: `HTTP 404` con `{"error":"no hay celda activa con ese h3_index"}`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/internal/handlers/admin_handler.go apps/api/internal/router/router.go
git commit -m "$(cat <<'EOF'
feat(api): agregar DELETE /admin/cells/:h3_index

Revoca en bulk los reportes aprobados de una celda H3 y reutiliza
recomputeCellAggregate existente para que desaparezca de cell_agg,
sin cambiar el modelo de agregación actual.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Frontend — cliente HTTP `deleteCell`

**Files:**
- Modify: `apps/web/src/lib/api.ts` (agregar función al final del archivo)

**Interfaces:**
- Consumes: `apiFetch(path: string, options: RequestInit)` (ya existe en el mismo archivo).
- Produces: `deleteCell(h3Index: string): Promise<{h3_index: string; reports_revoked: number}>`.

- [ ] **Step 1: Agregar la función**

Al final de `apps/web/src/lib/api.ts`, después de `reviewReport`:

```ts
export function deleteCell(h3Index: string) {
  return apiFetch(`/api/v1/admin/cells/${h3Index}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: Verificar que compila**

```bash
cd apps/web
npx tsc --noEmit
```

Expected: sin errores. (Si `tsc --noEmit` falla por falta de config de proyecto standalone, usar `npm run build` en su lugar y confirmar que termina sin errores de tipo.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(web): agregar cliente deleteCell al API client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — markup de la tabla "Celdas activas" + estilo de botón destructivo

**Files:**
- Modify: `apps/web/src/pages/admin/index.astro`
- Modify: `apps/web/src/styles/global.css` (agregar `.btn-danger` después de `.btn-secondary`, línea 322)

**Interfaces:**
- Produces: elementos DOM `#cells-table` (con `<tbody>` vacío) y `#cells-status`, que Task 4 puebla. Clase CSS `.btn-danger` para el botón "Eliminar" de cada fila.

- [ ] **Step 1: Actualizar `admin/index.astro`**

Reemplazar el contenido completo del archivo:

```astro
---
import '../../styles/global.css';
---
<html lang="es">
<head><meta charset="UTF-8" /><title>Moderación — MeshCore Santander</title></head>
<body>
  <header class="topbar">
    <h1>Moderación</h1>
    <nav><a href="/">Volver al mapa</a></nav>
  </header>

  <main>
    <h2>Reportes pendientes</h2>
    <table id="reports-table">
      <thead>
        <tr>
          <th>Celda H3</th><th>Quién reporta</th><th>Calidad</th>
          <th>Mensaje</th><th>Fecha</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <p id="status"></p>

    <h2>Celdas activas</h2>
    <table id="cells-table">
      <thead>
        <tr>
          <th>Celda H3</th><th>Señal</th><th>Reportes</th><th>Última actualización</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <p id="cells-status"></p>
  </main>

  <script src="../../lib/adminPage.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Agregar `.btn-danger` a `global.css`**

En `apps/web/src/styles/global.css`, inmediatamente después del bloque `.btn-secondary:hover { background: rgba(52, 215, 192, 0.12); }` (línea 322), agregar:

```css

/* CTA destructivo: mismo alto/tap-target que btn-secondary, color de
   alerta (mismo token que .signal-pobre en el mapa — reutiliza la
   semántica de color existente, no inventa una nueva). */
.btn-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 0.75rem;
  background: transparent;
  color: var(--signal-pobre);
  border: 1px solid var(--signal-pobre);
  border-radius: 4px;
  padding: 0.6rem 0.9rem;
  min-height: 44px;
  cursor: pointer;
}
.btn-danger:hover { background: rgba(231, 76, 60, 0.12); }
```

- [ ] **Step 3: Verificar que el build de Astro no rompe**

```bash
cd apps/web
npm run build
```

Expected: termina con `dist/` generado, sin errores (los dos `<tbody>` vacíos y `#cells-status` vacío son válidos HTML, Task 4 los llena en runtime).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin/index.astro apps/web/src/styles/global.css
git commit -m "$(cat <<'EOF'
feat(web): agregar markup de tabla "Celdas activas" en /admin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frontend — poblar y wire de la tabla "Celdas activas"

**Files:**
- Modify: `apps/web/src/lib/adminPage.ts`

**Interfaces:**
- Consumes: `getCells()` (ya existe en `api.ts`, devuelve `CellAggregate[]` con `h3_index`, `score_pct`, `report_count`, `last_report_at`), `deleteCell(h3Index: string)` (Task 2), `showToast(message: string, type: 'success'|'error')` (ya existe en `toast.ts`).
- Produces: comportamiento en runtime — al cargar la página, la tabla `#cells-table` se puebla; al hacer clic en "Eliminar" con confirmación, llama `deleteCell` y refresca la tabla.

- [ ] **Step 1: Reemplazar el contenido completo de `adminPage.ts`**

```ts
import { getPendingReports, reviewReport, getCells, deleteCell } from './api.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
const role = localStorage.getItem('role');
if (!token || role !== 'admin') {
  window.location.href = '/';
}

const tbody = document.querySelector('#reports-table tbody')!;
const status = document.getElementById('status')!;

async function load() {
  tbody.innerHTML = '';
  try {
    const reports = await getPendingReports();
    if (reports.length === 0) {
      status.textContent = 'No hay reportes pendientes.';
    }
    for (const r of reports) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.h3_index}</td>
        <td>${r.reporter_display_name || 'Anónimo'} <span class="hint">(cuenta: ${r.reporter_name})</span></td>
        <td>${r.signal_quality}</td>
        <td>${r.message || '-'}</td>
        <td>${new Date(r.created_at).toLocaleString('es-CO')}</td>
        <td>
          <button data-id="${r.id}" data-action="approved">Aprobar</button>
          <button data-id="${r.id}" data-action="rejected">Rechazar</button>
        </td>`;
      tbody.appendChild(tr);
    }
  } catch (err: any) {
    status.textContent = `Error: ${err.message}`;
  }
}

tbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  try {
    await reviewReport(btn.dataset.id!, btn.dataset.action as 'approved' | 'rejected');
    load();
  } catch (err: any) {
    status.textContent = `Error: ${err.message}`;
  }
});

const cellsTbody = document.querySelector('#cells-table tbody')!;
const cellsStatus = document.getElementById('cells-status')!;

async function loadCells() {
  cellsTbody.innerHTML = '';
  try {
    const cells = await getCells();
    cellsStatus.textContent = cells.length === 0 ? 'No hay celdas activas.' : '';
    for (const cell of cells) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${cell.h3_index}</td>
        <td>${Math.round(cell.score_pct)}%</td>
        <td>${cell.report_count}</td>
        <td>${new Date(cell.last_report_at).toLocaleString('es-CO')}</td>
        <td><button class="btn-danger" data-h3="${cell.h3_index}">Eliminar</button></td>`;
      cellsTbody.appendChild(tr);
    }
  } catch (err: any) {
    cellsStatus.textContent = `Error: ${err.message}`;
  }
}

cellsTbody.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const h3Index = btn.dataset.h3!;
  if (!confirm(`¿Eliminar la celda ${h3Index} del mapa? Los reportes aprobados quedarán marcados como rechazados.`)) {
    return;
  }
  try {
    await deleteCell(h3Index);
    showToast('Celda eliminada del mapa.', 'success');
    loadCells();
  } catch (err: any) {
    showToast(err.message || 'No se pudo eliminar la celda.', 'error');
  }
});

load();
loadCells();
```

- [ ] **Step 2: Verificar que compila**

```bash
cd apps/web
npm run build
```

Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/adminPage.ts
git commit -m "$(cat <<'EOF'
feat(web): poblar tabla "Celdas activas" y wire de eliminación

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Verificación end-to-end completa (Docker Compose + navegador)

**Files:** ninguno (solo verificación, sin cambios de código).

- [ ] **Step 1: Rebuild y levantar el stack completo**

```bash
cd infra
docker compose down
docker compose up -d --build
```

Expected: `infra-api-1` y `infra-web-1` corriendo (`docker compose ps` muestra ambos `Up`).

- [ ] **Step 2: Crear datos de prueba end-to-end**

Repetir el flujo del Task 1 / Step 5 pero contra `http://localhost:8080`
(el puerto publicado por `infra/docker-compose.yml`) en vez de un
`go run` local, y promoviendo el admin con:

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'plantest@example.com';"
docker restart infra-api-1
```

(el restart es necesario por la inconsistencia de bind-mount de SQLite
con Docker Desktop en macOS, documentada en `CLAUDE.md`).

- [ ] **Step 3: Verificación visual en navegador headless**

```bash
node -e "
const { chromium } = require('/Users/120m4n/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BASE = 'http://localhost:8081';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.fill('#email', 'plantest@example.com');
  await page.fill('#password', 'TestPass123!');
  await page.click('button[type=submit]');
  await page.waitForURL(BASE + '/', { timeout: 10000 });
  await page.goto(BASE + '/admin', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-120m4n-GitHub-meshcore-grid-h3/f255e364-0819-4eae-adcd-f9245ffa80d3/scratchpad/admin_cells_before.png', fullPage: true });

  page.once('dialog', d => d.accept());
  await page.click('#cells-table button.btn-danger');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-120m4n-GitHub-meshcore-grid-h3/f255e364-0819-4eae-adcd-f9245ffa80d3/scratchpad/admin_cells_after.png', fullPage: true });

  await browser.close();
})();
"
```

Expected: `admin_cells_before.png` muestra la fila con la celda de
prueba y el botón "Eliminar" en rojo; `admin_cells_after.png` muestra un
toast verde "Celda eliminada del mapa." y la tabla sin esa fila (o con
"No hay celdas activas." si era la única).

- [ ] **Step 4: Confirmar que el mapa público refleja el cambio**

```bash
curl -s http://localhost:8080/api/v1/cells
```

Expected: `[]` (o sin la celda eliminada, si había otras).

No hay commit en este task — es solo verificación de lo ya comiteado en
los Tasks 1-4.
