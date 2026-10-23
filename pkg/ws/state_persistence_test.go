package ws

import (
	"bytes"
	"github.com/hypernewbie/phi/internal/termstate"
	"os"
	"path/filepath"
	"testing"
)

func TestPersistentStateAnchorsMakeRestartAttachIndependentOfHistoryLength(t *testing.T) {
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
	path := first.recordingPath("long-session") + ".state"
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("state file permissions %o", info.Mode().Perm())
	}
	if info.Size() >= int64(len(source)/20) {
		t.Fatalf("parser checkpoints grew with transcript: %d for %d source bytes", info.Size(), len(source))
	}

	// A new hub models a server restart. It loads the atomic checkpoint index,
	// restores the nearest exact parser state and reads only the uncheckpointed
	// journal tail. The raw recording remains byte-identical and authoritative.
	second := NewHub(4096)
	if err = second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	newPos, newState, _, _, err := second.State("long-session")
	if err != nil {
		t.Fatal(err)
	}
	owner := second.GetOrCreatePaneHub("long-session")
	if owner == nil {
		t.Fatal("restart did not publish the recorded pane")
	}
	owner.mu.Lock()
	tail := owner.total - owner.stateHead
	owner.mu.Unlock()
	if tail > stateAnchorInterval {
		t.Fatalf("server restart replayed more than the bounded journal tail: %d", tail)
	}
	second.ClosePane("long-session")
	owner.mu.Lock()
	released := owner.state == nil && len(owner.stateAnchors) == 0 && !owner.stateAnchorsLoaded
	owner.mu.Unlock()
	if !released {
		t.Fatal("closed pane retained native parser/checkpoint memory")
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
	got, ok := second.Recording("long-session", 0, uint64(len(source)))
	if !ok || !bytes.Equal(got.Data, source) {
		t.Fatal("restart lost authoritative source bytes")
	}
	if len(got.Data) != len(source) {
		t.Fatal("recording range was truncated")
	}

	// Corrupt acceleration metadata must not alter the source recording. The
	// next state request falls back to an exact replay, not silent truncation.
	if err = os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.RemoveAll(path + ".d"); err != nil {
		t.Fatal(err)
	}
	third := NewHub(4096)
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
		t.Fatal("bad acceleration metadata damaged recoverable terminal state")
	}
	if _, err = os.Stat(filepath.Clean(path)); err != nil {
		t.Fatal(err)
	}
}
