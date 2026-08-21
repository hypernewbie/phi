package session

import (
	"context"
	"encoding/json"
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

	// 2. Test syncSessionCwdMappings robustness
	// This should run without errors even if cache or history files do not exist or are empty
	syncSessionCwdMappings(m)
}

func TestListGitWorktrees(t *testing.T) {
	cwd, err := os.Getwd()
	if err == nil {
		wts, err := ListGitWorktrees(context.Background(), cwd)
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
	wts, err := ListGitWorktrees(context.Background(), tempDir)
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

	origConfigDir := os.Getenv("CLAUDE_CONFIG_DIR")
	os.Setenv("CLAUDE_CONFIG_DIR", "") // force the ~/.claude fallback under the mock HOME
	defer os.Setenv("CLAUDE_CONFIG_DIR", origConfigDir)

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
	cwd, piProjPath := setupPiTestSessions(t)
	mockSessionID := "conv_abc123"
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	jsonlPath := filepath.Join(piProjPath, mockSessionID+".jsonl")
	mockContent := piSessionHeader(mockSessionID, cwd) + "\n" +
		`{"type":"session_info","name":"Custom Pi Title"}` + "\n" +
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello bot"}]}}` + "\n" +
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hello human"}]}}` + "\n" +
		`{"type":"msg","message":{"role":"user","content":[{"type":"text","text":"another user message"}]}}` + "\n" +
		`{"type":"msg","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool_xyz"}]}}` + "\n"

	if err := os.WriteFile(jsonlPath, []byte(mockContent), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	messages, err := GetPiSessionTranscript(cwd, mockSessionID)
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

func TestGetPiSessionTranscript_SpacedJSON(t *testing.T) {
	cwd, piProjPath := setupPiTestSessions(t)
	mockSessionID := "conv_spaced_123"
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	jsonlPath := filepath.Join(piProjPath, mockSessionID+".jsonl")
	mockContent := piSessionHeader(mockSessionID, cwd) + "\n" +
		`{"type": "session_info", "name": "Spaced Title"}` + "\n" +
		`{"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hello spaced"}]}}` + "\n" +
		`{"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi there"}]}}` + "\n"

	if err := os.WriteFile(jsonlPath, []byte(mockContent), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	messages, err := GetPiSessionTranscript(cwd, mockSessionID)
	if err != nil {
		t.Fatalf("GetPiSessionTranscript failed: %v", err)
	}

	if len(messages) != 2 {
		t.Fatalf("Expected 2 messages, got %d", len(messages))
	}
	if messages[0].Role != "user" || messages[0].Text != "hello spaced" {
		t.Errorf("Unexpected first spaced message: %+v", messages[0])
	}
	if messages[1].Role != "assistant" || messages[1].Text != "hi there" {
		t.Errorf("Unexpected second spaced message: %+v", messages[1])
	}
}

func TestGetPiSessionTranscript_WithTools(t *testing.T) {
	cwd, piProjPath := setupPiTestSessions(t)
	mockSessionID := "conv_tools_123"
	if err := os.MkdirAll(piProjPath, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	jsonlPath := filepath.Join(piProjPath, mockSessionID+".jsonl")
	mockContent := piSessionHeader(mockSessionID, cwd) + "\n" +
		`{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"let's run a tool"},{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls -la"}}]}}` + "\n" +
		`{"type":"message","message":{"role":"toolResult","toolName":"bash","toolCallId":"call_1","content":[{"type":"text","text":"file1.txt\nfile2.txt"}]}}` + "\n"

	if err := os.WriteFile(jsonlPath, []byte(mockContent), 0644); err != nil {
		t.Fatalf("write mock session file failed: %v", err)
	}

	messages, err := GetPiSessionTranscript(cwd, mockSessionID)
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

func TestResolvePiSessionPath_NonstandardFilename(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "header-id"
	path := writePiFixture(t, sessionsDir, "not-a-timestamp-name.jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"resumed"}]}}`,
	)

	sessions, err := ListPiSessions(cwd)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].SessionPath != path {
		t.Fatalf("nonstandard file was not discovered: %+v", sessions)
	}
	resolved, err := ResolvePiSessionPath(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ID != sessionID || resolved.SessionPath != path {
		t.Fatalf("unexpected resolved session: %+v", resolved)
	}
	messages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Text != "resumed" {
		t.Fatalf("unexpected transcript: %+v", messages)
	}
	if err := RevalidatePiSessionPath(cwd, path); err != nil {
		t.Fatal(err)
	}
}

func TestGetPiSessionTranscript_ActiveBranch(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "branched-session"
	path := writePiFixture(t, sessionsDir, "branched.jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"root"}]}}`,
		`{"type":"message","id":"assistant-root","parentId":"root","message":{"role":"assistant","content":[{"type":"text","text":"assistant root"}]}}`,
		`{"type":"message","id":"abandoned-user","parentId":"root","message":{"role":"user","content":[{"type":"text","text":"abandoned"}]}}`,
		`{"type":"message","id":"abandoned-answer","parentId":"abandoned-user","message":{"role":"assistant","content":[{"type":"text","text":"abandoned answer"}]}}`,
		`{"type":"message","id":"active-user","parentId":"assistant-root","message":{"role":"user","content":[{"type":"text","text":"active"}]}}`,
		`{"type":"message","id":"active-answer","parentId":"active-user","message":{"role":"assistant","content":[{"type":"text","text":"active answer"}]}}`,
	)

	messages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"root", "assistant root", "active", "active answer"}
	if len(messages) != len(want) {
		t.Fatalf("expected active branch %q, got %+v", want, messages)
	}
	for i, text := range want {
		if messages[i].Text != text {
			t.Errorf("message %d: want %q got %q", i, text, messages[i].Text)
		}
	}
}

func TestGetPiSessionTranscript_RejectsBrokenBranches(t *testing.T) {
	cases := []struct {
		name    string
		records []string
	}{
		{
			name: "duplicate ids",
			records: []string{
				`{"type":"message","id":"duplicate","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"one"}]}}`,
				`{"type":"message","id":"duplicate","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"two"}]}}`,
			},
		},
		{
			name: "missing parent",
			records: []string{
				`{"type":"message","id":"child","parentId":"missing","message":{"role":"user","content":[{"type":"text","text":"child"}]}}`,
			},
		},
		{
			name: "cycle",
			records: []string{
				`{"type":"message","id":"first","parentId":"second","message":{"role":"user","content":[{"type":"text","text":"first"}]}}`,
				`{"type":"message","id":"second","parentId":"first","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}`,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cwd, sessionsDir := setupPiTestSessions(t)
			path := writePiFixture(t, sessionsDir, tc.name+".jsonl", append([]string{piSessionHeader(tc.name, cwd)}, tc.records...)...)
			if _, err := GetPiSessionTranscriptForPath(cwd, path); err == nil {
				t.Fatal("broken active branch should fail")
			}
		})
	}
}

func TestGetPiSessionTranscript_LegacyNoIDs(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	path := writePiFixture(t, sessionsDir, "legacy.jsonl",
		piSessionHeader("legacy-session", cwd),
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"legacy user"}]}}`,
		`{"type":"msg","message":{"role":"assistant","content":[{"type":"text","text":"legacy assistant"}]}}`,
	)
	messages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Text != "legacy user" || messages[1].Text != "legacy assistant" {
		t.Fatalf("unexpected legacy transcript: %+v", messages)
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

func TestGetPiSessionRPCTranscriptForPath_WithTools(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "rpc-tools-session"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"read please"}]}}`,
		`{"type":"message","id":"call","parentId":"root","message":{"role":"assistant","content":[{"type":"thinking","thinking":"fetch it"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"file_path":"/work/example.ts","offset":1,"limit":5}}]}}`,
		`{"type":"message","id":"abandoned","parentId":"root","message":{"role":"assistant","content":[{"type":"toolCall","id":"orphan","name":"bash","arguments":{"command":"rm -rf"}}]}}`,
		`{"type":"message","id":"result","parentId":"call","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"line one"}],"isError":false,"details":{"diff":"+1 ok"}}}`,
	)

	rpcMessages, err := GetPiSessionRPCTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("GetPiSessionRPCTranscriptForPath failed: %v", err)
	}
	if len(rpcMessages) != 3 {
		t.Fatalf("expected 3 active-branch envelopes, got %d: %+v", len(rpcMessages), rpcMessages)
	}
	if rpcMessages[0].Role != "user" {
		t.Fatalf("first message role: want user got %q", rpcMessages[0].Role)
	}
	if string(rpcMessages[0].Content) != `[{"type":"text","text":"read please"}]` {
		t.Fatalf("first message content not preserved: %s", string(rpcMessages[0].Content))
	}

	assistant := rpcMessages[1]
	if assistant.Role != "assistant" {
		t.Fatalf("second message role: want assistant got %q", assistant.Role)
	}
	var segments []map[string]any
	if err := json.Unmarshal(assistant.Content, &segments); err != nil {
		t.Fatalf("assistant content not JSON array: %v (raw=%s)", err, string(assistant.Content))
	}
	var toolCall map[string]any
	for _, seg := range segments {
		if seg["type"] == "toolCall" {
			toolCall = seg
			break
		}
	}
	if toolCall == nil {
		t.Fatalf("assistant content missing toolCall segment: %+v", segments)
	}
	if toolCall["id"] != "call_1" || toolCall["name"] != "read" {
		t.Fatalf("assistant toolCall id/name lost: %+v", toolCall)
	}
	args, ok := toolCall["arguments"].(map[string]any)
	if !ok {
		t.Fatalf("assistant toolCall arguments not object: %+v", toolCall["arguments"])
	}
	if args["file_path"] != "/work/example.ts" || args["offset"].(float64) != 1 || args["limit"].(float64) != 5 {
		t.Fatalf("assistant toolCall arguments lost: %+v", args)
	}

	toolResult := rpcMessages[2]
	if toolResult.Role != "toolResult" {
		t.Fatalf("third message role: want toolResult got %q", toolResult.Role)
	}
	if toolResult.ToolCallID != "call_1" || toolResult.ToolName != "read" {
		t.Fatalf("toolResult pair fields lost: %+v", toolResult)
	}
	if toolResult.IsError == nil || *toolResult.IsError {
		t.Fatalf("toolResult isError=false not preserved: %+v", toolResult.IsError)
	}
	if string(toolResult.Content) != `[{"type":"text","text":"line one"}]` {
		t.Fatalf("toolResult content not preserved: %s", string(toolResult.Content))
	}
	var details map[string]any
	if err := json.Unmarshal(toolResult.Details, &details); err != nil {
		t.Fatalf("toolResult details not JSON object: %v (raw=%s)", err, string(toolResult.Details))
	}
	if details["diff"] != "+1 ok" {
		t.Fatalf("toolResult details.diff not preserved: %+v", details)
	}

	legacyMessages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("GetPiSessionTranscriptForPath failed: %v", err)
	}
	if len(legacyMessages) != 3 {
		t.Fatalf("expected 3 legacy messages, got %d: %+v", len(legacyMessages), legacyMessages)
	}
	combined := strings.Join([]string{
		legacyMessages[0].Text,
		legacyMessages[1].Text,
		legacyMessages[2].Text,
	}, "\n")
	if !strings.Contains(combined, "Used tool") {
		t.Errorf("legacy prose missing Used tool marker: %s", combined)
	}
	if !strings.Contains(combined, "Tool Output") {
		t.Errorf("legacy prose missing Tool Output marker: %s", combined)
	}
}

