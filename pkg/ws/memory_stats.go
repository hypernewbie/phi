//go:build profiling

package ws

// memoryStats is a best-effort view of memory with a known Phi owner. The
// measurements are separate categories and must not be added together.
type memoryStats struct {
	LiveOwnerCount          *int    `json:"live_owner_count"`
	ArchiveOwnerCount       *int    `json:"archive_owner_count"`
	SkippedOwnerCount       *int    `json:"skipped_owner_count"`
	RingCapacityBytes       *uint64 `json:"ring_capacity_bytes"`
	CheckpointCapacityBytes *uint64 `json:"checkpoint_capacity_bytes"`
	WasmLinearBytes         *uint64 `json:"wasm_linear_bytes"` // Kept for compatibility; zero without WASM.
	NativeResidentBytes     *uint64 `json:"native_resident_bytes"`
	Complete                bool    `json:"complete"`
	Reason                  string  `json:"reason,omitempty"`
}

type memoryOwner struct {
	pane    *PaneHub
	archive bool
}

// MemoryStats observes only allocations owned by live and archived panes.
// It never reads retained output or opens a recording.
func (h *Hub) MemoryStats() memoryStats {
	if h == nil || !h.mu.TryRLock() {
		return memoryStats{Complete: false, Reason: "hub_busy"}
	}
	owners := make([]memoryOwner, 0, len(h.panes)+len(h.archives))
	seen := make(map[*PaneHub]struct{}, len(h.panes)+len(h.archives))
	for _, pane := range h.panes {
		if pane == nil {
			continue
		}
		if _, ok := seen[pane]; ok {
			continue
		}
		seen[pane] = struct{}{}
		owners = append(owners, memoryOwner{pane: pane})
	}
	for _, pane := range h.archives {
		if pane == nil {
			continue
		}
		if _, ok := seen[pane]; ok {
			continue
		}
		seen[pane] = struct{}{}
		owners = append(owners, memoryOwner{pane: pane, archive: true})
	}
	h.mu.RUnlock()

	liveCount, archiveCount, skippedCount := 0, 0, 0
	var ringBytes, checkpointBytes, wasmBytes uint64
	complete := true
	for _, owner := range owners {
		if owner.archive {
			archiveCount++
		} else {
			liveCount++
		}
		if !owner.pane.mu.TryLock() {
			skippedCount++
			complete = false
			continue
		}

		ring := owner.pane.Ring
		if owner.pane.win != nil {
			ring = owner.pane.win.ring
		}
		var ringCapacity uint64
		if capacity, ok := ring.tryCapacity(); !ok {
			owner.pane.mu.Unlock()
			skippedCount++
			complete = false
			continue
		} else {
			ringCapacity = uint64(capacity)
		}
		checkpointCapacity := uint64(0)
		if owner.pane.ckpt != nil {
			checkpointCapacity = uint64(cap(owner.pane.ckpt.Ansi))
		}
		// The server holds no terminal engine, so it has no resident
		// terminal bytes to report. The field stays for compatibility.
		owner.pane.mu.Unlock()

		ringBytes += ringCapacity
		checkpointBytes += checkpointCapacity
	}

	return memoryStats{
		LiveOwnerCount:          &liveCount,
		ArchiveOwnerCount:       &archiveCount,
		SkippedOwnerCount:       &skippedCount,
		RingCapacityBytes:       &ringBytes,
		CheckpointCapacityBytes: &checkpointBytes,
		WasmLinearBytes:         &wasmBytes,
		NativeResidentBytes:     new(uint64),
		Complete:                complete,
	}
}

// tryCapacity reads allocated capacity without waiting on an active writer.
func (r *RingBuffer) tryCapacity() (int, bool) {
	if r == nil {
		return 0, true
	}
	if !r.mu.TryLock() {
		return 0, false
	}
	defer r.mu.Unlock()
	return cap(r.buf), true
}
