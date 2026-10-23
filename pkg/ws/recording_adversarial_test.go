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
	for _, cache := range []int{0, 8, 128} {
		for _, closed := range []bool{false, true} {
			name := "live"
			if closed {
				name = "exited"
			}
			t.Run(fmt.Sprintf("%s/cache-%d", name, cache), func(t *testing.T) {
				dir := t.TempDir()
				first := NewHub(cache)
				second := NewHub(cache)
				t.Cleanup(func() {
					for _, hub := range []*Hub{first, second} {
						pane, ok := hub.LookupPane("pane")
						if !ok {
							pane = hub.archives["pane"]
						}
						if pane != nil && pane.recording != nil {
							_ = pane.recording.file.Close()
						}
					}
				})
				if err := first.SetRecordingDirectory(dir); err != nil {
					t.Fatal(err)
				}
				data := []byte("retained output from a process that need not be relaunched\r\n")
				if err := first.Ingest("pane", data); err != nil {
					t.Fatal(err)
				}
				ph, _ := first.LookupPane("pane")
				if err := ph.recording.file.Sync(); err != nil {
					t.Fatal(err)
				}
				if closed {
					first.ClosePane("pane")
				}
				if err := second.SetRecordingDirectory(dir); err != nil {
					t.Fatal(err)
				}
				recording, ok := second.Recording("pane", 0, uint64(len(data)))
				if !ok || !bytes.Equal(recording.Data, data) {
					t.Fatalf("existing cold data requires a new live writer: found=%t data=%q", ok, recording.Data)
				}
			})
		}
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
			defer func() {
				if pane, ok := h.LookupPane("p"); ok && pane.recording != nil {
					_ = pane.recording.file.Close()
				}
			}()
			h.RecordResize("p", 80, 24)
			if err := h.Ingest("p", []byte("before")); err != nil {
				t.Fatal(err)
			}
			h.RecordResize("p", size[0], size[1])
			if err := h.Ingest("p", []byte("after")); err != nil {
				t.Fatal(err)
			}
			rec, ok := h.Recording("p", 0, 100)
			if !ok {
				t.Fatal("lost recording")
			}
			for _, m := range rec.Resizes {
				if m.Cols == 0 || m.Rows == 0 {
					t.Fatalf("authenticated malformed resize made every strict client reject subsequent recording: %+v", m)
				}
			}
		})
	}
}

func TestAdversarialTransientResizeJournalFailureDoesNotLoseGeometry(t *testing.T) {
	h := NewHub(8)
	h.RecordResize("p", 80, 24)
	if err := h.Ingest("p", []byte("before")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	r := ph.recording
	if err := r.file.Close(); err != nil {
		t.Fatal(err)
	}
	// ReadPump has no return value to prevent the actual PTY resize. Its
	// failure must be retained for retry, not disappear before new output.
	h.RecordResize("p", 100, 40)
	replacement, err := os.OpenFile(r.path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = replacement.Close() })
	r.file = replacement
	if err := h.Ingest("p", []byte("output generated in 100x40")); err != nil {
		return
	} // refusing admission is safe
	rec, ok := h.Recording("p", 0, 1000)
	if !ok {
		t.Fatal("missing recording")
	}
	last := rec.Resizes[len(rec.Resizes)-1]
	if last.Cols != 100 || last.Rows != 40 || last.AtSeq != 6 {
		t.Fatalf("new bytes admitted under a lost resize: %+v", last)
	}
}
