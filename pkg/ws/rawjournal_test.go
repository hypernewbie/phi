package ws

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTestRawJournal(t *testing.T, dir string) *rawJournal {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	j, err := openRawJournal(dir, 80, 24, nil)
	if err != nil {
		t.Fatalf("openRawJournal: %v", err)
	}
	t.Cleanup(func() { _ = j.close() })
	return j
}

func TestRawJournalPerAppendDurability(t *testing.T) {
	dir := t.TempDir()
	j := openTestRawJournal(t, dir)
	payloads := []string{"first\n", "second output chunk ", "third"}
	for i, p := range payloads {
		if _, err := j.appendPayload([]byte(p)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		if err := j.stageResize(100+uint16(i), 30); err != nil {
			t.Fatalf("stage %d: %v", i, err)
		}
		if _, err := j.commitResize(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
		// Every accepted append must survive a reopen on its own.
		r, err := openRawJournal(dir, 80, 24, nil)
		if err != nil {
			t.Fatalf("reopen %d: %v", i, err)
		}
		data, markers, endOrdinal, err := r.readOrd(0, r.head, 0)
		if err != nil {
			r.close()
			t.Fatalf("read %d: %v", i, err)
		}
		r.close()
		want := ""
		for _, q := range payloads[:i+1] {
			want += q
		}
		if string(data) != want {
			t.Fatalf("reopen %d: got %q want %q", i, data, want)
		}
		if len(markers) != i+1 || endOrdinal != uint64(i+1) {
			t.Fatalf("reopen %d: got %d markers end %d", i, len(markers), endOrdinal)
		}
	}
}

func TestRawJournalIdenticalRetryAdmitsOnce(t *testing.T) {
	j := openTestRawJournal(t, "")
	payload := []byte("held output")
	j.faults.dirSync = errors.New("injected dir sync failure")
	if _, err := j.appendPayload(payload); err == nil {
		t.Fatal("append with dir-sync fault must fail")
	}
	if j.pending == nil {
		t.Fatal("ambiguous manifest commit must retain pending state")
	}
	j.faults.dirSync = nil
	applied, err := j.appendPayload(payload)
	if err != nil {
		t.Fatalf("identical retry: %v", err)
	}
	if len(applied) != 0 {
		t.Fatalf("identical retry applied %d markers", len(applied))
	}
	if j.head != uint64(len(payload)) {
		t.Fatalf("head = %d, want %d (duplicated?)", j.head, len(payload))
	}
	data, _, _, err := j.readOrd(0, j.head, 0)
	if err != nil || string(data) != string(payload) {
		t.Fatalf("read after retry: %q, %v", data, err)
	}
}

func TestRawJournalMismatchedRetryRejected(t *testing.T) {
	j := openTestRawJournal(t, "")
	j.faults.dirSync = errors.New("injected dir sync failure")
	if _, err := j.appendPayload([]byte("original")); err == nil {
		t.Fatal("append with dir-sync fault must fail")
	}
	j.faults.dirSync = nil
	if _, err := j.appendPayload([]byte("different bytes")); !errors.Is(err, errStagedMismatch) {
		t.Fatalf("mismatched retry: got %v, want errStagedMismatch", err)
	}
	if _, err := j.appendPayload([]byte("original")); err != nil {
		t.Fatalf("identical retry after mismatch: %v", err)
	}
	if j.head != uint64(len("original")) {
		t.Fatalf("head = %d", j.head)
	}
}

func TestRawJournalSyncFaultsAdmitNothing(t *testing.T) {
	for _, fault := range []string{"journalSync", "manifestSync", "rename"} {
		j := openTestRawJournal(t, "")
		switch fault {
		case "journalSync":
			j.faults.journalSync = errors.New("injected")
		case "manifestSync":
			j.faults.manifestSync = errors.New("injected")
		case "rename":
			j.faults.rename = errors.New("injected")
		}
		if _, err := j.appendPayload([]byte("data")); err == nil {
			t.Fatalf("%s: append must fail", fault)
		}
		if j.pending != nil {
			t.Fatalf("%s: clean failure must not retain pending state", fault)
		}
		if j.head != 0 || len(j.chunks) != 0 {
			t.Fatalf("%s: failed append admitted bytes", fault)
		}
		j.faults = rawFaults{}
		if _, err := j.appendPayload([]byte("data")); err != nil {
			t.Fatalf("%s: retry after clear: %v", fault, err)
		}
		if j.head != 4 {
			t.Fatalf("%s: head = %d", fault, j.head)
		}
	}
}

func TestRawJournalMiddleCorruptionFailsClosed(t *testing.T) {
	dir := t.TempDir()
	j := openTestRawJournal(t, dir)
	for _, p := range []string{"alpha", "beta", "gamma"} {
		if _, err := j.appendPayload([]byte(p)); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	if err := j.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	path := filepath.Join(dir, "journal")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read journal: %v", err)
	}
	// Corrupt a middle header (record 2 starts at offset 10): the certified
	// prefix must fail closed, and the files must stay exactly as they
	// were for forensics. Payload bytes carry no checksum by design.
	before[10] = 0xFF
	if err := os.WriteFile(path, before, 0600); err != nil {
		t.Fatalf("corrupt journal: %v", err)
	}
	if _, err := openRawJournal(dir, 80, 24, nil); err == nil {
		t.Fatal("corrupt certified prefix must fail closed")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read journal after: %v", err)
	}
	if len(after) != len(before) {
		t.Fatalf("failed open truncated evidence: %d -> %d", len(before), len(after))
	}
	for i := range before {
		if after[i] != before[i] {
			t.Fatal("failed open modified the journal file")
		}
	}
}

func TestRawJournalTornTailTruncatesAndWarns(t *testing.T) {
	dir := t.TempDir()
	j := openTestRawJournal(t, dir)
	if _, err := j.appendPayload([]byte("committed")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := j.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// A torn uncommitted tail past the certified length recovers by
	// truncation, with the incomplete-history warning set.
	f, err := os.OpenFile(filepath.Join(dir, "journal"), os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	if _, err := f.Write([]byte{1, 0, 0, 0, 9, 'p', 'a'}); err != nil {
		t.Fatalf("write tail: %v", err)
	}
	f.Close()
	r, err := openRawJournal(dir, 80, 24, nil)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer r.close()
	if !r.historyIncomplete() {
		t.Fatal("truncated tail must set the incomplete-history warning")
	}
	if r.head != uint64(len("committed")) {
		t.Fatalf("head = %d", r.head)
	}
	data, _, _, err := r.readOrd(0, r.head, 0)
	if err != nil || string(data) != "committed" {
		t.Fatalf("verified prefix: %q, %v", data, err)
	}
}

func TestRawJournalUncleanLifetimeWarns(t *testing.T) {
	dir := t.TempDir()
	j := openTestRawJournal(t, dir)
	if _, err := j.appendPayload([]byte("output")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := j.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// No markClosed: the lifetime ended without recording its closure.
	r, err := openRawJournal(dir, 80, 24, nil)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !r.historyIncomplete() {
		r.close()
		t.Fatal("unclean lifetime must warn")
	}
	// Later successful appends cannot clear the warning.
	if _, err := r.appendPayload([]byte("more")); err != nil {
		r.close()
		t.Fatalf("append: %v", err)
	}
	if !r.historyIncomplete() {
		r.close()
		t.Fatal("warning must persist across later appends")
	}
	r.close()

	clean := t.TempDir()
	c := openTestRawJournal(t, clean)
	if _, err := c.appendPayload([]byte("output")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := c.markClosed(time.Now().UnixNano()); err != nil {
		t.Fatalf("markClosed: %v", err)
	}
	c.close()
	r2, err := openRawJournal(clean, 80, 24, nil)
	if err != nil {
		t.Fatalf("reopen clean: %v", err)
	}
	defer r2.close()
	if r2.historyIncomplete() {
		t.Fatal("clean closure must not warn")
	}
}

func TestRawJournalStagedResizeCommitAndAbandon(t *testing.T) {
	j := openTestRawJournal(t, "")
	if _, err := j.appendPayload([]byte("before")); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := j.stageResize(100, 30); err != nil {
		t.Fatalf("stage: %v", err)
	}
	// Output waits for the staged commit.
	if _, err := j.appendPayload([]byte("held")); !errors.Is(err, errResizeStaged) {
		t.Fatalf("append during stage: got %v, want errResizeStaged", err)
	}
	m, err := j.commitResize()
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if m.AtSeq != uint64(len("before")) || m.Cols != 100 || m.Rows != 30 || m.ordinal != 1 {
		t.Fatalf("committed marker: %+v", m)
	}
	if _, err := j.appendPayload([]byte("after")); err != nil {
		t.Fatalf("append after commit: %v", err)
	}
	// A failed physical step abandons only the uncommitted stage.
	if err := j.stageResize(120, 40); err != nil {
		t.Fatalf("stage 2: %v", err)
	}
	if err := j.abandonStaged(); err != nil {
		t.Fatalf("abandon: %v", err)
	}
	if j.nextOrdinal != 2 || len(j.resizes) != 1 {
		t.Fatalf("abandon left ordinal=%d markers=%d", j.nextOrdinal, len(j.resizes))
	}
	data, markers, endOrdinal, err := j.readOrd(0, j.head, 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "beforeafter" || len(markers) != 1 || endOrdinal != 1 {
		t.Fatalf("read: %q markers=%d end=%d", data, len(markers), endOrdinal)
	}
}

func TestRawJournalCommitFailureUnblocksThroughAdmission(t *testing.T) {
	j := openTestRawJournal(t, "")
	if err := j.stageResize(100, 30); err != nil {
		t.Fatalf("stage: %v", err)
	}
	// The OS resize succeeded but the manifest commit failed: later output
	// waits, then the admission retry finishes the commit first.
	j.faults.manifestSync = errors.New("injected")
	if _, err := j.commitResize(); err == nil {
		t.Fatal("commit with manifest fault must fail")
	}
	j.faults.manifestSync = nil
	applied, err := j.appendPayload([]byte("output"))
	if err != nil {
		t.Fatalf("append after failed commit: %v", err)
	}
	if len(applied) != 1 || applied[0].ordinal != 1 || applied[0].Cols != 100 {
		t.Fatalf("applied markers: %+v", applied)
	}
	if j.staged != nil || j.head != uint64(len("output")) {
		t.Fatalf("staged=%v head=%d", j.staged != nil, j.head)
	}
}

func TestRawJournalInitialGeometry(t *testing.T) {
	dir := t.TempDir()
	if _, err := openRawJournal(dir, 0, 24, nil); err == nil {
		t.Fatal("zero initial cols must fail")
	}
	j, err := openRawJournal(dir, 132, 43, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cols, rows := j.initialGeometry()
	if cols != 132 || rows != 43 {
		t.Fatalf("initial geometry = %dx%d", cols, rows)
	}
	j.close()
	// Reopen keeps the manifest baseline, not the passed dimensions.
	r, err := openRawJournal(dir, 80, 24, nil)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer r.close()
	cols, rows = r.initialGeometry()
	if cols != 132 || rows != 43 {
		t.Fatalf("reopened geometry = %dx%d", cols, rows)
	}
}

func TestRawJournalCursorFiltering(t *testing.T) {
	j := openTestRawJournal(t, "")
	if _, err := j.appendPayload([]byte("aa")); err != nil {
		t.Fatalf("append: %v", err)
	}
	for _, size := range [][2]uint16{{100, 30}, {120, 40}} {
		if err := j.stageResize(size[0], size[1]); err != nil {
			t.Fatalf("stage: %v", err)
		}
		if _, err := j.commitResize(); err != nil {
			t.Fatalf("commit: %v", err)
		}
	}
	if _, err := j.appendPayload([]byte("bb")); err != nil {
		t.Fatalf("append: %v", err)
	}
	// Same-position markers stay distinct and apply exactly once.
	_, first, end1, err := j.readOrd(0, 2, 0)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first) != 2 || end1 != 2 {
		t.Fatalf("first page: %d markers end %d", len(first), end1)
	}
	data, second, end2, err := j.readOrd(2, 4, end1)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if string(data) != "bb" || len(second) != 0 || end2 != end1 {
		t.Fatalf("second page: %q markers=%d end=%d", data, len(second), end2)
	}
	if _, _, _, err := j.readOrd(0, j.head, 99); err == nil {
		t.Fatal("future ordinal must fail")
	}
}

func TestRawJournalPageMarkerCap(t *testing.T) {
	j := openTestRawJournal(t, "")
	if _, err := j.appendPayload([]byte("xx")); err != nil {
		t.Fatalf("append: %v", err)
	}
	for i := 0; i < rawPageMaxMarkers+10; i++ {
		if err := j.stageResize(uint16(80+i%50), 24); err != nil {
			t.Fatalf("stage %d: %v", i, err)
		}
		if _, err := j.commitResize(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
	}
	if _, err := j.appendPayload([]byte("yy")); err != nil {
		t.Fatalf("append: %v", err)
	}
	// All markers sit at byte 2 with output after them: the page carries
	// the capped markers plus the bytes before them, stopping before the
	// output that follows the first omitted marker.
	data, markers, endOrdinal, err := j.readOrd(0, j.head, 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "xx" || len(markers) != rawPageMaxMarkers || endOrdinal != rawPageMaxMarkers {
		t.Fatalf("capped page: bytes=%q markers=%d end=%d", data, len(markers), endOrdinal)
	}
	nextFrom := uint64(len(data))
	data, markers, endOrdinal, err = j.readOrd(nextFrom, j.head, endOrdinal)
	if err != nil {
		t.Fatalf("read 2: %v", err)
	}
	// Ten markers remain at byte 2; all fit, so the trailing bytes flow.
	if len(markers) != 10 || string(data) != "yy" {
		t.Fatalf("second page: bytes=%q markers=%d", data, len(markers))
	}
	if endOrdinal != rawPageMaxMarkers+10 {
		t.Fatalf("end ordinal = %d", endOrdinal)
	}
}

func TestRawJournalPageShrinksBeforeOmittedMarker(t *testing.T) {
	j := openTestRawJournal(t, "")
	if _, err := j.appendPayload([]byte("a")); err != nil {
		t.Fatalf("append: %v", err)
	}
	// Markers spread across positions with output between them: an
	// over-full page must stop before output following an omitted marker.
	for i := 0; i < rawPageMaxMarkers+5; i++ {
		if err := j.stageResize(uint16(80+i%50), 24); err != nil {
			t.Fatalf("stage %d: %v", i, err)
		}
		if _, err := j.commitResize(); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
		if _, err := j.appendPayload([]byte("b")); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	data, markers, endOrdinal, err := j.readOrd(0, j.head, 0)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(markers) != rawPageMaxMarkers {
		t.Fatalf("markers = %d", len(markers))
	}
	// The page stops at the first omitted marker's bytes: byte 1 + 256.
	if len(data) != 1+rawPageMaxMarkers || endOrdinal != rawPageMaxMarkers {
		t.Fatalf("shrunk page: bytes=%d end=%d", len(data), endOrdinal)
	}
	rest, markers2, end2, err := j.readOrd(uint64(len(data)), j.head, endOrdinal)
	if err != nil {
		t.Fatalf("read 2: %v", err)
	}
	if len(markers2) != 5 || len(rest) != 5 {
		t.Fatalf("second page: bytes=%d markers=%d", len(rest), len(markers2))
	}
	if end2 != rawPageMaxMarkers+5 {
		t.Fatalf("end ordinal = %d", end2)
	}
}

func TestRawJournalEphemeral(t *testing.T) {
	j, err := openRawJournal("", 80, 24, nil)
	if err != nil {
		t.Fatalf("open ephemeral: %v", err)
	}
	defer j.close()
	if !j.ephemeral {
		t.Fatal("empty dir must request ephemeral storage")
	}
	if _, err := j.appendPayload([]byte("data")); err != nil {
		t.Fatalf("append: %v", err)
	}
	st := j.stats()
	if st.head != 4 || st.chunks != 1 || !st.ephemeral {
		t.Fatalf("stats: %+v", st)
	}
	// Nothing reads an ephemeral manifest, so writing one per flush is
	// pure overhead.
	if _, err := os.Stat(filepath.Join(j.dir, "MANIFEST")); !os.IsNotExist(err) {
		t.Fatalf("ephemeral journal wrote a manifest: %v", err)
	}
}

func BenchmarkRawJournalAppend32K(b *testing.B) {
	dir := b.TempDir()
	j, err := openRawJournal(dir, 80, 24, nil)
	if err != nil {
		b.Fatalf("openRawJournal: %v", err)
	}
	defer j.close()
	payload := make([]byte, 32*1024)
	for i := range payload {
		payload[i] = byte(i)
	}
	b.SetBytes(int64(len(payload)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := j.appendPayload(payload); err != nil {
			b.Fatalf("append: %v", err)
		}
	}
}

func TestRawJournalCloseLifecycle(t *testing.T) {
	j := openTestRawJournal(t, "")
	if err := j.markOpen(); err != nil {
		t.Fatalf("markOpen on live journal: %v", err)
	}
	now := time.Now().UnixNano()
	if err := j.markClosed(now); err != nil {
		t.Fatalf("markClosed: %v", err)
	}
	if j.closedAtNs != now || j.flags&rawFlagClosed == 0 {
		t.Fatal("closure not recorded")
	}
	if err := j.markOpen(); err != nil {
		t.Fatalf("markOpen: %v", err)
	}
	if j.flags&rawFlagClosed != 0 || j.closedAtNs != 0 {
		t.Fatal("reopen did not clear closure")
	}
	if err := j.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := j.appendPayload([]byte("x")); !errors.Is(err, errRawJournalClosed) {
		t.Fatalf("append after close: %v", err)
	}
}
