package ws

import (
	"context"
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
	"sync/atomic"
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

	// refreshPending marks one in-flight Pi repaint for this attachment.
	// A second refresh request while it is set is refused with NOT_SENT,
	// never queued: one repaint in flight per socket.
	refreshPending atomic.Bool
	pane           *PaneHub // exact registration, including archived/replaced panes
	terminal       bool
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

	// win is the RAM-only retained-output authority: every admitted byte
	// is written here and nothing is written to disk. The legacy journal
	// and retention group below stay referenceable for file-format tests
	// only; no production entrypoint opens or reads them.
	win *replayWindow

	// owner is the current read-loop owner. A restore retry reuses the
	// pane ID with a new instance, which resets the window and epoch.
	owner *pty.PTYInstance

	// retired marks history released by expiry. A late reader or attach
	// gets no history instead of reading released storage.
	retired bool

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
	// terminalRefresh dispatches one Pi repaint for a refresh-marked
	// resize; terminalRefreshHint is its advisory attach hint. Both are
	// set once before serving. A nil dispatcher answers NOT_SENT, and a
	// nil hint advertises no repaint.
	terminalRefresh     TerminalRefreshDispatch
	terminalRefreshHint func(paneID string) bool
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
	closed            bool
	closeDone         chan struct{}
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

// TerminalRefreshDispatch reports one Pi repaint attempt. It runs outside
// every pane lock and outside the connection read loop, so typing and
// pongs continue while the reply is pending. The outcome and reason use
// the terminal receipt vocabulary.
//
// Because a nil-safety rule applies to every bridge feature, a nil
// dispatcher must leave plain resize behavior untouched.
type TerminalRefreshDispatch func(ctx context.Context, paneID string, inst *pty.PTYInstance) (wspb.TerminalRefreshOutcome, string)

// SetTerminalRefresh registers the Pi repaint dispatcher and its advisory
// availability hint. Set once before serving.
func (h *Hub) SetTerminalRefresh(dispatch TerminalRefreshDispatch, hint func(paneID string) bool) {
	h.terminalRefresh = dispatch
	h.terminalRefreshHint = hint
}

// terminalRefreshReason keeps the wire vocabulary fixed. A host that
// invents a reason never reaches a client verbatim.
func terminalRefreshReason(reason string) string {
	switch reason {
	case "", "unavailable", "pending", "stale", "queue-full", "resize-failed", "error":
		return reason
	default:
		return "error"
	}
}

// deliverRefreshReceipt sends one repaint receipt to the requesting
// socket only. Holding the pane lock keeps registration stable across the
// check and the send; the send itself never blocks.
func (h *Hub) deliverRefreshReceipt(ph *PaneHub, client *Client, requestID string, outcome wspb.TerminalRefreshOutcome, reason string) {
	frame, err := wireproto.EncodeRefreshResultFrame(requestID, outcome, terminalRefreshReason(reason))
	if err != nil {
		return
	}
	if ph == nil {
		// Without the pane's registration lock there is no safe way to know
		// whether teardown already closed Send. A detached requester cannot
		// receive this receipt anyway, so drop it instead of risking a panic.
		return
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if !ph.clients[client] {
		return
	}
	h.deliverOrClose(client, frame)
}

// dispatchTerminalRefresh runs one repaint for a refresh-marked resize
// that already committed. At most one repaint is in flight per socket: an
// excess request is answered NOT_SENT/pending instead of queueing. The
// dispatcher may take seconds, so it never runs on the read loop.
func (h *Hub) dispatchTerminalRefresh(paneID string, inst *pty.PTYInstance, client *Client, requestID string) {
	ph, ok := h.LookupPane(paneID)
	if !ok {
		h.deliverRefreshReceipt(nil, client, requestID, wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "unavailable")
		return
	}
	if !client.refreshPending.CompareAndSwap(false, true) {
		h.deliverRefreshReceipt(ph, client, requestID, wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "pending")
		return
	}
	dispatch := h.terminalRefresh
	if dispatch == nil {
		client.refreshPending.Store(false)
		h.deliverRefreshReceipt(ph, client, requestID, wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "unavailable")
		return
	}
	go func() {
		defer client.refreshPending.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), terminalRefreshDispatchWait)
		defer cancel()
		outcome, reason := dispatch(ctx, paneID, inst)
		h.deliverRefreshReceipt(ph, client, requestID, outcome, reason)
	}()
}

