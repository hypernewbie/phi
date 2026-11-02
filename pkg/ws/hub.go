package ws

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termstate"
	"github.com/hypernewbie/phi/pkg/pty"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// componentLogger returns the "ws" component-tagged base logger, derived
// from whatever slog.Default() currently is. Deliberately NOT a package
// var baked in at init time: package-level vars in an imported package
// initialize before main() runs, i.e. before initLogging() installs the
// real handler (and before a test's installRecordingHandler swaps the
// default) — a cached var would permanently hold the wrong handler and
// silently stop honoring --log-level / PHI_LOG_FORMAT, or drop out of a
// test's recorder entirely. Recomputing per call is cheap (called once per
// connection/pane, never per frame) and always reflects the live default.
func componentLogger() *slog.Logger {
	return slog.Default().With("comp", "ws")
}

type Client struct {
	Ws              *websocket.Conn
	Send            chan []byte
	LastDropWarning time.Time
	FullSince       time.Time

	// Every pane attachment is live-only protobuf: an attach frame at
	// attach, then sequenced output frames.
	NativeState bool
	AnsiState   bool

	// Logger carries this client's comp=ws + conn+pane fields (set by
	// HandleWS, built on componentLogger()) so every log line for its
	// lifetime — writes, overflow, frame traces — correlates back to the
	// same connection. Nil for Clients built directly in tests; logger()
	// falls back to componentLogger().
	Logger *slog.Logger
}

// logger returns c.Logger if set, else componentLogger() — nil-safe so
// tests that construct a bare &Client{} keep working unchanged.
func (c *Client) logger() *slog.Logger {
	if c != nil && c.Logger != nil {
		return c.Logger
	}
	return componentLogger()
}

// ResizeMarker records a backend resize at the output sequence where it
// took effect: every byte at seq >= AtSeq was produced under ColsxRows.
// Archive replay applies markers in order so history reflows the way the
// live terminal did.
type ResizeMarker struct {
	AtSeq uint64
	Cols  uint16
	Rows  uint16
}

// paneCheckpoint is the newest client-uploaded screen snapshot. ANSI is
// stored opaquely; the server never parses it.
type paneCheckpoint struct {
	Through uint64 // output seq the snapshot reflects (exclusive head)
	Cols    uint16
	Rows    uint16
	Ansi    []byte
}

type PaneHub struct {
	clients      map[*Client]bool
	mu           sync.Mutex
	Ring         *RingBuffer
	recording    *retentionGroup
	recordingErr error

	// journal is the v3 raw journal: every committed output byte plus
	// ordered geometry. The retention group above is retired: it stays
	// for tests until the VT removal deletes it, but production paths
	// no longer open or read it.
	journal    *rawJournal
	journalErr error
	// initCols/initRows carry the actual PTY geometry from spawn until
	// the journal opens. Zero means unset; the lazy open falls back to
	// 80x24 only when no spawn ever stored them (tests).
	initCols uint16
	initRows uint16
	// journalRetryAt throttles journal open retries: a failed open
	// retries at most once a second, so a wedged pane self-heals when
	// storage recovers instead of wedging forever or hot-looping.
	journalRetryAt time.Time

	// bridgeManaged marks a pane with an active Pi bridge. Its
	// attachments use the close-on-overflow policy: a full send queue
	// closes the socket instead of evicting queued frames, so a queued
	// bridge control is never silently dropped.
	bridgeManaged bool

	// epoch changes identity: a fresh random value per pane creation, so
	// stale clients/caches cannot mix output from a previous PTY lifetime
	// under the same pane id.
	epoch uint64

	// total is the head output sequence: the count of bytes ever ingested
	// for this pane. Bytes carry absolute seqs [0, total); the retention
	// group reports the oldest retained byte as its moving floor.
	total uint64

	// closedAtUnixNano records the wall-clock closure of an archived pane.
	// Zero means live or unknown; the sweeper never expires those from
	// memory alone.
	closedAtUnixNano int64

	// pendingResize blocks output admission until its geometry is durable.
	pendingResize *ResizeMarker

	// ckpt is the newest accepted client checkpoint, if any.
	ckpt      *paneCheckpoint
	state     *termstate.Terminal
	stateHead uint64
	stateErr  error
}

type Hub struct {
	panes              map[string]*PaneHub
	mu                 sync.RWMutex
	replayBufferBytes  int
	recordingDirectory string
	archives           map[string]*PaneHub

	// auth fences client-facing sockets to the access-auth generation they
	// were admitted at. Password changes close older generations.
	auth authFencer

	// bridgeAttach encodes an optional Pi-bridge snapshot control frame
	// for an attaching client. bridgeExit observes pane death with the
	// exit code. Both are set once before serving; nil disables them.
	bridgeAttach func(snapshot pty.PTYInstanceSnapshot) *wspb.TerminalBridgeState
	onPaneExit   func(inst *pty.PTYInstance, code int)
	// paneOwners tracks the current read-loop owner per pane ID. A restore
	// retry reuses the same ID with a new instance pointer; the delayed old
	// exit must not broadcast, close, or notify for the replacement.
	paneOwners map[string]*pty.PTYInstance

	// Retention ownership and expiry. clock and savedReservations are
	// overridable for deterministic tests.
	clock             func() time.Time
	savedReservations func() (map[string]bool, error)
	leaseFile         *os.File
	leaseHeld         bool
	sweepDone         chan struct{}
	sweepWg           sync.WaitGroup
	sweepStarted      bool
	importFailed      map[string]importFailure
	importScans       uint64
	lastStats         importStats
}

func NewHub(replayBufferBytes int) *Hub {
	return &Hub{
		panes:             make(map[string]*PaneHub),
		archives:          make(map[string]*PaneHub),
		paneOwners:        make(map[string]*pty.PTYInstance),
		replayBufferBytes: replayBufferBytes,
		clock:             time.Now,
		savedReservations: defaultSavedReservations,
		importFailed:      make(map[string]importFailure),
	}
}

// SetBridgeAttach registers the Pi-bridge attach snapshot encoder.
// HandleWS sends one encoded frame per attach; nil state sends nothing.
// Set once before serving.
func (h *Hub) SetBridgeAttach(fn func(snapshot pty.PTYInstanceSnapshot) *wspb.TerminalBridgeState) {
	h.bridgeAttach = fn
}

// wallClock is the retention clock, defaulting to real time for a
// zero-value hub.
func (h *Hub) wallClock() time.Time {
	if h == nil || h.clock == nil {
		return time.Now()
	}
	return h.clock()
}

func (h *Hub) takeRawClock(j *rawJournal) {
	if j != nil && h != nil && h.clock != nil {
		j.now = h.clock
	}
}

