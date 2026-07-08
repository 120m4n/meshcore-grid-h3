package db

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate ejecuta todos los archivos .sql embebidos en orden alfabético
// (0001_..., 0002_..., etc.).
func Migrate(sqlDB *sql.DB) error {
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		content, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if _, err := sqlDB.Exec(string(content)); err != nil {
			return fmt.Errorf("migración %s falló: %w", name, err)
		}
	}

	return nil
}
