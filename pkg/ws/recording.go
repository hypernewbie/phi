package ws

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

// The replay ring is a cache. This append-only journal owns output and its
// geometry; chunk offsets permit bounded reads without rescanning old bytes.
type recordingChunk struct {
	seq    uint64
	offset int64
	length uint32
}
type coldRecording struct {
	file      *os.File
	path      string
	ephemeral bool
	offset    int64
	head      uint64
	chunks    []recordingChunk
	resizes   []ResizeMarker
	// Only ASCII text with CRLF line resets is eligible for a raw tail
	// shortcut. ANSI, UTF-8, tabs, and bare LF require prefix replay.
	plain    bool
	lastByte byte
}

func openRecording(path string) (*coldRecording, error) {
	var f *os.File
	var err error
	ephemeral := path == ""
	if ephemeral {
		f, err = os.CreateTemp("", "phi-recording-*")
	} else {
		f, err = os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	}
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return nil, fmt.Errorf("secure recording permissions: %w", err)
	}
	r := &coldRecording{file: f, path: f.Name(), ephemeral: ephemeral, plain: true}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	for r.offset < info.Size() {
		var hdr [5]byte
		if _, err = f.ReadAt(hdr[:], r.offset); err != nil {
			break
		}
		kind := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		suffixStart := r.offset + 5
		if kind != 1 && kind != 2 {
			suffixStart = r.offset + 1
		}
		if (kind != 1 && kind != 2) || (kind == 2 && n != 4) || n > 64*1024*1024 || r.offset+5+int64(n) > info.Size() {
			if hasValidRecordSuffix(f, suffixStart, info.Size()) {
				f.Close()
				return nil, fmt.Errorf("corrupt recording record at offset %d before retained suffix", r.offset)
			}
			break
		}
		switch kind {
		case 1:
			if err := r.inspectPlain(r.offset+5, n); err != nil {
				f.Close()
				return nil, err
			}
			r.chunks = append(r.chunks, recordingChunk{r.head, r.offset + 5, n})
			r.head += uint64(n)
		case 2:
			var geometry [4]byte
			if _, err = f.ReadAt(geometry[:], r.offset+5); err != nil {
				f.Close()
				return nil, err
			}
			r.resizes = append(r.resizes, ResizeMarker{r.head, binary.BigEndian.Uint16(geometry[:2]), binary.BigEndian.Uint16(geometry[2:])})
		}
		r.offset += 5 + int64(n)
	}
	// Recover only a torn final append; never retain a fabricated byte frontier.
	if err = f.Truncate(r.offset); err != nil {
		f.Close()
		return nil, err
	}
	runtime.SetFinalizer(r, func(r *coldRecording) {
		r.file.Close()
		if r.ephemeral {
			os.Remove(r.path)
		}
	})
	return r, nil
}

// hasValidRecordSuffix distinguishes a torn final append from a damaged
// middle header with later committed records. The journal predates checksums,
// so a committed record chain followed by a torn final append also counts
// as a retained suffix. Ambiguous damage must fail closed, not delete data.
func hasValidRecordChain(file *os.File, start, end int64) bool {
	position := start
	records := 0
	for position < end {
		if position+5 > end {
			// The preceding records are complete even if the last header
			// was only partly written before shutdown.
			return records > 0
		}
		var header [5]byte
		if _, err := file.ReadAt(header[:], position); err != nil {
			return false
		}
		length := binary.BigEndian.Uint32(header[1:])
		if length > 64*1024*1024 ||
			(header[0] == 2 && length != 4) || (header[0] != 1 && header[0] != 2) {
			return false
		}
		if position+5+int64(length) > end {
			return records > 0 // complete suffix, then an incomplete payload
		}
		position += 5 + int64(length)
		records++
	}
	return records > 0 && position == end
}

