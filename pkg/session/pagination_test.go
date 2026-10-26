package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/coders"
)

var pageTestBase = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

// pageMtime makes index 0 the newest session.
func pageMtime(i int) time.Time {
	return pageTestBase.Add(-time.Duration(i) * time.Minute)
}

func setMtime(t *testing.T, path string, mtime time.Time) {
	t.Helper()
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func sessionIDs(sessions []Session) []string {
	out := make([]string, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s.ID)
	}
	return out
}

func requireIDs(t *testing.T, label string, sessions []Session, want ...string) {
	t.Helper()
	got := sessionIDs(sessions)
	if len(got) != len(want) {
		t.Fatalf("%s: got %v, want %v", label, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: got %v, want %v", label, got, want)
		}
	}
}

func TestSliceSessions(t *testing.T) {
	sessions := []Session{{ID: "a"}, {ID: "b"}, {ID: "c"}}

	cases := []struct {
		name   string
		offset int
		limit  int
		want   []string
	}{
		{"first page", 0, 2, []string{"a", "b"}},
		{"second page", 2, 2, []string{"c"}},
		{"offset at end", 3, 2, nil},
		{"offset past end", 99, 2, nil},
		{"negative offset", -1, 2, []string{"a", "b"}},
		{"zero limit ignores offset", 2, 0, []string{"a", "b", "c"}},
		{"negative limit ignores offset", 2, -1, []string{"a", "b", "c"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sliceSessions(sessions, tc.offset, tc.limit)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", sessionIDs(got), tc.want)
			}
			for i := range tc.want {
				if got[i].ID != tc.want[i] {
					t.Fatalf("got %v, want %v", sessionIDs(got), tc.want)
				}
			}
		})
	}

	if got := sliceSessions(nil, 0, 5); len(got) != 0 {
		t.Fatalf("nil input: %v", got)
	}
	if got := sliceSessions(nil, 3, 5); len(got) != 0 {
		t.Fatalf("nil input past end: %v", got)
	}
	intMax := int(^uint(0) >> 1)
	if got := sliceSessions(sessions, intMax, intMax); len(got) != 0 {
		t.Fatalf("overflow guard: %v", got)
	}
}

func TestSortSessions(t *testing.T) {
	now := pageTestBase
	sessions := []Session{
		{ID: "old", TimeUpdated: now.Add(-2 * time.Hour)},
		{ID: "new", TimeUpdated: now},
		{ID: "mid", TimeUpdated: now.Add(-time.Hour)},
		{ID: "tie-a", TimeUpdated: now.Add(-time.Hour)},
	}
	SortSessions(sessions)
	requireIDs(t, "sorted", sessions, "new", "mid", "tie-a", "old")

	SortSessions(nil)
	SortSessions([]Session{})
}

func writePiPageFixtures(t *testing.T, sessionsDir, cwd string, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		// Filenames run against mtime order so only real sorting passes.
		name := fmt.Sprintf("s-%02d.jsonl", count-1-i)
		id := fmt.Sprintf("page-%02d", i)
		path := writePiFixture(t, sessionsDir, name,
			piSessionHeader(id, cwd),
			fmt.Sprintf(`{"type":"session_info","name":"Page session %02d"}`, i),
		)
		setMtime(t, path, pageMtime(i))
	}
}

