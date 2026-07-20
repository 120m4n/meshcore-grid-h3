-- 0005_network_type.sql
-- Tipo de tecnología de red del reporte (3G, LTE, etc.).
-- Tabla nueva en vez de ALTER TABLE a `reports`: el runner de migraciones
-- re-ejecuta cada archivo en cada arranque sin tabla de versiones, y
-- SQLite no soporta ADD COLUMN IF NOT EXISTS — CREATE TABLE IF NOT EXISTS
-- sí es idempotente de forma nativa (mismo patrón que 0002 y 0004).
-- Cuando no existe fila para un report_id, se asume 'desconocido'.
CREATE TABLE IF NOT EXISTS report_network_types (
    report_id    TEXT PRIMARY KEY REFERENCES reports(id),
    network_type TEXT NOT NULL DEFAULT 'desconocido'
        CHECK (network_type IN ('2g','3g','lte','5g','desconocido'))
);
