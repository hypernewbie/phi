package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func clearPiTitleMemo() {
	piTitleMemoMu.Lock()
	clear(piTitleMemo)
	piTitleMemoMu.Unlock()
}

// piPromptRecord builds a user message record whose prompt becomes the title.
func piPromptRecord(prompt string) string {
	return `{"type":"message","message":{"role":"user","content":"` + prompt + `"}}`
}

// A warm entry must skip the loader entirely and return the same text,
// including long Unicode names, empty titles, and the listing fallback.
func TestPiTitleMemoWarmsAndMatchesUncached(t *testing.T) {
	t.Cleanup(clearPiTitleMemo)
	_, dir := setupPiTestSessions(t)
	unicodeName := strings.Repeat("标题-üñïçø∂é-", 40)
	cases := []struct {
		name    string
		records []string
	}{
		{name: "plain", records: []string{`{"type":"session_info","name":"Named session"}`}},
		{name: "empty"},
		{name: "empty-then-prompt", records: []string{`{"type":"session_info","name":""}`, piPromptRecord("Useful prompt")}},
		{name: "unicode", records: []string{`{"type":"session_info","name":"` + unicodeName + `"}`}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			path := writePiFixture(t, dir, test.name+".jsonl", append([]string{`{"type":"session","id":"x","cwd":"/tmp"}`}, test.records...)...)
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			want, cacheable := extractPiSessionTitleResult(path)
			if !cacheable {
				t.Fatal("fixture unexpectedly uncacheable")
			}
			calls := 0
			load := func(string) (string, bool) { calls++; return want, true }
			if got := piSessionTitleWithLoader(path, info, load); got != want || calls != 1 {
				t.Fatalf("first load = %q calls=%d, want %q", got, calls, want)
			}
			if got := piSessionTitleWithLoader(path, info, load); got != want || calls != 1 {
				t.Fatalf("warm load = %q calls=%d, want a memo hit", got, calls)
			}
			if got := extractPiSessionTitle(path); got != want {
				t.Fatalf("wrapper title = %q, want %q", got, want)
			}
		})
	}
}