func TestListPiSessionsPage(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	writePiPageFixtures(t, sessionsDir, cwd, 23)

	first, err := listPiSessionsPage(cwd, 0, 10)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	requireIDs(t, "first page", first,
		"page-00", "page-01", "page-02", "page-03", "page-04",
		"page-05", "page-06", "page-07", "page-08", "page-09")
	if first[0].Title != "Page session 00" {
		t.Fatalf("title: %q", first[0].Title)
	}
	if first[0].Cwd != cwd || first[0].Coder != "pi" {
		t.Fatalf("metadata: %+v", first[0])
	}
	if !filepath.IsAbs(first[0].SessionPath) {
		t.Fatalf("session path not absolute: %q", first[0].SessionPath)
	}
	if !first[0].TimeUpdated.Equal(pageMtime(0)) {
		t.Fatalf("mtime: %v", first[0].TimeUpdated)
	}

	second, err := listPiSessionsPage(cwd, 10, 10)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	requireIDs(t, "second page", second,
		"page-10", "page-11", "page-12", "page-13", "page-14",
		"page-15", "page-16", "page-17", "page-18", "page-19")

	third, err := listPiSessionsPage(cwd, 20, 10)
	if err != nil {
		t.Fatalf("third page: %v", err)
	}
	requireIDs(t, "third page", third, "page-20", "page-21", "page-22")

	for _, offset := range []int{23, 99} {
		past, err := listPiSessionsPage(cwd, offset, 10)
		if err != nil {
			t.Fatalf("offset %d: %v", offset, err)
		}
		if len(past) != 0 {
			t.Fatalf("offset %d: %v", offset, sessionIDs(past))
		}
	}

	negative, err := listPiSessionsPage(cwd, -5, 10)
	if err != nil {
		t.Fatalf("negative offset: %v", err)
	}
	requireIDs(t, "negative offset", negative,
		"page-00", "page-01", "page-02", "page-03", "page-04",
		"page-05", "page-06", "page-07", "page-08", "page-09")

	for _, limit := range []int{0, -1} {
		all, err := listPiSessionsPage(cwd, 10, limit)
		if err != nil {
			t.Fatalf("limit %d: %v", limit, err)
		}
		if len(all) != 23 {
			t.Fatalf("limit %d: got %d sessions", limit, len(all))
		}
	}

	// Full-list wrapper keeps complete membership.
	wire, err := ListPiSessions(cwd)
	if err != nil {
		t.Fatalf("full list: %v", err)
	}
	if len(wire) != 23 {
		t.Fatalf("full list: got %d sessions", len(wire))
	}
}

func TestListPiSessionsPageTitleFallback(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)

	native := writePiFixture(t, sessionsDir, "native.jsonl",
		piSessionHeader("native-title", cwd),
		`{"type":"session_info","name":"Native title"}`,
	)
	setMtime(t, native, pageMtime(0))

	headerOnly := writePiFixture(t, sessionsDir, "header-only.jsonl",
		piSessionHeader("header-only-session", cwd),
	)
	setMtime(t, headerOnly, pageMtime(1))

	items, err := listPiSessionsPage(cwd, 0, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("got %d sessions", len(items))
	}
	if items[0].Title != "Native title" {
		t.Fatalf("native title: %q", items[0].Title)
	}
	wantFallback := "Pi session header-o " + pageMtime(1).Format("02 Jan 2006")
	if items[1].Title != wantFallback {
		t.Fatalf("fallback title: got %q, want %q", items[1].Title, wantFallback)
	}
}

func TestListPiSessionsPageEmptyAndInvalidCwd(t *testing.T) {
	cwd, _ := setupPiTestSessions(t)

	items, err := listPiSessionsPage(cwd, 0, 10)
	if err != nil {
		t.Fatalf("missing project dir: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("missing project dir returned %v", sessionIDs(items))
	}

	if _, err := listPiSessionsPage("relative/worktree", 0, 10); err == nil {
		t.Fatal("relative cwd must fail")
	}
}

func TestListPiSessionsPageCountsOnlyValidSessions(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("valid-%02d", i)
		path := writePiFixture(t, sessionsDir, id+".jsonl",
			piSessionHeader(id, cwd),
			fmt.Sprintf(`{"type":"session_info","name":"Valid %02d"}`, i),
		)
		setMtime(t, path, pageTestBase.Add(-time.Duration(10+i)*time.Minute))
	}

	empty := writePiFixture(t, sessionsDir, "newer-empty.jsonl")
	setMtime(t, empty, pageMtime(0))

	wrongCwd := writePiFixture(t, sessionsDir, "newer-wrong-cwd.jsonl",
		piSessionHeader("wrong-cwd", "/some/other/worktree"))
	setMtime(t, wrongCwd, pageMtime(1))

	garbage := writePiFixture(t, sessionsDir, "newer-garbage.jsonl", "not-json")
	setMtime(t, garbage, pageMtime(2))

	if err := os.MkdirAll(filepath.Join(sessionsDir, "newer-dir.jsonl"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionsDir, "ignored.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(sessionsDir, "valid-00.jsonl"), filepath.Join(sessionsDir, "newer-link.jsonl")); err != nil {
		t.Logf("symlink unavailable on this platform: %v", err)
	}

	page, err := listPiSessionsPage(cwd, 1, 2)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	requireIDs(t, "valid-only offset", page, "valid-01", "valid-02")

	first, err := listPiSessionsPage(cwd, 0, 1)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	requireIDs(t, "valid-only first", first, "valid-00")
}

func writeClaudePages(t *testing.T, home, cwd, encodedDir string, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		// Filenames run against mtime order so only real sorting passes.
		id := fmt.Sprintf("claude-%02d", count-1-i)
		lines := []string{
			fmt.Sprintf(`{"type":"mode","sessionId":%q}`, id),
		}
		if i != count-1 {
			lines = append(lines, fmt.Sprintf(`{"type":"ai-title","aiTitle":"Claude title %02d","cwd":%q}`, i, cwd))
		}
		writeClaudeTranscript(t, home, encodedDir, id, lines...)
		path := filepath.Join(home, ".claude", "projects", encodedDir, id+".jsonl")
		setMtime(t, path, pageMtime(i))
	}
}