func (h *Hub) takeGroupClock(g *retentionGroup) {
	if g != nil && h != nil && h.clock != nil {
		g.now = h.clock
	}
}

// SetOnPaneExit registers the pane-death observer fired from the PTY
// read loop after the exit broadcast. The exiting instance identifies the
// lease owner, so a delayed old exit cannot revoke a replacement lease
// that reused the pane ID. Set once before serving.
func (h *Hub) SetOnPaneExit(fn func(inst *pty.PTYInstance, code int)) {
	h.onPaneExit = fn
}

// notifyPaneExit fires the registered pane-death observer, if any.
func (h *Hub) notifyPaneExit(inst *pty.PTYInstance, code int) {
	if h.onPaneExit != nil {
		h.onPaneExit(inst, code)
	}
}

// SetRecordingDirectory enables private persistence for the application's
// logical pane histories. Call before restoring or spawning any panes.
// The first new server owns the versioned namespace through a nonblocking
// file lease; a second server degrades to bounded private ephemeral
// storage and reports no error. The lease cannot prove that an older
// binary without leases has stopped; that deployment precondition is
// documented, not enforced.
func (h *Hub) SetRecordingDirectory(dir string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Validate before mutating anything: the caller logs setup errors
	// and keeps serving, so a rejected directory must leave the
	// previous state (or the disabled zero state) behind, never a
	// half-configured namespace without a lease.
	for _, p := range []string{dir, filepath.Join(dir, "v3")} {
		if fi, err := os.Lstat(p); err != nil {
			if !os.IsNotExist(err) {
				return err
			}
		} else if !fi.Mode().IsDir() {
			return fmt.Errorf("retention path is not a directory: %s", p)
		}
	}
	if h.leaseFile != nil {
		// A repeat call releases first: flock conflicts even with
		// the same process, so re-locking without release would
		// demote this hub to ephemeral storage.
		h.leaseFile.Close()
		h.leaseFile = nil
		h.leaseHeld = false
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	// Raw journals live in the v3 namespace below the recording
	// directory. Pre-upgrade v2 groups and legacy journals beside it are
	// never opened, imported, swept, or deleted by this server; updated
	// clients start fresh histories and cannot see them.
	if err := os.MkdirAll(filepath.Join(dir, "v3"), 0700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Join(dir, "v3"), 0700); err != nil {
		return err
	}
	h.recordingDirectory = dir
	leasePath := filepath.Join(dir, "v3", "lease")
	if fi, err := os.Lstat(leasePath); err == nil && !fi.Mode().IsRegular() {
		// A planted link must never receive the namespace lock: drop the
		// link itself (never the target) and create a real lease file.
		if err := os.Remove(leasePath); err != nil {
			return err
		}
	}
	lease, err := os.OpenFile(leasePath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err := lockFileNonblocking(lease); err != nil {
		lease.Close()
		log.Printf("[ws] recordings namespace owned by another server; running on bounded ephemeral storage: %v", err)
		h.recordingDirectory = ""
		h.leaseHeld = false
		h.leaseFile = nil
		return nil
	}
	h.leaseFile = lease
	h.leaseHeld = true
	return nil
}

func (h *Hub) recordingEnabled() bool {
	h.mu.RLock()
	enabled := h.recordingDirectory != ""
	h.mu.RUnlock()
	return enabled
}

func (h *Hub) recordingPath(paneID string) string {
	if h.recordingDirectory == "" {
		return ""
	}
	return filepath.Join(h.recordingDirectory, "v3", fmt.Sprintf("%x", sha256.Sum256([]byte(paneID))))
}

func (h *Hub) SetReplayBufferBytes(bytes int) {
	h.mu.Lock()
	h.replayBufferBytes = bytes
	h.mu.Unlock()
}

// GetOrCreatePaneHub resolves the live owner for a pane. Pre-upgrade
// histories are never adopted: a pane without a v3 journal starts a
// fresh history once its spawn stores the initial geometry.
func (h *Hub) GetOrCreatePaneHub(paneID string) (*PaneHub, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	ph, exists := h.panes[paneID]
	if !exists {
		var ring *RingBuffer
		if h.replayBufferBytes > 0 {
			ring = NewRingBuffer(h.replayBufferBytes)
		}
		ph = h.archives[paneID]
		if ph != nil {
			// Promote the owner, not just its file. In-flight cold reads and
			// the live writer must continue to use the same journal mutex.
			delete(h.archives, paneID)
		} else {
			ph = &PaneHub{clients: make(map[*Client]bool)}
		}
		ph.mu.Lock()
		defer ph.mu.Unlock()
		if ph.journal != nil && ph.journal.readOnly {
			_ = ph.journal.close()
			ph.journal = nil
		}
		// Open the journal when an on-disk group or a stored spawn
		// geometry exists; otherwise InitPaneJournal (spawn/restore) or
		// the first Ingest opens it. A failed open is sticky: callers
		// see the error instead of a fresh empty authority.
		if ph.journal == nil && ph.journalErr == nil {
			ph.journal, ph.journalErr = h.openPaneJournal(paneID, ph)
		}
		h.takeRawClock(ph.journal)
		ph.closedAtUnixNano = 0
		if ph.journal != nil {
			if err := ph.journal.markOpen(); err != nil {
				log.Printf("[ws] pane %s: could not record its reopening: %v", paneID, err)
			}
		}
		ph.Ring = ring
		ph.epoch = randomEpoch()
		if ph.journal != nil {
			ph.total = ph.journal.head
			if ring != nil && ph.total > 0 {
				var from uint64
				if ph.total > uint64(h.replayBufferBytes) {
					from = ph.total - uint64(h.replayBufferBytes)
				}
				// The ring is a cache: a bounded tail fill needs no
				// markers, so the ordinal cursor starts at the head.
				data, _, _, err := ph.journal.readOrd(from, ph.total, ph.journal.nextOrdinal-1)
				if err == nil {
					ring.Write(data)
				}
			}
		}
		h.panes[paneID] = ph
	}
	return ph, nil
}

// openPaneJournal opens the v3 journal for a pane hub. An on-disk group
// reopens with its manifest baseline; otherwise the stored spawn geometry
// seeds a new journal. With neither, the journal stays unopened (nil,
// nil) until InitPaneJournal runs. The caller holds h.mu.
func (h *Hub) openPaneJournal(paneID string, ph *PaneHub) (*rawJournal, error) {
	path := h.recordingPath(paneID)
	if path == "" {
		// InitPaneJournal must seed ephemeral histories with the actual
		// spawn geometry too, not the first GetOrCreate's defaults.
		if ph.initCols == 0 || ph.initRows == 0 {
			return nil, nil
		}
		return openRawJournal("", ph.initCols, ph.initRows, h.wallClock)
	}
	if _, err := os.Stat(path); err == nil {
		return openRawJournal(path, 0, 0, h.wallClock)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if ph.initCols == 0 || ph.initRows == 0 {
		return nil, nil
	}
	return openRawJournal(path, ph.initCols, ph.initRows, h.wallClock)
}

// ensurePaneJournalLocked opens the pane journal when missing and retries
// a failed open at most once a second. The caller holds ph.mu.
func (h *Hub) ensurePaneJournalLocked(paneID string, ph *PaneHub) error {
	if ph.journal != nil {
		return nil
	}
	now := h.wallClock()
	if ph.journalErr != nil && now.Sub(ph.journalRetryAt) < time.Second {
		return ph.journalErr
	}
	ph.journalRetryAt = now
	ph.journal, ph.journalErr = h.openPaneJournal(paneID, ph)
	// Nonpersistent helper callers may admit output without a spawn.
	// Production initializes explicitly before any PTY read is admitted.
	if ph.journal == nil && ph.journalErr == nil && h.recordingDirectory == "" {
		ph.journal, ph.journalErr = openRawJournal("", ph.initColsOrDefault(), ph.initRowsOrDefault(), h.wallClock)
	}
	h.takeRawClock(ph.journal)
	if ph.journalErr != nil {
		return ph.journalErr
	}
	if ph.journal == nil {
		return fmt.Errorf("pane journal unavailable")
	}
	ph.total = ph.journal.head
	return nil
}

func (ph *PaneHub) initColsOrDefault() uint16 {
	if ph.initCols == 0 {
		return 80
	}
	return ph.initCols
}

func (ph *PaneHub) initRowsOrDefault() uint16 {
	if ph.initRows == 0 {
		return 24
	}
	return ph.initRows
}

// InitPaneJournal stores the actual spawn geometry and opens the pane's
// journal before the read loop admits bytes. StartPTYReadLoop calls this
// synchronously; reopening an existing journal keeps its manifest
// baseline. Idempotent.
func (h *Hub) InitPaneJournal(paneID string, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		return err
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.initCols == 0 || ph.initRows == 0 {
		ph.initCols, ph.initRows = cols, rows
	}
	if ph.journal == nil && ph.journalErr == nil {
		ph.journal, ph.journalErr = h.openPaneJournal(paneID, ph)
		h.takeRawClock(ph.journal)
		if ph.journal != nil {
			ph.total = ph.journal.head
		}
	}
	return ph.journalErr
}

func randomEpoch() uint64 {
	// Epochs ride the wire as JSON numbers and JS clients round-trip
	// them through doubles, which lose integer precision above 2^53.
	// A full 64-bit epoch would come back with different low bits, so
	// every epoch-scoped check (checkpoint store, recording fetch)
	// would spuriously mismatch in production while tests with small
	// epochs stay green. 53 random bits still uniquely identify a pane
	// lifetime, and epoch 0 is valid everywhere (never a sentinel).
	const doubleSafeMask = uint64((1 << 53) - 1)
	var b [8]byte
	if _, err := rand.Read(b[:]); err == nil {
		return binary.BigEndian.Uint64(b[:]) & doubleSafeMask
	}
	n := time.Now().UnixNano()
	return (uint64(n)<<32 | uint64(n>>32)) & doubleSafeMask
}

// LookupPane returns the pane hub without creating one.
func (h *Hub) LookupPane(paneID string) (*PaneHub, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ph, ok := h.panes[paneID]
	return ph, ok
}

// EpochOf exposes the pane identity epoch for diagnostics/tests.
func (ph *PaneHub) EpochOf() uint64 {
	ph.mu.Lock()
	defer ph.mu.Unlock()
	return ph.epoch
}

func (h *Hub) Register(paneID string, client *Client) {
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		log.Printf("[ws] register pane %s: %v", paneID, err)
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}
	ph.mu.Lock()
	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered client for pane %s", paneID)
}

// PanePosition is the seq-space snapshot a hot attach or recording read
// is taken against. Oldest is the first retained byte seq, Head is one
// past the newest byte (so live output resumes at exactly Head).
type PanePosition struct {
	Epoch  uint64
	Oldest uint64
	Head   uint64
	// EventCursor is the resize boundary a state response consumed,
	// empty when the call produced no checkpoint.
	EventCursor string
}

// positionLocked reads the pane's seq state under ph.mu.
func (ph *PaneHub) positionLocked() PanePosition {
	if ph.journal != nil {
		// The raw journal never evicts: the oldest byte is always zero.
		return PanePosition{Epoch: ph.epoch, Oldest: 0, Head: ph.total}
	}
	retained := uint64(0)
	if ph.Ring != nil {
		used, _ := ph.Ring.Stats()
		retained = uint64(used)
	}
	oldest := ph.total
	if retained > ph.total {
		retained = ph.total
	}
	oldest = ph.total - retained
	return PanePosition{Epoch: ph.epoch, Oldest: oldest, Head: ph.total}
}

// RecordingHeaderJSON is the header of the /recording HTTP response; raw
// bytes follow it in the body.
type RecordingHeaderJSON = wireproto.RecordingHeader

// AttachHot registers a protobuf client and enqueues its attach frame.
// Registration and the head capture happen under the pane lock, so the
// client is guaranteed to receive every output frame with start >= Head:
// the boundary is atomic, no gap, no duplication. Nothing from before
// Head is pushed — history stays off the live path.
func (h *Hub) AttachHot(paneID string, client *Client) {
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		log.Printf("[ws] attach pane %s: %v", paneID, err)
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}
	ph.mu.Lock()
	pos := ph.positionLocked()

	attach := &wspb.TerminalAttach{
		Epoch:  proto.Uint64(pos.Epoch),
		Oldest: proto.Uint64(pos.Oldest),
		Head:   proto.Uint64(pos.Head),
	}
	// The server sends no checkpoint: v2 clients replay raw bytes plus
	// ordered geometry from byte zero. The attach carries the replay
	// baseline (initial geometry), the head fence, and the durability
	// warnings. Client.NativeState/AnsiState are ignored; the fields
	// stay until the VT removal deletes them.
	if ph.journal != nil {
		initCols, initRows := ph.journal.initialGeometry()
		attach.InitialCols = proto.Uint32(uint32(initCols))
		attach.InitialRows = proto.Uint32(uint32(initRows))
		attach.EventCursor = proto.String(EncodeEventCursor(pos.Epoch, pos.Head, ph.journal.nextOrdinal-1))
		if ph.journal.historyIncomplete() {
			attach.HistoryIncomplete = proto.Bool(true)
		}
		if ph.journal.ephemeral {
			attach.Ephemeral = proto.Bool(true)
		}
	} else {
		attach.InitialCols = proto.Uint32(uint32(ph.initColsOrDefault()))
		attach.InitialRows = proto.Uint32(uint32(ph.initRowsOrDefault()))
		attach.EventCursor = proto.String(EncodeEventCursor(pos.Epoch, pos.Head, 0))
		if ph.journalErr != nil {
			log.Printf("[ws] attach pane %s: journal unavailable: %v", paneID, ph.journalErr)
		}
	}
	if frame, err := wireproto.EncodeAttachFrame(attach); err != nil {
		log.Printf("[ws] attach pane %s: encode error: %v", paneID, err)
	} else {
		client.Send <- frame
	}

	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered protobuf client for pane %s (epoch %d, head %d, live-only)", paneID, pos.Epoch, pos.Head)
}

// Replay errors map to HTTP statuses at the /replay endpoint: malformed
// requests (400), stale epochs and revealed future fences (409), missing
// history (404), and unavailable storage (503).
var (
	ErrReplayBadRequest  = errors.New("invalid replay request")
	ErrReplayEpoch       = errors.New("replay epoch mismatch")
	ErrReplayFuture      = errors.New("replay fence beyond head")
	ErrReplayNoHistory   = errors.New("no replay history")
	ErrReplayUnavailable = errors.New("replay storage unavailable")
)

// replayPageMaxBytes caps one replay page of raw output.
const replayPageMaxBytes = 2 << 20

// ReplayRequest is one raw replay page request. Latest drains the exit
// tail: it captures the current head as a finite fence and ignores
// ThroughCursor.
type ReplayRequest struct {
	Epoch         uint64
	From          uint64
	Through       uint64
	ThroughCursor string
	AfterCursor   string
	Latest        bool
}

// ReplayPage is one raw replay page: output bytes plus the geometry that
// orders them. End and EndCursor fence the next request.
type ReplayPage struct {
	Through       uint64
	ThroughCursor string
	Epoch         uint64
	Start         uint64
	End           uint64
	Data          []byte
	Resizes       []ResizeMarker
	EndCursor     string
	InitCols      uint16
	InitRows      uint16
	Incomplete    bool
	Ephemeral     bool
}

// Replay serves one raw replay page from the pane journal. The journal
// never evicts, so every request replays a complete prefix from byte
// zero; there is no snapshot base and no older-history import.
func (h *Hub) Replay(paneID string, req ReplayRequest) (ReplayPage, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return ReplayPage{}, ErrReplayNoHistory
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.journal == nil {
		return ReplayPage{}, ErrReplayUnavailable
	}
	head := ph.journal.head
	if req.Epoch != ph.epoch {
		return ReplayPage{}, ErrReplayEpoch
	}
	if req.From > head {
		return ReplayPage{}, fmt.Errorf("%w: from past head", ErrReplayBadRequest)
	}
	through := req.Through
	throughOrdinal := ph.journal.nextOrdinal - 1
	if req.Latest {
		through = head
	} else {
		if req.ThroughCursor == "" {
			return ReplayPage{}, fmt.Errorf("%w: through requires its fence", ErrReplayBadRequest)
		}
		cEpoch, cPos, cOrd, err := ParseEventCursor(req.ThroughCursor)
		if err != nil {
			return ReplayPage{}, fmt.Errorf("%w: bad through fence", ErrReplayBadRequest)
		}
		if cEpoch != ph.epoch {
			return ReplayPage{}, ErrReplayEpoch
		}
		if cPos != through {
			return ReplayPage{}, fmt.Errorf("%w: fence certifies a different end", ErrReplayBadRequest)
		}
		if through > head || cOrd >= ph.journal.nextOrdinal {
			return ReplayPage{}, ErrReplayFuture
		}
		throughOrdinal = cOrd
	}
	// A fence may exclude later events at its own byte position, never
	// events before that position or events that have not happened yet.
	validPosition := func(pos, ord uint64) bool {
		markers := ph.journal.resizes
		return ord < ph.journal.nextOrdinal &&
			(ord == 0 || markers[ord-1].AtSeq <= pos) &&
			(ord == uint64(len(markers)) || markers[ord].AtSeq >= pos)
	}
	if !validPosition(through, throughOrdinal) {
		return ReplayPage{}, fmt.Errorf("%w: inconsistent through cursor", ErrReplayBadRequest)
	}
	if through < req.From {
		return ReplayPage{}, fmt.Errorf("%w: through before from", ErrReplayBadRequest)
	}
	end := through
	if end > head {
		end = head
	}
	if end-req.From > replayPageMaxBytes {
		end = req.From + replayPageMaxBytes
	}
	var afterOrdinal uint64
	if req.AfterCursor != "" {
		cEpoch, cPos, cOrd, err := ParseEventCursor(req.AfterCursor)
		if err != nil {
			return ReplayPage{}, fmt.Errorf("%w: bad paging cursor", ErrReplayBadRequest)
		}
		if cEpoch != ph.epoch {
			return ReplayPage{}, ErrReplayEpoch
		}
		if cPos != req.From {
			return ReplayPage{}, fmt.Errorf("%w: paging cursor certifies a different start", ErrReplayBadRequest)
		}
		afterOrdinal = cOrd
	}
	if afterOrdinal > throughOrdinal || !validPosition(req.From, afterOrdinal) {
		return ReplayPage{}, fmt.Errorf("%w: inconsistent paging cursor", ErrReplayBadRequest)
	}
	data, ordMarkers, endOrdinal, err := ph.journal.readOrdThrough(req.From, end, afterOrdinal, throughOrdinal)
	if err != nil {
		return ReplayPage{}, ErrReplayUnavailable
	}
	finalEnd := req.From + uint64(len(data))
	resizes := make([]ResizeMarker, len(ordMarkers))
	for i, m := range ordMarkers {
		resizes[i] = m.ResizeMarker
	}
	initCols, initRows := ph.journal.initialGeometry()
	return ReplayPage{
		Through:       through,
		ThroughCursor: EncodeEventCursor(ph.epoch, through, throughOrdinal),
		Epoch:         ph.epoch,
		Start:         req.From,
		End:           finalEnd,
		Data:          data,
		Resizes:       resizes,
		EndCursor:     EncodeEventCursor(ph.epoch, finalEnd, endOrdinal),
		InitCols:      initCols,
		InitRows:      initRows,
		Incomplete:    ph.journal.historyIncomplete(),
		Ephemeral:     ph.journal.ephemeral,
	}, nil
}

func (ph *PaneHub) appendResizeLocked(marker ResizeMarker) error {
	if ph.recording == nil || ph.recording.isClosed() {
		return fmt.Errorf("recording unavailable for resize")
	}
	marker.AtSeq = ph.total
	applied, err := ph.recording.appendResize(marker, ph.snapshotBaseLocked)
	if err != nil {
		return err
	}
	for _, m := range applied {
		ph.applyResizeToParserLocked(m)
	}
	ph.pendingResize = nil
	return nil
}

func (ph *PaneHub) applyResizeToParserLocked(marker ResizeMarker) {
	if ph.state == nil {
		return
	}
	if err := ph.state.Resize(int(marker.Cols), int(marker.Rows)); err != nil {
		_ = ph.state.Close()
		ph.state = nil
		ph.stateHead = 0
		ph.stateErr = err
	}
}

// snapshotBaseLocked gzip-compresses the live parser as a zero-scrollback
// base checkpoint for a rotated-to segment. Any failure yields (nil, nil):
// the segment commits with an unavailable base and live output continues.
func (ph *PaneHub) snapshotBaseLocked() ([]byte, error) {
	if ph.state == nil && ph.stateErr == nil {
		_ = ph.prepareStateLocked()
	}
	if ph.state == nil {
		return nil, nil
	}
	window, err := ph.state.ReadyWindow(0)
	if err != nil {
		return nil, nil
	}
	gz, err := gzipBase(window)
	if err != nil {
		return nil, nil
	}
	return gz, nil
}

// RecordResize notes a backend resize at the pane's current head seq.
// Retired: production resizes go through StagePaneResize. It stays until
// the VT removal deletes the retention group it writes to.
func (h *Hub) RecordResize(paneID string, cols, rows uint16) {
	if cols == 0 || rows == 0 {
		return
	}
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		log.Printf("[ws] resize pane %s: %v", paneID, err)
		return
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.pendingResize != nil {
		if ph.pendingResize.Cols == cols && ph.pendingResize.Rows == rows {
			return
		}
	} else if ph.recording != nil && !ph.recording.isClosed() {
		if last, ok := ph.recording.lastResize(); ok && last.Cols == cols && last.Rows == rows {
			return
		}
	}
	marker := ResizeMarker{AtSeq: ph.total, Cols: cols, Rows: rows}
	if err := ph.appendResizeLocked(marker); err != nil {
		ph.pendingResize = &marker
		log.Printf("[recording] resize: %v", err)
	}
}

// journalGeometryCurrent reports whether the journal's newest geometry
// already has this size, so same-size nudges commit nothing.
func journalGeometryCurrent(j *rawJournal, cols, rows uint16) bool {
	if n := len(j.resizes); n > 0 {
		last := j.resizes[n-1]
		return last.Cols == cols && last.Rows == rows
	}
	return j.initCols == cols && j.initRows == rows
}

// publishGeometryLocked broadcasts one committed resize to live clients.
// The caller holds ph.mu; the marker is already durable.
func (h *Hub) publishGeometryLocked(ph *PaneHub, paneID string, m rawOrdMarker) {
	frame, err := wireproto.EncodeGeometryFrame(m.AtSeq, uint32(m.Cols), uint32(m.Rows), EncodeEventCursor(ph.epoch, m.AtSeq, m.ordinal))
	if err != nil {
		componentLogger().With("pane", paneID).Error("terminal geometry encode failed; live clients must reattach", "err", err)
		return
	}
	for client := range ph.clients {
		h.deliverPaneFrame(ph, client, frame)
	}
}

// StagePaneResize stages a backend resize in the pane journal and returns
// the commit/abort pair for ResizeRecorded. A staging failure refuses the
// physical resize. The commit runs only after the physical resize and
// publishes the live geometry frame; the abort drops the uncommitted
// stage after a physical failure.
func (h *Hub) StagePaneResize(paneID string, cols, rows uint16) (commit func() error, abort func(), err error) {
	noop := func() error { return nil }
	noopAbort := func() {}
	if cols == 0 || rows == 0 {
		return noop, noopAbort, nil
	}
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		return nil, nil, err
	}
	ph.mu.Lock()
	if err := h.ensurePaneJournalLocked(paneID, ph); err != nil {
		ph.mu.Unlock()
		return nil, nil, err
	}
	if ph.journal.staged != nil {
		// A commit that failed after its OS step resolves here, so an
		// idle pane cannot wedge later resizes behind it. A stage
		// whose OS step never ran means unserialized callers; refuse
		// rather than wedge.
		if !ph.journal.staged.osApplied {
			ph.mu.Unlock()
			return nil, nil, fmt.Errorf("raw journal: another commit is still staged")
		}
		m, err := ph.journal.finishStaged()
		if err != nil {
			ph.mu.Unlock()
			return nil, nil, err
		}
		h.publishGeometryLocked(ph, paneID, m)
	}
	if journalGeometryCurrent(ph.journal, cols, rows) {
		ph.mu.Unlock()
		return noop, noopAbort, nil
	}
	if err := ph.journal.stageResize(cols, rows); err != nil {
		ph.mu.Unlock()
		return nil, nil, err
	}
	ph.mu.Unlock()
	commit = func() error {
		ph.mu.Lock()
		defer ph.mu.Unlock()
		m, err := ph.journal.commitResize()
		if err != nil {
			// The OS resize succeeded; the stage stays pending and the
			// next Ingest or resize finishes the commit and publishes.
			return err
		}
		h.publishGeometryLocked(ph, paneID, m)
		return nil
	}
	abort = func() {
		ph.mu.Lock()
		defer ph.mu.Unlock()
		if ph.journal != nil {
			_ = ph.journal.abandonStaged()
		}
	}
	return commit, abort, nil
}

