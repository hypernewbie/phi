package ws

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRetentionPendingPayloadSurvivesInterveningResize(t *testing.T) {
	perCommitDurability(t)
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.recording.faults.dirSync = fmt.Errorf("injected dirSync failure")
	payload := []byte("0123456789abcdef")
	if err := h.Ingest("p", payload); err == nil {
		t.Fatal("dirSync fault admitted bytes")
	}
	// A resize arriving while the payload is pending must not wedge the
	// pane: the retry resolves the payload first and journals the resize
	// on the next call.
	h.RecordResize("p", 100, 30)
	if err := h.Ingest("p", payload); err != nil {
		t.Fatalf("payload retry after resize err = %v, want nil (wedged)", err)
	}
	want := "seed0123456789abcdef"
	data, _, err := ph.recording.read(0, uint64(len(want)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Fatalf("journal bytes = %q, want %q", data, want)
	}
	ph.mu.Lock()
	stillPending := ph.pendingResize != nil
	ph.mu.Unlock()
	if !stillPending {
		t.Fatal("resize should defer one Ingest after payload resolution")
	}
	if err := h.Ingest("p", []byte("next")); err != nil {
		t.Fatal(err)
	}
	last, ok := ph.recording.lastResize()
	if !ok || last.Cols != 100 || last.Rows != 30 {
		t.Fatalf("last resize = %+v, want 100x30", last)
	}
	if last.AtSeq != uint64(len(want)) {
		t.Fatalf("resize AtSeq = %d, want %d (after the resolved payload)", last.AtSeq, len(want))
	}
	if got := ph.recording.head; got != uint64(len(want)+4) {
		t.Fatalf("head = %d, want %d (no duplicate admission)", got, len(want)+4)
	}
}

func TestReadRetentionManifestIsBoundedAndRegular(t *testing.T) {
	dir := t.TempDir()
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); !os.IsNotExist(err) {
		t.Fatalf("missing manifest err = %v, want IsNotExist (fresh-group path)", err)
	}
	if err := os.Mkdir(filepath.Join(dir, "grp"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "grp")); err == nil {
		t.Fatal("directory manifest should reject")
	}
	atCap := bytes.Repeat([]byte("m"), retentionManifestMax)
	if err := os.WriteFile(filepath.Join(dir, "MANIFEST"), atCap, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); err != nil {
		t.Fatalf("64KiB manifest read err = %v, want nil", err)
	}
	over := bytes.Repeat([]byte("m"), retentionManifestMax+1)
	if err := os.WriteFile(filepath.Join(dir, "MANIFEST"), over, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "MANIFEST")); err == nil {
		t.Fatal("oversized manifest should reject before decode")
	}
	if _, err := openRetentionGroup(dir); err == nil {
		t.Fatal("open with oversized manifest should fail")
	}
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privilege on windows")
	}
	if err := os.Symlink("MANIFEST", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := readRetentionManifest(filepath.Join(dir, "link")); err == nil {
		t.Fatal("symlink manifest should reject")
	}
}

func TestRetentionGiantPayloadRetryUsesAdmissionIdentity(t *testing.T) {
	giant := bytes.Repeat([]byte("g"), retentionSegRawMax+65536)
	newGroup := func(t *testing.T) (*Hub, *PaneHub) {
		h := NewHub(0)
		t.Cleanup(func() { _ = h.Close() })
		if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
			t.Fatal(err)
		}
		if err := h.Ingest("p", []byte("seed")); err != nil {
			t.Fatal(err)
		}
		ph, _ := h.LookupPane("p")
		ph.recording.faults.dirSync = fmt.Errorf("injected dirSync failure")
		if err := h.Ingest("p", giant); err == nil {
			t.Fatal("dirSync fault admitted giant bytes")
		}
		return h, ph
	}
	// An identical whole-payload retry resolves the pending giant commit.
	h, ph := newGroup(t)
	if err := h.Ingest("p", giant); err != nil {
		t.Fatalf("giant retry err = %v, want nil", err)
	}
	wantHead := uint64(len("seed") + len(giant))
	if ph.recording.head != wantHead {
		t.Fatalf("head = %d, want %d", ph.recording.head, wantHead)
	}
	floor := wantHead - (1 << 20)
	data, _, err := ph.recording.read(floor, wantHead)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, giant[len(giant)-1<<20:]) {
		t.Fatal("giant retry kept the wrong suffix")
	}
	// Presenting only the retained suffix must not resolve it.
	_, ph2 := newGroup(t)
	suffix := giant[len(giant)-retentionSegRawMax:]
	if _, err := ph2.recording.appendPayload(suffix, ph2.snapshotBaseLocked); !errors.Is(err, errPendingTransaction) {
		t.Fatalf("suffix-only retry err = %v, want errPendingTransaction", err)
	}
}

