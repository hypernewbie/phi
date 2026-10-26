package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
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
)

const (
	importStreamChunk  = 1 << 20
	importResizeCap    = 16384
	importAnchorBudget = 32 << 20
	importAnchorMax    = 64 << 20
)

// importFailure keys a negative cache entry by source identity. A changed
// source retries; an unchanged failure never rescans.
type importFailure struct {
	size  int64
	mtime time.Time
}

// importStats describes one import attempt for tests and the import log.
type importStats struct {
	usedAnchor  bool
	parsedBytes uint64
	sourceBytes int64
}

func sameSource(sizeA int64, mtimeA time.Time, sizeB int64, mtimeB time.Time) bool {
	return sizeA == sizeB && mtimeA.Equal(mtimeB)
}

func (h *Hub) lastImportStats() importStats {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.lastStats
}

func (h *Hub) legacyRecordingPath(paneID string) string {
	if h.recordingDirectory == "" {
		return ""
	}
	return filepath.Join(h.recordingDirectory, fmt.Sprintf("%x.log", sha256.Sum256([]byte(paneID))))
}

// errLegacyImportFailed marks an eligible legacy source the importer
// could not adopt. Callers fail loudly instead of publishing fresh
// authority over the unreadable history.
var errLegacyImportFailed = errors.New("eligible legacy import failed")

// importRename publishes a staged import; a variable so tests can fail
// the rename deterministically (no parallel ws tests swap it).
var importRename = os.Rename

// adoptConcurrentWinner drops a losing staging when a concurrent sweep
// or importer published the destination first. It reports whether the
// caller should resolve the published winner instead of failing.
func adoptConcurrentWinner(final, staging string) bool {
	if _, err := os.Stat(final); err == nil {
		os.RemoveAll(staging)
		return true
	}
	return false
}

