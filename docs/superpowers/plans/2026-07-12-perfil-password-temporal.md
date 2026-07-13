# Perfil + Contraseña Temporal (admin) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Estado: plan para revisión, no para ejecutar todavía.** El usuario pidió explícitamente no tocar código en esta iteración — este documento existe para que se revisen los gaps y tradeoffs (sección al final) antes de mandar cualquier task a un subagente.

**Goal:** Agregar una ruta `/perfil` (nombre + email visibles, cambio de contraseña propio) y una función de administración para asignarle a cualquier usuario una contraseña temporal con TTL, de un solo uso hasta que la cambie.

**Architecture:** Backend Go/Gin existente, sin capa de servicio — SQL inline en handlers, siguiendo el patrón ya usado por `invite_handler.go` y `admin_handler.go`. El estado "esta cuenta tiene una contraseña temporal pendiente" vive en una tabla nueva (`password_resets`), no en columnas nuevas de `users` — ver Task 1 para el porqué. Frontend Astro sin framework de componentes: página nueva + script standalone, siguiendo el patrón de `reportar.astro`/`reportPage.ts`.

**Tech Stack:** Go 1.22 + Gin + `database/sql` + SQLite (mattn/go-sqlite3) + bcrypt + JWT (golang-jwt/v5). Astro 4 + TypeScript vanilla, sin frameworks de UI.

## Global Constraints

- Las migraciones se re-ejecutan enteras en cada arranque (`db.Migrate`, sin tabla de versiones) — todo archivo `.sql` nuevo debe ser idempotente. `ALTER TABLE ADD COLUMN` **no** es idempotente en SQLite y rompe el segundo restart — por eso 0002 y 0004 ya usaron tablas nuevas en vez de columnas nuevas; este plan sigue el mismo patrón.
- No hay suite de tests en el repo (`go test ./...` no encuentra nada hoy, `package.json` no tiene test runner). Este plan **introduce los primeros tests Go** del backend (`internal/handlers/*_test.go`) porque toca lógica de autenticación — está señalado como decisión explícita en Gaps, no es un efecto secundario silencioso.
- `WEB_ORIGIN`/CORS, rate limiting por IP y el resto de la infraestructura de `router.go` no cambian de forma — solo se agregan rutas y un rate limiter dedicado.
- Todo string de cara al usuario va en español, consistente con el resto de la UI.
- Todas las contraseñas se hashean con `auth.HashPassword` (bcrypt) — nunca se persiste texto plano, ni siquiera la temporal (se devuelve una sola vez en la respuesta HTTP y no se vuelve a poder recuperar).

---

## File Structure

**Backend (`apps/api`):**
- `internal/db/migrations/0005_temp_passwords.sql` — nueva tabla `password_resets`.
- `internal/config/config.go` — nuevo campo `TempPasswordTTLHours`.
- `internal/models/models.go` — extender `User` con `PasswordTemp`/`PasswordExpiresAt`.
- `internal/handlers/user_handler.go` — nuevo: `UserHandler.List` (GET /admin/users), `UserHandler.SetTempPassword` (POST /admin/users/:id/temp-password), generador de contraseña temporal.
- `internal/handlers/auth_handler.go` — modificar `Login` y `Me`, agregar `ChangePassword` (PATCH /me/password).
- `internal/handlers/testutil_test.go` — nuevo: helper de DB de test (primer archivo de test del repo).
- `internal/handlers/auth_handler_test.go` — nuevo.
- `internal/handlers/user_handler_test.go` — nuevo.
- `internal/router/router.go` — cablear las 3 rutas nuevas + rate limiter dedicado para `/me/password`.

**Frontend (`apps/web`):**
- `src/lib/api.ts` — tipos + funciones nuevas (`getMe` ya no existe como tal — se agrega; `listUsers`, `setTempPassword`, `changePassword`), más `checkForcedPasswordChange()` compartido.
- `src/pages/perfil.astro` — nuevo.
- `src/lib/perfilPage.ts` — nuevo.
- `src/lib/loginPage.ts` — redirigir a `/perfil` cuando `must_change_password`.
- `src/lib/mapPage.ts`, `src/lib/reportPage.ts`, `src/lib/adminPage.ts` — una llamada a `checkForcedPasswordChange()` cada uno.
- `src/pages/index.astro` — link "Perfil" en el nav (visible solo logueado).
- `src/pages/admin/index.astro` + `src/lib/adminPage.ts` — sección "Usuarios" nueva.

---

### Task 1: Migración — tabla `password_resets` + TTL configurable

**Files:**
- Create: `apps/api/internal/db/migrations/0005_temp_passwords.sql`
- Modify: `apps/api/internal/config/config.go`

**Interfaces:**
- Produces: tabla `password_resets(user_id TEXT PK, expires_at TEXT, created_by TEXT, created_at TEXT)`; `config.Config.TempPasswordTTLHours int`.

- [ ] **Step 1: Crear la migración**

```sql
-- 0005_temp_passwords.sql
-- Estado de contraseña temporal asignada por un admin — tabla nueva en
-- vez de ALTER TABLE a `users` por el mismo motivo que 0002 y 0004: el
-- runner re-ejecuta cada archivo en cada arranque sin tabla de
-- versiones, y ALTER TABLE ADD COLUMN falla con "duplicate column
-- name" en el segundo restart. Fila presente = la contraseña actual
-- del usuario es temporal; se borra al cambiarla (forzada o
-- voluntaria) o se ignora si expires_at ya pasó (chequeo en
-- AuthHandler.Login, no hay cron ni job de limpieza).
CREATE TABLE IF NOT EXISTS password_resets (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Agregar el TTL a config.Config**

```go
// apps/api/internal/config/config.go
type Config struct {
	Port                 string
	DBPath               string
	JWTSecret            string
	H3Resolution         int
	WebOrigin            string
	TempPasswordTTLHours int
}

