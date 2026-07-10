-- Override manual de score_pct hecho por un admin — queda "fijado"
-- hasta que se revierte explícitamente (DELETE /admin/cells/:h3/score):
-- recomputeCellAggregate lo respeta y NO lo pisa en el próximo
-- approve/reject de un reporte de esa celda. Tabla nueva en vez de
-- ALTER TABLE a cell_agg: el runner de migraciones re-ejecuta cada
-- archivo en cada arranque sin tabla de versiones, y un
-- ALTER TABLE ADD COLUMN fallaría con "duplicate column name" en el
-- segundo restart — mismo motivo que 0002_report_display_name.sql.
CREATE TABLE IF NOT EXISTS cell_overrides (
    h3_index   TEXT PRIMARY KEY,
    score_pct  REAL NOT NULL,
    updated_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
