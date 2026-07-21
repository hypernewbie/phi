package session

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func writeClaudeTranscript(t *testing.T, home, encodedDir, sessionID string, lines ...string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "projects", encodedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionID+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeClaudeRegistry(t *testing.T, home, fileName, jsonBody string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(jsonBody), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Test 0 — pure function, zero I/O, the anchor CI test. Asserts the encoder's
// exact output. This is the cheapest, most deterministic proof that the Bug
// #1 mapping is correct.
func TestEncodeClaudeProjectDir(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/Users/n0mad/code/phi", "-Users-n0mad-code-phi"},
		{"/Users/n0mad/code/dot_files", "-Users-n0mad-code-dot-files"}, // underscore -> '-'
		{"/home/me/my-project", "-home-me-my-project"},                 // literal dash -> '-'
		{"/home/me/.config", "-home-me--config"},                       // dot -> '-' (double dash)
		{"C:/mockpath", "C--mockpath"},                                 // colon + slash -> '-'
		{"/home/me/proj/", "-home-me-proj"},                            // trailing slash cleaned
		{"/a//b/../b", "-a-b"},                                         // Clean collapses . / ..
	}
	for _, c := range cases {
		if got := encodeClaudeProjectDir(c.in); got != c.want {
			t.Errorf("encodeClaudeProjectDir(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Test A — Bug #1: underscore/dash/dot paths are detected (regression).
func TestClaudeSessionDetection_DangerousPaths(t *testing.T) {
	home := setupMockHome(t)

	table := []struct {
		cwd string
		dir string
	}{
		{"/home/me/dot_files", "-home-me-dot-files"},
		{"/home/me/my-project", "-home-me-my-project"},
		{"/home/me/.config", "-home-me--config"},
	}

	for i, row := range table {
		if got := encodeClaudeProjectDir(row.cwd); got != row.dir {
			t.Fatalf("row %d: encodeClaudeProjectDir(%q) = %q, want %q", i, row.cwd, got, row.dir)
		}
		sessionID := fmt.Sprintf("sess-%d", i)
		writeClaudeTranscript(t, home, row.dir, sessionID,
			`{"type":"mode","sessionId":"`+sessionID+`"}`,
			`{"cwd":"`+row.cwd+`","sessionId":"`+sessionID+`"}`,
		)

		sessions, err := ListClaudeSessions(row.cwd)
		if err != nil {
			t.Fatalf("row %d: ListClaudeSessions failed: %v", i, err)
		}
		if len(sessions) != 1 {
			t.Fatalf("row %d: expected 1 session for cwd %q, got %d", i, row.cwd, len(sessions))
		}
		if sessions[0].ID != sessionID {
			t.Errorf("row %d: expected session id %q, got %q", i, sessionID, sessions[0].ID)
		}
		if sessions[0].Cwd != row.cwd {
			t.Errorf("row %d: expected Cwd %q, got %q", i, row.cwd, sessions[0].Cwd)
		}
	}
}

// Test C — Bug #3: aiTitle beats a derived name; a user-set name beats aiTitle.
func TestClaudeSessionDetection_TitlePriority(t *testing.T) {
	home := setupMockHome(t)
	cwd := "/home/me/proj"
	dir := encodeClaudeProjectDir(cwd)

	// S1: aiTitle + derived registry name -> aiTitle wins
	writeClaudeTranscript(t, home, dir, "s1",
		`{"type":"mode","sessionId":"s1"}`,
		`{"cwd":"`+cwd+`","sessionId":"s1"}`,
		`{"type":"ai-title","aiTitle":"Nice Title","sessionId":"s1"}`,
	)
	writeClaudeRegistry(t, home, "s1.json", `{"sessionId":"s1","name":"proj-a4","nameSource":"derived"}`)

	// S2: aiTitle + user-set (non-derived) registry name -> user name wins
	writeClaudeTranscript(t, home, dir, "s2",
		`{"type":"mode","sessionId":"s2"}`,
		`{"cwd":"`+cwd+`","sessionId":"s2"}`,
		`{"type":"ai-title","aiTitle":"Ignore Me","sessionId":"s2"}`,
	)
	writeClaudeRegistry(t, home, "s2.json", `{"sessionId":"s2","name":"user-set","nameSource":"manual"}`)

	got, err := ListClaudeSessions(cwd)
	if err != nil {
		t.Fatalf("ListClaudeSessions failed: %v", err)
	}
	byID := make(map[string]Session)
	for _, s := range got {
		byID[s.ID] = s
	}
	if s, ok := byID["s1"]; !ok || s.Title != "Nice Title" {
		t.Errorf("expected s1 title %q, got %q (found=%v)", "Nice Title", s.Title, ok)
	}
	if s, ok := byID["s2"]; !ok || s.Title != "user-set" {
		t.Errorf("expected s2 title %q, got %q (found=%v)", "user-set", s.Title, ok)
	}
}

// Test D — freebie: CLAUDE_CONFIG_DIR honored.
func TestClaudeSessionDetection_ConfigDirEnv(t *testing.T) {
	setupMockHome(t) // sets CLAUDE_CONFIG_DIR="" (fallback under HOME)
	alt := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", alt) // override to a dir NOT under HOME

	cwd := "/home/me/proj"
	dir := encodeClaudeProjectDir(cwd)

	// write transcript under alt/projects/<dir>/ (NOT under HOME/.claude)
	if err := os.MkdirAll(filepath.Join(alt, "projects", dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(alt, "projects", dir, "cfg.jsonl"), []byte(`{"cwd":"`+cwd+`","sessionId":"cfg"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ListClaudeSessions(cwd)
	if err != nil {
		t.Fatalf("ListClaudeSessions failed: %v", err)
	}
	found := false
	for _, s := range got {
		if s.ID == "cfg" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected session %q to be found via CLAUDE_CONFIG_DIR, got %+v", "cfg", got)
	}
}

// Independent oracle (mirror of Claude's documented rule; build dirs with THIS
// so the test checks production encodeClaudeProjectDir against it, not
// against itself).
var refNonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

func refEncode(p string) string { return refNonAlnum.ReplaceAllString(filepath.Clean(p), "-") }

func randDangerousPath(rng *rand.Rand) string {
	const alpha = "abcXYZ019"
	const seps = "/._-"
	n := 2 + rng.Intn(4)
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteByte('/')
		for j := 0; j < 1+rng.Intn(6); j++ {
			if rng.Intn(3) == 0 {
				b.WriteByte(seps[rng.Intn(len(seps))])
			} else {
				b.WriteByte(alpha[rng.Intn(len(alpha))])
			}
		}
	}
	p := b.String()
	if c := filepath.Clean(p); c == "/" || c == "." {
		return "/home/me/proj"
	}
	return p
}

// P1 — property test. ~300 random absolute paths over abcXYZ019 + the
// dangerous separators / . _ - (the class the old decoder mangled). For each:
// create the dir with refEncode(cwd), write a transcript with a matching cwd
// line, assert ListClaudeSessions(cwd) returns a session with that id. One
// failure => production encode disagrees with the oracle => Bug #1 regression.
func TestClaudeEncodeRoundTripDiscovery(t *testing.T) {
	home := setupMockHome(t)
	rng := rand.New(rand.NewSource(42))

	for i := 0; i < 300; i++ {
		cwd := randDangerousPath(rng)
		dir := refEncode(cwd)
		id := fmt.Sprintf("sess-%d", i)
		writeClaudeTranscript(t, home, dir, id,
			`{"type":"mode","sessionId":"`+id+`"}`,
			`{"cwd":"`+cwd+`","sessionId":"`+id+`"}`,
		)

		sessions, err := ListClaudeSessions(cwd)
		if err != nil {
			t.Fatalf("iteration %d: ListClaudeSessions(%q) failed: %v", i, cwd, err)
		}
		found := false
		for _, s := range sessions {
			if s.ID == id {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("iteration %d: cwd %q (dir %q) did not surface session %q; got %+v", i, cwd, dir, id, sessions)
		}
	}
}

// P3 — charset invariant, never panics.
func FuzzEncodeClaudeProjectDir(f *testing.F) {
	for _, s := range []string{"/Users/n0mad/code/dot_files", "/home/me/.config", "C:/mockpath", "", "/", "教育/路径"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, p string) {
		for _, r := range encodeClaudeProjectDir(p) {
			ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-'
			if !ok {
				t.Fatalf("encode(%q) leaked %q", p, r)
			}
		}
	})
}

// P4 — robustness. Fuzz (cwd, dirName, id); set HOME/USERPROFILE to
// t.TempDir() and CLAUDE_CONFIG_DIR="" (constants — never fuzzed env-var
// values); only create files when dirName/id are separator-free and not
// "."/"..", then call ListClaudeSessions(cwd) and require no panic. No output
// assertions.
func FuzzListClaudeSessionsNoPanic(f *testing.F) {
	f.Add("/home/me/proj", "-home-me-proj", "sess-1")
	f.Add("", "", "")
	f.Add("C:/mockpath", "C--mockpath", "conv_abc123")
	f.Add("/home/me/dot_files", "-home-me-dot-files", "sess-2")

	f.Fuzz(func(t *testing.T, cwd, dirName, id string) {
		home := t.TempDir()
		origHome := os.Getenv("HOME")
		origUserProfile := os.Getenv("USERPROFILE")
		origConfigDir := os.Getenv("CLAUDE_CONFIG_DIR")
		os.Setenv("HOME", home)
		os.Setenv("USERPROFILE", home)
		os.Setenv("CLAUDE_CONFIG_DIR", "")
		defer func() {
			os.Setenv("HOME", origHome)
			os.Setenv("USERPROFILE", origUserProfile)
			os.Setenv("CLAUDE_CONFIG_DIR", origConfigDir)
		}()

		validComponent := func(s string) bool {
			if s == "" || s == "." || s == ".." {
				return false
			}
			return !strings.ContainsAny(s, "/\\")
		}

		if validComponent(dirName) && validComponent(id) {
			dir := filepath.Join(home, ".claude", "projects", dirName)
			if err := os.MkdirAll(dir, 0o755); err == nil {
				_ = os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(`{"cwd":"`+cwd+`","sessionId":"`+id+`"}`+"\n"), 0o644)
			}
		}

		_, _ = ListClaudeSessions(cwd)
	})
}