func Load() Config {
	res, err := strconv.Atoi(getEnv("H3_RESOLUTION", "8"))
	if err != nil {
		res = 8
	}
	ttl, err := strconv.Atoi(getEnv("TEMP_PASSWORD_TTL_HOURS", "24"))
	if err != nil {
		ttl = 24
	}
	return Config{
		Port:                 getEnv("PORT", "8080"),
		DBPath:               getEnv("DB_PATH", "/data/meshcore.db"),
		JWTSecret:            getEnv("JWT_SECRET", "change-me-in-production"),
		H3Resolution:         res,
		WebOrigin:            getEnv("WEB_ORIGIN", "http://localhost:4321"),
		TempPasswordTTLHours: ttl,
	}
}
```

- [ ] **Step 3: Verificar que arranca dos veces sin error (idempotencia)**

```bash
cd apps/api
DB_PATH=/tmp/meshcore-test.db go run ./cmd/api &
sleep 1; kill %1
DB_PATH=/tmp/meshcore-test.db go run ./cmd/api &
sleep 1; kill %1
rm /tmp/meshcore-test.db
```

Expected: ambos arranques loguean el servidor levantando en :8080, ninguno imprime `migración 0005_temp_passwords.sql falló`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/internal/db/migrations/0005_temp_passwords.sql apps/api/internal/config/config.go
git commit -m "feat(api): agregar tabla password_resets y TTL configurable"
```

---

### Task 2: Backend — modelo `User` extendido + `UserHandler.List`

**Files:**
- Modify: `apps/api/internal/models/models.go`
- Create: `apps/api/internal/handlers/user_handler.go`
- Create: `apps/api/internal/handlers/testutil_test.go`
- Create: `apps/api/internal/handlers/user_handler_test.go`

**Interfaces:**
- Consumes: `config.Config` (Task 1).
- Produces: `models.User{ID, Email, DisplayName, Role, CreatedAt, PasswordTemp bool, PasswordExpiresAt *string}`; `handlers.UserHandler{DB *sql.DB}` con método `List(c *gin.Context)`.

- [ ] **Step 1: Extender `models.User`**

```go
// apps/api/internal/models/models.go — reemplazar el struct User existente
type User struct {
	ID                string  `json:"id"`
	Email             string  `json:"email"`
	DisplayName       string  `json:"display_name"`
	Role              Role    `json:"role"`
	PasswordHash      string  `json:"-"`
	CreatedAt         string  `json:"created_at"`
	PasswordTemp      bool    `json:"password_temp"`
	PasswordExpiresAt *string `json:"password_expires_at,omitempty"`
}
```

- [ ] **Step 2: Helper de test de DB (primer test del repo)**

```go
// apps/api/internal/handlers/testutil_test.go
package handlers

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"meshcore-map/api/internal/auth"
	"meshcore-map/api/internal/db"
)

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()
	// Archivo real en t.TempDir(), no ":memory:": go-sqlite3 abre un
	// in-memory DISTINTO por conexión sin "cache=shared", y sql.DB usa
	// pool de conexiones — con ":memory:" las tablas de la migración
	// podrían no verse desde la conexión que corre el test.
	path := filepath.Join(t.TempDir(), "test.db")
	sqlDB, err := db.Connect(path)
	if err != nil {
		t.Fatalf("db.Connect: %v", err)
	}
	if err := db.Migrate(sqlDB); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

// createTestUser inserta un usuario con contraseña conocida y devuelve
// su id y la contraseña en texto plano (para loguear en el test).
func createTestUser(t *testing.T, sqlDB *sql.DB, role, password string) string {
	t.Helper()
	id := uuid.NewString()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	_, err = sqlDB.Exec(
		`INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)`,
		id, id+"@example.com", hash, "Test User", role,
	)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

func setPasswordReset(t *testing.T, sqlDB *sql.DB, userID string, expiresAt time.Time) {
	t.Helper()
	_, err := sqlDB.Exec(
		`INSERT INTO password_resets (user_id, expires_at, created_by) VALUES (?, ?, ?)`,
		userID, expiresAt.UTC().Format("2006-01-02 15:04:05"), userID,
	)
	if err != nil {
		t.Fatalf("insert password_reset: %v", err)
	}
}
```

- [ ] **Step 3: Escribir el test de `List` (falla — el handler no existe)**

```go
// apps/api/internal/handlers/user_handler_test.go
package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestUserHandlerList(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)

	normalID := createTestUser(t, sqlDB, "user", "password123")
	tempID := createTestUser(t, sqlDB, "user", "password123")
	setPasswordReset(t, sqlDB, tempID, time.Now().Add(24*time.Hour))

	h := &UserHandler{DB: sqlDB}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/admin/users", nil)

	h.List(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !contains(body, normalID) || !contains(body, tempID) {
		t.Fatalf("respuesta no incluye ambos usuarios: %s", body)
	}
	if !contains(body, `"password_temp":true`) {
		t.Fatalf("respuesta no marca password_temp:true para %s: %s", tempID, body)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && indexOf(s, substr) >= 0))
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 4: Correr el test y confirmar que falla**

```bash
cd apps/api && go test ./internal/handlers/... -run TestUserHandlerList -v
```

Expected: `FAIL` — `UserHandler` no existe todavía (error de compilación).

- [ ] **Step 5: Implementar `UserHandler.List`**

```go
// apps/api/internal/handlers/user_handler.go
package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/models"
)

type UserHandler struct {
	DB *sql.DB
}

func (h *UserHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT u.id, u.email, u.display_name, u.role, u.created_at, pr.expires_at
		FROM users u
		LEFT JOIN password_resets pr ON pr.user_id = u.id
		ORDER BY u.created_at DESC
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar usuarios"})
		return
	}
	defer rows.Close()

	users := []models.User{}
	for rows.Next() {
		var u models.User
		var expiresAt sql.NullString
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.Role, &u.CreatedAt, &expiresAt); err != nil {
			continue
		}
		if expiresAt.Valid {
			u.PasswordTemp = true
			val := expiresAt.String
			u.PasswordExpiresAt = &val
		}
		users = append(users, u)
	}

	c.JSON(http.StatusOK, users)
}
```

- [ ] **Step 6: Correr el test y confirmar que pasa**

```bash
cd apps/api && go test ./internal/handlers/... -run TestUserHandlerList -v
```

Expected: `PASS`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/internal/models/models.go apps/api/internal/handlers/user_handler.go \
        apps/api/internal/handlers/testutil_test.go apps/api/internal/handlers/user_handler_test.go
git commit -m "feat(api): listar usuarios con estado de contraseña temporal"
```

---

### Task 3: Backend — `UserHandler.SetTempPassword`

**Files:**
- Modify: `apps/api/internal/handlers/user_handler.go`
- Modify: `apps/api/internal/handlers/user_handler_test.go`

