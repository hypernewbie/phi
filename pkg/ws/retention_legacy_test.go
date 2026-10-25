package ws

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/termstate"
	"github.com/hypernewbie/phi/pkg/pty"
)

func stampLegacySet(t *testing.T, journal string, at time.Time) {
	t.Helper()
	stampLegacy(t, journal, at)
	entries, err := os.ReadDir(journal + ".state.d")
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".state" {
			continue
		}
		stampLegacy(t, filepath.Join(journal+".state.d", entry.Name()), at)
	}
}

func requireLegacyPresent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("legacy source %s missing: %v", path, err)
	}
}

func requireLegacyAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("legacy source %s remains: %v", path, err)
	}
}

func TestLegacySweepExpiresUnreserved(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	journal := legacyLogPath(dir, "legacy-expired")
	source := writeLegacyLog(t, journal, [][]byte{[]byte("expired history\r\n")}, nil)
	writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
	stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
	checkpoint := filepath.Join(journal+".state.d", fmt.Sprintf("%020d.state", len(source)))
	journalSize := int64(len(mustRead(t, journal)))
	checkpointInfo, err := os.Stat(checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(dir, "keep-me")
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}

	stats := h.sweepRetention(fc.Now())
	requireLegacyAbsent(t, journal)
	requireLegacyAbsent(t, checkpoint)
	if _, err := os.Lstat(journal + ".state.d"); !os.IsNotExist(err) {
		t.Fatalf("empty checkpoint directory remains: %v", err)
	}
	if _, err := os.Lstat(groupDir(t, dir, "legacy-expired")); !os.IsNotExist(err) {
		t.Fatalf("expired source created a v2 group: %v", err)
	}
	if got := stats.BytesReclaimed; got != uint64(journalSize+checkpointInfo.Size()) {
		t.Fatalf("reclaimed bytes = %d, want %d", got, journalSize+checkpointInfo.Size())
	}
	if len(stats.FailedPaths) != 0 {
		t.Fatalf("failed paths = %v", stats.FailedPaths)
	}
	if got := string(mustRead(t, unrelated)); got != "unrelated" {
		t.Fatalf("unrelated file changed: %q", got)
	}
}

func TestLegacySweepMigratesNewestWindow(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "legacy-newest-window"
	journal := legacyLogPath(dir, pane)
	// Chunk sizes were chosen for a 1 MiB cap; scale with the real cap so the
	// journal still exceeds the retained window.
	scale := int(retentionHistoryCap / (1 << 20))
	chunks := [][]byte{
		bytes.Repeat([]byte("prefix\r\n"), 60000*scale),
		bytes.Repeat([]byte("middle\r\n"), 60000*scale),
		bytes.Repeat([]byte("second\r\n"), 60000*scale),
		bytes.Repeat([]byte("tail\r\n"), 130000*scale),
		bytes.Repeat([]byte("last\r\n"), 100000*scale),
	}
	resizeByChunk := map[int][2]uint16{
		1: {100, 40},
		2: {120, 50},
		3: {90, 30},
		4: {100, 35},
	}
	source := writeLegacyLog(t, journal, chunks, resizeByChunk)
	var resizeEvents [][3]uint64
	var anchor uint64
	for i, chunk := range chunks {
		if geometry, ok := resizeByChunk[i]; ok {
			resizeEvents = append(resizeEvents, [3]uint64{uint64(len(source[:anchor])), uint64(geometry[0]), uint64(geometry[1])})
		}
		anchor += uint64(len(chunk))
	}
	anchor = uint64(len(chunks[0]) + len(chunks[1]) + len(chunks[2]))
	writeLegacyAnchor(t, journal, anchor, source[:anchor], resizeEvents[:3])
	stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
	clock := fc.Now().Add(-time.Hour)

	stats := h.sweepRetention(fc.Now())
	requireLegacyAbsent(t, journal)
	if len(stats.FailedPaths) != 0 {
		t.Fatalf("failed paths = %v", stats.FailedPaths)
	}
	if _, err := os.Stat(filepath.Join(groupDir(t, dir, pane), "MANIFEST")); err != nil {
		t.Fatalf("sweep did not publish a v2 manifest: %v", err)
	}
	start := uint64(len(source)) - retentionHistoryCap
	recStart, data, markers := readRetained(t, h, pane, 0, ^uint64(0))
	if recStart != start || uint64(len(data)) != uint64(len(source))-start || !bytes.Equal(data, source[start:]) {
		t.Fatalf("recording start/data = %d %d bytes, want %d %d bytes", recStart, len(data), start, uint64(len(source))-start)
	}
	wantResizes := []ResizeMarker{
		{AtSeq: start, Cols: 90, Rows: 30},
		{AtSeq: uint64(len(chunks[0]) + len(chunks[1]) + len(chunks[2]) + len(chunks[3])), Cols: 100, Rows: 35},
	}
	if len(markers) != len(wantResizes) {
		t.Fatalf("retained resize markers = %+v, want %+v", markers, wantResizes)
	}
	for i := range wantResizes {
		if markers[i] != wantResizes[i] {
			t.Fatalf("retained resize marker %d = %+v, want %+v", i, markers[i], wantResizes[i])
		}
	}
	wantScreen, wantContinuation, wantCols, wantRows := parseDirect(t, source, resizeEvents)
	_, state, cols, rows, err := h.State(pane)
	if err != nil {
		t.Fatal(err)
	}
	gotScreen, gotContinuation, gotCols, gotRows := restoreDirect(t, state)
	if !bytes.Equal(gotScreen, wantScreen) || !bytes.Equal(gotContinuation, wantContinuation) {
		t.Fatal("migrated screen or parser continuation differs from a direct source parse")
	}
	if cols != wantCols || rows != wantRows || gotCols != wantCols || gotRows != wantRows {
		t.Fatalf("migrated geometry = %dx%d / %dx%d, want %dx%d", cols, rows, gotCols, gotRows, wantCols, wantRows)
	}
	manifest, err := os.ReadFile(filepath.Join(groupDir(t, dir, pane), "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeRetentionManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.lastUpdateNs != clock.UnixNano() {
		t.Fatalf("manifest clock = %d, want source clock %d", decoded.lastUpdateNs, clock.UnixNano())
	}
}

func TestLegacySweepKeepsSourceClock(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "legacy-source-clock"
	journal := legacyLogPath(dir, pane)
	source := writeLegacyLog(t, journal, [][]byte{bytes.Repeat([]byte("clock\r\n"), 20)}, nil)
	clock := fc.Now().Add(-6 * 24 * time.Hour)
	stampLegacySet(t, journal, clock)
	if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
		t.Fatalf("migration failures = %v", stats.FailedPaths)
	}
	requireLegacyAbsent(t, journal)
	manifestBytes, err := os.ReadFile(filepath.Join(groupDir(t, dir, pane), "MANIFEST"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := decodeRetentionManifest(manifestBytes)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.lastUpdateNs != clock.UnixNano() {
		t.Fatalf("manifest clock = %d, want original source clock %d", manifest.lastUpdateNs, clock.UnixNano())
	}
	fc.Advance(2 * 24 * time.Hour)
	stats := h.sweepRetention(fc.Now())
	if stats.GroupsDeleted != 1 {
		t.Fatalf("source-clock-aged replacement was not expired: %+v", stats)
	}
	if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
		t.Fatalf("source-clock-aged replacement remains: %v", err)
	}
	requireLegacyAbsent(t, journal)
	if _, ok := h.Recording(pane, 0, uint64(len(source))); ok {
		t.Fatal("expired migrated source resurrected")
	}
}

func TestLegacySweepRepeatIsIdempotent(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "legacy-repeat"
	journal := legacyLogPath(dir, pane)
	source := writeLegacyLog(t, journal, [][]byte{bytes.Repeat([]byte("repeat\r\n"), 200)}, nil)
	stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
	if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
		t.Fatalf("first sweep failures = %v", stats.FailedPaths)
	}
	requireLegacyAbsent(t, journal)
	manifestPath := filepath.Join(groupDir(t, dir, pane), "MANIFEST")
	before, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	second := h.sweepRetention(fc.Now())
	if second.BytesReclaimed != 0 || len(second.FailedPaths) != 0 {
		t.Fatalf("second sweep was not a no-op: %+v", second)
	}
	after, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("second sweep changed the published manifest")
	}
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
	if stats := h2.sweepRetention(fc.Now()); stats.BytesReclaimed != 0 || len(stats.FailedPaths) != 0 {
		t.Fatalf("reopened sweep was not a no-op: %+v", stats)
	}
	rec, ok := h2.Recording(pane, 0, ^uint64(0))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatalf("replacement after restart = %q, want %q", rec.Data, source)
	}
	requireLegacyAbsent(t, journal)
}

