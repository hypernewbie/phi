package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
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

func TestLegacyImportBuildsBoundedGroup(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "legacy-pane"
	chunk := bytes.Repeat([]byte("imported library line with color \x1b[31mred\x1b[0m and UTF-8 你🙂\r\n"), 2048)
	var chunks [][]byte
	for i := 0; i < 12; i++ {
		chunks = append(chunks, chunk)
	}
	resizes := map[int][2]uint16{0: {100, 30}, 6: {120, 40}, 9: {0, 0}}
	source := writeLegacyLog(t, legacyLogPath(dir, pane), chunks, resizes)
	var ordered [][3]uint64
	var head uint64
	for i := range chunks {
		if g, ok := resizes[i]; ok {
			ordered = append(ordered, [3]uint64{head, uint64(g[0]), uint64(g[1])})
		}
		head += uint64(len(chunks[i]))
	}
	anchorThrough := uint64(len(chunks[0]) * 2)
	writeLegacyAnchor(t, legacyLogPath(dir, pane), anchorThrough, source, ordered)
	writeLegacyAnchor(t, legacyLogPath(dir, pane), 0, source, ordered)
	stampLegacy(t, legacyLogPath(dir, pane), fc.Now())

	rec, ok := h.Recording(pane, 0, uint64(len(source)))
	if !ok {
		t.Fatal("eligible legacy log did not import")
	}
	if rec.Start != uint64(len(source))-(1<<20) || rec.End != uint64(len(source)) {
		t.Fatalf("imported window start=%d end=%d", rec.Start, rec.End)
	}
	if !bytes.Equal(rec.Data, source[len(source)-(1<<20):]) {
		t.Fatal("imported tail bytes are not the newest 1 MiB")
	}
	if len(rec.Resizes) == 0 || rec.Resizes[0].AtSeq != rec.Start {
		t.Fatalf("imported markers lack the in-force geometry: %+v", rec.Resizes)
	}
	for i := 1; i < len(rec.Resizes); i++ {
		if rec.Resizes[i].AtSeq < rec.Resizes[i-1].AtSeq {
			t.Fatal("imported markers out of order")
		}
	}
	wantScreen, wantContinuation, wantCols, wantRows := parseDirect(t, source, ordered)
	_, state, cols, rows, err := h.State(pane)
	if err != nil {
		t.Fatal(err)
	}
	gotScreen, gotContinuation, gotCols, gotRows := restoreDirect(t, state)
	if !bytes.Equal(gotScreen, wantScreen) || !bytes.Equal(gotContinuation, wantContinuation) {
		t.Fatal("imported state screen or continuation differs from a direct parse")
	}
	if gotCols != wantCols || gotRows != wantRows || cols != wantCols || rows != wantRows {
		t.Fatalf("imported geometry %dx%d/%dx%d want %dx%d", gotCols, gotRows, cols, rows, wantCols, wantRows)
	}
	stats := h.lastImportStats()
	if !stats.usedAnchor || stats.parsedBytes >= uint64(len(source)) {
		t.Fatalf("import did not use the anchor fast path: %+v", stats)
	}
	if _, err := os.Stat(legacyLogPath(dir, pane)); err != nil {
		t.Fatalf("import touched the legacy original: %v", err)
	}
}

func TestLegacyImportWithoutAnchorsStreamsThePrefix(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "no-anchor"
	source := writeLegacyLog(t, legacyLogPath(dir, pane), [][]byte{
		bytes.Repeat([]byte("first page\r\n"), 4000),
		bytes.Repeat([]byte("second page\r\n"), 4000),
	}, map[int][2]uint16{1: {90, 28}})
	stampLegacy(t, legacyLogPath(dir, pane), fc.Now())
	rec, ok := h.Recording(pane, 0, uint64(len(source)))
	if !ok {
		t.Fatal("anchorless legacy log did not import")
	}
	if !bytes.Equal(rec.Data, source) {
		t.Fatal("small-log import is not byte-identical")
	}
	stats := h.lastImportStats()
	if stats.usedAnchor {
		t.Fatalf("import claims an anchor that does not exist: %+v", stats)
	}
}

