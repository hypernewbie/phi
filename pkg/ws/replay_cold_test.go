package ws

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestColdReplayDoesNotMutateAndPromotionRecoversOwnedTail(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.InitPaneJournal("p", 100, 30); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("certified")); err != nil {
		t.Fatal(err)
	}
	path := h.recordingPath("p")
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(path, "journal")
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("uncommitted")); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if err := os.Chmod(file, 0640); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(path, "MANIFEST.tmp")
	if err := os.WriteFile(tmp, []byte("uncertain manifest"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest, _ := os.ReadFile(filepath.Join(path, "MANIFEST"))
	tail, _ := os.ReadFile(file)
	h = NewHub(4096)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ph := h.recordingForRead("p")
	if ph == nil || ph.journal == nil || !ph.journal.readOnly {
		t.Fatal("cold replay opened a writer")
	}
	page, err := h.Replay("p", ReplayRequest{Epoch: ph.epoch, Latest: true})
	if err != nil || string(page.Data) != "certified" || !page.Incomplete || page.InitCols != 100 || page.InitRows != 30 {
		t.Fatalf("wrong cold page: %+v %v", page, err)
	}
	got, _ := os.ReadFile(file)
	m, _ := os.ReadFile(filepath.Join(path, "MANIFEST"))
	st, _ := os.Stat(file)
	if !bytes.Equal(got, tail) || !bytes.Equal(m, manifest) || st.Mode().Perm() != 0640 {
		t.Fatal("read-only replay modified storage")
	}
	if _, err := os.Stat(tmp); err != nil {
		t.Fatal("cold reader removed an uncertain manifest")
	}
	writer, err := h.GetOrCreatePaneHub("p")
	if err != nil || writer != ph || writer.journal.readOnly {
		t.Fatalf("promotion lost the serialized owner: %v", err)
	}
	if err := h.Ingest("p", []byte(" later")); err != nil {
		t.Fatal(err)
	}
	page, err = h.Replay("p", ReplayRequest{Epoch: writer.epoch, Latest: true})
	if err != nil || string(page.Data) != "certified later" || !page.Incomplete {
		t.Fatalf("wrong promoted stream: %+v %v", page, err)
	}
}

func TestColdReplayCorruptionIsUnavailableNotMissing(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("certified")); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(h.recordingPath("p"), "journal")
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xff}, 0); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	before, _ := os.ReadFile(file)
	h = NewHub(4096)
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, err := h.Replay("p", ReplayRequest{Latest: true}); !errors.Is(err, ErrReplayUnavailable) {
		t.Fatalf("corrupt history read as %v", err)
	}
	after, _ := os.ReadFile(file)
	if !bytes.Equal(before, after) {
		t.Fatal("failed read modified the committed prefix")
	}
}
