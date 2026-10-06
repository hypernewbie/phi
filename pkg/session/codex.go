package session

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/pkg/coders"
)

// Codex 0.160 stores its authoritative thread index in state_5.sqlite, even
// when conversation content has migrated from JSONL to paginated history.
// Phi reads the index only; Codex owns all migrations and resume semantics.
type codexAdapterImpl struct{ c coders.Coder }

func codexAdapter(c coders.Coder) Adapter { return codexAdapterImpl{c: c} }

func codexEnv(c coders.Coder, name string) string {
	if value, ok := c.Env[name]; ok {
		return strings.TrimSpace(value)
	}
	return strings.TrimSpace(os.Getenv(name))
}

func codexDB(ctx context.Context, c coders.Coder) (*sql.DB, error) {
	root := codexEnv(c, "CODEX_SQLITE_HOME")
	if root == "" {
		root = codexEnv(c, "CODEX_HOME")
	}
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		root = filepath.Join(home, ".codex")
	}
	path, err := filepath.Abs(filepath.Join(root, "state_5.sqlite"))
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Codex thread index is not a regular file")
	}
	db, err := openDB(path + "?_pragma=query_only=true&_pragma=busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func (a codexAdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	db, err := codexDB(ctx, a.c)
	if err != nil || db == nil {
		return []Session{}, err
	}
	defer db.Close()
	// Child-agent records have a structured source; do not offer them as
	// independent user conversations. Archived threads stay archived.
	rows, err := db.QueryContext(ctx, `SELECT id, COALESCE(title, ''), COALESCE(cwd, ''), COALESCE(updated_at, 0) FROM threads
		WHERE archived = 0 AND (source IN ('cli', 'vscode', 'exec', 'app', 'app-server') OR (source NOT LIKE '{%' AND source NOT LIKE '%subagent%'))
		ORDER BY updated_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var id, title, dir string
		var updated int64
		if err := rows.Scan(&id, &title, &dir, &updated); err != nil {
			return nil, err
		}
		if cwd != "" && NormalisePath(cwd) != NormalisePath(dir) {
			continue
		}
		if strings.TrimSpace(title) == "" {
			title = "Codex session " + id
		}
		out = append(out, Session{ID: id, Title: title, Cwd: dir, Coder: a.c.ID, TimeUpdated: parseRawTime(updated)})
	}
	return out, rows.Err()
}

func (codexAdapterImpl) Transcript(context.Context, string, string) ([]Message, error) {
	// Native Codex handles both rollout and paginated history. Never pretend
	// an index or a partial raw log is a complete conversation transcript.
	return nil, ErrTranscriptUnsupported
}