func TestOpenRejectsSymlinkedSegmentFile(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("hello\r\n")); err != nil {
		t.Fatal(err)
	}
	group := h.recordingPath("p")
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(external, bytes.Repeat([]byte("V"), 4096), 0600); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(mustRead(t, external))
	link := filepath.Join(group, "s0000000000000001.raw")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, link); err != nil {
		t.Fatal(err)
	}
	if _, err := openRetentionGroup(group); err == nil {
		t.Fatal("open followed a symlinked segment file")
	}
	if sha256.Sum256(mustRead(t, external)) != before {
		t.Fatal("recovery mutated through the symlink")
	}
}

func TestCommitRejectsSymlinkedNextSegment(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", bytes.Repeat([]byte("f"), retentionSegNominal)); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(external, bytes.Repeat([]byte("V"), 4096), 0600); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(mustRead(t, external))
	if err := os.Symlink(external, filepath.Join(h.recordingPath("p"), "s0000000000000002.raw")); err != nil {
		t.Fatal(err)
	}
	// This byte rotates into generation 2: the commit must fail closed
	// instead of truncating through the planted link.
	if err := h.Ingest("p", []byte("x")); err == nil {
		t.Fatal("commit truncated through a symlinked segment file")
	}
	if sha256.Sum256(mustRead(t, external)) != before {
		t.Fatal("commit mutated through the symlink")
	}
}