**Interfaces:**
- Consumes: `auth.HashPassword` (existente, `apps/api/internal/auth/auth.go`), `config.Config.TempPasswordTTLHours` (Task 1).
- Produces: `UserHandler.SetTempPassword(c *gin.Context)`, respuesta `{"temp_password": string, "expires_at": string}`.

- [ ] **Step 1: Test — asignar contraseña temporal deja al usuario en estado `password_temp`**

```go
// agregar a apps/api/internal/handlers/user_handler_test.go
func TestUserHandlerSetTempPassword(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)

	adminID := createTestUser(t, sqlDB, "admin", "adminpass1")
	targetID := createTestUser(t, sqlDB, "user", "oldpassword1")

	h := &UserHandler{DB: sqlDB, Cfg: config.Config{TempPasswordTTLHours: 24}}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("user_id", adminID)
	c.Params = gin.Params{{Key: "id", Value: targetID}}
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/admin/users/"+targetID+"/temp-password", nil)

	h.SetTempPassword(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var out struct {
		TempPassword string `json:"temp_password"`
		ExpiresAt    string `json:"expires_at"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.TempPassword) < 10 {
		t.Fatalf("temp_password demasiado corta: %q", out.TempPassword)
	}

	// La contraseña vieja ya no sirve; la temporal sí.
	var hash string
	if err := sqlDB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, targetID).Scan(&hash); err != nil {
		t.Fatalf("select: %v", err)
	}
	if auth.CheckPassword(hash, "oldpassword1") {
		t.Fatal("la contraseña vieja todavía funciona")
	}
	if !auth.CheckPassword(hash, out.TempPassword) {
		t.Fatal("la contraseña temporal devuelta no coincide con el hash guardado")
	}

	var count int
	if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM password_resets WHERE user_id = ?`, targetID).Scan(&count); err != nil {
		t.Fatalf("select password_resets: %v", err)
	}
	if count != 1 {
		t.Fatalf("password_resets count = %d, esperaba 1", count)
	}
}
```

- [ ] **Step 2: Correr y confirmar que falla**

```bash
cd apps/api && go test ./internal/handlers/... -run TestUserHandlerSetTempPassword -v
```

Expected: `FAIL` (compilación — `SetTempPassword` no existe, `UserHandler.Cfg` no existe).

- [ ] **Step 3: Implementar**

```go
// apps/api/internal/handlers/user_handler.go — reemplazar el archivo completo
package handlers

import (
	"crypto/rand"
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/auth"
	"meshcore-map/api/internal/config"
	"meshcore-map/api/internal/models"
)

type UserHandler struct {
	DB  *sql.DB
	Cfg config.Config
}

func (h *UserHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT u.id, u.email, u.display_name, u.role, u.created_at, pr.expires_at
		FROM users u
		LEFT JOIN password_resets pr ON pr.user_id = u.id
		ORDER BY u.created_at DESC
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar usuarios"})
		return
	}
	defer rows.Close()

	users := []models.User{}
	for rows.Next() {
		var u models.User
		var expiresAt sql.NullString
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.Role, &u.CreatedAt, &expiresAt); err != nil {
			continue
		}
		if expiresAt.Valid {
			u.PasswordTemp = true
			val := expiresAt.String
			u.PasswordExpiresAt = &val
		}
		users = append(users, u)
	}

	c.JSON(http.StatusOK, users)
}

const tempPasswordAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
const tempPasswordLength = 14

func generateTempPassword() (string, error) {
	b := make([]byte, tempPasswordLength)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	pw := make([]byte, tempPasswordLength)
	for i, v := range b {
		pw[i] = tempPasswordAlphabet[int(v)%len(tempPasswordAlphabet)]
	}
	return string(pw), nil
}

func (h *UserHandler) SetTempPassword(c *gin.Context) {
	adminID, _ := c.Get("user_id")
	targetID := c.Param("id")

	var exists string
	if err := h.DB.QueryRow(`SELECT id FROM users WHERE id = ?`, targetID).Scan(&exists); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "usuario no encontrado"})
		return
	}

	tempPassword, err := generateTempPassword()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo generar la contraseña temporal"})
		return
	}
	hash, err := auth.HashPassword(tempPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo procesar la contraseña"})
		return
	}

	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(h.Cfg.TempPasswordTTLHours) * time.Hour).Format("2006-01-02 15:04:05")

	tx, err := h.DB.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo iniciar la operación"})
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, targetID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo actualizar la contraseña"})
		return
	}
	if _, err := tx.Exec(`
		INSERT INTO password_resets (user_id, expires_at, created_by)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			expires_at = excluded.expires_at,
			created_by = excluded.created_by,
			created_at = datetime('now')
	`, targetID, expiresAt, adminID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo registrar la contraseña temporal"})
		return
	}
	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo completar la operación"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"temp_password": tempPassword,
		"expires_at":    expiresAt,
	})
}
```

Agregar imports `encoding/json` y `meshcore-map/api/internal/config` al test file (`user_handler_test.go`).

- [ ] **Step 4: Correr y confirmar que pasa**

```bash
cd apps/api && go test ./internal/handlers/... -run TestUserHandlerSetTempPassword -v
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/handlers/user_handler.go apps/api/internal/handlers/user_handler_test.go
git commit -m "feat(api): endpoint admin para asignar contraseña temporal"
```

---

### Task 4: Backend — `Login` respeta contraseña temporal y su vencimiento

**Files:**
- Modify: `apps/api/internal/handlers/auth_handler.go`
- Create: `apps/api/internal/handlers/auth_handler_test.go`

**Interfaces:**
- Produces: respuesta de `POST /auth/login` gana el campo `must_change_password bool`; login con temporal vencida devuelve 401.

- [ ] **Step 1: Tests — 3 casos (normal, temporal vigente, temporal vencida)**

