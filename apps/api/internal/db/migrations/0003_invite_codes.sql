-- Registro por invitación: cada código es de un solo uso y expira a
-- las 72h de generado (ver InviteHandler.Generate). used_by/used_at
-- quedan NULL hasta que un registro exitoso los consume — la
-- consulta+consumo pasa en la misma transacción que el INSERT en
-- users (ver AuthHandler.Register) para evitar doble uso por carrera.
CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,           -- 8 chars alfanuméricos mayúsculas
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_by    TEXT REFERENCES users(id),
    used_at    TEXT
);
