package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/session"
)

// piProjectDirForTest mirrors piSessionDirectory's encoding without
// importing the unexported helper.
func piProjectDirForTest(t *testing.T, home, cwd string) string {
	t.Helper()
	normalized := filepath.ToSlash(cwd)
	normalized = strings.ReplaceAll(strings.Trim(normalized, "/"), ":", "-")
	return filepath.Join(home, ".pi", "agent", "sessions",
		"--"+strings.ReplaceAll(normalized, "/", "-")+"--")
}

func writePiSessionFixture(t *testing.T, dir, id, cwd string, mtime time.Time) {
	t.Helper()
	// Filenames run against mtime order so only sorting can satisfy the
	// expected page order.
	name := fmt.Sprintf("f-%s.jsonl", id)
	body := fmt.Sprintf("{\"type\":\"session\",\"version\":3,\"id\":%q,\"cwd\":%q}\n"+
		"{\"type\":\"session_info\",\"name\":\"Session %s\"}\n", id, cwd, id)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture %s: %v", name, err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
}

func TestHandleGetSessionsPagination(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")

	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	projectDir := piProjectDirForTest(t, home, cwd)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}

	const total = 503
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("s%03d", i)
		writePiSessionFixture(t, projectDir, id, cwd, base.Add(-time.Duration(i)*time.Minute))
	}

	before := coderManager
	coderManager = coders.NewManager()
	beforeCWD := activeCWD
	activeCWD = cwd
	t.Cleanup(func() {
		coderManager = before
		activeCWD = beforeCWD
	})

	query := func(extra map[string]string) string {
		values := url.Values{}
		if _, ok := extra["coder"]; !ok {
			values.Set("coder", "pi")
		}
		if _, ok := extra["cwd"]; !ok {
			values.Set("cwd", cwd)
		}
		for key, value := range extra {
			if value == "" {
				values.Set(key, "")
				continue
			}
			values.Set(key, value)
		}
		return values.Encode()
	}

	get := func(t *testing.T, extra map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/sessions?"+query(extra), nil)
		rec := httptest.NewRecorder()
		handleGetSessions(rec, req)
		return rec
	}

	expectIDs := func(t *testing.T, rec *httptest.ResponseRecorder, want ...string) {
		t.Helper()
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if !strings.HasPrefix(rec.Body.String(), "[") {
			t.Fatalf("response is not a bare array: %.40q", rec.Body.String())
		}
		var got []session.Session
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(got) != len(want) {
			t.Fatalf("got %d sessions, want %d", len(got), len(want))
		}
		for i := range want {
			if got[i].ID != want[i] {
				t.Fatalf("session %d: got %q, want %q", i, got[i].ID, want[i])
			}
		}
	}

	expectFull := func(t *testing.T, rec *httptest.ResponseRecorder) {
		t.Helper()
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var got []session.Session
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(got) != total {
			t.Fatalf("got %d sessions, want %d", len(got), total)
		}
		if got[0].ID != "s000" || got[total-1].ID != fmt.Sprintf("s%03d", total-1) {
			t.Fatalf("order: first=%q last=%q", got[0].ID, got[total-1].ID)
		}
	}

	expectFull(t, get(t, nil))
	expectFull(t, get(t, map[string]string{"offset": "10"}))
	expectFull(t, get(t, map[string]string{"limit": ""}))
	expectFull(t, get(t, map[string]string{"limit": "0", "offset": "10"}))
	expectFull(t, get(t, map[string]string{"limit": "-2", "offset": "10"}))

	expectIDs(t, get(t, map[string]string{"limit": "10", "offset": "0"}),
		"s000", "s001", "s002", "s003", "s004", "s005", "s006", "s007", "s008", "s009")
	expectIDs(t, get(t, map[string]string{"limit": "10", "offset": "10"}),
		"s010", "s011", "s012", "s013", "s014", "s015", "s016", "s017", "s018", "s019")
	expectIDs(t, get(t, map[string]string{"limit": "10", "offset": "500"}),
		"s500", "s501", "s502")
	expectIDs(t, get(t, map[string]string{"limit": "10", "offset": "503"}))

	for _, extra := range []map[string]string{
		{"limit": "wat"},
		{"limit": "10", "offset": "wat"},
	} {
		rec := get(t, extra)
		if rec.Code != 400 {
			t.Fatalf("%v: status %d", extra, rec.Code)
		}
		want := "Invalid limit\n"
		if extra["offset"] == "wat" {
			want = "Invalid offset\n"
		}
		if rec.Body.String() != want {
			t.Fatalf("%v: body %q, want %q", extra, rec.Body.String(), want)
		}
	}
}