// RecordRestoreGeometry commits the restored PTY size before new output.
// Unlike a live resize there is no physical step: the PTY already has
// this size. A restored size matching the journal baseline commits
// nothing. The caller runs InitPaneJournal first.
func (h *Hub) RecordRestoreGeometry(paneID string, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		return err
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if err := h.ensurePaneJournalLocked(paneID, ph); err != nil {
		return err
	}
	if journalGeometryCurrent(ph.journal, cols, rows) {
		return nil
	}
	if ph.journal.staged != nil || ph.journal.pending != nil {
		return fmt.Errorf("raw journal: another commit is still staged")
	}
	if err := ph.journal.stageResize(cols, rows); err != nil {
		return err
	}
	m, err := ph.journal.commitResize()
	if err != nil {
		return err
	}
	h.publishGeometryLocked(ph, paneID, m)
	return nil
}

// Recording is the server's bounded terminal recording read (plan §5):
// raw output bytes for [from, min(through, head)) plus the resize markers
// that fall inside that span. from is clamped up to oldest so a caller can
// discover truncation by comparing Start with its requested from.
type Recording struct {
	Epoch   uint64
	Start   uint64
	End     uint64
	Data    []byte
	Resizes []ResizeMarker
	// EventCursor continues marker filtering on the next page.
	EventCursor string
}