func TestGetPiSessionRPCTranscriptForPath_EmptyContent(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "rpc-empty-content"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
		`{"type":"message","id":"empty","parentId":"root","message":{"role":"assistant","content":[]}}`,
	)

	rpcMessages, err := GetPiSessionRPCTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("GetPiSessionRPCTranscriptForPath failed: %v", err)
	}
	if len(rpcMessages) != 2 {
		t.Fatalf("expected 2 RPC envelopes, got %d: %+v", len(rpcMessages), rpcMessages)
	}
	if rpcMessages[1].Role != "assistant" {
		t.Fatalf("second envelope role: want assistant got %q", rpcMessages[1].Role)
	}
	if string(rpcMessages[1].Content) != "[]" {
		t.Fatalf("empty content not preserved as []: %s", string(rpcMessages[1].Content))
	}

	legacyMessages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("GetPiSessionTranscriptForPath failed: %v", err)
	}
	if len(legacyMessages) != 1 {
		t.Fatalf("expected legacy path to drop empty assistant message, got %d: %+v", len(legacyMessages), legacyMessages)
	}
	if legacyMessages[0].Role != "user" {
		t.Fatalf("legacy retained message is not the user one: %+v", legacyMessages[0])
	}
}

// Regression: the active-branch reader used to return
// `decode Pi message entry <id>: ...` when a selected active-branch payload
// was valid JSON but incompatible with PiMessageInner. The raw-payload
// refactor must surface that same contextual error for both the legacy
// HTTP transcript and the RPC resume path so consumers can locate the
// offending entry by id.
func TestGetPiSessionTranscriptForPath_StripsActiveBranchOnBadPayload(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "bad-active-legacy"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
		// Selected: `content` is a string, not an array — valid JSON but
		// incompatible with PiMessageInner's []PiMessageContent field.
		`{"type":"message","id":"bad","parentId":"root","message":{"role":"assistant","content":"not-an-array"}}`,
	)

	_, err := GetPiSessionTranscriptForPath(cwd, path)
	if err == nil {
		t.Fatal("expected legacy resume to fail on incompatible active-branch payload")
	}
	if !strings.Contains(err.Error(), "decode Pi message entry bad:") {
		t.Fatalf("legacy error lacks contextual entry id: %v", err)
	}
}