// terminalRefreshDispatchWait bounds one repaint end to end. The host
// receipt has its own one-second IPC deadline; this outer bound also
// covers pane lookup and encoding.
const terminalRefreshDispatchWait = 3 * time.Second

// maxRefreshRequestIDBytes bounds one repaint correlation ID.
const maxRefreshRequestIDBytes = 64

// dispatchTerminalRefreshFailure answers a repaint request whose resize
// never committed. Nothing reached the host, so it is NOT_SENT.
func (h *Hub) dispatchTerminalRefreshFailure(paneID string, client *Client, requestID string) {
	ph, ok := h.LookupPane(paneID)
	if !ok {
		ph = nil
	}
	h.deliverRefreshReceipt(ph, client, requestID, wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT, "resize-failed")
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

// SetReplayBufferBytes changes the retained-byte capacity used for new
// panes. The value is clamped to the hard 32 MiB ceiling; nonpositive
// values disable retention.
func (h *Hub) SetReplayBufferBytes(bytes int) {
	if bytes > replayWindowMaxBytes {
		bytes = replayWindowMaxBytes
	}
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
	if h.closed {
		return nil, ErrReplayNoHistory
	}
	return h.getOrCreatePaneHubLocked(paneID), nil
}

// getOrCreatePaneHubLocked returns the live pane hub, promoting a closed
// archive so its RAM history stays readable in-process. The caller holds
// h.mu. Production initialization goes through InitPaneForOwner, which
// resets a replacement owner's window and epoch.
func (h *Hub) getOrCreatePaneHubLocked(paneID string) *PaneHub {
	if ph := h.panes[paneID]; ph != nil {
		return ph
	}
	ph := h.archives[paneID]
	if ph != nil {
		delete(h.archives, paneID)
		ph.mu.Lock()
		ph.closedAtUnixNano = 0
		ph.retired = false
		ph.mu.Unlock()
	} else {
		ph = &PaneHub{clients: make(map[*Client]bool)}
		ph.epoch = randomEpoch()
		ph.win = newReplayWindow(h.replayBufferBytes, 0, 0)
	}
	h.panes[paneID] = ph
	return ph
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

// InitPaneJournal is the RAM-only compatibility initializer: it stores
// the spawn geometry and creates the pane's retained window. Production
// spawn and restore use InitPaneForOwner, which also binds the owner.
// Idempotent; it never opens a journal.
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
	ph.initCols, ph.initRows = cols, rows
	ph.bindGeometryLocked(h.replayBufferBytes, cols, rows)
	return nil
}

// bindGeometryLocked seeds a window that has never produced output.
func (ph *PaneHub) bindGeometryLocked(capacity int, cols, rows uint16) {
	if ph.win == nil {
		ph.win = newReplayWindow(capacity, cols, rows)
		return
	}
	if ph.win.head == 0 && len(ph.win.resizes) == 0 && ph.win.baseCols == 0 {
		ph.win.baseCols, ph.win.baseRows = cols, rows
	}
}

// InitPaneForOwner binds a pane to its exact PTY read-loop owner and seeds
// its geometry before any byte is admitted. The owner and geometry bind
// atomically under h.mu then ph.mu, so a delayed initializer cannot bind a
// retired instance.
//
// A repeat call for the same instance is idempotent. A replacement
// instance starts a fresh window and a new epoch: old clients are closed,
// the old owner entry is dropped, and the previous history is released.
func (h *Hub) InitPaneForOwner(inst *pty.PTYInstance) error {
	if inst == nil || inst.Pty == nil {
		return fmt.Errorf("pane owner is nil")
	}
	cols, rows := inst.Pty.Cols, inst.Pty.Rows
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || inst.ReadOwnerRetired() {
		return fmt.Errorf("pane owner retired")
	}
	ph := h.getOrCreatePaneHubLocked(inst.ID)
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.owner == inst {
		ph.bindGeometryLocked(h.replayBufferBytes, cols, rows)
		return nil
	}
	if ph.owner != nil || ph.winHeadLocked() > 0 {
		// A replacement owns a new lifetime, never the old reader's bytes.
		if ph.owner != nil {
			ph.owner.RetireReadOwner()
		}
		for client := range ph.clients {
			delete(ph.clients, client)
			close(client.Send)
		}
		ph.epoch = randomEpoch()
		ph.win = newReplayWindow(h.replayBufferBytes, cols, rows)
		ph.ckpt = nil
		ph.closedAtUnixNano = 0
		ph.retired = false
	}
	ph.owner = inst
	ph.initCols, ph.initRows = cols, rows
	ph.bindGeometryLocked(h.replayBufferBytes, cols, rows)
	h.paneOwners[inst.ID] = inst
	return nil
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
	client.pane = ph
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
	if ph.win == nil {
		return PanePosition{Epoch: ph.epoch}
	}
	return PanePosition{Epoch: ph.epoch, Oldest: ph.win.floor(), Head: ph.win.head}
}

// RecordingHeaderJSON is the header of the /recording HTTP response; raw
// bytes follow it in the body.
type RecordingHeaderJSON = wireproto.RecordingHeader

// AttachHot registers a protobuf client and enqueues its attach frame.
// Registration and the head capture happen under the pane lock, so the
// client is guaranteed to receive every output frame with start >= Head:
// the boundary is atomic, no gap, no duplication. Nothing from before
// Head is pushed — history is served over HTTP from the RAM window.
// It reports false when the attach frame could not be queued.
func (h *Hub) AttachHot(paneID string, client *Client) bool {
	return h.attachHot(paneID, client, nil)
}

func (h *Hub) attachHot(paneID string, client *Client, owner *pty.PTYInstance) bool {
	// A viewer never promotes an archive or renews its closure time.
	ph := h.recordingForRead(paneID)
	var err error
	if ph == nil && owner != nil && owner.IsPtyDead() {
		// A missing ghost archive still gets a finite empty attach + Exit,
		// but viewing it must not recreate retained state or renew expiry.
		ph = &PaneHub{clients: make(map[*Client]bool), epoch: randomEpoch(), win: newReplayWindow(0, 80, 24)}
	} else if ph == nil && (owner == nil || !owner.ReadOwnerRetired()) {
		ph, err = h.GetOrCreatePaneHub(paneID)
	}
	if ph == nil {
		return false
	}
	if err != nil {
		log.Printf("[ws] attach pane %s: %v", paneID, err)
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return false
	}
	// The repaint hint is advisory and read outside the pane lock: a
	// bridge lookup must never wait behind terminal state.
	refreshAvailable := h.terminalRefreshHint != nil && h.terminalRefreshHint(paneID)
	ph.mu.Lock()
	if ph.retired || (owner != nil && owner.Pty != nil && ph.owner != nil && ph.owner != owner) {
		ph.mu.Unlock()
		return false
	}
	pos := ph.positionLocked()
	floorCols, floorRows, headCols, headRows := ph.attachGeometryLocked()

	attach := &wspb.TerminalAttach{
		Epoch:       proto.Uint64(pos.Epoch),
		Oldest:      proto.Uint64(pos.Oldest),
		Head:        proto.Uint64(pos.Head),
		InitialCols: proto.Uint32(uint32(ph.initColsOrDefault())),
		InitialRows: proto.Uint32(uint32(ph.initRowsOrDefault())),
		FloorCols:   proto.Uint32(uint32(floorCols)),
		FloorRows:   proto.Uint32(uint32(floorRows)),
		HeadCols:    proto.Uint32(uint32(headCols)),
		HeadRows:    proto.Uint32(uint32(headRows)),
		EventCursor: proto.String(EncodeEventCursor(pos.Epoch, pos.Head, ph.winOrdinalLocked())),
	}
	if ph.win != nil {
		attach.FloorEventCursor = proto.String(EncodeEventCursor(pos.Epoch, pos.Oldest, ph.win.ordinalAt(pos.Oldest)))
	}
	// Bridge refresh availability is a hint, rechecked at dispatch.
	attach.TerminalRefreshAvailable = proto.Bool(refreshAvailable)

	frame, err := wireproto.EncodeAttachFrame(attach)
	if err != nil {
		ph.mu.Unlock()
		log.Printf("[ws] attach pane %s: encode error: %v", paneID, err)
		return false
	}
	client.pane, client.terminal = ph, true
	ph.clients[client] = true
	select {
	case client.Send <- frame:
	default:
		delete(ph.clients, client)
		ph.mu.Unlock()
		log.Printf("[ws] attach pane %s: send queue full", paneID)
		return false
	}
	ph.mu.Unlock()
	log.Printf("[ws] Registered protobuf client for pane %s (epoch %d, head %d, retained from %d)", paneID, pos.Epoch, pos.Head, pos.Oldest)
	return true
}

// attachGeometryLocked returns floor and head grids for the attach frame.
func (ph *PaneHub) attachGeometryLocked() (floorCols, floorRows, headCols, headRows uint16) {
	if ph.win == nil {
		return ph.initColsOrDefault(), ph.initRowsOrDefault(), ph.initColsOrDefault(), ph.initRowsOrDefault()
	}
	floorCols, floorRows = ph.win.initialGeometry()
	if floorCols == 0 || floorRows == 0 {
		floorCols, floorRows = ph.initColsOrDefault(), ph.initRowsOrDefault()
	}
	headCols, headRows = ph.win.geometryAt(ph.win.head)
	if headCols == 0 || headRows == 0 {
		headCols, headRows = floorCols, floorRows
	}
	return floorCols, floorRows, headCols, headRows
}

// winOrdinalLocked is the newest applied resize ordinal, zero when none.
func (ph *PaneHub) winOrdinalLocked() uint64 {
	if ph.win == nil {
		return 0
	}
	return ph.win.lastOrdinal()
}

// ReplayWindowInfo is the atomic window metadata returned with an expired
// replay response. A client uses it to resume at the certified floor
// without guessing how much history it lost.
type ReplayWindowInfo struct {
	Epoch            uint64 `json:"epoch"`
	Oldest           uint64 `json:"oldest"`
	Head             uint64 `json:"head"`
	FloorCols        uint16 `json:"floor_cols"`
	FloorRows        uint16 `json:"floor_rows"`
	HeadCols         uint16 `json:"head_cols"`
	HeadRows         uint16 `json:"head_rows"`
	FloorEventCursor string `json:"floor_event_cursor,omitempty"`
	EventCursor      string `json:"event_cursor,omitempty"`
}

// ReplayWindow reports the pane's current floor and head with geometry.
// It returns false when the pane has no retained history.
func (h *Hub) ReplayWindow(paneID string) (ReplayWindowInfo, bool) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return ReplayWindowInfo{}, false
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.retired || ph.win == nil {
		return ReplayWindowInfo{}, false
	}
	return ph.replayWindowLocked(), true
}

