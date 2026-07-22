package mdwatch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitFor blocks until an event arrives on ch or timeout elapses,
// returning the event and true, or "" and false on timeout.
func waitFor(t *testing.T, ch chan string, timeout time.Duration) (string, bool) {
	t.Helper()
	select {
	case dir := <-ch:
		return dir, true
	case <-time.After(timeout):
		return "", false
	}
}

// assertNoEvent fails the test if an event arrives on ch within window.
func assertNoEvent(t *testing.T, ch chan string, window time.Duration) {
	t.Helper()
	select {
	case dir := <-ch:
		t.Fatalf("expected no event, got one for %q", dir)
	case <-time.After(window):
	}
}

// newTestWatcher builds a Watcher over dirs (fixed set, via a closure)
// with a short Debounce/RearmInterval suitable for tests, collecting
// onChange calls into a buffered channel.
func newTestWatcher(t *testing.T, getDirs func() []string) (*Watcher, chan string) {
	t.Helper()
	events := make(chan string, 16)
	w, err := New(getDirs, func(dir string) {
		events <- dir
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	w.Debounce = 50 * time.Millisecond
	w.RearmInterval = 100 * time.Millisecond
	t.Cleanup(w.Close)
	return w, events
}

func TestCreateMdFires(t *testing.T) {
	dir := t.TempDir()
	w, events := newTestWatcher(t, func() []string { return []string{dir} })
	w.Start()

	if err := os.WriteFile(filepath.Join(dir, "a.md"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, ok := waitFor(t, events, 2*time.Second)
	if !ok {
		t.Fatal("expected an onChange event, got none within 2s")
	}
	if got != dir {
		t.Errorf("expected event dir %q, got %q", dir, got)
	}
}

func TestNonMdIgnored(t *testing.T) {
	dir := t.TempDir()
	w, events := newTestWatcher(t, func() []string { return []string{dir} })
	w.Start()

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	assertNoEvent(t, events, 300*time.Millisecond)
}

func TestDebounceCoalesces(t *testing.T) {
	dir := t.TempDir()
	w, events := newTestWatcher(t, func() []string { return []string{dir} })
	w.Start()

	for i := 0; i < 5; i++ {
		name := filepath.Join(dir, string(rune('a'+i))+".md")
		if err := os.WriteFile(name, []byte("hi"), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	if _, ok := waitFor(t, events, 2*time.Second); !ok {
		t.Fatal("expected exactly one onChange event, got none within 2s")
	}
	assertNoEvent(t, events, 300*time.Millisecond)
}

func TestRemoveMdFires(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "b.md")
	if err := os.WriteFile(path, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	w, events := newTestWatcher(t, func() []string { return []string{dir} })
	w.Start()

	if err := os.Remove(path); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if _, ok := waitFor(t, events, 2*time.Second); !ok {
		t.Fatal("expected an onChange event for the removed file, got none within 2s")
	}
}

func TestLateCreatedDirArmed(t *testing.T) {
	tmp := t.TempDir()
	dir := filepath.Join(tmp, "research")

	w, events := newTestWatcher(t, func() []string { return []string{dir} })
	w.Start()

	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// Give the rearm ticker (100ms) a chance to arm the now-existing dir
	// before creating the file: fsnotify watches don't retroactively
	// report contents present at Add-time, only future events, so a
	// mkdir+create with zero gap would race the watch itself.
	time.Sleep(3 * w.RearmInterval)
	if err := os.WriteFile(filepath.Join(dir, "c.md"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, ok := waitFor(t, events, 2*time.Second); !ok {
		t.Fatal("expected the rearm ticker to arm the late-created dir and fire an event within 2s")
	}
}

func TestCloseIdempotent(t *testing.T) {
	dir := t.TempDir()
	w, err := New(func() []string { return []string{dir} }, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	w.Start()
	w.Close()
	w.Close() // must not panic
}
