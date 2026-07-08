package db

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// Connect abre el archivo SQLite y activa WAL + foreign_keys.
// Sin extensiones espaciales: geom_wkt en cell_agg es una columna TEXT
// plana (ver migración 0001). mattn/go-sqlite3 compila su propio SQLite
// vía cgo (amalgamation vendorizada), no depende de libsqlite3 del sistema.
func Connect(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on", path)

	sqlDB, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite solo soporta un writer a la vez; con WAL los lectores no se
	// bloquean, pero limitamos conexiones abiertas para evitar contención
	// excesiva de "database is locked" bajo carga concurrente.
	sqlDB.SetMaxOpenConns(4)

	if err := sqlDB.Ping(); err != nil {
		return nil, err
	}

	return sqlDB, nil
}