func (ph *PaneHub) replayWindowLocked() ReplayWindowInfo {
	pos := ph.positionLocked()
	floorCols, floorRows, headCols, headRows := ph.attachGeometryLocked()
	return ReplayWindowInfo{
		Epoch:            pos.Epoch,
		Oldest:           pos.Oldest,
		Head:             pos.Head,
		FloorCols:        floorCols,
		FloorRows:        floorRows,
		HeadCols:         headCols,
		HeadRows:         headRows,
		FloorEventCursor: EncodeEventCursor(pos.Epoch, pos.Oldest, ph.win.ordinalAt(pos.Oldest)),
		EventCursor:      EncodeEventCursor(pos.Epoch, pos.Head, ph.winOrdinalLocked()),
	}
}

// Replay errors map to HTTP statuses at the /replay endpoint: malformed
// requests (400), stale epochs and revealed future fences (409), missing
// history (404), and unavailable storage (503).
var (
	ErrReplayBadRequest  = errors.New("invalid replay request")
	ErrReplayEpoch       = errors.New("replay epoch mismatch")
	ErrReplayFuture      = errors.New("replay fence beyond head")
	ErrReplayNoHistory   = errors.New("no replay history")
	ErrReplayExpired     = errors.New("replay position expired")
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
	Position      *ReplayWindowInfo // captured under the same lock as an expiry refusal
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
	// Floor and head geometry of the pane this page was served from.
	FloorEventCursor string
	FloorCols        uint16
	FloorRows        uint16
	HeadCols         uint16
	HeadRows         uint16
}

