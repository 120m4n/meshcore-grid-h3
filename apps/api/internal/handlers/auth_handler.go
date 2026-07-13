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
		respondError(c, http.StatusBadRequest, err.Error())
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
		respondError(c, http.StatusInternalServerError, "no se pudo procesar la contraseña")
		return
	}

	code := strings.ToUpper(strings.TrimSpace(in.InviteCode))
	now := time.Now().UTC().Format("2006-01-02 15:04:05")

	tx, err := h.DB.Begin()
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo iniciar el registro")
		return
	}
	defer tx.Rollback()

	var expiresAt string
	var usedAt sql.NullString
	err = tx.QueryRow(
		`SELECT expires_at, used_at FROM invite_codes WHERE code = ?`, code,
	).Scan(&expiresAt, &usedAt)
	if err != nil {
		respondError(c, http.StatusBadRequest, "código de invitación inválido")
		return
	}
	if usedAt.Valid {
		respondError(c, http.StatusBadRequest, "código de invitación ya utilizado")
		return
	}
	if expiresAt < now {
		respondError(c, http.StatusBadRequest, "código de invitación expirado")
		return
	}

	id := uuid.NewString()
	_, err = tx.Exec(
		`INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')`,
		id, in.Email, hash, in.DisplayName,
	)
	if err != nil {
		respondError(c, http.StatusConflict, "el email ya está registrado")
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
		respondError(c, http.StatusInternalServerError, "no se pudo consumir el código de invitación")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		respondError(c, http.StatusBadRequest, "código de invitación ya utilizado")
		return
	}

	if err := tx.Commit(); err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo completar el registro")
		return
	}

	token, err := auth.IssueToken(h.Cfg.JWTSecret, id, "user")
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo generar el token")
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
		respondError(c, http.StatusBadRequest, err.Error())
		return
	}

	var id, hash, role string
	err := h.DB.QueryRow(
		`SELECT id, password_hash, role FROM users WHERE email = ?`, in.Email,
	).Scan(&id, &hash, &role)
	if err != nil || !auth.CheckPassword(hash, in.Password) {
		respondError(c, http.StatusUnauthorized, "credenciales inválidas")
		return
	}

	token, err := auth.IssueToken(h.Cfg.JWTSecret, id, role)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "no se pudo generar el token")
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
		respondError(c, http.StatusNotFound, "usuario no encontrado")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":           userID,
		"email":        email,
		"display_name": displayName,
		"role":         role,
	})
}