// importLegacyGroup migrates an eligible legacy journal into a bounded
// versioned group and publishes it as a closed archive. The legacy
// original is only ever read: eligibility failures, corrupt data, and
// concurrent modification all abort without writing either side.
// Slow staging runs unlocked; the rename and publish share one hold.
// It reports (false, nil) for ineligible sources, where the caller may
// proceed fresh, and (false, err) for eligible sources it could not
// adopt, where the caller must fail without fresh authority.
func (h *Hub) importLegacyGroup(paneID string) (bool, error) {
	h.mu.RLock()
	dir := h.recordingDirectory
	h.mu.RUnlock()
	if dir == "" {
		return false, nil
	}
	legacy := filepath.Join(dir, fmt.Sprintf("%x.log", sha256.Sum256([]byte(paneID))))
	now := h.wallClock()
	info, err := os.Lstat(legacy)
	if err != nil {
		return false, nil
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("%w: source is not a regular file", errLegacyImportFailed)
	}
	mtime := info.ModTime()
	if mtime.After(now) || now.Sub(mtime) >= retentionPeriod {
		return false, nil
	}
	h.mu.RLock()
	failed, seen := h.importFailed[paneID]
	h.mu.RUnlock()
	if seen && sameSource(info.Size(), mtime, failed.size, failed.mtime) {
		return false, fmt.Errorf("%w: unchanged source already failed", errLegacyImportFailed)
	}
	cacheFailure := func() {
		h.mu.Lock()
		if h.importFailed == nil {
			h.importFailed = make(map[string]importFailure)
		}
		h.importFailed[paneID] = importFailure{size: info.Size(), mtime: mtime}
		h.mu.Unlock()
	}
	h.mu.Lock()
	h.importScans++
	h.mu.Unlock()
	// Stage beside the destination: a system temp dir may live on another
	// filesystem where the final rename cannot work.
	staging, err := os.MkdirTemp(filepath.Join(dir, "v2"), ".import-*")
	if err != nil {
		return false, fmt.Errorf("%w: staging: %v", errLegacyImportFailed, err)
	}
	stats, err := stageLegacyImport(legacy, staging, info.Size(), mtime)
	h.mu.Lock()
	h.lastStats = stats
	h.mu.Unlock()
	if err != nil {
		// A concurrent sweep may have published the replacement and
		// retired the source mid-staging. Adopt the winner instead
		// of failing: the caller resolves the published group.
		h.mu.RLock()
		final := h.recordingPath(paneID)
		h.mu.RUnlock()
		if final != "" && adoptConcurrentWinner(final, staging) {
			return false, nil
		}
		cacheFailure()
		os.RemoveAll(staging)
		log.Printf("[ws] legacy import of %s failed; the original is untouched: %v", legacy, err)
		return false, fmt.Errorf("%w: %v", errLegacyImportFailed, err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if ph := h.panes[paneID]; ph != nil {
		os.RemoveAll(staging)
		return false, nil
	}
	if ph := h.archives[paneID]; ph != nil {
		os.RemoveAll(staging)
		return false, nil
	}
	final := h.recordingPath(paneID)
	if final == "" {
		os.RemoveAll(staging)
		return false, nil
	}
	if _, err := os.Stat(final); err == nil {
		os.RemoveAll(staging)
		return false, nil
	}
	if cur, err := os.Lstat(legacy); err != nil || !sameSource(info.Size(), mtime, cur.Size(), cur.ModTime()) {
		// The source may be gone because a concurrent sweep published
		// and retired it while this staging waited on the hub lock.
		if adoptConcurrentWinner(final, staging) {
			return false, nil
		}
		os.RemoveAll(staging)
		return false, fmt.Errorf("%w: source changed during staging", errLegacyImportFailed)
	}
	if err := importRename(staging, final); err != nil {
		// A concurrent winner may have published between the check
		// and the rename; adopt that instead of failing.
		if _, serr := os.Stat(final); serr == nil {
			os.RemoveAll(staging)
			return false, nil
		}
		// This branch already holds h.mu: update the cache inline
		// instead of calling cacheFailure (which locks).
		if h.importFailed == nil {
			h.importFailed = make(map[string]importFailure)
		}
		h.importFailed[paneID] = importFailure{size: info.Size(), mtime: mtime}
		os.RemoveAll(staging)
		return false, fmt.Errorf("%w: rename: %v", errLegacyImportFailed, err)
	}
	_ = syncDir(filepath.Dir(final))
	recording, err := openRetentionGroup(final)
	if err != nil {
		log.Printf("[ws] imported group for %s failed to open; left for inspection: %v", paneID, err)
		return false, fmt.Errorf("%w: reopen: %v", errLegacyImportFailed, err)
	}
	h.takeGroupClock(recording)
	h.archives[paneID] = &PaneHub{
		clients:          make(map[*Client]bool),
		recording:        recording,
		epoch:            randomEpoch(),
		total:            recording.head,
		closedAtUnixNano: mtime.UnixNano(),
	}
	log.Printf("[ws] imported legacy recording for %s (%d source bytes, anchor=%t)", paneID, info.Size(), stats.usedAnchor)
	return true, nil
}

// stageLegacyImport streams the legacy journal, builds a bounded
// single-segment replacement in staging, reopens it, and compares the
// retained bytes and current parser state. Memory stays bounded:
// one stream window, the imported tail, the parser, and capped markers.
func stageLegacyImport(legacy, staging string, size int64, mtime time.Time) (importStats, error) {
	var stats importStats
	stats.sourceBytes = size
	// Anchors are an optimization, not a requirement: list them only from
	// a real directory, never through a symlink, and otherwise stream the
	// full prefix. The sweep still refuses such a source outright.
	var anchors []uint64
	if info, err := os.Lstat(legacy + ".state.d"); err == nil && info.IsDir() {
		anchors = listLegacyAnchors(legacy + ".state.d")
	} else if err != nil && !os.IsNotExist(err) {
		return stats, err
	}
	f, err := os.Open(legacy)
	if err != nil {
		return stats, err
	}
	defer f.Close()
	scan, err := scanLegacyLog(f, size, anchors)
	if err != nil {
		return stats, err
	}
	// The replacement is one segment, so the imported tail is bounded by the
	// physical segment ceiling, not by the larger public history window.
	tailLimit := uint64(min(retentionHistoryCap, retentionSegRawMax))
	tailStart := uint64(0)
	if scan.head > tailLimit {
		tailStart = scan.head - tailLimit
	}
	// Newest first: a corrupt anchor falls back to an older one, then
	// to a full prefix stream.
	var order []uint64
	for _, a := range anchors {
		if a <= tailStart {
			if _, ok := scan.crossed[a]; ok {
				order = append(order, a)
			}
		}
	}
	sort.Slice(order, func(i, j int) bool { return order[i] > order[j] })
	order = append(order, ^uint64(0))
	var tail []byte
	var ckptGz []byte
	var headReady []byte
	var parsedBytes uint64
	streamed := false
	for _, through := range order {
		var anchor []byte
		startOff := int64(0)
		recStart := uint64(0)
		skipTo := uint64(0)
		if through != ^uint64(0) {
			anchor, err = readLegacyAnchor(legacy+".state.d", through)
			if err != nil {
				continue
			}
			cross := scan.crossed[through]
			startOff = cross.off
			recStart = cross.start
			skipTo = through
		}
		tail, ckptGz, headReady, parsedBytes, err = streamLegacyTail(f, scan.committed, startOff, recStart, skipTo, tailStart, scan.head, anchor)
		if err == errAnchorUnusable {
			continue
		}
		if err != nil {
			return stats, err
		}
		stats.usedAnchor = through != ^uint64(0)
		streamed = true
		break
	}
	if !streamed {
		return stats, fmt.Errorf("legacy import found no usable parser base")
	}
	stats.parsedBytes = parsedBytes
	if cur, err := os.Stat(legacy); err != nil || !sameSource(size, mtime, cur.Size(), cur.ModTime()) {
		return stats, fmt.Errorf("legacy source changed during import")
	}
	markers := importTailMarkers(scan.resizes, tailStart)
	if err := buildImportedGroup(staging, tailStart, scan.head, markers, ckptGz, tail, mtime); err != nil {
		return stats, err
	}
	if err := verifyImportedGroup(staging, tailStart, scan.head, tail, markers, headReady); err != nil {
		return stats, err
	}
	return stats, nil
}

func listLegacyAnchors(dir string) []uint64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []uint64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".state")
		through, err := strconv.ParseUint(name, 10, 64)
		if err != nil || entry.Name() != name+".state" {
			continue
		}
		out = append(out, through)
	}
	return out
}