func TestListClaudeSessionsPage(t *testing.T) {
	home := setupMockHome(t)
	cwd := filepath.Join(t.TempDir(), "claude-pages")
	encoded := encodeClaudeProjectDir(cwd)

	writeClaudePages(t, home, cwd, encoded, 23)
	writeClaudeRegistry(t, home, "registry.json",
		`{"pid":1,"sessionId":"claude-05","name":"Registry name five","nameSource":"user"}`)
	if err := os.MkdirAll(filepath.Join(home, ".phi"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".phi", "sessions.json"),
		[]byte(`{"claude-09":{"name":"Renamed nine"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	first, err := listClaudeSessionsPage(cwd, "", 0, 10)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	requireIDs(t, "first page", first,
		"claude-22", "claude-21", "claude-20", "claude-19", "claude-18",
		"claude-17", "claude-16", "claude-15", "claude-14", "claude-13")
	if first[0].Cwd != cwd || first[0].Coder != "claude" {
		t.Fatalf("metadata: %+v", first[0])
	}
	if first[0].Title != "Claude title 00" {
		t.Fatalf("aiTitle: %q", first[0].Title)
	}
	if !first[0].TimeUpdated.Equal(pageMtime(0)) {
		t.Fatalf("mtime: %v", first[0].TimeUpdated)
	}

	second, err := listClaudeSessionsPage(cwd, "", 10, 10)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	requireIDs(t, "second page", second,
		"claude-12", "claude-11", "claude-10", "claude-09", "claude-08",
		"claude-07", "claude-06", "claude-05", "claude-04", "claude-03")

	// Title priority on selected pages: rename > registry > aiTitle.
	if second[3].Title != "Renamed nine" {
		t.Fatalf("custom rename: %q", second[3].Title)
	}
	if second[7].Title != "Registry name five" {
		t.Fatalf("registry name: %q", second[7].Title)
	}

	third, err := listClaudeSessionsPage(cwd, "", 20, 10)
	if err != nil {
		t.Fatalf("third page: %v", err)
	}
	requireIDs(t, "third page", third, "claude-02", "claude-01", "claude-00")
	wantFallback := "Claude session claude-0 " + pageMtime(22).Format("02 Jan 2006")
	if third[2].Title != wantFallback {
		t.Fatalf("fallback title: got %q, want %q", third[2].Title, wantFallback)
	}

	past, err := listClaudeSessionsPage(cwd, "", 23, 10)
	if err != nil {
		t.Fatalf("offset past end: %v", err)
	}
	if len(past) != 0 {
		t.Fatalf("offset past end: %v", sessionIDs(past))
	}

	negative, err := listClaudeSessionsPage(cwd, "", -4, 10)
	if err != nil {
		t.Fatalf("negative offset: %v", err)
	}
	requireIDs(t, "negative offset", negative,
		"claude-22", "claude-21", "claude-20", "claude-19", "claude-18",
		"claude-17", "claude-16", "claude-15", "claude-14", "claude-13")

	all, err := listClaudeSessionsPage(cwd, "", 10, 0)
	if err != nil {
		t.Fatalf("limit 0: %v", err)
	}
	if len(all) != 23 {
		t.Fatalf("limit 0: got %d sessions", len(all))
	}

	full, err := listClaudeSessions(cwd, "")
	if err != nil {
		t.Fatalf("full list: %v", err)
	}
	if len(full) != 23 {
		t.Fatalf("full list: got %d sessions", len(full))
	}
}

func TestListClaudeSessionsPageMissingProjects(t *testing.T) {
	_ = setupMockHome(t)

	items, err := listClaudeSessionsPage("/work/missing", "", 0, 10)
	if err != nil {
		t.Fatalf("missing projects dir: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("missing projects dir returned %v", sessionIDs(items))
	}
}

func TestListSessionsPageRouting(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	writePiPageFixtures(t, sessionsDir, cwd, 5)
	home := os.Getenv("HOME")
	encoded := encodeClaudeProjectDir(cwd)
	writeClaudePages(t, home, cwd, encoded, 5)

	manager := coders.NewManager()
	ctx := context.Background()

	piCoder := manager.MustGet("pi")
	piPage, err := ListSessionsPage(ctx, piCoder, cwd, 0, 2)
	if err != nil {
		t.Fatalf("pi page: %v", err)
	}
	requireIDs(t, "pi page", piPage, "page-00", "page-01")
	piAll, err := ListSessions(ctx, piCoder, cwd)
	if err != nil || len(piAll) != 5 {
		t.Fatalf("pi full list: %d %v", len(piAll), err)
	}

	claudeCoder := manager.MustGet("claude")
	claudePage, err := ListSessionsPage(ctx, claudeCoder, cwd, 1, 2)
	if err != nil {
		t.Fatalf("claude page: %v", err)
	}
	if len(claudePage) != 2 {
		t.Fatalf("claude page: %v", sessionIDs(claudePage))
	}

	// Non-paged adapter falls back to a sorted slice.
	root := t.TempDir()
	path := filepath.Join(root, "state_5.sqlite")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, source TEXT, archived INTEGER);
	INSERT INTO threads VALUES ('newest','Newest','/project',1790000003,'cli',0),
	('middle','Middle','/project',1790000002,'cli',0),
	('oldest','Oldest','/project',1790000001,'cli',0);`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()

	codexCoder := manager.MustGet("codex")
	codexCoder.Env = map[string]string{"CODEX_HOME": t.TempDir(), "CODEX_SQLITE_HOME": root}

	codexPage, err := ListSessionsPage(ctx, codexCoder, "/project", 1, 1)
	if err != nil {
		t.Fatalf("codex page: %v", err)
	}
	requireIDs(t, "codex page", codexPage, "middle")
	codexAll, err := ListSessionsPage(ctx, codexCoder, "/project", 1, 0)
	if err != nil || len(codexAll) != 3 {
		t.Fatalf("codex full list: %d %v", len(codexAll), err)
	}

	unknown := coders.Coder{SessionSource: "missing-test-source"}
	if _, err := ListSessionsPage(ctx, unknown, "/project", 0, 10); !errors.Is(err, ErrAdapterUnknown) {
		t.Fatalf("unknown source: %v", err)
	}

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := ListSessionsPage(canceled, codexCoder, "/project", 0, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation through fallback: %v", err)
	}
}

func TestListPiSessionsPageTitleReadWindow(t *testing.T) {
	cwd, sessionsDir := setupPiTestSessions(t)
	for i := 0; i < 23; i++ {
		name := fmt.Sprintf("s-%02d.jsonl", 22-i)
		path := writePiFixture(t, sessionsDir, name,
			piSessionHeader(fmt.Sprintf("page-%02d", i), cwd),
			"not-json",
			fmt.Sprintf(`{"type":"session_info","name":"Page session %02d"}`, i),
		)
		setMtime(t, path, pageMtime(i))
	}

	origWriter := log.Writer()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(origWriter) })

	readFiles := func(offset, limit int) []string {
		t.Helper()
		buf.Reset()
		items, err := listPiSessionsPage(cwd, offset, limit)
		if err != nil {
			t.Fatalf("offset %d: %v", offset, err)
		}
		lines := strings.Split(buf.String(), "\n")
		var files []string
		for _, line := range lines {
			if !strings.Contains(line, "Pi title extraction warning in") {
				continue
			}
			start := strings.Index(line, "warning in ")
			rest := line[start+len("warning in "):]
			// Cut at the fixture suffix instead of a colon: Windows paths
			// (C:\...) contain one, so splitting on ':' breaks there.
			end := strings.Index(rest, ".jsonl")
			if end < 0 {
				continue
			}
			name := filepath.Base(rest[:end+len(".jsonl")])
			files = append(files, name)
		}
		if len(files) != len(items) {
			t.Fatalf("offset %d: %d warnings for %d sessions (%v)", offset, len(files), len(items), files)
		}
		return files
	}

	first := readFiles(0, 10)
	if len(first) != 10 {
		t.Fatalf("first page titles: %v", first)
	}
	for _, name := range first {
		if name == "s-12.jsonl" || name == "s-02.jsonl" {
			t.Fatalf("first page parsed outside its window: %v", first)
		}
	}
	if first[0] != "s-22.jsonl" || first[9] != "s-13.jsonl" {
		t.Fatalf("first page files: %v", first)
	}

	second := readFiles(10, 10)
	if len(second) != 10 || second[0] != "s-12.jsonl" || second[9] != "s-03.jsonl" {
		t.Fatalf("second page files: %v", second)
	}

	third := readFiles(20, 10)
	if len(third) != 3 || third[0] != "s-02.jsonl" || third[2] != "s-00.jsonl" {
		t.Fatalf("third page files: %v", third)
	}

	if past := readFiles(23, 10); len(past) != 0 {
		t.Fatalf("offset past end parsed titles: %v", past)
	}
}

