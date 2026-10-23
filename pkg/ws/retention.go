package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hypernewbie/phi/internal/termstate"
)

// Bounded terminal retention.
//
// A retention group keeps the newest 1 MiB of raw output history per
// terminal in two rotating journal segments. Each segment holds separate
// raw bytes, fixed-size resize records, and one immutable base checkpoint:
// the exact parser at that segment's source start with zero historical
// scrollback. Older bytes are evicted permanently once a rotation commits.
//
// Source positions stay absolute and monotonic. Head is one past the
// newest committed byte; floor is the oldest readable byte and moves as
// history wraps. A physical prefix before the floor exists only for exact
// parser reconstruction and is never exposed through history reads.
//
// The group has no internal mutex. Every method must run under the owning
// PaneHub's mutex, exactly like the legacy journal it replaces.

// Approved retention bounds. Upper bounds, not reservations.
const (
	retentionHistoryCap  = 1 << 20
	retentionSegNominal  = 1 << 20
	retentionSegSlack    = 32 << 10
	retentionSegRawMax   = retentionSegNominal + retentionSegSlack
	retentionCkptMax     = 2 << 20
	retentionRszRecLen   = 12
	retentionRszMaxCount = 4096
	retentionRszMaxBytes = 64 << 10
	retentionManifestMax = 64 << 10
	retentionSegsKept    = 2
)

var errPendingTransaction = errors.New("unresolved retention transaction")

var retentionManifestMagic = []byte("PHIRV2")

const retentionManifestVersion = 1

const retentionFlagClosed = 1 << 0

type retentionSegDesc struct {
	gen          uint64
	start        uint64
	rawLen       uint64
	startOrdinal uint64
	rszCount     uint32
	ckptLen      uint32
}

type retentionManifest struct {
	head         uint64
	segs         []retentionSegDesc
	plain        bool
	lastByte     byte
	flags        uint32
	closedAtNs   int64
	lastUpdateNs int64
}

func encodeRetentionManifest(m retentionManifest) []byte {
	var buf bytes.Buffer
	buf.Write(retentionManifestMagic)
	var tmp [8]byte
	binary.LittleEndian.PutUint16(tmp[:2], retentionManifestVersion)
	buf.Write(tmp[:2])
	binary.LittleEndian.PutUint64(tmp[:], m.head)
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint32(tmp[:4], uint32(len(m.segs)))
	buf.Write(tmp[:4])
	for _, s := range m.segs {
		binary.LittleEndian.PutUint64(tmp[:], s.gen)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.start)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.rawLen)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint64(tmp[:], s.startOrdinal)
		buf.Write(tmp[:])
		binary.LittleEndian.PutUint32(tmp[:4], s.rszCount)
		buf.Write(tmp[:4])
		binary.LittleEndian.PutUint32(tmp[:4], s.ckptLen)
		buf.Write(tmp[:4])
	}
	if m.plain {
		buf.WriteByte(1)
	} else {
		buf.WriteByte(0)
	}
	buf.WriteByte(m.lastByte)
	binary.LittleEndian.PutUint32(tmp[:4], m.flags)
	buf.Write(tmp[:4])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.closedAtNs))
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.lastUpdateNs))
	buf.Write(tmp[:])
	out := buf.Bytes()
	var crc [4]byte
	binary.LittleEndian.PutUint32(crc[:], crc32.ChecksumIEEE(out))
	return append(out, crc[:]...)
}

