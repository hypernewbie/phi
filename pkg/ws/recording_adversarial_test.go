package ws

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Terminal history is RAM-only: a restarted hub has no history to adopt,
// even when the previous process left files behind. Nothing is read from
// the old namespace and nothing is deleted.
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
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}

			second := NewHub(64)
			t.Cleanup(func() { _ = second.Close() })
			if err := second.SetRecordingDirectory(dir); err != nil {
				t.Fatal(err)
			}
			if err := second.InitPaneJournal("pane", 80, 24); err != nil {
				t.Fatal(err)
			}
			c := &Client{Send: make(chan []byte, 4)}
			second.AttachHot("pane", c)
			attach := parseAttach(t, drainOne(c.Send))
			if attach.GetHead() != 0 || attach.GetOldest() != 0 {
				t.Fatalf("restarted hub adopted old history: oldest=%d head=%d", attach.GetOldest(), attach.GetHead())
			}
			if err := second.Ingest("pane", []byte("new")); err != nil {
				t.Fatal(err)
			}
			page, err := second.Replay("pane", ReplayRequest{Epoch: attach.GetEpoch(), From: 0, Latest: true})
			if err != nil || string(page.Data) != "new" {
				t.Fatalf("restarted hub served pre-restart history: err=%v data=%q", err, page.Data)
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
			h := NewHub(64)
			t.Cleanup(func() { _ = h.Close() })
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
