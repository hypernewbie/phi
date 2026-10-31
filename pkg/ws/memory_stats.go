package ws

// memoryStats is a best-effort view of memory with a known Phi owner. The
// measurements are separate categories and must not be added together.
type memoryStats struct {
	LiveOwnerCount          *int    `json:"live_owner_count"`
	ArchiveOwnerCount       *int    `json:"archive_owner_count"`
	SkippedOwnerCount       *int    `json:"skipped_owner_count"`
	RingCapacityBytes       *uint64 `json:"ring_capacity_bytes"`
	CheckpointCapacityBytes *uint64 `json:"checkpoint_capacity_bytes"`
	WasmLinearBytes         *uint64 `json:"wasm_linear_bytes"`
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

		var ringCapacity uint64
		if capacity, ok := owner.pane.Ring.tryCapacity(); !ok {
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
		var terminalBytes uint64
		if owner.pane.state != nil {
			var err error
			terminalBytes, err = owner.pane.state.LinearMemoryBytes()
			if err != nil {
				owner.pane.mu.Unlock()
				skippedCount++
				complete = false
				continue
			}
		}
		owner.pane.mu.Unlock()

		ringBytes += ringCapacity
		checkpointBytes += checkpointCapacity
		wasmBytes += terminalBytes
	}

	return memoryStats{
		LiveOwnerCount:          &liveCount,
		ArchiveOwnerCount:       &archiveCount,
		SkippedOwnerCount:       &skippedCount,
		RingCapacityBytes:       &ringBytes,
		CheckpointCapacityBytes: &checkpointBytes,
		WasmLinearBytes:         &wasmBytes,
		Complete:                complete,
	}
}
