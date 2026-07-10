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

No existe ninguna cuenta admin por defecto — se crea a mano. El
registro es **solo por invitación** (código de 8 caracteres, un solo
uso, vence a las 72h) — no hay walk-in signup. Para el primerísimo
usuario del sistema (todavía no existe ningún admin que genere un
código), se inserta uno a mano una sola vez:

```bash
sqlite3 infra/data/meshcore.db \
  "INSERT INTO invite_codes (code, created_by, expires_at)
   VALUES ('BOOTSTRAP', 'system', datetime('now', '+1 day'));"
```

Usá esta cuenta de prueba documentada para todo el flujo de abajo:

| Campo | Valor |
|---|---|
| Email | `plantest@example.com` |
| Contraseña | `TestPass123!` |
| Nombre a mostrar | `Plan Test` |
| Código de invitación (solo el primer registro) | `BOOTSTRAP` |

Para promoverla a admin (una sola vez, después de registrarla en la
sección 1):

```bash
sqlite3 infra/data/meshcore.db \
  "UPDATE users SET role = 'admin' WHERE email = 'plantest@example.com';"
docker restart infra-api-1
```

El `docker restart` es obligatorio — sin él, el login puede seguir
devolviendo el rol viejo (ver nota de bind-mount en `CLAUDE.md`). Una
vez que `plantest@example.com` es admin, ya puede generar sus propios
códigos desde `/admin` (sección 6) para registrar cuentas nuevas — no
hace falta repetir el insert manual.

---

## 1. Registro (código de invitación) y login

1. Ir a http://localhost:8081/register.
2. **Esperado:** solo se ve un campo "Código de invitación" y el botón
   "Validar código" — los campos de cuenta (nombre/email/contraseña)
   están ocultos.
3. Ingresar un código inventado (ej. `XXXXXXXX`) → **Validar código**.
4. **Esperado:** toast rojo de error ("código inválido"), los campos de
   cuenta siguen ocultos.
5. Ingresar `BOOTSTRAP` (o el código real generado desde `/admin` si ya
   existe un admin) → **Validar código**.
6. **Esperado:** el paso 1 desaparece, aparecen los campos nombre a
   mostrar / email / contraseña.
7. Completar nombre a mostrar `Plan Test`, email
   `plantest@example.com`, contraseña `TestPass123!` (mín. 8
   caracteres) → **Registrarme**.
8. **Esperado:** redirige a `/` automáticamente logueado; el nav
   muestra "Ingresar" reemplazado o el link "Admin" sigue oculto (todavía
   no es admin).
9. Intentar registrar una segunda cuenta reusando el mismo código ya
   consumido.
10. **Esperado:** toast rojo "código de invitación ya utilizado" (o,
    si se llega a probar el mismo código en dos pestañas a la vez, solo
    uno de los dos registros prospera — el otro debe fallar igual, sin
    crear una cuenta duplicada ni dejar el código "medio usado").
11. Cerrar sesión manualmente (borrar `localStorage` desde devtools, o ir
   a `/login` directo) y volver a entrar en http://localhost:8081/login
   con el mismo email/contraseña.
12. **Esperado:** login exitoso, redirige a `/`.
13. Probar con contraseña incorrecta.
14. **Esperado:** toast rojo de error, sin redirigir.
15. Probar 6 intentos de login seguidos con contraseña incorrecta.
16. **Esperado:** a partir del 6to (rate limit de auth: 10/hora, ráfaga
    5), toast "demasiadas solicitudes, esperá un momento" en vez del
    error de credenciales — confirma que el rate limiting está activo.

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

## 3b. Generar códigos de invitación (admin)

Requiere la cuenta de prueba ya promovida a admin (misma sesión de la
sección 3).

1. En http://localhost:8081/admin, ubicar la tabla "Códigos de
   invitación".
2. **Esperado:** el código `BOOTSTRAP` usado en la sección 1 aparece
   con estado "usado".
3. Click **Generar código**.
4. **Esperado:** toast verde "Código generado y copiado: XXXXXXXX", el
   código aparece en la tabla con estado "activo", columna "Expira /
   usado" mostrando una fecha ~72h en el futuro. Pegar el portapapeles
   en algún lado confirma que efectivamente se copió.
5. Abrir una pestaña de incógnito, ir a `/register`, pegar ese código.
6. **Esperado:** valida OK, revela el form de cuenta (sección 1,
   pasos 5-8).
7. Completar el registro con ese código.
8. **Esperado:** cuenta creada con éxito; volver a la tabla de
   `/admin` (recargar) — el código ahora figura "usado".
9. Intentar usar el mismo código de nuevo en otra pestaña de
   incógnito.