// Event cursor failures distinguish malformed requests from boundaries
// rotation removed. Callers map invalid to 400 and expired to 409.
var (
	ErrEventCursorInvalid = errors.New("invalid event cursor")
	ErrEventCursorExpired = errors.New("event cursor boundary expired")
)

func (h *Hub) recordingForRead(paneID string) *PaneHub {
	h.mu.RLock()
	ph := h.panes[paneID]
	if ph == nil {
		ph = h.archives[paneID]
	}
	h.mu.RUnlock()
	if ph != nil {
		return ph
	}
	// Cold opens read the certified prefix without recovery writes.
	// Publish one owner so promotion serializes against in-flight reads.
	h.mu.Lock()
	if ph = h.panes[paneID]; ph != nil {
		h.mu.Unlock()
		return ph
	}
	if ph = h.archives[paneID]; ph != nil {
		h.mu.Unlock()
		return ph
	}
	path := h.recordingPath(paneID)
	if path == "" {
		h.mu.Unlock()
		return nil
	}
	_, statErr := os.Lstat(path)
	if statErr != nil && !os.IsNotExist(statErr) {
		h.mu.Unlock()
		return &PaneHub{journalErr: statErr}
	}
	if statErr == nil {
		journal, err := openRawJournalReadOnly(path, h.wallClock)
		if err != nil {
			ph = &PaneHub{clients: make(map[*Client]bool), epoch: randomEpoch(), journalErr: err}
			h.mu.Unlock()
			return ph // unavailable is not absent history
		}
		h.takeRawClock(journal)
		ph = &PaneHub{
			clients: make(map[*Client]bool),
			journal: journal,
			epoch:   randomEpoch(),
			total:   journal.head,
		}
		h.archives[paneID] = ph
		h.mu.Unlock()
		return ph
	}
	h.mu.Unlock()
	// No v3 journal, no history: pre-upgrade files are never adopted.
	return nil
}

