package ws

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func paneHash(paneID string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(paneID)))
}

func writeTestFile(t *testing.T, path string, content []byte, modTime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	if !modTime.IsZero() {
		if err := os.Chtimes(path, modTime, modTime); err != nil {
			t.Fatal(err)
		}
	}
}

func setDirModTime(t *testing.T, dir string, modTime time.Time) {
	t.Helper()
	if err := os.Chtimes(dir, modTime, modTime); err != nil {
		t.Fatal(err)
	}
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func edgeExpiryTestHub(t *testing.T, fc *fakeClock) (*Hub, string) {
	t.Helper()
	h, dir := expiryTestHub(t, fc)
	if err := os.MkdirAll(filepath.Join(dir, "v2"), 0700); err != nil {
		t.Fatal(err)
	}
	return h, dir
}

func TestRetentionExpiryEdge_LegacySweep(t *testing.T) {
	baseTime := time.Unix(1_900_000_000, 0)
	expiredTime := baseTime.Add(-retentionPeriod - 2*time.Hour)
	recentTime := baseTime.Add(-retentionPeriod + 24*time.Hour)
	futureTime := baseTime.Add(2 * time.Hour)

	t.Run("ExpiredUnreservedLogRemoved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("expired-unreserved-legacy")
		logPath := filepath.Join(dir, hash+".log")
		ckptDir := filepath.Join(dir, hash+".log.state.d")
		ckptFile := filepath.Join(ckptDir, fmt.Sprintf("%020d.state", 1))

		writeTestFile(t, ckptFile, []byte("checkpoint-state-bytes"), expiredTime)
		setDirModTime(t, ckptDir, expiredTime)
		writeTestFile(t, logPath, []byte("legacy-log-contents-here"), expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(logPath) {
			t.Fatalf("expired legacy log was not removed: %s", logPath)
		}
		if pathExists(ckptDir) {
			t.Fatalf("expired legacy checkpoint dir was not removed: %s", ckptDir)
		}
		expectedReclaimed := uint64(len("checkpoint-state-bytes") + len("legacy-log-contents-here"))
		if stats.BytesReclaimed != expectedReclaimed {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, expectedReclaimed)
		}
		if len(stats.FailedPaths) != 0 {
			t.Fatalf("unexpected failed paths: %v", stats.FailedPaths)
		}
	})

	t.Run("UnexpiredLogPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("recent-legacy-pane")
		logPath := filepath.Join(dir, hash+".log")
		ckptDir := filepath.Join(dir, hash+".log.state.d")
		ckptFile := filepath.Join(ckptDir, fmt.Sprintf("%020d.state", 1))

		writeTestFile(t, ckptFile, []byte("recent-checkpoint"), recentTime)
		setDirModTime(t, ckptDir, recentTime)
		writeTestFile(t, logPath, []byte("recent-log"), recentTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(logPath) {
			t.Fatalf("unexpired legacy log was incorrectly removed: %s", logPath)
		}
		if !pathExists(ckptDir) {
			t.Fatalf("unexpired legacy checkpoint dir was incorrectly removed: %s", ckptDir)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from unexpired log, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("ReservedPaneLogPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		reservedPaneID := "reserved-legacy-pane"
		hash := paneHash(reservedPaneID)
		logPath := filepath.Join(dir, hash+".log")
		writeTestFile(t, logPath, []byte("reserved-log-bytes"), expiredTime)

		h.savedReservations = func() (map[string]bool, error) {
			return map[string]bool{reservedPaneID: true}, nil
		}

		stats := h.sweepRetention(fc.Now())
		if !pathExists(logPath) {
			t.Fatalf("reserved legacy log was removed: %s", logPath)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from reserved log, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("ActiveLivePaneLogPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		livePaneID := "live-legacy-pane"
		hash := paneHash(livePaneID)
		logPath := filepath.Join(dir, hash+".log")
		writeTestFile(t, logPath, []byte("live-log-bytes"), expiredTime)

		if err := h.InitPaneJournal(livePaneID, 80, 24); err != nil {
			t.Fatal(err)
		}

		stats := h.sweepRetention(fc.Now())
		if !pathExists(logPath) {
			t.Fatalf("active live legacy log was removed: %s", logPath)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from active live log, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("FutureMtimeLogPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("future-legacy-pane")
		logPath := filepath.Join(dir, hash+".log")
		writeTestFile(t, logPath, []byte("future-log-bytes"), futureTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(logPath) {
			t.Fatalf("future timestamped log was removed: %s", logPath)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from future log, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("OrphanCheckpointDirectoryExpiredRemoved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("orphan-expired-legacy")
		ckptDir := filepath.Join(dir, hash+".log.state.d")
		ckptFile := filepath.Join(ckptDir, fmt.Sprintf("%020d.state", 2))

		writeTestFile(t, ckptFile, []byte("orphan-state-bytes"), expiredTime)
		setDirModTime(t, ckptDir, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(ckptDir) {
			t.Fatalf("expired orphan checkpoint dir was not removed: %s", ckptDir)
		}
		if stats.BytesReclaimed != uint64(len("orphan-state-bytes")) {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, len("orphan-state-bytes"))
		}
	})

	t.Run("OrphanCheckpointDirectoryUnexpiredPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("orphan-fresh-legacy")
		ckptDir := filepath.Join(dir, hash+".log.state.d")
		ckptFile := filepath.Join(ckptDir, fmt.Sprintf("%020d.state", 1))

		writeTestFile(t, ckptFile, []byte("orphan-fresh-bytes"), recentTime)
		setDirModTime(t, ckptDir, recentTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(ckptDir) {
			t.Fatalf("unexpired orphan checkpoint dir was removed: %s", ckptDir)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from unexpired orphan, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("NonCheckpointLeftoversPreserveCheckpointDir", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		hash := paneHash("leftover-legacy-pane")
		logPath := filepath.Join(dir, hash+".log")
		ckptDir := filepath.Join(dir, hash+".log.state.d")
		ckptFile := filepath.Join(ckptDir, fmt.Sprintf("%020d.state", 1))
		foreignFile := filepath.Join(ckptDir, "unrecognised.txt")

		writeTestFile(t, ckptFile, []byte("checkpoint-bytes"), expiredTime)
		writeTestFile(t, foreignFile, []byte("user-note"), expiredTime)
		setDirModTime(t, ckptDir, expiredTime)
		writeTestFile(t, logPath, []byte("journal-bytes"), expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(logPath) {
			t.Fatalf("legacy log was not removed: %s", logPath)
		}
		if pathExists(ckptFile) {
			t.Fatalf("valid checkpoint file was not removed: %s", ckptFile)
		}
		if !pathExists(foreignFile) {
			t.Fatalf("unrecognised file was unexpectedly removed: %s", foreignFile)
		}
		if !pathExists(ckptDir) {
			t.Fatalf("checkpoint dir containing unrecognised file was removed: %s", ckptDir)
		}
		expectedReclaimed := uint64(len("checkpoint-bytes") + len("journal-bytes"))
		if stats.BytesReclaimed != expectedReclaimed {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, expectedReclaimed)
		}
	})

	t.Run("InvalidLegacyNamesIgnored", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		shortHexLog := filepath.Join(dir, "abcd1234ef.log")
		nonHexLog := filepath.Join(dir, "nonhexname_something_here_not_valid_sha256_hash_length_at_all.log")
		validHash := paneHash("unsafe-type-pane")
		dirAsLog := filepath.Join(dir, validHash+".log")

		writeTestFile(t, shortHexLog, []byte("short"), expiredTime)
		writeTestFile(t, nonHexLog, []byte("nonhex"), expiredTime)
		if err := os.MkdirAll(dirAsLog, 0700); err != nil {
			t.Fatal(err)
		}
		setDirModTime(t, dirAsLog, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(shortHexLog) {
			t.Fatalf("short hex log was removed: %s", shortHexLog)
		}
		if !pathExists(nonHexLog) {
			t.Fatalf("non-hex log was removed: %s", nonHexLog)
		}
		if !pathExists(dirAsLog) {
			t.Fatalf("directory named .log was removed: %s", dirAsLog)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes from invalid names, want 0", stats.BytesReclaimed)
		}
	})
}

func TestRetentionExpiryEdge_V2Sweep(t *testing.T) {
	baseTime := time.Unix(1_900_000_000, 0)
	expiredTime := baseTime.Add(-retentionPeriod - 2*time.Hour)
	recentTime := baseTime.Add(-retentionPeriod + 24*time.Hour)

	t.Run("ExpiredClosedPaneDirectoryRemoved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "closed-v2-pane"
		gDir := groupDir(t, dir, paneID)

		manifestPath := filepath.Join(gDir, "MANIFEST")
		manifestTmpPath := filepath.Join(gDir, "MANIFEST.tmp")
		rawPath := filepath.Join(gDir, "s0000000000000001.raw")
		rszPath := filepath.Join(gDir, "s0000000000000001.rsz")
		ckptPath := filepath.Join(gDir, "s0000000000000001.ckpt")

		writeTestFile(t, manifestPath, []byte("manifest-contents"), expiredTime)
		writeTestFile(t, manifestTmpPath, []byte("tmp-manifest"), expiredTime)
		writeTestFile(t, rawPath, []byte("raw-bytes-here"), expiredTime)
		writeTestFile(t, rszPath, []byte("rsz-data"), expiredTime)
		writeTestFile(t, ckptPath, []byte("ckpt-data"), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(gDir) {
			t.Fatalf("expired v2 group directory was not removed: %s", gDir)
		}
		if stats.GroupsDeleted != 1 {
			t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
		}
		expectedReclaimed := uint64(len("manifest-contents") + len("tmp-manifest") + len("raw-bytes-here") + len("rsz-data") + len("ckpt-data"))
		if stats.BytesReclaimed != expectedReclaimed {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, expectedReclaimed)
		}
		if len(stats.FailedPaths) != 0 {
			t.Fatalf("unexpected failed paths: %v", stats.FailedPaths)
		}
	})

	t.Run("UnexpiredClosedPaneDirectoryPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "unexpired-v2-pane"
		gDir := groupDir(t, dir, paneID)

		manifestPath := filepath.Join(gDir, "MANIFEST")
		rawPath := filepath.Join(gDir, "s0000000000000001.raw")
		writeTestFile(t, manifestPath, []byte("manifest-contents"), recentTime)
		writeTestFile(t, rawPath, []byte("raw-bytes"), recentTime)
		setDirModTime(t, gDir, recentTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(gDir) {
			t.Fatalf("unexpired v2 group directory was removed: %s", gDir)
		}
		if stats.GroupsDeleted != 0 {
			t.Fatalf("groups deleted = %d, want 0", stats.GroupsDeleted)
		}
		if stats.BytesReclaimed != 0 {
			t.Fatalf("reclaimed %d bytes, want 0", stats.BytesReclaimed)
		}
	})

	t.Run("ActiveLivePaneDirectoryPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "active-live-v2-pane"
		gDir := groupDir(t, dir, paneID)

		manifestPath := filepath.Join(gDir, "MANIFEST")
		writeTestFile(t, manifestPath, []byte("manifest-contents"), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		if err := h.InitPaneJournal(paneID, 80, 24); err != nil {
			t.Fatal(err)
		}

		stats := h.sweepRetention(fc.Now())
		if !pathExists(gDir) {
			t.Fatalf("active live pane group directory was removed: %s", gDir)
		}
		if stats.GroupsDeleted != 0 {
			t.Fatalf("groups deleted = %d, want 0", stats.GroupsDeleted)
		}
	})

	t.Run("ReservedPaneDirectoryPreserved", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "reserved-v2-pane"
		gDir := groupDir(t, dir, paneID)

		manifestPath := filepath.Join(gDir, "MANIFEST")
		writeTestFile(t, manifestPath, []byte("manifest-contents"), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		h.savedReservations = func() (map[string]bool, error) {
			return map[string]bool{paneID: true}, nil
		}

		stats := h.sweepRetention(fc.Now())
		if !pathExists(gDir) {
			t.Fatalf("reserved pane group directory was removed: %s", gDir)
		}
		if stats.GroupsDeleted != 0 {
			t.Fatalf("groups deleted = %d, want 0", stats.GroupsDeleted)
		}
	})

	t.Run("CorruptOrUnrecognisedEntriesKeptWhileSegmentsCleaned", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "corrupt-entries-pane"
		gDir := groupDir(t, dir, paneID)

		manifestPath := filepath.Join(gDir, "MANIFEST")
		rawPath := filepath.Join(gDir, "s0000000000000001.raw")
		rszPath := filepath.Join(gDir, "s0000000000000001.rsz")
		ckptPath := filepath.Join(gDir, "s0000000000000001.ckpt")

		corruptFile := filepath.Join(gDir, "corrupt.txt")
		malformedSeg := filepath.Join(gDir, "s1.raw")
		subfolderFile := filepath.Join(gDir, "nested_dir", "leftover.bin")

		writeTestFile(t, manifestPath, []byte("manifest-data"), expiredTime)
		writeTestFile(t, rawPath, []byte("raw-segment"), expiredTime)
		writeTestFile(t, rszPath, []byte("rsz-segment"), expiredTime)
		writeTestFile(t, ckptPath, []byte("ckpt-segment"), expiredTime)

		writeTestFile(t, corruptFile, []byte("keep-me"), expiredTime)
		writeTestFile(t, malformedSeg, []byte("short-name"), expiredTime)
		writeTestFile(t, subfolderFile, []byte("nested-data"), expiredTime)
		setDirModTime(t, filepath.Dir(subfolderFile), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		stats := h.sweepRetention(fc.Now())

		if pathExists(manifestPath) {
			t.Fatalf("manifest was not removed: %s", manifestPath)
		}
		if pathExists(rawPath) {
			t.Fatalf("raw segment was not removed: %s", rawPath)
		}
		if pathExists(rszPath) {
			t.Fatalf("rsz segment was not removed: %s", rszPath)
		}
		if pathExists(ckptPath) {
			t.Fatalf("ckpt segment was not removed: %s", ckptPath)
		}

		if !pathExists(corruptFile) {
			t.Fatalf("unrecognised file was unexpectedly removed: %s", corruptFile)
		}
		if !pathExists(malformedSeg) {
			t.Fatalf("malformed segment file was unexpectedly removed: %s", malformedSeg)
		}
		if !pathExists(subfolderFile) {
			t.Fatalf("nested subfolder file was unexpectedly removed: %s", subfolderFile)
		}
		if !pathExists(gDir) {
			t.Fatalf("group directory containing unrecognised files was removed: %s", gDir)
		}

		if stats.GroupsDeleted != 1 {
			t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
		}
		expectedReclaimed := uint64(len("manifest-data") + len("raw-segment") + len("rsz-segment") + len("ckpt-segment"))
		if stats.BytesReclaimed != expectedReclaimed {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, expectedReclaimed)
		}
		if len(stats.FailedPaths) != 0 {
			t.Fatalf("unexpected failed paths: %v", stats.FailedPaths)
		}
	})

	t.Run("LeftoverSegmentFilesCleanedWithoutManifest", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "leftover-segs-pane"
		gDir := groupDir(t, dir, paneID)

		rawPath := filepath.Join(gDir, "s0000000000000003.raw")
		rszPath := filepath.Join(gDir, "s0000000000000003.rsz")
		ckptPath := filepath.Join(gDir, "s0000000000000003.ckpt")

		writeTestFile(t, rawPath, []byte("orphan-raw"), expiredTime)
		writeTestFile(t, rszPath, []byte("orphan-rsz"), expiredTime)
		writeTestFile(t, ckptPath, []byte("orphan-ckpt"), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(gDir) {
			t.Fatalf("leftover segment directory was not removed: %s", gDir)
		}
		if stats.GroupsDeleted != 0 {
			t.Fatalf("groups deleted = %d, want 0 without manifest", stats.GroupsDeleted)
		}
		expectedReclaimed := uint64(len("orphan-raw") + len("orphan-rsz") + len("orphan-ckpt"))
		if stats.BytesReclaimed != expectedReclaimed {
			t.Fatalf("reclaimed %d bytes, want %d", stats.BytesReclaimed, expectedReclaimed)
		}
	})

	t.Run("InvalidGroupDirectoryNamesIgnored", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)
		v2Dir := filepath.Join(dir, "v2")

		strayFile := filepath.Join(v2Dir, "stray.txt")
		shortDir := filepath.Join(v2Dir, "abcd1234")
		uppercaseDir := filepath.Join(v2Dir, "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef")
		nonHexDir := filepath.Join(v2Dir, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")

		writeTestFile(t, strayFile, []byte("stray"), expiredTime)
		if err := os.MkdirAll(shortDir, 0700); err != nil {
			t.Fatal(err)
		}
		setDirModTime(t, shortDir, expiredTime)
		if err := os.MkdirAll(uppercaseDir, 0700); err != nil {
			t.Fatal(err)
		}
		setDirModTime(t, uppercaseDir, expiredTime)
		if err := os.MkdirAll(nonHexDir, 0700); err != nil {
			t.Fatal(err)
		}
		setDirModTime(t, nonHexDir, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if !pathExists(strayFile) {
			t.Fatalf("stray file was removed: %s", strayFile)
		}
		if !pathExists(shortDir) {
			t.Fatalf("short directory was removed: %s", shortDir)
		}
		if !pathExists(uppercaseDir) {
			t.Fatalf("uppercase directory was removed: %s", uppercaseDir)
		}
		if !pathExists(nonHexDir) {
			t.Fatalf("non-hex directory was removed: %s", nonHexDir)
		}
		if stats.GroupsDeleted != 0 || stats.BytesReclaimed != 0 {
			t.Fatalf("unexpected stats: deleted=%d, reclaimed=%d", stats.GroupsDeleted, stats.BytesReclaimed)
		}
	})

	t.Run("InMemoryArchiveDetachedOnDiskGroupSweep", func(t *testing.T) {
		fc := &fakeClock{now: baseTime}
		h, dir := edgeExpiryTestHub(t, fc)

		paneID := "archived-disk-pane"
		if err := h.InitPaneJournal(paneID, 80, 24); err != nil {
			t.Fatal(err)
		}
		h.ClosePane(paneID)

		if h.recordingForRead(paneID) == nil {
			t.Fatal("archive should be present in memory after close")
		}

		gDir := groupDir(t, dir, paneID)
		manifestPath := filepath.Join(gDir, "MANIFEST")
		writeTestFile(t, manifestPath, []byte("manifest"), expiredTime)
		setDirModTime(t, gDir, expiredTime)

		stats := h.sweepRetention(fc.Now())
		if pathExists(gDir) {
			t.Fatalf("expired disk group was not removed: %s", gDir)
		}
		if h.recordingForRead(paneID) != nil {
			t.Fatal("archive owner was not detached from memory during disk group sweep")
		}
		if stats.GroupsDeleted != 1 {
			t.Fatalf("groups deleted = %d, want 1", stats.GroupsDeleted)
		}
	})
}

func TestRetentionExpiryEdge_ReservationErrorSkipsSweep(t *testing.T) {
	baseTime := time.Unix(1_900_000_000, 0)
	expiredTime := baseTime.Add(-retentionPeriod - 2*time.Hour)

	fc := &fakeClock{now: baseTime}
	h, dir := edgeExpiryTestHub(t, fc)

	paneID := "res-error-pane"
	hash := paneHash(paneID)
	legacyLog := filepath.Join(dir, hash+".log")
	writeTestFile(t, legacyLog, []byte("legacy-log"), expiredTime)

	gDir := groupDir(t, dir, paneID)
	manifestPath := filepath.Join(gDir, "MANIFEST")
	writeTestFile(t, manifestPath, []byte("manifest"), expiredTime)
	setDirModTime(t, gDir, expiredTime)

	h.savedReservations = func() (map[string]bool, error) {
		return nil, errors.New("saved reservation database temporarily unreachable")
	}

	stats := h.sweepRetention(fc.Now())
	if !pathExists(legacyLog) {
		t.Fatalf("legacy log was removed despite reservation check error: %s", legacyLog)
	}
	if !pathExists(gDir) {
		t.Fatalf("v2 directory was removed despite reservation check error: %s", gDir)
	}
	if stats.GroupsDeleted != 0 || stats.BytesReclaimed != 0 {
		t.Fatalf("sweep ran despite reservation error: %+v", stats)
	}
}

func TestRetentionExpiryEdge_LeaseNotHeldSkipsDiskSweep(t *testing.T) {
	baseTime := time.Unix(1_900_000_000, 0)
	expiredTime := baseTime.Add(-retentionPeriod - 2*time.Hour)

	fc := &fakeClock{now: baseTime}
	h, dir := edgeExpiryTestHub(t, fc)

	paneID := "no-lease-pane"
	hash := paneHash(paneID)
	legacyLog := filepath.Join(dir, hash+".log")
	writeTestFile(t, legacyLog, []byte("legacy-log"), expiredTime)

	gDir := groupDir(t, dir, paneID)
	manifestPath := filepath.Join(gDir, "MANIFEST")
	writeTestFile(t, manifestPath, []byte("manifest"), expiredTime)
	setDirModTime(t, gDir, expiredTime)

	h.mu.Lock()
	h.leaseHeld = false
	h.mu.Unlock()

	stats := h.sweepRetention(fc.Now())
	if !pathExists(legacyLog) {
		t.Fatalf("legacy log was removed when lease was unheld: %s", legacyLog)
	}
	if !pathExists(gDir) {
		t.Fatalf("v2 directory was removed when lease was unheld: %s", gDir)
	}
	if stats.GroupsDeleted != 0 || stats.BytesReclaimed != 0 {
		t.Fatalf("disk sweep ran without lease: %+v", stats)
	}
}
