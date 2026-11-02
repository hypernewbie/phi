package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/termstate"
)

// writeLegacyLog appends output chunks and resize markers with the legacy
// journal format and returns the source bytes. Anchor through values must
// land on chunk boundaries.
func writeLegacyLog(t *testing.T, path string, chunks [][]byte, resizes map[int][2]uint16) []byte {
	t.Helper()
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	var source []byte
	var head uint64
	for i, chunk := range chunks {
		if g, ok := resizes[i]; ok {
			marker := []byte{byte(g[0] >> 8), byte(g[0]), byte(g[1] >> 8), byte(g[1])}
			if err := r.append(2, marker); err != nil {
				t.Fatal(err)
			}
		}
		if err := r.append(1, chunk); err != nil {
			t.Fatal(err)
		}
		source = append(source, chunk...)
		head += uint64(len(chunk))
	}
	if err := r.file.Close(); err != nil {
		t.Fatal(err)
	}
	_ = head
	return source
}

func writeLegacyAnchor(t *testing.T, logPath string, through uint64, prefix []byte, resizes [][3]uint64) {
	t.Helper()
	state, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	var fed uint64
	for _, r := range resizes {
		if r[0] > through {
			break
		}
		if r[0] > fed {
			if err := state.Feed(prefix[fed:r[0]]); err != nil {
				t.Fatal(err)
			}
			fed = r[0]
		}
		if r[1] == 0 || r[2] == 0 {
			continue
		}
		if err := state.Resize(int(r[1]), int(r[2])); err != nil {
			t.Fatal(err)
		}
	}
	if fed < through {
		if err := state.Feed(prefix[fed:through]); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, err := state.Ready()
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	if _, err := w.Write(snapshot); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	dir := logPath + ".state.d"
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%020d.state", through)), buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}

func legacyLogPath(dir, paneID string) string {
	return filepath.Join(dir, fmt.Sprintf("%x.log", sha256.Sum256([]byte(paneID))))
}

func parseDirect(t *testing.T, source []byte, resizes [][3]uint64) (screen, continuation []byte, cols, rows int) {
	t.Helper()
	state, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	var fed uint64
	for _, r := range resizes {
		if r[0] > uint64(len(source)) {
			break
		}
		if r[0] > fed {
			if err := state.Feed(source[fed:r[0]]); err != nil {
				t.Fatal(err)
			}
			fed = r[0]
		}
		if r[1] == 0 || r[2] == 0 {
			continue
		}
		if err := state.Resize(int(r[1]), int(r[2])); err != nil {
			t.Fatal(err)
		}
	}
	if fed < uint64(len(source)) {
		if err := state.Feed(source[fed:]); err != nil {
			t.Fatal(err)
		}
	}
	screen, err = state.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	continuation, err = state.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	cols, rows = state.Geometry()
	return screen, continuation, cols, rows
}
func TestLegacyImportRejectsOldAndFutureSources(t *testing.T) {
	for _, tc := range []struct {
		name  string
		mtime time.Time
	}{
		{"expired", time.Unix(1_700_000_000, 0).UTC().Add(-8 * 24 * time.Hour)},
		{"future", time.Unix(1_700_000_000, 0).UTC().Add(time.Hour)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
			h, dir := expiryTestHub(t, fc)
			path := legacyLogPath(dir, "pane")
			writeLegacyLog(t, path, [][]byte{[]byte("history\r\n")}, nil)
			before := sha256.Sum256(mustRead(t, path))
			if err := os.Chtimes(path, tc.mtime, tc.mtime); err != nil {
				t.Fatal(err)
			}
			if _, ok := h.Recording("pane", 0, 8); ok {
				t.Fatalf("%s source imported", tc.name)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if sha256.Sum256(after) != before {
				t.Fatal("rejected import modified the legacy original")
			}
		})
	}
}
func restoreDirect(t *testing.T, snapshot []byte) (screen, continuation []byte, cols, rows int) {
	t.Helper()
	state, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err := state.Restore(snapshot); err != nil {
		t.Fatal(err)
	}
	screen, err = state.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	continuation, err = state.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	cols, rows = state.Geometry()
	return screen, continuation, cols, rows
}

func stampLegacy(t *testing.T, path string, mtime time.Time) {
	t.Helper()
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestImportRejectsSymlinkedLegacyJournal(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	external := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(external, bytes.Repeat([]byte("V"), 4096), 0600); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(mustRead(t, external))
	if err := os.Symlink(external, legacyLogPath(dir, "linkpane")); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.Recording("linkpane", 0, 100); ok {
		t.Fatal("import followed a symlinked legacy journal")
	}
	h.mu.RLock()
	scans := h.importScans
	_, cached := h.importFailed["linkpane"]
	h.mu.RUnlock()
	if scans != 0 || cached {
		t.Fatal("symlink rejection scanned or cached instead of refusing upfront")
	}
	if _, err := os.Stat(h.recordingPath("linkpane")); !os.IsNotExist(err) {
		t.Fatal("symlink import published authority")
	}
	if sha256.Sum256(mustRead(t, external)) != before {
		t.Fatal("import mutated through the symlink")
	}
}
func TestSameSourceComparesIdentity(t *testing.T) {
	a := time.Unix(100, 0)
	if !sameSource(100, a, 100, a) || sameSource(101, a, 100, a) || sameSource(100, a, 100, a.Add(time.Second)) {
		t.Fatal("source identity comparison is wrong")
	}
}
