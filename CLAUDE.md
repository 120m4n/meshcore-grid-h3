# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mapa de disponibilidad de red MeshCore en Santander (Colombia): celdas H3
coloreadas por calidad de señal, alimentadas por reportes de usuarios
moderados por administradores. Monorepo con dos apps independientes
(`apps/api` en Go, `apps/web` en Astro) más `infra/` para el despliegue
conjunto vía Docker Compose.

## Preservación de datos — no negociable

Cualquier cambio (migraciones, refactors de esquema, scripts de
mantenimiento, cambios de formato de fechas u otros campos, etc.) debe
preservar los datos ya existentes en `infra/data/meshcore.db`. Nada de
pérdida ni corrupción de datos reales, ni siquiera temporal.

En la práctica:

- Las migraciones (`internal/db/migrations/*.sql`) son siempre aditivas
  e idempotentes (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD
  COLUMN` con guarda) — nunca un `DROP`/`DELETE`/reescritura destructiva
  de una tabla con filas existentes sin antes respaldarlas.
- Si un cambio requiere transformar datos ya guardados (p.ej. un formato
  de fecha), la migración/script debe reescribir las filas existentes al
  nuevo formato, no limitarse a cambiar el `DEFAULT` para las filas
  nuevas dejando las viejas inconsistentes.
- Antes de cualquier operación irreversible sobre `infra/data/meshcore.db`
  (en local o en el host de producción), sacar una copia
  (`cp meshcore.db meshcore.db.bak-$(date +%Y%m%d%H%M%S)`) y confirmarlo
  explícitamente en la conversación antes de proceder.
- Ante la duda entre una solución que toca datos ya persistidos y una
  que no, preferir la que no los toca (ver el fix de zona horaria: se
  resolvió en el frontend, sin migrar filas existentes).

## Commands

Comandos específicos de cada app, en `apps/api/CLAUDE.md` (backend Go)
y `apps/web/CLAUDE.md` (frontend Astro). Para desplegar con
docker-compose, crear el primer admin, o depurar redirects 301 de
nginx, usar la skill `deploy` (`.claude/skills/deploy/SKILL.md`).

## Architecture

Notas de arquitectura específicas de cada app — capas del backend
(Gin, registro por invitación, override de `score_pct`, `plus_code`,
`reports` vs `cell_agg`, resolución H3, migraciones) y del frontend
(JS vanilla por página, geolocalización en vivo, modo prueba,
actualización manual del mapa, acotamiento geográfico) — viven en
`apps/api/CLAUDE.md` y `apps/web/CLAUDE.md` respectivamente.