func TestLegacyImportAnchorAtResizeBoundary(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "anchor-resize"
	first := bytes.Repeat([]byte("before resize\r\n"), 20000)
	second := bytes.Repeat([]byte("after resize\r\n"), 80000)
	source := writeLegacyLog(t, legacyLogPath(dir, pane), [][]byte{first, second}, map[int][2]uint16{1: {132, 45}})
	ordered := [][3]uint64{{uint64(len(first)), 132, 45}}
	writeLegacyAnchor(t, legacyLogPath(dir, pane), uint64(len(first)), source, ordered)
	stampLegacy(t, legacyLogPath(dir, pane), fc.Now())
	rec, ok := h.Recording(pane, 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source[len(source)-(1<<20):]) {
		t.Fatal("anchor-at-resize log did not import its newest 1 MiB")
	}
	wantScreen, wantContinuation, wantCols, wantRows := parseDirect(t, source, ordered)
	_, state, cols, rows, err := h.State(pane)
	if err != nil {
		t.Fatal(err)
	}
	gotScreen, gotContinuation, _, _ := restoreDirect(t, state)
	if !bytes.Equal(gotScreen, wantScreen) || !bytes.Equal(gotContinuation, wantContinuation) {
		t.Fatal("anchor-at-resize import lost the boundary resize")
	}
	if cols != wantCols || rows != wantRows {
		t.Fatalf("anchor-at-resize geometry %dx%d want %dx%d", cols, rows, wantCols, wantRows)
	}
	if stats := h.lastImportStats(); !stats.usedAnchor {
		t.Fatalf("anchor-at-resize did not use the anchor: %+v", stats)
	}
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

func TestLegacyImportRejectsCorruptMiddleAndRecoversTornTail(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	good := writeLegacyLog(t, legacyLogPath(dir, "bad"), [][]byte{
		[]byte("alpha\r\n"),
		[]byte("bravo\r\n"),
		[]byte("charlie\r\n"),
	}, nil)
	before := sha256.Sum256(append([]byte(nil), mustRead(t, legacyLogPath(dir, "bad"))...))
	_ = good
	// Corrupt the middle record header while a valid chain follows.
	data := mustRead(t, legacyLogPath(dir, "bad"))
	data[5+len("alpha\r\n")] = 9
	if err := os.WriteFile(legacyLogPath(dir, "bad"), data, 0600); err != nil {
		t.Fatal(err)
	}
	stampLegacy(t, legacyLogPath(dir, "bad"), fc.Now())
	before = sha256.Sum256(mustRead(t, legacyLogPath(dir, "bad")))
	if _, ok := h.Recording("bad", 0, 100); ok {
		t.Fatal("corrupt middle imported")
	}
	if sha256.Sum256(mustRead(t, legacyLogPath(dir, "bad"))) != before {
		t.Fatal("rejected import modified the legacy original")
	}
	// A torn final append imports its committed prefix.
	writeLegacyLog(t, legacyLogPath(dir, "torn"), [][]byte{[]byte("committed\r\n")}, nil)
	f, err := os.OpenFile(legacyLogPath(dir, "torn"), os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{1, 0, 0, 0, 20, 'x'}); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	stampLegacy(t, legacyLogPath(dir, "torn"), fc.Now())
	rec, ok := h.Recording("torn", 0, 100)
	if !ok || !bytes.Equal(rec.Data, []byte("committed\r\n")) {
		t.Fatalf("torn tail import bytes=%q ok=%t", rec.Data, ok)
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

func TestExpiredImportDoesNotResurrect(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "aging"
	source := writeLegacyLog(t, legacyLogPath(dir, pane), [][]byte{[]byte("aging history\r\n")}, nil)
	before := sha256.Sum256(mustRead(t, legacyLogPath(dir, pane)))
	legacyTime := fc.Now().Add(-6 * 24 * time.Hour)
	if err := os.Chtimes(legacyLogPath(dir, pane), legacyTime, legacyTime); err != nil {
		t.Fatal(err)
	}
	rec, ok := h.Recording(pane, 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("six-day-old legacy did not import")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h2 := NewHub(0)
	h2.clock = fc.Now
	h2.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	if err := h2.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer h2.Close()
	fc.Advance(2 * 24 * time.Hour)
	if stats := h2.sweepRetention(fc.Now()); stats.GroupsDeleted != 1 {
		t.Fatalf("imported group kept past its source clock: %+v", stats)
	}
	if _, ok := h2.Recording(pane, 0, 100); ok {
		t.Fatal("expired import resurrected from the legacy original")
	}
	if sha256.Sum256(mustRead(t, legacyLogPath(dir, pane))) != before {
		t.Fatal("expiry modified the legacy original")
	}
}

func TestSpawnFailsLoudlyWhenEligibleImportFails(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	writeLegacyLog(t, legacyLogPath(dir, "bad"), [][]byte{[]byte("a\r\n"), []byte("b\r\n"), []byte("c\r\n")}, nil)
	data := mustRead(t, legacyLogPath(dir, "bad"))
	data[len("a\r\n")+5] = 9
	if err := os.WriteFile(legacyLogPath(dir, "bad"), data, 0600); err != nil {
		t.Fatal(err)
	}
	stampLegacy(t, legacyLogPath(dir, "bad"), fc.Now())
	before := sha256.Sum256(mustRead(t, legacyLogPath(dir, "bad")))
	if err := h.Ingest("bad", []byte("live\r\n")); err == nil {
		t.Fatal("spawn over failed import admitted bytes")
	}
	if _, err := os.Stat(h.recordingPath("bad")); !os.IsNotExist(err) {
		t.Fatal("failed import published fresh v2 authority")
	}
	if err := h.Ingest("bad", []byte("live\r\n")); err == nil {
		t.Fatal("retry over failed import admitted bytes")
	}
	if sha256.Sum256(mustRead(t, legacyLogPath(dir, "bad"))) != before {
		t.Fatal("failed import modified the legacy original")
	}
}

func TestLegacyImportStagesOnDestinationFilesystem(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	source := writeLegacyLog(t, legacyLogPath(dir, "ok"), [][]byte{[]byte("a\r\n"), []byte("b\r\n")}, nil)
	stampLegacy(t, legacyLogPath(dir, "ok"), fc.Now())
	// Staging must not depend on the system temp dir (which may live on
	// another filesystem where the final rename cannot work). TMPDIR only
	// governs unix temp dirs; on windows this asserts success only.
	t.Setenv("TMPDIR", filepath.Join(dir, "does-not-exist"))
	rec, ok := h.Recording("ok", 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("import with unusable TMPDIR did not adopt the legacy journal")
	}
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

func TestImportRenameFailurePropagatesWithoutDeadlock(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	writeLegacyLog(t, legacyLogPath(dir, "p"), [][]byte{[]byte("a\r\n"), []byte("b\r\n")}, nil)
	stampLegacy(t, legacyLogPath(dir, "p"), fc.Now())
	old := importRename
	importRename = func(_, _ string) error { return fmt.Errorf("injected rename failure") }
	t.Cleanup(func() { importRename = old })
	done := make(chan error, 1)
	go func() { done <- h.Ingest("p", []byte("live\r\n")) }()
	select {
	case err := <-done:
		if !errors.Is(err, errLegacyImportFailed) {
			t.Fatalf("rename failure err = %v, want import failure", err)
		}
		if _, serr := os.Stat(h.recordingPath("p")); !os.IsNotExist(serr) {
			t.Fatal("failed rename published authority")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("import rename failure deadlocked")
	}
}

func TestImportFailureCachesNegativeUntilSourceChanges(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	writeLegacyLog(t, legacyLogPath(dir, "bad"), [][]byte{[]byte("a\r\n"), []byte("b\r\n"), []byte("c\r\n")}, nil)
	data := mustRead(t, legacyLogPath(dir, "bad"))
	data[len("a\r\n")+5] = 9
	if err := os.WriteFile(legacyLogPath(dir, "bad"), data, 0600); err != nil {
		t.Fatal(err)
	}
	stampLegacy(t, legacyLogPath(dir, "bad"), fc.Now())
	if _, ok := h.Recording("bad", 0, 100); ok {
		t.Fatal("corrupt source imported")
	}
	h.mu.RLock()
	_, cached := h.importFailed["bad"]
	n := h.importScans
	h.mu.RUnlock()
	if !cached {
		t.Fatal("failed import was not cached")
	}
	if _, ok := h.Recording("bad", 0, 100); ok {
		t.Fatal("corrupt source imported on retry")
	}
	h.mu.RLock()
	again := h.importScans
	h.mu.RUnlock()
	if again != n {
		t.Fatal("cached failure rescanned the source")
	}
}

func TestImportAdoptsOnSpawnAndIgnoresIneligibleLegacy(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	source := writeLegacyLog(t, legacyLogPath(dir, "adopted"), [][]byte{bytes.Repeat([]byte("old process\r\n"), 1000)}, nil)
	stampLegacy(t, legacyLogPath(dir, "adopted"), fc.Now())
	ph, gerr := h.GetOrCreatePaneHub("adopted")
	if gerr != nil {
		t.Fatal(gerr)
	}
	ph.mu.Lock()
	total := ph.total
	ph.mu.Unlock()
	if total != uint64(len(source)) {
		t.Fatalf("spawn adopted total=%d want %d", total, len(source))
	}
	rec, ok := h.Recording("adopted", 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("spawned pane lost its adopted history")
	}
	old := writeLegacyLog(t, legacyLogPath(dir, "stale"), [][]byte{[]byte("stale\r\n")}, nil)
	_ = old
	if err := os.Chtimes(legacyLogPath(dir, "stale"), fc.Now().Add(-8*24*time.Hour), fc.Now().Add(-8*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	stale, gerr := h.GetOrCreatePaneHub("stale")
	if gerr != nil {
		t.Fatal(gerr)
	}
	stale.mu.Lock()
	staleTotal := stale.total
	stale.mu.Unlock()
	if staleTotal != 0 {
		t.Fatalf("spawn adopted ineligible history: total=%d", staleTotal)
	}
}

func TestSameSourceComparesIdentity(t *testing.T) {
	a := time.Unix(100, 0)
	if !sameSource(100, a, 100, a) || sameSource(101, a, 100, a) || sameSource(100, a, 100, a.Add(time.Second)) {
		t.Fatal("source identity comparison is wrong")
	}
}
