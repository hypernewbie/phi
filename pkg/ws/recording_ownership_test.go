package ws

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestRecordingCorruptMiddleAndTornTailPreservesCommittedSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recording")
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.file.Close()
	if err := r.append(1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	middle := r.offset
	if err := r.append(1, []byte("second committed")); err != nil {
		t.Fatal(err)
	}
	if err := r.append(1, []byte("third committed")); err != nil {
		t.Fatal(err)
	}
	var invalid [4]byte
	binary.BigEndian.PutUint32(invalid[:], 65*1024*1024)
	if _, err := r.file.WriteAt(invalid[:], middle+1); err != nil {
		t.Fatal(err)
	}
	if _, err := r.file.WriteAt([]byte{1, 0}, r.offset); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reopened, openErr := openRecording(path)
	if reopened != nil {
		defer reopened.file.Close()
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if openErr == nil {
		t.Error("corrupt middle and torn tail must fail closed")
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("cold recovery deleted %d bytes including the committed suffix", len(before)-len(after))
	}
}

func TestRecordingConcurrentColdReadersCannotTruncateLiveWriter(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	if err := h.InitPaneJournal("pane", 80, 24); err != nil {
		t.Fatal(err)
	}
	const count = 150000
	if err := h.Ingest("pane", bytes.Repeat([]byte("X"), count)); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	// Promote back to live; readers use the promoted epoch.
	if err := h.Ingest("pane", []byte("PROMOTE")); err != nil {
		t.Fatal(err)
	}
	ph, ok := h.LookupPane("pane")
	if !ok {
		t.Fatal("pane missing after promotion")
	}
	epoch := ph.EpochOf()
	// Replay and Ingest serialize on the pane mutex, so every
	// concurrent read is an exact prefix of the final stream.
	reads := make(chan []byte, 24*20)
	errs := make(chan error, 24*20)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				page, err := h.Replay("pane", ReplayRequest{Epoch: epoch, From: 0, Latest: true})
				if err != nil {
					errs <- err
					return
				}
				reads <- page.Data
			}
		}()
	}
	payload := bytes.Repeat([]byte("N"), 4096)
	const writes = 128
	for i := 0; i < writes; i++ {
		if err := h.Ingest("pane", payload); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent replay: %v", err)
	}
	close(reads)
	final, err := h.Replay("pane", ReplayRequest{Epoch: epoch, From: 0, Latest: true})
	if err != nil {
		t.Fatal(err)
	}
	want := append(append(bytes.Repeat([]byte("X"), count), []byte("PROMOTE")...), bytes.Repeat([]byte("N"), 4096*writes)...)
	if !bytes.Equal(final.Data, want) {
		t.Fatalf("final replay has %d bytes, want %d", len(final.Data), len(want))
	}
	for r := range reads {
		if !bytes.Equal(r, want[:len(r)]) {
			t.Fatal("concurrent replay was not an exact prefix of the final stream")
		}
	}
}
