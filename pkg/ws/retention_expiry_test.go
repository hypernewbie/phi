package ws

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

func TestClosureMarksGroupAndSweepExpiresAfterSevenDays(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("pane", []byte("closed history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	path := groupDir(t, dir, "pane")
	if _, err := os.Stat(filepath.Join(path, "MANIFEST")); err != nil {
		t.Fatalf("closed group missing manifest: %v", err)
	}
	fc.Advance(7*24*time.Hour + time.Hour)
	stats := h.sweepRetention(fc.Now())
	if stats.GroupsDeleted != 1 {
		t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
	}
	if stats.BytesReclaimed == 0 {
		t.Fatal("reclaimed bytes not reported")
	}
	if len(stats.FailedPaths) != 0 {
		t.Fatalf("failed paths = %v", stats.FailedPaths)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expired group remains: %v", err)
	}
	h.mu.RLock()
	_, retained := h.archives["pane"]
	h.mu.RUnlock()
	if retained {
		t.Fatal("expired archive entry was not detached")
	}
}

func TestSweepKeepsFreshClosedGroups(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("pane", []byte("fresh history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	fc.Advance(7*24*time.Hour - time.Hour)
	stats := h.sweepRetention(fc.Now())
	if stats.GroupsDeleted != 0 || len(stats.FailedPaths) != 0 {
		t.Fatalf("fresh group swept: %+v", stats)
	}
	if _, err := os.Stat(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST")); err != nil {
		t.Fatalf("fresh group deleted: %v", err)
	}
}

func TestSweepProtectsLiveIdlePanesRegardlessOfAge(t *testing.T) {
	perCommitDurability(t)
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if _, gerr := h.GetOrCreatePaneHub("live"); gerr != nil {
		t.Fatal(gerr)
	}
	if err := h.Ingest("live", []byte("idle terminal\r\n")); err != nil {
		t.Fatal(err)
	}
	// The pane stays live but ingests nothing for over seven days.
	fc.Advance(8 * 24 * time.Hour)
	stats := h.sweepRetention(fc.Now())
	if stats.GroupsDeleted != 0 {
		t.Fatalf("live idle pane swept: %+v", stats)
	}
	if _, err := os.Stat(filepath.Join(groupDir(t, dir, "live"), "MANIFEST")); err != nil {
		t.Fatalf("live group deleted: %v", err)
	}
}

func TestSweepProtectsSavedReservations(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	reserved := map[string]bool{"saved": true}
	h.savedReservations = func() (map[string]bool, error) { return reserved, nil }
	if err := h.Ingest("saved", []byte("saved tab\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("saved")
	fc.Advance(8 * 24 * time.Hour)
	if stats := h.sweepRetention(fc.Now()); stats.GroupsDeleted != 0 {
		t.Fatalf("saved reservation swept: %+v", stats)
	}
	// The tab is gone: normal expiry applies on the next sweep.
	reserved = map[string]bool{}
	if stats := h.sweepRetention(fc.Now()); stats.GroupsDeleted != 1 {
		t.Fatalf("unsaved expired group kept: %+v", stats)
	}
	if _, err := os.Stat(groupDir(t, dir, "saved")); !os.IsNotExist(err) {
		t.Fatalf("expired group remains: %v", err)
	}
}

func TestSweepSkipsWhenReservationsUnreadable(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	h.savedReservations = func() (map[string]bool, error) { return nil, fmt.Errorf("tabs db offline") }
	if err := h.Ingest("pane", []byte("history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	fc.Advance(8 * 24 * time.Hour)
	if stats := h.sweepRetention(fc.Now()); stats.GroupsDeleted != 0 {
		t.Fatalf("sweep deleted without the reservation list: %+v", stats)
	}
	if _, err := os.Stat(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST")); err != nil {
		t.Fatalf("group deleted without reservations: %v", err)
	}
}

func TestOrphanExpiryUsesLastDurableUpdate(t *testing.T) {
	perCommitDurability(t)
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("orphan", []byte("orphaned\r\n")); err != nil {
		t.Fatal(err)
	}
	// Restart without a close event: the group is an orphan with no
	// in-memory closure, so its last durable commit clocks it.
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h2 := NewHub(0)
	h2.clock = fc.Now
	h2.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	if err := h2.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer h2.Close()
	fc.Advance(8 * 24 * time.Hour)
	if stats := h2.sweepRetention(fc.Now()); stats.GroupsDeleted != 1 {
		t.Fatalf("old orphan kept: %+v", stats)
	}
	if _, err := os.Stat(groupDir(t, dir, "orphan")); !os.IsNotExist(err) {
		t.Fatalf("expired orphan remains: %v", err)
	}
}

func TestReadsDoNotRenewTheRetentionClock(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	payload := []byte("stable history\r\n")
	if err := h.Ingest("pane", payload); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	before, err := os.ReadFile(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	fc.Advance(24 * time.Hour)
	if _, ok := h.Recording("pane", 0, uint64(len(payload))); !ok {
		t.Fatal("cold read failed")
	}
	if _, _, _, _, err := h.State("pane"); err == nil {
		// State reads are best-effort here; the clock assertion below is the contract.
		_ = err
	}
	after, err := os.ReadFile(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("a history read rewrote the retention manifest")
	}
	fc.Advance(7 * 24 * time.Hour)
	if stats := h.sweepRetention(fc.Now()); stats.GroupsDeleted != 1 {
		t.Fatalf("read-aged group kept: %+v", stats)
	}
}

func TestSetRecordingDirectoryRejectsSymlinkedNamespaceCleanly(t *testing.T) {
	dir := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(dir, "v2")); err != nil {
		t.Fatal(err)
	}
	h := NewHub(0)
	t.Cleanup(func() { _ = h.Close() })
	if err := h.SetRecordingDirectory(dir); err == nil {
		t.Fatal("symlinked v2 namespace accepted")
	}
	// The caller keeps serving after a setup error: a rejection must
	// leave the hub disabled, never half-configured without a lease.
	if h.recordingDirectory != "" || h.leaseHeld {
		t.Fatalf("rejected directory stored: dir=%q lease=%v", h.recordingDirectory, h.leaseHeld)
	}
	if err := h.Ingest("p", []byte("x\r\n")); err != nil {
		t.Fatalf("Ingest after rejection: %v", err)
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("writes escaped through the rejected link")
	}
}

func TestSweepDetachesColdArchiveOpenedAfterSnapshot(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("gone", []byte("closed history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("gone")
	fc.Advance(7*24*time.Hour + time.Hour)
	// Evict the closed owner, then cold-read it back: the resulting
	// archive simulates one published after the sweep snapshot.
	h.mu.Lock()
	delete(h.archives, "gone")
	h.mu.Unlock()
	if _, ok := h.Recording("gone", 0, 10); !ok {
		t.Fatal("setup: cold read failed")
	}
	name := fmt.Sprintf("%x", sha256.Sum256([]byte("gone")))
	var stats retentionSweepStats
	h.sweepOneGroup(filepath.Join(dir, "v2"), name, fc.Now(), &stats)
	if stats.GroupsDeleted != 1 {
		t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
	}
	h.mu.RLock()
	_, retained := h.archives["gone"]
	h.mu.RUnlock()
	if retained {
		t.Fatal("sweep deleted files under a live archive owner")
	}
	if _, err := os.Stat(groupDir(t, dir, "gone")); !os.IsNotExist(err) {
		t.Fatal("expired group files survive")
	}
	if _, ok := h.Recording("gone", 0, 10); ok {
		t.Fatal("deleted group resurrected")
	}
}

func TestSweepSkipsSymlinkedGroupDirectory(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	victim := t.TempDir()
	old := fc.Now().Add(-8 * 24 * time.Hour).UnixNano()
	manifest := encodeRetentionManifest(retentionManifest{
		head:  10,
		segs:  []retentionSegDesc{{gen: 1, start: 0, rawLen: 10, startOrdinal: 1}},
		flags: retentionFlagClosed, closedAtNs: old, lastUpdateNs: old,
	})
	if err := os.WriteFile(filepath.Join(victim, "MANIFEST"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(victim, "s0000000000000001.raw"), bytes.Repeat([]byte("V"), 10), 0600); err != nil {
		t.Fatal(err)
	}
	before := sha256.Sum256(mustRead(t, filepath.Join(victim, "MANIFEST")))
	link := filepath.Join(dir, "v2", fmt.Sprintf("%064x", 7))
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}
	// The victim manifest reads as expired through the link, but the
	// sweep must not delete through a non-directory group entry.
	_ = h.sweepRetention(fc.Now())
	if sha256.Sum256(mustRead(t, filepath.Join(victim, "MANIFEST"))) != before {
		t.Fatal("sweep deleted through a symlinked group directory")
	}
	if _, err := os.Stat(filepath.Join(victim, "s0000000000000001.raw")); err != nil {
		t.Fatal("sweep deleted segment bytes through the link")
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("sweep removed the link itself")
	}
}

func TestSweepIgnoresUnknownEntriesAndSymlinks(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("pane", []byte("history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	v2 := filepath.Join(dir, "v2")
	unknown := filepath.Join(v2, "not-a-group")
	if err := os.WriteFile(unknown, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	oddDir := filepath.Join(v2, "xyz")
	if err := os.Mkdir(oddDir, 0700); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(groupDir(t, dir, "pane"), filepath.Join(v2, "link")); err != nil {
			t.Fatal(err)
		}
	}
	// An unknown file inside an expired group survives; recognized files go.
	mystery := filepath.Join(groupDir(t, dir, "pane"), "mystery")
	if err := os.WriteFile(mystery, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	fc.Advance(8 * 24 * time.Hour)
	stats := h.sweepRetention(fc.Now())
	if stats.GroupsDeleted != 1 {
		t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
	}
	for _, p := range []string{unknown, oddDir, mystery} {
		if _, err := os.Lstat(p); err != nil {
			t.Fatalf("sweep touched unknown entry %s: %v", p, err)
		}
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Lstat(filepath.Join(v2, "link")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("sweep followed or removed the symlink: %v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST")); !os.IsNotExist(err) {
		t.Fatalf("recognized manifest remains: %v", err)
	}
}

func TestSweepReportsFailedDeletesWithoutClaimingBytes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permission semantics")
	}
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("pane", []byte("history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	path := groupDir(t, dir, "pane")
	if err := os.Chmod(path, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0700) })
	fc.Advance(8 * 24 * time.Hour)
	stats := h.sweepRetention(fc.Now())
	if len(stats.FailedPaths) == 0 {
		t.Fatal("failed delete reported no path")
	}
	if stats.BytesReclaimed != 0 {
		t.Fatalf("claimed %d bytes that remain allocated", stats.BytesReclaimed)
	}
	if _, err := os.Stat(filepath.Join(path, "MANIFEST")); err != nil {
		t.Fatalf("failed delete removed the manifest: %v", err)
	}
}

func TestLeaseConflictFallsBackToEphemeral(t *testing.T) {
	dir := t.TempDir()
	h1 := NewHub(0)
	if err := h1.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	defer h1.Close()
	if !h1.leaseHeld {
		t.Fatal("first hub did not acquire the lease")
	}
	h2 := NewHub(0)
	if err := h2.SetRecordingDirectory(dir); err != nil {
		t.Fatalf("second hub must degrade, not fail: %v", err)
	}
	defer h2.Close()
	if h2.leaseHeld {
		t.Fatal("second hub claims a held lease")
	}
	// Live terminals stay usable on bounded private storage.
	if err := h2.Ingest("pane", []byte("ephemeral\r\n")); err != nil {
		t.Fatal(err)
	}
	if _, ok := h2.Recording("pane", 0, 11); !ok {
		t.Fatal("ephemeral fallback cannot serve its own writes")
	}
	if _, err := os.Stat(groupDir(t, dir, "pane")); !os.IsNotExist(err) {
		t.Fatalf("conflicted hub wrote the owned namespace: %v", err)
	}
	if stats := h2.sweepRetention(time.Now()); stats.GroupsDeleted != 0 {
		t.Fatalf("conflicted hub swept: %+v", stats)
	}
	// Releasing the first hub frees the namespace for the next owner.
	if err := h1.Close(); err != nil {
		t.Fatal(err)
	}
	h3 := NewHub(0)
	defer h3.Close()
	if err := h3.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if !h3.leaseHeld {
		t.Fatal("lease was not released on close")
	}
}

func TestSetRecordingDirectoryIsRepeatable(t *testing.T) {
	dir := t.TempDir()
	h := NewHub(0)
	defer h.Close()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	// A repeat call must not flock-conflict with itself into ephemeral mode.
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	if !h.leaseHeld {
		t.Fatal("repeat SetRecordingDirectory lost the namespace lease")
	}
	if err := h.Ingest("pane", []byte("held\r\n")); err != nil {
		t.Fatal(err)
	}
}

func TestLeaseConflictAcrossProcesses(t *testing.T) {
	if os.Getenv("PHI_LEASE_HOLDER") == "1" {
		path := os.Getenv("PHI_LEASE_PATH")
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			os.Exit(2)
		}
		defer f.Close()
		if err := lockFileBlocking(f); err != nil {
			os.Exit(3)
		}
		fmt.Println("ready")
		select {}
	}
	dir := t.TempDir()
	v2 := filepath.Join(dir, "v2")
	if err := os.MkdirAll(v2, 0700); err != nil {
		t.Fatal(err)
	}
	leasePath := filepath.Join(v2, "lease")
	cmd := exec.Command(os.Args[0], "-test.run", "TestLeaseConflictAcrossProcesses")
	cmd.Env = append(os.Environ(), "PHI_LEASE_HOLDER=1", "PHI_LEASE_PATH="+leasePath)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	buf := make([]byte, 64)
	if _, err := out.Read(buf); err != nil || !strings.Contains(string(buf), "ready") {
		t.Fatalf("holder child never locked: %v", err)
	}
	h := NewHub(0)
	defer h.Close()
	if err := h.SetRecordingDirectory(dir); err != nil {
		t.Fatalf("conflicted hub must degrade, not fail: %v", err)
	}
	if h.leaseHeld {
		t.Fatal("hub claims a lease held by another process")
	}
}

func TestPromotionClearsClosure(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	if err := h.Ingest("pane", []byte("history\r\n")); err != nil {
		t.Fatal(err)
	}
	h.ClosePane("pane")
	if _, gerr := h.GetOrCreatePaneHub("pane"); gerr != nil {
		t.Fatal(gerr)
	}
	data, err := os.ReadFile(filepath.Join(groupDir(t, dir, "pane"), "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := decodeRetentionManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	if m.flags&retentionFlagClosed != 0 || m.closedAtNs != 0 {
		t.Fatalf("promoted group still closed: flags=%d closedAt=%d", m.flags, m.closedAtNs)
	}
}

func TestArchiveMapBoundedByExpiry(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h := NewHub(0)
	h.clock = fc.Now
	h.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	defer h.Close()
	for _, id := range []string{"a", "b", "c"} {
		if err := h.Ingest(id, []byte("ephemeral\r\n")); err != nil {
			t.Fatal(err)
		}
		h.ClosePane(id)
	}
	fc.Advance(8 * 24 * time.Hour)
	h.sweepRetention(fc.Now())
	h.mu.RLock()
	n := len(h.archives)
	h.mu.RUnlock()
	if n != 0 {
		t.Fatalf("%d expired ephemeral archives retained", n)
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
