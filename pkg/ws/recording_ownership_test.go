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
	const count = 150000
	initial := bytes.Repeat([]byte{1, 0, 0, 0, 1, 'X'}, count)
	if err := os.WriteFile(h.recordingPath("pane"), initial, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{}, 24)
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.Recording("pane", 0, 1)
			done <- struct{}{}
		}()
	}
	<-done
	cold := h.recordingForRead("pane")
	ph := h.GetOrCreatePaneHub("pane")
	if ph != cold {
		t.Fatal("cold-to-live promotion split the journal's mutex ownership")
	}
	payload := bytes.Repeat([]byte("N"), 4096)
	stop := make(chan struct{})
	go func() { wg.Wait(); close(stop) }()
	const writes = 128
	for i := 0; i < writes; i++ {
		if err := h.Ingest("pane", payload); err != nil {
			t.Fatal(err)
		}
	}
	<-stop
	defer ph.recording.file.Close()
	stat, err := ph.recording.file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if stat.Size() != ph.recording.offset {
		t.Fatalf("concurrent cold opener truncated admitted writer bytes: size=%d expected=%d", stat.Size(), ph.recording.offset)
	}
	rec, ok := h.Recording("pane", count, ph.total)
	expected := bytes.Repeat(payload, writes)
	if !ok || !bytes.Equal(rec.Data, expected) {
		for i := 0; i < len(rec.Data) && i < len(expected); i++ {
			if rec.Data[i] != expected[i] {
				t.Fatalf("concurrent recovery corrupted appended data at seq=%d: expected=%#x actual=%#x (read ok=%t)", count+i, expected[i], rec.Data[i], ok)
			}
		}
		t.Fatalf("concurrent recovery corrupted appended data; ok=%t actual length=%d expected=%d", ok, len(rec.Data), len(expected))
	}
}
