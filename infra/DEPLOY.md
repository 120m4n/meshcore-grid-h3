# Actualización del VPS

Runbook para actualizar `meshcore-api`/`meshcore-web` en el VPS de
producción (`infra/traefik.yml` — contenedores `meshcore-api`/
`meshcore-web`, datos en bind mount `/home/roman/meshcore/data:/data`,
imágenes `ghcr.io/120m4n/meshcore-*:latest`).

Regla no negociable (ver `CLAUDE.md`): ningún paso de este proceso debe
arriesgar los datos ya guardados en `meshcore.db`. Siempre backup antes
de tocar contenedores, y nunca `down -v` / borrar el bind mount.

## Fase 0 — Antes de tocar el VPS (local)

- Confirmar que `infra/deploy.sh` ya corrió y las imágenes `:latest` en
  GHCR corresponden al commit que querés desplegar
  (`git rev-parse --short HEAD`). Anotar ese SHA — `deploy.sh` también
  empuja `:<sha>` además de `:latest`, así que queda disponible en el
  registry como target de rollback.
- Si el release cambia `infra/traefik.yml` (nuevas env vars, labels,
  etc.), copiar el archivo actualizado al VPS. Las imágenes solas no
  bastan si el compose file también cambió.

## Fase 1 — Backup del DB (en el VPS, antes de `pull`/`up`)

La DB corre en modo WAL (`_journal_mode=WAL` en
`apps/api/internal/db/db.go`), así que un `cp` directo del `.db` puede
perder escrituras que todavía viven en `.db-wal`. Usar el backup nativo
de SQLite, seguro incluso con la DB en caliente:

```bash
BACKUP_DIR=/home/roman/meshcore/backups
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d%H%M%S)
sqlite3 /home/roman/meshcore/data/meshcore.db ".backup '$BACKUP_DIR/meshcore.db.bak-$TS'"

# Verificar que el backup abre y tiene datos:
sqlite3 "$BACKUP_DIR/meshcore.db.bak-$TS" \
  "PRAGMA integrity_check; SELECT count(*) FROM reports; SELECT count(*) FROM cell_agg;"
```

Anotar esos counts (`reports`, `cell_agg`, y de paso `users`,
`invite_codes`) — son el baseline contra el que comparás después del
deploy.

## Fase 2 — Deploy

```bash
cd /home/roman/meshcore   # o donde viva traefik.yml en el VPS
docker compose -f traefik.yml pull
docker compose -f traefik.yml up -d
```

- `up -d` sin `-v`/`--volumes`: nunca toca el bind mount
  `/home/roman/meshcore/data`. No usar `down -v` en ningún paso de este
  proceso.
- Las migraciones embebidas (`internal/db/migrations/*.sql`) corren
  solas al arrancar `meshcore-api` (`db.Migrate`) — son idempotentes,
  no hay paso manual. Deben ser siempre aditivas: si algún release
  necesita transformar filas ya existentes (no solo el `DEFAULT` para
  filas nuevas), la migración tiene que reescribirlas explícitamente.

## Fase 3 — Verificación post-deploy

```bash
docker compose -f traefik.yml logs api --tail=50    # sin errores de migración/conexión
sqlite3 /home/roman/meshcore/data/meshcore.db \
  "SELECT count(*) FROM reports; SELECT count(*) FROM cell_agg;"
```

- Comparar esos counts contra el baseline de la Fase 1 — deben ser
  iguales o mayores, nunca menores.
- Ver nota ya documentada en `CLAUDE.md`: justo después de un restart
  del contenedor `api`, la primera petición de escritura puede devolver
  500 por el bind mount de SQLite — si pasa, reintentar antes de asumir
  que algo se rompió.
- Chequeo funcional mínimo: `/admin` carga celdas paginadas, ordenar
  columnas funciona, las horas mostradas coinciden con la hora real de
  Bogotá.

## Fase 4 — Rollback (solo si algo falla)

```bash
docker compose -f traefik.yml down          # sin -v
cp /home/roman/meshcore/backups/meshcore.db.bak-$TS /home/roman/meshcore/data/meshcore.db
rm -f /home/roman/meshcore/data/meshcore.db-wal /home/roman/meshcore/data/meshcore.db-shm
docker compose -f traefik.yml up -d
```

**Pendiente:** `infra/traefik.yml` tiene la imagen fijada a `:latest`,
no parametrizada por `IMAGE_TAG` como `docker-compose.prod.yml`. Para
poder rollbackear a un SHA específico sin editar el archivo a mano,
convendría parametrizarlo igual que el otro compose.
