package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseRawTime(t *testing.T) {
	// Test Unix seconds (int64)
	sec := int64(1700000000)
	parsedSec := parseRawTime(sec)
	if parsedSec.Unix() != sec {
		t.Errorf("Expected unix time %d, got %d", sec, parsedSec.Unix())
	}

	// Test Unix milliseconds (int64)
	ms := int64(1700000000000)
	parsedMs := parseRawTime(ms)
	if parsedMs.Unix() != sec {
		t.Errorf("Expected unix time from milliseconds %d, got %d", sec, parsedMs.Unix())
	}

	// Test RFC3339 string
	str := "2026-05-31T07:57:06Z"
	parsedStr := parseRawTime(str)
	if parsedStr.Format(time.RFC3339) != str {
		t.Errorf("Expected parsed time format %q, got %q", str, parsedStr.Format(time.RFC3339))
	}
}

func TestDecodeClaudePath(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"-home-hypernewbie-code-util", "/home/hypernewbie/code/util"},
		{"-home-user-project", "/home/user/project"},
		{"some-path", "some/path"},
	}

	for _, c := range cases {
		result := decodeClaudePath(c.input)
		if result != c.expected {
			t.Errorf("decodeClaudePath(%q) = %q; expected %q", c.input, result, c.expected)
		}
	}
}

func TestListAgySessionsRobutness(t *testing.T) {
	// Verify that ListAgySessions runs fine even if directory is empty or path doesn't exist
	sessions, err := ListAgySessions("/home/hypernewbie/code/nonexistent")
	if err != nil {
		t.Fatalf("Unexpected error listing agy sessions: %v", err)
	}
	// We shouldn't crash or return nil if conversations dir doesn't exist
	if sessions == nil {
		t.Error("Expected empty sessions slice, got nil")
	}
}

func TestAgySessionCwdAndSync(t *testing.T) {
	metaPath := getMetaFilePath()
	// Backup original file
	var backup []byte
	var backupExists bool
	if b, err := os.ReadFile(metaPath); err == nil {
		backup = b
		backupExists = true
	}

	// Clean up or restore at the end
	defer func() {
		if backupExists {
			_ = os.WriteFile(metaPath, backup, 0644)
		} else {
			_ = os.Remove(metaPath)
		}
	}()

	// 1. Test SaveAgySessionCwd
	testID := "test-session-uuid-12345"
	testCwd := "/home/hypernewbie/code/test-cwd"
	
	err := SaveAgySessionCwd(testID, testCwd)
	if err != nil {
		t.Fatalf("Failed to save session cwd: %v", err)
	}

	// Load and check
	m, err := LoadAgyMetaMap()
	if err != nil {
		t.Fatalf("Failed to load meta map: %v", err)
	}

	meta, exists := m[testID]
	if !exists {
		t.Fatalf("Session %s not found in meta map", testID)
	}

	if meta.Cwd != testCwd {
		t.Errorf("Expected Cwd %q, got %q", testCwd, meta.Cwd)
	}

	// 2. Test syncAgyCwdMappings robustness
	// This should run without errors even if cache or history files do not exist or are empty
	syncAgyCwdMappings(m)
}

func TestListGitWorktrees(t *testing.T) {
	cwd, err := os.Getwd()
	if err == nil {
		wts, err := ListGitWorktrees(cwd)
		if err != nil {
			t.Errorf("Unexpected error listing worktrees in active directory: %v", err)
		}
		if len(wts) < 1 {
			t.Error("Expected at least 1 worktree for active git repository, got 0")
		}
		found := false
		for _, wt := range wts {
			if wt.Path != "" {
				found = true
				break
			}
		}
		if !found {
			t.Error("Expected to find valid worktree paths")
		}
	}

	tempDir := t.TempDir()
	wts, err := ListGitWorktrees(tempDir)
	if err != nil {
		t.Errorf("Unexpected error listing worktrees in temp directory: %v", err)
	}
	if len(wts) != 1 {
		t.Errorf("Expected fallback worktrees size to be 1, got %d", len(wts))
	}
	if wts[0].Path != tempDir {
		t.Errorf("Expected fallback path to be %q, got %q", tempDir, wts[0].Path)
	}
	if wts[0].Branch != "" {
		t.Errorf("Expected fallback branch to be empty, got %q", wts[0].Branch)
	}
}