func TestListClaudeSessionsPageAcrossProjects(t *testing.T) {
	t.Run("global window over all projects", func(t *testing.T) {
		home := setupMockHome(t)
		cwdA := filepath.Join(t.TempDir(), "project-a")
		cwdB := filepath.Join(t.TempDir(), "project-b")
		encodedA := encodeClaudeProjectDir(cwdA)
		encodedB := encodeClaudeProjectDir(cwdB)

		type fixture struct {
			cwd, encoded, id string
			index            int
			title            bool
		}
		fixtures := []fixture{
			{cwdA, encodedA, "a-new", 0, true},
			{cwdB, encodedB, "b-new", 1, true},
			{cwdA, encodedA, "a-mid", 2, true},
			{cwdB, encodedB, "b-mid", 3, true},
			{cwdA, encodedA, "a-old", 4, false},
			{cwdB, encodedB, "b-old", 5, true},
		}
		for _, f := range fixtures {
			lines := []string{fmt.Sprintf(`{"type":"mode","sessionId":%q}`, f.id)}
			if f.title {
				lines = append(lines, fmt.Sprintf(`{"type":"ai-title","aiTitle":%q,"cwd":%q}`, "Title "+f.id, f.cwd))
			}
			writeClaudeTranscript(t, home, f.encoded, f.id, lines...)
			setMtime(t, filepath.Join(home, ".claude", "projects", f.encoded, f.id+".jsonl"), pageMtime(f.index))
		}

		first, err := listClaudeSessionsPage("", "", 0, 3)
		if err != nil {
			t.Fatalf("first page: %v", err)
		}
		requireIDs(t, "first page", first, "a-new", "b-new", "a-mid")
		if first[0].Cwd != cwdA || first[1].Cwd != cwdB {
			t.Fatalf("transcript cwd: %+v", first)
		}

		second, err := listClaudeSessionsPage("", "", 3, 3)
		if err != nil {
			t.Fatalf("second page: %v", err)
		}
		requireIDs(t, "second page", second, "b-mid", "a-old", "b-old")
		wantFallback := "Claude session a-old " + pageMtime(4).Format("02 Jan 2006")
		if second[1].Title != wantFallback {
			t.Fatalf("decoded-dir fallback: got %q, want %q", second[1].Title, wantFallback)
		}

		filtered, err := listClaudeSessionsPage(cwdA, "", 0, 10)
		if err != nil {
			t.Fatalf("filtered list: %v", err)
		}
		requireIDs(t, "filtered", filtered, "a-new", "a-mid", "a-old")
	})

	t.Run("explicit config dir wins over HOME", func(t *testing.T) {
		home := setupMockHome(t)
		altDir := t.TempDir()
		cwd := filepath.Join(t.TempDir(), "alt-project")
		encoded := encodeClaudeProjectDir(cwd)

		writeClaudeTranscript(t, home, encoded, "home-only",
			fmt.Sprintf(`{"type":"ai-title","aiTitle":"Home title","cwd":%q}`, cwd))
		setMtime(t, filepath.Join(home, ".claude", "projects", encoded, "home-only.jsonl"), pageMtime(0))

		altProjects := filepath.Join(altDir, "projects", encoded)
		if err := os.MkdirAll(altProjects, 0o755); err != nil {
			t.Fatal(err)
		}
		altPath := filepath.Join(altProjects, "alt-only.jsonl")
		body := fmt.Sprintf("{\"type\":\"ai-title\",\"aiTitle\":\"Alt title\",\"cwd\":%q}\n", cwd)
		if err := os.WriteFile(altPath, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		setMtime(t, altPath, pageMtime(0))

		items, err := listClaudeSessionsPage(cwd, altDir, 0, 10)
		if err != nil {
			t.Fatalf("alt config dir: %v", err)
		}
		requireIDs(t, "alt config dir", items, "alt-only")
	})
}