// readRetentionManifest reads a manifest through a bounded regular-file
// reader so a corrupt oversized entry cannot exhaust server memory
// before the size check runs. Non-regular entries (symlinks, fifos,
// directories) reject without blocking on or following them.
func readRetentionManifest(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("retention manifest is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if ofi, err := f.Stat(); err != nil || !ofi.Mode().IsRegular() {
		return nil, fmt.Errorf("retention manifest is not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(retentionManifestMax)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > retentionManifestMax {
		return nil, fmt.Errorf("retention manifest exceeds size bound")
	}
	return data, nil
}

func decodeRetentionManifest(data []byte) (retentionManifest, error) {
	var m retentionManifest
	if len(data) > retentionManifestMax {
		return m, fmt.Errorf("retention manifest exceeds size bound")
	}
	if len(data) < 50 || !bytes.Equal(data[:6], retentionManifestMagic) {
		return m, fmt.Errorf("invalid retention manifest")
	}
	body, crc := data[:len(data)-4], data[len(data)-4:]
	if crc32.ChecksumIEEE(body) != binary.LittleEndian.Uint32(crc) {
		return m, fmt.Errorf("retention manifest checksum mismatch")
	}
	if binary.LittleEndian.Uint16(body[6:8]) != retentionManifestVersion {
		return m, fmt.Errorf("unsupported retention manifest version")
	}
	m.head = binary.LittleEndian.Uint64(body[8:16])
	count := int(binary.LittleEndian.Uint32(body[16:20]))
	if count < 1 || count > retentionSegsKept {
		return m, fmt.Errorf("invalid retention segment count %d", count)
	}
	if len(body) != 42+40*count {
		return m, fmt.Errorf("retention manifest length mismatch")
	}
	at := 20
	for range count {
		var s retentionSegDesc
		s.gen = binary.LittleEndian.Uint64(body[at:])
		s.start = binary.LittleEndian.Uint64(body[at+8:])
		s.rawLen = binary.LittleEndian.Uint64(body[at+16:])
		s.startOrdinal = binary.LittleEndian.Uint64(body[at+24:])
		s.rszCount = binary.LittleEndian.Uint32(body[at+32:])
		s.ckptLen = binary.LittleEndian.Uint32(body[at+36:])
		at += 40
		if s.gen == 0 || s.start > m.head || s.rawLen > retentionSegRawMax ||
			s.startOrdinal == 0 || s.rszCount > retentionRszMaxCount || s.ckptLen > retentionCkptMax {
			return m, fmt.Errorf("retention manifest segment out of bounds")
		}
		if n := len(m.segs); n > 0 {
			prev := m.segs[n-1]
			if s.gen <= prev.gen || s.start < prev.start ||
				s.startOrdinal != prev.startOrdinal+uint64(prev.rszCount) {
				return m, fmt.Errorf("retention manifest segments out of order")
			}
		}
		m.segs = append(m.segs, s)
	}
	last := m.segs[len(m.segs)-1]
	if last.start+last.rawLen != m.head {
		return m, fmt.Errorf("retention manifest head mismatch")
	}
	switch body[at] {
	case 0:
		m.plain = false
	case 1:
		m.plain = true
	default:
		return m, fmt.Errorf("invalid retention plain flag")
	}
	m.lastByte = body[at+1]
	m.flags = binary.LittleEndian.Uint32(body[at+2:])
	m.closedAtNs = int64(binary.LittleEndian.Uint64(body[at+6:]))
	m.lastUpdateNs = int64(binary.LittleEndian.Uint64(body[at+14:]))
	return m, nil
}

type retentionSeg struct {
	retentionSegDesc
	raw     *os.File
	rsz     *os.File
	resizes []ResizeMarker
}

// retentionFaults injects one-shot failures at each commit boundary for
// tests. Each set fault fires once, then clears itself.
type retentionFaults struct {
	rawSync      error
	rszSync      error
	ckptSync     error
	manifestSync error
	rename       error
	dirSync      error
}

type stagedKind byte

const (
	stagedPayload stagedKind = iota + 1
	stagedResize
)

type stagedCommit struct {
	kind    stagedKind
	newHead uint64
	// admitLen/admitDigest identify the complete admission for retry
	// validation. A giant payload retains only its suffix on disk, but
	// an identical retry re-presents the whole payload.
	admitLen      int
	admitDigest   [32]byte
	rotate        bool
	evict         []uint64
	newSeg        retentionSegDesc
	newRaw        *os.File
	newRsz        *os.File
	curRawAppend  uint64
	marker        ResizeMarker
	plainAfter    bool
	lastByteAfter byte
}

// retentionPending retains a transaction whose manifest rename is visible
// but whose directory sync never confirmed durability. Payload bytes are
// not retained: an identical retry re-presents them, and anything else
// must fail instead of receiving that acknowledgement.
type retentionPending struct {
	staged        *stagedCommit
	oldHead       uint64
	payloadLen    int
	payloadDigest [32]byte
}

type retentionGroup struct {
	dir          string
	ephemeral    bool
	closed       bool
	head         uint64
	start        uint64
	plain        bool
	lastByte     byte
	flags        uint32
	closedAtNs   int64
	lastUpdateNs int64
	segs         []retentionSeg
	nextGen      uint64
	nextOrdinal  uint64
	// maxEvictedMarkerSeq is the highest source position of any resize
	// marker rotation evicted. Evicted markers usually precede the byte
	// floor, but metadata-only rotation can evict markers at the head.
	maxEvictedMarkerSeq uint64
	ckptMax             uint32
	faults              retentionFaults
	pending             *retentionPending
	now                 func() time.Time
}

// baseSnapshotFunc returns a gzipped zero-scrollback snapshot of the live
// parser, or (nil, nil) when no exact base is available. The group must
// never fail a commit because the snapshot does.
type baseSnapshotFunc func() ([]byte, error)

func retentionSegBase(gen uint64) string {
	return fmt.Sprintf("s%016x", gen)
}

// rejectNonRegular refuses to mutate through a namespace entry that is
// missing-OK but must never be a symlink, directory, fifo, or device.
// Same-uid TOCTOU between this check and use is out of scope: a local
// writer racing the server can write the files directly.
func rejectNonRegular(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("retention entry is not a regular file: %s", path)
	}
	return nil
}

func parseRetentionSegFile(name string) (uint64, bool) {
	var suffix string
	switch {
	case strings.HasSuffix(name, ".raw"):
		suffix = ".raw"
	case strings.HasSuffix(name, ".rsz"):
		suffix = ".rsz"
	case strings.HasSuffix(name, ".ckpt"):
		suffix = ".ckpt"
	default:
		return 0, false
	}
	// "s" + 16 hex + suffix; validate the full shape before slicing
	// so short names like ".raw" reject instead of panicking.
	if len(name) != 1+16+len(suffix) || name[0] != 's' {
		return 0, false
	}
	hexPart := name[1 : 1+16]
	gen, err := strconv.ParseUint(hexPart, 16, 64)
	if err != nil || gen == 0 {
		return 0, false
	}
	return gen, true
}

func retentionGroupHasSegments(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if _, ok := parseRetentionSegFile(entry.Name()); ok {
			return true, nil
		}
	}
	return false, nil
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := d.Sync()
	closeErr := d.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

// openRetentionGroup opens or creates the bounded group at dir. An empty
// dir requests bounded private ephemeral storage in a temporary directory.
// Recovery accepts only a complete valid manifest with all required
// dependencies; anything else fails closed without deleting evidence.
func openRetentionGroup(dir string) (*retentionGroup, error) {
	ephemeral := dir == ""
	if ephemeral {
		tmp, err := os.MkdirTemp("", "phi-retention-*")
		if err != nil {
			return nil, err
		}
		dir = tmp
	} else if fi, err := os.Lstat(dir); err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		if err := syncDir(filepath.Dir(dir)); err != nil {
			return nil, err
		}
	} else if !fi.Mode().IsDir() {
		return nil, fmt.Errorf("retention group path is not a directory: %s", dir)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	g := &retentionGroup{dir: dir, ephemeral: ephemeral, ckptMax: retentionCkptMax, plain: true, now: time.Now}
	// A temp manifest is never referenced; a crashed commit may leave one.
	_ = os.Remove(filepath.Join(dir, "MANIFEST.tmp"))
	raw, err := readRetentionManifest(filepath.Join(dir, "MANIFEST"))
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		staged, err := retentionGroupHasSegments(dir)
		if err != nil {
			return nil, err
		}
		if staged {
			return nil, fmt.Errorf("retention group has segments without a manifest")
		}
		// Resize ordinals are 1-based from the group's introduction so
		// ordinal 0 in an event cursor means "no resize applied yet".
		g.segs = []retentionSeg{{retentionSegDesc: retentionSegDesc{gen: 1, startOrdinal: 1}}}
		g.nextGen = 2
		g.nextOrdinal = 1
		return g, nil
	}
	m, err := decodeRetentionManifest(raw)
	if err != nil {
		return nil, err
	}
	g.head = m.head
	g.plain = m.plain
	g.lastByte = m.lastByte
	g.flags = m.flags
	g.closedAtNs = m.closedAtNs
	g.lastUpdateNs = m.lastUpdateNs
	for _, d := range m.segs {
		s, err := g.openSegment(d)
		if err != nil {
			g.close()
			return nil, err
		}
		g.segs = append(g.segs, s)
	}
	g.start = g.segs[0].start
	for i := range g.segs {
		g.nextGen = max(g.nextGen, g.segs[i].gen+1)
	}
	last := g.segs[len(g.segs)-1]
	g.nextOrdinal = last.startOrdinal + uint64(last.rszCount)
	evictedMarkers := g.segs[0].startOrdinal > 1
	if !evictedMarkers {
		retained := false
		for i := range g.segs {
			if len(g.segs[i].resizes) > 0 {
				retained = true
				break
			}
		}
		evictedMarkers = !retained && g.nextOrdinal > 1
	}
	if evictedMarkers {
		// Pre-open evictions left no positions behind: assume an evicted
		// marker may sit anywhere through the head, so only
		// ordinal-current cursors stay valid without re-anchoring.
		g.maxEvictedMarkerSeq = g.head
	}
	g.sweepUnreferenced()
	return g, nil
}

