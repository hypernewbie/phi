package ws

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
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
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
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

	// Hot marks a hot-v1 terminal-protocol attachment (term_proto=hot-v1
	// on /ws/pane). Hot clients receive 0x08 ATTACH_HEAD at attach and
	// 0x09 LIVE_OUTPUT frames thereafter, instead of the legacy 1 MiB
	// replay + 0x01 frames.
	Hot         bool
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

	// bridgeAttach encodes an optional Pi-bridge snapshot control frame
	// for an attaching client. bridgeExit observes pane death with the
	// exit code. Both are set once before serving; nil disables them.
	bridgeAttach func(snapshot pty.PTYInstanceSnapshot) []byte
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
// HandleWS sends one encoded frame per attach; nil payload sends nothing.
// Set once before serving.
func (h *Hub) SetBridgeAttach(fn func(snapshot pty.PTYInstanceSnapshot) []byte) {
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
	for _, p := range []string{dir, filepath.Join(dir, "v2")} {
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
	// Bounded retention groups live in a versioned namespace below the
	// recording directory. Legacy journals stay untouched beside it.
	if err := os.MkdirAll(filepath.Join(dir, "v2"), 0700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Join(dir, "v2"), 0700); err != nil {
		return err
	}
	h.recordingDirectory = dir
	leasePath := filepath.Join(dir, "v2", "lease")
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
	return filepath.Join(h.recordingDirectory, "v2", fmt.Sprintf("%x", sha256.Sum256([]byte(paneID))))
}

func (h *Hub) SetReplayBufferBytes(bytes int) {
	h.mu.Lock()
	h.replayBufferBytes = bytes
	h.mu.Unlock()
}

// GetOrCreatePaneHub resolves the live owner for a pane, adopting an
// eligible legacy journal first. An eligible source the importer cannot
// adopt fails here: the caller gets no hub and no fresh authority is
// published over the unreadable history.
func (h *Hub) GetOrCreatePaneHub(paneID string) (*PaneHub, error) {
	for {
		h.mu.Lock()
		_, exists := h.panes[paneID]
		needAdopt := false
		if !exists && h.archives[paneID] == nil {
			if path := h.recordingPath(paneID); path != "" {
				if _, err := os.Stat(path); os.IsNotExist(err) {
					if _, err := os.Stat(h.legacyRecordingPath(paneID)); err == nil {
						needAdopt = true
					}
				}
			}
		}
		h.mu.Unlock()
		if !needAdopt {
			break
		}
		adopted, err := h.importLegacyGroup(paneID)
		if err != nil {
			return nil, err
		}
		if !adopted {
			// Ineligible (or won by a racer): the resolve below
			// promotes the adoption or creates a fresh pane.
			break
		}
	}
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
			ph.recording, ph.recordingErr = openRetentionGroup(h.recordingPath(paneID))
		}
		h.takeGroupClock(ph.recording)
		ph.mu.Lock()
		defer ph.mu.Unlock()
		ph.closedAtUnixNano = 0
		if ph.recording != nil && !ph.recording.isClosed() {
			_ = ph.recording.markOpen()
		}
		ph.Ring = ring
		ph.epoch = randomEpoch()
		if ph.recording != nil && !ph.recording.isClosed() {
			ph.total = ph.recording.head
			if ring != nil {
				from := ph.recording.floor()
				if ph.total > uint64(h.replayBufferBytes) {
					if back := ph.total - uint64(h.replayBufferBytes); back > from {
						from = back
					}
				}
				data, _, err := ph.recording.read(from, ph.total)
				if err == nil {
					ring.Write(data)
				}
			}
		}
		h.panes[paneID] = ph
	}
	return ph, nil
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
	if ph.recording != nil && !ph.recording.isClosed() {
		return PanePosition{Epoch: ph.epoch, Oldest: ph.recording.floor(), Head: ph.total}
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

// attachHeadJSON is the JSON header carried by the 0x08 ATTACH_HEAD frame
// and by the /recording HTTP response. In ATTACH_HEAD, Checkpoint is nil
// unless a usable client snapshot exists, in which case the raw ANSI bytes
// follow the JSON header in the same frame.
type attachHeadJSON = wireproto.AttachHeadHeader

type checkpointJSON = wireproto.CheckpointHeader

// RecordingHeaderJSON is the header of the /recording HTTP response; raw
// bytes follow it in the body, exactly as with ATTACH_HEAD.
type RecordingHeaderJSON = wireproto.RecordingHeader

// frameFramedJSON builds [msgType][u32 jsonLen BE][json bytes][extra bytes].
func frameFramedJSON(msgType byte, v any, extra []byte) []byte {
	j, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	frame := make([]byte, 1+4+len(j)+len(extra))
	frame[0] = msgType
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(j)))
	copy(frame[5:], j)
	copy(frame[5+len(j):], extra)
	return frame
}