```go
// apps/api/internal/handlers/auth_handler_test.go
package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/config"
)

func doLogin(t *testing.T, h *AuthHandler, email, password string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")

	h.Login(c)

	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAuthHandlerLoginNormal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "password123")

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	w, out := doLogin(t, h, userID+"@example.com", "password123")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if out["must_change_password"] != false {
		t.Fatalf("must_change_password = %v, esperaba false", out["must_change_password"])
	}
	if out["token"] == "" || out["token"] == nil {
		t.Fatal("token vacío")
	}
}

func TestAuthHandlerLoginTempPasswordVigente(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "temppass123")
	setPasswordReset(t, sqlDB, userID, time.Now().Add(1*time.Hour))

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	w, out := doLogin(t, h, userID+"@example.com", "temppass123")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if out["must_change_password"] != true {
		t.Fatalf("must_change_password = %v, esperaba true", out["must_change_password"])
	}
}

func TestAuthHandlerLoginTempPasswordVencida(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "temppass123")
	setPasswordReset(t, sqlDB, userID, time.Now().Add(-1*time.Hour))

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	w, _ := doLogin(t, h, userID+"@example.com", "temppass123")

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s, esperaba 401", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Correr y confirmar que fallan**

```bash
cd apps/api && go test ./internal/handlers/... -run TestAuthHandlerLogin -v
```

Expected: `TestAuthHandlerLoginNormal` pasa (la lógica actual ya soporta login simple, pero `must_change_password` no existe en la respuesta → falla el assert). Los otros dos: `FAIL`.

- [ ] **Step 3: Implementar**

```go
// apps/api/internal/handlers/auth_handler.go — reemplazar func (h *AuthHandler) Login
func (h *AuthHandler) Login(c *gin.Context) {
	var in loginInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var id, hash, role string
	var tempExpiresAt sql.NullString
	err := h.DB.QueryRow(`
		SELECT u.id, u.password_hash, u.role, pr.expires_at
		FROM users u
		LEFT JOIN password_resets pr ON pr.user_id = u.id
		WHERE u.email = ?
	`, in.Email).Scan(&id, &hash, &role, &tempExpiresAt)
	if err != nil || !auth.CheckPassword(hash, in.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "credenciales inválidas"})
		return
	}

	mustChange := false
	if tempExpiresAt.Valid {
		now := time.Now().UTC().Format("2006-01-02 15:04:05")
		if tempExpiresAt.String < now {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "la contraseña temporal venció, pedí una nueva a un administrador"})
			return
		}
		mustChange = true
	}

	token, err := auth.IssueToken(h.Cfg.JWTSecret, id, role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo generar el token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"token": token, "must_change_password": mustChange})
}
```

- [ ] **Step 4: Correr y confirmar que pasan**

```bash
cd apps/api && go test ./internal/handlers/... -run TestAuthHandlerLogin -v
```

Expected: `PASS` los 3.

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/handlers/auth_handler.go apps/api/internal/handlers/auth_handler_test.go
git commit -m "feat(api): login respeta contraseña temporal y su vencimiento"
```

---

### Task 5: Backend — `Me` expone estado de contraseña temporal

**Files:**
- Modify: `apps/api/internal/handlers/auth_handler.go`
- Modify: `apps/api/internal/handlers/auth_handler_test.go`

**Interfaces:**
- Produces: `GET /me` gana `password_temp bool` y `password_expires_at string|null`.

- [ ] **Step 1: Test**

```go
// agregar a apps/api/internal/handlers/auth_handler_test.go
func TestAuthHandlerMeIncludesTempPasswordState(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "password123")
	setPasswordReset(t, sqlDB, userID, time.Now().Add(1*time.Hour))

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("user_id", userID)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)

	h.Me(c)

	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if out["password_temp"] != true {
		t.Fatalf("password_temp = %v, esperaba true", out["password_temp"])
	}
	if out["password_expires_at"] == nil {
		t.Fatal("password_expires_at es nil, esperaba una fecha")
	}
}
```

- [ ] **Step 2: Correr y confirmar que falla**

```bash
cd apps/api && go test ./internal/handlers/... -run TestAuthHandlerMe -v
```

- [ ] **Step 3: Implementar**

```go
// apps/api/internal/handlers/auth_handler.go — reemplazar func (h *AuthHandler) Me
func (h *AuthHandler) Me(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var email, displayName, role string
	var tempExpiresAt sql.NullString
	err := h.DB.QueryRow(`
		SELECT u.email, u.display_name, u.role, pr.expires_at
		FROM users u
		LEFT JOIN password_resets pr ON pr.user_id = u.id
		WHERE u.id = ?
	`, userID).Scan(&email, &displayName, &role, &tempExpiresAt)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "usuario no encontrado"})
		return
	}

	resp := gin.H{
		"id":                  userID,
		"email":               email,
		"display_name":        displayName,
		"role":                role,
		"password_temp":       tempExpiresAt.Valid,
		"password_expires_at": nil,
	}
	if tempExpiresAt.Valid {
		resp["password_expires_at"] = tempExpiresAt.String
	}
	c.JSON(http.StatusOK, resp)
}
```

- [ ] **Step 4: Correr y confirmar que pasa**

```bash
cd apps/api && go test ./internal/handlers/... -run TestAuthHandlerMe -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/internal/handlers/auth_handler.go apps/api/internal/handlers/auth_handler_test.go
git commit -m "feat(api): /me expone si la contraseña actual es temporal"
```

---

### Task 6: Backend — `ChangePassword` (PATCH /me/password)

**Files:**
- Modify: `apps/api/internal/handlers/auth_handler.go`
- Modify: `apps/api/internal/handlers/auth_handler_test.go`

**Interfaces:**
- Produces: `AuthHandler.ChangePassword(c *gin.Context)`; `PATCH /me/password` body `{current_password, new_password}` → `{"status":"ok"}` o 401 si `current_password` no matchea.

- [ ] **Step 1: Tests — cambio exitoso borra el estado temporal; password actual incorrecta rechaza**

```go
// agregar a apps/api/internal/handlers/auth_handler_test.go
func TestAuthHandlerChangePasswordSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "oldpassword1")
	setPasswordReset(t, sqlDB, userID, time.Now().Add(1*time.Hour))

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	body, _ := json.Marshal(map[string]string{
		"current_password": "oldpassword1",
		"new_password":      "brandnewpassword1",
	})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("user_id", userID)
	c.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/me/password", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")

	h.ChangePassword(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var count int
	sqlDB.QueryRow(`SELECT COUNT(*) FROM password_resets WHERE user_id = ?`, userID).Scan(&count)
	if count != 0 {
		t.Fatalf("password_resets sigue teniendo %d filas, esperaba 0", count)
	}

	var hash string
	sqlDB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if !auth.CheckPassword(hash, "brandnewpassword1") {
		t.Fatal("la nueva contraseña no quedó guardada")
	}
}

func TestAuthHandlerChangePasswordWrongCurrent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	sqlDB := setupTestDB(t)
	userID := createTestUser(t, sqlDB, "user", "oldpassword1")

	h := &AuthHandler{DB: sqlDB, Cfg: config.Config{JWTSecret: "test-secret"}}
	body, _ := json.Marshal(map[string]string{
		"current_password": "wrongpassword",
		"new_password":      "brandnewpassword1",
	})
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Set("user_id", userID)
	c.Request = httptest.NewRequest(http.MethodPatch, "/api/v1/me/password", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")

	h.ChangePassword(c)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, esperaba 401", w.Code)
	}
}
```