// openCommitFile opens an append-only committed file. Committed bytes must
// exist; a longer file holds only an owned uncommitted tail from a crashed
// attempt and is truncated back. Anything else fails closed.
func openCommitFile(path string, committedLen int64) (*os.File, error) {
	if err := rejectNonRegular(path); err != nil {
		return nil, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) || committedLen > 0 {
			return nil, err
		}
		return os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	// The descriptor pins the inode: verify it is the file checked above.
	if ofi, err := f.Stat(); err != nil || !os.SameFile(fi, ofi) {
		f.Close()
		return nil, fmt.Errorf("retention file changed during open: %s", path)
	}
	switch {
	case fi.Size() < committedLen:
		f.Close()
		return nil, fmt.Errorf("committed retention bytes are missing: %s", path)
	case fi.Size() > committedLen:
		if err := f.Truncate(committedLen); err != nil {
			f.Close()
			return nil, err
		}
	}
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func loadResizeCache(f *os.File, count uint32, segStart, head uint64) ([]ResizeMarker, error) {
	if count == 0 {
		return nil, nil
	}
	if count > retentionRszMaxCount {
		return nil, fmt.Errorf("retention resize count out of bounds")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, int64(count)*retentionRszRecLen)
	if _, err := io.ReadFull(f, buf); err != nil {
		return nil, err
	}
	out := make([]ResizeMarker, 0, count)
	for i := uint32(0); i < count; i++ {
		rec := buf[int64(i)*retentionRszRecLen:]
		m := ResizeMarker{
			AtSeq: binary.BigEndian.Uint64(rec),
			Cols:  binary.BigEndian.Uint16(rec[8:]),
			Rows:  binary.BigEndian.Uint16(rec[10:]),
		}
		if m.Cols == 0 || m.Rows == 0 || m.AtSeq < segStart || m.AtSeq > head {
			return nil, fmt.Errorf("retention resize record out of bounds")
		}
		if i > 0 && m.AtSeq < out[i-1].AtSeq {
			return nil, fmt.Errorf("retention resize records out of order")
		}
		out = append(out, m)
	}
	return out, nil
}

func (g *retentionGroup) openSegment(d retentionSegDesc) (retentionSeg, error) {
	var s retentionSeg
	s.retentionSegDesc = d
	base := filepath.Join(g.dir, retentionSegBase(d.gen))
	raw, err := openCommitFile(base+".raw", int64(d.rawLen))
	if err != nil {
		return s, err
	}
	s.raw = raw
	rsz, err := openCommitFile(base+".rsz", int64(d.rszCount)*retentionRszRecLen)
	if err != nil {
		raw.Close()
		return s, err
	}
	s.rsz = rsz
	ckptPath := base + ".ckpt"
	if d.ckptLen > 0 {
		// Base checkpoints are immutable once committed: any size
		// mismatch is corruption, never a truncatable tail. The
		// descriptor pins the inode for the permission remediation.
		fi, err := os.Lstat(ckptPath)
		if err != nil {
			raw.Close()
			rsz.Close()
			return s, err
		}
		if !fi.Mode().IsRegular() || fi.Size() != int64(d.ckptLen) {
			raw.Close()
			rsz.Close()
			return s, fmt.Errorf("retention base checkpoint size mismatch")
		}
		cf, err := os.Open(ckptPath)
		if err != nil {
			raw.Close()
			rsz.Close()
			return s, err
		}
		if ofi, err := cf.Stat(); err != nil || !os.SameFile(fi, ofi) {
			cf.Close()
			raw.Close()
			rsz.Close()
			return s, fmt.Errorf("retention checkpoint changed during open")
		}
		err = cf.Chmod(0600)
		cf.Close()
		if err != nil {
			raw.Close()
			rsz.Close()
			return s, err
		}
	} else if _, err := os.Lstat(ckptPath); err == nil {
		raw.Close()
		rsz.Close()
		return s, fmt.Errorf("retention checkpoint contradicts unavailable base")
	} else if !os.IsNotExist(err) {
		raw.Close()
		rsz.Close()
		return s, err
	}
	cache, err := loadResizeCache(rsz, d.rszCount, d.start, g.head)
	if err != nil {
		raw.Close()
		rsz.Close()
		return s, err
	}
	s.resizes = cache
	return s, nil
}

// sweepUnreferenced deletes only our own segment files that the committed
// manifest no longer references: staged files from a crashed commit and
// evicted generations from an interrupted rotation. Unknown files, the
// manifest, and committed dependencies are never touched.
func (g *retentionGroup) sweepUnreferenced() {
	live := make(map[uint64]bool, len(g.segs))
	for i := range g.segs {
		live[g.segs[i].gen] = true
	}
	entries, err := os.ReadDir(g.dir)
	if err != nil {
		componentLogger().Warn("retention sweep cannot list group", "dir", g.dir, "err", err)
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		gen, ok := parseRetentionSegFile(entry.Name())
		if !ok || live[gen] {
			continue
		}
		path := filepath.Join(g.dir, entry.Name())
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			componentLogger().Warn("retention sweep left an unreferenced file", "path", path, "err", err)
		}
	}
}

