package session

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func setupMockHome(t *testing.T) string {
	t.Helper()
	tempDir := t.TempDir()

	// Backup existing env variables.
	origHome := os.Getenv("HOME")
	origUserProfile := os.Getenv("USERPROFILE")

	// Set env variables to our temporary directory to mock the user home directory.
	os.Setenv("HOME", tempDir)
	os.Setenv("USERPROFILE", tempDir)

	t.Cleanup(func() {
		os.Setenv("HOME", origHome)
		os.Setenv("USERPROFILE", origUserProfile)
	})

	return tempDir
}

func TestListAgySessions_AuthoritativeParsing(t *testing.T) {
	mockHome := setupMockHome(t)

	// Set up the required folder structure for agy sessions.
	conversationsDir := filepath.Join(mockHome, ".gemini", "antigravity-cli", "conversations")
	if err := os.MkdirAll(conversationsDir, 0755); err != nil {
		t.Fatalf("Failed to create mock conversations directory: %v", err)
	}

	brainDir := filepath.Join(mockHome, ".gemini", "antigravity-cli", "brain", "test-uuid-999", ".system_generated", "logs")
	if err := os.MkdirAll(brainDir, 0755); err != nil {
		t.Fatalf("Failed to create mock brain logs directory: %v", err)
	}

	cacheDir := filepath.Join(mockHome, ".gemini", "antigravity-cli", "cache")
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		t.Fatalf("Failed to create mock cache directory: %v", err)
	}

	// 1. Authoritative brain transcript log session.
	pbFile999 := filepath.Join(conversationsDir, "test-uuid-999.pb")
	if err := os.WriteFile(pbFile999, []byte(""), 0644); err != nil {
		t.Fatalf("Failed to write mock pb file: %v", err)
	}

	transcriptPath := filepath.Join(brainDir, "transcript.jsonl")
	// Double escaped Windows-style paths should get correctly parsed.
	transcriptContent := `{"Cwd": "\"C:\\\\mock\\\\cwd\""}` + "\n"
	if err := os.WriteFile(transcriptPath, []byte(transcriptContent), 0644); err != nil {
		t.Fatalf("Failed to write mock transcript log: %v", err)
	}

	// 2. Cached session from last_conversations.json.
	pbFile888 := filepath.Join(conversationsDir, "test-uuid-888.pb")
	if err := os.WriteFile(pbFile888, []byte(""), 0644); err != nil {
		t.Fatalf("Failed to write mock pb file: %v", err)
	}

	cachePath := filepath.Join(cacheDir, "last_conversations.json")
	cacheContent := `{"/mock/cwd/cached": "test-uuid-888"}`
	if err := os.WriteFile(cachePath, []byte(cacheContent), 0644); err != nil {
		t.Fatalf("Failed to write mock cache file: %v", err)
	}

	// List and verify the brain-logged session.
	sessionsBrain, err := ListAgySessions("C:/mock/cwd")
	if err != nil {
		t.Fatalf("ListAgySessions failed: %v", err)
	}

	if len(sessionsBrain) != 1 || sessionsBrain[0].ID != "test-uuid-999" {
		t.Errorf("Expected 1 session with ID 'test-uuid-999', got: %v", sessionsBrain)
	}

	// List and verify the cached session.
	sessionsCached, err := ListAgySessions("/mock/cwd/cached")
	if err != nil {
		t.Fatalf("ListAgySessions failed: %v", err)
	}

	if len(sessionsCached) != 1 || sessionsCached[0].ID != "test-uuid-888" {
		t.Errorf("Expected 1 session with ID 'test-uuid-888', got: %v", sessionsCached)
	}
}

