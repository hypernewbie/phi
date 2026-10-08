package ws

import (
	"bytes"
	"os"
	"testing"
)

func TestOldParserAnchorsRemainAvailableAfterMemoryCacheEviction(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("archive", []byte("current screen")); err != nil {
		t.Fatal(err)
	}
	ph, ok := h.LookupPane("archive")
	if !ok {
		t.Fatal("pane missing")
	}
	ph.mu.Lock()
	source, err := ph.state.Ready()
	if err != nil {
		ph.mu.Unlock()
		t.Fatal(err)
	}
	for i := 1; i <= stateAnchorCount+8; i++ {
		ph.stateHead = uint64(i) * stateAnchorInterval
		ph.total = ph.stateHead
		if err = ph.addStateAnchorLocked(); err != nil {
			ph.mu.Unlock()
			t.Fatal(err)
		}
	}
	if len(ph.stateAnchors) != stateAnchorCount {
		ph.mu.Unlock()
		t.Fatalf("memory cache size=%d", len(ph.stateAnchors))
	}
	for _, anchor := range ph.stateAnchors {
		if anchor.through == stateAnchorInterval {
			ph.mu.Unlock()
			t.Fatal("old anchor unexpectedly remains in memory")
		}
	}
	anchor, ok := ph.nearestStateAnchor(stateAnchorInterval)
	ph.mu.Unlock()
	if !ok || anchor.through != stateAnchorInterval {
		t.Fatalf("oldest requested checkpoint not found: %+v", anchor)
	}
	restored, err := restoreAnchor(anchor.compressed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, source) {
		t.Fatal("disk checkpoint did not preserve parser state")
	}
	entries, err := os.ReadDir(ph.statePath + ".d")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != stateAnchorCount+9 {
		t.Fatalf("durable checkpoints=%d", len(entries))
	}
}
