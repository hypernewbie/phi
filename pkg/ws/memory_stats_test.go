//go:build profiling

package ws

import (
	"bytes"
	"sync"
	"testing"
)

func TestMemoryStatsUsesRingCapacityNotFill(t *testing.T) {
	h := NewHub(0)
	empty := &PaneHub{Ring: NewRingBuffer(8)}
	partial := &PaneHub{Ring: NewRingBuffer(8)}
	partial.Ring.Write([]byte("abc"))
	wrapped := &PaneHub{Ring: NewRingBuffer(8)}
	wrapped.Ring.Write([]byte("0123456789"))
	h.panes["empty"] = empty
	h.panes["partial"] = partial
	h.panes["wrapped"] = wrapped
	// A duplicate pointer in both maps is one owner, counted as live.
	h.archives["duplicate"] = empty

	got := h.MemoryStats()
	if !got.Complete || *got.LiveOwnerCount != 3 || *got.ArchiveOwnerCount != 0 || *got.SkippedOwnerCount != 0 {
		t.Fatalf("owner counts = %+v", got)
	}
	if *got.RingCapacityBytes != 24 {
		t.Fatalf("ring capacity = %d, want 24", *got.RingCapacityBytes)
	}
	if *got.RingCapacityBytes == 11 {
		t.Fatal("ring accounting reported fill instead of allocated capacity")
	}
}

func TestMemoryStatsCheckpointReplacementAndArchiveRehydration(t *testing.T) {
	h := NewHub(32)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.Ingest("owned", []byte("initial output")); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := h.State("owned"); err != nil {
		t.Fatal(err)
	}
	pane, ok := h.LookupPane("owned")
	if !ok {
		t.Fatal("live pane not found")
	}
	pane.mu.Lock()
	epoch, head := pane.epoch, pane.total
	pane.mu.Unlock()
	if !h.StoreCheckpoint("owned", CheckpointUpload{
		Epoch: epoch, Through: head, Cols: 80, Rows: 24, Ansi: make([]byte, 64),
	}) {
		t.Fatal("first checkpoint rejected")
	}
	if err := h.Ingest("owned", []byte(" more")); err != nil {
		t.Fatal(err)
	}
	pane.mu.Lock()
	head = pane.total
	pane.mu.Unlock()
	if !h.StoreCheckpoint("owned", CheckpointUpload{
		Epoch: epoch, Through: head, Cols: 80, Rows: 24, Ansi: make([]byte, 23),
	}) {
		t.Fatal("replacement checkpoint rejected")
	}

	before, ok := h.Recording("owned", 0, head)
	if !ok {
		t.Fatal("recording unavailable before snapshot")
	}
	live := h.MemoryStats()
	if !live.Complete || *live.LiveOwnerCount != 1 || *live.ArchiveOwnerCount != 0 {
		t.Fatalf("live owner counts = %+v", live)
	}
	if *live.RingCapacityBytes != 32 || *live.CheckpointCapacityBytes != 23 || *live.WasmLinearBytes == 0 {
		t.Fatalf("live memory stats = %+v", live)
	}
	afterSnapshot, ok := h.Recording("owned", 0, head)
	if !ok || !bytes.Equal(afterSnapshot.Data, before.Data) {
		t.Fatal("memory snapshot changed recording bytes")
	}

	h.ClosePane("owned")
	archived := h.MemoryStats()
	if !archived.Complete || *archived.LiveOwnerCount != 0 || *archived.ArchiveOwnerCount != 1 {
		t.Fatalf("archive owner counts = %+v", archived)
	}
	if *archived.RingCapacityBytes != 0 || *archived.CheckpointCapacityBytes != 0 || *archived.WasmLinearBytes != 0 {
		t.Fatalf("closed pane retained live buffers: %+v", archived)
	}

	if _, err := h.GetOrCreatePaneHub("owned"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := h.State("owned"); err != nil {
		t.Fatal(err)
	}
	rehydrated := h.MemoryStats()
	if !rehydrated.Complete || *rehydrated.LiveOwnerCount != 1 || *rehydrated.ArchiveOwnerCount != 0 {
		t.Fatalf("rehydrated owner counts = %+v", rehydrated)
	}
	if *rehydrated.RingCapacityBytes != 32 || *rehydrated.WasmLinearBytes == 0 {
		t.Fatalf("rehydrated memory stats = %+v", rehydrated)
	}
	afterRehydrate, ok := h.Recording("owned", 0, head)
	if !ok || !bytes.Equal(afterRehydrate.Data, before.Data) {
		t.Fatal("archive rehydration changed recording bytes")
	}
}

func TestMemoryStatsBusyHubReturnsNullCounters(t *testing.T) {
	h := NewHub(0)
	h.mu.Lock()
	got := h.MemoryStats()
	h.mu.Unlock()
	if got.Complete || got.Reason != "hub_busy" {
		t.Fatalf("busy hub status = %+v", got)
	}
	if got.LiveOwnerCount != nil || got.ArchiveOwnerCount != nil || got.SkippedOwnerCount != nil || got.RingCapacityBytes != nil || got.CheckpointCapacityBytes != nil || got.WasmLinearBytes != nil {
		t.Fatalf("busy hub reported counters: %+v", got)
	}
}

func TestMemoryStatsSkipsBusyPaneWithoutInventingTotals(t *testing.T) {
	h := NewHub(0)
	pane := &PaneHub{Ring: NewRingBuffer(16)}
	h.panes["busy"] = pane
	pane.mu.Lock()
	got := h.MemoryStats()
	pane.mu.Unlock()
	if got.Complete || got.LiveOwnerCount == nil || *got.LiveOwnerCount != 1 || got.SkippedOwnerCount == nil || *got.SkippedOwnerCount != 1 {
		t.Fatalf("busy pane status = %+v", got)
	}
	if *got.RingCapacityBytes != 0 || *got.CheckpointCapacityBytes != 0 || *got.WasmLinearBytes != 0 {
		t.Fatalf("busy pane totals should contain no guessed values: %+v", got)
	}
}

func TestMemoryStatsSkipsOwnerWhenRingLockIsBusy(t *testing.T) {
	h := NewHub(0)
	pane := &PaneHub{Ring: NewRingBuffer(16)}
	h.panes["busy-ring"] = pane
	pane.Ring.mu.Lock()
	got := h.MemoryStats()
	pane.Ring.mu.Unlock()
	if got.Complete || got.SkippedOwnerCount == nil || *got.SkippedOwnerCount != 1 || *got.RingCapacityBytes != 0 {
		t.Fatalf("busy ring status = %+v", got)
	}
}

func TestMemoryStatsConcurrentIngestCloseAndSnapshot(t *testing.T) {
	h := NewHub(4096)
	if err := h.Ingest("race", []byte("start")); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			_ = h.Ingest("race", []byte("x"))
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 100; i++ {
			h.ClosePane("race")
		}
	}()
	go func() {
		defer workers.Done()
		for i := 0; i < 200; i++ {
			_ = h.MemoryStats()
		}
	}()
	workers.Wait()
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
}