- [ ] **Step 2: Correr y confirmar que fallan (compilación: `ChangePassword` no existe)**

```bash
cd apps/api && go test ./internal/handlers/... -run TestAuthHandlerChangePassword -v
```

- [ ] **Step 3: Implementar**

```go
// apps/api/internal/handlers/auth_handler.go — agregar al final del archivo
type changePasswordInput struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewPassword     string `json:"new_password" binding:"required,min=8"`
}

func (h *AuthHandler) ChangePassword(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var in changePasswordInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var hash string
	if err := h.DB.QueryRow(`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "usuario no encontrado"})
		return
	}
	if !auth.CheckPassword(hash, in.CurrentPassword) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "contraseña actual incorrecta"})
		return
	}

	newHash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo procesar la contraseña"})
		return
	}

	tx, err := h.DB.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo iniciar la operación"})
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, newHash, userID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo actualizar la contraseña"})
		return
	}
	if _, err := tx.Exec(`DELETE FROM password_resets WHERE user_id = ?`, userID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo limpiar el estado temporal"})
		return
	}
	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo completar la operación"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
```

- [ ] **Step 4: Correr y confirmar que pasan**

```bash
cd apps/api && go test ./internal/handlers/... -v
```

Expected: todos los tests del paquete `handlers` en `PASS` (incluye Tasks 2–6).

- [ ] **Step 5: `go vet` limpio**

```bash
cd apps/api && go vet ./...
```

Expected: sin salida (sin errores).

- [ ] **Step 6: Commit**

```bash
git add apps/api/internal/handlers/auth_handler.go apps/api/internal/handlers/auth_handler_test.go
git commit -m "feat(api): endpoint para cambiar la contraseña propia"
```

---

### Task 7: Backend — cablear rutas en `router.go`

**Files:**
- Modify: `apps/api/internal/router/router.go`

**Interfaces:**
- Consumes: `handlers.UserHandler` (Task 2/3), `handlers.AuthHandler.ChangePassword` (Task 6).
- Produces: rutas `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:id/temp-password`, `PATCH /api/v1/me/password`.

- [ ] **Step 1: Editar router.go**

```go
// apps/api/internal/router/router.go
authH := &handlers.AuthHandler{DB: db, Cfg: cfg}
reportH := &handlers.ReportHandler{DB: db, Cfg: cfg}
cellH := &handlers.CellHandler{DB: db}
adminH := &handlers.AdminHandler{DB: db}
inviteH := &handlers.InviteHandler{DB: db}
userH := &handlers.UserHandler{DB: db, Cfg: cfg}

// junto a authRateLimit — límite propio y más estricto que el genérico
// de /admin (300/h): este endpoint deja adivinar la contraseña actual
// con un JWT robado, no queremos darle presupuesto amplio de intentos.
changePasswordRateLimit := middleware.RateLimit(middleware.PerHour(20), 5)

v1 := r.Group("/api/v1")
{
	v1.POST("/auth/register", authRateLimit, authH.Register)
	v1.POST("/auth/login", authRateLimit, authH.Login)
	v1.POST("/auth/invite-codes/validate", authRateLimit, inviteH.Validate)
	v1.GET("/cells", cellH.List)
	v1.GET("/cells/:h3_index/origins", cellH.Origins)

	authed := v1.Group("")
	authed.Use(middleware.RequireAuth(cfg.JWTSecret))
	{
		authed.GET("/me", authH.Me)
		authed.PATCH("/me/password", changePasswordRateLimit, authH.ChangePassword)
		authed.POST("/reports", reportH.Create)

		admin := authed.Group("/admin")
		admin.Use(middleware.RequireAdmin())
		{
			admin.GET("/reports", adminH.ListReports)
			admin.PATCH("/reports/:id", adminH.ReviewReport)
			admin.GET("/export.csv", adminH.ExportCSV)
			admin.DELETE("/cells/:h3_index", adminH.DeleteCell)
			admin.PATCH("/cells/:h3_index/score", adminH.UpdateCellScore)
			admin.DELETE("/cells/:h3_index/score", adminH.RevertCellScore)
			admin.POST("/invite-codes", inviteH.Generate)
			admin.GET("/invite-codes", inviteH.List)
			admin.GET("/users", userH.List)
			admin.POST("/users/:id/temp-password", userH.SetTempPassword)
		}
	}
}
```

- [ ] **Step 2: Build**

```bash
cd apps/api && go build -o /tmp/api-build-check ./cmd/api && rm /tmp/api-build-check
```

Expected: sin errores.

- [ ] **Step 3: Verificación manual end-to-end con curl**

```bash
cd apps/api && DB_PATH=/tmp/meshcore-e2e.db go run ./cmd/api &
sleep 1

# admin bootstrap (mismo flujo que CLAUDE.md) omitido por brevedad —
# asumir $ADMIN_TOKEN ya obtenido y un usuario normal $USER_ID existente.

curl -s -X POST http://localhost:8080/api/v1/admin/users/$USER_ID/temp-password \
  -H "Authorization: Bearer $ADMIN_TOKEN" | tee /tmp/temp-pw.json

TEMP_PW=$(jq -r .temp_password /tmp/temp-pw.json)
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$TEMP_PW\"}"
# Expected: 200, {"token":"...", "must_change_password":true}

kill %1; rm /tmp/meshcore-e2e.db
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/internal/router/router.go
git commit -m "feat(api): cablear rutas de perfil y contraseña temporal"
```

---

### Task 8: Frontend — `api.ts` (tipos, funciones, guard compartido)

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Produces: `getMe()`, `listUsers()`, `setTempPassword(userId)`, `changePassword(current, next)`, `checkForcedPasswordChange()`.

- [ ] **Step 1: Agregar a `apps/web/src/lib/api.ts`**

```ts
export interface Me {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'admin';
  password_temp: boolean;
  password_expires_at: string | null;
}

