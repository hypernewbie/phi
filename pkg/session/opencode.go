package session

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

func ListOpenCodeSessions(cwd string) ([]Session, error) {
	dbPath := expandHome("~/.local/share/opencode/opencode.db")
	fi, err := os.Stat(dbPath)
	if os.IsNotExist(err) || (err == nil && fi.IsDir()) {
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
	fi, err := os.Stat(dbPath)
	if os.IsNotExist(err) || (err == nil && fi.IsDir()) {
		return []Message{}, nil
	}

	db, err := sql.Open("sqlite", dbPath+"?_pragma=query_only=true&_pragma=busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	// 1. Get all messages for the session
	msgRows, err := db.Query(`SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer msgRows.Close()

	type msgData struct {
		Role string `json:"role"`
	}

	type partData struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}

	var messages []Message
	for msgRows.Next() {
		var id, dataStr string
		if err := msgRows.Scan(&id, &dataStr); err != nil {
			continue
		}

		var mInfo msgData
		if err := json.Unmarshal([]byte(dataStr), &mInfo); err != nil || mInfo.Role == "" {
			continue
		}

		// 2. Get all text parts for this message
		partRows, err := db.Query(`SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`, id)
		if err != nil {
			continue
		}

		var combinedText strings.Builder
		for partRows.Next() {
			var partStr string
			if err := partRows.Scan(&partStr); err == nil {
				var pInfo partData
				if err := json.Unmarshal([]byte(partStr), &pInfo); err == nil && pInfo.Type == "text" {
					combinedText.WriteString(pInfo.Text)
				}
			}
		}
		partRows.Close()

		txt := strings.TrimSpace(combinedText.String())
		if txt == "" {
			continue
		}

		messages = append(messages, Message{
			Role: mInfo.Role,
			Text: txt,
		})
	}

	return messages, nil
}