// Any metadata change the listing can observe must refresh the title.
func TestPiTitleMemoInvalidatesOnFileChanges(t *testing.T) {
	t.Cleanup(clearPiTitleMemo)
	_, dir := setupPiTestSessions(t)
	path := writePiFixture(t, dir, "changes.jsonl",
		`{"type":"session","id":"x","cwd":"/tmp"}`,
		`{"type":"session_info","name":"Original"}`)
	stamp := func() os.FileInfo {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		return info
	}
	title := func() string {
		t.Helper()
		return piSessionTitle(path, stamp())
	}
	if got := title(); got != "Original" {
		t.Fatalf("initial title = %q", got)
	}
	if got := title(); got != "Original" {
		t.Fatalf("warm title = %q", got)
	}

	// Append: the newest name wins.
	appendRecord(t, path, `{"type":"session_info","name":"Appended"}`)
	if got := title(); got != "Appended" {
		t.Fatalf("after append = %q, want Appended", got)
	}

	// Truncate: the name disappears and the prompt becomes the title.
	truncateTo(t, path, `{"type":"session","id":"x","cwd":"/tmp"}`+"\n"+piPromptRecord("Truncated prompt")+"\n")
	if got := title(); got != "Truncated prompt" {
		t.Fatalf("after truncate = %q, want the prompt", got)
	}

	// Equal-size rewrite with a changed mtime.
	before := stamp()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	replaced := strings.Replace(string(content), "Truncated prompt", "Rewritten prompt", 1)
	if len(replaced) != len(content) {
		t.Fatalf("test requires equal-size rewrite: %d vs %d", len(replaced), len(content))
	}
	if err := os.WriteFile(path, []byte(replaced), 0644); err != nil {
		t.Fatal(err)
	}
	later := before.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if got := title(); got != "Rewritten prompt" {
		t.Fatalf("after equal-size rewrite = %q, want the rewritten prompt", got)
	}

	// Atomic replacement with size and mtime restored.
	restored := stamp()
	fresh := filepath.Join(filepath.Dir(path), "replacement.jsonl")
	replacement := strings.Replace(replaced, "Rewritten prompt", "Replaced! prompt", 1)
	if len(replacement) != int(restored.Size()) {
		t.Fatal("test requires an equal-size replacement")
	}
	if err := os.WriteFile(fresh, []byte(replacement), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(fresh, restored.ModTime(), restored.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(fresh, path); err != nil {
		t.Fatal(err)
	}
	replacementInfo := stamp()
	if os.SameFile(restored, replacementInfo) || restored.Size() != replacementInfo.Size() || restored.Mode() != replacementInfo.Mode() || !restored.ModTime().Equal(replacementInfo.ModTime()) {
		t.Fatal("test requires a new file identity with matching metadata")
	}
	if got := title(); got != "Replaced! prompt" {
		t.Fatalf("after atomic replacement = %q, want Replaced! prompt", got)
	}
}

// A title that changes during extraction must not be stored, and a failed load
// must not poison the next successful one.
func TestPiTitleMemoSkipsUnstableAndFailedLoads(t *testing.T) {
	t.Cleanup(clearPiTitleMemo)
	_, dir := setupPiTestSessions(t)
	path := writePiFixture(t, dir, "unstable.jsonl",
		`{"type":"session","id":"x","cwd":"/tmp"}`,
		`{"type":"session_info","name":"First"}`)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}

	calls := 0
	unstable := func(string) (string, bool) {
		calls++
		later := time.Now().Add(time.Duration(calls) * time.Second)
		if err := os.Chtimes(path, later, later); err != nil {
			t.Errorf("touch session file: %v", err)
		}
		return "First", true
	}
	if got := piSessionTitleWithLoader(path, info, unstable); got != "First" {
		t.Fatalf("unstable load = %q", got)
	}
	if _, ok := lookupPiTitleMemo(path, mustLstat(t, path)); ok {
		t.Fatal("a title extracted across a metadata change was stored")
	}
	if got := piSessionTitleWithLoader(path, mustLstat(t, path), unstable); got != "First" || calls != 2 {
		t.Fatalf("retry = %q calls=%d, want a second load", got, calls)
	}

	// A failed load stores nothing and does not shadow the successful retry.
	clearPiTitleMemo()
	failed := func(string) (string, bool) { return "", false }
	if got := piSessionTitleWithLoader(path, mustLstat(t, path), failed); got != "" {
		t.Fatalf("failed load = %q, want empty", got)
	}
	if _, ok := lookupPiTitleMemo(path, mustLstat(t, path)); ok {
		t.Fatal("a failed load populated the memo")
	}
	if got := piSessionTitle(path, mustLstat(t, path)); got != "First" {
		t.Fatalf("load after failure = %q, want First", got)
	}
}

// Cached and uncached titles agree on the semantics the memo must preserve,
// and oversized titles are returned but not stored.
func TestPiTitleMemoTitleSemanticsAndBounds(t *testing.T) {
	t.Cleanup(clearPiTitleMemo)
	_, dir := setupPiTestSessions(t)
	huge := strings.Repeat("x", piTitleMemoMaxBytes+1)
	cases := []struct {
		name    string
		records []string
		want    string
		stored  bool
	}{
		{
			name:    "latest name wins",
			records: []string{`{"type":"session_info","name":"First"}`, `{"type":"session_info","name":"Second"}`},
			want:    "Second",
			stored:  true,
		},
		{
			name:    "null clears to prompt",
			records: []string{piPromptRecord("Prompt title"), `{"type":"session_info","name":"Named"}`, `{"type":"session_info","name":null}`},
			want:    "Prompt title",
			stored:  true,
		},
		{
			name:    "non-string is ignored",
			records: []string{`{"type":"session_info","name":"Named"}`, `{"type":"session_info","name":123}`},
			want:    "Named",
			stored:  true,
		},
		{
			name:    "oversized stays uncached",
			records: []string{`{"type":"session_info","name":"` + huge + `"}`},
			want:    huge,
			stored:  false,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			path := writePiFixture(t, dir, strings.ReplaceAll(test.name, " ", "-")+".jsonl",
				append([]string{`{"type":"session","id":"x","cwd":"/tmp"}`}, test.records...)...)
			want, cacheable := extractPiSessionTitleResult(path)
			if !cacheable || want != test.want {
				t.Fatalf("uncached title = %q cacheable=%t, want %q", want, cacheable, test.want)
			}
			if got := piSessionTitle(path, mustLstat(t, path)); got != test.want {
				t.Fatalf("memo title = %q, want %q", got, test.want)
			}
			if _, ok := lookupPiTitleMemo(path, mustLstat(t, path)); ok != test.stored {
				t.Fatalf("stored=%t, want %t", ok, test.stored)
			}
		})
	}

	// Capacity is bounded: filling the memo clears it.
	for i := 0; i < piTitleMemoCap+1; i++ {
		path := writePiFixture(t, dir, "capacity-"+string(rune('a'+i%26))+string(rune('a'+i/26))+".jsonl",
			`{"type":"session","id":"x","cwd":"/tmp"}`, `{"type":"session_info","name":"n"}`)
		storePiTitleMemo(path, mustLstat(t, path), "n")
	}
	piTitleMemoMu.Lock()
	size := len(piTitleMemo)
	piTitleMemoMu.Unlock()
	if size > piTitleMemoCap {
		t.Fatalf("memo holds %d entries, cap is %d", size, piTitleMemoCap)
	}
}