func TestListPiSessions_TitleParsing(t *testing.T) {
	mockHome := setupMockHome(t)

	// Set up folder structure for pi sessions.
	sessionsDir := filepath.Join(mockHome, ".pi", "agent", "sessions", "--mock-cwd--")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatalf("Failed to create mock pi sessions directory: %v", err)
	}

	// Write session 1 with custom session_info name.
	sess1Path := filepath.Join(sessionsDir, "sess1.jsonl")
	sess1Content := `{"type":"session_info","name":"A premium Pi Session"}` + "\n"
	if err := os.WriteFile(sess1Path, []byte(sess1Content), 0644); err != nil {
		t.Fatalf("Failed to write mock session 1: %v", err)
	}

	// Write session 2 with user prompt fallback.
	sess2Path := filepath.Join(sessionsDir, "sess2.jsonl")
	sess2Content := `{"type":"msg","message":{"role":"user","content":[{"type":"text","text":"Show me antigravity code preset"}]}}` + "\n"
	if err := os.WriteFile(sess2Path, []byte(sess2Content), 0644); err != nil {
		t.Fatalf("Failed to write mock session 2: %v", err)
	}

	sessions, err := ListPiSessions("/mock/cwd")
	if err != nil {
		t.Fatalf("ListPiSessions failed: %v", err)
	}

	if len(sessions) != 2 {
		t.Fatalf("Expected 2 sessions, got %d", len(sessions))
	}

	var foundSess1, foundSess2 bool
	for _, s := range sessions {
		if s.ID == "sess1" {
			foundSess1 = true
			if s.Title != "A premium Pi Session" {
				t.Errorf("Expected title 'A premium Pi Session', got %q", s.Title)
			}
		} else if s.ID == "sess2" {
			foundSess2 = true
			if s.Title != "Show me antigravity code preset" {
				t.Errorf("Expected title 'Show me antigravity code preset', got %q", s.Title)
			}
		}
	}

	if !foundSess1 || !foundSess2 {
		t.Error("Did not find both expected sessions in results")
	}
}

func TestListOpenCodeSessions_DBQuery(t *testing.T) {
	mockHome := setupMockHome(t)

	// Set up SQLite DB location folder.
	dbDir := filepath.Join(mockHome, ".local", "share", "opencode")
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		t.Fatalf("Failed to create mock opencode database folder: %v", err)
	}

	dbPath := filepath.Join(dbDir, "opencode.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("Failed to open temporary sqlite db: %v", err)
	}
	defer db.Close()

	// Create tables matching opencode structure.
	_, err = db.Exec(`
		CREATE TABLE project (
			id TEXT PRIMARY KEY,
			worktree TEXT
		);
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			title TEXT,
			directory TEXT,
			project_id TEXT,
			parent_id TEXT,
			time_archived INTEGER,
			time_updated TEXT
		);
	`)
	if err != nil {
		t.Fatalf("Failed to initialise database tables: %v", err)
	}

	// Insert mock projects and sessions.
	_, err = db.Exec(`
		INSERT INTO project (id, worktree) VALUES ('proj1', '/mock/cwd');
		INSERT INTO project (id, worktree) VALUES ('proj2', '/mock/cwd');

		INSERT INTO session (id, title, directory, project_id, parent_id, time_archived, time_updated) 
		VALUES ('sess-db-1', 'Mock OpenCode Session 1', '', 'proj1', NULL, 0, '2026-05-31T07:57:06Z');

		INSERT INTO session (id, title, directory, project_id, parent_id, time_archived, time_updated) 
		VALUES ('sess-db-2', 'Mock OpenCode Session 2', '/mock/cwd', 'proj2', NULL, 0, '2026-06-01T12:00:00Z');

		INSERT INTO session (id, title, directory, project_id, parent_id, time_archived, time_updated) 
		VALUES ('sess-db-child', 'Child Session', '/mock/cwd', 'proj2', 'sess-db-2', 0, '2026-06-01T12:05:00Z');

		INSERT INTO session (id, title, directory, project_id, parent_id, time_archived, time_updated) 
		VALUES ('sess-db-archived', 'Archived Session', '/mock/cwd', 'proj2', NULL, 123456789, '2026-06-01T12:10:00Z');
	`)
	if err != nil {
		t.Fatalf("Failed to insert mock data: %v", err)
	}

	// Close database to flush writes.
	db.Close()

	sessions, err := ListOpenCodeSessions("/mock/cwd")
	if err != nil {
		t.Fatalf("ListOpenCodeSessions failed: %v", err)
	}

	// Child sessions (where parent_id is not empty) must be excluded from results.
	if len(sessions) != 2 {
		t.Fatalf("Expected exactly 2 sessions, got %d: %v", len(sessions), sessions)
	}

	var foundSess1, foundSess2 bool
	for _, s := range sessions {
		if s.ID == "sess-db-1" {
			foundSess1 = true
			if s.Title != "Mock OpenCode Session 1" {
				t.Errorf("Expected title 'Mock OpenCode Session 1', got %q", s.Title)
			}
		} else if s.ID == "sess-db-2" {
			foundSess2 = true
			if s.Title != "Mock OpenCode Session 2" {
				t.Errorf("Expected title 'Mock OpenCode Session 2', got %q", s.Title)
			}
		}
	}

	if !foundSess1 || !foundSess2 {
		t.Error("Did not find both expected database sessions in results")
	}
}
