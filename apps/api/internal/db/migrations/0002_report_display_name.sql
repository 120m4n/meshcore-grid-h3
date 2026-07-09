-- Nombre opcional para mostrar en la revisión admin de un reporte,
-- separado de la cuenta real (reports.reporter_id sigue siendo la
-- fuente de verdad para moderación). Tabla nueva en vez de ALTER TABLE
-- a `reports`: el runner de migraciones re-ejecuta cada archivo en
-- cada arranque sin tabla de versiones, y SQLite no soporta
-- ADD COLUMN IF NOT EXISTS — CREATE TABLE IF NOT EXISTS sí es
-- idempotente de forma nativa.
CREATE TABLE IF NOT EXISTS report_display_names (
    report_id    TEXT PRIMARY KEY REFERENCES reports(id),
    display_name TEXT NOT NULL
);