export function getMe(): Promise<Me> {
  return apiFetch('/api/v1/me');
}

export function changePassword(current_password: string, new_password: string) {
  return apiFetch('/api/v1/me/password', {
    method: 'PATCH',
    body: JSON.stringify({ current_password, new_password }),
  });
}

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: 'user' | 'admin';
  created_at: string;
  password_temp: boolean;
  password_expires_at?: string;
}

export function listUsers(): Promise<AdminUser[]> {
  return apiFetch('/api/v1/admin/users');
}

export function setTempPassword(userId: string): Promise<{ temp_password: string; expires_at: string }> {
  return apiFetch(`/api/v1/admin/users/${userId}/temp-password`, { method: 'POST' });
}

// Guard de UX (no de seguridad — el servidor no bloquea otras rutas
// mientras la contraseña siga siendo temporal, ver plan de gaps). Cada
// página autenticada que quiera forzar el cambio antes de dejar
// operar la llama una vez al cargar.
export async function checkForcedPasswordChange() {
  if (!localStorage.getItem('token')) return;
  if (window.location.pathname === '/perfil') return;
  try {
    const me = await getMe();
    if (me.password_temp) {
      window.location.href = '/perfil?forced=1';
    }
  } catch {
    // token vencido/inválido — las páginas ya manejan ese caso por su cuenta.
  }
}
```

- [ ] **Step 2: Typecheck del build de Astro**

```bash
cd apps/web && npm run build
```

Expected: build exitoso, sin errores de TS (las funciones nuevas no se usan todavía, pero deben compilar).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): cliente API para perfil y contraseña temporal"
```

---

### Task 9: Frontend — página `/perfil`

**Files:**
- Create: `apps/web/src/pages/perfil.astro`
- Create: `apps/web/src/lib/perfilPage.ts`

**Interfaces:**
- Consumes: `getMe`, `changePassword` (Task 8).

- [ ] **Step 1: Crear la página**

```astro
---
// apps/web/src/pages/perfil.astro
import '../styles/global.css';
---
<html lang="es">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>Mi perfil — MeshCore Santander</title></head>
<body>
  <header class="topbar">
    <h1 class="brand">
      <svg class="brand-bars" viewBox="0 0 18 14" aria-hidden="true">
        <rect x="0" y="8" width="3" height="6" rx="1" />
        <rect x="5" y="5" width="3" height="9" rx="1" />
        <rect x="10" y="2" width="3" height="12" rx="1" />
        <rect x="15" y="0" width="3" height="14" rx="1" />
      </svg>
      Mi perfil
    </h1>
    <nav><a href="/">Volver al mapa</a></nav>
  </header>

  <main class="form-container">
    <p id="forced-banner" class="hint" hidden>
      Tu contraseña es temporal — cambiala antes de seguir usando la cuenta.
    </p>

    <section>
      <h2 class="section-title">Datos de la cuenta</h2>
      <p><strong>Nombre:</strong> <span id="profile-name"></span></p>
      <p><strong>Email:</strong> <span id="profile-email"></span></p>
    </section>

    <section>
      <h2 class="section-title">Cambiar contraseña</h2>
      <form id="password-form">
        <label>Contraseña actual <input type="password" id="current-password" required /></label>
        <label>Contraseña nueva <input type="password" id="new-password" required minlength="8" /></label>
        <button type="submit">Actualizar contraseña</button>
      </form>
    </section>
  </main>

  <script src="../lib/perfilPage.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Script de la página**

```ts
// apps/web/src/lib/perfilPage.ts
import { getMe, changePassword } from './api.ts';
import { showToast } from './toast.ts';

const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login';
}

if (new URLSearchParams(window.location.search).get('forced') === '1') {
  document.getElementById('forced-banner')!.hidden = false;
}

getMe().then((me) => {
  document.getElementById('profile-name')!.textContent = me.display_name;
  document.getElementById('profile-email')!.textContent = me.email;
  if (me.password_temp) {
    document.getElementById('forced-banner')!.hidden = false;
  }
}).catch(() => {
  localStorage.clear();
  window.location.href = '/login';
});

document.getElementById('password-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = (document.getElementById('current-password') as HTMLInputElement).value;
  const next = (document.getElementById('new-password') as HTMLInputElement).value;
  try {
    await changePassword(current, next);
    showToast('Contraseña actualizada.', 'success');
    document.getElementById('forced-banner')!.hidden = true;
    (document.getElementById('password-form') as HTMLFormElement).reset();
  } catch (err: any) {
    showToast(err.message || 'No se pudo cambiar la contraseña.', 'error');
  }
});
```

- [ ] **Step 3: Verificación manual en navegador**

```bash
cd apps/web && npm run dev
```

Con la API corriendo (`DB_PATH=./meshcore.db go run ./cmd/api` en otra terminal): loguearse en `/login`, navegar a `/perfil`, confirmar que nombre y email se muestran, cambiar la contraseña y confirmar el toast de éxito y que el login posterior con la contraseña vieja falla.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/perfil.astro apps/web/src/lib/perfilPage.ts
git commit -m "feat(web): página de perfil con cambio de contraseña"
```

---

### Task 10: Frontend — redirección forzada tras login + guard en páginas existentes

**Files:**
- Modify: `apps/web/src/lib/loginPage.ts`
- Modify: `apps/web/src/lib/mapPage.ts`
- Modify: `apps/web/src/lib/reportPage.ts`
- Modify: `apps/web/src/lib/adminPage.ts`

**Interfaces:**
- Consumes: `checkForcedPasswordChange` (Task 8), `must_change_password` en la respuesta de `login()` (ya existente en `api.ts`, backend Task 4).

- [ ] **Step 1: `loginPage.ts` — redirigir a `/perfil` si `must_change_password`**

```ts
// apps/web/src/lib/loginPage.ts — reemplazar el handler del submit
document.getElementById('login-form')!.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await login(
      (document.getElementById('email') as HTMLInputElement).value,
      (document.getElementById('password') as HTMLInputElement).value
    );
    localStorage.setItem('token', res.token);
    const payload = JSON.parse(atob(res.token.split('.')[1]));
    localStorage.setItem('role', payload.role);
    window.location.href = res.must_change_password ? '/perfil?forced=1' : '/';
  } catch (err: any) {
    showToast(err.message || 'No se pudo ingresar.', 'error');
  }
});
```