// Replay serves one raw replay page from the pane's RAM window. The
// window retains a bounded tail, so a request below its floor is refused
// as expired rather than served under wrong geometry.
func (h *Hub) Replay(paneID string, req ReplayRequest) (ReplayPage, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return ReplayPage{}, ErrReplayNoHistory
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if ph.retired || ph.win == nil {
		return ReplayPage{}, ErrReplayNoHistory
	}
	w := ph.win
	head := w.head
	if req.Epoch != ph.epoch {
		return ReplayPage{}, ErrReplayEpoch
	}
	floor := w.floor()
	expired := func() (ReplayPage, error) {
		info := ph.replayWindowLocked()
		return ReplayPage{Position: &info}, ErrReplayExpired
	}
	if req.From < floor {
		return expired()
	}
	if req.From > head {
		return ReplayPage{}, fmt.Errorf("%w: from past head", ErrReplayBadRequest)
	}
	through := req.Through
	throughOrdinal := w.lastOrdinal()
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
		if through > head || cOrd > w.lastOrdinal() {
			return ReplayPage{}, ErrReplayFuture
		}
		if through < floor || cOrd < w.floorOrd {
			return expired()
		}
		if !w.validFence(through, cOrd) {
			return ReplayPage{}, fmt.Errorf("%w: inconsistent through cursor", ErrReplayBadRequest)
		}
		throughOrdinal = cOrd
	}
	if through > head {
		return ReplayPage{}, ErrReplayFuture
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
	if afterOrdinal < w.floorOrd {
		return expired()
	}
	if afterOrdinal > throughOrdinal || !w.validFence(req.From, afterOrdinal) {
		return ReplayPage{}, fmt.Errorf("%w: inconsistent paging cursor", ErrReplayBadRequest)
	}
	// Stop before a 257th event, even when many share the same byte.
	pageOrdinal := throughOrdinal
	count := 0
	for i, m := range w.resizes {
		ord := w.floorOrd + uint64(i) + 1
		if ord <= afterOrdinal {
			continue
		}
		if ord > throughOrdinal || m.AtSeq > end {
			break
		}
		if count == 256 {
			end, pageOrdinal = m.AtSeq, ord-1
			break
		}
		count++
	}
	data := w.rangeView(req.From, end)
	if uint64(len(data)) != end-req.From {
		if req.From < w.floor() {
			return expired()
		}
		return ReplayPage{}, ErrReplayUnavailable
	}
	finalEnd := req.From + uint64(len(data))
	resizes, endOrdinal := w.markersBetween(req.From, finalEnd, afterOrdinal, pageOrdinal)
	initCols, initRows := w.initialGeometry()
	if initCols == 0 || initRows == 0 {
		initCols, initRows = ph.initColsOrDefault(), ph.initRowsOrDefault()
	}
	headCols, headRows := w.geometryAt(head)
	if headCols == 0 || headRows == 0 {
		headCols, headRows = initCols, initRows
	}
	return ReplayPage{
		Through:          through,
		ThroughCursor:    EncodeEventCursor(ph.epoch, through, throughOrdinal),
		Epoch:            ph.epoch,
		Start:            req.From,
		End:              finalEnd,
		Data:             data,
		Resizes:          resizes,
		EndCursor:        EncodeEventCursor(ph.epoch, finalEnd, endOrdinal),
		InitCols:         initCols,
		InitRows:         initRows,
		Incomplete:       false,
		FloorEventCursor: EncodeEventCursor(ph.epoch, floor, w.ordinalAt(floor)),
		FloorCols:        initCols,
		FloorRows:        initRows,
		HeadCols:         headCols,
		HeadRows:         headRows,
	}, nil
}

