//go:build otel

package session

import (
	"database/sql"

	"github.com/XSAM/otelsql"
	semconv "go.opentelemetry.io/otel/semconv/v1.28.0"
)

// openDB opens the opencode SQLite database through otelsql so every
// query issued against the returned *sql.DB auto-spans — db.query is
// wrapped once here rather than hand-instrumented at each call site (plan:
// "wrap the driver, don't hand-instrument"). Requires db.QueryContext (not
// db.Query) at the call sites so spans nest under the caller's ctx —
// already the case after the M5a ctx-threading pass.
func openDB(dsn string) (*sql.DB, error) {
	return otelsql.Open("sqlite", dsn, otelsql.WithAttributes(semconv.DBSystemSqlite))
}
