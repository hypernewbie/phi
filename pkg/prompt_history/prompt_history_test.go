package prompt_history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "prompt_history.json")
	s, err := Load(path)
	if err != nil {
		t.Fatalf("load on missing file: %v", err)
	}
	if s == nil {
		t.Fatalf("Load returned nil store")
	}
	if s.Len() != 0 {
		t.Fatalf("fresh store should be empty, got %d entries", s.Len())
	}
	return s
}

func TestLoad_MissingFileYieldsEmptyStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nope.json")
	s, err := Load(path)
	if err != nil {
		t.Fatalf("missing file should not error, got: %v", err)
	}
	if s.Len() != 0 {
		t.Fatalf("expected 0 entries, got %d", s.Len())
	}
}

func TestLoad_CorruptFileReturnsErrorAndEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt.json")
	if err := os.WriteFile(path, []byte("{ not parseable json"), 0644); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}
	s, err := Load(path)
	if err == nil {
		t.Fatalf("corrupt file must surface an error (so the caller can warn the user)")
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Fatalf("expected parse error, got: %v", err)
	}
	if s == nil || s.Len() != 0 {
		t.Fatalf("load should still return a usable empty store, got %+v", s)
	}
}

func TestAppend_RoundTripAcrossReload(t *testing.T) {
	// Simulate the user-facing flow: send prompts, then "restart" by
	// re-reading the file fresh from disk and confirming every entry
	// is still there.
	path := filepath.Join(t.TempDir(), "history.json")
	s1, _ := Load(path)
	if _, err := s1.Append("first prompt", "/proj/a"); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if _, err := s1.Append("second prompt", "/proj/a"); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	if _, err := s1.Append("third", "/proj/b"); err != nil {
		t.Fatalf("append 3: %v", err)
	}

	// "Restart": drop the in-memory store, reload from disk.
	s2, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if s2.Len() != 3 {
		t.Fatalf("after restart, expected 3 entries, got %d", s2.Len())
	}
	recent := s2.Recent("/proj/a", 0)
	if len(recent) != 2 {
		t.Fatalf("/proj/a should have 2 entries, got %d", len(recent))
	}
	// Recent returns newest-first.
	if recent[0].Text != "second prompt" || recent[1].Text != "first prompt" {
		t.Fatalf("Recent order wrong: %+v", recent)
	}
	recentB := s2.Recent("/proj/b", 0)
	if len(recentB) != 1 || recentB[0].Text != "third" {
		t.Fatalf("/proj/b entry wrong: %+v", recentB)
	}
}

func TestAppend_FifoEvictionAtCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evict.json")
	s, _ := Load(path)
	s.maxEntries = 5 // shrink for the test
	for i := 0; i < 10; i++ {
		if _, err := s.Append("prompt #"+itoa(i), "/p"); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	if s.Len() != 5 {
		t.Fatalf("after 10 appends with cap 5, Len=%d want 5", s.Len())
	}
	recent := s.Recent("/p", 0)
	if len(recent) != 5 {
		t.Fatalf("want 5 retained, got %d", len(recent))
	}
	// The 5 newest (#5..#9) must be the ones retained. Recent is
	// newest-first, so the first item is "prompt #9".
	retainedSet := map[string]bool{}
	for _, e := range recent {
		retainedSet[e.Text] = true
	}
	for i := 5; i <= 9; i++ {
		want := "prompt #" + itoa(i)
		if !retainedSet[want] {
			t.Fatalf("expected %q to be retained, got %v", want, recent)
		}
	}
	// And the 5 oldest (#0..#4) must be GONE.
	for i := 0; i <= 4; i++ {
		gone := "prompt #" + itoa(i)
		if retainedSet[gone] {
			t.Fatalf("oldest %q should have been evicted, got %v", gone, recent)
		}
	}
}

func TestAppend_EmptyTextIsSkipped(t *testing.T) {
	s := makeStore(t)
	n, err := s.Append("   ", "/p")
	if err != nil {
		t.Fatalf("append empty: %v", err)
	}
	if n != 0 {
		t.Fatalf("empty/whitespace should not be stored, got length %d", n)
	}
}

func TestRecent_NParameter(t *testing.T) {
	s := makeStore(t)
	for i := 0; i < 5; i++ {
		s.Append("p"+itoa(i), "/p")
	}
	// n=0 returns everything (newest-first).
	all := s.Recent("/p", 0)
	if len(all) != 5 {
		t.Fatalf("n=0 must return everything: got %d", len(all))
	}
	// n limits.
	top3 := s.Recent("/p", 3)
	if len(top3) != 3 {
		t.Fatalf("n=3 must limit to 3: got %d", len(top3))
	}
	// Newest first. Last appended was p4, so it must lead.
	if !strings.Contains(top3[0].Text, "p4") {
		t.Fatalf("top3[0] should be newest ('p4'): %q", top3[0].Text)
	}
}

func TestAppend_ConcurrentSafe(t *testing.T) {
	// Quick concurrency check — Append must not corrupt the file
	// under simultaneous writes. We don't assert specific ordering,
	// just that the file ends up parseable and Len ≤ cap.
	s := makeStore(t)
	s.maxEntries = 100
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func(gid int) {
			for i := 0; i < 20; i++ {
				s.Append("g"+itoa(gid)+"-i"+itoa(i), "/p")
			}
			done <- struct{}{}
		}(g)
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	// Final entry count is at most cap (160 appends vs 100 cap → 100 entries).
	if s.Len() > s.maxEntries {
		t.Fatalf("len %d exceeded cap %d", s.Len(), s.maxEntries)
	}
	// Re-load from disk and confirm JSON parses.
	s2, err := Load(s.path) // path is private; we wrote to disk so reload via file
	_ = s2
	_ = err
	// Re-load from the same path via a fresh Load call.
	s3, err := Load(s.path)
	if err != nil {
		t.Fatalf("reload after concurrent append: %v", err)
	}
	if s3.Len() == 0 {
		t.Fatalf("reload lost all entries")
	}
}

// Lightweight int->string so the tests don't pull in fmt imports just
// to format i (small helper for readability).
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	const digits = "0123456789"
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = digits[i%10]
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

// Silence "unused import" if json isn't read directly.
var _ = json.Marshal
