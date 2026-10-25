package ws

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/termstate"
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
		h.sweepLegacySources(dir, saved, now, &stats)
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
		syncLegacyDirs(h.finalizeLegacyCandidate(root, snapshot, "", savedHashes, now, stats), stats)
	}
	if candidates > 0 {
		log.Printf("[ws] legacy retention sweep handled %d sources in %s", candidates, time.Since(start))
	}
}

func (h *Hub) sweepLegacyJournal(snapshot legacySourceSnapshot, saved map[string]bool, now time.Time, stats *retentionSweepStats) {
	if legacySnapshotExpired(snapshot, now) {
		if !saved[snapshot.hash] {
			h.mu.RLock()
			live := legacyLiveLocked(h, snapshot.hash)
			h.mu.RUnlock()
			if !live {
				syncLegacyDirs(h.finalizeLegacyCandidate(snapshot.root, snapshot, "", saved, now, stats), stats)
				return
			}
		}
		// Expired but protected (saved or live): only a valid existing
		// v2 can retire the sources, never a new conversion.
		syncLegacyDirs(h.sweepLegacyAuthority(snapshot, stats), stats)
		return
	}
	h.mu.RLock()
	eligible := h.leaseHeld && h.recordingDirectory == snapshot.root && !legacyCurrentOwnerLocked(h, snapshot.hash)
	h.mu.RUnlock()
	v2 := filepath.Join(snapshot.root, "v2")
	if info, err := os.Lstat(v2); err != nil || !info.IsDir() {
		if err == nil {
			err = fmt.Errorf("v2 namespace is not a real directory")
		}
		legacyFailure(stats, v2, err)
		return
	}
	destination := filepath.Join(v2, snapshot.hash)
	if _, err := os.Lstat(destination); err == nil {
		// An existing destination is never converted over. A live or
		// archived owner keeps authority; only the read-only validator
		// below can retire sources beside it.
		syncLegacyDirs(h.sweepLegacyAuthority(snapshot, stats), stats)
		return
	} else if !os.IsNotExist(err) {
		legacyFailure(stats, destination, err)
		return
	}
	if !eligible {
		return
	}
	staging, err := os.MkdirTemp(v2, ".import-*")
	if err != nil {
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	if _, err := stageLegacyImport(snapshot.journal.path, staging, snapshot.journal.info.Size(), snapshot.journal.info.ModTime()); err != nil {
		if removeErr := os.RemoveAll(staging); removeErr != nil {
			legacyFailure(stats, staging, removeErr)
		}
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	syncLegacyDirs(h.finalizeLegacyCandidate(snapshot.root, snapshot, staging, saved, now, stats), stats)
}

// errLegacyAuthorityDefer marks a silent deferral: no v2 destination, an
// owner the validator must not disturb, or state that changed between
// phases. A later sweep retries; nothing is reported.
var errLegacyAuthorityDefer = errors.New("legacy authority deferred")

// legacyAuthorityDep pins one committed segment dependency: the raw and
// resize files must cover their committed lengths (a missing file is
// allowed only for a zero committed length, mirroring openCommitFile),
// while a checkpoint must match its committed length exactly.
type legacyAuthorityDep struct {
	rawInfo  os.FileInfo
	rawSize  int64
	rszInfo  os.FileInfo
	rszSize  int64
	ckptInfo os.FileInfo
}

// legacyAuthorityCkpt is a bounded copy of one committed base checkpoint
// for lock-free parser usability checks.
type legacyAuthorityCkpt struct {
	start uint64
	data  []byte
}

// legacyAuthoritySnapshot pins the existing v2 state a legacy cleanup
// validated: ownership, manifest identity/bytes, dependency identities, and
// bounded checkpoint copies for lock-free parser usability checks.
type legacyAuthoritySnapshot struct {
	hash         string
	pane         *PaneHub
	archive      *PaneHub
	readLoop     *pty.PTYInstance
	recording    *retentionGroup
	destDir      string
	destDirInfo  os.FileInfo
	manifestPath string
	manifestInfo os.FileInfo
	manifestData []byte
	manifest     retentionManifest
	deps         []legacyAuthorityDep
	ckpts        []legacyAuthorityCkpt
	sourceHead   uint64
	sourceTime   time.Time
}

// legacyOwnersLocked resolves the pane, archive, and read-loop owners for a
// legacy hash. The caller holds h.mu.
func legacyOwnersLocked(h *Hub, hash string) (pane, archive *PaneHub, readLoop *pty.PTYInstance) {
	for id, ph := range h.panes {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == hash {
			pane = ph
			break
		}
	}
	for id, ph := range h.archives {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == hash {
			archive = ph
			break
		}
	}
	for id, inst := range h.paneOwners {
		if fmt.Sprintf("%x", sha256.Sum256([]byte(id))) == hash {
			readLoop = inst
			break
		}
	}
	return pane, archive, readLoop
}

// scanLegacySourceHead opens the retained journal read-only and returns its
// committed output head. The caller holds no locks.
func scanLegacySourceHead(snapshot legacySourceSnapshot) (uint64, error) {
	if !snapshot.hasJournal {
		return 0, fmt.Errorf("legacy source has no journal")
	}
	f, err := os.Open(snapshot.journal.path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !os.SameFile(snapshot.journal.info, info) {
		if err == nil {
			err = fmt.Errorf("legacy source identity changed: %s", snapshot.journal.path)
		}
		return 0, err
	}
	scan, err := scanLegacyLog(f, snapshot.journal.info.Size(), nil)
	if err != nil {
		return 0, err
	}
	return scan.head, nil
}

// captureLegacyAuthority runs phase A of the existing-authority validator
// under h.mu (then the owner lock): it pins ownership, the destination
// directory, exact manifest bytes, referenced dependency identities, and
// bounded checkpoint copies. An unavailable, closed, ephemeral, or pending
// owned recording defers silently; anything malformed fails loudly.
func (h *Hub) captureLegacyAuthority(root, hash string, sourceHead uint64, sourceTime time.Time) (*legacyAuthoritySnapshot, error) {
	snap := &legacyAuthoritySnapshot{hash: hash, sourceHead: sourceHead, sourceTime: sourceTime}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.leaseHeld || h.recordingDirectory != root {
		return nil, fmt.Errorf("%w: namespace lease lost", errLegacyAuthorityDefer)
	}
	snap.pane, snap.archive, snap.readLoop = legacyOwnersLocked(h, hash)
	owner := snap.pane
	if owner == nil {
		owner = snap.archive
	}
	if owner != nil {
		owner.mu.Lock()
		defer owner.mu.Unlock()
		snap.recording = owner.recording
		switch {
		case snap.recording == nil:
			return nil, fmt.Errorf("%w: owned recording unavailable", errLegacyAuthorityDefer)
		case snap.recording.isClosed():
			return nil, fmt.Errorf("%w: owned recording closed", errLegacyAuthorityDefer)
		case snap.recording.ephemeral:
			return nil, fmt.Errorf("%w: owned recording ephemeral", errLegacyAuthorityDefer)
		case snap.recording.pending != nil || owner.pendingResize != nil:
			return nil, fmt.Errorf("%w: owned recording has a pending commit", errLegacyAuthorityDefer)
		}
	}
	snap.destDir = filepath.Join(root, "v2", hash)
	dirInfo, err := os.Lstat(snap.destDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: destination absent", errLegacyAuthorityDefer)
		}
		return nil, err
	}
	if !dirInfo.IsDir() {
		return nil, fmt.Errorf("legacy destination is not a real directory: %s", snap.destDir)
	}
	snap.destDirInfo = dirInfo
	snap.manifestPath = filepath.Join(snap.destDir, "MANIFEST")
	manifestInfo, err := os.Lstat(snap.manifestPath)
	if err != nil {
		return nil, err
	}
	if !manifestInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("retention manifest is not a regular file")
	}
	data, err := readRetentionManifest(snap.manifestPath)
	if err != nil {
		return nil, err
	}
	manifest, err := decodeRetentionManifest(data)
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(snap.manifestPath)
	if err != nil {
		return nil, err
	}
	if !os.SameFile(manifestInfo, after) || after.Size() != manifestInfo.Size() || !after.ModTime().Equal(manifestInfo.ModTime()) {
		return nil, fmt.Errorf("retention manifest changed during capture")
	}
	snap.manifestInfo = manifestInfo
	snap.manifestData = data
	snap.manifest = manifest
	for i := 1; i < len(manifest.segs); i++ {
		prev, cur := manifest.segs[i-1], manifest.segs[i]
		if cur.start != prev.start+prev.rawLen {
			return nil, fmt.Errorf("retention segments are not contiguous")
		}
	}
	for _, seg := range manifest.segs {
		dep, ckpt, err := captureLegacyAuthorityDep(snap.destDir, seg, manifest.head)
		if err != nil {
			return nil, err
		}
		snap.deps = append(snap.deps, dep)
		if ckpt != nil {
			snap.ckpts = append(snap.ckpts, *ckpt)
		}
	}
	return snap, nil
}

// openLegacyAuthorityDep pins one committed raw/resize dependency read-only.
// A missing file is allowed only for a zero committed length, mirroring
// openCommitFile; a present file must cover its committed length.
func openLegacyAuthorityDep(path string, committed int64) (os.FileInfo, *os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) && committed == 0 {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("retention dependency is not a regular file: %s", path)
	}
	if info.Size() < committed {
		return nil, nil, fmt.Errorf("committed retention bytes are missing: %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	if stat, err := f.Stat(); err != nil || !os.SameFile(info, stat) {
		f.Close()
		if err == nil {
			err = fmt.Errorf("retention file changed during open: %s", path)
		}
		return nil, nil, err
	}
	return info, f, nil
}

// captureLegacyAuthorityDep pins one segment: committed raw prefixes stream
// cleanly, committed resize records decode, and referenced checkpoints
// match exact committed lengths with bounded copies.
func captureLegacyAuthorityDep(dir string, seg retentionSegDesc, head uint64) (legacyAuthorityDep, *legacyAuthorityCkpt, error) {
	var dep legacyAuthorityDep
	base := filepath.Join(dir, retentionSegBase(seg.gen))
	rawInfo, raw, err := openLegacyAuthorityDep(base+".raw", int64(seg.rawLen))
	if err != nil {
		return dep, nil, err
	}
	if raw != nil {
		defer raw.Close()
		dep.rawInfo, dep.rawSize = rawInfo, rawInfo.Size()
		if _, err := io.CopyN(io.Discard, raw, int64(seg.rawLen)); err != nil {
			return dep, nil, err
		}
	}
	rszInfo, rsz, err := openLegacyAuthorityDep(base+".rsz", int64(seg.rszCount)*retentionRszRecLen)
	if err != nil {
		return dep, nil, err
	}
	if rsz != nil {
		defer rsz.Close()
		dep.rszInfo, dep.rszSize = rszInfo, rszInfo.Size()
		if _, err := loadResizeCache(rsz, seg.rszCount, seg.start, head); err != nil {
			return dep, nil, err
		}
	}
	ckptPath := base + ".ckpt"
	if seg.ckptLen == 0 {
		if _, err := os.Lstat(ckptPath); err == nil {
			return dep, nil, fmt.Errorf("retention checkpoint contradicts unavailable base")
		} else if !os.IsNotExist(err) {
			return dep, nil, err
		}
		return dep, nil, nil
	}
	ckptInfo, err := os.Lstat(ckptPath)
	if err != nil {
		return dep, nil, err
	}
	if !ckptInfo.Mode().IsRegular() || ckptInfo.Size() != int64(seg.ckptLen) {
		return dep, nil, fmt.Errorf("retention base checkpoint size mismatch")
	}
	ckpt, err := os.Open(ckptPath)
	if err != nil {
		return dep, nil, err
	}
	defer ckpt.Close()
	if stat, err := ckpt.Stat(); err != nil || !os.SameFile(ckptInfo, stat) {
		if err == nil {
			err = fmt.Errorf("retention checkpoint changed during open")
		}
		return dep, nil, err
	}
	data := make([]byte, seg.ckptLen)
	if _, err := io.ReadFull(ckpt, data); err != nil {
		return dep, nil, err
	}
	dep.ckptInfo = ckptInfo
	return dep, &legacyAuthorityCkpt{start: seg.start, data: data}, nil
}

// checkLegacyAuthorityUsable runs phase B of the existing-authority
// validator with no locks held: captured checkpoints at or below the
// public base floor restore on disposable parsers, newest first. Fresh-
// parser fallback needs an intact zero prefix (first-segment start zero
// with start ordinal one; capture already proved committed output/resize
// coverage) and a working parser constructor.
func checkLegacyAuthorityUsable(snap *legacyAuthoritySnapshot) error {
	m := snap.manifest
	floor := m.segs[0].start
	if window := m.head - min(m.head, retentionHistoryCap); window > floor {
		floor = window
	}
	for i := len(snap.ckpts) - 1; i >= 0; i-- {
		ckpt := snap.ckpts[i]
		if ckpt.start > floor {
			continue
		}
		state, err := restoreAnchor(ckpt.data)
		if err != nil {
			continue
		}
		parser, err := termstate.New(context.Background(), 80, 24)
		if err != nil {
			return err
		}
		restoreErr := parser.Restore(state)
		closeErr := parser.Close()
		if restoreErr == nil && closeErr == nil {
			return nil
		}
	}
	if m.segs[0].start == 0 && m.segs[0].startOrdinal == 1 {
		probe, err := termstate.New(context.Background(), 80, 24)
		if err != nil {
			return err
		}
		if err := probe.Close(); err != nil {
			return err
		}
		return nil
	}
	return fmt.Errorf("no usable retained base checkpoint")
}

// finalizeLegacyAuthority runs phase C of the existing-authority validator
// under h.mu (then the owner lock): it requires the identical owners,
// destination, manifest bytes, and dependency inodes the capture pinned,
// then requires the committed head to cover the source head with a
// durable time at least the source time before retiring the sources.
// Ownership or committed-state changes defer silently; head/time
// shortfalls, sync failures, and source-identity changes report.
func (h *Hub) finalizeLegacyAuthority(snapshot legacySourceSnapshot, authority *legacyAuthoritySnapshot, stats *retentionSweepStats) (syncDirs []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.leaseHeld || h.recordingDirectory != snapshot.root {
		return
	}
	pane, archive, readLoop := legacyOwnersLocked(h, authority.hash)
	if pane != authority.pane || archive != authority.archive || readLoop != authority.readLoop {
		return
	}
	owner := pane
	if owner == nil {
		owner = archive
	}
	if owner != nil {
		owner.mu.Lock()
		defer owner.mu.Unlock()
		rec := owner.recording
		if rec != authority.recording || rec == nil || rec.isClosed() || rec.ephemeral || rec.pending != nil || owner.pendingResize != nil {
			return
		}
	} else if authority.recording != nil {
		return
	}
	dirInfo, err := os.Lstat(authority.destDir)
	if err != nil || !dirInfo.IsDir() || !os.SameFile(authority.destDirInfo, dirInfo) {
		return
	}
	manifestInfo, err := os.Lstat(authority.manifestPath)
	if err != nil || !manifestInfo.Mode().IsRegular() || !os.SameFile(authority.manifestInfo, manifestInfo) ||
		manifestInfo.Size() != authority.manifestInfo.Size() || !manifestInfo.ModTime().Equal(authority.manifestInfo.ModTime()) {
		return
	}
	manifestData, err := readRetentionManifest(authority.manifestPath)
	if err != nil || !bytes.Equal(manifestData, authority.manifestData) {
		return
	}
	for i, seg := range authority.manifest.segs {
		dep := authority.deps[i]
		base := filepath.Join(authority.destDir, retentionSegBase(seg.gen))
		if !legacyAuthorityDepUnchanged(base+".raw", dep.rawInfo, dep.rawSize) {
			return
		}
		if !legacyAuthorityDepUnchanged(base+".rsz", dep.rszInfo, dep.rszSize) {
			return
		}
		ckptPath := base + ".ckpt"
		if seg.ckptLen == 0 {
			if _, err := os.Lstat(ckptPath); err == nil || !os.IsNotExist(err) {
				return
			}
			continue
		}
		ckptInfo, err := os.Lstat(ckptPath)
		if err != nil || !ckptInfo.Mode().IsRegular() || !os.SameFile(dep.ckptInfo, ckptInfo) ||
			ckptInfo.Size() != int64(seg.ckptLen) || !ckptInfo.ModTime().Equal(dep.ckptInfo.ModTime()) {
			return
		}
	}
	m := authority.manifest
	// A v2 that does not cover the source is not authoritative yet (or,
	// for a static group, ever): preserve the sources and let a later
	// sweep retry. This deferral is silent like every other authority
	// deferral; only I/O, identity, and durability errors are failures.
	if m.head < authority.sourceHead {
		return
	}
	if m.lastUpdateNs < authority.sourceTime.UnixNano() {
		return
	}
	// These two syncs stay under the lock: an interrupted publish left the
	// destination visible but not durable, so they must precede the source
	// unlinks below. Only the post-unlink barrier moves out.
	if err := legacySyncDir(authority.destDir); err != nil {
		legacyFailure(stats, authority.destDir, err)
		return
	}
	if err := legacySyncDir(filepath.Join(snapshot.root, "v2")); err != nil {
		legacyFailure(stats, filepath.Join(snapshot.root, "v2"), err)
		return
	}
	if err := verifyLegacySnapshot(snapshot, nil, false); err != nil {
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	dirs, path, err := retireLegacySources(snapshot, stats)
	if err != nil {
		legacyFailure(stats, path, err)
	}
	return dirs
}

// legacyAuthorityDepUnchanged requires a raw/resize dependency to keep its
// capture identity while permitting growth beyond committed lengths.
func legacyAuthorityDepUnchanged(path string, pinned os.FileInfo, pinnedSize int64) bool {
	if pinned == nil {
		_, err := os.Lstat(path)
		return os.IsNotExist(err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(pinned, info) {
		return false
	}
	return info.Size() >= pinnedSize
}

// sweepLegacyAuthority retires redundant legacy sources beside a valid
// existing v2 without replacing, reopening, or flushing it: an unlocked
// source scan, a locked capture, lock-free parser usability checks, and a
// locked recheck with deletion.
func (h *Hub) sweepLegacyAuthority(snapshot legacySourceSnapshot, stats *retentionSweepStats) (syncDirs []string) {
	if !snapshot.hasJournal {
		return
	}
	destination := filepath.Join(snapshot.root, "v2", snapshot.hash)
	if info, err := os.Lstat(destination); err != nil {
		if os.IsNotExist(err) {
			return
		}
		legacyFailure(stats, destination, err)
		return
	} else if !info.IsDir() {
		legacyFailure(stats, destination, fmt.Errorf("legacy destination is not a real directory: %s", destination))
		return
	}
	sourceHead, err := scanLegacySourceHead(snapshot)
	if err != nil {
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	authority, err := h.captureLegacyAuthority(snapshot.root, snapshot.hash, sourceHead, snapshot.journal.info.ModTime())
	if err != nil {
		if errors.Is(err, errLegacyAuthorityDefer) {
			return
		}
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	if err := checkLegacyAuthorityUsable(authority); err != nil {
		legacyFailure(stats, snapshot.journal.path, err)
		return
	}
	return h.finalizeLegacyAuthority(snapshot, authority, stats)
}

func (h *Hub) finalizeLegacyCandidate(root string, snapshot legacySourceSnapshot, staging string, saved map[string]bool, now time.Time, stats *retentionSweepStats) (syncDirs []string) {
	if staging != "" {
		defer func() {
			if err := os.RemoveAll(staging); err != nil {
				legacyFailure(stats, staging, err)
			}
		}()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.leaseHeld || h.recordingDirectory != root {
		return
	}
	expired := legacySnapshotExpired(snapshot, now)
	if snapshot.orphan || expired {
		if !expired || saved[snapshot.hash] || legacyLiveLocked(h, snapshot.hash) {
			return
		}
		dirs, path, err := retireLegacySources(snapshot, stats)
		if err != nil {
			legacyFailure(stats, path, err)
		}
		return dirs
	}
	if staging == "" || legacyCurrentOwnerLocked(h, snapshot.hash) {
		return
	}
	v2 := filepath.Join(root, "v2")
	if info, err := os.Lstat(v2); err != nil || !info.IsDir() {
		if err == nil {
			err = fmt.Errorf("v2 namespace is not a real directory")
		}
		legacyFailure(stats, v2, err)
		return
	}
	destination := filepath.Join(v2, snapshot.hash)
	if _, err := os.Lstat(destination); err == nil {
		return
	} else if !os.IsNotExist(err) {
		legacyFailure(stats, destination, err)
		return
	}
	if staging != "" {
		if err := verifyLegacySnapshot(snapshot, nil, false); err != nil {
			legacyFailure(stats, snapshot.journal.path, err)
			return
		}
		if err := importRename(staging, destination); err != nil {
			legacyFailure(stats, snapshot.journal.path, fmt.Errorf("publish replacement: %w", err))
			return
		}
		// The publish barrier stays under the lock: the replacement must
		// be durable before its sources are unlinked below.
		if err := legacySyncDir(v2); err != nil {
			legacyFailure(stats, snapshot.journal.path, fmt.Errorf("sync published replacement: %w", err))
			return
		}
		if err := verifyLegacySnapshot(snapshot, nil, false); err != nil {
			legacyFailure(stats, snapshot.journal.path, err)
			return
		}
	}
	dirs, path, err := retireLegacySources(snapshot, stats)
	if err != nil {
		legacyFailure(stats, path, err)
	}
	return dirs
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