func TestLegacySweepProtectsOwnership(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  func(*Hub, string)
	}{
		{name: "saved", set: func(h *Hub, pane string) {
			h.savedReservations = func() (map[string]bool, error) { return map[string]bool{pane: true}, nil }
		}},
		{name: "live pane", set: func(h *Hub, pane string) {
			h.mu.Lock()
			h.panes[pane] = &PaneHub{}
			h.mu.Unlock()
		}},
		{name: "unreadable reservations", set: func(h *Hub, _ string) {
			h.savedReservations = func() (map[string]bool, error) { return nil, fmt.Errorf("saved tabs unavailable") }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
			h, dir := expiryTestHub(t, fc)
			const pane = "legacy-protected"
			journal := legacyLogPath(dir, pane)
			writeLegacyLog(t, journal, [][]byte{[]byte("protected\r\n")}, nil)
			stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
			tc.set(h, pane)
			if stats := h.sweepRetention(fc.Now()); stats.BytesReclaimed != 0 {
				t.Fatalf("protected sweep reclaimed bytes: %+v", stats)
			}
			requireLegacyPresent(t, journal)
			if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
				t.Fatalf("protected source created a replacement: %v", err)
			}
		})
	}

	t.Run("no namespace lease", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		journal := legacyLogPath(dir, "legacy-no-lease")
		writeLegacyLog(t, journal, [][]byte{[]byte("lease protected\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		h.mu.Lock()
		h.leaseHeld = false
		h.mu.Unlock()
		if stats := h.sweepRetention(fc.Now()); stats.BytesReclaimed != 0 {
			t.Fatalf("lease-free sweep reclaimed bytes: %+v", stats)
		}
		requireLegacyPresent(t, journal)
		h.mu.Lock()
		h.leaseHeld = true
		h.mu.Unlock()
	})

	t.Run("unavailable owned recording keeps sources", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-owner-unavailable"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		manifestBefore := manifestBytes(t, dir, pane)
		h.mu.Lock()
		ph := h.archives[pane]
		h.mu.Unlock()
		ph.mu.Lock()
		rec := ph.recording
		ph.mu.Unlock()
		if err := rec.close(); err != nil {
			t.Fatal(err)
		}
		ph.mu.Lock()
		ph.recording = nil
		ph.mu.Unlock()
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		h.mu.RLock()
		after := h.archives[pane]
		h.mu.RUnlock()
		if after != ph {
			t.Fatal("sweep replaced the unavailable owner")
		}
		ph.mu.Lock()
		stillNil := ph.recording == nil
		ph.mu.Unlock()
		if !stillNil {
			t.Fatal("sweep repaired the unavailable owner")
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep rewrote the manifest")
		}
		if err := h.Ingest("other-pane", []byte("x\r\n")); err != nil {
			t.Fatalf("hub unusable after deferral: %v", err)
		}
	})

	t.Run("closed owned recording keeps sources", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-owner-closed"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		manifestBefore := manifestBytes(t, dir, pane)
		h.mu.Lock()
		ph := h.archives[pane]
		h.mu.Unlock()
		ph.mu.Lock()
		rec := ph.recording
		ph.mu.Unlock()
		if err := rec.close(); err != nil {
			t.Fatal(err)
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep rewrote the manifest")
		}
		h.mu.RLock()
		_, retained := h.archives[pane]
		h.mu.RUnlock()
		if !retained {
			t.Fatal("sweep detached the closed owner")
		}
	})

	t.Run("ephemeral owned recording keeps sources", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-owner-ephemeral"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		manifestBefore := manifestBytes(t, dir, pane)
		h.mu.Lock()
		ph := h.archives[pane]
		h.mu.Unlock()
		ph.mu.Lock()
		rec := ph.recording
		ph.mu.Unlock()
		if err := rec.close(); err != nil {
			t.Fatal(err)
		}
		eph, err := openRetentionGroup("")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = eph.close() })
		if !eph.ephemeral {
			t.Fatal("fixture group is not ephemeral")
		}
		ph.mu.Lock()
		ph.recording = eph
		ph.mu.Unlock()
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		if _, err := os.Stat(eph.dir); err != nil {
			t.Fatalf("sweep closed the ephemeral owner: %v", err)
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep rewrote the manifest")
		}
	})

	t.Run("pending owned recording keeps sources", func(t *testing.T) {
		perCommitDurability(t)
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-owner-pending"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		ph, _ := h.LookupPane(pane)
		ph.recording.faults.dirSync = fmt.Errorf("injected dirSync failure")
		pendingPayload := []byte("pending\r\n")
		if err := h.Ingest(pane, pendingPayload); err == nil {
			t.Fatal("dirSync fault admitted bytes")
		}
		manifestBefore := manifestBytes(t, dir, pane)
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		ph.mu.Lock()
		stillPending := ph.recording.pending != nil
		ph.mu.Unlock()
		if !stillPending {
			t.Fatal("sweep resolved the pending commit")
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep rewrote the manifest")
		}
		// The owner still resolves its own pending commit afterwards.
		if err := h.Ingest(pane, pendingPayload); err != nil {
			t.Fatalf("pending owner cannot resolve: %v", err)
		}
	})
}

func TestLegacySweepSkipsUnsafeEntries(t *testing.T) {
	t.Run("symlinked journal", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		target := filepath.Join(t.TempDir(), "source.log")
		if err := os.WriteFile(target, []byte("target evidence"), 0600); err != nil {
			t.Fatal(err)
		}
		journal := legacyLogPath(dir, "legacy-symlink")
		if err := os.Symlink(target, journal); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		if stats.BytesReclaimed != 0 {
			t.Fatalf("symlink sweep reclaimed bytes: %+v", stats)
		}
		requireFailedPathsEmpty(t, stats)
		requireLegacyPresent(t, journal)
		if got := string(mustRead(t, target)); got != "target evidence" {
			t.Fatalf("symlink target changed: %q", got)
		}
	})

	t.Run("symlinked checkpoint directory", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		journal := legacyLogPath(dir, "legacy-checkpoint-link")
		writeLegacyLog(t, journal, [][]byte{[]byte("recent history\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		target := t.TempDir()
		checkpoint := filepath.Join(target, "00000000000000000001.state")
		if err := os.WriteFile(checkpoint, []byte("not followed"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, journal+".state.d"); err != nil {
			t.Fatal(err)
		}
		stampLegacy(t, checkpoint, fc.Now().Add(-time.Hour))
		sweepStats := h.sweepRetention(fc.Now())
		requireFailedPathsEmpty(t, sweepStats)
		requireLegacyPresent(t, journal)
		if _, err := os.Lstat(groupDir(t, dir, "legacy-checkpoint-link")); !os.IsNotExist(err) {
			t.Fatalf("linked checkpoint directory published a replacement: %v", err)
		}
		if got := string(mustRead(t, checkpoint)); got != "not followed" {
			t.Fatalf("linked checkpoint target changed: %q", got)
		}
		staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
		if err != nil {
			t.Fatal(err)
		}
		defer os.RemoveAll(staging)
		journalInfo, err := os.Lstat(journal)
		if err != nil {
			t.Fatal(err)
		}
		// The live import must not die on the symlink either: it falls
		// back to a full prefix stream without following it.
		stats, err := stageLegacyImport(journal, staging, journalInfo.Size(), journalInfo.ModTime())
		if err != nil {
			t.Fatalf("legacy importer refused a symlinked checkpoint directory: %v", err)
		}
		if stats.usedAnchor {
			t.Fatal("legacy importer used an anchor through a symlinked checkpoint directory")
		}
		if got := string(mustRead(t, checkpoint)); got != "not followed" {
			t.Fatalf("linked checkpoint target changed during import: %q", got)
		}
	})

	t.Run("symlinked destination", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-destination-link"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("recent history\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		target := t.TempDir()
		sentinel := filepath.Join(target, "keep")
		if err := os.WriteFile(sentinel, []byte("destination"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, groupDir(t, dir, pane)); err != nil {
			t.Fatal(err)
		}
		h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if got := string(mustRead(t, sentinel)); got != "destination" {
			t.Fatalf("symlink destination target changed: %q", got)
		}
	})

	t.Run("future source clock", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		journal := legacyLogPath(dir, "legacy-future")
		writeLegacyLog(t, journal, [][]byte{[]byte("future history\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(time.Hour))
		h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
	})

	t.Run("safe expired control", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		journal := legacyLogPath(dir, "legacy-safe-expired")
		writeLegacyLog(t, journal, [][]byte{[]byte("expired control\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
	})

	t.Run("symlinked checkpoint file", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-checkpoint-file-link"
		journal := legacyLogPath(dir, pane)
		source := writeLegacyLog(t, journal, [][]byte{[]byte("recent history\r\n")}, nil)
		writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		external := filepath.Join(t.TempDir(), "victim.state")
		if err := os.WriteFile(external, []byte("not followed"), 0600); err != nil {
			t.Fatal(err)
		}
		before := sha256.Sum256(mustRead(t, external))
		if err := os.Symlink(external, filepath.Join(journal+".state.d", "00000000000000000001.state")); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("linked checkpoint file published a replacement: %v", err)
		}
		if sha256.Sum256(mustRead(t, external)) != before {
			t.Fatal("sweep mutated through the checkpoint link")
		}
	})

	t.Run("unknown entries survive conversion", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-unknown-conversion"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		mystery := filepath.Join(journal+".state.d", "notes.txt")
		if err := os.WriteFile(mystery, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		nested := filepath.Join(journal+".state.d", "nested")
		if err := os.Mkdir(nested, 0700); err != nil {
			t.Fatal(err)
		}
		deep := filepath.Join(nested, "deep.state")
		if err := os.WriteFile(deep, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		requireFailedPathsEmpty(t, stats)
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("conversion beside unknown entries lost bytes")
		}
		if _, err := os.Lstat(journal); !os.IsNotExist(err) {
			t.Fatalf("converted journal remains: %v", err)
		}
		for _, p := range []string{mystery, nested, deep, journal + ".state.d"} {
			if _, err := os.Lstat(p); err != nil {
				t.Fatalf("unknown entry %s did not survive: %v", p, err)
			}
		}
	})

	t.Run("invalid manifest preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-invalid-manifest"
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		destination := groupDir(t, dir, pane)
		if err := os.Mkdir(destination, 0700); err != nil {
			t.Fatal(err)
		}
		garbage := filepath.Join(destination, "MANIFEST")
		if err := os.WriteFile(garbage, []byte("not a manifest"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPath(t, stats, journal)
		if got := string(mustRead(t, garbage)); got != "not a manifest" {
			t.Fatalf("invalid destination changed: %q", got)
		}
		if entries, err := os.ReadDir(destination); err != nil || len(entries) != 1 {
			t.Fatalf("invalid destination gained entries: %v %v", entries, err)
		}
	})

	t.Run("missing dependency preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-missing-dependency"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		h2 := reopenLegacyHub(t, h, dir, fc)
		m := decodeManifest(t, dir, pane)
		rawPath := filepath.Join(groupDir(t, dir, pane), fmt.Sprintf("s%016x.raw", m.segs[0].gen))
		if err := os.Remove(rawPath); err != nil {
			t.Fatal(err)
		}
		manifestBefore := manifestBytes(t, dir, pane)
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h2.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("missing dependency changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep repaired the broken destination")
		}
	})

	t.Run("segment gap preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-segment-gap"
		chunk := rotationChunk()
		for i := 0; i < 5; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
		}
		h.ClosePane(pane)
		rewriteManifest(t, dir, pane, func(m *retentionManifest) { m.segs[1].start += 100; m.head += 100 })
		gapped := decodeManifest(t, dir, pane)
		if gapped.segs[1].start != gapped.segs[0].start+gapped.segs[0].rawLen+100 {
			t.Fatalf("fixture has no gap: %+v", gapped.segs)
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("segment gap changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
		after := decodeManifest(t, dir, pane)
		if after.segs[1].start != gapped.segs[1].start {
			t.Fatal("sweep repaired the gapped manifest")
		}
		if _, ok := h.Recording(pane, 0, 10); !ok {
			t.Fatal("owner lost reads beside the preserved source")
		}
	})

	t.Run("segment overlap preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-segment-overlap"
		chunk := rotationChunk()
		for i := 0; i < 5; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
		}
		h.ClosePane(pane)
		rewriteManifest(t, dir, pane, func(m *retentionManifest) { m.segs[1].start -= 100; m.head -= 100 })
		lapped := decodeManifest(t, dir, pane)
		if lapped.segs[1].start != lapped.segs[0].start+lapped.segs[0].rawLen-100 {
			t.Fatalf("fixture has no overlap: %+v", lapped.segs)
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("segment overlap changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
		after := decodeManifest(t, dir, pane)
		if after.segs[1].start != lapped.segs[1].start {
			t.Fatal("sweep repaired the overlapped manifest")
		}
	})

	t.Run("shorter destination preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-shorter-destination"
		ingestDurable(t, h, pane, []byte("tiny\r\n"))
		h.ClosePane(pane)
		manifestBefore := manifestBytes(t, dir, pane)
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		if m := decodeManifest(t, dir, pane); m.head >= uint64(len(source)) {
			t.Fatalf("fixture head %d covers the source", m.head)
		}
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("shorter destination changed the preserved source")
		}
		requireFailedPathsEmpty(t, stats)
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep changed the shorter destination")
		}
	})

	t.Run("older destination preserves evidence", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-older-destination"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		// Pin the durable-update time to the old fake clock: small
		// flushed commits keep the creation stamp, which uses wall time.
		rewriteManifest(t, dir, pane, func(m *retentionManifest) { m.lastUpdateNs = time.Unix(1_700_000_000, 0).UTC().UnixNano() })
		manifestBefore := manifestBytes(t, dir, pane)
		fc.Advance(24 * time.Hour)
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-12*time.Hour))
		if m := decodeManifest(t, dir, pane); m.head < uint64(len(source)) {
			t.Fatalf("fixture head %d does not cover the source", m.head)
		}
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("older destination changed the preserved source")
		}
		requireFailedPathsEmpty(t, stats)
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("sweep changed the older destination")
		}
	})
}

