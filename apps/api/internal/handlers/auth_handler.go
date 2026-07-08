package handlers

import (
	"database/sql"
	"net/http"

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
}

func (h *AuthHandler) Register(c *gin.Context) {
	var in registerInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudo procesar la contraseña"})
		return
	}

	id := uuid.NewString()
	_, err = h.DB.Exec(
		`INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')`,
		id, in.Email, hash, in.DisplayName,
	)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "el email ya está registrado"})
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
