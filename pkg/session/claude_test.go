package session

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeSessionNamingPriority(t *testing.T) {
	mockHome := setupMockHome(t)

	// Create directories
	projectsDir := filepath.Join(mockHome, ".claude", "projects", "C--mockpath")
	if err := os.MkdirAll(projectsDir, 0755); err != nil {
		t.Fatalf("failed to create projects dir: %v", err)
	}

	sessionsDir := filepath.Join(mockHome, ".claude", "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatalf("failed to create sessions dir: %v", err)
	}

	// Write mock JSONL files with different metadata content
	session1File := filepath.Join(projectsDir, "session-1.jsonl")
	// Has both slug and aiTitle (priority aiTitle > slug)
	session1Content := `{"type":"mode","mode":"normal","sessionId":"session-1"}` + "\n" +
		`{"parentUuid":"1","isSidechain":false,"slug":"stateless-sleeping-steele","sessionId":"session-1"}` + "\n" +
		`{"type":"ai-title","aiTitle":"Analyze the build system","sessionId":"session-1"}` + "\n"
	if err := os.WriteFile(session1File, []byte(session1Content), 0644); err != nil {
		t.Fatalf("failed to write session 1 log: %v", err)
	}

	// Has only slug (priority slug)
	session2File := filepath.Join(projectsDir, "session-2.jsonl")
	session2Content := `{"parentUuid":"2","isSidechain":false,"slug":"mellow-dreaming-hellman","sessionId":"session-2"}` + "\n"
	if err := os.WriteFile(session2File, []byte(session2Content), 0644); err != nil {
		t.Fatalf("failed to write session 2 log: %v", err)
	}

	// Has only summary (priority summary)
	session3File := filepath.Join(projectsDir, "session-3.jsonl")
	session3Content := `{"type":"summary","summary":"Implemented widgets feature","sessionId":"session-3"}` + "\n"
	if err := os.WriteFile(session3File, []byte(session3Content), 0644); err != nil {
		t.Fatalf("failed to write session 3 log: %v", err)
	}

	// Has active session file under ~/.claude/sessions/
	session4File := filepath.Join(projectsDir, "session-4.jsonl")
	session4Content := `{"type":"mode","mode":"normal","sessionId":"session-4"}` + "\n"
	if err := os.WriteFile(session4File, []byte(session4Content), 0644); err != nil {
		t.Fatalf("failed to write session 4 log: %v", err)
	}

	// Write the active session JSON file
	activeSessionFile := filepath.Join(sessionsDir, "12345.json")
	activeSessionContent := `{"pid":12345,"sessionId":"session-4","name":"ae-e5","cwd":"C:\\mockpath"}`
	if err := os.WriteFile(activeSessionFile, []byte(activeSessionContent), 0644); err != nil {
		t.Fatalf("failed to write active session JSON: %v", err)
	}

	// Run ListClaudeSessions
	t.Logf("mockHome: %q", mockHome)
	t.Logf("projectsDir exists: %v", func() bool { _, err := os.Stat(projectsDir); return err == nil }())
	t.Logf("sessionsDir exists: %v", func() bool { _, err := os.Stat(sessionsDir); return err == nil }())
	sessions, err := ListClaudeSessions("C:/mockpath")
	if err != nil {
		t.Fatalf("ListClaudeSessions failed: %v", err)
	}
	t.Logf("found %d sessions", len(sessions))

	// We expect 4 sessions
	if len(sessions) != 4 {
		t.Fatalf("expected 4 sessions, got %d", len(sessions))
	}

	// Map them by ID for verification
	sessionsMap := make(map[string]Session)
	for _, s := range sessions {
		sessionsMap[s.ID] = s
	}

	// Verify session-1 title is the AI-generated title ("Analyze the build system")
	if s, exists := sessionsMap["session-1"]; !exists || s.Title != "Analyze the build system" {
		t.Errorf("expected session-1 title to be 'Analyze the build system', got: %q", s.Title)
	}

	// Verify session-2 title is the slug ("mellow-dreaming-hellman")
	if s, exists := sessionsMap["session-2"]; !exists || s.Title != "mellow-dreaming-hellman" {
		t.Errorf("expected session-2 title to be 'mellow-dreaming-hellman', got: %q", s.Title)
	}

	// Verify session-3 title is the summary ("Implemented widgets feature")
	if s, exists := sessionsMap["session-3"]; !exists || s.Title != "Implemented widgets feature" {
		t.Errorf("expected session-3 title to be 'Implemented widgets feature', got: %q", s.Title)
	}

	// Verify session-4 title is the active session name ("ae-e5")
	if s, exists := sessionsMap["session-4"]; !exists || s.Title != "ae-e5" {
		t.Errorf("expected session-4 title to be 'ae-e5', got: %q", s.Title)
	}
}
