# Pendientes

## Eliminar celda activa del mapa — con diseño, lista para plan

Brainstorming completo el 2026-07-09. Se evaluó un sistema de "puntos"
(sumar por reporte repetido, restar por delete) para reemplazar el
promedio actual de `score_pct` — **se descartó**: el modelo de datos
actual (promedio de `signal_quality` de reportes aprobados, calculado en
`recomputeCellAggregate`) se mantiene sin cambios.

El único gap real: no hay forma de sacar del mapa una celda ya activa —
el admin solo ve reportes `pending`, y una vez aprobado un reporte
desaparece de su vista. Diseño completo (nuevo endpoint
`DELETE /admin/cells/:h3_index`, tabla "Celdas activas" en `/admin`) en
[`docs/superpowers/specs/2026-07-09-delete-active-cell-design.md`](./superpowers/specs/2026-07-09-delete-active-cell-design.md).

**Siguiente paso:** transicionar a `writing-plans` para el plan de
implementación.
