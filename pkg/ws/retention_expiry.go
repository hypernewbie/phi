package ws

import (
	"crypto/sha256"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
)

// retentionPeriod is the accepted closed-history lifetime. Live panes,
// valid saved-tab reservations, and fresh groups are never expired.
const retentionPeriod = 7 * 24 * time.Hour

const retentionSweepInterval = time.Hour

// retentionSweepStats reports one sweep. BytesReclaimed counts only files
// actually unlinked; FailedPaths names groups the next sweep must retry.
type retentionSweepStats struct {
	GroupsDeleted  int
	BytesReclaimed uint64
	FailedPaths    []string
}

func defaultSavedReservations() (map[string]bool, error) {
	tabs, err := pty.ReadSavedTabs()
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(tabs))
	for _, tab := range tabs {
		out[tab.ID] = true
	}
	return out, nil
}

// StartRetentionSweeps runs the first expiry sweep and then one per hour.
// Call once after saved-tab restoration completes, never before. Without
// the namespace lease the worker still bounds the in-memory archive map
// but never touches the disk namespace.
func (h *Hub) StartRetentionSweeps() {
	h.mu.Lock()
	if h.sweepStarted {
		h.mu.Unlock()
		return
	}
	h.sweepStarted = true
	h.sweepDone = make(chan struct{})
	done := h.sweepDone
	h.mu.Unlock()
	h.sweepRetention(h.wallClock())
	h.sweepWg.Add(1)
	go func() {
		defer h.sweepWg.Done()
		ticker := time.NewTicker(retentionSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-ticker.C:
				h.sweepRetention(now)
			}
		}
	}()
}

// sweepRetention expires closed groups older than the retention period.
// Live panes, saved reservations, fresh groups, and unrecognized layouts
// are kept. A failed delete keeps its group for the next sweep.
func (h *Hub) sweepRetention(now time.Time) retentionSweepStats {
	var stats retentionSweepStats
	h.mu.RLock()
	dir, held := h.recordingDirectory, h.leaseHeld
	h.mu.RUnlock()
	saved := map[string]bool{}
	if h.savedReservations != nil {
		var err error
		saved, err = h.savedReservations()
		if err != nil {
			log.Printf("[ws] retention sweep skipped without the saved-tab list: %v", err)
			return stats
		}
	}
	if held && dir != "" {
		h.sweepDiskGroups(filepath.Join(dir, "v2"), saved, now, &stats)
	}
	h.sweepArchives(saved, now)
	return stats
}

func (h *Hub) sweepArchives(saved map[string]bool, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, ph := range h.archives {
		if saved[id] {
			continue
		}
		ph.mu.Lock()
		closedAt := ph.closedAtUnixNano
		if closedAt > 0 && now.UnixNano()-closedAt >= int64(retentionPeriod) {
			if ph.recording != nil {
				_ = ph.recording.close()
			}
			delete(h.archives, id)
		}
		ph.mu.Unlock()
	}
}

// sweepDiskGroups deletes expired versioned groups. The caller is the
// lease owner. Each group is rechecked and deleted under h.mu so a pane
// that goes live mid-sweep can never lose its history.
func (h *Hub) sweepDiskGroups(v2 string, saved map[string]bool, now time.Time, stats *retentionSweepStats) {
	entries, err := os.ReadDir(v2)
	if err != nil {
		log.Printf("[ws] retention sweep cannot list %s: %v", v2, err)
		return
	}
	savedHashes := make(map[string]bool, len(saved))
	for id := range saved {
		savedHashes[fmt.Sprintf("%x", sha256.Sum256([]byte(id)))] = true
	}
	// Snapshot live membership once. The snapshot only skips groups;
	// every expired candidate is re-verified under the write lock
	// before deletion, so a pane that goes live mid-sweep can never
	// lose its history. Archive ownership is resolved fresh per group:
	// a cold read may publish an owner after this snapshot.
	h.mu.RLock()
	live := make(map[string]bool, len(h.panes))
	for id := range h.panes {
		live[fmt.Sprintf("%x", sha256.Sum256([]byte(id)))] = true
	}
	h.mu.RUnlock()
	for _, entry := range entries {
		name := entry.Name()
		if !isRetentionGroupName(name) || !entry.IsDir() {
			continue
		}
		if savedHashes[name] || live[name] {
			continue
		}
		h.sweepOneGroup(v2, name, now, stats)
	}
}

