package session

import (
	"database/sql"
	"os"

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
		WHERE s.parent_id IS NULL OR s.parent_id = ''
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

		// Group/filter sessions matching current directory
		if cwd != "" && worktree != cwd {
			continue
		}

		t := parseRawTime(rawTime)

		sessions = append(sessions, Session{
			ID:          id,
			Title:       title,
			Cwd:         worktree,
			Coder:       "opencode",
			TimeUpdated: t,
		})
	}
	return sessions, nil
}
