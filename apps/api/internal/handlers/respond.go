package handlers

import "github.com/gin-gonic/gin"

// respondError centraliza el formato de error de la API ({"error": "..."})
// — antes repetido inline en cada handler (c.JSON(status, gin.H{"error": msg})),
// un solo lugar si el formato de error cambia (p.ej. agregar un código interno).
func respondError(c *gin.Context, status int, message string) {
	c.JSON(status, gin.H{"error": message})
}
