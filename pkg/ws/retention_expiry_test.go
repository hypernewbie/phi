package ws

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

type fakeClock struct{ now time.Time }

func (f *fakeClock) Now() time.Time          { return f.now }
func (f *fakeClock) Advance(d time.Duration) { f.now = f.now.Add(d) }

func expiryTestHub(t *testing.T, fc *fakeClock) (*Hub, string) {
	t.Helper()
	h := NewHub(0)
	h.clock = fc.Now
	h.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	dir := t.TempDir()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if !h.leaseHeld {
		t.Fatal("test hub did not acquire the namespace lease")
	}
	t.Cleanup(func() { _ = h.Close() })
	return h, dir
}

func groupDir(t *testing.T, dir, paneID string) string {
	t.Helper()
	return filepath.Join(dir, "v2", fmt.Sprintf("%x", sha256.Sum256([]byte(paneID))))
}

func TestRAMReplayArchiveLifecycle(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_800_000_000, 0)}
	h := NewHub(8)
	h.clock = fc.Now
	t.Cleanup(func() { _ = h.Close() })
	reserved := map[string]bool{"saved": true}
	var reservationErr error
	h.savedReservations = func() (map[string]bool, error) { return reserved, reservationErr }
	for _, id := range []string{"closed", "saved", "live", "unknown"} {
		if err := h.InitPaneJournal(id, 80, 24); err != nil {
			t.Fatal(err)
		}
		if err := h.Ingest(id, []byte("retained-tail")); err != nil {
			t.Fatal(err)
		}
		if id != "live" {
			h.ClosePane(id)
		}
	}
	h.archives["unknown"].closedAtUnixNano = 0
	closed := h.recordingForRead("closed")
	viewer := &Client{Send: make(chan []byte, 4)}
	if !h.AttachHot("closed", viewer) {
		t.Fatal("closed history cannot be viewed")
	}
	closure := closed.closedAtUnixNano
	h.Unregister("closed", viewer)
	if closed.closedAtUnixNano != closure || h.panes["closed"] != nil {
		t.Fatal("viewing promoted or renewed the archive")
	}
	viewer = &Client{Send: make(chan []byte, 4)}
	if !h.AttachHot("closed", viewer) {
		t.Fatal("archive reattach failed")
	}
	fc.Advance(retentionPeriod - time.Nanosecond)
	h.sweepRAMArchives(fc.Now())
	if h.recordingForRead("closed") == nil {
		t.Fatal("expired before seven days")
	}
	fc.Advance(time.Nanosecond)
	reservationErr = errors.New("reservation list unavailable")
	h.sweepRAMArchives(fc.Now())
	if h.recordingForRead("closed") == nil {
		t.Fatal("expired without a reservation list")
	}
	reservationErr = nil
	h.sweepRAMArchives(fc.Now())
	if h.recordingForRead("closed") != nil || !closed.retired || closed.win != nil || len(closed.clients) != 0 {
		t.Fatal("expiry retained state or client references")
	}
	for range viewer.Send {
	} // queued attach drains, then expiry closes the channel
	// A reader which resolved the old pointer before expiry must observe
	// retirement, not revive the archive under its former ID.
	if _, err := h.Replay("closed", ReplayRequest{Epoch: closed.epoch, Latest: true}); !errors.Is(err, ErrReplayNoHistory) {
		t.Fatalf("expired replay: %v", err)
	}
	ghost := &Client{Send: make(chan []byte, 4)}
	if !h.attachHot("closed", ghost, &pty.PTYInstance{ID: "closed"}) {
		t.Fatal("missing ghost cannot report its finite exit")
	}
	h.Unregister("closed", ghost)
	if h.recordingForRead("closed") != nil {
		t.Fatal("ghost viewing recreated history")
	}
	for _, id := range []string{"saved", "live", "unknown"} {
		if h.recordingForRead(id) == nil {
			t.Fatalf("expired protected pane %s", id)
		}
	}
}

func TestRAMReplaySweepStartCloseOverlap(t *testing.T) {
	h := NewHub(8)
	if err := h.Ingest("p", []byte("tail")); err != nil {
		t.Fatal(err)
	}
	ph := h.recordingForRead("p")
	entered, release := make(chan struct{}), make(chan struct{})
	h.savedReservations = func() (map[string]bool, error) { close(entered); <-release; return nil, nil }
	h.StartRAMRetentionSweeps()
	<-entered
	done := make(chan error, 1)
	go func() { done <- h.Close() }()
	deadline := time.After(3 * time.Second)
	for {
		h.mu.RLock()
		closing := h.closed
		h.mu.RUnlock()
		if closing {
			break
		}
		select {
		case <-deadline:
			t.Fatal("Close never started")
		case <-time.After(time.Millisecond):
		}
	}
	select {
	case <-done:
		t.Fatal("Close did not join the worker")
	default:
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-deadline:
		t.Fatal("Close deadlocked with sweep")
	}
	if ph.win != nil || len(h.panes) != 0 {
		t.Fatal("Close retained RAM")
	}
	h.StartRAMRetentionSweeps() // no worker may start after Close
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHubCloseStopsSweeper(t *testing.T) {
	h := NewHub(0)
	h.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	h.StartRetentionSweeps()
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	// Closing twice must not panic on the worker channel.
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
}