func TestHandleGetSessionsPaginationEdges(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")

	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	projectDir := piProjectDirForTest(t, home, cwd)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}

	const total = 503
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("s%03d", i)
		writePiSessionFixture(t, projectDir, id, cwd, base.Add(-time.Duration(i)*time.Minute))
	}

	beforeCoders := coderManager
	coderManager = coders.NewManager()
	coderManager.Add(coders.Coder{ID: "missing-source-coder", SessionSource: "missing-test-source"})
	beforeCWD := activeCWD
	activeCWD = cwd
	t.Cleanup(func() {
		coderManager = beforeCoders
		activeCWD = beforeCWD
	})

	encodedCwd := url.QueryEscape(cwd)
	rawGet := func(t *testing.T, rawQuery string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/sessions?"+rawQuery, nil)
		rec := httptest.NewRecorder()
		handleGetSessions(rec, req)
		return rec
	}
	decode := func(t *testing.T, rec *httptest.ResponseRecorder) []session.Session {
		t.Helper()
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var got []session.Session
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return got
	}

	capped := decode(t, rawGet(t, "coder=pi&cwd="+encodedCwd+"&limit=999&offset=0"))
	if len(capped) != 500 {
		t.Fatalf("cap: got %d sessions, want 500", len(capped))
	}

	negative := decode(t, rawGet(t, "coder=pi&cwd="+encodedCwd+"&limit=10&offset=-3"))
	if len(negative) != 10 || negative[0].ID != "s000" {
		t.Fatalf("negative offset: %v", sessionIDsOf(negative))
	}

	emptyOffset := decode(t, rawGet(t, "coder=pi&cwd="+encodedCwd+"&limit=10&offset="))
	if len(emptyOffset) != 10 || emptyOffset[0].ID != "s000" {
		t.Fatalf("empty offset: %v", sessionIDsOf(emptyOffset))
	}

	fallback := decode(t, rawGet(t, "coder=pi&limit=10"))
	if len(fallback) != 10 || fallback[0].ID != "s000" {
		t.Fatalf("activeCWD fallback: %v", sessionIDsOf(fallback))
	}

	huge := strings.Repeat("9", 100)
	for raw, want := range map[string]string{
		"coder=pi&cwd=" + encodedCwd + "&limit=" + huge:           "Invalid limit\n",
		"coder=pi&cwd=" + encodedCwd + "&limit=10&offset=" + huge: "Invalid offset\n",
		"coder=nope&cwd=" + encodedCwd:                            "Invalid coder\n",
		"coder=missing-source-coder&cwd=" + encodedCwd:            "Unsupported session_source: missing-test-source\n",
	} {
		rec := rawGet(t, raw)
		if rec.Code != 400 {
			t.Fatalf("%q: status %d (%s)", raw, rec.Code, rec.Body.String())
		}
		if rec.Body.String() != want {
			t.Fatalf("%q: body %q, want %q", raw, rec.Body.String(), want)
		}
	}

	if rec := rawGet(t, "coder=pi&cwd=relative/worktree&limit=10"); rec.Code != 500 {
		t.Fatalf("relative cwd: status %d", rec.Code)
	}
}

func sessionIDsOf(sessions []session.Session) []string {
	out := make([]string, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s.ID)
	}
	return out
}
