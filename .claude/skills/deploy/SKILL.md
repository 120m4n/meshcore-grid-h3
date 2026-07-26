---
name: deploy
description: Use when deploying meshcore-grid-h3 via docker-compose, creating the first admin user, or debugging clean-URL 301 redirects from nginx.
---

## Despliegue (docker-compose)

```bash
cd infra
cp .env.example .env    # editar JWT_SECRET, PUBLIC_API_URL, dominios
docker compose up -d --build
```

Levanta `api` (Go binario + volumen `./data` bind-mounted, DB en
`infra/data/meshcore.db`) y `web` (build estático servido por nginx).
Las migraciones embebidas corren automáticamente al arrancar el backend
(`internal/db/migrate.go`) — no hay paso manual de init de DB.

## Crear el primer admin

No existe endpoint de promoción, es deliberado. El registro requiere un
`invite_code` válido en `invite_codes` — para el primerísimo usuario,
ese código no lo generó ningún admin (todavía no existe ninguno), así
que se inserta a mano una sola vez:

```bash
sqlite3 infra/data/meshcore.db \
  "INSERT INTO invite_codes (code, created_by, expires_at)
   VALUES ('BOOTSTRAP', 'system', datetime('now', '+1 day'));"
```

Registrarse en `/register` con ese código (`BOOTSTRAP`, sin distinguir
mayúsculas/minúsculas), y luego promoverlo:

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'tu-email@dominio.com';"
```

Cualquier admin generado a partir de ahí ya puede generar sus propios
códigos desde `/admin` — no hace falta repetir el insert manual salvo
para ese primer usuario.

Si el contenedor `api` ya estaba corriendo cuando corriste el `UPDATE`, el
login puede seguir devolviendo el rol viejo por un rato: el bind mount
de SQLite con Docker Desktop no siempre refleja escrituras hechas desde
el host a una conexión ya abierta dentro del contenedor. `docker restart
infra-api-1` (o `docker compose restart api`) fuerza a reabrir el
archivo y ver el cambio.

Esta misma inconsistencia se observó una vez justo después de un
`docker restart infra-api-1` en una ruta de escritura normal de la API
(no solo en un `UPDATE` hecho desde el host): la primera petición
devolvió 500 y la segunda, idéntica, funcionó. No es exclusivo del flujo
de promoción de admin — si una escritura falla inmediatamente después de
un restart del contenedor `api`, reintentar antes de asumir un bug de
lógica.

## nginx: rutas limpias necesitan `apps/web/nginx.conf` propio

Astro genera cada página como carpeta (`/login/index.html`,
`/register/index.html`, etc). El `default.conf` de la imagen base
`nginx:1.27-alpine` no trae `try_files`: al pedir `/login` (sin slash)
nginx lo resuelve como directorio y responde **301** a `/login/` usando
`$host`, que en nginx nunca incluye el puerto. En un host expuesto en
puerto no estándar (p.ej. `localhost:8081`) el navegador termina
siguiendo el redirect a `http://localhost/login/` (puerto 80 implícito)
y no resuelve — se ve como si la ruta directa/reload no funcionara.
`apps/web/nginx.conf` (copiado a `/etc/nginx/conf.d/default.conf` en el
Dockerfile) usa `try_files $uri $uri.html $uri/index.html =404;` para
servir el archivo directo sin pasar por ese redirect. Si agregás rutas
nuevas o cambiás el output de Astro, verificá con `curl -I` que no
vuelva un 301 con puerto faltante en el `Location`.