func hasValidRecordSuffix(file *os.File, start, end int64) bool {
	const blockSize = 64 * 1024
	block := make([]byte, blockSize+4)
	for base := start; base+5 <= end; {
		length := min(int64(len(block)), end-base)
		n, err := file.ReadAt(block[:length], base)
		for i := 0; i+5 <= n; i++ {
			kind := block[i]
			if kind != 1 && kind != 2 {
				continue
			}
			declared := binary.BigEndian.Uint32(block[i+1 : i+5])
			candidate := base + int64(i)
			if declared > 64*1024*1024 || candidate+5+int64(declared) > end ||
				(kind == 2 && declared != 4) {
				continue
			}
			if hasValidRecordChain(file, candidate, end) {
				return true
			}
		}
		if err != nil || n <= 4 {
			break
		}
		base += int64(n - 4)
	}
	return false
}

func (r *coldRecording) notePlain(data []byte) {
	if !r.plain {
		return
	}
	for _, b := range data {
		if (b < 32 && b != '\r' && b != '\n') || b > 126 || (b == '\n' && r.lastByte != '\r') {
			r.plain = false
			return
		}
		r.lastByte = b
	}
}

func (r *coldRecording) inspectPlain(offset int64, length uint32) error {
	if !r.plain || length == 0 {
		return nil
	}
	block := make([]byte, min(length, 64*1024))
	for left := int64(length); left > 0 && r.plain; {
		n := min(int64(len(block)), left)
		if _, err := r.file.ReadAt(block[:n], offset); err != nil {
			return err
		}
		r.notePlain(block[:n])
		offset += n
		left -= n
	}
	return nil
}

// A line reset is a safe raw replay boundary only when the entire prefix is
// plain text and enough complete lines follow it to replace the live buffer.
// Otherwise no shortcut is certified; the client must replay the prefix.
func (r *coldRecording) replayStart() uint64 {
	const tailBytes = 2*1024*1024 - 128*1024
	const minimumLines = 10000 + 4096
	if !r.plain || r.head <= tailBytes {
		return 0
	}
	from := r.head - tailBytes
	data, resizes, err := r.read(from, r.head)
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

func (r *coldRecording) append(kind byte, data []byte) error {
	var hdr [5]byte
	hdr[0] = kind
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(data)))
	if _, err := r.file.WriteAt(hdr[:], r.offset); err != nil {
		return err
	}
	if n, err := r.file.WriteAt(data, r.offset+5); err != nil {
		return err
	} else if n != len(data) {
		return io.ErrShortWrite
	}
	if kind == 1 {
		r.notePlain(data)
		r.chunks = append(r.chunks, recordingChunk{r.head, r.offset + 5, uint32(len(data))})
		r.head += uint64(len(data))
	} else {
		r.resizes = append(r.resizes, ResizeMarker{r.head, binary.BigEndian.Uint16(data[:2]), binary.BigEndian.Uint16(data[2:])})
	}
	r.offset += 5 + int64(len(data))
	return nil
}

func (r *coldRecording) read(from, end uint64) ([]byte, []ResizeMarker, error) {
	if end < from || end > r.head {
		return nil, nil, fmt.Errorf("invalid recording range")
	}
	data := make([]byte, int(end-from))
	i := sort.Search(len(r.chunks), func(i int) bool { c := r.chunks[i]; return c.seq+uint64(c.length) > from })
	for ; i < len(r.chunks); i++ {
		c := r.chunks[i]
		if c.seq >= end {
			break
		}
		start, stop := max(from, c.seq), min(end, c.seq+uint64(c.length))
		if _, err := r.file.ReadAt(data[start-from:stop-from], c.offset+int64(start-c.seq)); err != nil {
			return nil, nil, err
		}
	}
	var resizes []ResizeMarker
	at := sort.Search(len(r.resizes), func(i int) bool { return r.resizes[i].AtSeq >= from })
	// The geometry in force at the beginning matters even when set earlier.
	if at > 0 {
		resizes = append(resizes, r.resizes[at-1])
	}
	for ; at < len(r.resizes) && r.resizes[at].AtSeq <= end; at++ {
		resizes = append(resizes, r.resizes[at])
	}
	return data, resizes, nil
}