func (h *Hub) Recording(paneID string, from, through uint64) (Recording, bool) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return Recording{}, false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	pos := ph.positionLocked()
	if from > pos.Head {
		return Recording{}, false
	}
	if from < pos.Oldest {
		from = pos.Oldest
	}
	end := through
	if end > pos.Head {
		end = pos.Head
	}
	if end < from {
		// The window lies wholly below the floor, so none of it is left.
		// Serve the empty span at the floor: the start is above the
		// requested position, which is how a client learns that the
		// prefix expired.
		end = from
	}
	if end-from > MaxCheckpointBytes {
		end = from + MaxCheckpointBytes
	}
	rec := Recording{Epoch: pos.Epoch, Start: from, End: end}
	if ph.recording == nil || ph.recording.isClosed() {
		return Recording{}, false
	}
	data, ords, endOrdinal, err := ph.recording.readOrd(from, end, 0, false)
	if err != nil {
		return Recording{}, false
	}
	rec.Data = data
	rec.Resizes = make([]ResizeMarker, len(ords))
	for i, o := range ords {
		rec.Resizes[i] = o.ResizeMarker
	}
	rec.EventCursor = EncodeEventCursor(pos.Epoch, end, endOrdinal)
	return rec, true
}

// RecordingAfterCursor serves a recording page after a checkpoint: only
// resizes after the cursor's ordinal are included, so same-position
// boundaries apply exactly once. The span rules match Recording; the
// returned end cursor continues the chain.
func (h *Hub) RecordingAfterCursor(paneID string, from, through uint64, after string) (Recording, string, error) {
	cursorEpoch, cursorPos, afterOrdinal, err := ParseEventCursor(after)
	if err != nil {
		return Recording{}, "", ErrEventCursorInvalid
	}
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return Recording{}, "", ErrEventCursorInvalid
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	pos := ph.positionLocked()
	if cursorEpoch != pos.Epoch {
		return Recording{}, "", ErrEventCursorExpired
	}
	if from > pos.Head {
		return Recording{}, "", ErrEventCursorInvalid
	}
	if from < pos.Oldest {
		from = pos.Oldest
	}
	end := through
	if end > pos.Head {
		end = pos.Head
	}
	if end < from {
		// The window lies wholly below the floor: the empty span at the
		// floor reports the expired prefix, like Recording does.
		end = from
	}
	if end-from > MaxCheckpointBytes {
		end = from + MaxCheckpointBytes
	}
	if ph.recording == nil || ph.recording.isClosed() {
		return Recording{}, "", ErrEventCursorInvalid
	}
	if ph.recording.cursorExpired(pos.Oldest, cursorPos, afterOrdinal) {
		return Recording{}, "", ErrEventCursorExpired
	}
	data, ords, endOrdinal, err := ph.recording.readOrd(from, end, afterOrdinal, true)
	if err != nil {
		return Recording{}, "", ErrEventCursorInvalid
	}
	rec := Recording{Epoch: pos.Epoch, Start: from, End: end, Data: data}
	rec.Resizes = make([]ResizeMarker, len(ords))
	for i, o := range ords {
		rec.Resizes[i] = o.ResizeMarker
	}
	endCursor := EncodeEventCursor(pos.Epoch, end, endOrdinal)
	rec.EventCursor = endCursor
	return rec, endCursor, nil
}

