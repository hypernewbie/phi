package ws

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"testing"
	"time"
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