// Raw v3 journal.
//
// A raw journal keeps every committed output byte of one terminal, oldest
// first, in a single append-only file beside a versioned manifest. Record
// layout reuses the cold journal: a five-byte header (kind + big-endian
// length) ahead of kind 1 (raw output) or kind 2 (four-byte big-endian
// cols + rows geometry). Raw-byte offsets are the public seq space; file
// offsets stay private behind the chunk index.
//
// The manifest certifies the committed prefix: journal length, raw head,
// next resize ordinal, initial geometry, and lifecycle flags. Every
// accepted append rewrites it; only manifest-certified bytes are readable.
// Bytes past the certified length are an uncommitted tail from a crashed
// attempt and are truncated on open. A malformed certified prefix fails
// closed without touching the files.
//
// The journal has no internal mutex. Every method must run under the
// owning PaneHub's mutex, exactly like the retention group it replaces.

const (
	rawRecordOutput = 1
	rawRecordResize = 2
	rawRecordHeader = 5
	rawRecordMaxLen = 64 << 20
	// rawPageMaxMarkers bounds one replay page. The byte bound lives with
	// the hub page computation; the journal enforces the marker bound
	// because shrinking a page needs the resize index.
	rawPageMaxMarkers = 256
)

var rawManifestMagic = []byte("PHIRV3")

const rawManifestVersion = 1

const (
	rawFlagClosed     uint32 = 1 << 0
	rawFlagIncomplete uint32 = 1 << 1
)

var (
	errRawJournalClosed = errors.New("raw journal is closed")
	// errResizeStaged backpressures the PTY reader: a staged resize must
	// commit before later bytes are admitted. The read loop retries.
	errResizeStaged   = errors.New("resize staged; output held for commit")
	errStagedMismatch = errors.New("staged commit does not match retry")
)

type rawManifest struct {
	committedLen int64
	head         uint64
	nextOrdinal  uint64
	initCols     uint16
	initRows     uint16
	flags        uint32
	closedAtNs   int64
	createdNs    int64
	lastUpdateNs int64
}

func encodeRawManifest(m rawManifest) []byte {
	var buf bytes.Buffer
	buf.Write(rawManifestMagic)
	var tmp [8]byte
	binary.LittleEndian.PutUint16(tmp[:2], rawManifestVersion)
	buf.Write(tmp[:2])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.committedLen))
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], m.head)
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], m.nextOrdinal)
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint16(tmp[:2], m.initCols)
	buf.Write(tmp[:2])
	binary.LittleEndian.PutUint16(tmp[:2], m.initRows)
	buf.Write(tmp[:2])
	binary.LittleEndian.PutUint32(tmp[:4], m.flags)
	buf.Write(tmp[:4])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.closedAtNs))
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.createdNs))
	buf.Write(tmp[:])
	binary.LittleEndian.PutUint64(tmp[:], uint64(m.lastUpdateNs))
	buf.Write(tmp[:])
	out := buf.Bytes()
	var crc [4]byte
	binary.LittleEndian.PutUint32(crc[:], crc32.ChecksumIEEE(out))
	return append(out, crc[:]...)
}

func decodeRawManifest(data []byte) (rawManifest, error) {
	var m rawManifest
	const decodedLen = 6 + 2 + 8 + 8 + 8 + 2 + 2 + 4 + 8 + 8 + 8
	if len(data) != decodedLen+4 {
		return m, fmt.Errorf("raw journal manifest has wrong length %d", len(data))
	}
	body, want := data[:decodedLen], data[decodedLen:]
	if !bytes.Equal(body[:6], rawManifestMagic) {
		return m, fmt.Errorf("raw journal manifest has wrong magic")
	}
	if binary.LittleEndian.Uint16(body[6:8]) != rawManifestVersion {
		return m, fmt.Errorf("raw journal manifest has wrong version")
	}
	if binary.LittleEndian.Uint32(want) != crc32.ChecksumIEEE(body) {
		return m, fmt.Errorf("raw journal manifest checksum mismatch")
	}
	off := 8
	m.committedLen = int64(binary.LittleEndian.Uint64(body[off:]))
	off += 8
	m.head = binary.LittleEndian.Uint64(body[off:])
	off += 8
	m.nextOrdinal = binary.LittleEndian.Uint64(body[off:])
	off += 8
	m.initCols = binary.LittleEndian.Uint16(body[off:])
	off += 2
	m.initRows = binary.LittleEndian.Uint16(body[off:])
	off += 2
	m.flags = binary.LittleEndian.Uint32(body[off:])
	off += 4
	m.closedAtNs = int64(binary.LittleEndian.Uint64(body[off:]))
	off += 8
	m.createdNs = int64(binary.LittleEndian.Uint64(body[off:]))
	off += 8
	m.lastUpdateNs = int64(binary.LittleEndian.Uint64(body[off:]))
	if m.committedLen < 0 || m.nextOrdinal < 1 || m.initCols == 0 || m.initRows == 0 {
		return m, fmt.Errorf("raw journal manifest certifies an impossible prefix")
	}
	return m, nil
}