func isRetentionGroupName(name string) bool {
	if len(name) != 64 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// sweepOneGroup rechecks ownership under h.mu and deletes one expired
// group. Only recognized regular files are unlinked; unknown entries and
// symlinks are left in place and the directory is removed only when empty.
func (h *Hub) sweepOneGroup(v2, name string, now time.Time, stats *retentionSweepStats) {
	group := filepath.Join(v2, name)
	h.mu.Lock()
	defer h.mu.Unlock()
	for id := range h.panes {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == name {
			return
		}
	}
	// The manifest is read under the same lock that serializes close
	// and promote, so a just-closed pane can never be judged by a
	// stale pre-close manifest.
	data, err := readRetentionManifest(filepath.Join(group, "MANIFEST"))
	if err != nil {
		return
	}
	manifest, err := decodeRetentionManifest(data)
	if err != nil {
		return
	}
	clock := manifest.lastUpdateNs
	if manifest.flags&retentionFlagClosed != 0 && manifest.closedAtNs > 0 {
		clock = manifest.closedAtNs
	}
	if clock <= 0 || now.UnixNano()-clock < int64(retentionPeriod) {
		return
	}

	// Resolve the current archive owner under this lock: a cold read may
	// have published one after the sweep snapshot. Detach and close it
	// before deleting so no owner outlives its files.
	for id, ph := range h.archives {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == name {
			ph.mu.Lock()
			if ph.recording != nil {
				_ = ph.recording.close()
			}
			ph.mu.Unlock()
			delete(h.archives, id)
			break
		}
	}
	reclaimed, removed, err := deleteRetentionGroupFiles(v2, group)
	if err != nil {
		stats.FailedPaths = append(stats.FailedPaths, group)
		log.Printf("[ws] retention sweep cannot delete %s: %v", group, err)
		return
	}
	stats.BytesReclaimed += reclaimed
	if removed {
		stats.GroupsDeleted++
		log.Printf("[ws] retention sweep expired %s (%d bytes)", group, reclaimed)
	}
}

func isRecognizedRetentionFile(name string) bool {
	if name == "MANIFEST" || name == "MANIFEST.tmp" {
		return true
	}
	_, ok := parseRetentionSegFile(name)
	return ok
}

// deleteRetentionGroupFiles unlinks recognized regular files below the
// group directory and removes the directory when empty. Every path stays
// rooted in the namespace; symlinks, directories, and unknown names are
// never followed or deleted. A group counts as removed once its manifest
// is unlinked: unknown leftovers keep an inert directory that never
// reopens and the next sweep skips.
func deleteRetentionGroupFiles(v2, group string) (uint64, bool, error) {
	var reclaimed uint64
	// ReadDir follows a symlinked group dir into its target: refuse to
	// delete through anything but a real namespace directory.
	if fi, err := os.Lstat(group); err != nil {
		return 0, false, err
	} else if !fi.Mode().IsDir() {
		return 0, false, nil
	}
	entries, err := os.ReadDir(group)
	if err != nil {
		return 0, false, err
	}
	// The manifest goes last so a failed delete leaves the group
	// recognizable and the next sweep retries it.
	ordered := make([]os.DirEntry, 0, len(entries))
	var manifests []os.DirEntry
	for _, entry := range entries {
		if entry.Name() == "MANIFEST" {
			manifests = append(manifests, entry)
		} else {
			ordered = append(ordered, entry)
		}
	}
	ordered = append(ordered, manifests...)
	manifestRemoved := false
	for _, entry := range ordered {
		name := entry.Name()
		if !isRecognizedRetentionFile(name) || entry.IsDir() {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			continue
		}
		path := filepath.Join(group, name)
		rel, err := filepath.Rel(v2, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return reclaimed, false, fmt.Errorf("path escapes the retention namespace: %s", name)
		}
		info, err := entry.Info()
		if err != nil {
			return reclaimed, false, err
		}
		if err := os.Remove(path); err != nil {
			return reclaimed, manifestRemoved, err
		}
		reclaimed += uint64(info.Size())
		if name == "MANIFEST" {
			manifestRemoved = true
		}
	}
	if err := os.Remove(group); err != nil && !os.IsNotExist(err) && !os.IsExist(err) {
		log.Printf("[ws] retention sweep cannot remove %s: %v", group, err)
	}
	return reclaimed, manifestRemoved, nil
}
