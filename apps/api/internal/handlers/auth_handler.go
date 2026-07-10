package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"meshcore-map/api/internal/auth"
	"meshcore-map/api/internal/config"
)

type AuthHandler struct {
	DB  *sql.DB
	Cfg config.Config
}

type registerInput struct {
	Email       string `json:"email" binding:"required,email"`
	Password    string `json:"password" binding:"required,min=8"`
	DisplayName string `json:"display_name" binding:"required"`
	InviteCode  string `json:"invite_code" binding:"required"`
	// Honeypot: campo oculto en el form real que un humano nunca
	// completa — si viene con algo, es un bot rellenando todos los
	// inputs del DOM. No es obligatorio (binding sin "required") para
	// no romper clientes que no lo manden.
	Website string `json:"website"`
}

func (h *AuthHandler) Register(c *gin.Context) {
	var in registerInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if in.Website != "" {
		// Respuesta idéntica a un éxito real (sin revelar que se detectó
		// el honeypot) para no darle señal al bot de qué campo evitar.
		c.JSON(http.StatusCreated, gin.H{"token": ""})
		return
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo procesar la contraseña"})
		return
	}

	code := strings.ToUpper(strings.TrimSpace(in.InviteCode))
	now := time.Now().UTC().Format("2006-01-02 15:04:05")

	tx, err := h.DB.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo iniciar el registro"})
		return
	}
	defer tx.Rollback()

	var expiresAt string
	var usedAt sql.NullString
	err = tx.QueryRow(
		`SELECT expires_at, used_at FROM invite_codes WHERE code = ?`, code,
	).Scan(&expiresAt, &usedAt)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "código de invitación inválido"})
		return
	}
	if usedAt.Valid {
		c.JSON(http.StatusBadRequest, gin.H{"error": "código de invitación ya utilizado"})
		return
	}
	if expiresAt < now {
		c.JSON(http.StatusBadRequest, gin.H{"error": "código de invitación expirado"})
		return
	}

	id := uuid.NewString()
	_, err = tx.Exec(
		`INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')`,
		id, in.Email, hash, in.DisplayName,
	)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "el email ya está registrado"})
		return
	}

	// Marca el código usado dentro de la misma transacción que crea el
	// usuario — si dos registros pisan el mismo código a la vez, el
	// UPDATE con WHERE used_at IS NULL solo deja pasar al primero que
	// confirma (SQLite serializa escrituras, no hay condición de carrera).
	res, err := tx.Exec(
		`UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL`,
		id, now, code,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consumir el código de invitación"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "código de invitación ya utilizado"})
		return
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo completar el registro"})
		return
	}

	token, err := auth.IssueToken(h.Cfg.JWTSecret, id, "user")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo generar el token"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"token": token})
}

type loginInput struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var in loginInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var id, hash, role string
	err := h.DB.QueryRow(
		`SELECT id, password_hash, role FROM users WHERE email = ?`, in.Email,
	).Scan(&id, &hash, &role)
	if err != nil || !auth.CheckPassword(hash, in.Password) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "credenciales inválidas"})
		return
	}

	token, err := auth.IssueToken(h.Cfg.JWTSecret, id, role)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo generar el token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"token": token})
}

func (h *AuthHandler) Me(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var email, displayName, role string
	err := h.DB.QueryRow(
		`SELECT email, display_name, role FROM users WHERE id = ?`, userID,
	).Scan(&email, &displayName, &role)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "usuario no encontrado"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":           userID,
		"email":        email,
		"display_name": displayName,
		"role":         role,
	})
}