func TestClaudeSessionRename(t *testing.T) {
	metaPath := getMetaFilePath()
	// Backup original file
	var backup []byte
	var backupExists bool
	if b, err := os.ReadFile(metaPath); err == nil {
		backup = b
		backupExists = true
	}

	defer func() {
		if backupExists {
			_ = os.WriteFile(metaPath, backup, 0644)
		} else {
			_ = os.Remove(metaPath)
		}
	}()

	// Setup mock Claude projects directory
	tempHome := t.TempDir()
	homeKey := "USERPROFILE"
	if os.Getenv(homeKey) == "" {
		homeKey = "HOME"
	}
	origHomeVal := os.Getenv(homeKey)
	err := os.Setenv(homeKey, tempHome)
	if err != nil {
		t.Fatalf("setenv failed: %v", err)
	}
	defer os.Setenv(homeKey, origHomeVal)

	// Create project directory path: ~ / .claude / projects / C--mock-path
	projectDirName := "C--mock-path"
	mockSessionID := "conv_abc123"
	
	claudeProjPath := filepath.Join(tempHome, ".claude", "projects", projectDirName)
	if err := os.MkdirAll(claudeProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	
	jsonlPath := filepath.Join(claudeProjPath, mockSessionID+".jsonl")
	// Write standard JSONL file containing history but no summary
	if err := os.WriteFile(jsonlPath, []byte(`{"type":"message","text":"hello"}`+"\n"), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	// Initialise the rename in the sidecar mapping
	renameTitle := "Renamed Custom Claude Session"
	if err := SaveAgySessionName(mockSessionID, renameTitle); err != nil {
		t.Fatalf("SaveAgySessionName failed: %v", err)
	}

	// Run ListClaudeSessions
	sessions, err := ListClaudeSessions("C:/mock/path")
	if err != nil {
		t.Fatalf("ListClaudeSessions failed: %v", err)
	}

	if len(sessions) != 1 {
		t.Fatalf("Expected 1 Claude session, got %d", len(sessions))
	}

	if sessions[0].Title != renameTitle {
		t.Errorf("Expected title %q, got %q", renameTitle, sessions[0].Title)
	}
}

func TestGetPiSessionTranscript(t *testing.T) {
	tempHome := t.TempDir()
	homeKey := "USERPROFILE"
	if os.Getenv(homeKey) == "" {
		homeKey = "HOME"
	}
	origHomeVal := os.Getenv(homeKey)
	if err := os.Setenv(homeKey, tempHome); err != nil {
		t.Fatalf("setenv failed: %v", err)
	}
	defer os.Setenv(homeKey, origHomeVal)

	// Create project directory path: ~ / .pi / agent / sessions / --C--mock-path--
	projectDirName := "--C--mock-path--"
	mockSessionID := "conv_abc123"
	
	piProjPath := filepath.Join(tempHome, ".pi", "agent", "sessions", projectDirName)
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	
	jsonlPath := filepath.Join(piProjPath, mockSessionID+".jsonl")
	mockContent := `{"type":"session_info","name":"Custom Pi Title"}` + "\n" +
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello bot"}]}}` + "\n" +
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hello human"}]}}` + "\n" +
		`{"type":"msg","message":{"role":"user","content":[{"type":"text","text":"another user message"}]}}` + "\n" +
		`{"type":"msg","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool_xyz"}]}}` + "\n"

	if err := os.WriteFile(jsonlPath, []byte(mockContent), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	messages, err := GetPiSessionTranscript("C:/mock/path", mockSessionID)
	if err != nil {
		t.Fatalf("GetPiSessionTranscript failed: %v", err)
	}

	// We expect 4 messages because tool use lines are now included.
	if len(messages) != 4 {
		t.Fatalf("Expected 4 messages, got %d", len(messages))
	}

	if messages[0].Role != "user" || messages[0].Text != "hello bot" {
		t.Errorf("Unexpected user message: %+v", messages[0])
	}

	if messages[1].Role != "assistant" || messages[1].Text != "hello human" {
		t.Errorf("Unexpected assistant message: %+v", messages[1])
	}

	if messages[2].Role != "user" || messages[2].Text != "another user message" {
		t.Errorf("Unexpected third message: %+v", messages[2])
	}

	if messages[3].Role != "assistant" || messages[3].Text != "*(Used tool: tool)*" {
		t.Errorf("Unexpected fourth message: %+v", messages[3])
	}
}

func TestGetPiSessionTranscript_WithTools(t *testing.T) {
	tempHome := t.TempDir()
	homeKey := "USERPROFILE"
	if os.Getenv(homeKey) == "" {
		homeKey = "HOME"
	}
	origHomeVal := os.Getenv(homeKey)
	if err := os.Setenv(homeKey, tempHome); err != nil {
		t.Fatalf("setenv failed: %v", err)
	}
	defer os.Setenv(homeKey, origHomeVal)

	projectDirName := "--C--mock-path--"
	mockSessionID := "conv_tools_123"

	piProjPath := filepath.Join(tempHome, ".pi", "agent", "sessions", projectDirName)
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	jsonlPath := filepath.Join(piProjPath, mockSessionID+".jsonl")
	mockContent := `{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let's run a tool"},{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls -la"}}]}}` + "\n" +
		`{"type":"message","message":{"role":"toolResult","toolName":"bash","toolCallId":"call_1","content":[{"type":"text","text":"file1.txt\nfile2.txt"}]}}` + "\n"

	if err := os.WriteFile(jsonlPath, []byte(mockContent), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	messages, err := GetPiSessionTranscript("C:/mock/path", mockSessionID)
	if err != nil {
		t.Fatalf("GetPiSessionTranscript failed: %v", err)
	}

	if len(messages) != 2 {
		t.Fatalf("Expected 2 messages, got %d", len(messages))
	}

	// First message: assistant with thinking and tool use (including bash command)
	m0 := messages[0]
	if m0.Role != "assistant" {
		t.Errorf("Expected role assistant, got %s", m0.Role)
	}
	if !strings.Contains(m0.Text, "> **Thinking:**\n> let's run a tool") {
		t.Errorf("Missing thinking block: %s", m0.Text)
	}
	if !strings.Contains(m0.Text, "*(Used tool: bash)*") {
		t.Errorf("Missing tool use marker: %s", m0.Text)
	}
	if !strings.Contains(m0.Text, "```bash\nls -la\n```") {
		t.Errorf("Missing tool arguments block: %s", m0.Text)
	}

	// Second message: toolResult with output
	m1 := messages[1]
	if m1.Role != "toolResult" {
		t.Errorf("Expected role toolResult, got %s", m1.Role)
	}
	if !strings.Contains(m1.Text, "> **Tool Output (bash):**") {
		t.Errorf("Missing tool output header: %s", m1.Text)
	}
	if !strings.Contains(m1.Text, "file1.txt\nfile2.txt") {
		t.Errorf("Missing tool output text: %s", m1.Text)
	}
}

func TestGetPiSessionTranscript_RealFile(t *testing.T) {
	absPath := `C:\Users\HyperNewbie\.gemini\antigravity-cli\brain\8ab8f921-fca3-432a-a927-aad940cc4bc1\scratch\019e976c-8167-7e8f-80a4-6c823e9cab84.jsonl`
	_, err := os.Stat(absPath)
	if os.IsNotExist(err) {
		t.Skip("Scratch file not found, skipping real file test")
	}

	tempHome := t.TempDir()
	homeKey := "USERPROFILE"
	if os.Getenv(homeKey) == "" {
		homeKey = "HOME"
	}
	origHomeVal := os.Getenv(homeKey)
	if err := os.Setenv(homeKey, tempHome); err != nil {
		t.Fatalf("setenv failed: %v", err)
	}
	defer os.Setenv(homeKey, origHomeVal)

	projectDirName := "--home-hypernewbie-code-ae3--"
	mockSessionID := "019e976c-8167-7e8f-80a4-6c823e9cab84"

	piProjPath := filepath.Join(tempHome, ".pi", "agent", "sessions", projectDirName)
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	destPath := filepath.Join(piProjPath, "2026-06-05T10-55-31-175Z_"+mockSessionID+".jsonl")

	data, err := os.ReadFile(absPath)
	if err != nil {
		t.Fatalf("Failed to read scratch file: %v", err)
	}
	if err := os.WriteFile(destPath, data, 0644); err != nil {
		t.Fatalf("Failed to write to temp file: %v", err)
	}

	messages, err := GetPiSessionTranscript("/home/hypernewbie/code/ae3", mockSessionID)
	if err != nil {
		t.Fatalf("GetPiSessionTranscript failed: %v", err)
	}

	if len(messages) == 0 {
		t.Fatalf("Expected messages to be parsed, got 0")
	}
	t.Logf("Parsed %d messages from real file", len(messages))

	hasToolResult := false
	for _, m := range messages {
		if m.Role == "toolResult" {
			hasToolResult = true
			break
		}
	}
	if !hasToolResult {
		t.Errorf("Expected toolResult messages in parsed transcript, but none found")
	}
}
