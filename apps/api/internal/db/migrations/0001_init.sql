-- 0001_init.sql (SQLite plano, sin extensiones)

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,           -- uuid generado en Go
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
    id             TEXT PRIMARY KEY,          -- uuid generado en Go
    h3_index       TEXT NOT NULL,             -- ej. 8866089b05fffff
    h3_resolution  INTEGER NOT NULL,
    lat            REAL NOT NULL,
    lon            REAL NOT NULL,
    input_method   TEXT NOT NULL CHECK (input_method IN ('coords','pluscode')),
    input_raw      TEXT,
    reporter_id    TEXT NOT NULL REFERENCES users(id),
    signal_quality TEXT NOT NULL CHECK (signal_quality IN ('sin_cobertura','debil','buena','excelente')),
    message        TEXT,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    reviewed_by    TEXT REFERENCES users(id),
    reviewed_at    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reports_h3 ON reports(h3_index);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);

-- Tabla materializada que consume el mapa público.
-- Se recalcula en Go cada vez que un admin aprueba/rechaza un reporte
-- (ver internal/handlers/admin_handler.go -> recomputeCellAggregate).
-- geom_wkt es texto plano (POLYGON((lon lat, ...))) calculado desde el
-- boundary de H3 en Go; no depende de ninguna extensión espacial de SQLite.
-- Si algún día se necesita ver esto en QGIS: exportar vía
-- GET /api/v1/admin/export.csv y usar "Añadir capa de texto delimitado"
-- con el campo WKT — sin tocar el motor de la base de datos operativa.
CREATE TABLE IF NOT EXISTS cell_agg (
    h3_index        TEXT PRIMARY KEY,
    score_pct       REAL NOT NULL,
    report_count    INTEGER NOT NULL,
    last_report_at  TEXT NOT NULL,
    geom_wkt        TEXT NOT NULL
);

-- Primer admin: registrar un usuario normal vía API y luego:
-- UPDATE users SET role = 'admin' WHERE email = 'tu-email@dominio.com';
