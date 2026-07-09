# Pruebas manuales — MeshCore Santander

Guía paso a paso para probar la app completa a mano contra el deploy
local de Docker Compose. Pensada para ejecutarse en orden — cada sección
deja el estado que la siguiente necesita (usuario registrado, reporte
pendiente, etc).

## Preparación

```bash
cd infra
cp -n .env.example .env   # si no existe ya
docker compose up -d --build
docker compose ps          # confirmar infra-api-1 e infra-web-1 "Up"
```

- Mapa público: http://localhost:8081
- API: http://localhost:8080

**Nota conocida:** si acabás de reiniciar el contenedor `api`
(`docker restart infra-api-1`), la primera escritura puede devolver un
500 transitorio por una inconsistencia de bind-mount de SQLite en Docker
Desktop/macOS — reintentar antes de asumir que algo está roto (ver
`CLAUDE.md`).

## Credenciales de la cuenta de prueba

No existe ninguna cuenta admin por defecto — se crea a mano. Usá esta
cuenta de prueba documentada para todo el flujo de abajo:

| Campo | Valor |
|---|---|
| Email | `plantest@example.com` |
| Contraseña | `TestPass123!` |
| Nombre a mostrar | `Plan Test` |

Para promoverla a admin (una sola vez, después de registrarla en la
sección 1):

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'plantest@example.com';"
docker restart infra-api-1
```

El `docker restart` es obligatorio — sin él, el login puede seguir
devolviendo el rol viejo (ver nota de bind-mount en `CLAUDE.md`).

---

## 1. Registro y login

1. Ir a http://localhost:8081/register.
2. Completar nombre a mostrar `Plan Test`, email
   `plantest@example.com`, contraseña `TestPass123!` (mín. 8
   caracteres) → **Registrarme**.
3. **Esperado:** redirige a `/` automáticamente logueado; el nav
   muestra "Ingresar" reemplazado o el link "Admin" sigue oculto (todavía
   no es admin).
4. Cerrar sesión manualmente (borrar `localStorage` desde devtools, o ir
   a `/login` directo) y volver a entrar en http://localhost:8081/login
   con el mismo email/contraseña.
5. **Esperado:** login exitoso, redirige a `/`.
6. Probar con contraseña incorrecta.
7. **Esperado:** toast rojo de error, sin redirigir.

## 2. Enviar un reporte — los 3 métodos de ubicación

Ir a http://localhost:8081/reportar (logueado con la cuenta de prueba).

**2a. Coordenadas GPS (método por defecto):**
1. Dejar "Coordenadas GPS" seleccionado.
2. Latitud `7.1193`, Longitud `-73.1227`.
3. Calidad de señal: `Buena`. Observación: cualquier texto corto.
4. **Enviar reporte**.
5. **Esperado:** toast verde de éxito, el formulario se limpia.

**2b. Plus Code:**
1. Seleccionar "Plus Code".
2. **Esperado:** el bloque de coordenadas se oculta, aparece el campo Plus Code.
3. Ingresar `869876XV+GX` (o cualquier plus code válido de la zona).
4. Completar calidad de señal → **Enviar reporte**.
5. **Esperado:** éxito igual que 2a.

**2c. Clic en el mapa:**
1. Seleccionar "Clic en el mapa".
2. **Esperado:** aparece un mini-mapa embebido (`#map-picker`) con el
   hint "Hacé clic en el mapa para elegir la ubicación."
3. Hacer clic en cualquier punto dentro de Bucaramanga/Santander.
4. **Esperado:** aparece un marcador y el hint cambia a mostrar
   lat/lon elegidos.
5. Completar calidad de señal → **Enviar reporte**.
6. **Esperado:** éxito igual que 2a.
7. Repetir el envío sin hacer clic en el mini-mapa (dejar sin marcador)
   y enviar.
8. **Esperado:** toast de error, no se envía (falta lat/lon).

**2d. Límite de caracteres y campo opcional "¿Quién reporta?":**
1. En cualquiera de los métodos, escribir más de 120 caracteres en
   "Observación".
2. **Esperado:** el textarea no deja escribir más de 120 (`maxlength`)
   y el contador `#message-count` muestra `120/120`.
3. Dejar "¿Quién reporta?" vacío en un envío y con un nombre en otro.
4. **Esperado:** ambos se envían sin error (es opcional); se verifica
   el efecto en la sección 3.

## 3. Moderación — aprobar / rechazar reportes pendientes

Requiere la cuenta de prueba ya promovida a admin (ver "Credenciales" arriba)
y volver a loguearse después del `docker restart` para que el JWT lleve
`role: admin`.

1. Ir a http://localhost:8081/admin.
2. **Esperado:** tabla "Reportes pendientes" lista los reportes creados
   en la sección 2, con columna "Quién reporta" mostrando el nombre
   ingresado o "Anónimo" si se dejó vacío, y "(cuenta: Plan Test)" al lado.
3. Click **Aprobar** en uno de los reportes.
4. **Esperado:** la fila desaparece de "Reportes pendientes"; la celda
   aparece poco después en la tabla "Celdas activas" (puede requerir
   recargar la página) y en el mapa público tras **Actualizar mapa**.
5. Click **Rechazar** en otro reporte.
6. **Esperado:** la fila desaparece; esa celda NO aparece en "Celdas
   activas" ni en el mapa (a menos que ya tuviera otros reportes
   aprobados).

## 4. Mapa público — capas base

Ir a http://localhost:8081/ (sin login necesario).

