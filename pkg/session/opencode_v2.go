package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/pkg/coders"
)

type opencodeV2AdapterImpl struct{ c coders.Coder }

func opencodeV2Adapter(c coders.Coder) Adapter { return opencodeV2AdapterImpl{c: c} }

// Ask the configured v2 binary for its DB path. This respects platform XDG
// roots, release channels, OPENCODE_DB, and profile-local environment values.
// `debug paths db` neither starts a server nor opens/migrates the database.
func openCodeV2DB(ctx context.Context, c coders.Coder) (*sql.DB, error) {
	out, err := coders.OpenCodeOutput(ctx, c, "debug", "paths", "db")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("cannot locate OpenCode 2 session history; check opencode_command and the v2 installation")
	}
	path := strings.TrimSuffix(strings.TrimSuffix(string(out), "\n"), "\r")
	if path == ":memory:" {
		return nil, nil
	}
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\r\n\x00") {
		return nil, fmt.Errorf("OpenCode 2 is required to locate session history (debug paths db)")
	}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("OpenCode session database is a directory")
	}
	uriPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath // file:///C:/... on Windows
	}
	uri := url.URL{Scheme: "file", Path: uriPath}
	query := url.Values{"mode": {"ro"}, "_pragma": {"query_only=true", "busy_timeout=5000"}}
	uri.RawQuery = query.Encode()
	db, err := openDB(uri.String())
	if err != nil {
		return nil, err
	}
	var exists int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session_v2'`).Scan(&exists); err != nil {
		db.Close()
		return nil, err
	}
	if exists == 0 {
		// Before the first v2 launch the shared DB may contain only v1
		// tables. Never list them as v2 sessions or migrate from Phi.
		db.Close()
		return nil, nil
	}
	return db, nil
}

// V2's --session creates a conversation if its ID is missing. Phi's
// resume action must not silently turn an old/stale ID into an empty one.
func ValidateOpenCodeV2Resume(ctx context.Context, c coders.Coder, id string) error {
	db, err := openCodeV2DB(ctx, c)
	if err != nil {
		return err
	}
	if db != nil {
		defer db.Close()
		var exists int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM session_v2 WHERE id = ?`, id).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			return nil
		}
	}
	return fmt.Errorf("OpenCode 2 session was not found; start a new Mini session once to migrate v1 history, then refresh the session list")
}

func (a opencodeV2AdapterImpl) List(ctx context.Context, cwd string) ([]Session, error) {
	db, err := openCodeV2DB(ctx, a.c)
	if err != nil || db == nil {
		return []Session{}, err
	}
	defer db.Close()
	return listOpenCodeV2SessionsFromDB(ctx, db, cwd, a.c.ID)
}

func listOpenCodeV2SessionsFromDB(ctx context.Context, db *sql.DB, cwd, coder string) ([]Session, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT s.id, COALESCE(s.title, s.slug, s.id), s.directory, COALESCE(p.worktree, ''), s.time_updated
		FROM session_v2 s LEFT JOIN project p ON s.project_id = p.id
		WHERE (s.parent_id IS NULL OR s.parent_id = '') AND (s.time_archived IS NULL OR s.time_archived = 0)
		ORDER BY s.time_updated DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sessions := []Session{}
	for rows.Next() {
		var id, title, directory, worktree string
		var updated interface{}
		if err := rows.Scan(&id, &title, &directory, &worktree, &updated); err != nil {
			return nil, err
		}
		if directory == "" {
			directory = worktree
		}
		if cwd != "" && NormalisePath(directory) != NormalisePath(cwd) {
			continue
		}
		sessions = append(sessions, Session{ID: id, Title: title, Cwd: directory, Coder: coder, TimeUpdated: parseRawTime(updated)})
	}
	return sessions, rows.Err()
}

func (a opencodeV2AdapterImpl) Transcript(ctx context.Context, cwd, id string) ([]Message, error) {
	db, err := openCodeV2DB(ctx, a.c)
	if err != nil || db == nil {
		return []Message{}, err
	}
	defer db.Close()
	return getOpenCodeV2TranscriptFromDB(ctx, db, id)
}

// V2 stores complete messages in session_message, not v1's message/part
// tables. Sequence order is authoritative; reasoning and tool content are
// not assistant prose and are deliberately omitted from the review view.
func getOpenCodeV2TranscriptFromDB(ctx context.Context, db *sql.DB, id string) ([]Message, error) {
	rows, err := db.QueryContext(ctx, `SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []Message{}
	for rows.Next() {
		var kind, raw string
		if err := rows.Scan(&kind, &raw); err != nil {
			return nil, err
		}
		var data struct {
			Text    string `json:"text"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal([]byte(raw), &data); err != nil {
			continue
		}
		text := ""
		switch kind {
		case "user":
			text = data.Text
		case "assistant":
			var b strings.Builder
			for _, part := range data.Content {
				if part.Type == "text" {
					b.WriteString(part.Text)
				}
			}
			text = b.String()
		default:
			continue
		}
		if strings.TrimSpace(text) != "" {
			messages = append(messages, Message{Role: kind, Text: text})
		}
	}
	return messages, rows.Err()
}