func (g *retentionGroup) isClosed() bool {
	return g.closed
}

// markClosed records a closure event in the manifest. A failed persist
// leaves the previous manifest, whose last-update time clocks the group
// as an orphan; closure and commit are seconds apart, so the fallback
// expiry is negligibly early.
func (g *retentionGroup) markClosed(ns int64) error {
	g.flags |= retentionFlagClosed
	g.closedAtNs = ns
	return g.persistMetadata()
}

// markOpen clears a stale closure when a pane goes live again.
func (g *retentionGroup) markOpen() error {
	if g.flags&retentionFlagClosed == 0 && g.closedAtNs == 0 {
		return nil
	}
	g.flags &^= retentionFlagClosed
	g.closedAtNs = 0
	return g.persistMetadata()
}

// persistMetadata rewrites the manifest with the current open/closed
// state. Unlike commit it carries no payload, so there is no pending
// transaction to resolve on a directory-sync failure.
func (g *retentionGroup) persistMetadata() error {
	if g.dir == "" || g.closed {
		return nil
	}
	descs := make([]retentionSegDesc, len(g.segs))
	for i := range g.segs {
		descs[i] = g.segs[i].retentionSegDesc
	}
	m := retentionManifest{
		head:         g.head,
		segs:         descs,
		plain:        g.plain,
		lastByte:     g.lastByte,
		flags:        g.flags,
		closedAtNs:   g.closedAtNs,
		lastUpdateNs: g.lastUpdateNs,
	}
	tmp := filepath.Join(g.dir, "MANIFEST.tmp")
	if err := rejectNonRegular(tmp); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(encodeRetentionManifest(m)); err != nil {
		f.Close()
		return err
	}
	if err := g.syncFileAs(f, &g.faults.manifestSync); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := g.renameAs(tmp, filepath.Join(g.dir, "MANIFEST")); err != nil {
		return err
	}
	return g.syncDirAs(g.dir)
}

func (g *retentionGroup) close() error {
	if g.closed {
		return nil
	}
	g.closed = true
	var errs []error
	for i := range g.segs {
		if g.segs[i].raw != nil {
			errs = append(errs, g.segs[i].raw.Close())
			g.segs[i].raw = nil
		}
		if g.segs[i].rsz != nil {
			errs = append(errs, g.segs[i].rsz.Close())
			g.segs[i].rsz = nil
		}
	}
	if g.pending != nil {
		if g.pending.staged.newRaw != nil {
			errs = append(errs, g.pending.staged.newRaw.Close())
			g.pending.staged.newRaw = nil
		}
		if g.pending.staged.newRsz != nil {
			errs = append(errs, g.pending.staged.newRsz.Close())
			g.pending.staged.newRsz = nil
		}
		g.pending = nil
	}
	if g.ephemeral {
		errs = append(errs, os.RemoveAll(g.dir))
	}
	return errors.Join(errs...)
}

// floor is the oldest readable source sequence: the public 1 MiB window,
// or the oldest physically retained byte when resize pressure shortened
// history before the raw cap.
func (g *retentionGroup) floor() uint64 {
	if g.head > retentionHistoryCap && g.head-retentionHistoryCap > g.start {
		return g.head - retentionHistoryCap
	}
	return g.start
}

func (g *retentionGroup) lastResize() (ResizeMarker, bool) {
	for i := len(g.segs) - 1; i >= 0; i-- {
		if n := len(g.segs[i].resizes); n > 0 {
			return g.segs[i].resizes[n-1], true
		}
	}
	return ResizeMarker{}, false
}

// ordResize pairs a retained marker with its 1-based group ordinal.
// Ordinals increase with append order; eviction drops ordinal prefixes.
type ordResize struct {
	ResizeMarker
	ordinal uint64
}

// read returns raw bytes for [from, end) plus the geometry in force at
// from and the markers inside that span: the same inclusion rule as the
// legacy journal reader. Internal reconstruction may read the private
// prefix below the public floor; history reads must clamp first.
func (g *retentionGroup) read(from, end uint64) ([]byte, []ResizeMarker, error) {
	data, ords, endOrdinal, err := g.readOrd(from, end, 0, false)
	if err != nil {
		return nil, nil, err
	}
	_ = endOrdinal
	markers := make([]ResizeMarker, len(ords))
	for i, o := range ords {
		markers[i] = o.ResizeMarker
	}
	return data, markers, nil
}

// readOrd is read with ordinal tracking. Without a cursor it keeps the
// legacy inclusion rule (geometry in force plus span markers) and reports
// the last ordinal at or before end, or 0 when none exists. With a cursor
// it keeps only markers after that ordinal at or after from, so a page
// following a checkpoint applies same-position resizes exactly once; the
// end ordinal never moves backward past afterOrdinal. A cursor with
// ordinal 0 still filters (it excludes the checkpoint-covered in-force
// marker), so cursor use is explicit rather than inferred from zero.
func (g *retentionGroup) readOrd(from, end uint64, afterOrdinal uint64, useCursor bool) ([]byte, []ordResize, uint64, error) {
	if g.closed {
		return nil, nil, 0, fmt.Errorf("retention group closed")
	}
	if end < from || end > g.head || from < g.start {
		return nil, nil, 0, fmt.Errorf("invalid retention range")
	}
	data := make([]byte, end-from)
	for i := range g.segs {
		s := &g.segs[i]
		segEnd := s.start + s.rawLen
		lo, hi := max(from, s.start), min(end, segEnd)
		if hi <= lo {
			continue
		}
		if _, err := s.raw.ReadAt(data[lo-from:hi-from], int64(lo-s.start)); err != nil {
			return nil, nil, 0, err
		}
	}
	var all []ordResize
	for i := range g.segs {
		s := &g.segs[i]
		for j, m := range s.resizes {
			all = append(all, ordResize{ResizeMarker: m, ordinal: s.startOrdinal + uint64(j)})
		}
	}
	at := sort.Search(len(all), func(i int) bool { return all[i].AtSeq >= from })
	var markers []ordResize
	if !useCursor {
		if at > 0 {
			markers = append(markers, all[at-1])
		}
		for ; at < len(all) && all[at].AtSeq <= end; at++ {
			markers = append(markers, all[at])
		}
	} else {
		for ; at < len(all) && all[at].AtSeq <= end; at++ {
			if all[at].ordinal > afterOrdinal {
				markers = append(markers, all[at])
			}
		}
	}
	endOrdinal := afterOrdinal
	if n := len(all); n > 0 {
		last := sort.Search(n, func(i int) bool { return all[i].AtSeq > end })
		if last > 0 && all[last-1].ordinal > endOrdinal {
			endOrdinal = all[last-1].ordinal
		}
	}
	return data, markers, endOrdinal, nil
}