- [ ] **Step 2: Agregar el guard a las 3 páginas autenticadas restantes**

```ts
// al principio de apps/web/src/lib/mapPage.ts, reportPage.ts y adminPage.ts
import { checkForcedPasswordChange } from './api.ts';
checkForcedPasswordChange();
```

(Import y llamada agregados junto al resto de imports existentes de cada archivo — no reemplaza nada más.)

- [ ] **Step 3: Verificación manual**

Con un usuario que tiene `password_temp=true` (asignado vía admin, Task 12): loguearse → debe aterrizar en `/perfil?forced=1` con el banner visible. Cambiar la contraseña, navegar a `/`, `/reportar`, refrescar — no debe volver a redirigir.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/loginPage.ts apps/web/src/lib/mapPage.ts \
        apps/web/src/lib/reportPage.ts apps/web/src/lib/adminPage.ts
git commit -m "feat(web): forzar cambio de contraseña temporal tras login"
```

---

### Task 11: Frontend — link "Perfil" en el nav del mapa

**Files:**
- Modify: `apps/web/src/pages/index.astro`
- Modify: `apps/web/src/lib/mapPage.ts`

**Interfaces:**
- Consumes: mismo patrón de `nav-admin`/`nav-report` ya existente en `mapPage.ts`.

- [ ] **Step 1: Agregar el link al nav**

```astro
<!-- apps/web/src/pages/index.astro — dentro de <nav>, junto a nav-admin -->
<a href="/reportar" class="btn-primary" id="nav-report" hidden>Reportar conectividad</a>
<a href="/perfil" id="nav-perfil" hidden>Perfil</a>
<a href="/admin" id="nav-admin" hidden>Admin</a>
```

- [ ] **Step 2: Mostrarlo cuando hay sesión — junto a donde ya se muestra `nav-report`**

```ts
// apps/web/src/lib/mapPage.ts — en el bloque que ya hace
// document.getElementById('nav-report')!.hidden = false;
document.getElementById('nav-report')!.hidden = false;
document.getElementById('nav-perfil')!.hidden = false;
```

- [ ] **Step 3: Verificación manual**

`npm run dev`, loguearse, confirmar que "Perfil" aparece en el nav del mapa y lleva a `/perfil`; deslogueado, confirmar que sigue oculto.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/index.astro apps/web/src/lib/mapPage.ts
git commit -m "feat(web): link a Perfil en el nav del mapa"
```

---

### Task 12: Frontend — sección "Usuarios" en `/admin`

**Files:**
- Modify: `apps/web/src/pages/admin/index.astro`
- Modify: `apps/web/src/lib/adminPage.ts`

**Interfaces:**
- Consumes: `listUsers`, `setTempPassword` (Task 8).

- [ ] **Step 1: Agregar la sección a la página**

```astro
<!-- apps/web/src/pages/admin/index.astro — antes del cierre de </main> -->
<h2 class="section-title">Usuarios</h2>
<div class="table-scroll">
  <table id="users-table">
    <thead>
      <tr>
        <th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Acciones</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
</div>
<p id="users-status" class="hint"></p>
```

- [ ] **Step 2: Wiring en `adminPage.ts`**

```ts
// apps/web/src/lib/adminPage.ts — agregar junto a la carga de invite codes existente
import { listUsers, setTempPassword, type AdminUser } from './api.ts';

async function loadUsers() {
  const statusEl = document.getElementById('users-status')!;
  const tbody = document.querySelector('#users-table tbody')!;
  try {
    const users = await listUsers();
    tbody.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      const estado = u.password_temp
        ? `Temporal — vence ${u.password_expires_at}`
        : 'Normal';
      tr.innerHTML = `
        <td>${u.display_name}</td>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td>${estado}</td>
        <td><button class="btn-secondary" data-user-id="${u.id}">Asignar contraseña temporal</button></td>
      `;
      tbody.appendChild(tr);
    }
    statusEl.textContent = '';
  } catch (err: any) {
    statusEl.textContent = err.message || 'No se pudieron cargar los usuarios.';
  }
}

document.querySelector('#users-table tbody')!.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-user-id]') as HTMLButtonElement | null;
  if (!btn) return;
  const userId = btn.dataset.userId!;
  if (!confirm('¿Asignar una contraseña temporal a este usuario? Su contraseña actual dejará de funcionar.')) return;
  try {
    const { temp_password, expires_at } = await setTempPassword(userId);
    // Se muestra UNA sola vez — no se puede volver a recuperar después de este punto.
    alert(`Contraseña temporal: ${temp_password}\nVence: ${expires_at}\n\nCopiala ahora y compartila con el usuario por un canal directo (no queda registrada en ningún lado).`);
    loadUsers();
  } catch (err: any) {
    showToast(err.message || 'No se pudo asignar la contraseña temporal.', 'error');
  }
});

loadUsers();
```

(`showToast` ya está importado en `adminPage.ts` para las otras secciones — reusar el import existente.)

- [ ] **Step 3: Verificación manual**

