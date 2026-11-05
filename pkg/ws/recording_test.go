package ws

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// Terminal history is RAM-only: a restart starts empty, never adopts the
// previous process's files, and never deletes them.
func TestRAMReplayRestartDoesNotAdoptFiles(t *testing.T) {
	dir := t.TempDir()
	files := []string{filepath.Join(dir, "legacy.rec"), filepath.Join(dir, "v2", "old", "manifest"), filepath.Join(dir, "v3", "old", "data")}
	for _, file := range files {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("synthetic pre-upgrade history"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	first := NewHub(64)
	if err := first.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := first.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := first.Ingest("p", []byte("old output\r\n")); err != nil {
		t.Fatal(err)
	}
	first.ClosePane("p")
	closed := first.recordingForRead("p")
	if page, err := first.Replay("p", ReplayRequest{Epoch: closed.epoch, Latest: true}); err != nil || string(page.Data) != "old output\r\n" {
		t.Fatalf("closed pane lost its finite view: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := NewHub(64)
	t.Cleanup(func() { _ = second.Close() })
	if err := second.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if err := second.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := second.Ingest("p", []byte("new output\r\n")); err != nil {
		t.Fatal(err)
	}
	ph, _ := second.LookupPane("p")
	page, err := second.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
	if err != nil || !bytes.Equal(page.Data, []byte("new output\r\n")) {
		t.Fatalf("restart data: %+v %v", page, err)
	}
	if page.Incomplete {
		t.Fatal("a fresh RAM window reported incomplete history")
	}
	second.savedReservations = func() (map[string]bool, error) { return nil, nil }
	second.sweepRAMArchives(second.wallClock().Add(2 * retentionPeriod))
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil || string(data) != "synthetic pre-upgrade history" {
			t.Fatalf("old file changed: %s: %v", file, err)
		}
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0o640 {
			t.Fatalf("old file mode changed: %s", file)
		}
		entries, err := os.ReadDir(filepath.Dir(file))
		if err != nil || (filepath.Dir(file) != dir && len(entries) != 1) {
			t.Fatalf("old directory changed: %s", file)
		}
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

func TestRecordingRecoversTrailingZeroBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recording")
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.append(1, []byte("retained")); err != nil {
		t.Fatal(err)
	}
	// Simulate unwritten preallocated zeroes from a hard crash / unclean reboot.
	zeros := make([]byte, 260)
	if _, err = r.file.WriteAt(zeros, r.offset); err != nil {
		t.Fatal(err)
	}
	recovered, err := openRecording(path)
	if err != nil {
		t.Fatalf("openRecording failed on trailing zeros: %v", err)
	}
	defer recovered.file.Close()
	if recovered.head != 8 {
		t.Fatalf("head=%d want 8", recovered.head)
	}
	if err = recovered.append(1, []byte(" tail")); err != nil {
		t.Fatal(err)
	}
	data, _, err := recovered.read(0, recovered.head)
	if err != nil || string(data) != "retained tail" {
		t.Fatalf("data=%q err=%v", data, err)
	}
}

func TestRecordingRecoversTornInvalidHeaderAtTail(t *testing.T) {
	for _, badHeader := range [][]byte{
		{99, 0, 0, 0, 0},      // invalid kind != 1, 2
		{2, 0, 0, 0, 5},       // resize with length != 4
		{1, 0, 0, 0, 20, 'x'}, // declared length exceeding file size
	} {
		path := filepath.Join(t.TempDir(), "recording")
		r, err := openRecording(path)
		if err != nil {
			t.Fatal(err)
		}
		if err = r.append(1, []byte("retained")); err != nil {
			t.Fatal(err)
		}
		if _, err = r.file.WriteAt(badHeader, r.offset); err != nil {
			t.Fatal(err)
		}
		recovered, err := openRecording(path)
		if err != nil {
			t.Fatalf("openRecording failed on badHeader %v: %v", badHeader, err)
		}
		if recovered.head != 8 {
			t.Fatalf("head=%d want 8", recovered.head)
		}
		if err = recovered.append(1, []byte(" tail")); err != nil {
			t.Fatal(err)
		}
		data, _, err := recovered.read(0, recovered.head)
		if err != nil || string(data) != "retained tail" {
			t.Fatalf("data=%q err=%v", data, err)
		}
		_ = recovered.file.Close()
	}
}

func TestRecordingCorruptMiddleInvalidKindPreservesSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recording")
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.file.Close()
	if err = r.append(1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	middle := r.offset
	if err = r.append(1, []byte("second committed")); err != nil {
		t.Fatal(err)
	}
	if err = r.append(1, []byte("third committed")); err != nil {
		t.Fatal(err)
	}
	// Corrupt middle record header kind to an invalid type 99.
	if _, err = r.file.WriteAt([]byte{99}, middle); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	recovered, openErr := openRecording(path)
	if recovered != nil {
		defer recovered.file.Close()
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if openErr == nil {
		t.Error("corrupt middle invalid kind must fail closed")
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("recovery deleted %d retained bytes", len(before)-len(after))
	}
}