// eventCursorVersion prefixes every encoded event cursor.
const eventCursorVersion = "v1"

// maxEventCursorLen bounds request cursors before parsing.
const maxEventCursorLen = 128

// cursorExpired reports whether a cursor's boundary left the retained
// window. Positions below the floor lost unseen bytes and markers; an
// ordinal-behind cursor additionally expires when evicted markers reach
// its position, because metadata-only rotation can evict markers at
// the head without moving the byte floor.
func (g *retentionGroup) cursorExpired(floor, pos, afterOrdinal uint64) bool {
	if pos < floor {
		return true
	}
	minRetained := g.nextOrdinal
	for i := range g.segs {
		if len(g.segs[i].resizes) > 0 {
			minRetained = g.segs[i].startOrdinal
			break
		}
	}
	return afterOrdinal < minRetained-1 && g.maxEvictedMarkerSeq >= pos
}

// EncodeEventCursor renders the (epoch, source position, last applied
// resize ordinal) boundary a checkpoint consumed. The position is
// informational; ordinals drive marker filtering.
func EncodeEventCursor(epoch, pos, ordinal uint64) string {
	return eventCursorVersion + "." + strconv.FormatUint(epoch, 10) + "." + strconv.FormatUint(pos, 10) + "." + strconv.FormatUint(ordinal, 10)
}

// ParseEventCursor validates an encoded cursor. Anything malformed is a
// bad request, never an expired boundary.
func ParseEventCursor(s string) (epoch, pos, ordinal uint64, err error) {
	if len(s) == 0 || len(s) > maxEventCursorLen {
		return 0, 0, 0, fmt.Errorf("invalid event cursor")
	}
	parts := strings.Split(s, ".")
	if len(parts) != 4 || parts[0] != eventCursorVersion {
		return 0, 0, 0, fmt.Errorf("invalid event cursor")
	}
	vals := make([]uint64, 3)
	for i, p := range parts[1:] {
		v, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("invalid event cursor")
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2], nil
}

// baseCandidates returns segment indexes with start at or below through,
// newest first, for base selection with older retained fallback.
func (g *retentionGroup) baseCandidates(through uint64) []int {
	var out []int
	for i := len(g.segs) - 1; i >= 0; i-- {
		if g.segs[i].start <= through {
			out = append(out, i)
		}
	}
	return out
}

// readBase returns the gzipped base checkpoint for a segment, or (nil, nil)
// when that segment committed without a usable base. A missing or short
// committed checkpoint is corruption and fails explicitly.
func (g *retentionGroup) readBase(idx int) ([]byte, error) {
	if g.closed {
		return nil, fmt.Errorf("retention group closed")
	}
	d := g.segs[idx].retentionSegDesc
	if d.ckptLen == 0 {
		return nil, nil
	}
	path := filepath.Join(g.dir, retentionSegBase(d.gen)+".ckpt")
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() != int64(d.ckptLen) {
		return nil, fmt.Errorf("retention base checkpoint size mismatch")
	}
	return os.ReadFile(path)
}

// replayStart certifies a raw replay boundary only for plain CRLF history
// with enough complete lines in the retained window, exactly like the
// legacy reader. Unlike that reader it scans the retained window rather
// than requiring a multi-megabyte prefix to exist.
func (g *retentionGroup) replayStart() uint64 {
	const tailBytes = 2*1024*1024 - 128*1024
	const minimumLines = 10000 + 4096
	if g.closed || !g.plain || g.head <= g.start {
		return 0
	}
	from := g.start
	if g.head-from > tailBytes {
		from = g.head - tailBytes
	}
	data, resizes, err := g.read(from, g.head)
	if err != nil || bytes.Count(data, []byte("\r\n")) < minimumLines {
		return 0
	}
	for _, resize := range resizes {
		if resize.Rows > 4096 {
			return 0
		}
	}
	reset := bytes.Index(data, []byte("\r\n"))
	return from + uint64(reset) + 2
}

// foldPlain applies the legacy plain-text rule to data, starting from the
// committed flag and last byte. Only fully plain committed history keeps
// the raw-tail certificate.
func foldPlain(plain bool, lastByte byte, data []byte) (bool, byte) {
	if !plain {
		return false, lastByte
	}
	for _, b := range data {
		if (b < 32 && b != '\r' && b != '\n') || b > 126 || (b == '\n' && lastByte != '\r') {
			return false, lastByte
		}
		lastByte = b
	}
	return true, lastByte
}