func TestLegacySweepProtectsReadLoopOwner(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)

	const journalPane = "legacy-read-loop-journal"
	journal := legacyLogPath(dir, journalPane)
	source := writeLegacyLog(t, journal, [][]byte{[]byte("read loop owns this\r\n")}, nil)
	writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
	stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
	journalOwner := &pty.PTYInstance{ID: journalPane}
	h.notePaneOwner(journalOwner)

	const orphanPane = "legacy-read-loop-orphan"
	orphanDir := legacyLogPath(dir, orphanPane) + ".state.d"
	if err := os.Mkdir(orphanDir, 0700); err != nil {
		t.Fatal(err)
	}
	orphanCheckpoint := filepath.Join(orphanDir, "00000000000000000001.state")
	if err := os.WriteFile(orphanCheckpoint, []byte("checkpoint"), 0600); err != nil {
		t.Fatal(err)
	}
	stampLegacy(t, orphanCheckpoint, fc.Now().Add(-8*24*time.Hour))
	orphanOwner := &pty.PTYInstance{ID: orphanPane}
	h.notePaneOwner(orphanOwner)

	stats := h.sweepRetention(fc.Now())
	if stats.BytesReclaimed != 0 {
		t.Fatalf("read-loop owners lost bytes: %+v", stats)
	}
	requireLegacyPresent(t, journal)
	requireLegacyPresent(t, orphanCheckpoint)
	for _, pane := range []string{journalPane, orphanPane} {
		h.mu.RLock()
		_, hasPane := h.panes[pane]
		_, hasArchive := h.archives[pane]
		h.mu.RUnlock()
		if hasPane || hasArchive {
			t.Fatalf("fixture unexpectedly created a pane/archive owner for %q", pane)
		}
	}

	t.Run("owner registered after staging", func(t *testing.T) {
		const pane = "legacy-read-loop-after-stage"
		path := legacyLogPath(dir, pane)
		writeLegacyLog(t, path, [][]byte{[]byte("staged history\r\n")}, nil)
		stampLegacySet(t, path, fc.Now().Add(-time.Hour))
		hash := filepath.Base(path)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stageLegacyImport(path, staging, snapshot.journal.info.Size(), snapshot.journal.info.ModTime()); err != nil {
			t.Fatal(err)
		}
		h.notePaneOwner(&pty.PTYInstance{ID: pane})
		var finalStats retentionSweepStats
		h.finalizeLegacyCandidate(dir, snapshot, staging, legacySavedHashes(nil), fc.Now(), &finalStats)
		requireLegacyPresent(t, path)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("read-loop owner acquired a replacement: %v", err)
		}
		if finalStats.BytesReclaimed != 0 {
			t.Fatalf("late owner finalization reclaimed bytes: %+v", finalStats)
		}
	})

	t.Run("owner appears during authority checking", func(t *testing.T) {
		fc2 := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h2, dir2 := expiryTestHub(t, fc2)
		const pane = "legacy-read-loop-authority"
		ingestDurable(t, h2, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h2.ClosePane(pane)
		// Evict the archive owner, leaving disk-only v2 authority.
		h2.mu.Lock()
		ph := h2.archives[pane]
		delete(h2.archives, pane)
		h2.mu.Unlock()
		ph.mu.Lock()
		rec := ph.recording
		ph.mu.Unlock()
		if err := rec.close(); err != nil {
			t.Fatal(err)
		}
		journal, _ := seedSmallLegacy(t, dir2, pane, fc2.Now().Add(-time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir2, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		sourceHead, err := scanLegacySourceHead(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		authority, err := h2.captureLegacyAuthority(dir2, hash, sourceHead, info.ModTime())
		if err != nil {
			t.Fatal(err)
		}
		if err := checkLegacyAuthorityUsable(authority); err != nil {
			t.Fatal(err)
		}
		before := sourceHash(t, journal)
		h2.notePaneOwner(&pty.PTYInstance{ID: pane})
		var stats retentionSweepStats
		h2.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})
}

func TestLegacySweepPublicationFailures(t *testing.T) {
	t.Run("rename failure", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-rename-failure"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("keep after rename failure\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		oldRename := importRename
		importRename = func(string, string) error { return errors.New("injected rename failure") }
		t.Cleanup(func() { importRename = oldRename })

		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("rename failure published a replacement: %v", err)
		}
		if stats.BytesReclaimed != 0 || len(stats.FailedPaths) == 0 {
			t.Fatalf("rename failure not reported safely: %+v", stats)
		}
	})

	t.Run("parent sync failure after rename", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-parent-sync-failure"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("keep after parent sync failure\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		v2 := filepath.Join(dir, "v2")
		oldSync := legacySyncDir
		failed := false
		legacySyncDir = func(path string) error {
			if path == v2 && !failed {
				failed = true
				return errors.New("injected parent sync failure")
			}
			return oldSync(path)
		}
		t.Cleanup(func() { legacySyncDir = oldSync })

		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if _, err := os.Stat(filepath.Join(groupDir(t, dir, pane), "MANIFEST")); err != nil {
			t.Fatalf("published replacement missing after sync error: %v", err)
		}
		if !failed || stats.BytesReclaimed != 0 || len(stats.FailedPaths) == 0 {
			t.Fatalf("post-rename sync failure not reported safely: %+v, invoked=%v", stats, failed)
		}
	})

	t.Run("corrupt middle preserves originals", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-corrupt-middle"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("a\r\n"), []byte("b\r\n"), []byte("c\r\n")}, nil)
		data := mustRead(t, journal)
		data[len("a\r\n")+5] = 9
		if err := os.WriteFile(journal, data, 0600); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("corrupt middle changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("corrupt middle published a replacement: %v", err)
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("expired corrupt source retires without parsing", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-expired-corrupt"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("a\r\n"), []byte("b\r\n"), []byte("c\r\n")}, nil)
		data := mustRead(t, journal)
		data[len("a\r\n")+5] = 9
		if err := os.WriteFile(journal, data, 0600); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("torn final append still converts", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-torn-tail"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("committed\r\n")}, nil)
		f, err := os.OpenFile(journal, os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte{1, 0, 0, 0, 20, 'x'}); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		rec, ok := h.Recording(pane, 0, 100)
		if !ok || !bytes.Equal(rec.Data, []byte("committed\r\n")) {
			t.Fatalf("torn tail converted bytes=%q ok=%t", rec.Data, ok)
		}
	})

	t.Run("invalid published destination is never overwritten", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-invalid-published"
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		destination := groupDir(t, dir, pane)
		if err := os.Mkdir(destination, 0700); err != nil {
			t.Fatal(err)
		}
		garbage := filepath.Join(destination, "MANIFEST")
		if err := os.WriteFile(garbage, []byte("not a manifest"), 0600); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(destination, "preserve")
		if err := os.WriteFile(sentinel, []byte("existing destination"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPath(t, stats, journal)
		if got := string(mustRead(t, garbage)); got != "not a manifest" {
			t.Fatalf("invalid destination manifest changed: %q", got)
		}
		if got := string(mustRead(t, sentinel)); got != "existing destination" {
			t.Fatalf("invalid destination sentinel changed: %q", got)
		}
		assertNoStagingLeftovers(t, dir)
	})
}

func TestLegacySweepDestinationStates(t *testing.T) {
	t.Run("absent destination converts", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-absent-destination"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("convert me\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		if _, err := os.Stat(filepath.Join(groupDir(t, dir, pane), "MANIFEST")); err != nil {
			t.Fatalf("destination manifest missing: %v", err)
		}
	})

	t.Run("expired source leaves existing destination unchanged", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-expired-existing-destination"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("expired beside destination\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		destination := groupDir(t, dir, pane)
		if err := os.Mkdir(destination, 0700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(destination, "preserve")
		if err := os.WriteFile(sentinel, []byte("existing destination"), 0600); err != nil {
			t.Fatal(err)
		}
		h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		if got := string(mustRead(t, sentinel)); got != "existing destination" {
			t.Fatalf("existing destination changed: %q", got)
		}
		if _, err := os.Lstat(filepath.Join(destination, "MANIFEST")); !os.IsNotExist(err) {
			t.Fatalf("expired-source cleanup repaired the existing destination: %v", err)
		}
	})

	t.Run("archive alone is not live age protection", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-archive-only"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("expired archive source\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		h.mu.Lock()
		h.archives[pane] = &PaneHub{}
		h.mu.Unlock()
		h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
	})

	t.Run("incomplete destination defers", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-incomplete-destination"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("preserve me\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		if err := os.Mkdir(groupDir(t, dir, pane), 0700); err != nil {
			t.Fatal(err)
		}
		before := append([]byte(nil), mustRead(t, journal)...)
		h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if !bytes.Equal(mustRead(t, journal), before) {
			t.Fatal("incomplete destination changed the source")
		}
		if _, err := os.Lstat(filepath.Join(groupDir(t, dir, pane), "MANIFEST")); !os.IsNotExist(err) {
			t.Fatalf("incomplete destination changed: %v", err)
		}
	})

	t.Run("lookup error never counts as destination absence", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("unix permission semantics")
		}
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-destination-lookup-error"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("preserve me\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
		v2 := filepath.Join(dir, "v2")
		if err := os.Chmod(v2, 0000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(v2, 0700) })
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPath(t, stats, groupDir(t, dir, pane))
	})

	t.Run("incomplete destination stays unchanged", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "legacy-incomplete-unchanged"
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		destination := groupDir(t, dir, pane)
		if err := os.Mkdir(destination, 0700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(destination, "preserve")
		if err := os.WriteFile(sentinel, []byte("do not touch"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		requireFailedPath(t, stats, journal)
		if got := string(mustRead(t, sentinel)); got != "do not touch" {
			t.Fatalf("incomplete destination changed: %q", got)
		}
		if _, err := os.Lstat(filepath.Join(destination, "MANIFEST")); !os.IsNotExist(err) {
			t.Fatalf("incomplete destination changed: %v", err)
		}
		assertNoStagingLeftovers(t, dir)
	})
}

// ---------- M2 helpers ----------

// ingestDurable ingests payload and forces its manifest to the durable
// frontier, so committed v2 state is deterministic under a fake clock.
func ingestDurable(t *testing.T, h *Hub, pane string, payload []byte) {
	t.Helper()
	if err := h.Ingest(pane, payload); err != nil {
		t.Fatal(err)
	}
	ph, ok := h.LookupPane(pane)
	if !ok {
		t.Fatal("pane missing after ingest")
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.recording == nil || ph.recording.isClosed() {
		t.Fatal("pane has no open recording after ingest")
	}
	if err := ph.recording.flushDurable(); err != nil {
		t.Fatal(err)
	}
}

func manifestBytes(t *testing.T, dir, pane string) []byte {
	t.Helper()
	return mustRead(t, filepath.Join(groupDir(t, dir, pane), "MANIFEST"))
}

func decodeManifest(t *testing.T, dir, pane string) retentionManifest {
	t.Helper()
	m, err := decodeRetentionManifest(manifestBytes(t, dir, pane))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func sourceHash(t *testing.T, journal string) [32]byte {
	t.Helper()
	return sha256.Sum256(mustRead(t, journal))
}

func requireFailedPath(t *testing.T, stats retentionSweepStats, path string) {
	t.Helper()
	for _, p := range stats.FailedPaths {
		if p == path {
			return
		}
	}
	t.Fatalf("failed paths %v do not report %s", stats.FailedPaths, path)
}

func requireFailedPathsEmpty(t *testing.T, stats retentionSweepStats) {
	t.Helper()
	if len(stats.FailedPaths) != 0 {
		t.Fatalf("failed paths = %v, want none", stats.FailedPaths)
	}
}

// poisonSameSize flips every byte in place, keeping the file size (and any
// manifest that names it) unchanged while destroying its contents.
func poisonSameSize(t *testing.T, path string) {
	t.Helper()
	data := mustRead(t, path)
	for i := range data {
		data[i] ^= 0xff
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func ckptPathForGen(t *testing.T, dir, pane string, gen uint64) string {
	t.Helper()
	return filepath.Join(groupDir(t, dir, pane), fmt.Sprintf("s%016x.ckpt", gen))
}

// storedGzip wraps fill bytes in a minimal valid gzip stream built from
// stored (uncompressed) deflate blocks, sized to exactly target bytes. The
// stream gunzips cleanly while carrying parser-invalid bytes, for fixtures
// that must pass restoreAnchor but fail disposable-parser Restore.
func storedGzip(t *testing.T, target int, fill byte) []byte {
	t.Helper()
	if target < 24 {
		t.Fatalf("stored gzip target %d too small", target)
	}
	payload := bytes.Repeat([]byte{fill}, target-23)
	crc := crc32.ChecksumIEEE(payload)
	out := []byte{0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff}
	rest := payload
	for len(rest) > 0 {
		n := len(rest)
		if n > 65535 {
			n = 65535
		}
		if len(rest) == n {
			out = append(out, 0x01)
		} else {
			out = append(out, 0x00)
		}
		out = append(out, byte(n), byte(n>>8), byte(^uint16(n)), byte(^uint16(n)>>8))
		out = append(out, rest[:n]...)
		rest = rest[n:]
	}
	var tmp [8]byte
	binary.LittleEndian.PutUint32(tmp[:4], crc)
	binary.LittleEndian.PutUint32(tmp[4:], uint32(len(payload)))
	out = append(out, tmp[:]...)
	if len(out) != target {
		t.Fatalf("stored gzip size = %d, want %d", len(out), target)
	}
	return out
}

func rewriteManifest(t *testing.T, dir, pane string, edit func(*retentionManifest)) {
	t.Helper()
	path := filepath.Join(groupDir(t, dir, pane), "MANIFEST")
	m, err := decodeRetentionManifest(mustRead(t, path))
	if err != nil {
		t.Fatal(err)
	}
	edit(&m)
	if err := os.WriteFile(path, encodeRetentionManifest(m), 0600); err != nil {
		t.Fatal(err)
	}
}

func assertNoStagingLeftovers(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "v2"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".import-") {
			t.Fatalf("staging leftover remains: %s", entry.Name())
		}
	}
}

// seedSmallLegacy writes a recent legacy journal with one anchor for pane and
// returns its path and output bytes.
func seedSmallLegacy(t *testing.T, dir, pane string, mtime time.Time) (string, []byte) {
	t.Helper()
	journal := legacyLogPath(dir, pane)
	source := writeLegacyLog(t, journal, [][]byte{bytes.Repeat([]byte("legacy history line\r\n"), 100)}, nil)
	writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
	stampLegacySet(t, journal, mtime)
	return journal, source
}

// rotationChunk returns a payload just under a quarter segment, so the
// fixtures in this file force the one, two, or three rotations their ingest
// counts document.
func rotationChunk() []byte {
	const line = "rotation filler line 0123456789abcdef\r\n"
	size := int(retentionSegNominal)/4 - 64<<10
	return bytes.Repeat([]byte(line), size/len(line))
}

// fillLastSegment appends small filler until the last of the expected
// segments reaches the nominal size without rotating, then flushes the
// frontier durably. It returns the appended bytes.
func fillLastSegment(t *testing.T, h *Hub, pane string, segments int) []byte {
	t.Helper()
	var appended []byte
	filler := bytes.Repeat([]byte("0123456789"), 1024)
	ph, _ := h.LookupPane(pane)
	for {
		ph.mu.Lock()
		n := len(ph.recording.segs)
		rawLen := ph.recording.segs[n-1].rawLen
		ph.mu.Unlock()
		if n != segments {
			t.Fatalf("fixture has %d segments, want %d", n, segments)
		}
		if rawLen >= retentionHistoryCap {
			break
		}
		if err := h.Ingest(pane, filler); err != nil {
			t.Fatal(err)
		}
		appended = append(appended, filler...)
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if err := ph.recording.flushDurable(); err != nil {
		t.Fatal(err)
	}
	return appended
}

// authorityFloor recomputes the public parser-base floor the validator uses:
// the oldest committed byte or the oldest byte inside the history window.
func authorityFloor(m retentionManifest) uint64 {
	floor := m.segs[0].start
	if window := m.head - min(m.head, retentionHistoryCap); window > floor {
		floor = window
	}
	return floor
}

// reopenLegacyHub closes h and opens a fresh hub over the same namespace with
// the same fake clock, leaving on-disk v2 groups without in-memory owners.
func reopenLegacyHub(t *testing.T, h *Hub, dir string, fc *fakeClock) *Hub {
	t.Helper()
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	h2 := NewHub(0)
	h2.clock = fc.Now
	h2.savedReservations = func() (map[string]bool, error) { return map[string]bool{}, nil }
	if err := h2.SetRecordingDirectory(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h2.Close() })
	return h2
}

func TestLegacySweepExistingAuthority(t *testing.T) {
	t.Run("live owner retains authority and dirty tails", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-live"
		payload := bytes.Repeat([]byte("live history line\r\n"), 200)
		ingestDurable(t, h, pane, payload)
		tail := []byte("unflushed live tail\r\n")
		if err := h.Ingest(pane, tail); err != nil {
			t.Fatal(err)
		}
		m := decodeManifest(t, dir, pane)
		if m.head != uint64(len(payload)) {
			t.Fatalf("committed head = %d, want %d (dirty tail must stay uncommitted)", m.head, len(payload))
		}
		manifestBefore := manifestBytes(t, dir, pane)
		rawPath := filepath.Join(groupDir(t, dir, pane), "s0000000000000001.raw")
		rawBefore, err := os.Stat(rawPath)
		if err != nil {
			t.Fatal(err)
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		want := append(append([]byte(nil), payload...), tail...)
		rec, ok := h.Recording(pane, 0, uint64(len(want)))
		if !ok || !bytes.Equal(rec.Data, want) {
			t.Fatalf("live bytes changed: ok=%t len=%d want %d", ok, len(rec.Data), len(want))
		}
		if rawAfter, err := os.Stat(rawPath); err != nil || rawAfter.Size() != rawBefore.Size() {
			t.Fatalf("dirty tail truncated: before=%d after=%v err=%v", rawBefore.Size(), rawAfter, err)
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("authority validation rewrote the manifest")
		}
	})

	t.Run("archive owner retains authority", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-archive"
		payload := bytes.Repeat([]byte("archived history line\r\n"), 200)
		ingestDurable(t, h, pane, payload)
		h.ClosePane(pane)
		manifestBefore := manifestBytes(t, dir, pane)
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		rec, ok := h.Recording(pane, 0, uint64(len(payload)))
		if !ok || !bytes.Equal(rec.Data, payload) {
			t.Fatal("archive lost readable bytes beside retired sources")
		}
		h.mu.RLock()
		_, retained := h.archives[pane]
		h.mu.RUnlock()
		if !retained {
			t.Fatal("authority validation detached the archive owner")
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("authority validation rewrote the manifest")
		}
		if m := decodeManifest(t, dir, pane); m.flags&retentionFlagClosed == 0 {
			t.Fatal("authority validation reopened the closed group")
		}
	})

	t.Run("closed v2 without an owner retains authority", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-closed"
		payload := bytes.Repeat([]byte("closed history line\r\n"), 200)
		ingestDurable(t, h, pane, payload)
		h.ClosePane(pane)
		h2 := reopenLegacyHub(t, h, dir, fc)
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		manifestBefore := manifestBytes(t, dir, pane)
		stats := h2.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		rec, ok := h2.Recording(pane, 0, uint64(len(payload)))
		if !ok || !bytes.Equal(rec.Data, payload) {
			t.Fatal("closed v2 lost readable bytes beside retired sources")
		}
		if !bytes.Equal(manifestBytes(t, dir, pane), manifestBefore) {
			t.Fatal("authority validation rewrote the manifest")
		}
	})
}

func TestLegacySweepAuthorityBases(t *testing.T) {
	// rotateTwice builds [gen2, gen3] with the first-segment prefix evicted
	// and returns the ingested bytes plus the committed manifest.
	rotateTwice := func(t *testing.T, h *Hub, pane string) ([]byte, retentionManifest) {
		t.Helper()
		var ingested []byte
		chunk := rotationChunk()
		for i := 0; i < 9; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
			ingested = append(ingested, chunk...)
		}
		frontier := []byte("durable frontier\r\n")
		ingestDurable(t, h, pane, frontier)
		ingested = append(ingested, frontier...)
		return ingested, decodeManifest(t, h.recordingDirectory, pane)
	}

	t.Run("same-size corrupt gzip preserves sources", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-corrupt-gzip"
		ingested, m := rotateTwice(t, h, pane)
		if len(m.segs) != 2 || m.segs[0].start == 0 {
			t.Fatalf("fixture kept the zero prefix: %+v", m.segs)
		}
		floor := authorityFloor(m)
		if !(m.segs[0].start <= floor && floor < m.segs[1].start) {
			t.Fatalf("fixture floor %d not between starts %d and %d", floor, m.segs[0].start, m.segs[1].start)
		}
		for _, s := range m.segs {
			if s.ckptLen == 0 {
				t.Fatal("fixture segment has no base to corrupt")
			}
			poisonSameSize(t, ckptPathForGen(t, dir, pane, s.gen))
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("corrupt bases changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
		start, data, _ := readRetained(t, h, pane, 0, m.head)
		if start != m.head-uint64(len(data)) || !bytes.Equal(data, ingested[len(ingested)-len(data):]) {
			t.Fatal("v2 raw reads broke beside corrupt bases")
		}
	})

	t.Run("valid gzip with invalid state preserves sources", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-invalid-state"
		_, m := rotateTwice(t, h, pane)
		if len(m.segs) != 2 || m.segs[0].start == 0 {
			t.Fatalf("fixture kept the zero prefix: %+v", m.segs)
		}
		floor := authorityFloor(m)
		if !(m.segs[0].start <= floor && floor < m.segs[1].start) {
			t.Fatalf("fixture floor %d not between starts %d and %d", floor, m.segs[0].start, m.segs[1].start)
		}
		poisonSameSize(t, ckptPathForGen(t, dir, pane, m.segs[1].gen))
		older := ckptPathForGen(t, dir, pane, m.segs[0].gen)
		crafted := storedGzip(t, len(mustRead(t, older)), 'X')
		if err := os.WriteFile(older, crafted, 0600); err != nil {
			t.Fatal(err)
		}
		state, err := restoreAnchor(crafted)
		if err != nil {
			t.Fatalf("fixture must gunzip cleanly: %v", err)
		}
		probe, err := termstate.New(context.Background(), 80, 24)
		if err != nil {
			t.Fatal(err)
		}
		restoreErr := probe.Restore(state)
		_ = probe.Close()
		if restoreErr == nil {
			t.Fatal("fixture must fail disposable-parser Restore")
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("unrestorable base changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
	})

	t.Run("no base after eviction defers", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-no-base"
		chunk := rotationChunk()
		for i := 0; i < 4; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
		}
		ph, _ := h.LookupPane(pane)
		ph.recording.ckptMax = 64
		for i := 0; i < 6; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatalf("unbased rotation stalled live output: %v", err)
			}
		}
		ph.recording.ckptMax = retentionCkptMax
		ingestDurable(t, h, pane, []byte("durable frontier\r\n"))
		m := decodeManifest(t, dir, pane)
		if len(m.segs) != 2 || m.segs[0].start == 0 {
			t.Fatalf("fixture kept the zero prefix: %+v", m.segs)
		}
		for _, s := range m.segs {
			if s.ckptLen != 0 {
				t.Fatalf("fixture segment has a base: %+v", s)
			}
			if _, err := os.Lstat(ckptPathForGen(t, dir, pane, s.gen)); !os.IsNotExist(err) {
				t.Fatalf("unavailable base left a file: %v", err)
			}
		}
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("missing bases changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
	})

	t.Run("eligible older usable base permits cleanup", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-older-base"
		// Two rotations evict the first segment, so only a retained
		// base (never the zero-prefix fallback) can permit cleanup.
		ingested, _ := rotateTwice(t, h, pane)
		ingested = append(ingested, fillLastSegment(t, h, pane, 2)...)
		m := decodeManifest(t, dir, pane)
		if len(m.segs) != 2 || m.segs[0].start == 0 {
			t.Fatalf("fixture kept the zero prefix: %+v", m.segs)
		}
		floor := authorityFloor(m)
		if m.segs[1].start > floor {
			t.Fatalf("newer base start %d above floor %d", m.segs[1].start, floor)
		}
		if m.segs[0].ckptLen == 0 || m.segs[1].ckptLen == 0 {
			t.Fatalf("fixture lost a base: %+v", m.segs)
		}
		// The corrupt newer base fails first; the older usable base
		// at the floor still permits cleanup.
		poisonSameSize(t, ckptPathForGen(t, dir, pane, m.segs[1].gen))
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		_, data, _ := readRetained(t, h, pane, 0, m.head)
		if !bytes.Equal(data, ingested[len(ingested)-len(data):]) {
			t.Fatal("cleanup changed the surviving bytes")
		}
	})

	t.Run("intact zero prefix permits cleanup despite bad checkpoints", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-zero-prefix"
		// One rotation: the first segment keeps the zero prefix and
		// never carries a base, so only the zero-prefix fallback can
		// permit cleanup once the newer base is corrupt.
		var ingested []byte
		chunk := rotationChunk()
		for i := 0; i < 8; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
			ingested = append(ingested, chunk...)
		}
		ingested = append(ingested, fillLastSegment(t, h, pane, 2)...)
		m := decodeManifest(t, dir, pane)
		if len(m.segs) != 2 || m.segs[0].start != 0 || m.segs[0].startOrdinal != 1 {
			t.Fatalf("fixture lost the zero prefix: %+v", m.segs)
		}
		if m.segs[0].ckptLen != 0 {
			t.Fatalf("first segment unexpectedly has a base: %+v", m.segs[0])
		}
		if floor := authorityFloor(m); m.segs[1].start > floor {
			t.Fatalf("newer base start %d above floor %d", m.segs[1].start, floor)
		}
		if m.segs[1].ckptLen == 0 {
			t.Fatal("fixture segment has no base to corrupt")
		}
		ckpt := ckptPathForGen(t, dir, pane, m.segs[1].gen)
		poisonSameSize(t, ckpt)
		ckptHash := sha256.Sum256(mustRead(t, ckpt))
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		if sha256.Sum256(mustRead(t, ckpt)) != ckptHash {
			t.Fatal("cleanup repaired or replaced the bad checkpoint")
		}
		_, data, _ := readRetained(t, h, pane, 0, m.head)
		if !bytes.Equal(data, ingested[len(ingested)-len(data):]) {
			t.Fatal("cleanup changed the surviving bytes")
		}
	})

	t.Run("zero output start with evicted resize prefix does not", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-resize-evicted"
		// No output at all: two resize-metadata rotations evict the
		// first segment while every start stays zero.
		for n := 0; n < 2*4097+10; n++ {
			h.RecordResize(pane, 80+uint16(n%2), 24)
		}
		m := decodeManifest(t, dir, pane)
		if m.head != 0 || len(m.segs) != 2 {
			t.Fatalf("fixture head=%d segs=%+v", m.head, m.segs)
		}
		if m.segs[0].start != 0 || m.segs[0].startOrdinal == 1 {
			t.Fatalf("fixture kept the usable zero prefix: %+v", m.segs)
		}
		for _, s := range m.segs {
			if s.ckptLen == 0 {
				t.Fatal("fixture segment has no base to corrupt")
			}
			poisonSameSize(t, ckptPathForGen(t, dir, pane, s.gen))
		}
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, nil, nil)
		stampLegacy(t, journal, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("evicted resize prefix changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
	})

	t.Run("base newer than the floor alone does not", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-newer-base"
		_, m := rotateTwice(t, h, pane)
		if len(m.segs) != 2 || m.segs[0].start == 0 {
			t.Fatalf("fixture kept the zero prefix: %+v", m.segs)
		}
		floor := authorityFloor(m)
		if !(m.segs[0].start <= floor && floor < m.segs[1].start) {
			t.Fatalf("fixture floor %d not between starts %d and %d", floor, m.segs[0].start, m.segs[1].start)
		}
		poisonSameSize(t, ckptPathForGen(t, dir, pane, m.segs[0].gen))
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		before := sourceHash(t, journal)
		stats := h.sweepRetention(fc.Now())
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("ineligible newer base changed the preserved source")
		}
		requireFailedPath(t, stats, journal)
	})
}

