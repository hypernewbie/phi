package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePiForkFixture creates a nested fork session file under the Pi
// sessions root (sessionsDir = <home>/.pi/agent/sessions/<projdir>) and
// returns its absolute path.
func writePiForkFixture(t *testing.T, sessionsDir, rel string, records ...string) string {
	t.Helper()
	path := filepath.Join(sessionsDir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir Pi fork session dir: %v", err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(records, "\n")+"\n"), 0644); err != nil {
		t.Fatalf("write Pi fork session fixture: %v", err)
	}
	return path
}

func forkRecords(cwd string) []string {
	return []string{
		piSessionHeader("fork-session-id", cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"fork hello"}]}}`,
	}
}

func TestGetPiForkSessionRPCTranscript_HappyPath(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	path := writePiForkFixture(t, sessionsDir,
		filepath.Join("20260822T000000_fork", "run-0", "session.jsonl"),
		forkRecords(cwd)...,
	)
	messages, err := GetPiForkSessionRPCTranscript(cwd, path)
	if err != nil {
		t.Fatalf("fork transcript: %v", err)
	}
	if len(messages) < 1 {
		t.Fatalf("expected at least one message, got %+v", messages)
	}
	if messages[0].Role != "user" {
		t.Fatalf("first message role = %q, want user", messages[0].Role)
	}
}

func TestGetPiForkSessionRPCTranscript_OutsideSessionsRoot(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	// A file under the test home but NOT under ~/.pi/agent/sessions.
	outside := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(sessionsDir))), "elsewhere", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(outside), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte(strings.Join(forkRecords(cwd), "\n")+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPiForkSessionRPCTranscript(cwd, outside); err == nil {
		t.Fatal("path outside the sessions root must be rejected")
	}
}

func TestGetPiForkSessionRPCTranscript_SymlinkRejected(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	path := writePiForkFixture(t, sessionsDir,
		filepath.Join("20260822T000001_fork", "run-0", "session.jsonl"),
		forkRecords(cwd)...,
	)
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := GetPiForkSessionRPCTranscript(cwd, link); err == nil {
		t.Fatal("symlinked session file must be rejected")
	}
}

func TestGetPiForkSessionRPCTranscript_RelativePathRejected(t *testing.T) {
	if _, err := GetPiForkSessionRPCTranscript("/w/d", "relative/session.jsonl"); err == nil {
		t.Fatal("relative session path must be rejected")
	}
}

func TestGetPiForkSessionRPCTranscript_HeaderCwdMismatch(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	path := writePiForkFixture(t, sessionsDir,
		filepath.Join("20260822T000002_fork", "run-0", "session.jsonl"),
		forkRecords("/some/other/cwd")...,
	)
	if _, err := GetPiForkSessionRPCTranscript(cwd, path); err == nil {
		t.Fatal("header cwd mismatch must be rejected")
	}
}