// AttachHot registers a hot-v1 client and enqueues its 0x08 ATTACH_HEAD
// frame. Registration and the head capture happen under the pane lock, so
// the client is guaranteed to receive every 0x09 LIVE_OUTPUT frame with
// startSeq >= Head: the boundary is atomic, no gap, no duplication.
// Nothing from before Head is pushed — history stays off the live path.
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

	hdr := attachHeadJSON{Epoch: pos.Epoch, Oldest: pos.Oldest, Head: pos.Head}
	var extra []byte
	if client.NativeState || client.AnsiState {
		if err := ph.prepareStateLocked(); err != nil {
			ph.mu.Unlock()
			if client.Ws != nil {
				_ = client.Ws.Close()
			}
			return
		}
		var snapshot []byte
		var err error
		if client.NativeState {
			snapshot, err = ph.state.ReadyWindow(256)
		} else {
			var screen, continuation []byte
			screen, err = ph.state.FormatVTState()
			if err == nil {
				continuation, err = ph.state.Continuation()
			}
			snapshot = append(screen, continuation...)
		}
		if err != nil {
			ph.mu.Unlock()
			if client.Ws != nil {
				_ = client.Ws.Close()
			}
			return
		}
		cols, rows := ph.state.Geometry()
		kind := "ghostty-ready-v1"
		if client.AnsiState {
			kind = "ansi-v1"
		}
		if len(snapshot) > MaxCheckpointBytes {
			ph.mu.Unlock()
			if client.Ws != nil {
				_ = client.Ws.Close()
			}
			return
		}
		hdr.Ckpt = &checkpointJSON{Through: pos.Head, Cols: uint16(cols), Rows: uint16(rows), Len: len(snapshot), Kind: kind}
		if ph.recording != nil && !ph.recording.isClosed() {
			if _, _, endOrdinal, rerr := ph.recording.readOrd(pos.Head, pos.Head, 0, false); rerr == nil {
				hdr.Ckpt.EventCursor = EncodeEventCursor(pos.Epoch, pos.Head, endOrdinal)
			}
		}
		extra = snapshot
	} else if ph.ckpt != nil && ph.ckpt.Through <= pos.Head && ph.ckpt.Through >= pos.Oldest {
		// A stored checkpoint below the retention floor is unusable: clients
		// validate checkpoint.through >= oldest and close on the mismatch.
		// Drop it here so every client sees a consistent head.
		hdr.Ckpt = &checkpointJSON{
			Through: ph.ckpt.Through,
			Cols:    ph.ckpt.Cols,
			Rows:    ph.ckpt.Rows,
			Len:     len(ph.ckpt.Ansi),
		}
		extra = ph.ckpt.Ansi
	}
	if hdr.Ckpt == nil && ph.recording != nil && !ph.recording.isClosed() {
		hdr.ReplayFrom = ph.recording.replayStart()
	}
	frame := frameFramedJSON(0x08, hdr, extra)
	if frame != nil {
		client.Send <- frame
	}

	client.Hot = true
	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered hot-v1 client for pane %s (epoch %d, head %d, live-only)", paneID, pos.Epoch, pos.Head)
}