func TestLegacySweepAuthorityChanges(t *testing.T) {
	// setupChange builds a live-owner v2 with a recent legacy source, runs
	// the capture and usability phases, and returns the snapshots for a
	// caller-supplied mutation before finalization.
	setupChange := func(t *testing.T) (*Hub, string, *fakeClock, string, legacySourceSnapshot, *legacyAuthoritySnapshot) {
		t.Helper()
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "authority-change"
		// One rotation leaves a retained base checkpoint to mutate.
		chunk := rotationChunk()
		for i := 0; i < 5; i++ {
			if err := h.Ingest(pane, chunk); err != nil {
				t.Fatal(err)
			}
		}
		ingestDurable(t, h, pane, []byte("change window frontier\r\n"))
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		sourceHead, err := scanLegacySourceHead(snapshot)
		if err != nil {
			t.Fatal(err)
		}
		authority, err := h.captureLegacyAuthority(dir, hash, sourceHead, info.ModTime())
		if err != nil {
			t.Fatal(err)
		}
		if err := checkLegacyAuthorityUsable(authority); err != nil {
			t.Fatal(err)
		}
		return h, dir, fc, journal, snapshot, authority
	}

	t.Run("pane promotion prevents stale finalization", func(t *testing.T) {
		h, _, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		h.ClosePane("authority-change")
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("read-loop owner prevents stale finalization", func(t *testing.T) {
		h, _, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		h.notePaneOwner(&pty.PTYInstance{ID: "authority-change"})
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("manifest growth prevents stale finalization", func(t *testing.T) {
		h, _, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		ingestDurable(t, h, "authority-change", []byte("owner kept writing\r\n"))
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("checkpoint replacement prevents stale finalization", func(t *testing.T) {
		h, dir, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		if len(authority.manifest.segs) != 2 || authority.manifest.segs[1].ckptLen == 0 {
			t.Fatalf("fixture has no checkpoint to replace: %+v", authority.manifest.segs)
		}
		poisonSameSize(t, ckptPathForGen(t, dir, "authority-change", authority.manifest.segs[1].gen))
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("pending commit prevents stale finalization", func(t *testing.T) {
		perCommitDurability(t)
		h, _, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		ph, _ := h.LookupPane("authority-change")
		ph.recording.faults.dirSync = fmt.Errorf("injected dirSync failure")
		if err := h.Ingest("authority-change", []byte("pending\r\n")); err == nil {
			t.Fatal("dirSync fault admitted bytes")
		}
		ph.mu.Lock()
		pending := ph.recording.pending != nil
		ph.mu.Unlock()
		if !pending {
			t.Fatal("setup did not leave a pending commit")
		}
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("pending resize prevents stale finalization", func(t *testing.T) {
		perCommitDurability(t)
		h, _, _, journal, snapshot, authority := setupChange(t)
		before := sourceHash(t, journal)
		ph, _ := h.LookupPane("authority-change")
		ph.recording.faults.rszSync = fmt.Errorf("injected resize sync failure")
		h.RecordResize("authority-change", 100, 40)
		ph.mu.Lock()
		pending := ph.pendingResize != nil
		ph.mu.Unlock()
		if !pending {
			t.Fatal("setup did not leave a pending resize")
		}
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyPresent(t, journal)
		if sourceHash(t, journal) != before {
			t.Fatal("stale finalization changed the source")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("another pane can ingest between capture and finalization", func(t *testing.T) {
		h, _, _, journal, snapshot, authority := setupChange(t)
		ingestDurable(t, h, "unrelated-pane", []byte("unrelated output\r\n"))
		var stats retentionSweepStats
		h.finalizeLegacyAuthority(snapshot, authority, &stats)
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
	})
}

func TestLegacySweepSourceIdentity(t *testing.T) {
	stageForIdentity := func(t *testing.T, h *Hub, dir, pane string) (legacySourceSnapshot, string, string) {
		t.Helper()
		journal, _ := seedSmallLegacy(t, dir, pane, time.Unix(1_700_000_000, 0).UTC().Add(-time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stageLegacyImport(journal, staging, info.Size(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		return snapshot, journal, staging
	}

	finalizeConversion := func(t *testing.T, h *Hub, dir string, snapshot legacySourceSnapshot, staging string) retentionSweepStats {
		t.Helper()
		var stats retentionSweepStats
		h.finalizeLegacyCandidate(dir, snapshot, staging, legacySavedHashes(nil), time.Unix(1_700_000_000, 0).UTC(), &stats)
		return stats
	}

	t.Run("journal append blocks publication", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "identity-append"
		snapshot, journal, staging := stageForIdentity(t, h, dir, pane)
		before := sourceHash(t, journal)
		f, err := os.OpenFile(journal, os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte("appended after staging")); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		stats := finalizeConversion(t, h, dir, snapshot, staging)
		requireFailedPath(t, stats, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("stale snapshot published: %v", err)
		}
		// The failed finalizer must not touch the changed source either.
		if sourceHash(t, journal) == before {
			t.Fatal("setup did not change the journal")
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("inode replacement with identical size and time blocks publication", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "identity-inode"
		snapshot, journal, staging := stageForIdentity(t, h, dir, pane)
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		data := mustRead(t, journal)
		if err := os.Remove(journal); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(journal, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(journal, info.ModTime(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		stats := finalizeConversion(t, h, dir, snapshot, staging)
		requireFailedPath(t, stats, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("stale snapshot published: %v", err)
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("checkpoint replacement blocks publication", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "identity-checkpoint"
		snapshot, journal, staging := stageForIdentity(t, h, dir, pane)
		if len(snapshot.checkpoints) != 1 {
			t.Fatalf("fixture checkpoints = %d, want 1", len(snapshot.checkpoints))
		}
		ckpt := snapshot.checkpoints[0].path
		info, err := os.Stat(ckpt)
		if err != nil {
			t.Fatal(err)
		}
		data := mustRead(t, ckpt)
		if err := os.Remove(ckpt); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(ckpt, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(ckpt, info.ModTime(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		stats := finalizeConversion(t, h, dir, snapshot, staging)
		requireFailedPath(t, stats, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("stale snapshot published: %v", err)
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("checkpoint membership change blocks publication", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "identity-membership"
		snapshot, journal, staging := stageForIdentity(t, h, dir, pane)
		extra := filepath.Join(journal+".state.d", "00000000000000999999.state")
		if err := os.WriteFile(extra, []byte("late checkpoint"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := finalizeConversion(t, h, dir, snapshot, staging)
		requireFailedPath(t, stats, journal)
		if _, err := os.Lstat(groupDir(t, dir, pane)); !os.IsNotExist(err) {
			t.Fatalf("stale snapshot published: %v", err)
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("journal append blocks expiry deletion", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "identity-expiry"
		journal := legacyLogPath(dir, pane)
		writeLegacyLog(t, journal, [][]byte{[]byte("expired source\r\n")}, nil)
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		snapshot, err := snapshotLegacySource(dir, filepath.Base(journal)[:64], true)
		if err != nil {
			t.Fatal(err)
		}
		f, err := os.OpenFile(journal, os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte("appended after snapshot")); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		var stats retentionSweepStats
		h.finalizeLegacyCandidate(dir, snapshot, "", legacySavedHashes(nil), fc.Now(), &stats)
		requireFailedPath(t, stats, journal)
		requireLegacyPresent(t, journal)
	})
}

func TestLegacySweepOrphanCheckpoints(t *testing.T) {
	writeOrphan := func(t *testing.T, dir, pane string, names []string, at time.Time) string {
		t.Helper()
		ckptDir := legacyLogPath(dir, pane) + ".state.d"
		if err := os.MkdirAll(ckptDir, 0700); err != nil {
			t.Fatal(err)
		}
		for _, name := range names {
			if err := os.WriteFile(filepath.Join(ckptDir, name), []byte("orphan checkpoint "+name), 0600); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range names {
			stampLegacy(t, filepath.Join(ckptDir, name), at)
		}
		return ckptDir
	}

	t.Run("old unreserved orphans expire", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-old"
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state", "00000000000000000020.state"}, fc.Now().Add(-8*24*time.Hour))
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(ckptDir); !os.IsNotExist(err) {
			t.Fatalf("expired orphan directory remains: %v", err)
		}
		if stats.BytesReclaimed == 0 {
			t.Fatal("expired orphans reclaimed no bytes")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("recent orphans survive beside valid v2", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-recent"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(-time.Hour))
		before := mustRead(t, filepath.Join(ckptDir, "00000000000000000010.state"))
		stats := h.sweepRetention(fc.Now())
		if !bytes.Equal(mustRead(t, filepath.Join(ckptDir, "00000000000000000010.state")), before) {
			t.Fatal("recent orphan did not survive beside valid v2")
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("future orphans survive beside valid v2", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-future"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(time.Hour))
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); err != nil {
			t.Fatalf("future orphan did not survive: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("unestablished orphans survive beside valid v2", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-unestablished"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, time.Time{})
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); err != nil {
			t.Fatalf("unestablished orphan did not survive: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("saved orphans survive beside valid v2", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-saved"
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		h.ClosePane(pane)
		h.savedReservations = func() (map[string]bool, error) { return map[string]bool{pane: true}, nil }
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(-8*24*time.Hour))
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); err != nil {
			t.Fatalf("saved orphan did not survive: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("live orphans survive beside valid v2", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-live"
		// Keep the pane live: orphan checkpoints for a live ID survive
		// even when every file is old and valid v2 exists.
		ingestDurable(t, h, pane, bytes.Repeat([]byte("v2 history\r\n"), 200))
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(-8*24*time.Hour))
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); err != nil {
			t.Fatalf("live orphan did not survive: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("directory time alone cannot expire fresh files", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-dirtime"
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(-time.Hour))
		old := fc.Now().Add(-8 * 24 * time.Hour)
		if err := os.Chtimes(ckptDir, old, old); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); err != nil {
			t.Fatalf("fresh orphan expired by directory time: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("unknown entries survive beside expired orphans", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-unknown"
		ckptDir := writeOrphan(t, dir, pane, []string{"00000000000000000010.state"}, fc.Now().Add(-8*24*time.Hour))
		mystery := filepath.Join(ckptDir, "notes.txt")
		if err := os.WriteFile(mystery, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		nested := filepath.Join(ckptDir, "nested")
		if err := os.Mkdir(nested, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, "deep.state"), []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(filepath.Join(ckptDir, "00000000000000000010.state")); !os.IsNotExist(err) {
			t.Fatalf("expired orphan remains: %v", err)
		}
		for _, p := range []string{mystery, nested, filepath.Join(nested, "deep.state"), ckptDir} {
			if _, err := os.Lstat(p); err != nil {
				t.Fatalf("unknown entry %s did not survive: %v", p, err)
			}
		}
		requireFailedPathsEmpty(t, stats)
	})

	t.Run("empty recognized directory is removed after checks", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "orphan-empty"
		ckptDir := legacyLogPath(dir, pane) + ".state.d"
		if err := os.MkdirAll(ckptDir, 0700); err != nil {
			t.Fatal(err)
		}
		stats := h.sweepRetention(fc.Now())
		if _, err := os.Lstat(ckptDir); !os.IsNotExist(err) {
			t.Fatalf("empty orphan directory remains: %v", err)
		}
		requireFailedPathsEmpty(t, stats)
	})
}

func TestLegacySweepDeletionFailures(t *testing.T) {
	t.Run("first checkpoint unlink failure keeps the retry anchor", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "delete-first"
		journal := legacyLogPath(dir, pane)
		source := writeLegacyLog(t, journal, [][]byte{[]byte("expired source\r\n")}, nil)
		writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
		extra := filepath.Join(journal+".state.d", "00000000000000000005.state")
		if err := os.WriteFile(extra, []byte("second checkpoint"), 0600); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.checkpoints) != 2 {
			t.Fatalf("fixture checkpoints = %d, want 2", len(snapshot.checkpoints))
		}
		old := legacyRemove
		legacyRemove = func(path string) error {
			if path == snapshot.checkpoints[0].path {
				return fmt.Errorf("injected checkpoint unlink failure")
			}
			return old(path)
		}
		t.Cleanup(func() { legacyRemove = old })
		stats := h.sweepRetention(fc.Now())
		requireFailedPath(t, stats, snapshot.checkpoints[0].path)
		if stats.BytesReclaimed != 0 {
			t.Fatalf("claimed %d bytes without unlinking anything", stats.BytesReclaimed)
		}
		requireLegacyPresent(t, journal)
		for _, c := range snapshot.checkpoints {
			if _, err := os.Lstat(c.path); err != nil {
				t.Fatalf("checkpoint %s removed before the anchor: %v", c.path, err)
			}
		}
	})

	t.Run("later checkpoint unlink failure counts actual unlinks", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "delete-later"
		journal := legacyLogPath(dir, pane)
		source := writeLegacyLog(t, journal, [][]byte{[]byte("expired source\r\n")}, nil)
		writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
		extra := filepath.Join(journal+".state.d", "00000000000000000005.state")
		if err := os.WriteFile(extra, []byte("second checkpoint"), 0600); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.checkpoints) != 2 {
			t.Fatalf("fixture checkpoints = %d, want 2", len(snapshot.checkpoints))
		}
		old := legacyRemove
		legacyRemove = func(path string) error {
			if path == snapshot.checkpoints[1].path {
				return fmt.Errorf("injected checkpoint unlink failure")
			}
			return old(path)
		}
		t.Cleanup(func() { legacyRemove = old })
		stats := h.sweepRetention(fc.Now())
		requireFailedPath(t, stats, snapshot.checkpoints[1].path)
		if stats.BytesReclaimed != uint64(snapshot.checkpoints[0].info.Size()) {
			t.Fatalf("reclaimed %d bytes, want the one actual unlink (%d)", stats.BytesReclaimed, snapshot.checkpoints[0].info.Size())
		}
		if _, err := os.Lstat(snapshot.checkpoints[0].path); !os.IsNotExist(err) {
			t.Fatalf("first checkpoint remains: %v", err)
		}
		if _, err := os.Lstat(snapshot.checkpoints[1].path); err != nil {
			t.Fatalf("failed checkpoint removed: %v", err)
		}
		requireLegacyPresent(t, journal)
	})

	t.Run("journal unlink failure keeps v2 readable", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "delete-journal"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		old := legacyRemove
		legacyRemove = func(path string) error {
			if path == journal {
				return fmt.Errorf("injected journal unlink failure")
			}
			return old(path)
		}
		t.Cleanup(func() { legacyRemove = old })
		stats := h.sweepRetention(fc.Now())
		requireFailedPath(t, stats, journal)
		requireLegacyPresent(t, journal)
		if _, err := os.Lstat(journal + ".state.d"); !os.IsNotExist(err) {
			t.Fatalf("checkpoints remain after journal failure: %v", err)
		}
		if stats.BytesReclaimed == 0 {
			t.Fatal("unlinked checkpoints claimed no bytes")
		}
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("published v2 unreadable after journal unlink failure")
		}
	})

	t.Run("post-unlink directory sync failure reports without hiding deletions", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "delete-sync"
		journal, _ := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		var want uint64 = uint64(info.Size())
		entries, err := os.ReadDir(journal + ".state.d")
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entryInfo, err := entry.Info(); err == nil {
				want += uint64(entryInfo.Size())
			}
		}
		old := legacySyncDir
		legacySyncDir = func(path string) error {
			if path == dir {
				if _, err := os.Lstat(journal); os.IsNotExist(err) {
					return fmt.Errorf("injected post-unlink sync failure")
				}
			}
			return old(path)
		}
		t.Cleanup(func() { legacySyncDir = old })
		stats := h.sweepRetention(fc.Now())
		requireFailedPath(t, stats, dir)
		requireLegacyAbsent(t, journal)
		if stats.BytesReclaimed != want {
			t.Fatalf("reclaimed %d bytes, want %d for deleted sources", stats.BytesReclaimed, want)
		}
		// A later normal sweep retries the durability barrier silently.
		legacySyncDir = old
		if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
			t.Fatalf("retry failed paths = %v", stats.FailedPaths)
		}
	})

	t.Run("checkpoint directory sync retries while the directory exists", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "delete-ckpt-sync"
		journal := legacyLogPath(dir, pane)
		source := writeLegacyLog(t, journal, [][]byte{[]byte("expired source\r\n")}, nil)
		writeLegacyAnchor(t, journal, uint64(len(source)), source, nil)
		extra := filepath.Join(journal+".state.d", "00000000000000000005.state")
		if err := os.WriteFile(extra, []byte("second checkpoint"), 0600); err != nil {
			t.Fatal(err)
		}
		stampLegacySet(t, journal, fc.Now().Add(-8*24*time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.checkpoints) != 2 {
			t.Fatalf("fixture checkpoints = %d, want 2", len(snapshot.checkpoints))
		}
		// A removed checkpoint directory needs no barrier; only a
		// partial cleanup with the directory still in place syncs it.
		// Fail the second unlink and the directory barrier together.
		ckptDir := journal + ".state.d"
		oldRemove, oldSync := legacyRemove, legacySyncDir
		legacyRemove = func(path string) error {
			if path == snapshot.checkpoints[1].path {
				return fmt.Errorf("injected checkpoint unlink failure")
			}
			return oldRemove(path)
		}
		legacySyncDir = func(path string) error {
			if path == ckptDir {
				return fmt.Errorf("injected checkpoint sync failure")
			}
			return oldSync(path)
		}
		t.Cleanup(func() { legacyRemove, legacySyncDir = oldRemove, oldSync })
		stats := h.sweepRetention(fc.Now())
		requireFailedPath(t, stats, snapshot.checkpoints[1].path)
		requireFailedPath(t, stats, ckptDir)
		if stats.BytesReclaimed != uint64(snapshot.checkpoints[0].info.Size()) {
			t.Fatalf("reclaimed %d bytes, want the one actual unlink (%d)", stats.BytesReclaimed, snapshot.checkpoints[0].info.Size())
		}
		requireLegacyPresent(t, journal)
		if _, err := os.Lstat(ckptDir); err != nil {
			t.Fatalf("checkpoint directory removed before its barrier: %v", err)
		}
		legacyRemove, legacySyncDir = oldRemove, oldSync
		if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
			t.Fatalf("retry failed paths = %v", stats.FailedPaths)
		}
		requireLegacyAbsent(t, journal)
	})
}

func TestLegacySweepRetriesInterruptedCleanup(t *testing.T) {
	t.Run("leftover staging does not block conversion", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "retry-staging"
		leftover := filepath.Join(dir, "v2", ".import-leftover")
		if err := os.Mkdir(leftover, 0700); err != nil {
			t.Fatal(err)
		}
		junk := filepath.Join(leftover, "junk")
		if err := os.WriteFile(junk, []byte("interrupted attempt"), 0600); err != nil {
			t.Fatal(err)
		}
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		stats := h.sweepRetention(fc.Now())
		requireLegacyAbsent(t, journal)
		requireFailedPathsEmpty(t, stats)
		if got := string(mustRead(t, junk)); got != "interrupted attempt" {
			t.Fatalf("leftover staging changed: %q", got)
		}
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("conversion beside leftover staging lost bytes")
		}
	})

	t.Run("rename before parent sync retries through authority", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "retry-sync"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		oldSync := legacySyncDir
		legacySyncDir = func(path string) error {
			if path == filepath.Join(dir, "v2") {
				return fmt.Errorf("injected parent sync failure")
			}
			return oldSync(path)
		}
		stats := h.sweepRetention(fc.Now())
		legacySyncDir = oldSync
		t.Cleanup(func() { legacySyncDir = oldSync })
		requireFailedPath(t, stats, journal)
		requireLegacyPresent(t, journal)
		published := manifestBytes(t, dir, pane)
		oldRename := importRename
		importRename = func(_, _ string) error { return fmt.Errorf("conversion must not repeat") }
		t.Cleanup(func() { importRename = oldRename })
		if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
			t.Fatalf("retry failed paths = %v", stats.FailedPaths)
		}
		requireLegacyAbsent(t, journal)
		if !bytes.Equal(manifestBytes(t, dir, pane), published) {
			t.Fatal("retry overwrote the published destination")
		}
		assertNoStagingLeftovers(t, dir)
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("retry lost the published bytes")
		}
	})

	t.Run("restart after partial deletion finishes through authority", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "retry-partial"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		old := legacyRemove
		legacyRemove = func(path string) error {
			if path == journal {
				return fmt.Errorf("injected journal unlink failure")
			}
			return old(path)
		}
		stats := h.sweepRetention(fc.Now())
		legacyRemove = old
		t.Cleanup(func() { legacyRemove = old })
		requireFailedPath(t, stats, journal)
		requireLegacyPresent(t, journal)
		published := manifestBytes(t, dir, pane)
		h2 := reopenLegacyHub(t, h, dir, fc)
		if stats := h2.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
			t.Fatalf("restart retry failed paths = %v", stats.FailedPaths)
		}
		requireLegacyAbsent(t, journal)
		if !bytes.Equal(manifestBytes(t, dir, pane), published) {
			t.Fatal("restart retry overwrote the published destination")
		}
		rec, ok := h2.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("restart retry lost the published bytes")
		}
	})
}

func TestLegacySweepConcurrentAdmission(t *testing.T) {
	t.Run("pane admitted after staging wins", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "race-pane-wins"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stageLegacyImport(journal, staging, info.Size(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		if _, err := h.GetOrCreatePaneHub(pane); err != nil {
			t.Fatal(err)
		}
		var stats retentionSweepStats
		h.finalizeLegacyCandidate(dir, snapshot, staging, legacySavedHashes(nil), fc.Now(), &stats)
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("admitted pane lost the winner bytes")
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("cold reader admitted after staging wins", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		const pane = "race-reader-wins"
		journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		hash := filepath.Base(journal)[:64]
		snapshot, err := snapshotLegacySource(dir, hash, true)
		if err != nil {
			t.Fatal(err)
		}
		staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(journal)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := stageLegacyImport(journal, staging, info.Size(), info.ModTime()); err != nil {
			t.Fatal(err)
		}
		if _, ok := h.Recording(pane, 0, uint64(len(source))); !ok {
			t.Fatal("cold reader did not adopt the legacy source")
		}
		var stats retentionSweepStats
		h.finalizeLegacyCandidate(dir, snapshot, staging, legacySavedHashes(nil), fc.Now(), &stats)
		requireLegacyPresent(t, journal)
		requireFailedPathsEmpty(t, stats)
		rec, ok := h.Recording(pane, 0, uint64(len(source)))
		if !ok || !bytes.Equal(rec.Data, source) {
			t.Fatal("admitted reader lost the winner bytes")
		}
		assertNoStagingLeftovers(t, dir)
	})

	t.Run("sweep races admission and reads", func(t *testing.T) {
		fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
		h, dir := expiryTestHub(t, fc)
		panes := []string{"race-a", "race-b"}
		for _, pane := range panes {
			seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < 3; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				for j := 0; j < 5; j++ {
					h.sweepRetention(fc.Now())
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 20; j++ {
				_ = h.Ingest("race-a", []byte("live\r\n"))
			}
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 20; j++ {
				h.Recording("race-a", 0, 1<<20)
				h.Recording("race-b", 0, 1<<20)
			}
		}()
		close(start)
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(60 * time.Second):
			t.Fatal("concurrent sweep/admission/read did not complete")
		}
		for _, pane := range panes {
			if _, err := os.Lstat(groupDir(t, dir, pane)); err == nil {
				decodeManifest(t, dir, pane)
				if rec, ok := h.Recording(pane, 0, 1<<20); ok && uint64(len(rec.Data)) != rec.End-rec.Start {
					t.Fatalf("pane %s serves %d bytes for [%d,%d)", pane, len(rec.Data), rec.Start, rec.End)
				}
			}
			if _, err := os.Lstat(legacyLogPath(dir, pane)); err == nil {
				f, err := os.Open(legacyLogPath(dir, pane))
				if err != nil {
					t.Fatal(err)
				}
				info, err := f.Stat()
				if err != nil {
					f.Close()
					t.Fatal(err)
				}
				if _, err := scanLegacyLog(f, info.Size(), nil); err != nil {
					f.Close()
					t.Fatalf("pane %s legacy journal left unscannable: %v", pane, err)
				}
				f.Close()
			}
		}
		if err := h.Ingest("race-a", []byte("after\r\n")); err != nil {
			t.Fatalf("hub unusable after the race: %v", err)
		}
	})
}

func TestLegacyImportAdoptsSweepPublishedWinner(t *testing.T) {
	fc := &fakeClock{now: time.Unix(1_700_000_000, 0).UTC()}
	h, dir := expiryTestHub(t, fc)
	const pane = "legacy-sweep-winner"
	journal, source := seedSmallLegacy(t, dir, pane, fc.Now().Add(-time.Hour))
	if stats := h.sweepRetention(fc.Now()); len(stats.FailedPaths) != 0 {
		t.Fatalf("setup sweep failures = %v", stats.FailedPaths)
	}
	requireLegacyAbsent(t, journal)
	// A journal beside the published v2 whose staging fails: the sweep
	// may have retired the source the importer started reading. The
	// importer must adopt the published winner instead of failing.
	writeLegacyLog(t, journal, [][]byte{[]byte("a\r\n"), []byte("b\r\n"), []byte("c\r\n")}, nil)
	data := mustRead(t, journal)
	data[len("a\r\n")+5] = 9
	if err := os.WriteFile(journal, data, 0600); err != nil {
		t.Fatal(err)
	}
	stampLegacySet(t, journal, fc.Now().Add(-time.Hour))
	for i := 0; i < 2; i++ {
		adopted, err := h.importLegacyGroup(pane)
		if err != nil {
			t.Fatalf("import %d failed beside a published winner: %v", i, err)
		}
		if adopted {
			t.Fatalf("import %d claimed adoption beside a published winner", i)
		}
	}
	assertNoStagingLeftovers(t, dir)
	rec, ok := h.Recording(pane, 0, uint64(len(source)))
	if !ok || !bytes.Equal(rec.Data, source) {
		t.Fatal("published winner unreadable after adoption")
	}
}
