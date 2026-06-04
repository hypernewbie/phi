package session

import (
	"database/sql"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func ListOpenCodeSessions(cwd string) ([]Session, error) {
	dbPath := expandHome("~/.local/share/opencode/opencode.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return []Session{}, nil
	}

	// Open SQLite in read-only and WAL compatible mode
	db, err := sql.Open("sqlite", dbPath+"?_pragma=query_only=true&_pragma=busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	query := `
		SELECT s.id, s.title, s.directory, p.worktree, s.time_updated
		FROM session s
		LEFT JOIN project p ON s.project_id = p.id
		WHERE (s.parent_id IS NULL OR s.parent_id = '') AND (s.time_archived IS NULL OR s.time_archived = 0)
		ORDER BY s.time_updated DESC
	`
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []Session
	for rows.Next() {
		var id, title, directory, worktree string
		var rawTime interface{}
		err = rows.Scan(&id, &title, &directory, &worktree, &rawTime)
		if err != nil {
			continue
		}

		sessionCwd := directory
		if sessionCwd == "" {
			sessionCwd = worktree
		}

		// Normalize separators before comparing — git returns forward slashes on
		// Windows but OpenCode stores backslashes in the DB.
		if cwd != "" && filepath.ToSlash(sessionCwd) != filepath.ToSlash(cwd) {
			continue
		}

		t := parseRawTime(rawTime)

		sessions = append(sessions, Session{
			ID:          id,
			Title:       title,
			Cwd:         sessionCwd,
			Coder:       "opencode",
			TimeUpdated: t,
		})
	}
	return sessions, nil
}

func GetOpenCodeSessionTranscript(sessionID string) ([]Message, error) {
	dbPath := expandHome("~/.local/share/opencode/opencode.db")
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return []Message{}, nil
	}

	db, err := sql.Open("sqlite", dbPath+"?_pragma=query_only=true&_pragma=busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	query := `SELECT role, text FROM message WHERE session_id = ? ORDER BY time_created ASC`
	rows, err := db.Query(query, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var role, text string
		if err := rows.Scan(&role, &text); err != nil {
			continue
		}
		messages = append(messages, Message{
			Role: role,
			Text: text,
		})
	}
	return messages, nil
}
