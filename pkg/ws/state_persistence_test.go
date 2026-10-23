package ws

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/hypernewbie/phi/internal/termstate"
)

func TestRetentionMetadataRotationReopenAppliesTriggerResize(t *testing.T) {
	dir := t.TempDir()
	first := NewHub(0)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := first.Ingest("p", []byte("line one\r\nline two\r\n")); err != nil {
		t.Fatal(err)
	}
	// Fill the segment's resize budget, then trigger a metadata-only
	// rotation: the newest base predates the trigger, and no output
	// follows it, so reopening must apply the marker-only span.
	for i := 0; i < retentionRszMaxCount; i++ {
		if i%2 == 0 {
			first.RecordResize("p", 80, 24)
		} else {
			first.RecordResize("p", 81, 25)
		}
	}
	first.RecordResize("p", 100, 30)
	render := func(data []byte) ([]byte, []byte) {
		e, err := termstate.New(t.Context(), 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		defer e.Close()
		if err = e.Restore(data); err != nil {
			t.Fatal(err)
		}
		screen, err := e.FormatVTState()
		if err != nil {
			t.Fatal(err)
		}
		continuation, err := e.Continuation()
		if err != nil {
			t.Fatal(err)
		}
		return screen, continuation
	}
	_, liveState, liveCols, liveRows, err := first.State("p")
	if err != nil {
		t.Fatal(err)
	}
	if liveCols != 100 || liveRows != 30 {
		t.Fatalf("live geometry = %dx%d, want 100x30", liveCols, liveRows)
	}
	liveScreen, liveContinuation := render(liveState)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(0)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	_, coldState, coldCols, coldRows, err := second.State("p")
	if err != nil {
		t.Fatal(err)
	}
	if coldCols != 100 || coldRows != 30 {
		t.Fatalf("reopen geometry = %dx%d, want 100x30", coldCols, coldRows)
	}
	coldScreen, coldContinuation := render(coldState)
	if !bytes.Equal(liveScreen, coldScreen) || !bytes.Equal(liveContinuation, coldContinuation) {
		t.Fatal("reopen changed the screen or continuation across a metadata rotation")
	}
}

func TestPersistentBaseCheckpointsMakeRestartAttachIndependentOfHistoryLength(t *testing.T) {
	const capacity = 1 << 20
	dir := t.TempDir()
	first := NewHub(4096)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	var source []byte
	for i := 0; i < 80; i++ {
		chunk := bytes.Repeat([]byte("retained library page with Unicode 你🙂\r\n"), 2048)
		source = append(source, chunk...)
		if err := first.Ingest("long-session", chunk); err != nil {
			t.Fatal(err)
		}
	}
	oldPos, oldState, _, _, err := first.State("long-session")
	if err != nil {
		t.Fatal(err)
	}
	// The bounded group stays within the approved steady-state disk max
	// and keeps every file private, however long the session runs.
	var groupBytes int64
	var groupFiles int
	if err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("%s is readable by another user: %o", path, info.Mode().Perm())
		}
		if !entry.IsDir() {
			groupFiles++
			groupBytes += info.Size()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if groupBytes > 6.25*1024*1024 {
		t.Fatalf("retained group grew with transcript: %d bytes in %d files", groupBytes, groupFiles)
	}

	// A new hub models a server restart. It restores the newest retained
	// base checkpoint and replays at most one bounded segment tail. The
	// newest 1 MiB of source stays byte-identical and authoritative.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(4096)
	t.Cleanup(func() { _ = second.Close() })
	if err = second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	newPos, newState, _, _, err := second.State("long-session")
	if err != nil {
		t.Fatal(err)
	}
	owner, gerr := second.GetOrCreatePaneHub("long-session")
	if gerr != nil {
		t.Fatal(gerr)
	}
	owner.mu.Lock()
	newestBase := owner.recording.segs[len(owner.recording.segs)-1].start
	replayTail := owner.total - newestBase
	owner.mu.Unlock()
	if replayTail > retentionSegRawMax {
		t.Fatalf("server restart replays more than the bounded segment tail: %d", replayTail)
	}
	second.ClosePane("long-session")
	owner.mu.Lock()
	released := owner.state == nil && owner.recording != nil && !owner.recording.isClosed()
	owner.mu.Unlock()
	if !released {
		t.Fatal("closed pane retained native parser memory or dropped its cold group")
	}
	newPos, newState, _, _, err = second.State("long-session")
	if err != nil {
		t.Fatal(err)
	}
	render := func(data []byte) ([]byte, []byte, error) {
		e, err := termstate.New(t.Context(), 80, 24)
		if err != nil {
			return nil, nil, err
		}
		defer e.Close()
		if err = e.Restore(data); err != nil {
			return nil, nil, err
		}
		screen, err := e.FormatVTState()
		if err != nil {
			return nil, nil, err
		}
		continuation, err := e.Continuation()
		return screen, continuation, err
	}
	oldScreen, oldContinuation, err := render(oldState)
	if err != nil {
		t.Fatal(err)
	}
	newScreen, newContinuation, err := render(newState)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(oldScreen, newScreen) || !bytes.Equal(oldContinuation, newContinuation) {
		t.Fatalf("restart checkpoint changed visible terminal/parser state: screens %d/%d continuation %q/%q", len(oldScreen), len(newScreen), oldContinuation, newContinuation)
	}
	if oldPos.Head != newPos.Head || oldPos.Head != uint64(len(source)) {
		t.Fatal("restart lost recording frontier")
	}
	if newPos.Oldest != newPos.Head-capacity {
		t.Fatalf("restart floor oldest=%d head=%d", newPos.Oldest, newPos.Head)
	}
	want := source[len(source)-capacity:]
	got, ok := second.Recording("long-session", newPos.Oldest, newPos.Head)
	if !ok || !bytes.Equal(got.Data, want) {
		t.Fatal("restart lost the retained suffix")
	}
	clamped, ok := second.Recording("long-session", 0, newPos.Head)
	if !ok || clamped.Start != newPos.Oldest || !bytes.Equal(clamped.Data, want) {
		t.Fatal("evicted prefix did not clamp to the retained floor")
	}

	groupDir := second.recordingPath("long-session")
	ckptPaths := func() []string {
		owner.mu.Lock()
		defer owner.mu.Unlock()
		var out []string
		for _, s := range owner.recording.segs {
			if s.ckptLen > 0 {
				out = append(out, filepath.Join(groupDir, retentionSegBase(s.gen)+".ckpt"))
			}
		}
		return out
	}
	poison := func(path string) {
		t.Helper()
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		// Same size, unreadable contents: the manifest still verifies,
		// but the checkpoint cannot be restored.
		for i := range data {
			data[i] ^= 0xff
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	paths := ckptPaths()
	if len(paths) < 2 {
		t.Fatalf("expected two retained base checkpoints, found %d", len(paths))
	}

	// A corrupt newest base falls back to the older retained base. The
	// source recording is untouched and state still reconstructs exactly.
	poison(paths[len(paths)-1])
	// A restart test closes the first hub before the second opens the
	// same namespace, releasing the lease.
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	third := NewHub(4096)
	t.Cleanup(func() { _ = third.Close() })
	if err = third.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	_, replayed, _, _, err := third.State("long-session")
	if err != nil {
		t.Fatal(err)
	}
	replayedScreen, replayedContinuation, err := render(replayed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(oldScreen, replayedScreen) || !bytes.Equal(oldContinuation, replayedContinuation) {
		t.Fatal("bad newest base damaged recoverable terminal state")
	}
	got, ok = third.Recording("long-session", newPos.Oldest, newPos.Head)
	if !ok || !bytes.Equal(got.Data, want) {
		t.Fatal("corrupt base altered the source recording")
	}
	if err := third.Close(); err != nil {
		t.Fatal(err)
	}

	// With every base corrupt and the prefix gone, restoration must fail
	// explicitly instead of reconstructing from a blank parser.
	for _, path := range paths[:len(paths)-1] {
		poison(path)
	}
	fourth := NewHub(4096)
	t.Cleanup(func() { _ = fourth.Close() })
	if err = fourth.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := fourth.State("long-session"); !errors.Is(err, errStateBaseUnavailable) {
		t.Fatalf("all-bases-corrupt state: %v", err)
	}
	if err := fourth.Close(); err != nil {
		t.Fatal(err)
	}

	// A corrupt manifest fails the open closed: no invented frontier and
	// no deleted evidence.
	manifestPath := filepath.Join(groupDir, "MANIFEST")
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	before, err := dirSnapshot(groupDir)
	if err != nil {
		t.Fatal(err)
	}
	manifest[len(manifest)-1] ^= 0xff
	if err := os.WriteFile(manifestPath, manifest, 0600); err != nil {
		t.Fatal(err)
	}
	fifth := NewHub(4096)
	t.Cleanup(func() { _ = fifth.Close() })
	if err = fifth.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := fifth.State("long-session"); err == nil {
		t.Fatal("corrupt manifest opened as valid")
	}
	after, err := dirSnapshot(groupDir)
	if err != nil {
		t.Fatal(err)
	}
	delete(before, manifestPath)
	delete(after, manifestPath)
	if len(before) != len(after) {
		t.Fatal("failed open deleted group evidence")
	}
	for path, hash := range before {
		if after[path] != hash {
			t.Fatalf("failed open altered %s", path)
		}
	}
}

func dirSnapshot(dir string) (map[string][32]byte, error) {
	out := make(map[string][32]byte)
	var hashFile = func(path string) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out[path] = sha256.Sum256(data)
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if err := hashFile(filepath.Join(dir, entry.Name())); err != nil {
			return nil, err
		}
	}
	return out, nil
}
