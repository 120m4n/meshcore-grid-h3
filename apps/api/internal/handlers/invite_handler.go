package handlers

import (
	"crypto/rand"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"meshcore-map/api/internal/models"
)

type InviteHandler struct {
	DB *sql.DB
}

// InviteCodeTTL: 72h desde la generación — suficiente para compartir
// el código por WhatsApp/Telegram sin apuro, sin que queden códigos
// viejos dando vueltas indefinidamente.
const InviteCodeTTL = 72 * time.Hour

// sin 0/O/1/I: códigos pensados para tipear o dictar a mano, evita
// confusiones visuales/auditivas comunes.
const inviteCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const inviteCodeLength = 8

func generateInviteCode() (string, error) {
	b := make([]byte, inviteCodeLength)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	code := make([]byte, inviteCodeLength)
	for i, v := range b {
		code[i] = inviteCodeAlphabet[int(v)%len(inviteCodeAlphabet)]
	}
	return string(code), nil
}

// Generate crea un código nuevo de un solo uso, TTL fijo de 72h.
func (h *InviteHandler) Generate(c *gin.Context) {
	adminID, _ := c.Get("user_id")

	code, err := generateInviteCode()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo generar el código"})
		return
	}
	now := time.Now().UTC()
	createdAt := now.Format("2006-01-02 15:04:05")
	expiresAt := now.Add(InviteCodeTTL).Format("2006-01-02 15:04:05")

	// created_at explícito (no el DEFAULT de SQLite): así la respuesta
	// no necesita un round-trip extra para devolver el valor real.
	_, err = h.DB.Exec(
		`INSERT INTO invite_codes (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		code, adminID, createdAt, expiresAt,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo guardar el código"})
		return
	}

	c.JSON(http.StatusCreated, models.InviteCode{
		Code:      code,
		CreatedBy: adminID.(string),
		CreatedAt: createdAt,
		ExpiresAt: expiresAt,
	})
}

// List devuelve todos los códigos (usados, expirados o activos) para
// que el admin vea el estado completo — el frontend decide cómo
// distinguirlos visualmente a partir de used_at/expires_at.
func (h *InviteHandler) List(c *gin.Context) {
	rows, err := h.DB.Query(`
		SELECT code, created_by, created_at, expires_at, used_by, used_at
		FROM invite_codes ORDER BY created_at DESC
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo consultar los códigos"})
		return
	}
	defer rows.Close()

	codes := []models.InviteCode{}
	for rows.Next() {
		var ic models.InviteCode
		var usedBy, usedAt sql.NullString
		if err := rows.Scan(&ic.Code, &ic.CreatedBy, &ic.CreatedAt, &ic.ExpiresAt, &usedBy, &usedAt); err != nil {
			continue
		}
		if usedBy.Valid {
			ic.UsedBy = &usedBy.String
		}
		if usedAt.Valid {
			ic.UsedAt = &usedAt.String
		}
		codes = append(codes, ic)
	}

	c.JSON(http.StatusOK, codes)
}

type validateInput struct {
	Code string `json:"code" binding:"required"`
}

// Validate chequea el código SIN consumirlo — el form de registro lo
// llama antes de mostrar los campos de email/password. Register vuelve
// a validar (y esta vez sí consume) al momento real de registrarse,
// porque el código puede vencer o gastarse entre ambos pasos.
func (h *InviteHandler) Validate(c *gin.Context) {
	var in validateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	code := strings.ToUpper(strings.TrimSpace(in.Code))

	var expiresAt string
	var usedAt sql.NullString
	err := h.DB.QueryRow(
		`SELECT expires_at, used_at FROM invite_codes WHERE code = ?`, code,
	).Scan(&expiresAt, &usedAt)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"valid": false, "error": "código inválido"})
		return
	}
	if usedAt.Valid {
		c.JSON(http.StatusGone, gin.H{"valid": false, "error": "código ya utilizado"})
		return
	}
	if expiresAt < time.Now().UTC().Format("2006-01-02 15:04:05") {
		c.JSON(http.StatusGone, gin.H{"valid": false, "error": "código expirado"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"valid": true})
}