// rawOrdMarker is a committed geometry record with its 1-based ordinal.
// Ordinal 0 in a cursor means "no resize applied yet"; the initial
// geometry rides the attach frame and replay headers, never the marker
// stream. Ordinals rise with AtSeq, so ordinal filtering implies position
// filtering and same-position changes stay distinct.
type rawOrdMarker struct {
	ResizeMarker
	ordinal uint64
}

// rawStaged is a geometry record written and synced to the journal file
// but not yet named by the manifest. osApplied is set once the caller
// performed the physical resize; only then may the commit complete.
type rawStaged struct {
	cols      uint16
	rows      uint16
	atSeq     uint64
	osApplied bool
}

type rawPendingKind byte

const (
	rawPendingPayload rawPendingKind = iota + 1
	rawPendingResize
)

// rawPending retains a commit whose manifest rename is visible but whose
// directory sync never confirmed durability. Payload bytes are not
// retained: an identical retry re-presents them, and anything else fails
// instead of receiving that acknowledgement.
type rawPending struct {
	kind          rawPendingKind
	newHead       uint64
	newOffset     int64
	payloadLen    int
	payloadDigest [32]byte
	resizeOrdinal uint64
}

type rawFaults struct {
	journalSync  error
	manifestSync error
	rename       error
	dirSync      error
	// syncs counts the file syncs that ran; truncates counts tail
	// repairs, so a test can assert that a clean commit never truncates.
	syncs     int
	truncates int
}

type rawJournal struct {
	dir          string
	file         *os.File
	ephemeral    bool
	closed       bool
	committedLen int64
	head         uint64
	nextOrdinal  uint64
	initCols     uint16
	initRows     uint16
	flags        uint32
	closedAtNs   int64
	createdNs    int64
	lastUpdateNs int64
	chunks       []recordingChunk
	resizes      []rawOrdMarker
	staged       *rawStaged
	pending      *rawPending
	faults       rawFaults
	now          func() time.Time
}