// The listing must keep using the validated metadata, keep files isolated, and
// keep warning-based fixtures uncached so their warning counts stay meaningful.
func TestPiTitleMemoListingBehavior(t *testing.T) {
	t.Cleanup(clearPiTitleMemo)
	cwd, dir := setupPiTestSessions(t)
	header := piSessionHeader("id-1", cwd)
	first := writePiFixture(t, dir, "a.jsonl", header, `{"type":"session_info","name":"Alpha"}`)
	second := writePiFixture(t, dir, "b.jsonl", header, `{"type":"session_info","name":"Beta"}`)
	malformed := writePiFixture(t, dir, "c.jsonl", header, `{"type":"session_info","name":"Broken"`, piPromptRecord("Prompt"))
	empty := writePiFixture(t, dir, "empty.jsonl", header)
	symlink := filepath.Join(dir, "d.jsonl")
	if err := os.Symlink(first, symlink); err != nil {
		t.Fatal(err)
	}

	sessions, err := ListPiSessions(cwd)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]string{}
	for _, item := range sessions {
		byPath[item.SessionPath] = item.Title
	}
	wantFallback := "Pi session id-1 " + mustLstat(t, empty).ModTime().Format("02 Jan 2006")
	if byPath[empty] != wantFallback {
		t.Fatalf("empty title fallback = %q, want %q", byPath[empty], wantFallback)
	}
	if title, hit := lookupPiTitleMemo(empty, mustLstat(t, empty)); !hit || title != "" {
		t.Fatalf("empty title memo = %q hit=%t, want a cached empty title", title, hit)
	}
	if byPath[first] != "Alpha" || byPath[second] != "Beta" {
		t.Fatalf("titles = %v", byPath)
	}
	if _, ok := byPath[symlink]; ok {
		t.Fatal("symlinked session was listed")
	}
	if _, ok := lookupPiTitleMemo(malformed, mustLstat(t, malformed)); ok {
		t.Fatal("a malformed fixture was cached despite its warning")
	}
	if _, ok := lookupPiTitleMemo(first, mustLstat(t, first)); !ok {
		t.Fatal("a clean session title was not cached")
	}

	// A change to one file must not disturb the other's entry.
	appendRecord(t, first, `{"type":"session_info","name":"Alpha two"}`)
	sessions, err = ListPiSessions(cwd)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range sessions {
		switch item.SessionPath {
		case first:
			if item.Title != "Alpha two" {
				t.Fatalf("changed file title = %q", item.Title)
			}
		case second:
			if item.Title != "Beta" {
				t.Fatalf("unchanged file title = %q", item.Title)
			}
		case empty:
			if item.Title != wantFallback {
				t.Fatalf("warm empty fallback = %q, want %q", item.Title, wantFallback)
			}
		}
	}

}

func mustLstat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func appendRecord(t *testing.T, path, record string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(record + "\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func truncateTo(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
