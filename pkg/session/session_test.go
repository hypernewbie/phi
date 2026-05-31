package session

import (
	"os"
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