func TestGetPiSessionRPCTranscriptForPath_StripsActiveBranchOnBadPayload(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "bad-active-rpc"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
		// Selected: `role` is not a string, so the outer envelope cannot
		// unmarshal into either PiMessageInner or PiRPCMessage. A payload
		// whose `content` shape alone is incompatible (e.g. singleton or
		// string) is now intentionally tolerated by RPC and covered by
		// TestGetPiSessionRPCTranscriptForPath_PreservesSingletonToolResult.
		`{"type":"message","id":"bad","parentId":"root","message":{"role":42,"content":[]}}`,
	)

	_, err := GetPiSessionRPCTranscriptForPath(cwd, path)
	if err == nil {
		t.Fatal("expected RPC resume to fail on malformed outer envelope")
	}
	if !strings.Contains(err.Error(), "decode Pi message entry bad:") {
		t.Fatalf("RPC error lacks contextual entry id: %v", err)
	}

	_, err = GetPiSessionTranscriptForPath(cwd, path)
	if err == nil {
		t.Fatal("expected legacy resume to fail on the same malformed outer envelope")
	}
	if !strings.Contains(err.Error(), "decode Pi message entry bad:") {
		t.Fatalf("legacy error lacks contextual entry id: %v", err)
	}
}

// Regression: a resumed RPC toolResult whose `content` is a single text
// object (rather than an array) must flow through the RPC resume path
// verbatim. PiMessageInner still rejects it, so the legacy path keeps
// returning the established `decode Pi message entry <id>: ...` error.
func TestGetPiSessionRPCTranscriptForPath_PreservesSingletonToolResult(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "rpc-singleton-toolresult"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
		// Selected: `content` is a singleton object, not an array. Valid
		// JSON for PiRPCMessage but incompatible with PiMessageInner's
		// []PiMessageContent shape.
		`{"type":"message","id":"result","parentId":"root","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":{"type":"text","text":"singleton output"}}}`,
	)

	_, err := GetPiSessionTranscriptForPath(cwd, path)
	if err == nil {
		t.Fatal("expected legacy resume to fail on singleton toolResult content")
	}
	if !strings.Contains(err.Error(), "decode Pi message entry result:") {
		t.Fatalf("legacy error lacks contextual entry id: %v", err)
	}

	rpcMessages, err := GetPiSessionRPCTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("GetPiSessionRPCTranscriptForPath failed: %v", err)
	}
	if len(rpcMessages) != 2 {
		t.Fatalf("expected 2 RPC envelopes, got %d: %+v", len(rpcMessages), rpcMessages)
	}
	if rpcMessages[0].Role != "user" {
		t.Fatalf("first envelope role: want user got %q", rpcMessages[0].Role)
	}

	toolResult := rpcMessages[1]
	if toolResult.Role != "toolResult" {
		t.Fatalf("second envelope role: want toolResult got %q", toolResult.Role)
	}
	if toolResult.ToolCallID != "call_1" || toolResult.ToolName != "bash" {
		t.Fatalf("toolResult pair fields lost: %+v", toolResult)
	}
	if string(toolResult.Content) != `{"type":"text","text":"singleton output"}` {
		t.Fatalf("singleton content not preserved exactly: %s", string(toolResult.Content))
	}
}

// Regression: legacy no-ID transcripts must stay tolerant of malformed
// and incompatible lines so a single bad row never breaks the whole view.
func TestGetPiSessionTranscript_KeepsLegacyNoIDTolerance(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	sessionID := "legacy-mixed"
	path := writePiFixture(t, sessionsDir, sessionID+".jsonl",
		piSessionHeader(sessionID, cwd),
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`,
		`not json at all`,
		`{"type":"message","message":{"role":"assistant","content":"not-an-array"}}`,
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"goodbye"}]}}`,
	)

	messages, err := GetPiSessionTranscriptForPath(cwd, path)
	if err != nil {
		t.Fatalf("legacy tolerance broken: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected 2 tolerable legacy messages, got %d: %+v", len(messages), messages)
	}
	if messages[0].Text != "hello" || messages[1].Text != "goodbye" {
		t.Fatalf("legacy tolerance skipped the wrong rows: %+v", messages)
	}
}
