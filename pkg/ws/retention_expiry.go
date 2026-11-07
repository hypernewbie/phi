package ws

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/obs"
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
func (h *Hub) StartRetentionSweeps() { h.startRetentionSweeps(false) }

// StartRAMRetentionSweeps never opens or deletes pre-upgrade recordings.
func (h *Hub) StartRAMRetentionSweeps() { h.startRetentionSweeps(true) }

func (h *Hub) startRetentionSweeps(ramOnly bool) {
	h.mu.Lock()
	if h.sweepStarted || h.closed {
		h.mu.Unlock()
		return
	}
	h.sweepStarted = true
	h.sweepDone = make(chan struct{})
	done := h.sweepDone
	h.sweepWg.Add(1) // registered before Close can wait
	h.mu.Unlock()
	go obs.DoFeature("terminal", func(_ context.Context) {
		defer h.sweepWg.Done()
		sweep := func() {
			if !ramOnly {
				h.sweepRetention(h.wallClock())
				return
			}
			h.sweepRAMArchives(h.wallClock())
		}
		sweep()
		ticker := time.NewTicker(retentionSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				sweep()
			}
		}
	})
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
		h.sweepLegacySources(dir, saved, now, &stats)
	}
	h.sweepArchives(saved, now)
	return stats
}

func (h *Hub) sweepRAMArchives(now time.Time) {
	saved := map[string]bool{}
	if h.savedReservations != nil {
		var err error
		saved, err = h.savedReservations()
		if err != nil {
			log.Printf("[ws] RAM expiry skipped: %v", err)
			return
		}
	}
	h.sweepArchives(saved, now)
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
			ph.retired = true
			for c := range ph.clients {
				delete(ph.clients, c)
				close(c.Send)
			}
			ph.win, ph.Ring, ph.ckpt = nil, nil, nil
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
	// The retention group format is retired: no code writes it, and the
	// on-disk groups this sweep still finds are leftovers from binaries
	// that did. The group manifest is gone with the format, so the
	// directory mtime is the expiry clock. A recent mtime only delays a
	// later sweep; nothing reads the group either way.
	info, err := os.Lstat(group)
	if err != nil || !info.IsDir() {
		return
	}
	if info.ModTime().IsZero() || now.Sub(info.ModTime()) < retentionPeriod {
		return
	}

	// Resolve the current archive owner under this lock: a cold read may
	// have published one after the sweep snapshot. Detach it before
	// deleting so no owner outlives its files.
	for id := range h.archives {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == name {
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

var legacySyncDir = syncDir
var legacyRemove = os.Remove

type legacyFileSnapshot struct {
	path string
	info os.FileInfo
}

type legacySourceSnapshot struct {
	root               string
	hash               string
	journal            legacyFileSnapshot
	hasJournal         bool
	checkpointDir      string
	checkpointDirInfo  os.FileInfo
	checkpointDirEmpty bool
	checkpoints        []legacyFileSnapshot
	orphan             bool
}

func legacyJournalHash(name string) (string, bool) {
	if !strings.HasSuffix(name, ".log") {
		return "", false
	}
	hash := strings.TrimSuffix(name, ".log")
	return hash, isRetentionGroupName(hash)
}

func legacyCheckpointDirHash(name string) (string, bool) {
	const suffix = ".log.state.d"
	if !strings.HasSuffix(name, suffix) {
		return "", false
	}
	hash := strings.TrimSuffix(name, suffix)
	return hash, isRetentionGroupName(hash)
}

// legacyCheckpointName accepts only the canonical zero-padded names the
// legacy writer produced and readLegacyAnchor reads. Anything else stays
// an unknown entry the sweep never deletes.
func legacyCheckpointName(name string) bool {
	if !strings.HasSuffix(name, ".state") {
		return false
	}
	number := strings.TrimSuffix(name, ".state")
	parsed, err := strconv.ParseUint(number, 10, 64)
	return err == nil && number == fmt.Sprintf("%020d", parsed)
}

// errLegacyUnsafeType marks a legacy source whose recognized paths have
// an unsafe type (symlink, directory, device): the sweep preserves it
// silently instead of reporting a failure no retry can clear.
var errLegacyUnsafeType = errors.New("legacy source has an unsafe type")

func snapshotLegacySource(root, hash string, hasJournal bool) (legacySourceSnapshot, error) {
	snapshot := legacySourceSnapshot{
		root:          root,
		hash:          hash,
		checkpointDir: filepath.Join(root, hash+".log.state.d"),
	}
	if !isRetentionGroupName(hash) {
		return snapshot, fmt.Errorf("invalid legacy source hash %q", hash)
	}
	journal := filepath.Join(root, hash+".log")
	if hasJournal {
		info, err := os.Lstat(journal)
		if err != nil {
			return snapshot, err
		}
		if !info.Mode().IsRegular() {
			return snapshot, fmt.Errorf("%w: legacy journal is not a regular file", errLegacyUnsafeType)
		}
		snapshot.hasJournal = true
		snapshot.journal = legacyFileSnapshot{path: journal, info: info}
	} else {
		if _, err := os.Lstat(journal); err == nil {
			return snapshot, fmt.Errorf("legacy journal exists; checkpoint directory is not an orphan")
		} else if !os.IsNotExist(err) {
			return snapshot, err
		}
		snapshot.orphan = true
	}

	info, err := os.Lstat(snapshot.checkpointDir)
	if os.IsNotExist(err) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	if !info.IsDir() {
		return snapshot, fmt.Errorf("%w: legacy checkpoint path is not a real directory", errLegacyUnsafeType)
	}
	snapshot.checkpointDirInfo = info
	entries, err := os.ReadDir(snapshot.checkpointDir)
	if err != nil {
		return snapshot, err
	}
	snapshot.checkpointDirEmpty = len(entries) == 0
	for _, entry := range entries {
		if !legacyCheckpointName(entry.Name()) {
			continue
		}
		path := filepath.Join(snapshot.checkpointDir, entry.Name())
		fileInfo, err := os.Lstat(path)
		if err != nil {
			return snapshot, err
		}
		if !fileInfo.Mode().IsRegular() {
			return snapshot, fmt.Errorf("%w: legacy checkpoint is not a regular file: %s", errLegacyUnsafeType, path)
		}
		snapshot.checkpoints = append(snapshot.checkpoints, legacyFileSnapshot{path: path, info: fileInfo})
	}
	sort.Slice(snapshot.checkpoints, func(i, j int) bool {
		return snapshot.checkpoints[i].path < snapshot.checkpoints[j].path
	})
	return snapshot, nil
}

func legacySnapshotTimesSafe(snapshot legacySourceSnapshot, now time.Time) bool {
	isSafe := func(info os.FileInfo) bool {
		modified := info.ModTime()
		return !modified.IsZero() && !modified.After(now)
	}
	if snapshot.hasJournal && !isSafe(snapshot.journal.info) {
		return false
	}
	for _, checkpoint := range snapshot.checkpoints {
		if !isSafe(checkpoint.info) {
			return false
		}
	}
	return true
}

func legacySnapshotExpired(snapshot legacySourceSnapshot, now time.Time) bool {
	if snapshot.hasJournal {
		return now.Sub(snapshot.journal.info.ModTime()) >= retentionPeriod
	}
	if !snapshot.orphan || snapshot.checkpointDirInfo == nil {
		return false
	}
	if len(snapshot.checkpoints) == 0 {
		return snapshot.checkpointDirEmpty
	}
	for _, checkpoint := range snapshot.checkpoints {
		if now.Sub(checkpoint.info.ModTime()) < retentionPeriod {
			return false
		}
	}
	return true
}

func legacySnapshotMatchesFile(path string, original os.FileInfo) error {
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || current.Mode().Type() != original.Mode().Type() ||
		!os.SameFile(original, current) || current.Size() != original.Size() ||
		!current.ModTime().Equal(original.ModTime()) {
		return fmt.Errorf("legacy source identity changed: %s", path)
	}
	return nil
}

func verifyLegacySnapshot(snapshot legacySourceSnapshot, removed map[string]bool, directoryRemoved bool) error {
	journalPath := filepath.Join(snapshot.root, snapshot.hash+".log")
	if snapshot.hasJournal && !removed[journalPath] {
		if err := legacySnapshotMatchesFile(snapshot.journal.path, snapshot.journal.info); err != nil {
			return err
		}
	} else if err := requireLegacyPathAbsent(journalPath); err != nil {
		return err
	}

	if directoryRemoved {
		return requireLegacyPathAbsent(snapshot.checkpointDir)
	}
	if snapshot.checkpointDirInfo == nil {
		return requireLegacyPathAbsent(snapshot.checkpointDir)
	}
	currentDir, err := os.Lstat(snapshot.checkpointDir)
	if err != nil {
		return err
	}
	if !currentDir.IsDir() || !os.SameFile(snapshot.checkpointDirInfo, currentDir) {
		return fmt.Errorf("legacy checkpoint directory identity changed: %s", snapshot.checkpointDir)
	}
	entries, err := os.ReadDir(snapshot.checkpointDir)
	if err != nil {
		return err
	}
	expected := make(map[string]legacyFileSnapshot, len(snapshot.checkpoints))
	for _, checkpoint := range snapshot.checkpoints {
		if !removed[checkpoint.path] {
			expected[checkpoint.path] = checkpoint
		}
	}
	actual := make(map[string]bool)
	for _, entry := range entries {
		if !legacyCheckpointName(entry.Name()) {
			continue
		}
		path := filepath.Join(snapshot.checkpointDir, entry.Name())
		actual[path] = true
	}
	if len(actual) != len(expected) {
		return fmt.Errorf("legacy checkpoint membership changed: %s", snapshot.checkpointDir)
	}
	for path, checkpoint := range expected {
		if !actual[path] {
			return fmt.Errorf("legacy checkpoint membership changed: %s", path)
		}
		if err := legacySnapshotMatchesFile(path, checkpoint.info); err != nil {
			return err
		}
	}
	return nil
}

func requireLegacyPathAbsent(path string) error {
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("legacy source unexpectedly appeared: %s", path)
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

func legacyLiveLocked(h *Hub, hash string) bool {
	matches := func(id string) bool {
		return fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == hash
	}
	for id := range h.panes {
		if matches(id) {
			return true
		}
	}
	for id := range h.paneOwners {
		if matches(id) {
			return true
		}
	}
	return false
}

func legacyCurrentOwnerLocked(h *Hub, hash string) bool {
	if legacyLiveLocked(h, hash) {
		return true
	}
	for id := range h.archives {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == hash {
			return true
		}
	}
	return false
}

func legacySavedHashes(saved map[string]bool) map[string]bool {
	hashes := make(map[string]bool, len(saved))
	for id := range saved {
		hashes[fmt.Sprintf("%x", sha256.Sum256([]byte(id)))] = true
	}
	return hashes
}

func legacyFailure(stats *retentionSweepStats, path string, err error) {
	stats.FailedPaths = append(stats.FailedPaths, path)
	log.Printf("[ws] legacy retention cannot finalize %s: %v", path, err)
}

func (h *Hub) sweepLegacySources(root string, saved map[string]bool, now time.Time, stats *retentionSweepStats) {
	start := time.Now()
	info, err := os.Lstat(root)
	if err != nil {
		legacyFailure(stats, root, err)
		return
	}
	if !info.IsDir() {
		legacyFailure(stats, root, fmt.Errorf("recording namespace is not a real directory"))
		return
	}
	defer func() {
		if err := legacySyncDir(root); err != nil {
			legacyFailure(stats, root, err)
		}
	}()
	entries, err := os.ReadDir(root)
	if err != nil {
		legacyFailure(stats, root, err)
		return
	}
	journals := make(map[string]bool)
	for _, entry := range entries {
		if hash, ok := legacyJournalHash(entry.Name()); ok {
			journals[hash] = true
		}
	}
	savedHashes := legacySavedHashes(saved)
	candidates := 0
	for _, entry := range entries {
		hash, ok := legacyJournalHash(entry.Name())
		if !ok {
			continue
		}
		candidates++
		snapshot, err := snapshotLegacySource(root, hash, true)
		if err != nil {
			if errors.Is(err, errLegacyUnsafeType) {
				continue
			}
			legacyFailure(stats, filepath.Join(root, entry.Name()), err)
			continue
		}
		if !legacySnapshotTimesSafe(snapshot, now) {
			continue
		}
		h.sweepLegacyJournal(snapshot, savedHashes, now, stats)
	}
	for _, entry := range entries {
		hash, ok := legacyCheckpointDirHash(entry.Name())
		if !ok || journals[hash] {
			continue
		}
		candidates++
		snapshot, err := snapshotLegacySource(root, hash, false)
		if err != nil {
			if errors.Is(err, errLegacyUnsafeType) {
				continue
			}
			legacyFailure(stats, filepath.Join(root, entry.Name()), err)
			continue
		}
		if !legacySnapshotTimesSafe(snapshot, now) || !legacySnapshotExpired(snapshot, now) {
			continue
		}
		syncDirs, failPath, err := retireLegacySources(snapshot, stats)
		if err != nil && failPath != "" {
			legacyFailure(stats, failPath, err)
		}
		syncLegacyDirs(syncDirs, stats)
	}
	if candidates > 0 {
		log.Printf("[ws] legacy retention sweep handled %d sources in %s", candidates, time.Since(start))
	}
}

// sweepLegacyJournal deletes an expired legacy journal. It never imports:
// the VT-based importer is gone, and every legacy journal is older than the
// retention period on any binary that still has one on disk, so the
// expired branch is the only branch that can run. Unexpired sources are
// left for a later sweep.
func (h *Hub) sweepLegacyJournal(snapshot legacySourceSnapshot, saved map[string]bool, now time.Time, stats *retentionSweepStats) {
	if !legacySnapshotExpired(snapshot, now) {
		return
	}
	if saved[snapshot.hash] {
		return
	}
	h.mu.RLock()
	live := legacyLiveLocked(h, snapshot.hash)
	h.mu.RUnlock()
	if live {
		return
	}
	syncDirs, failPath, err := retireLegacySources(snapshot, stats)
	if err != nil && failPath != "" {
		legacyFailure(stats, failPath, err)
	}
	syncLegacyDirs(syncDirs, stats)
}

// retireLegacySources unlinks recognized legacy files under the caller's
// lock and returns the directories needing a durability sync. The caller
// runs syncLegacyDirs after releasing the lock: unlinks stay ordered
// before their barrier, but Ingest never blocks on a directory fsync.
// Unlink and identity errors still abort the remaining unlinks.
func retireLegacySources(snapshot legacySourceSnapshot, stats *retentionSweepStats) (syncDirs []string, failPath string, err error) {
	removed := make(map[string]bool, len(snapshot.checkpoints)+1)
	directoryRemoved := false
	for _, checkpoint := range snapshot.checkpoints {
		if err := verifyLegacySnapshot(snapshot, removed, directoryRemoved); err != nil {
			return partialLegacySyncDirs(snapshot, removed), checkpoint.path, err
		}
		if err := legacyRemove(checkpoint.path); err != nil {
			return partialLegacySyncDirs(snapshot, removed), checkpoint.path, err
		}
		removed[checkpoint.path] = true
		stats.BytesReclaimed += uint64(checkpoint.info.Size())
	}
	if len(snapshot.checkpoints) > 0 {
		syncDirs = append(syncDirs, snapshot.checkpointDir)
	}
	if snapshot.checkpointDirInfo != nil {
		if err := verifyLegacySnapshot(snapshot, removed, false); err != nil {
			return syncDirs, snapshot.checkpointDir, err
		}
		entries, err := os.ReadDir(snapshot.checkpointDir)
		if err != nil {
			return syncDirs, snapshot.checkpointDir, err
		}
		if len(entries) == 0 {
			if err := legacyRemove(snapshot.checkpointDir); err != nil {
				if !os.IsNotExist(err) {
					return syncDirs, snapshot.checkpointDir, err
				}
				if err := requireLegacyPathAbsent(snapshot.checkpointDir); err != nil {
					return syncDirs, snapshot.checkpointDir, err
				}
			}
			directoryRemoved = true
			// A removed directory needs no barrier; its parent does.
			kept := syncDirs[:0]
			for _, dir := range syncDirs {
				if dir != snapshot.checkpointDir {
					kept = append(kept, dir)
				}
			}
			syncDirs = kept
			syncDirs = append(syncDirs, snapshot.root)
		}
	}
	journalPath := filepath.Join(snapshot.root, snapshot.hash+".log")
	if snapshot.hasJournal {
		if err := verifyLegacySnapshot(snapshot, removed, directoryRemoved); err != nil {
			return syncDirs, snapshot.journal.path, err
		}
		if err := legacyRemove(snapshot.journal.path); err != nil {
			return syncDirs, snapshot.journal.path, err
		}
		removed[journalPath] = true
		stats.BytesReclaimed += uint64(snapshot.journal.info.Size())
		syncDirs = append(syncDirs, snapshot.root)
	}
	return syncDirs, "", nil
}

// partialLegacySyncDirs covers an aborted checkpoint loop: removed
// checkpoints still need their directory barrier on the way out.
func partialLegacySyncDirs(snapshot legacySourceSnapshot, removed map[string]bool) []string {
	if snapshot.checkpointDirInfo == nil || len(removed) == 0 {
		return nil
	}
	return []string{snapshot.checkpointDir}
}

// syncLegacyDirs runs the post-unlink durability barrier without the hub
// lock. A failed barrier only means a later sweep must repeat it; the
// end-of-pass root sync is that retry for the recording root.
func syncLegacyDirs(dirs []string, stats *retentionSweepStats) {
	seen := make(map[string]bool, len(dirs))
	for _, dir := range dirs {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		if err := legacySyncDir(dir); err != nil {
			legacyFailure(stats, dir, err)
		}
	}
}