func gzipBase(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodeResizeRecord(m ResizeMarker) []byte {
	var rec [retentionRszRecLen]byte
	binary.BigEndian.PutUint64(rec[0:8], m.AtSeq)
	binary.BigEndian.PutUint16(rec[8:10], m.Cols)
	binary.BigEndian.PutUint16(rec[10:12], m.Rows)
	return rec[:]
}

func writeFullAt(f *os.File, off int64, data []byte) error {
	for len(data) > 0 {
		n, err := f.WriteAt(data, off)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		off += int64(n)
		data = data[n:]
	}
	return nil
}

func writeFileSynced(path string, data []byte, fault *error, g *retentionGroup) error {
	if err := rejectNonRegular(path); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return g.syncFileAs(f, fault)
}

func (g *retentionGroup) syncFileAs(f *os.File, fault *error) error {
	if *fault != nil {
		err := *fault
		*fault = nil
		return err
	}
	// Ephemeral groups have no crash-recovery path, so durability syncs
	// are meaningless for them; the commit order stays identical.
	if g.ephemeral {
		return nil
	}
	return f.Sync()
}

func (g *retentionGroup) renameAs(oldPath, newPath string) error {
	if g.faults.rename != nil {
		err := g.faults.rename
		g.faults.rename = nil
		return err
	}
	return os.Rename(oldPath, newPath)
}

func (g *retentionGroup) syncDirAs(path string) error {
	if g.faults.dirSync != nil {
		err := g.faults.dirSync
		g.faults.dirSync = nil
		return err
	}
	if g.ephemeral {
		return nil
	}
	return syncDir(path)
}

// syncDirPlain syncs a directory for durability outside any fault stage.
// It still propagates real errors for persistent groups.
func (g *retentionGroup) syncDirPlain(path string) error {
	if g.ephemeral {
		return nil
	}
	return syncDir(path)
}

// snapshotBase resolves the base checkpoint for a rotated-to segment. Any
// snapshot failure, or a checkpoint over the storage cap, yields an
// unavailable base instead of failing the commit: live output continues
// and restoration that needs the missing base fails explicitly.
func (g *retentionGroup) snapshotBase(snap baseSnapshotFunc) []byte {
	if snap == nil {
		return nil
	}
	gz, err := snap()
	if err != nil || len(gz) == 0 || uint32(len(gz)) > g.ckptMax {
		return nil
	}
	return gz
}

// appendPayload commits one whole output batch and returns the resize
// markers completed by this call that the hub must feed to the live
// parser before the payload. Partial admission never happens: the PTY
// loop retries the complete payload, so anything but exactly-once bytes
// would duplicate output.
// resolvePendingPayload completes a durability-failed payload commit
// using the re-presented bytes. It reports false when no payload is
// pending — including a pending resize, which appendPayload drains —
// so a caller retrying a queued resize can unblock the payload first.
func (g *retentionGroup) resolvePendingPayload(payload []byte) (bool, error) {
	if g.closed {
		return false, fmt.Errorf("retention group closed")
	}
	if g.pending == nil || g.pending.staged.kind != stagedPayload {
		return false, nil
	}
	if err := g.syncDirAs(g.dir); err != nil {
		return false, err
	}
	p := g.pending
	if g.head != p.oldHead || len(payload) != p.payloadLen || sha256.Sum256(payload) != p.payloadDigest {
		return false, errPendingTransaction
	}
	// Identical retry: the bytes were written once by the first attempt
	// and the manifest already references them. Adopt the retained
	// transaction; the hub publishes the re-presented bytes once from
	// its own copy.
	g.publish(p.staged)
	g.pending = nil
	return true, nil
}

func (g *retentionGroup) appendPayload(payload []byte, snap baseSnapshotFunc) ([]ResizeMarker, error) {
	if g.closed {
		return nil, fmt.Errorf("retention group closed")
	}
	var applied []ResizeMarker
	if g.pending != nil {
		if resolved, err := g.resolvePendingPayload(payload); err != nil {
			return nil, err
		} else if resolved {
			return nil, nil
		}
		// Only a staged resize can remain: drain it, then stage the payload.
		if err := g.syncDirAs(g.dir); err != nil {
			return nil, err
		}
		p := g.pending
		applied = append(applied, p.staged.marker)
		g.publish(p.staged)
		g.pending = nil
	}
	if uint64(len(payload)) > retentionSegRawMax {
		st, in, err := g.stageGiantPayload(payload, snap)
		if err != nil {
			return nil, err
		}
		if err := g.commit(st, in); err != nil {
			return nil, err
		}
		return applied, nil
	}
	cur := &g.segs[len(g.segs)-1]
	// Rotate before the append would breach the physical cap: reopening
	// rejects segments over retentionSegRawMax, so admission must never
	// create one. The payload fits the fresh segment because anything
	// over the cap takes the giant path above.
	rotate := cur.rawLen >= retentionSegNominal || cur.rawLen+uint64(len(payload)) > retentionSegRawMax || cur.rszCount >= retentionRszMaxCount
	var ckpt []byte
	if rotate {
		ckpt = g.snapshotBase(snap)
	}
	st := &stagedCommit{kind: stagedPayload, newHead: g.head + uint64(len(payload)), admitLen: len(payload), admitDigest: sha256.Sum256(payload), rotate: rotate}
	// The plain certificate covers every admitted byte, including a prefix
	// that this commit evicts: replay safety depends on the bytes the
	// parser saw, not only the bytes retained.
	st.plainAfter, st.lastByteAfter = foldPlain(g.plain, g.lastByte, payload)
	if rotate {
		st.newSeg = retentionSegDesc{gen: g.nextGen, start: g.head, startOrdinal: g.nextOrdinal}
		if len(g.segs) == retentionSegsKept {
			st.evict = []uint64{g.segs[0].gen}
		}
	}
	if err := g.commit(st, commitInput{raw: payload, ckpt: ckpt}); err != nil {
		return nil, err
	}
	return applied, nil
}

// stageGiantPayload stages one bounded replacement segment for a payload
// larger than a physical segment. The retained suffix comes entirely from
// the new payload; its exact parser is built by feeding the dropped
// prefix through a scratch clone of the live snapshot in bounded chunks,
// without another payload-sized copy. The live parser stays untouched
// until the hub publishes after a successful commit.
func (g *retentionGroup) stageGiantPayload(payload []byte, snap baseSnapshotFunc) (*stagedCommit, commitInput, error) {
	newHead := g.head + uint64(len(payload))
	base := newHead - retentionSegRawMax
	dropped := payload[:len(payload)-retentionSegRawMax]
	var ckpt []byte
	if snap != nil {
		if live, err := snap(); err == nil && len(live) > 0 {
			ckpt = g.buildGiantBase(live, dropped)
		}
	}
	st := &stagedCommit{
		kind:        stagedPayload,
		newHead:     newHead,
		admitLen:    len(payload),
		admitDigest: sha256.Sum256(payload),
		rotate:      true,
		newSeg: retentionSegDesc{
			gen:          g.nextGen,
			start:        base,
			rawLen:       retentionSegRawMax,
			startOrdinal: g.nextOrdinal,
		},
	}
	st.plainAfter, st.lastByteAfter = foldPlain(g.plain, g.lastByte, payload)

	for i := range g.segs {
		st.evict = append(st.evict, g.segs[i].gen)
	}
	return st, commitInput{raw: payload[len(payload)-retentionSegRawMax:], ckpt: ckpt}, nil
}

func (g *retentionGroup) buildGiantBase(liveGz, dropped []byte) []byte {
	snap, err := restoreAnchor(liveGz)
	if err != nil {
		return nil
	}
	scratch, err := termstate.New(context.Background(), 80, 24)
	if err != nil {
		return nil
	}
	defer scratch.Close()
	if err := scratch.Restore(snap); err != nil {
		return nil
	}
	if err := scratch.Feed(dropped); err != nil {
		return nil
	}
	window, err := scratch.ReadyWindow(0)
	if err != nil {
		return nil
	}
	gz, err := gzipBase(window)
	if err != nil || uint32(len(gz)) > g.ckptMax {
		return nil
	}
	return gz
}

// appendResize commits one resize record and returns the markers newly
// published by this call that the hub must feed to the live parser in
// order. A completed pending resize plus the incoming marker may both be
// returned; an already-committed duplicate is skipped idempotently.
func (g *retentionGroup) appendResize(marker ResizeMarker, snap baseSnapshotFunc) ([]ResizeMarker, error) {
	if g.closed {
		return nil, fmt.Errorf("retention group closed")
	}
	if marker.AtSeq != g.head || marker.Cols == 0 || marker.Rows == 0 {
		return nil, fmt.Errorf("retention resize out of bounds")
	}
	var applied []ResizeMarker
	if g.pending != nil {
		if err := g.syncDirAs(g.dir); err != nil {
			return nil, err
		}
		p := g.pending
		if p.staged.kind == stagedPayload {
			return nil, errPendingTransaction
		}
		applied = append(applied, p.staged.marker)
		g.publish(p.staged)
		g.pending = nil
	}
	if last, ok := g.lastResize(); ok && last == marker {
		return applied, nil
	}
	cur := &g.segs[len(g.segs)-1]
	rotate := cur.rszCount >= retentionRszMaxCount
	var ckpt []byte
	if rotate {
		ckpt = g.snapshotBase(snap)
	}
	st := &stagedCommit{kind: stagedResize, newHead: g.head, rotate: rotate, marker: marker}
	st.plainAfter, st.lastByteAfter = g.plain, g.lastByte
	if rotate {
		st.newSeg = retentionSegDesc{gen: g.nextGen, start: g.head, startOrdinal: g.nextOrdinal}
		if len(g.segs) == retentionSegsKept {
			st.evict = []uint64{g.segs[0].gen}
		}
	}
	if err := g.commit(st, commitInput{marker: &st.marker, ckpt: ckpt}); err != nil {
		return nil, err
	}
	return append(applied, marker), nil
}

type commitInput struct {
	raw    []byte
	marker *ResizeMarker
	ckpt   []byte
}

// commit stages files, syncs every referenced dependency, swaps the
// manifest over the old one, and syncs the directory before publishing.
// A successful rename makes the transaction visible; only the directory
// sync makes it durable. On a post-rename directory-sync failure the
// staged transaction is retained as pending and the caller must retry.
func (g *retentionGroup) commit(st *stagedCommit, in commitInput) error {
	if err := g.truncateTails(); err != nil {
		return err
	}
	fail := func(err error) error {
		if st.newRaw != nil {
			st.newRaw.Close()
			st.newRaw = nil
		}
		if st.newRsz != nil {
			st.newRsz.Close()
			st.newRsz = nil
		}
		return err
	}
	if st.rotate {
		base := filepath.Join(g.dir, retentionSegBase(st.newSeg.gen))
		if err := rejectNonRegular(base + ".raw"); err != nil {
			return fail(err)
		}
		raw, err := os.OpenFile(base+".raw", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			return fail(err)
		}
		st.newRaw = raw
		if len(in.raw) > 0 {
			if err := writeFullAt(raw, 0, in.raw); err != nil {
				return fail(err)
			}
		}
		if err := rejectNonRegular(base + ".rsz"); err != nil {
			return fail(err)
		}
		rsz, err := os.OpenFile(base+".rsz", os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			return fail(err)
		}
		st.newRsz = rsz
		st.newSeg.rawLen = uint64(len(in.raw))
		if in.marker != nil {
			if err := writeFullAt(rsz, 0, encodeResizeRecord(*in.marker)); err != nil {
				return fail(err)
			}
			st.newSeg.rszCount = 1
		}
		if len(in.ckpt) > 0 {
			if err := writeFileSynced(base+".ckpt", in.ckpt, &g.faults.ckptSync, g); err != nil {
				return fail(err)
			}
			st.newSeg.ckptLen = uint32(len(in.ckpt))
		}
		if err := g.syncDirPlain(g.dir); err != nil {
			return fail(err)
		}
	} else {
		cur := &g.segs[len(g.segs)-1]
		curBase := filepath.Join(g.dir, retentionSegBase(cur.gen))
		if len(in.raw) > 0 {
			if cur.raw == nil {
				if err := rejectNonRegular(curBase + ".raw"); err != nil {
					return err
				}
				f, err := os.OpenFile(curBase+".raw", os.O_RDWR|os.O_CREATE, 0600)
				if err != nil {
					return err
				}
				cur.raw = f
				if err := g.syncDirPlain(g.dir); err != nil {
					return err
				}
			}
			if err := writeFullAt(cur.raw, int64(cur.rawLen), in.raw); err != nil {
				return err
			}
		}
		if in.marker != nil {
			if cur.rsz == nil {
				if err := rejectNonRegular(curBase + ".rsz"); err != nil {
					return err
				}
				f, err := os.OpenFile(curBase+".rsz", os.O_RDWR|os.O_CREATE, 0600)
				if err != nil {
					return err
				}
				cur.rsz = f
				if err := g.syncDirPlain(g.dir); err != nil {
					return err
				}
			}
			if err := writeFullAt(cur.rsz, int64(cur.rszCount)*retentionRszRecLen, encodeResizeRecord(*in.marker)); err != nil {
				return err
			}
		}
		st.curRawAppend = uint64(len(in.raw))
	}
	evicted := make(map[uint64]bool, len(st.evict))
	for _, gen := range st.evict {
		evicted[gen] = true
	}
	// Sync every file this transaction modified. Unmodified referenced
	// files are append-only or immutable, so their committed bytes were
	// already synced by the commit that wrote them; every byte the new
	// manifest references was synced at or before this commit. The new
	// checkpoint file was already synced at creation above.
	if st.rotate {
		if err := g.syncFileAs(st.newRaw, &g.faults.rawSync); err != nil {
			return fail(err)
		}
		if err := g.syncFileAs(st.newRsz, &g.faults.rszSync); err != nil {
			return fail(err)
		}
	} else {
		cur := &g.segs[len(g.segs)-1]
		if len(in.raw) > 0 && cur.raw != nil {
			if err := g.syncFileAs(cur.raw, &g.faults.rawSync); err != nil {
				return fail(err)
			}
		}
		if in.marker != nil && cur.rsz != nil {
			if err := g.syncFileAs(cur.rsz, &g.faults.rszSync); err != nil {
				return fail(err)
			}
		}
	}
	var descs []retentionSegDesc
	for i := range g.segs {
		if evicted[g.segs[i].gen] {
			continue
		}
		d := g.segs[i].retentionSegDesc
		if !st.rotate && i == len(g.segs)-1 {
			d.rawLen += uint64(len(in.raw))
			if in.marker != nil {
				d.rszCount++
			}
		}
		descs = append(descs, d)
	}
	if st.rotate {
		descs = append(descs, st.newSeg)
	}
	// The manifest carries this commit's durable-update time. A failed
	// commit leaves memory ahead of disk; the next commit overwrites it.
	g.lastUpdateNs = g.now().UnixNano()
	m := retentionManifest{
		head:         st.newHead,
		segs:         descs,
		plain:        st.plainAfter,
		lastByte:     st.lastByteAfter,
		flags:        g.flags,
		closedAtNs:   g.closedAtNs,
		lastUpdateNs: g.lastUpdateNs,
	}
	tmp := filepath.Join(g.dir, "MANIFEST.tmp")
	if err := rejectNonRegular(tmp); err != nil {
		return fail(err)
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fail(err)
	}
	if _, err := f.Write(encodeRetentionManifest(m)); err != nil {
		f.Close()
		return fail(err)
	}
	if err := g.syncFileAs(f, &g.faults.manifestSync); err != nil {
		f.Close()
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if err := g.renameAs(tmp, filepath.Join(g.dir, "MANIFEST")); err != nil {
		return fail(err)
	}
	if err := g.syncDirAs(g.dir); err != nil {
		p := &retentionPending{staged: st, oldHead: g.head}
		if st.kind == stagedPayload {
			p.payloadLen = st.admitLen
			p.payloadDigest = st.admitDigest
		}
		g.pending = p
		return err
	}
	g.publish(st)
	return nil
}

// truncateTails removes owned uncommitted tails left by a failed attempt
// before staging again. Committed bytes are never truncated.
func (g *retentionGroup) truncateTails() error {
	cur := &g.segs[len(g.segs)-1]
	if cur.raw != nil {
		if err := cur.raw.Truncate(int64(cur.rawLen)); err != nil {
			return err
		}
	}
	if cur.rsz != nil {
		if err := cur.rsz.Truncate(int64(cur.rszCount) * retentionRszRecLen); err != nil {
			return err
		}
	}
	return nil
}

// publish adopts a durable transaction into memory and deletes evicted
// generations. Publication runs once per admission: either on the commit
// path after the directory sync, or when an identical retry resolves a
// pending transaction.
func (g *retentionGroup) publish(st *stagedCommit) {
	if st.rotate {
		evicted := make(map[uint64]bool, len(st.evict))
		for _, gen := range st.evict {
			evicted[gen] = true
		}
		var kept []retentionSeg
		for i := range g.segs {
			if evicted[g.segs[i].gen] {
				for _, m := range g.segs[i].resizes {
					g.maxEvictedMarkerSeq = max(g.maxEvictedMarkerSeq, m.AtSeq)
				}
				if g.segs[i].raw != nil {
					_ = g.segs[i].raw.Close()
				}
				if g.segs[i].rsz != nil {
					_ = g.segs[i].rsz.Close()
				}
				continue
			}
			kept = append(kept, g.segs[i])
		}
		var resizes []ResizeMarker
		if st.kind == stagedResize {
			resizes = []ResizeMarker{st.marker}
		}
		kept = append(kept, retentionSeg{
			retentionSegDesc: st.newSeg,
			raw:              st.newRaw,
			rsz:              st.newRsz,
			resizes:          resizes,
		})
		st.newRaw, st.newRsz = nil, nil
		g.segs = kept
		g.nextGen = st.newSeg.gen + 1
	} else {
		cur := &g.segs[len(g.segs)-1]
		cur.rawLen += st.curRawAppend
		if st.kind == stagedResize {
			cur.rszCount++
			cur.resizes = append(cur.resizes, st.marker)
		}
	}
	if st.kind == stagedResize {
		g.nextOrdinal++
	}
	g.head = st.newHead
	g.start = g.segs[0].start
	g.plain = st.plainAfter
	g.lastByte = st.lastByteAfter
	for _, gen := range st.evict {
		base := filepath.Join(g.dir, retentionSegBase(gen))
		for _, suffix := range []string{".raw", ".rsz", ".ckpt"} {
			if err := os.Remove(base + suffix); err != nil && !os.IsNotExist(err) {
				componentLogger().Warn("retention eviction left a file behind", "path", base+suffix, "err", err)
			}
		}
	}
}