// MaxCheckpointBytes bounds client-uploaded screen snapshots.
const MaxCheckpointBytes = 2 * 1024 * 1024

// StoreCheckpoint validates and stores the newest client screen snapshot.
// Rules (plan §3): epoch must match the live pane, Through must not exceed
// the head, payloads are size-bounded, and only the newest valid
// checkpoint is kept. The ANSI bytes are stored opaquely.
type CheckpointUpload struct {
	Epoch   uint64
	Through uint64
	Cols    uint16
	Rows    uint16
	Ansi    []byte
}

func (h *Hub) StoreCheckpoint(paneID string, up CheckpointUpload) bool {
	ph, ok := h.LookupPane(paneID)
	if !ok {
		return false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	if up.Epoch != ph.epoch {
		return false
	}
	if up.Through > ph.total {
		return false
	}
	if up.Cols == 0 || up.Rows == 0 || len(up.Ansi) == 0 || len(up.Ansi) > MaxCheckpointBytes {
		return false
	}
	if ph.ckpt != nil && up.Through <= ph.ckpt.Through {
		// Stale or duplicate upload; keep the newer snapshot.
		return true
	}
	ans := make([]byte, len(up.Ansi))
	copy(ans, up.Ansi)
	ph.ckpt = &paneCheckpoint{Through: up.Through, Cols: up.Cols, Rows: up.Rows, Ansi: ans}
	return true
}

// Unregister removes a client from a pane and drops it from the auth fence.
func (h *Hub) Unregister(paneID string, client *Client) {
	h.auth.forget(client.Ws)
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	ph.mu.Lock()
	if _, ok := ph.clients[client]; ok {
		delete(ph.clients, client)
		close(client.Send)
	}
	ph.mu.Unlock()
	log.Printf("[ws] Unregistered client from pane %s", paneID)
}

// Close stops the sweep worker, marks every owned journal closed, releases
// every owned recording handle, and releases the namespace lease without
// deleting it. Ephemeral journals are deleted. The closure mark keeps a
// clean shutdown from reopening with a spurious incomplete-history
// warning. A hub must not be used after Close; a restart test closes
// the first hub before the second opens the same namespace. Close is
// idempotent.
func (h *Hub) Close() error {
	h.mu.Lock()
	started, done := h.sweepStarted, h.sweepDone
	h.sweepStarted = false
	h.sweepDone = nil
	h.mu.Unlock()
	if started {
		close(done)
		h.sweepWg.Wait()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	var errs []error
	closeJournals := func(panes map[string]*PaneHub) {
		for paneID, ph := range panes {
			ph.mu.Lock()
			if ph.recording != nil {
				errs = append(errs, ph.recording.close())
			}
			if ph.journal != nil && !ph.journal.closed {
				h.markPaneClosedLocked(ph, paneID, h.wallClock().UnixNano())
				errs = append(errs, ph.journal.close())
			}
			ph.mu.Unlock()
		}
	}
	closeJournals(h.panes)
	closeJournals(h.archives)
	if h.leaseFile != nil {
		errs = append(errs, h.leaseFile.Close())
		h.leaseFile = nil
		h.leaseHeld = false
	}
	return errors.Join(errs...)
}

func (h *Hub) ClosePane(paneID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closePaneLocked(paneID)
}

// closePaneLocked is shared by explicit close and the owner-guarded exit.
// The caller holds h.mu.
// markPaneClosedLocked records the pane's closure in its journal. The
// caller holds h.mu and ph.mu. A failed closure persist keeps the last
// committed bytes; the reopening warns instead of hiding the gap.
func (h *Hub) markPaneClosedLocked(ph *PaneHub, paneID string, closedAt int64) {
	if ph.journal == nil || ph.journal.readOnly || ph.journal.flags&rawFlagClosed != 0 {
		return
	}
	if err := ph.journal.markClosed(closedAt); err != nil {
		log.Printf("[ws] pane %s: could not record its closure: %v", paneID, err)
	}
}

func (h *Hub) closePaneLocked(paneID string) {
	if ph := h.panes[paneID]; ph != nil {
		ph.mu.Lock()
		for client := range ph.clients {
			delete(ph.clients, client)
			close(client.Send)
		}
		ph.Ring = nil
		ph.ckpt = nil
		if ph.state != nil {
			_ = ph.state.Close()
			ph.state = nil
			ph.stateHead = 0
		}
		closedAt := h.wallClock().UnixNano()
		ph.closedAtUnixNano = closedAt
		h.markPaneClosedLocked(ph, paneID, closedAt)
		h.archives[paneID] = ph
		ph.mu.Unlock()
	}
	delete(h.panes, paneID)
	log.Printf("[ws] Closed pane %s; cold recording retained", paneID)
}

// notePaneOwner records the current read-loop owner for a pane ID.
// StartPTYReadLoop calls this synchronously before its goroutine starts,
// so a replacement owner is visible before any new attach or ingest.
func (h *Hub) notePaneOwner(inst *pty.PTYInstance) {
	if h == nil || inst == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.paneOwners == nil {
		h.paneOwners = make(map[string]*pty.PTYInstance)
	}
	h.paneOwners[inst.ID] = inst
}

// exitPaneForOwner runs the full PTY exit cleanup (exit broadcast, pane
// close, exit hook) only when inst still owns its pane ID. A delayed old
// read loop after a same-ID retry returns false without touching the
// replacement's clients, history, or lease hook. The owner check,
// broadcast, and close hold h.mu so a concurrent replacement cannot
// interleave new attach/ingest between the check and the close.
func (h *Hub) exitPaneForOwner(inst *pty.PTYInstance, code int) bool {
	if h == nil || inst == nil {
		return false
	}
	h.mu.Lock()
	if h.paneOwners[inst.ID] != inst {
		h.mu.Unlock()
		return false
	}
	delete(h.paneOwners, inst.ID)
	if ph := h.panes[inst.ID]; ph != nil {
		// Marshal before locking: a failure skips the broadcast, but the
		// pane below still closes and the hook still fires.
		msg, err := wireproto.EncodeExitFrame(int32(code))
		if err != nil {
			log.Printf("[ws] pane %s: exit encode error: %v", inst.ID, err)
		} else {
			ph.mu.Lock()
			// The closure commits before the exit broadcast: a client
			// that replays on exit reads the closed history.
			h.markPaneClosedLocked(ph, inst.ID, h.wallClock().UnixNano())
			for client := range ph.clients {
				h.deliverPaneFrame(ph, client, msg)
			}
			ph.mu.Unlock()
		}
	}
	h.closePaneLocked(inst.ID)
	h.mu.Unlock()
	h.notifyPaneExit(inst, code)
	return true
}

// deliverOrClose pushes msg to a bridge-managed attachment. A full send
// queue closes the socket instead of evicting queued frames: the client
// reconnects and the attach snapshot replays the latest bridge state, so
// a queued control frame survives the congestion.
func (h *Hub) deliverOrClose(client *Client, msg []byte) {
	select {
	case client.Send <- msg:
		client.FullSince = time.Time{}
	default:
		client.logger().Warn("ws send queue full; closing for reconnect")
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
	}
}

// deliverOrDrop pushes msg to client's Send channel. If the channel is
// full, it drops the oldest queued frame(s) to make room (bounded to
// 100), injects a one-shot 5s-rate-limited "[phi: output dropped]" warning,
// and keeps the connection alive. Only after 30s of sustained fullness
// does it close the connection as a last resort. The PaneHub mu must be
// held when calling this (caller-side invariant: see Ingest/Broadcast).
func (h *Hub) deliverOrDrop(client *Client, msg []byte) {
	select {
	case client.Send <- msg:
		client.FullSince = time.Time{}
		return
	default:
	}

	now := time.Now()
	if client.FullSince.IsZero() {
		client.FullSince = now
	} else if now.Sub(client.FullSince) > 30*time.Second {
		client.logger().Warn("ws send buffer full for 30s+, closing connection")
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}

	dropped := 0
	for dropped < 100 {
		select {
		case <-client.Send:
			dropped++
		default:
		}
		select {
		case client.Send <- msg:
			client.FullSince = time.Time{}
			if dropped > 0 {
				client.logger().Warn("ws dropped stale frames for slow client, kept connection alive", "dropped", dropped)
			}
			return
		default:
			dropped++
		}
	}

	// Could not reclaim space in 100 drops: log and move on, will retry next tick.
	client.logger().Warn("ws send buffer still full after 100 drops, deferring frame")
	h.injectDropWarning(client, now)
}

// injectDropWarning delivers the rate-limited slow-client notice as a
// protobuf drop frame. It renders beside the byte stream, so sequence
// accounting is untouched.
func (h *Hub) injectDropWarning(client *Client, now time.Time) {
	if now.Sub(client.LastDropWarning) <= 5*time.Second {
		return
	}
	client.LastDropWarning = now
	warn, err := wireproto.EncodeDropNoticeFrame()
	if err != nil {
		return
	}
	select {
	case client.Send <- warn:
	default:
	}
}

func (h *Hub) Ingest(paneID string, payload []byte) error {
	persistent := h.recordingEnabled()
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		return err
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// Begin parsing at the pane's first output. New sessions never replay
	// their recording on attach; the recording remains the byte authority.
	if persistent && ph.state == nil && ph.stateErr == nil {
		if err := ph.prepareStateLocked(); err != nil && !errors.Is(err, errStateBaseUnavailable) {
			ph.stateErr = err
		}
	}

	// Commit to the authoritative journal before publishing a frontier or
	// admitting the bytes to the cache/live stream. A storage failure must
	// backpressure the PTY reader, not silently drop output.
	if err := h.ensurePaneJournalLocked(paneID, ph); err != nil {
		return err
	}
	// The journal resolves a commit-after-OS-step resize before the
	// payload, so no hub-level pending resize outlives this call.
	applied, err := ph.journal.appendPayload(payload)
	// A committed marker stays committed when its payload fails: adopt
	// it for the live parser and publish it before returning the error,
	// or live clients hold a stale grid until the next resize.
	for _, m := range applied {
		ph.applyResizeToParserLocked(m.ResizeMarker)
		h.publishGeometryLocked(ph, paneID, m)
	}
	if err != nil {
		return err
	}
	start := ph.total
	if ph.state != nil {
		if err := ph.state.Feed(payload); err != nil {
			_ = ph.state.Close()
			ph.state = nil
			ph.stateHead = 0
			ph.stateErr = err
		} else {
			ph.stateHead = start + uint64(len(payload))
		}
	}
	if ph.Ring != nil {
		ph.Ring.Write(payload)
	}
	ph.total = ph.journal.head

	// 2. Broadcast to clients as one sequenced protobuf output frame. The
	// bytes above are already committed: an encode failure must not become
	// a durability error that retries them, so live clients miss this span
	// and recover it through the recording on reattach.
	var outMsg []byte
	for client := range ph.clients {
		if outMsg == nil {
			var err error
			if outMsg, err = wireproto.EncodeOutputFrame(start, payload); err != nil {
				componentLogger().With("pane", paneID).Error("terminal output encode failed; live clients must reattach", "err", err)
				return nil
			}
		}
		h.deliverPaneFrame(ph, client, outMsg)
	}
	return nil
}

// deliverPaneFrame pushes one frame to a client of ph. Bridge-managed
// panes close a full client instead of evicting queued frames, so PTY
// output cannot drop an already queued bridge control.
func (h *Hub) deliverPaneFrame(ph *PaneHub, client *Client, msg []byte) {
	if ph.bridgeManaged {
		h.deliverOrClose(client, msg)
		return
	}
	h.deliverOrDrop(client, msg)
}

// BroadcastFrame pushes one pre-encoded frame to every client of a pane
// through the standard pane delivery policy (close-on-full for
// bridge-managed panes, drop-oldest otherwise). Terminal core paths use
// it for protobuf frames; the M2 notification cutover moves the
// remaining byte-prefix producers here.
func (h *Hub) BroadcastFrame(paneID string, msg []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverPaneFrame(ph, client, msg)
	}
}

// BroadcastBridgeFrame pushes one pre-encoded Pi-bridge frame to every
// client of a pane. A full client is closed instead of evicting queued
// frames: the client reconnects and the bridge attach snapshot replays
// the latest view, so a qualifying observed settlement is never silently
// lost to congestion.
func (h *Hub) BroadcastBridgeFrame(paneID string, msg []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverOrClose(client, msg)
	}
}