func (ph *PaneHub) appendResizeLocked(cols, rows uint16) (ResizeMarker, uint64, bool) {
	if ph.win == nil {
		ph.win = newReplayWindow(0, ph.initColsOrDefault(), ph.initRowsOrDefault())
	}
	return ph.win.appendResize(cols, rows)
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
// Production resizes go through StagePaneResize; this helper exists for
// callers that only need the marker and live geometry frame.
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
		return
	}
	m, ordinal, changed := ph.appendResizeLocked(cols, rows)
	if !changed {
		return
	}
	h.publishGeometryLocked(ph, paneID, m, ordinal)
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
// The caller holds ph.mu.
func (h *Hub) publishGeometryLocked(ph *PaneHub, paneID string, m ResizeMarker, ordinal uint64) {
	frame, err := wireproto.EncodeGeometryFrame(m.AtSeq, uint32(m.Cols), uint32(m.Rows), EncodeEventCursor(ph.epoch, m.AtSeq, ordinal))
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
	return h.stageResizeLocked(ph, paneID, cols, rows)
}

func (h *Hub) stageResizeForOwner(inst *pty.PTYInstance, cols, rows uint16) (func() error, func(), error) {
	h.mu.RLock()
	ph := h.panes[inst.ID]
	if ph == nil {
		h.mu.RUnlock()
		return nil, nil, ErrReplayNoHistory
	}
	ph.mu.Lock()
	h.mu.RUnlock()
	if ph.retired || (ph.owner != nil && ph.owner != inst) {
		ph.mu.Unlock()
		return nil, nil, fmt.Errorf("pane owner replaced")
	}
	return h.stageResizeLocked(ph, inst.ID, cols, rows)
}