func readLegacyAnchor(dir string, through uint64) ([]byte, error) {
	path := filepath.Join(dir, fmt.Sprintf("%020d.state", through))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > importAnchorBudget {
		return nil, fmt.Errorf("legacy anchor unusable")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("legacy anchor unusable")
	}
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("legacy anchor unusable")
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, importAnchorMax+1))
	if err != nil || len(out) > importAnchorMax {
		return nil, fmt.Errorf("legacy anchor unusable")
	}
	return out, nil
}

type legacyCrossing struct {
	off   int64
	start uint64
}

type legacyScan struct {
	head      uint64
	committed int64
	resizes   []ResizeMarker
	crossed   map[uint64]legacyCrossing
}

// scanLegacyLog walks record headers with a buffered window, skipping
// payload bytes without copying them. A bad header with a valid later
// chain is corrupt committed data; anything else is a torn tail.
func scanLegacyLog(f *os.File, size int64, anchors []uint64) (*legacyScan, error) {
	scan := &legacyScan{crossed: make(map[uint64]legacyCrossing)}
	sorted := append([]uint64(nil), anchors...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	anchorIdx := 0
	window := make([]byte, importStreamChunk)
	var wOff, wLen int64
	var pos int64
	head := uint64(0)
	fill := func() error {
		if pos < wOff || pos >= wOff+wLen {
			wOff = pos
			n, err := f.ReadAt(window, wOff)
			wLen = int64(n)
			if err != nil && err != io.EOF {
				return err
			}
		}
		return nil
	}
	at := func(off int64, n int64) ([]byte, bool) {
		if off < wOff || off+n > wOff+wLen {
			return nil, false
		}
		return window[off-wOff : off-wOff+n], true
	}
	for pos < size {
		if err := fill(); err != nil {
			return nil, err
		}
		hdr, ok := at(pos, 5)
		if !ok {
			var raw [5]byte
			n, err := f.ReadAt(raw[:], pos)
			if err != nil && err != io.EOF {
				return nil, err
			}
			if int64(n) < 5 {
				break
			}
			hdr = raw[:]
		}
		kind := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		if (kind != 1 && kind != 2) || (kind == 2 && n != 4) || n > 64*1024*1024 || pos+5+int64(n) > size {
			suffixStart := pos + 5
			if kind != 1 && kind != 2 {
				suffixStart = pos + 1
			}
			if hasValidRecordSuffix(f, suffixStart, size) {
				return nil, fmt.Errorf("corrupt legacy record at offset %d before retained suffix", pos)
			}
			break
		}
		recEnd := head + recordHeadLen(kind, n)
		for anchorIdx < len(sorted) {
			a := sorted[anchorIdx]
			// An output record covers [head, recEnd); a resize at
			// head applies to every byte at or after head. Anchors
			// and records both advance monotonically, so one pointer
			// crosses each anchor at its first relevant record.
			var inside bool
			if kind == 1 {
				inside = a < recEnd
			} else {
				inside = a <= head
			}
			if !inside {
				break
			}
			scan.crossed[a] = legacyCrossing{off: pos, start: head}
			anchorIdx++
		}
		if kind == 1 {
			head += uint64(n)
		} else {
			var geometry [4]byte
			if payload, ok := at(pos+5, 4); ok {
				copy(geometry[:], payload)
			} else if _, err := f.ReadAt(geometry[:], pos+5); err != nil {
				return nil, err
			}
			cols := binary.BigEndian.Uint16(geometry[:2])
			rows := binary.BigEndian.Uint16(geometry[2:])
			if cols != 0 && rows != 0 {
				scan.resizes = append(scan.resizes, ResizeMarker{AtSeq: head, Cols: cols, Rows: rows})
				if len(scan.resizes) > importResizeCap {
					copy(scan.resizes, scan.resizes[len(scan.resizes)-importResizeCap:])
					scan.resizes = scan.resizes[:importResizeCap]
				}
			}
		}
		pos += 5 + int64(n)
	}
	scan.head = head
	scan.committed = pos
	return scan, nil
}

func recordHeadLen(kind byte, n uint32) uint64 {
	if kind == 1 {
		return uint64(n)
	}
	return 0
}

var errAnchorUnusable = fmt.Errorf("legacy anchor unusable")

// streamLegacyTail replays [skipTo, head): parser only until tailStart,
// then parser plus tail collection. The checkpoint is the parser state
// exactly at tailStart; headReady is the state at the committed head.
func streamLegacyTail(f *os.File, committed int64, startOff int64, recStart, skipTo, tailStart, head uint64, anchor []byte) ([]byte, []byte, []byte, uint64, error) {
	parser, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		return nil, nil, nil, 0, err
	}
	defer parser.Close()
	if anchor != nil {
		if err := parser.Restore(anchor); err != nil {
			return nil, nil, nil, 0, errAnchorUnusable
		}
	}
	var tail []byte
	var ckpt []byte
	var parsed uint64
	feed := func(data []byte) error {
		if len(data) == 0 {
			return nil
		}
		if err := parser.Feed(data); err != nil {
			return err
		}
		parsed += uint64(len(data))
		return nil
	}
	takePayload := func(off int64, length uint32, seq uint64) error {
		end := seq + uint64(length)
		if end <= skipTo || seq >= head {
			return nil
		}
		lo, hi := seq, end
		if lo < skipTo {
			lo = skipTo
		}
		for lo < hi {
			if lo == tailStart && ckpt == nil {
				snapshot, err := parser.Ready()
				if err != nil {
					return err
				}
				ckpt = snapshot
			}
			chunkEnd := hi
			if lo < tailStart && chunkEnd > tailStart {
				chunkEnd = tailStart
			}
			// One pathological record must not allocate the tail.
			if chunkEnd-lo > 64<<10 {
				chunkEnd = lo + 64<<10
			}
			chunk := make([]byte, chunkEnd-lo)
			if _, err := f.ReadAt(chunk, off+int64(lo-seq)); err != nil {
				return err
			}
			if err := feed(chunk); err != nil {
				return err
			}
			if lo >= tailStart {
				tail = append(tail, chunk...)
			}
			lo = chunkEnd
		}
		return nil
	}
	off := startOff
	seq := recStart
	// Re-walk headers from the start offset; every header here was
	// already validated by the scan, so any surprise aborts.
	for off < committed {
		var hdr [5]byte
		if _, err := f.ReadAt(hdr[:], off); err != nil {
			return nil, nil, nil, 0, err
		}
		kind := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		if (kind != 1 && kind != 2) || (kind == 2 && n != 4) || off+5+int64(n) > committed {
			return nil, nil, nil, 0, fmt.Errorf("legacy source changed during import")
		}
		if kind == 1 {
			if err := takePayload(off+5, n, seq); err != nil {
				return nil, nil, nil, 0, err
			}
			seq += uint64(n)
		} else {
			var geometry [4]byte
			if _, err := f.ReadAt(geometry[:], off+5); err != nil {
				return nil, nil, nil, 0, err
			}
			cols := binary.BigEndian.Uint16(geometry[:2])
			rows := binary.BigEndian.Uint16(geometry[2:])
			if seq >= skipTo && cols != 0 && rows != 0 {
				if err := parser.Resize(int(cols), int(rows)); err != nil {
					return nil, nil, nil, 0, err
				}
			}
		}
		off += 5 + int64(n)
	}
	if seq != head {
		return nil, nil, nil, 0, fmt.Errorf("legacy source changed during import")
	}
	if ckpt == nil {
		snapshot, err := parser.Ready()
		if err != nil {
			return nil, nil, nil, 0, err
		}
		ckpt = snapshot
	}
	headReady, err := parser.Ready()
	if err != nil {
		return nil, nil, nil, 0, err
	}
	ckptGz := gzipBest(ckpt)
	if uint32(len(ckptGz)) > retentionCkptMax {
		ckptGz = nil
	}
	return tail, ckptGz, headReady, parsed, nil
}