func TestRetentionPayloadCommitFailuresRetryExactlyOnce(t *testing.T) {
	perCommitDurability(t)
	stages := []struct {
		name string
		set  func(*retentionFaults, error)
	}{
		{"rawSync", func(f *retentionFaults, err error) { f.rawSync = err }},
		{"manifestSync", func(f *retentionFaults, err error) { f.manifestSync = err }},
		{"rename", func(f *retentionFaults, err error) { f.rename = err }},
		{"dirSync", func(f *retentionFaults, err error) { f.dirSync = err }},
	}
	for _, stage := range stages {
		t.Run(stage.name, func(t *testing.T) {
			dir := t.TempDir()
			h := NewHub(0)
			t.Cleanup(func() { _ = h.Close() })
			if err := h.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			if err := h.Ingest("p", []byte("seed")); err != nil {
				t.Fatal(err)
			}
			ph, _ := h.LookupPane("p")
			injected := fmt.Errorf("injected %s failure", stage.name)
			stage.set(&ph.recording.faults, injected)
			payload := []byte("0123456789abcdef")
			if err := h.Ingest("p", payload); err == nil {
				t.Fatalf("%s fault admitted bytes", stage.name)
			}
			ph.mu.Lock()
			total, head := ph.total, ph.recording.head
			ph.mu.Unlock()
			if total != 4 || head != 4 {
				t.Fatalf("%s failure advanced frontier to %d/%d", stage.name, total, head)
			}
			rec, ok := h.Recording("p", 0, 4)
			if !ok || !bytes.Equal(rec.Data, []byte("seed")) {
				t.Fatalf("%s failure lost prior authority", stage.name)
			}
			// The PTY loop retries the complete payload. The retry must
			// produce exactly one admission, never a duplicate.
			if err := h.Ingest("p", payload); err != nil {
				t.Fatalf("%s retry: %v", stage.name, err)
			}
			rec, ok = h.Recording("p", 0, 20)
			if !ok || !bytes.Equal(rec.Data, []byte("seed0123456789abcdef")) {
				t.Fatalf("%s retry bytes=%q ok=%t", stage.name, rec.Data, ok)
			}
			if stage.name == "rename" {
				// No resizes and no rotation: exactly the manifest and
				// one raw file. A failed rename must not leave a temp
				// manifest or staged generations behind.
				var files []string
				if err := filepath.WalkDir(h.recordingPath("p"), func(path string, entry os.DirEntry, err error) error {
					if err != nil {
						return err
					}
					if !entry.IsDir() {
						files = append(files, filepath.Base(path))
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				if len(files) != 2 || files[0] != "MANIFEST" || files[1] != "s0000000000000001.raw" {
					t.Fatalf("failed rename accumulated temp files: %v", files)
				}
			}
			// Reopening proves the manifest references only complete
			// dependencies.
			if err := h.Close(); err != nil {
				t.Fatal(err)
			}
			second := NewHub(0)
			t.Cleanup(func() { _ = second.Close() })
			if err := second.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			rec, ok = second.Recording("p", 0, 20)
			if !ok || !bytes.Equal(rec.Data, []byte("seed0123456789abcdef")) {
				t.Fatalf("%s reopen bytes=%q ok=%t", stage.name, rec.Data, ok)
			}
		})
	}
}

func TestRetentionPendingPayloadRejectsDifferentPayload(t *testing.T) {
	perCommitDurability(t)
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.recording.faults.dirSync = fmt.Errorf("injected dir sync failure")
	first := []byte("AAAAAAAAAAAAAAAA")
	if err := h.Ingest("p", first); err == nil {
		t.Fatal("dir sync fault admitted bytes")
	}
	// A different payload cannot receive the pending acknowledgement.
	second := []byte("BBBBBBBBBBBBBBBB")
	if err := h.Ingest("p", second); !errors.Is(err, errPendingTransaction) {
		t.Fatalf("different payload during pending: %v", err)
	}
	ph.mu.Lock()
	total := ph.total
	ph.mu.Unlock()
	if total != 4 {
		t.Fatalf("pending transaction advanced frontier to %d", total)
	}
	if err := h.Ingest("p", first); err != nil {
		t.Fatalf("identical retry: %v", err)
	}
	if err := h.Ingest("p", second); err != nil {
		t.Fatalf("later payload: %v", err)
	}
	rec, ok := h.Recording("p", 0, 36)
	if !ok || !bytes.Equal(rec.Data, []byte("seedAAAAAAAAAAAAAAAA"+"BBBBBBBBBBBBBBBB")) {
		t.Fatalf("pending bytes=%q ok=%t", rec.Data, ok)
	}
}

func TestRetentionPendingPayloadReopenAcceptsVisibleManifest(t *testing.T) {
	perCommitDurability(t)
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.recording.faults.dirSync = fmt.Errorf("injected dir sync failure")
	if err := h.Ingest("p", []byte("visible-payload!")); err == nil {
		t.Fatal("dir sync fault admitted bytes")
	}
	// The rename succeeded, so the new manifest is visible. Reopening
	// accepts that complete valid manifest with its dependencies.
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	rec, ok := second.Recording("p", 0, 20)
	if !ok || !bytes.Equal(rec.Data, []byte("seedvisible-payload!")) {
		t.Fatalf("reopen after pending bytes=%q ok=%t", rec.Data, ok)
	}
}

func TestRetentionResizeCommitFailuresRetryWithoutDuplicates(t *testing.T) {
	perCommitDurability(t)
	stages := []struct {
		name string
		set  func(*retentionFaults, error)
	}{
		{"rszSync", func(f *retentionFaults, err error) { f.rszSync = err }},
		{"manifestSync", func(f *retentionFaults, err error) { f.manifestSync = err }},
		{"rename", func(f *retentionFaults, err error) { f.rename = err }},
		{"dirSync", func(f *retentionFaults, err error) { f.dirSync = err }},
	}
	for _, stage := range stages {
		t.Run(stage.name, func(t *testing.T) {
			h := NewHub(0)
			t.Cleanup(func() { _ = h.Close() })
			// A durable group: the manifest write is what the manifest,
			// rename and directory-sync faults act on. An ephemeral group
			// has no manifest, so it cannot fail those.
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatal(err)
			}
			h.RecordResize("p", 80, 24)
			if err := h.Ingest("p", []byte("before")); err != nil {
				t.Fatal(err)
			}
			ph, _ := h.LookupPane("p")
			stage.set(&ph.recording.faults, fmt.Errorf("injected %s failure", stage.name))
			h.RecordResize("p", 100, 40)
			if ph.pendingResize == nil {
				t.Fatalf("%s failure was not retained for retry", stage.name)
			}
			if err := h.Ingest("p", []byte("after")); err != nil {
				t.Fatalf("%s retry: %v", stage.name, err)
			}
			rec, ok := h.Recording("p", 0, 100)
			if !ok {
				t.Fatalf("%s lost recording", stage.name)
			}
			want := []ResizeMarker{{AtSeq: 0, Cols: 80, Rows: 24}, {AtSeq: 6, Cols: 100, Rows: 40}}
			if len(rec.Resizes) != len(want) {
				t.Fatalf("%s markers=%+v", stage.name, rec.Resizes)
			}
			for i := range want {
				if rec.Resizes[i] != want[i] {
					t.Fatalf("%s markers=%+v", stage.name, rec.Resizes)
				}
			}
		})
	}
}

func TestRetentionRotationCheckpointSyncFailureRetriesCleanly(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 32; i++ {
		if err := h.Ingest("p", bytes.Repeat([]byte("r"), 32*1024)); err != nil {
			t.Fatal(err)
		}
	}
	ph, _ := h.LookupPane("p")
	ph.recording.faults.ckptSync = fmt.Errorf("injected checkpoint sync failure")
	if err := h.Ingest("p", []byte("Z")); err == nil {
		t.Fatal("checkpoint sync fault admitted bytes")
	}
	ph.mu.Lock()
	segs, head := len(ph.recording.segs), ph.recording.head
	ph.mu.Unlock()
	if segs != 1 || head != 1<<20 {
		t.Fatalf("failed rotation published segs=%d head=%d", segs, head)
	}
	if err := h.Ingest("p", []byte("Z")); err != nil {
		t.Fatalf("rotation retry: %v", err)
	}
	ph.mu.Lock()
	segs, head = len(ph.recording.segs), ph.recording.head
	ckptLen := ph.recording.segs[1].ckptLen
	ph.mu.Unlock()
	if segs != 2 || head != (1<<20)+1 || ckptLen == 0 {
		t.Fatalf("rotation retry segs=%d head=%d ckpt=%d", segs, head, ckptLen)
	}
	rec, ok := h.Recording("p", 0, head)
	want := append(bytes.Repeat([]byte("r"), (1<<20)-1), 'Z')
	if !ok || rec.Start != 1 || !bytes.Equal(rec.Data, want) {
		t.Fatalf("rotation retry start=%d bytes=%d ok=%t", rec.Start, len(rec.Data), ok)
	}
	var files []string
	if err := filepath.WalkDir(h.recordingPath("p"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			files = append(files, filepath.Base(path))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// One manifest, two raw files, one resize file (no resizes were
	// recorded in the first segment), one checkpoint. The failed
	// rotation must not accumulate staged generations.
	wantFiles := []string{"MANIFEST", "s0000000000000001.raw", "s0000000000000002.ckpt", "s0000000000000002.raw", "s0000000000000002.rsz"}
	if len(files) != len(wantFiles) {
		t.Fatalf("failed rotation accumulated files=%v", files)
	}
	for i := range wantFiles {
		if files[i] != wantFiles[i] {
			t.Fatalf("failed rotation accumulated files=%v", files)
		}
	}
}

func TestRetentionOversizedBaseKeepsLiveOutputAndFailsRestorationExplicitly(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("live output continues\r\n"), 1600)
	for i := 0; i < 32; i++ {
		if err := h.Ingest("p", chunk[:32*1024]); err != nil {
			t.Fatal(err)
		}
	}
	ph, _ := h.LookupPane("p")
	// Shrink the checkpoint cap so the next rotation cannot store its
	// base. Live output must continue regardless.
	ph.recording.ckptMax = 64
	for i := 0; i < 32; i++ {
		if err := h.Ingest("p", chunk[:32*1024]); err != nil {
			t.Fatalf("oversized base stalled live output: %v", err)
		}
	}
	ph.recording.ckptMax = retentionCkptMax
	if err := h.Ingest("p", chunk[:32*1024]); err != nil {
		t.Fatalf("later output: %v", err)
	}
	ph.mu.Lock()
	segs := append([]retentionSeg(nil), ph.recording.segs...)
	epoch, head := ph.epoch, ph.total
	ph.mu.Unlock()
	if len(segs) != 2 || segs[0].ckptLen != 0 || segs[1].ckptLen == 0 {
		t.Fatalf("base availability segs=%+v", segs)
	}
	// The head sits in the based segment, so live state reconstructs.
	if _, _, _, _, err := h.State("p"); err != nil {
		t.Fatalf("live state with valid newer base: %v", err)
	}
	// The unbased middle range has no usable base and no prefix: the
	// request fails explicitly instead of guessing from zero.
	mid := segs[0].start + segs[0].rawLen/2
	if _, _, _, _, err := h.HistoricalState("p", epoch, mid); !errors.Is(err, ErrStatePositionMismatch) {
		t.Fatalf("unbased range state: %v", err)
	}
	if _, _, _, _, err := h.HistoricalState("p", epoch, head); err != nil {
		t.Fatalf("based range state: %v", err)
	}
}

func TestRetentionResizeExhaustionRotatesAndKeepsExactOrder(t *testing.T) {
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	// A small head keeps live-parser resizes fast; the pressure under
	// test is resize metadata, not raw bytes.
	if err := h.Ingest("p", bytes.Repeat([]byte("output\r\n"), 512)); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	head := ph.total
	ph.mu.Unlock()
	const rounds = 3
	const perRound = 4097
	geo := func(n int) uint16 { return 80 + uint16(n%2) }
	for r := 0; r < rounds; r++ {
		for i := 0; i < perRound; i++ {
			h.RecordResize("p", geo(r*perRound+i), 24)
		}
	}
	ph.mu.Lock()
	segs := append([]retentionSeg(nil), ph.recording.segs...)
	floor := ph.recording.floor()
	ordinalOK := len(segs) == 2 && segs[1].startOrdinal == segs[0].startOrdinal+uint64(segs[0].rszCount)
	ph.mu.Unlock()
	if ph.total != head {
		t.Fatalf("resizes advanced head to %d", ph.total)
	}
	// Three forced rotations evicted every raw byte; the floor honestly
	// reports the empty window instead of promising lost history.
	if floor != head {
		t.Fatalf("floor=%d head=%d after resize exhaustion", floor, head)
	}
	if !ordinalOK {
		t.Fatalf("resize ordinals not dense across rotation: %+v", segs)
	}
	rec, ok := h.Recording("p", head, head)
	if !ok {
		t.Fatal("lost recording after resize exhaustion")
	}
	var retained int
	for _, s := range segs {
		retained += int(s.rszCount)
	}
	evicted := rounds*perRound - retained
	var want []ResizeMarker
	for n := evicted; n < rounds*perRound; n++ {
		want = append(want, ResizeMarker{AtSeq: head, Cols: geo(n), Rows: 24})
	}
	if len(rec.Resizes) != len(want) {
		t.Fatalf("retained markers=%d want %d", len(rec.Resizes), len(want))
	}
	for i := range want {
		if rec.Resizes[i] != want[i] {
			t.Fatalf("marker %d=%+v want %+v", i, rec.Resizes[i], want[i])
		}
	}
	for _, s := range segs {
		if s.rszCount > retentionRszMaxCount {
			t.Fatalf("segment resize count=%d", s.rszCount)
		}
		info, err := s.rsz.Stat()
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() > retentionRszMaxBytes {
			t.Fatalf("resize file=%d bytes", info.Size())
		}
	}
}

func TestRetentionOpenRecoversStagedAndTornTails(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("seed-data")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	groupDir := ph.recording.dir
	gen := ph.recording.segs[0].gen
	nextGen := ph.recording.nextGen
	ph.mu.Unlock()
	rawPath := filepath.Join(groupDir, retentionSegBase(gen)+".raw")
	f, err := os.OpenFile(rawPath, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(bytes.Repeat([]byte("T"), 100)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(groupDir, "MANIFEST.tmp"), []byte("torn"), 0600); err != nil {
		t.Fatal(err)
	}
	staged := retentionSegBase(nextGen)
	for _, suffix := range []string{".raw", ".rsz", ".ckpt"} {
		if err := os.WriteFile(filepath.Join(groupDir, staged+suffix), []byte("staged"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	rec, ok := second.Recording("p", 0, 9)
	if !ok || !bytes.Equal(rec.Data, []byte("seed-data")) {
		t.Fatalf("reopen bytes=%q ok=%t", rec.Data, ok)
	}
	info, err := os.Stat(rawPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 9 {
		t.Fatalf("torn tail not truncated: size=%d", info.Size())
	}
	var names []string
	if err := filepath.WalkDir(groupDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			names = append(names, filepath.Base(path))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(names) != 3 {
		t.Fatalf("staged files not swept: %v", names)
	}
}

func TestRetentionOpenFailsClosedOnShortOrCorruptState(t *testing.T) {
	t.Run("short raw file", func(t *testing.T) {
		dir := t.TempDir()
		h := NewHub(0)
		if err := h.SetRecordingDirectory(dir); err != nil {
			t.Fatal(err)
		}
		if err := h.Ingest("p", []byte("committed")); err != nil {
			t.Fatal(err)
		}
		groupDir := h.recordingPath("p")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
		rawPath := filepath.Join(groupDir, retentionSegBase(1)+".raw")
		before, err := os.ReadFile(rawPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(rawPath, 4); err != nil {
			t.Fatal(err)
		}
		if _, err := openRetentionGroup(groupDir); err == nil {
			t.Fatal("short committed raw opened as valid")
		}
		after, err := os.ReadFile(rawPath)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(after, before[:4]) {
			t.Fatal("failed open altered committed bytes")
		}
		second := NewHub(0)
		t.Cleanup(func() { _ = second.Close() })
		if err := second.SetRecordingDirectory(dir); err != nil {
			t.Fatal(err)
		}
		if _, ok := second.Recording("p", 0, 9); ok {
			t.Fatal("short committed raw readable")
		}
	})
	t.Run("missing checkpoint", func(t *testing.T) {
		dir := t.TempDir()
		h := NewHub(0)
		if err := h.SetRecordingDirectory(dir); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 33; i++ {
			if err := h.Ingest("p", bytes.Repeat([]byte("r"), 32*1024)); err != nil {
				t.Fatal(err)
			}
		}
		groupDir := h.recordingPath("p")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
		ckptPath := filepath.Join(groupDir, retentionSegBase(2)+".ckpt")
		if _, err := os.Stat(ckptPath); err != nil {
			t.Fatalf("rotation did not store a base: %v", err)
		}
		if err := os.Remove(ckptPath); err != nil {
			t.Fatal(err)
		}
		if _, err := openRetentionGroup(groupDir); err == nil {
			t.Fatal("missing committed checkpoint opened as valid")
		}
	})
	t.Run("segments without manifest", func(t *testing.T) {
		dir := t.TempDir()
		h := NewHub(0)
		if err := h.SetRecordingDirectory(dir); err != nil {
			t.Fatal(err)
		}
		if err := h.Ingest("p", []byte("seed")); err != nil {
			t.Fatal(err)
		}
		groupDir := h.recordingPath("p")
		if err := h.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(groupDir, "MANIFEST")); err != nil {
			t.Fatal(err)
		}
		if _, err := openRetentionGroup(groupDir); err == nil {
			t.Fatal("segments without manifest opened as valid")
		}
	})
}

func TestRetentionEphemeralGroupDeletedOnClose(t *testing.T) {
	h := NewHub(0)
	if err := h.Ingest("p", []byte("temporary")); err != nil {
		t.Fatal(err)
	}
	rec, ok := h.Recording("p", 0, 9)
	if !ok || !bytes.Equal(rec.Data, []byte("temporary")) {
		t.Fatalf("ephemeral bytes=%q ok=%t", rec.Data, ok)
	}
	ph, _ := h.LookupPane("p")
	ph.mu.Lock()
	groupDir := ph.recording.dir
	ephemeral := ph.recording.ephemeral
	ph.mu.Unlock()
	if !ephemeral {
		t.Fatal("expected an ephemeral group without a recording directory")
	}
	if _, err := os.Stat(groupDir); err != nil {
		t.Fatal("ephemeral group missing before close")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(groupDir); !os.IsNotExist(err) {
		t.Fatalf("ephemeral group survived close: %v", err)
	}
}
