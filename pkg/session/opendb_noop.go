//go:build !otel

package session

import "database/sql"

// openDB opens the opencode SQLite database. Default build: plain
// sql.Open — no otelsql dependency. See opendb_otel.go for the
// //go:build otel variant that wraps the driver so every query auto-spans.
func openDB(dsn string) (*sql.DB, error) {
	return sql.Open("sqlite", dsn)
}