// RecordResize notes a backend resize at the pane's current head seq.
// Called from ReadPump when the client resizes; the marker orders resizes
// against output for archive replay. Idempotent for consecutive
// same-size resizes (TUI redraw nudges) to keep the ring small.
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
	// Opening includes journal recovery. Serialize it with every other
	// opener and publish exactly one owner before any writer can append.
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
	if _, err := os.Stat(path); err == nil {
		recording, err := openRetentionGroup(path)
		if err != nil {
			h.mu.Unlock()
			return nil
		}
		h.takeGroupClock(recording)
		ph = &PaneHub{
			clients:   make(map[*Client]bool),
			recording: recording,
			epoch:     randomEpoch(),
			total:     recording.head,
		}
		h.archives[paneID] = ph
		h.mu.Unlock()
		return ph
	}
	h.mu.Unlock()
	// No versioned group: a legacy import does parser work and must
	// not hold the hub lock. A failed eligible import reads as absent
	// (no fresh authority), never as empty history.
	if _, err := h.importLegacyGroup(paneID); err != nil {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	if ph = h.panes[paneID]; ph != nil {
		return ph
	}
	return h.archives[paneID]
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

func (h *Hub) AttachWithReplay(paneID string, client *Client) {
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		log.Printf("[ws] attach pane %s: %v", paneID, err)
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// 1. Snapshot and replay history
	if ph.Ring != nil {
		snap := ph.Ring.Snapshot()
		if len(snap) > 0 {
			const chunkSize = 32 * 1024
			for i := 0; i < len(snap); i += chunkSize {
				end := i + chunkSize
				if end > len(snap) {
					end = len(snap)
				}
				chunk := snap[i:end]
				frame := make([]byte, len(chunk)+1)
				frame[0] = 0x01 // PTY Output Stdout
				copy(frame[1:], chunk)
				client.Send <- frame
			}
		}
	}

	// 2. Send 0x06 replay-complete frame
	client.Send <- []byte{0x06}

	// 3. Register for live updates
	ph.clients[client] = true
	log.Printf("[ws] Registered client for pane %s (with history replay)", paneID)
}

func (h *Hub) Unregister(paneID string, client *Client) {
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

// CloseAllClients closes every live WebSocket without deleting pane state.
// Callers use this when a security boundary changes (for example, Phi access
// password rotation) so connections authorized at handshake cannot outlive
// the session that authorized them. ReadPump performs normal unregistering.
func (h *Hub) CloseAllClients() {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var clients []*Client
	for _, ph := range h.panes {
		ph.mu.Lock()
		for client := range ph.clients {
			clients = append(clients, client)
		}
		ph.mu.Unlock()
	}
	for _, client := range clients {
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
	}
}

// Close stops the sweep worker, releases every owned recording handle,
// and releases the namespace lease without deleting it. Ephemeral groups
// are deleted. A hub must not be used after Close; a restart test closes
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
	for _, ph := range h.panes {
		ph.mu.Lock()
		if ph.recording != nil {
			errs = append(errs, ph.recording.close())
		}
		ph.mu.Unlock()
	}
	for _, ph := range h.archives {
		ph.mu.Lock()
		if ph.recording != nil {
			errs = append(errs, ph.recording.close())
		}
		ph.mu.Unlock()
	}
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
		if ph.recording != nil && !ph.recording.isClosed() {
			// A failed closure persist falls back to the last-update
			// clock, which the last commit already recorded.
			_ = ph.recording.markClosed(closedAt)
		}
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
		payload := []byte(fmt.Sprintf(`{"code":%d}`, code))
		msg := make([]byte, len(payload)+1)
		msg[0] = 0x04
		copy(msg[1:], payload)
		ph.mu.Lock()
		for client := range ph.clients {
			h.deliverPaneFrame(ph, client, msg)
		}
		ph.mu.Unlock()
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

// injectDropWarning delivers the rate-limited slow-client notice. Hot
// clients account for every byte by seq, so injecting warning text into
// the 0x09 stream would corrupt that accounting — they get a 0x02
// control frame the client renders itself, off the byte stream. Legacy
// clients keep the historical inline 0x01 text.
func (h *Hub) injectDropWarning(client *Client, now time.Time) {
	if now.Sub(client.LastDropWarning) <= 5*time.Second {
		return
	}
	client.LastDropWarning = now
	if client.Hot {
		payload, _ := json.Marshal(map[string]string{"type": "output-dropped"})
		warnCtl := append([]byte{0x02}, payload...)
		if warnCtl != nil {
			select {
			case client.Send <- warnCtl:
			default:
			}
		}
		return
	}
	warningStr := "\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n"
	warningMsg := make([]byte, 1+len(warningStr))
	warningMsg[0] = 0x01
	copy(warningMsg[1:], warningStr)
	select {
	case client.Send <- warningMsg:
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
	if ph.recording == nil {
		ph.recording, ph.recordingErr = openRetentionGroup(h.recordingPath(paneID))
		if ph.recordingErr != nil {
			return ph.recordingErr
		}
		h.takeGroupClock(ph.recording)
		ph.total = ph.recording.head
	} else if ph.recording.isClosed() {
		return fmt.Errorf("pane recording closed")
	}
	payloadAdmitted := false
	if ph.pendingResize != nil {
		// A durability-failed payload resolves before the queued
		// resize: appendResize refuses while a payload is staged, so
		// retrying the resize first would wedge behind it forever.
		// The resize then waits one Ingest; its AtSeq is recomputed
		// from the advanced head on the next call.
		if resolved, err := ph.recording.resolvePendingPayload(payload); err != nil {
			return err
		} else if resolved {
			payloadAdmitted = true
			ph.total = ph.recording.head - uint64(len(payload))
		} else if err := ph.appendResizeLocked(*ph.pendingResize); err != nil {
			return err
		}
	}
	var applied []ResizeMarker
	if !payloadAdmitted {
		var err error
		applied, err = ph.recording.appendPayload(payload, ph.snapshotBaseLocked)
		if err != nil {
			return err
		}
	}
	start := ph.total
	for _, m := range applied {
		ph.applyResizeToParserLocked(m)
	}
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
	ph.total = ph.recording.head

	// 2. Broadcast to clients. Hot clients receive 0x09 LIVE_OUTPUT frames
	// with the seq prefix; legacy clients keep the bare 0x01 replay framing
	// so old cached pages keep working during migration.
	var legacyMsg, hotMsg []byte
	for client := range ph.clients {
		if client.Hot {
			if hotMsg == nil {
				hotMsg = make([]byte, 9+len(payload))
				hotMsg[0] = 0x09
				binary.BigEndian.PutUint64(hotMsg[1:9], start)
				copy(hotMsg[9:], payload)
			}
			h.deliverPaneFrame(ph, client, hotMsg)
		} else {
			if legacyMsg == nil {
				legacyMsg = make([]byte, len(payload)+1)
				legacyMsg[0] = 0x01
				copy(legacyMsg[1:], payload)
			}
			h.deliverPaneFrame(ph, client, legacyMsg)
		}
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

func (h *Hub) Broadcast(paneID string, msgType byte, payload []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	msg := make([]byte, len(payload)+1)
	msg[0] = msgType
	copy(msg[1:], payload)

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverPaneFrame(ph, client, msg)
	}
}

// BroadcastBridge pushes one Pi-bridge control frame (0x02) to every
// client of a pane. Unlike Broadcast, a full client is closed instead
// of evicting queued frames: the client reconnects and the bridge
// attach snapshot replays the latest settlement, so a qualifying
// observed settlement is never silently lost to congestion.
func (h *Hub) BroadcastBridge(paneID string, payload []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	msg := make([]byte, len(payload)+1)
	msg[0] = 0x02
	copy(msg[1:], payload)

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverOrClose(client, msg)
	}
}

// BroadcastAll pushes a typed frame to every client of every pane.
// Best-effort: full client send channels drop the frame rather than
// block (same contract as BroadcastShutdown, which now delegates here).
func (h *Hub) BroadcastAll(msgType byte, payload []byte) {
	msg := make([]byte, 1+len(payload))
	msg[0] = msgType
	copy(msg[1:], payload)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, ph := range h.panes {
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
// The payload is the JSON envelope {"reason":"restart"|"update"|"shutdown"}
// per WS protocol v2 §3.1, so the UI can render a distinct state and arm
// the post-restart auto-reload poller. Best-effort: if a client's send
// channel is full the message is dropped silently rather than blocking
// the shutdown path.
func (h *Hub) BroadcastShutdown(reason string) {
	if reason == "" {
		reason = "shutdown"
	}
	payload := []byte(fmt.Sprintf(`{"reason":%q}`, reason))
	h.BroadcastAll(0x05, payload)
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