// Keep the pane transaction locked through the physical resize. Ingest
// and owner replacement cannot publish bytes under uncommitted geometry.
func (h *Hub) stageResizeLocked(ph *PaneHub, paneID string, cols, rows uint16) (func() error, func(), error) {
	var once sync.Once
	commit := func() error {
		once.Do(func() {
			defer ph.mu.Unlock()
			m, ordinal, changed := ph.appendResizeLocked(cols, rows)
			if changed {
				h.publishGeometryLocked(ph, paneID, m, ordinal)
			}
		})
		return nil
	}
	abort := func() { once.Do(func() { ph.mu.Unlock() }) }
	return commit, abort, nil
}

// winHeadLocked is the next byte position, zero when no window exists.
func (ph *PaneHub) winHeadLocked() uint64 {
	if ph.win == nil {
		return 0
	}
	return ph.win.head
}

// RecordRestoreGeometry records the restored PTY size before new output.
// Unlike a live resize there is no physical step: the PTY already has
// this size. A restored size matching the current geometry records
// nothing.
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
	if ph.pendingResize != nil {
		return fmt.Errorf("terminal resize: another resize is still staged")
	}
	m, ordinal, changed := ph.appendResizeLocked(cols, rows)
	if !changed {
		return nil
	}
	h.publishGeometryLocked(ph, paneID, m, ordinal)
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

