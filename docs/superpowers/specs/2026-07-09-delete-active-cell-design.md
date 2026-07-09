# Eliminar una celda activa del mapa

## Contexto

Hoy no existe forma de sacar una celda ya visible en el mapa público. Una
vez que un admin aprueba un reporte, `recomputeCellAggregate`
(`apps/api/internal/handlers/admin_handler.go`) crea/actualiza la fila en
`cell_agg`, y el reporte deja de aparecer en la vista de admin — que solo
lista `status=pending` (`adminPage.ts` → `getPendingReports()` →
`GET /admin/reports?status=pending`). No hay manera de volver a encontrar
ese reporte para revertirlo, ni una acción a nivel de celda.

Se evaluó primero un sistema de "puntos" (sumar por reporte repetido,
restar por delete) para reemplazar el promedio actual de `score_pct`.
Se descartó: el promedio y el resto del modelo de datos quedan **tal
como están hoy**. El único gap real es operativo, no de modelado — cómo
borrar una celda que ya está activa.

## Hallazgo clave

El backend ya soporta técnicamente revertir una aprobación:
`AdminHandler.ReviewReport` no valida el estado actual del reporte antes
de actualizarlo — un `PATCH /admin/reports/:id` con
`{"status":"rejected"}` funciona igual sobre un reporte ya `approved`, y
dispara `recomputeCellAggregate`, que borra la fila de `cell_agg` cuando
el conteo de aprobados llega a 0. El gap es 100% de UI/endpoint de
listado y de una acción en bulk por celda, no de lógica de agregación
nueva.

## Diseño

### Backend (`apps/api`)

**Nuevo endpoint:** `DELETE /api/v1/admin/cells/:h3_index`, dentro del
grupo `admin` existente en `internal/router/router.go` (mismo
`middleware.RequireAdmin()` que ya protege `/admin/reports` y
`/admin/export.csv` — no se crea middleware nuevo).

**Nuevo handler:** `AdminHandler.DeleteCell` en `admin_handler.go`:

1. `UPDATE reports SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE h3_index = ? AND status = 'approved'` — revoca en una sola sentencia todos los reportes aprobados de esa celda. Si `RowsAffected() == 0`, responder 404 (no había celda activa con ese índice).
2. Llamar `recomputeCellAggregate(h.DB, h3Index)` — la misma función que ya usa `ReviewReport`, sin modificarla. Con 0 aprobados restantes, borra la fila de `cell_agg`.
3. Responder `200 {"h3_index": ..., "reports_revoked": N}`.

No se toca el schema ni se agregan migraciones: los reportes originales
quedan en `reports` con `status='rejected'` (historial auditable via
`reviewed_by`/`reviewed_at`), y `cell_agg` se limpia con el mecanismo que
ya existe. Esto es lo que lo hace "soft" sin construir nada especial.

**No se necesita un GET nuevo para listar celdas activas en el admin:**
`GET /api/v1/cells` (público, ya existe, sin auth) devuelve exactamente
`h3_index`, `score_pct`, `report_count`, `last_report_at` — el admin lo
consume tal cual con el `getCells()` que ya está en `api.ts`.

### Frontend (`apps/web`)

**`src/lib/api.ts`:** una función nueva,

```ts
export function deleteCell(h3Index: string) {
  return apiFetch(`/api/v1/admin/cells/${h3Index}`, { method: 'DELETE' });
}
```

Mismo patrón que `reviewReport` — nada nuevo que aprender del cliente
HTTP.

**`src/pages/admin/index.astro`:** segunda tabla "Celdas activas" debajo
de la tabla de reportes pendientes existente, con columnas `Celda H3`,
`Calidad (score_pct)`, `Reportes`, `Última actualización`, `Acciones`
(botón "Eliminar").

**`src/lib/adminPage.ts`:** una función `loadCells()` (paralela a la
`load()` que ya existe para pendientes) que llama `getCells()` y puebla
la segunda tabla. El botón "Eliminar" de cada fila:

1. `confirm('¿Eliminar la celda {h3_index} del mapa? Los reportes aprobados quedarán marcados como rechazados.')` — acción destructiva desde la perspectiva de la UI (el usuario público la deja de ver), aunque los datos originales no se pierden.
2. Si se confirma, llama `deleteCell(h3Index)`.
3. `showToast('Celda eliminada del mapa.', 'success')` o el error correspondiente (reusa el módulo `toast.ts` ya usado en `reportPage.ts`/`loginPage.ts`/`registerPage.ts`).
4. Recarga `loadCells()` (la tabla de pendientes no se ve afectada por este flujo, no hace falta recargarla).

No se toca el mapa público (`index.astro`/`mapPage.ts`) — la celda
desaparece ahí en el siguiente `GET /cells`, que ya se dispara con el
botón "Actualizar mapa" existente; no hace falta lógica reactiva nueva.

## Fuera de alcance (explícitamente descartado)

- Sistema de puntos que suman/restan por reporte — se mantiene el
  promedio actual de `score_pct` sin cambios.
- Deduplicar reportes por usuario en el cálculo del promedio.
- Delete por reporte individual desde una vista ampliada de la tabla de
  pendientes — se eligió granularidad por celda completa.
- Acción de eliminar embebida en el popup del mapa público — vive solo
  en `/admin`.

## Verificación

1. `apps/api`: `go build ./...` y `go vet ./...` limpios.
2. Backend manual: aprobar 2+ reportes de prueba sobre la misma celda,
   confirmar que aparece en `GET /cells`; llamar
   `DELETE /admin/cells/:h3_index` con un JWT de admin; confirmar
   `GET /cells` ya no la incluye y que los reportes originales quedan
   `status=rejected` en `GET /admin/reports?status=rejected`.
3. `DELETE` sobre un `h3_index` sin reportes aprobados → 404.
4. `apps/web`: `npm run build` limpio.
5. E2E con navegador headless (mismo patrón ya usado en la sesión): login
   admin → `/admin` → confirmar que la tabla "Celdas activas" lista las
   celdas del mapa → eliminar una → toast de éxito → la tabla se
   refresca sin esa fila → volver a `/` → "Actualizar mapa" → la celda
   ya no aparece en el mapa.