// BroadcastNotification pushes one shared notification to every client
// of every pane. Each required envelope is encoded once: the synthetic
// @events group receives the bare Notification, every other group
// receives the TerminalServerFrame wrapper. Best-effort: full client
// send channels drop the frame rather than block (same contract as
// BroadcastShutdown, which now delegates here).
func (h *Hub) BroadcastNotification(n *wspb.Notification) {
	eventsMsg, err := wireproto.EncodeNotification(n)
	if err != nil {
		componentLogger().Error("notification encode failed", "err", err)
		return
	}
	paneMsg, err := wireproto.EncodeNotificationFrame(n)
	if err != nil {
		componentLogger().Error("notification frame encode failed", "err", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for paneID, ph := range h.panes {
		msg := paneMsg
		if paneID == EventsPaneID {
			msg = eventsMsg
		}
		ph.mu.Lock()
		for client := range ph.clients {
			select {
			case client.Send <- msg:
			default:
			}
		}
		ph.mu.Unlock()
	}
}

// BroadcastShutdown announces server shutdown to every connected client.
// The payload is the Notification.shutdown envelope with reason
// "restart"|"update"|"shutdown" per WS protocol v2 §3.1, so the UI can
// render a distinct state and arm the post-restart auto-reload poller.
// Best-effort: if a client's send channel is full the message is dropped
// silently rather than blocking the shutdown path.
func (h *Hub) BroadcastShutdown(reason string) {
	if reason == "" {
		reason = "shutdown"
	}
	h.BroadcastNotification(&wspb.Notification{
		Kind: &wspb.Notification_Shutdown{Shutdown: &wspb.ServerShutdown{
			Reason: proto.String(reason),
		}},
	})
}

// PaneStats returns (client count, ring bytes used, ring capacity) for
// a given pane. Returns (0,0,0) if the pane is unknown. Used by the
// /api/diag endpoint.
func (h *Hub) PaneStats(paneID string) (int, int, int) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()
	if !exists {
		return 0, 0, 0
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	clients := len(ph.clients)
	var used, cap int
	if ph.Ring != nil {
		used, cap = ph.Ring.Stats()
	}
	return clients, used, cap
}