`npm run dev`, entrar a `/admin` como admin, confirmar que la tabla de usuarios carga, click en "Asignar contraseña temporal" muestra el alert con la contraseña una sola vez, y que el estado de esa fila pasa a "Temporal — vence …" tras recargar la tabla.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin/index.astro apps/web/src/lib/adminPage.ts
git commit -m "feat(web): admin puede asignar contraseñas temporales desde /admin"
```

---

## Self-Review

**Cobertura del pedido original:**
1. Ruta `/perfil` visible con nombre y email → Task 9.
2. Cambiar contraseña dentro del perfil → Task 6 (backend) + Task 9 (frontend).
3. Setear contraseña random con TTL para cualquier usuario, borra la actual, login permitido solo para cambiarla, bloqueada tras vencer, solo rol admin puede asignarla → Tasks 1, 3, 4, 6, 12.
4. Listar todos los usuarios al admin con la opción de setear temporal → Tasks 2, 12.
5. Este documento — plan + gaps/tradeoffs sin tocar código → cumplido (nada de esto se ejecutó).

**Placeholder scan:** sin "TBD"/"implementar después" — cada step tiene código completo o comando exacto.

**Consistencia de tipos:** `Me`, `AdminUser`, `models.User` alineados entre backend (Task 2/5) y frontend (Task 8); `checkForcedPasswordChange` definido una vez (Task 8) y consumido igual en Tasks 9/10.

---

## Gaps, riesgos y tradeoffs

**1. No hay forma de entregar la contraseña temporal al usuario — es 100% manual.**
El plan no incluye envío de email (no existe infraestructura de correo en el repo — ni SMTP, ni servicio transaccional, `go.mod` no trae ningún cliente de mail). El admin ve la contraseña una vez en un `alert()` del navegador y tiene que pasársela al usuario por otro canal (WhatsApp, en persona, etc.). Si el admin cierra el alert sin copiarla, no hay forma de recuperarla — hay que generar una nueva. **Tradeoff:** agregar envío de email es una pieza de infraestructura nueva (proveedor SMTP, secretos, colas de reintento) que no pedía el ticket; lo dejo fuera a propósito (YAGNI) pero es la limitación más visible del feature tal como está planteado.

**2. El "forzar cambio de contraseña" es solo de UX, no un límite de seguridad real.**
`checkForcedPasswordChange()` (Task 8/10) redirige en el navegador, pero el servidor **no** bloquea `POST /reports`, `/admin/*`, etc. mientras `password_temp=true`. Alguien con el JWT (por ejemplo interceptado antes del cambio de contraseña) puede seguir usando la API normalmente — el JWT no lleva el estado `password_temp` y no se revalida en cada request. **Opciones no incluidas en este plan:**
   - (a) Chequear `password_resets` en `RequireAuth` en cada request (una query extra por request autenticado — costo bajo en SQLite local, pero es un cambio transversal a todo el middleware).
   - (b) Codificar `password_temp` en el JWT al loguear y aceptar que quede stale hasta el próximo login (JWT vive 72h — un usuario que cambia la contraseña seguiría teniendo un JWT viejo que dice `password_temp:true` y viceversa).
   Ninguna se implementó porque el pedido original no fue explícito sobre bloquear *otras* rutas, solo sobre permitir login + cambio de contraseña. Si esto importa (por ejemplo, para que un admin no pueda operar con una contraseña temporal sin cambiarla primero), decidir (a) o (b) antes de ejecutar Task 4/7.

**3. Qué pasa con la cuenta cuando el TTL vence — hoy es un bloqueo total, no un fallback.**
El diseño actual (Task 4) hace que el login falle con 401 apenas `expires_at` queda en el pasado — no hay "volver a la contraseña anterior" (se borró al asignar la temporal, tal como pediste) ni ningún flujo de auto-servicio. La única salida es que un admin le asigne una contraseña temporal *nueva*. Esto es coherente con el pedido ("después de vencido el ttl no se permitirá uso de la contraseña temporal") pero vale confirmarlo: si un usuario deja pasar el TTL de vacaciones, queda sin acceso hasta que alguien con rol admin intervenga — no hay recuperación por email tampoco (ver gap 1).

**4. `ON CONFLICT(user_id) DO UPDATE` en `password_resets` permite reasignar antes de que expire la anterior.**
Si un admin asigna una temporal, y sin que el usuario la use, la vuelve a asignar, la fila de `password_resets` se pisa (nueva `expires_at`/`created_by`) y la contraseña vieja (nunca usada) deja de servir silenciosamente. Comportamiento razonable, pero no hay ningún log de auditoría de "quién pisó la contraseña de quién y cuándo" más allá de `created_by`/`created_at` en esa única fila (no hay historial). Si se necesita auditoría, `password_resets` tendría que ser un log append-only en vez de una fila por usuario — cambio de diseño que no hice porque no fue parte del pedido.

**5. Primeros tests automatizados del backend — decisión, no efecto colateral.**
CLAUDE.md dice explícitamente "no hay suite de tests todavía". Este plan agrega `internal/handlers/*_test.go` (Tasks 2–6) porque tocar login/contraseñas sin ningún test me parece el peor lugar posible para no tenerlos. **Alternativa más barata:** saltear los tests Go y verificar todo a mano con `curl`, igual que el resto del backend hoy — más rápido de ejecutar pero deja la lógica de expiración de TTL (el caso más fácil de romper con un `off-by-one` de formato de fecha) sin red de seguridad. Recomiendo mantener los tests: son ~4 archivos acotados al feature, no una migración de todo el repo a TDD.

**6. `password_hash` viejo se pierde para siempre al asignar una temporal.**
"Al setear contraseña temporal la actual se elimina" se implementó literalmente: `UPDATE users SET password_hash = ?` pisa el hash sin guardar el anterior en ningún lado. Si el usuario nunca recibe la temporal (gap 1) o la pierde, no hay forma de "deshacer" — es indistinguible de haber vencido el TTL. Coherente con lo pedido, lo marco para que quede explícito que es irreversible por diseño.

**7. Rate limit de `PATCH /me/password` (20/h por IP) es nuevo, no pedido explícitamente.**
Lo agregué porque ese endpoint deja intentar adivinar `current_password` con un JWT válido — sin límite, alguien con un token robado podría fuerza-bruta la contraseña actual sin pasar por el rate limit de `/auth/*`. Es un límite por IP (mismo mecanismo que el resto de la app, sin Redis), así que un atacante detrás de un NAT compartido con otros usuarios legítimos podría toparlo — mismo tradeoff que ya existe en el resto de `middleware.RateLimit`.

**8. Nav "Perfil" solo se agregó a `index.astro` (Task 11), no a `reportar.astro` ni `admin/index.astro`.**
Esas dos páginas hoy solo tienen `<nav><a href="/">Volver al mapa</a></nav>` (sin nav condicional por rol) — agregarles el link también es mecánico pero no lo incluí en el plan para no inflarlo; queda como follow-up de una línea si se quiere el link visible desde todas partes, no solo desde el mapa.

**9. Sin límite de intentos de login específico para contraseñas temporales.**
`POST /auth/login` ya tiene `authRateLimit` (10/h) aplicado igual para todos los logins — no hay un límite más estricto para cuentas con `password_temp=true`, aunque en teoría son un blanco más valioso (contraseña recién generada, quizás compartida por un canal no cifrado). No lo separé porque el rate limit ya existente parece suficiente y duplicar la lógica por poco beneficio no valía la complejidad extra.