// recordingForRead resolves a live or archived pane hub. There is no cold
// open: RAM history exists only in this process, and an unknown pane has
// no history. The returned hub may be retired; its readers check that
// under the pane lock.
func (h *Hub) recordingForRead(paneID string) *PaneHub {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if ph := h.panes[paneID]; ph != nil {
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
	if ph.retired || ph.win == nil {
		return Recording{}, false
	}
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
		end = from
	}
	if end-from > MaxCheckpointBytes {
		end = from + MaxCheckpointBytes
	}
	data := ph.win.rangeView(from, end)
	if uint64(len(data)) != end-from {
		return Recording{}, false
	}
	resizes, endOrdinal := ph.win.markersBetween(from, end, 0, ph.win.lastOrdinal())
	return Recording{
		Epoch:       pos.Epoch,
		Start:       from,
		End:         from + uint64(len(data)),
		Data:        data,
		Resizes:     resizes,
		EventCursor: EncodeEventCursor(pos.Epoch, from+uint64(len(data)), endOrdinal),
	}, true
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
	if ph.retired || ph.win == nil {
		return Recording{}, "", ErrEventCursorExpired
	}

	pos := ph.positionLocked()
	if cursorEpoch != pos.Epoch {
		return Recording{}, "", ErrEventCursorExpired
	}
	if from > pos.Head {
		return Recording{}, "", ErrEventCursorInvalid
	}
	if cursorPos < from || cursorPos < pos.Oldest {
		return Recording{}, "", ErrEventCursorExpired
	}
	if from < pos.Oldest {
		from = pos.Oldest
	}
	end := through
	if end > pos.Head {
		end = pos.Head
	}
	if end < from {
		end = from
	}
	if end-from > MaxCheckpointBytes {
		end = from + MaxCheckpointBytes
	}
	if afterOrdinal > ph.win.lastOrdinal() {
		return Recording{}, "", ErrEventCursorExpired
	}
	data := ph.win.rangeView(from, end)
	if uint64(len(data)) != end-from {
		return Recording{}, "", ErrEventCursorExpired
	}
	resizes, endOrdinal := ph.win.markersBetween(from, end, afterOrdinal, ph.win.lastOrdinal())
	endCursor := EncodeEventCursor(pos.Epoch, from+uint64(len(data)), endOrdinal)
	return Recording{
		Epoch:       pos.Epoch,
		Start:       from,
		End:         from + uint64(len(data)),
		Data:        data,
		Resizes:     resizes,
		EventCursor: endCursor,
	}, endCursor, nil
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
	ph := client.pane
	if ph == nil {
		ph = h.recordingForRead(paneID)
	}
	if ph == nil {
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
	if h.closed {
		done := h.closeDone
		h.mu.Unlock()
		<-done
		return nil
	}
	h.closed = true
	h.closeDone = make(chan struct{})
	defer close(h.closeDone)
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
			ph.retired = true
			for c := range ph.clients {
				delete(ph.clients, c)
				close(c.Send)
			}
			ph.win, ph.Ring, ph.ckpt = nil, nil, nil
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
	clear(h.panes)
	clear(h.archives)
	clear(h.paneOwners)
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
		ph.ckpt = nil
		if ph.state != nil {
			_ = ph.state.Close()
			ph.state = nil
			ph.stateHead = 0
		}
		// The RAM window stays with the archive so same-process closed
		// history remains replayable until expiry.
		ph.closedAtUnixNano = h.wallClock().UnixNano()
		h.archives[paneID] = ph
		ph.mu.Unlock()
	}
	delete(h.panes, paneID)
	log.Printf("[ws] Closed pane %s; RAM history retained", paneID)
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
	if len(payload) == 0 {
		return nil
	}
	ph, err := h.GetOrCreatePaneHub(paneID)
	if err != nil {
		return err
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	return h.ingestLocked(ph, paneID, payload)
}

func (h *Hub) ingestForOwner(inst *pty.PTYInstance, payload []byte) error {
	h.mu.RLock()
	ph := h.panes[inst.ID]
	if ph == nil {
		h.mu.RUnlock()
		return ErrReplayNoHistory
	}
	ph.mu.Lock()
	h.mu.RUnlock()
	defer ph.mu.Unlock()
	if ph.owner != inst || ph.retired || inst.ReadOwnerRetired() {
		return fmt.Errorf("pane owner replaced")
	}
	return h.ingestLocked(ph, inst.ID, payload)
}

func (h *Hub) ingestLocked(ph *PaneHub, paneID string, payload []byte) error {
	if ph.retired {
		return ErrReplayNoHistory
	}
	// Publish bounded chunks: one oversized admission is split so a
	// subscriber's queue holds frames, not a whole burst.
	for len(payload) > 0 {
		chunk := payload
		if len(chunk) > terminalPublishChunkBytes {
			chunk = chunk[:terminalPublishChunkBytes]
		}
		payload = payload[len(chunk):]
		start := ph.win.head
		ph.win.write(chunk)
		ph.total = ph.win.head

		var outMsg []byte
		for client := range ph.clients {
			if outMsg == nil {
				var err error
				if outMsg, err = wireproto.EncodeOutputFrame(start, chunk); err != nil {
					componentLogger().With("pane", paneID).Error("terminal output encode failed; live clients must reattach", "err", err)
					return nil
				}
			}
			h.deliverPaneFrame(ph, client, outMsg)
		}
	}
	return nil
}

// terminalPublishChunkBytes bounds one encoded output frame.
const terminalPublishChunkBytes = 64 << 10

// deliverPaneFrame pushes one frame to a client of ph. Bridge-managed
// panes close a full client instead of evicting queued frames, so PTY
// output cannot drop an already queued bridge control.
func (h *Hub) deliverPaneFrame(ph *PaneHub, client *Client, msg []byte) {
	if client.terminal || ph.bridgeManaged {
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
	if ph.win != nil {
		used, cap = ph.win.used(), ph.win.capacity()
	}
	return clients, used, cap
}
