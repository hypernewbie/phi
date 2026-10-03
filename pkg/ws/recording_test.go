package ws

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestPersistentRecordingAcrossHubRestart(t *testing.T) {
	dir := t.TempDir()
	first := NewHub(8)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	first.RecordResize("p", 80, 24)
	if err := first.Ingest("p", []byte("old output\r\n")); err != nil {
		t.Fatal(err)
	}
	ph, _ := first.LookupPane("p")
	oldEpoch := ph.EpochOf()
	if err := ph.recording.file.Sync(); err != nil {
		t.Fatal(err)
	}
	second := NewHub(8)
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := second.Ingest("p", []byte("new output\r\n")); err != nil {
		t.Fatal(err)
	}
	rec, ok := second.Recording("p", 0, 1000)
	if !ok || !bytes.Equal(rec.Data, []byte("old output\r\nnew output\r\n")) {
		t.Fatalf("restart data: %+v", rec)
	}
	if rec.Epoch == oldEpoch {
		t.Fatal("new server reused the old live/cache identity")
	}
	if len(rec.Resizes) != 1 || rec.Resizes[0].Cols != 80 {
		t.Fatal("restart lost geometry")
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("files=%d", len(files))
	}
	info, err := os.Stat(filepath.Join(dir, files[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("recording is readable by another user")
	}
}

func TestRecordingRecoversATornFinalAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recording")
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.append(1, []byte("retained")); err != nil {
		t.Fatal(err)
	}
	var hdr [5]byte
	hdr[0] = 1
	binary.BigEndian.PutUint32(hdr[1:], 20)
	if _, err = r.file.WriteAt(append(hdr[:], byte('x')), r.offset); err != nil {
		t.Fatal(err)
	}
	recovered, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.head != 8 {
		t.Fatalf("invented frontier %d", recovered.head)
	}
	if err = recovered.append(1, []byte(" tail")); err != nil {
		t.Fatal(err)
	}
	data, _, err := recovered.read(0, recovered.head)
	if err != nil || string(data) != "retained tail" {
		t.Fatalf("data=%q error=%v", data, err)
	}
}

func TestRecordingWriteFailureDoesNotAdvanceFrontier(t *testing.T) {
	h := NewHub(8)
	if err := h.Ingest("p", []byte("retained")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	ph.recording.file.Close()
	if err := h.Ingest("p", []byte("not admitted")); err == nil {
		t.Fatal("closed recording accepted bytes")
	}
	if ph.total != 8 {
		t.Fatalf("failure advanced head to %d", ph.total)
	}
}
