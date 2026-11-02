package ws

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestAdversarialColdReadAfterRestartWithoutLiveWriter(t *testing.T) {
	for _, closed := range []bool{false, true} {
		name := "live"
		if closed {
			name = "exited"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			first := NewHub(64)
			if err := first.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			if err := first.InitPaneJournal("pane", 80, 24); err != nil {
				t.Fatal(err)
			}
			data := []byte("retained output from a process that need not be relaunched\r\n")
			if err := first.Ingest("pane", data); err != nil {
				t.Fatal(err)
			}
			if closed {
				first.ClosePane("pane")
			}
			// A restart closes the first owner before the second
			// opens the same journal.
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			second := NewHub(64)
			t.Cleanup(func() { _ = second.Close() })
			if err := second.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			// The backend respawn reopens the journal; the epoch is
			// per-hub-lifetime, so the client learns it from attach.
			if err := second.InitPaneJournal("pane", 80, 24); err != nil {
				t.Fatal(err)
			}
			c := &Client{Send: make(chan []byte, 4)}
			second.AttachHot("pane", c)
			attach := parseAttach(t, drainOne(c.Send))
			page, err := second.Replay("pane", ReplayRequest{Epoch: attach.GetEpoch(), From: 0, Latest: true})
			if err != nil || !bytes.Equal(page.Data, data) {
				t.Fatalf("existing cold data requires a new live writer: err=%v data=%q", err, page.Data)
			}
		})
	}
}

func TestAdversarialCorruptMiddleHeaderDoesNotDeleteRetainedSuffix(t *testing.T) {
	for _, length := range []uint32{65 * 1024 * 1024, 1024} {
		t.Run(fmt.Sprintf("declared-length-%d", length), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "recording")
			r, err := openRecording(path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = r.file.Close() })
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
			var n [4]byte
			binary.BigEndian.PutUint32(n[:], length)
			if _, err = r.file.WriteAt(n[:], middle+1); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			recovered, openErr := openRecording(path)
			if recovered != nil {
				t.Cleanup(func() { _ = recovered.file.Close() })
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if openErr == nil {
				t.Error("corrupt middle record was treated as an ordinary incomplete final append")
			}
			if !bytes.Equal(before, after) {
				t.Fatalf("recovery deleted %d retained bytes", len(before)-len(after))
			}
		})
	}
}

func TestAdversarialInvalidResizeCannotPoisonAllLaterReplay(t *testing.T) {
	for _, size := range [][2]uint16{{0, 24}, {80, 0}, {0, 0}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			h := NewHub(8)
			t.Cleanup(func() { _ = h.Close() })
			if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
				t.Fatal(err)
			}
			if err := h.InitPaneJournal("p", 80, 24); err != nil {
				t.Fatal(err)
			}
			if err := h.Ingest("p", []byte("before")); err != nil {
				t.Fatal(err)
			}
			// A zero dimension is a no-op, never a marker.
			commit, _, err := h.StagePaneResize("p", size[0], size[1])
			if err != nil {
				t.Fatal(err)
			}
			if err := commit(); err != nil {
				t.Fatal(err)
			}
			if err := h.Ingest("p", []byte("after")); err != nil {
				t.Fatal(err)
			}
			ph, _ := h.LookupPane("p")
			page, err := h.Replay("p", ReplayRequest{Epoch: ph.EpochOf(), From: 0, Latest: true})
			if err != nil {
				t.Fatalf("lost recording: %v", err)
			}
			if string(page.Data) != "beforeafter" {
				t.Fatalf("recording = %q", page.Data)
			}
			for _, m := range page.Resizes {
				if m.Cols == 0 || m.Rows == 0 {
					t.Fatalf("malformed resize marker poisoned replay: %+v", m)
				}
			}
		})
	}
}

// perCommitDurability pins the group to one durable commit per payload.
// The default batches durability, so the fault-injection tests, which drive
// a failure at a specific sync point, ask for the old granularity.
func perCommitDurability(t *testing.T) {
	t.Helper()
	old := retentionFlushBytes
	retentionFlushBytes = 0
	t.Cleanup(func() { retentionFlushBytes = old })
}