10. **Esperado:** falla con "código de invitación ya utilizado" en el
    paso de validación previa (ni siquiera llega a mostrar el form).

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
8. **Esperado:** si ya pasaron 45 min desde la última carga de celdas
   (carga inicial de la página u otro "Actualizar mapa"), todas las
   celdas de prueba se limpian Y se recargan las celdas reales desde el
   backend. Si NO pasaron los 45 min (caso normal al probar esto en el
   momento), aparece un toast rojo "El mapa ya está al día. Podés
   actualizarlo de nuevo en N min." y NO se limpia nada ni se llama al
   backend — ver sección 4c para forzar el caso "TTL vencido".
9. Crear una celda de prueba y click **Limpiar pruebas** (sin tocar
   Actualizar mapa).
10. **Esperado:** solo desaparecen las celdas de prueba; las reales
    (si había alguna cargada) no se ven afectadas. "Limpiar pruebas" no
    tiene TTL, siempre es inmediato (no toca el backend).
11. Cerrar sesión y volver a http://localhost:8081/.
12. **Esperado:** el botón "Limpiar pruebas" ya no aparece y click en
    un punto vacío del mapa no crea ninguna celda punteada.

## 4c. TTL de "Actualizar mapa" (45 min)

No es un mapa de navegación ni de eventos en tiempo real — la
cobertura de una celda cambia en horas, no en segundos. El botón
"Actualizar mapa" está limitado a una llamada real al backend cada 45
minutos (persistido en `localStorage`, sobrevive a recargar la
página) para no forzar al backend con clicks repetidos.

1. Abrir http://localhost:8081/ (carga inicial ya cuenta como el
   primer "fetch" del TTL).
2. Click inmediato en **Actualizar mapa**.
3. **Esperado:** toast rojo "El mapa ya está al día. Podés
   actualizarlo de nuevo en 45 min." (o el minuto redondeado que
   corresponda), sin request nueva a `GET /cells` (verificar en la
   pestaña Network del navegador).
4. Recargar la página (F5) y click en **Actualizar mapa** de nuevo.
5. **Esperado:** sigue bloqueado — el TTL persiste entre recargas, no
   se resetea.
6. Para forzar el caso "TTL vencido" sin esperar 45 min, desde la
   consola del navegador:
   ```js
   localStorage.setItem('meshcore:cells-last-fetch', String(Date.now() - 46 * 60 * 1000));
   ```
7. Click en **Actualizar mapa**.
8. **Esperado:** esta vez sí dispara `GET /cells` y recarga las celdas
   reales normalmente.

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

## 5b. Editar la señal de una celda a mano + filtrar por plus code (feature nueva)

Requiere al menos una celda con reportes aprobados visible en "Celdas
activas" (sección 3, paso 4).

1. En http://localhost:8081/admin, ubicar la tabla "Celdas activas".
2. **Esperado:** columna nueva "Plus code" junto a "Celda H3", con un
   código tipo `869876XV+GX` (calculado del centro de la celda, no de
   ningún reporte puntual).
3. Escribir en "Filtrar por plus code" algo que no matchee ningún
   código (ej. `ZZZZZZZZ`).
4. **Esperado:** la tabla queda vacía (el filtro no toca el backend, es
   sobre los datos ya cargados).
5. Escribir solo los primeros 4-5 caracteres de un plus code real, en
   minúsculas.
6. **Esperado:** la fila correspondiente aparece igual (filtro parcial,
   sin distinguir mayúsculas/minúsculas). Borrar el filtro.
7. Click **Editar** en una fila.
8. **Esperado:** la columna "Señal" se convierte en un input numérico
   con el valor actual, "Acciones" pasa a mostrar "Guardar"/"Cancelar".
9. Cambiar el número a algo distinto (ej. `30`) → **Guardar**.
10. **Esperado:** toast verde "Señal actualizada.", la columna vuelve a
    mostrar el número seguido de "(manual)", y aparece un botón nuevo
    "Revertir a automático" en Acciones.
11. Ir a http://localhost:8081/reportar y enviar+aprobar un reporte
    nuevo para esa misma celda (cualquier calidad de señal).
12. **Esperado:** al recargar `/admin`, "Reportes" subió en esa fila
    (dato real), pero la "Señal" sigue en el valor fijado a mano del
    paso 9 — el reporte nuevo NO la recalculó.
13. Click **Revertir a automático** en esa fila.
14. **Esperado:** diálogo de confirmación; al aceptar, toast verde
    "Celda vuelta a cálculo automático.", "(manual)" y el botón
    "Revertir" desaparecen, la señal pasa a reflejar el promedio real
    de los reportes aprobados de esa celda.
15. Click **Editar** → **Cancelar** (sin cambiar el número).
16. **Esperado:** no pasa nada, la fila vuelve a su estado normal sin
    llamar al backend.

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