// openRawJournal opens or creates the raw journal at dir. An empty dir
// requests private ephemeral storage in a temporary directory. Recovery
// reads only the manifest-certified prefix; an uncommitted tail is
// truncated and a malformed certified prefix fails closed.
func openRawJournal(dir string, initCols, initRows uint16, now func() time.Time) (*rawJournal, error) {
	ephemeral := dir == ""
	if ephemeral {
		tmp, err := os.MkdirTemp("", "phi-rawjournal-*")
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
		return nil, fmt.Errorf("raw journal path is not a directory: %s", dir)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	j := &rawJournal{dir: dir, ephemeral: ephemeral, nextOrdinal: 1, now: now}
	// A temp manifest is never referenced; a crashed commit may leave one.
	_ = os.Remove(filepath.Join(dir, "MANIFEST.tmp"))
	journalPath := filepath.Join(dir, "journal")
	raw, err := readRetentionManifest(filepath.Join(dir, "MANIFEST"))
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		if _, serr := os.Lstat(journalPath); serr == nil {
			return nil, fmt.Errorf("raw journal has a journal file without a manifest")
		} else if !os.IsNotExist(serr) {
			return nil, serr
		}
		if initCols == 0 || initRows == 0 {
			return nil, fmt.Errorf("raw journal needs positive initial geometry")
		}
		f, err := os.OpenFile(journalPath, os.O_RDWR|os.O_CREATE, 0600)
		if err != nil {
			return nil, err
		}
		if err := f.Chmod(0600); err != nil {
			f.Close()
			return nil, err
		}
		j.file = f
		j.initCols, j.initRows = initCols, initRows
		j.createdNs = now().UnixNano()
		j.lastUpdateNs = j.createdNs
		// The group gets its manifest now: a journal without one is
		// unreadable, and the update clock starts here for expiry.
		if err := j.publishManifest(0, 0, 1); err != nil {
			f.Close()
			return nil, err
		}
		if err := j.syncManifestDir(); err != nil {
			f.Close()
			return nil, err
		}
		return j, nil
	}
	m, err := decodeRawManifest(raw)
	if err != nil {
		return nil, err
	}
	preSize := int64(-1)
	if fi, serr := os.Stat(journalPath); serr == nil {
		preSize = fi.Size()
	}
	f, err := openCommitFile(journalPath, m.committedLen)
	if err != nil {
		return nil, err
	}
	j.file = f
	j.committedLen = m.committedLen
	j.head = m.head
	j.nextOrdinal = m.nextOrdinal
	j.initCols, j.initRows = m.initCols, m.initRows
	j.flags = m.flags
	j.closedAtNs = m.closedAtNs
	j.createdNs = m.createdNs
	j.lastUpdateNs = m.lastUpdateNs
	if preSize > m.committedLen {
		j.faults.truncates++
	}
	if err := j.loadCertified(); err != nil {
		f.Close()
		return nil, err
	}
	// A truncated tail proves a crash, and a lifetime that never
	// recorded its closure may have lost output. Either keeps the
	// verified prefix with an incomplete-history warning; later
	// successful appends cannot clear it.
	if preSize > m.committedLen || (m.flags&rawFlagClosed == 0 && (m.head > 0 || m.nextOrdinal > 1)) {
		j.flags |= rawFlagIncomplete
	}
	if j.flags != m.flags {
		if err := j.publishManifest(j.head, j.committedLen, j.nextOrdinal); err != nil {
			f.Close()
			return nil, err
		}
		if err := j.syncManifestDir(); err != nil {
			f.Close()
			return nil, err
		}
	}
	return j, nil
}

// loadCertified validates the manifest-certified prefix and rebuilds the
// chunk and resize indexes from it. Any structural defect fails closed.
func (j *rawJournal) loadCertified() error {
	var off int64
	var head uint64
	ordinal := uint64(1)
	for off < j.committedLen {
		var hdr [rawRecordHeader]byte
		if _, err := j.file.ReadAt(hdr[:], off); err != nil {
			return fmt.Errorf("raw journal: cannot read certified record at offset %d: %w", off, err)
		}
		kind := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		if (kind != rawRecordOutput && kind != rawRecordResize) || (kind == rawRecordResize && n != 4) ||
			n > rawRecordMaxLen || off+rawRecordHeader+int64(n) > j.committedLen {
			return fmt.Errorf("raw journal: corrupt certified record at offset %d", off)
		}
		if kind == rawRecordOutput {
			j.chunks = append(j.chunks, recordingChunk{seq: head, offset: off + rawRecordHeader, length: n})
			head += uint64(n)
		} else {
			var geo [4]byte
			if _, err := j.file.ReadAt(geo[:], off+rawRecordHeader); err != nil {
				return fmt.Errorf("raw journal: cannot read certified geometry at offset %d: %w", off, err)
			}
			cols := binary.BigEndian.Uint16(geo[:2])
			rows := binary.BigEndian.Uint16(geo[2:])
			if cols == 0 || rows == 0 {
				return fmt.Errorf("raw journal: certified geometry at offset %d is not positive", off)
			}
			j.resizes = append(j.resizes, rawOrdMarker{ResizeMarker: ResizeMarker{AtSeq: head, Cols: cols, Rows: rows}, ordinal: ordinal})
			ordinal++
		}
		off += rawRecordHeader + int64(n)
	}
	if off != j.committedLen || head != j.head || ordinal != j.nextOrdinal {
		return fmt.Errorf("raw journal: certified bytes do not match the manifest")
	}
	return nil
}