func gzipBest(data []byte) []byte {
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	_, _ = w.Write(data)
	_ = w.Close()
	return buf.Bytes()
}

// importTailMarkers keeps the newest markers in the tail window with the
// geometry in force at the window start carried as its first marker, so
// an imported read matches the legacy inclusion rule exactly.
func importTailMarkers(resizes []ResizeMarker, tailStart uint64) []ResizeMarker {
	var inForce *ResizeMarker
	var rest []ResizeMarker
	for i := range resizes {
		m := resizes[i]
		if m.AtSeq < tailStart {
			inForce = &resizes[i]
		} else if m.AtSeq == tailStart {
			inForce = nil
			rest = append(rest, m)
		} else {
			rest = append(rest, m)
		}
	}
	var out []ResizeMarker
	if inForce != nil {
		out = append(out, ResizeMarker{AtSeq: tailStart, Cols: inForce.Cols, Rows: inForce.Rows})
	}
	out = append(out, rest...)
	if len(out) > retentionRszMaxCount {
		// Newest geometry wins; only middle markers are dropped.
		kept := []ResizeMarker{out[0]}
		kept = append(kept, out[len(out)-retentionRszMaxCount+1:]...)
		out = kept
	}
	return out
}

// buildImportedGroup writes a closed single-segment group: the tail
// bytes, the carried markers, and the checkpoint exactly at the tail
// start. The manifest clock preserves the original source time.
func buildImportedGroup(staging string, tailStart, head uint64, markers []ResizeMarker, ckptGz, tail []byte, sourceTime time.Time) error {
	base := filepath.Join(staging, retentionSegBase(1))
	raw, err := os.OpenFile(base+".raw", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := raw.Write(tail); err != nil {
		raw.Close()
		return err
	}
	if err := raw.Sync(); err != nil {
		raw.Close()
		return err
	}
	if err := raw.Close(); err != nil {
		return err
	}
	if len(markers) > 0 {
		rsz, err := os.OpenFile(base+".rsz", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		for _, m := range markers {
			if _, err := rsz.Write(encodeResizeRecord(m)); err != nil {
				rsz.Close()
				return err
			}
		}
		if err := rsz.Sync(); err != nil {
			rsz.Close()
			return err
		}
		if err := rsz.Close(); err != nil {
			return err
		}
	}
	if len(ckptGz) > 0 {
		ckpt, err := os.OpenFile(base+".ckpt", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		if _, err := ckpt.Write(ckptGz); err != nil {
			ckpt.Close()
			return err
		}
		if err := ckpt.Sync(); err != nil {
			ckpt.Close()
			return err
		}
		if err := ckpt.Close(); err != nil {
			return err
		}
	}
	lastByte := byte(0)
	if len(tail) > 0 {
		lastByte = tail[len(tail)-1]
	}
	m := retentionManifest{
		head: head,
		segs: []retentionSegDesc{{
			gen:          1,
			start:        tailStart,
			rawLen:       uint64(len(tail)),
			startOrdinal: 1,
			rszCount:     uint32(len(markers)),
			ckptLen:      uint32(len(ckptGz)),
		}},
		plain:        false,
		lastByte:     lastByte,
		flags:        retentionFlagClosed,
		closedAtNs:   sourceTime.UnixNano(),
		lastUpdateNs: sourceTime.UnixNano(),
	}
	manifest, err := os.OpenFile(filepath.Join(staging, "MANIFEST"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := manifest.Write(encodeRetentionManifest(m)); err != nil {
		manifest.Close()
		return err
	}
	if err := manifest.Sync(); err != nil {
		manifest.Close()
		return err
	}
	if err := manifest.Close(); err != nil {
		return err
	}
	return syncDir(staging)
}

// verifyImportedGroup reopens the staged replacement and compares the
// retained bytes and the current parser state before it takes authority.
func verifyImportedGroup(staging string, tailStart, head uint64, tail []byte, markers []ResizeMarker, headReady []byte) error {
	g, err := openRetentionGroup(staging)
	if err != nil {
		return err
	}
	defer g.close()
	data, _, err := g.read(tailStart, head)
	if err != nil {
		return err
	}
	if !bytes.Equal(data, tail) {
		return fmt.Errorf("imported bytes differ from the source tail")
	}
	if len(markers) > 0 {
		_, got, err := g.read(tailStart, head)
		if err != nil {
			return err
		}
		if len(got) != len(markers) {
			return fmt.Errorf("imported markers differ from the source tail")
		}
		for i := range markers {
			if got[i] != markers[i] {
				return fmt.Errorf("imported markers differ from the source tail")
			}
		}
	}
	if g.segs[0].ckptLen == 0 {
		return nil
	}
	base, err := g.readBase(0)
	if err != nil {
		return err
	}
	r, err := gzip.NewReader(bytes.NewReader(base))
	if err != nil {
		return err
	}
	snapshot, err := io.ReadAll(io.LimitReader(r, importAnchorMax+1))
	r.Close()
	if err != nil || len(snapshot) > importAnchorMax {
		return fmt.Errorf("imported base checkpoint unreadable")
	}
	replay, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		return err
	}
	defer replay.Close()
	if err := replay.Restore(snapshot); err != nil {
		return err
	}
	at := tailStart
	for _, m := range markers {
		if m.AtSeq > at {
			if err := replay.Feed(tail[at-tailStart : m.AtSeq-tailStart]); err != nil {
				return err
			}
			at = m.AtSeq
		}
		if err := replay.Resize(int(m.Cols), int(m.Rows)); err != nil {
			return err
		}
	}
	if err := replay.Feed(tail[at-tailStart:]); err != nil {
		return err
	}
	got, err := replay.Ready()
	if err != nil {
		return err
	}
	return compareTermStates(got, headReady)
}

func compareTermStates(a, b []byte) error {
	pa, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		return err
	}
	defer pa.Close()
	pb, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		return err
	}
	defer pb.Close()
	if err := pa.Restore(a); err != nil {
		return err
	}
	if err := pb.Restore(b); err != nil {
		return err
	}
	sa, err := pa.FormatVTState()
	if err != nil {
		return err
	}
	sb, err := pb.FormatVTState()
	if err != nil {
		return err
	}
	if !bytes.Equal(sa, sb) {
		return fmt.Errorf("imported screen differs from the source head state")
	}
	ca, err := pa.Continuation()
	if err != nil {
		return err
	}
	cb, err := pb.Continuation()
	if err != nil {
		return err
	}
	if !bytes.Equal(ca, cb) {
		return fmt.Errorf("imported continuation differs from the source head state")
	}
	acols, arows := pa.Geometry()
	bcols, brows := pb.Geometry()
	if acols != bcols || arows != brows {
		return fmt.Errorf("imported geometry differs from the source head state")
	}
	return nil
}