1. **Esperado al cargar:** mapa centrado en el extent de las celdas
   reales (o en Bucaramanga si no hay ninguna), capa base oscura
   (CartoDB dark) activa por defecto, con selector de capas (ícono
   superior derecho) que permite cambiar a OSM claro.
2. Click en una celda coloreada (reporte aprobado de la sección 3).
3. **Esperado:** popup informativo con el score de la celda.
4. **Esperado:** sin sesión de admin, no hay botón "Limpiar pruebas" en
   el nav y click en un punto vacío del mapa no dibuja ninguna celda
   punteada — el modo prueba está restringido a admin (ver sección 4b).

## 4b. Celdas de prueba (solo admin)

Requiere estar logueado con la cuenta de prueba ya promovida a admin
(ver "Credenciales" arriba).

1. Loguearse y entrar a http://localhost:8081/.
2. **Esperado:** aparece el botón "Limpiar pruebas" en el nav.
3. Click en un punto vacío del mapa (zoom ≥13 recomendado para ver los
   hexágonos con claridad).
4. **Esperado:** se dibuja una celda punteada de "prueba" (borde teal,
   `dashArray`), NO afecta el backend.
5. Click de nuevo sobre esa misma celda punteada.
6. **Esperado:** la celda de prueba desaparece.
7. Crear 2-3 celdas de prueba más, luego click **Actualizar mapa**.
8. **Esperado:** todas las celdas de prueba se limpian Y se recargan
   las celdas reales desde el backend.
9. Crear una celda de prueba y click **Limpiar pruebas** (sin tocar
   Actualizar mapa).
10. **Esperado:** solo desaparecen las celdas de prueba; las reales
    (si había alguna cargada) no se ven afectadas.
11. Cerrar sesión y volver a http://localhost:8081/.
12. **Esperado:** el botón "Limpiar pruebas" ya no aparece y click en
    un punto vacío del mapa no crea ninguna celda punteada.

## 5. Eliminar una celda activa (feature nueva)

Requiere al menos una celda con reportes aprobados visible en "Celdas
activas" (sección 3, paso 4).

1. En http://localhost:8081/admin, ubicar la tabla "Celdas activas".
2. **Esperado:** cada fila muestra `h3_index`, señal (`score_pct`),
   cantidad de reportes y fecha, con botón rojo "Eliminar".
3. Click **Eliminar** en una fila.
4. **Esperado:** aparece un diálogo de confirmación del navegador
   ("¿Eliminar la celda … del mapa? …").
5. Cancelar el diálogo.
6. **Esperado:** no pasa nada, la fila sigue ahí.
7. Click **Eliminar** de nuevo y esta vez **Aceptar**.
8. **Esperado:** toast verde "Celda eliminada del mapa.", la fila
   desaparece de la tabla sin recargar la página entera.
9. Ir a http://localhost:8081/ y click **Actualizar mapa**.
10. **Esperado:** esa celda ya no aparece en el mapa público.
11. Verificar que el historial no se perdió:

```bash
curl -s "http://localhost:8080/api/v1/admin/reports?status=rejected" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Esperado:** el/los reporte(s) que sostenían esa celda aparecen con
`"status":"rejected"` (no se borraron, solo cambiaron de estado).

## 6. Áreas de plus code al hacer click en una celda (feature nueva)

Requiere al menos una celda real con reportes aprobados visible en el
mapa público (sección 3).

1. Ir a http://localhost:8081/ y hacer click en una celda coloreada
   (con reportes aprobados).
2. **Esperado:** además del popup de score que ya existía, se dibujan
   uno o más rectángulos finos de borde teal (`#34d7c0`) dentro del
   hexágono — cada uno es el área de plus code (nivel 10, ~13m) de un
   reporte aprobado que originó esa celda. Reportes que caen en el
   mismo plus code (ej. mismo edificio) se muestran como un único
   rectángulo, deduplicados.
3. Click en otra celda real distinta (con reportes aprobados propios).
4. **Esperado:** los rectángulos de la celda anterior desaparecen y se
   dibujan los de la celda nueva — la capa se reemplaza, no se
   acumula.
5. Click **Actualizar mapa**.
6. **Esperado:** los rectángulos teal desaparecen junto con la recarga
   de celdas.
7. Click en un punto vacío del mapa (celda de prueba punteada, sin
   reportes reales — ver sección 4).
8. **Esperado:** no se dibuja ningún rectángulo teal (el click de
   prueba no corresponde a un `h3_index` real).

Verificación directa del endpoint (opcional, sin UI):

```bash
curl -s "http://localhost:8080/api/v1/cells/<h3_index>/origins" \
  | python3 -m json.tool
```

**Esperado:** array de objetos con `plus_code`, `lat_lo`, `lat_hi`,
`lng_lo`, `lng_hi`; `[]` si la celda no tiene reportes aprobados.

## 7. Casos de error generales

1. Intentar `POST /reports` sin estar logueado (ej. borrar el token de
   `localStorage` y enviar el formulario de `/reportar`).
2. **Esperado:** error de autenticación, no se crea el reporte.
3. Entrar a http://localhost:8081/admin sin ser admin (usuario normal
   logueado).
4. **Esperado:** redirige a `/` automáticamente.
5. Refrescar cualquier ruta directa con el navegador (ej. recargar
   `http://localhost:8081/reportar` con F5, no solo navegar con links).
6. **Esperado:** carga la página normalmente, sin 404 ni redirect a
   puerto incorrecto (ver nota de nginx en `CLAUDE.md` si esto falla).