// publishManifest rewrites the manifest with the given frontier. Unlike
// the directory sync it is never ambiguous: a failure leaves the
// previous manifest, so no pending commit is recorded.
func (j *rawJournal) publishManifest(head uint64, committedLen int64, nextOrdinal uint64) error {
	if j.ephemeral {
		return nil
	}
	m := rawManifest{
		committedLen: committedLen,
		head:         head,
		nextOrdinal:  nextOrdinal,
		initCols:     j.initCols,
		initRows:     j.initRows,
		flags:        j.flags,
		closedAtNs:   j.closedAtNs,
		createdNs:    j.createdNs,
		lastUpdateNs: j.lastUpdateNs,
	}
	tmp := filepath.Join(j.dir, "MANIFEST.tmp")
	if err := rejectNonRegular(tmp); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(encodeRawManifest(m)); err != nil {
		f.Close()
		return err
	}
	if j.faults.manifestSync != nil {
		f.Close()
		return j.faults.manifestSync
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if j.faults.rename != nil {
		return j.faults.rename
	}
	return os.Rename(tmp, filepath.Join(j.dir, "MANIFEST"))
}

func (j *rawJournal) syncManifestDir() error {
	if j.ephemeral {
		return nil
	}
	if j.faults.dirSync != nil {
		return j.faults.dirSync
	}
	return syncDir(j.dir)
}

func (j *rawJournal) syncJournal() error {
	if j.faults.journalSync != nil {
		return j.faults.journalSync
	}
	j.faults.syncs++
	if j.ephemeral {
		return nil
	}
	return j.file.Sync()
}

// appendPayload commits one PTY output chunk and returns the geometry
// markers committed ahead of it, for live publish. A resize that
// survived its OS step commits first; later bytes wait for it. An
// identical retry after an ambiguous manifest commit completes the
// admission without duplicating bytes; anything else fails.
func (j *rawJournal) appendPayload(payload []byte) ([]rawOrdMarker, error) {
	if j.closed {
		return nil, errRawJournalClosed
	}
	if len(payload) > rawRecordMaxLen {
		return nil, fmt.Errorf("raw journal: payload exceeds %d bytes", rawRecordMaxLen)
	}
	var applied []rawOrdMarker
	if j.staged != nil {
		if !j.staged.osApplied {
			return nil, errResizeStaged
		}
		m, err := j.finishStaged()
		if err != nil {
			return nil, err
		}
		applied = append(applied, m)
	}
	if j.pending != nil {
		if j.pending.kind != rawPendingPayload || j.pending.payloadLen != len(payload) ||
			j.pending.payloadDigest != sha256.Sum256(payload) {
			return applied, errStagedMismatch
		}
		if err := j.syncManifestDir(); err != nil {
			return applied, err
		}
		j.advancePayload(j.pending.newHead, j.pending.newOffset, len(payload))
		j.pending = nil
		return applied, nil
	}
	at := j.committedLen
	var hdr [rawRecordHeader]byte
	hdr[0] = rawRecordOutput
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if n, err := j.file.WriteAt(hdr[:], at); err != nil {
		return applied, err
	} else if n != len(hdr) {
		return applied, io.ErrShortWrite
	}
	if n, err := j.file.WriteAt(payload, at+rawRecordHeader); err != nil {
		return applied, err
	} else if n != len(payload) {
		return applied, io.ErrShortWrite
	}
	if err := j.syncJournal(); err != nil {
		return applied, err
	}
	newHead := j.head + uint64(len(payload))
	newOffset := at + rawRecordHeader + int64(len(payload))
	if err := j.publishManifest(newHead, newOffset, j.nextOrdinal); err != nil {
		return applied, err
	}
	if err := j.syncManifestDir(); err != nil {
		j.pending = &rawPending{kind: rawPendingPayload, newHead: newHead, newOffset: newOffset,
			payloadLen: len(payload), payloadDigest: sha256.Sum256(payload)}
		return applied, err
	}
	j.advancePayload(newHead, newOffset, len(payload))
	return applied, nil
}

func (j *rawJournal) advancePayload(newHead uint64, newOffset int64, payloadLen int) {
	j.chunks = append(j.chunks, recordingChunk{seq: j.head, offset: j.committedLen + rawRecordHeader, length: uint32(payloadLen)})
	j.head = newHead
	j.committedLen = newOffset
	j.lastUpdateNs = j.now().UnixNano()
}

// stageResize writes and syncs a geometry record without committing it.
// The caller performs the physical resize, then commits or abandons.
func (j *rawJournal) stageResize(cols, rows uint16) error {
	if j.closed {
		return errRawJournalClosed
	}
	if cols == 0 || rows == 0 {
		return fmt.Errorf("raw journal: staged geometry is not positive")
	}
	if j.staged != nil || j.pending != nil {
		return fmt.Errorf("raw journal: another commit is still staged")
	}
	var hdr [rawRecordHeader]byte
	hdr[0] = rawRecordResize
	binary.BigEndian.PutUint32(hdr[1:], 4)
	var geo [4]byte
	binary.BigEndian.PutUint16(geo[:2], cols)
	binary.BigEndian.PutUint16(geo[2:], rows)
	if n, err := j.file.WriteAt(hdr[:], j.committedLen); err != nil {
		return err
	} else if n != len(hdr) {
		return io.ErrShortWrite
	}
	if n, err := j.file.WriteAt(geo[:], j.committedLen+rawRecordHeader); err != nil {
		return err
	} else if n != len(geo) {
		return io.ErrShortWrite
	}
	if err := j.syncJournal(); err != nil {
		return err
	}
	j.staged = &rawStaged{cols: cols, rows: rows, atSeq: j.head}
	return nil
}

// commitResize commits the staged resize after the caller performed the
// physical resize. It returns the committed marker for live publish.
func (j *rawJournal) commitResize() (rawOrdMarker, error) {
	if j.closed {
		return rawOrdMarker{}, errRawJournalClosed
	}
	if j.staged == nil {
		return rawOrdMarker{}, fmt.Errorf("raw journal: no staged resize to commit")
	}
	j.staged.osApplied = true
	return j.finishStaged()
}

// finishStaged manifests the staged resize. It runs either from the
// commit after the OS resize or from output admission unblocking behind
// a commit that failed after its OS step.
func (j *rawJournal) finishStaged() (rawOrdMarker, error) {
	s := j.staged
	if s == nil {
		return rawOrdMarker{}, fmt.Errorf("raw journal: no staged resize to commit")
	}
	if j.pending != nil {
		if j.pending.kind != rawPendingResize || j.pending.resizeOrdinal != j.nextOrdinal {
			return rawOrdMarker{}, errStagedMismatch
		}
		if err := j.syncManifestDir(); err != nil {
			return rawOrdMarker{}, err
		}
	} else {
		if err := j.publishManifest(j.head, j.committedLen+rawRecordHeader+4, j.nextOrdinal+1); err != nil {
			return rawOrdMarker{}, err
		}
		if err := j.syncManifestDir(); err != nil {
			j.pending = &rawPending{kind: rawPendingResize, newHead: j.head,
				newOffset: j.committedLen + rawRecordHeader + 4, resizeOrdinal: j.nextOrdinal}
			return rawOrdMarker{}, err
		}
	}
	m := rawOrdMarker{ResizeMarker: ResizeMarker{AtSeq: s.atSeq, Cols: s.cols, Rows: s.rows}, ordinal: j.nextOrdinal}
	j.resizes = append(j.resizes, m)
	j.nextOrdinal++
	j.committedLen += rawRecordHeader + 4
	j.lastUpdateNs = j.now().UnixNano()
	j.staged = nil
	j.pending = nil
	return m, nil
}

// abandonStaged drops a staged resize whose physical step failed and
// truncates its bytes, which the manifest never named.
func (j *rawJournal) abandonStaged() error {
	if j.staged == nil {
		return nil
	}
	if j.pending != nil {
		return fmt.Errorf("raw journal: cannot abandon a resize with an ambiguous commit")
	}
	if err := j.file.Truncate(j.committedLen); err != nil {
		return err
	}
	j.staged = nil
	return nil
}

// readOrd serves raw bytes for [from, end) plus the committed markers
// with an ordinal past afterOrdinal inside that span. Marker output
// stops at rawPageMaxMarkers: the page shrinks to end before the first
// omitted marker's bytes, unless the markers sit exactly at the start,
// in which case an empty span still advances the geometry ordinal.
func (j *rawJournal) readOrd(from, end uint64, afterOrdinal uint64) ([]byte, []rawOrdMarker, uint64, error) {
	if j.closed {
		return nil, nil, 0, errRawJournalClosed
	}
	if end < from || end > j.head {
		return nil, nil, 0, fmt.Errorf("invalid raw journal range")
	}
	if afterOrdinal >= j.nextOrdinal {
		return nil, nil, 0, fmt.Errorf("invalid raw journal cursor")
	}
	at := sort.Search(len(j.resizes), func(i int) bool { return j.resizes[i].ordinal > afterOrdinal })
	var markers []rawOrdMarker
	for ; at < len(j.resizes) && len(markers) <= rawPageMaxMarkers; at++ {
		m := j.resizes[at]
		if m.AtSeq < from {
			continue
		}
		if m.AtSeq > end {
			break
		}
		markers = append(markers, m)
	}
	endOrdinal := afterOrdinal
	if len(markers) > rawPageMaxMarkers {
		// Ordinals rise with AtSeq, so the first 256 markers all sit at
		// or before the first omitted one. The page keeps them and stops
		// its bytes there: no returned output follows an omitted marker.
		// When every marker sits exactly at the start, the empty span
		// still advances the geometry ordinal.
		end = markers[rawPageMaxMarkers].AtSeq
		markers = markers[:rawPageMaxMarkers]
	}
	if len(markers) > 0 {
		endOrdinal = markers[len(markers)-1].ordinal
	}
	data := make([]byte, int(end-from))
	i := sort.Search(len(j.chunks), func(i int) bool { c := j.chunks[i]; return c.seq+uint64(c.length) > from })
	for ; i < len(j.chunks); i++ {
		c := j.chunks[i]
		if c.seq >= end {
			break
		}
		start, stop := max(from, c.seq), min(end, c.seq+uint64(c.length))
		if _, err := j.file.ReadAt(data[start-from:stop-from], c.offset+int64(start-c.seq)); err != nil {
			return nil, nil, 0, err
		}
	}
	return data, markers, endOrdinal, nil
}

// markClosed records a closure event in the manifest. A resize that
// survived its OS step commits first so the closed prefix stays ordered.
func (j *rawJournal) markClosed(ns int64) error {
	if j.closed {
		return errRawJournalClosed
	}
	if j.staged != nil && j.staged.osApplied {
		if _, err := j.finishStaged(); err != nil {
			return err
		}
	}
	j.flags |= rawFlagClosed
	j.closedAtNs = ns
	if j.ephemeral {
		return nil
	}
	if err := j.publishManifest(j.head, j.committedLen, j.nextOrdinal); err != nil {
		return err
	}
	return j.syncManifestDir()
}

// markOpen clears a stale closure when a pane goes live again.
func (j *rawJournal) markOpen() error {
	if j.closed {
		return errRawJournalClosed
	}
	if j.flags&rawFlagClosed == 0 && j.closedAtNs == 0 {
		return nil
	}
	j.flags &^= rawFlagClosed
	j.closedAtNs = 0
	if j.ephemeral {
		return nil
	}
	if err := j.publishManifest(j.head, j.committedLen, j.nextOrdinal); err != nil {
		return err
	}
	return j.syncManifestDir()
}

func (j *rawJournal) close() error {
	if j.closed {
		return nil
	}
	// Every accepted append is already durable; nothing is left to flush.
	j.closed = true
	err := j.file.Close()
	if j.ephemeral {
		// Best effort: the OS reclaims temp dirs on reboot.
		errs := os.RemoveAll(j.dir)
		if err == nil {
			err = errs
		}
	}
	return err
}

func (j *rawJournal) initialGeometry() (uint16, uint16) { return j.initCols, j.initRows }

func (j *rawJournal) historyIncomplete() bool { return j.flags&rawFlagIncomplete != 0 }

// rawStats reports the retained frontier and the index growth the full
// prefix requires. Callers use it for diagnostics, never for paging.
type rawStats struct {
	head       uint64
	fileBytes  int64
	chunks     int
	resizes    int
	incomplete bool
	ephemeral  bool
}

func (j *rawJournal) stats() rawStats {
	return rawStats{head: j.head, fileBytes: j.committedLen, chunks: len(j.chunks), resizes: len(j.resizes), incomplete: j.historyIncomplete(), ephemeral: j.ephemeral}
}
