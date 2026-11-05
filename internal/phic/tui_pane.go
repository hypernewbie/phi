package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type paneKey struct{ Origin, ID string }

func (k paneKey) String() string { return k.Origin + "#" + k.ID }

type paneSpec struct {
	Key                                        paneKey
	Title, Coder, Dir, Workspace, OpenCodeMode string
	Fresh                                      bool
	Cols, Rows                                 int
}
type paneEventKind int

const (
	paneOutput paneEventKind = iota
	paneStatus
	paneExited
	paneError
	paneMetadata
)

type paneEvent struct {
	Actor      *paneActor
	Key        paneKey
	Kind       paneEventKind
	Status     string
	Code       int
	Title, PWD string
}
type paneInputKind int

const (
	paneInputKey paneInputKind = iota
	paneInputMouse
	paneInputPaste
	paneInputResize
	paneInputFocus
	paneInputScroll
	paneInputHistory
	paneInputLive
	// paneInputRaw carries already-encoded backend bytes (TUI navigation
	// sequences the emulator must not reinterpret). Delivery goes through
	// the same uncertain/exited/connection guards as keys.
	paneInputRaw
)

type paneInput struct {
	Kind  paneInputKind
	Key   termemu.KeyEvent
	Mouse struct {
		Action termemu.MouseAction
		Button termemu.MouseButton
		Mods   termemu.Modifier
		X, Y   int
	}
	Paste       []byte
	Raw         []byte
	Cols, Rows  int
	Focused     bool
	ForceResize bool
	Scroll      int
}
type paneWrite struct {
	conn  *websocket.Conn
	bytes []byte
}
type paneRead struct {
	bytes []byte
	err   error
}

// A pane owns one parser actor and one ordered writer. Readers belong to a
// single connection: old disconnects/frames cannot leak into its replacement.
type paneActor struct {
	spec                               paneSpec
	api                                *apiClient
	emu                                termemu.Terminal
	build                              func(termemu.Options) (termemu.Terminal, error)
	events                             chan<- paneEvent
	mu                                 sync.Mutex
	frontier, head, epoch              uint64
	replayOrdinal                      uint64
	oldest                             uint64
	epochSet                           bool
	frame                              termemu.Frame
	frameOK                            bool
	historyView                        paneHistoryView // copied with the painted frame under mu
	lastPaint, lastInteraction         time.Time
	cols, rows                         int
	dirty, exited, uncertainInput      bool
	emuCols, emuRows                   int // parser-owner geometry, distinct from desired panel size
	exitCode                           int
	serverDraining                     bool            // parser owner; wait for readiness before reconnecting
	historicalUntil                    *replayPosition // original cold fence survives partial replay failures
	mouseButton, mouseMotion, mouseAny bool
	connMu                             sync.Mutex
	conn                               *websocket.Conn
	outbox                             chan paneWrite
	inbox                              chan paneInput
	resizes                            chan paneInput // latest geometry, separate from input backlog
	historyOffset                      int
	ctx                                context.Context
	cancel                             context.CancelFunc
	done, writerDone                   chan struct{}

	// Paged replay: one worker owns HTTP reads and one page is pending at
	// a time. Frames that arrive during a page are held in order, bounded
	// by paneHeldBytes/paneHeldSpans, and replayed by the actor after it.
	pageSeq      uint64
	pages        chan pageRequest
	pageResults  chan pageResult
	pageDone     chan struct{}
	reads        <-chan paneRead
	held         [][]byte
	heldBytes    int
	heldOverflow bool

	// One recovery episode spans replacement sockets: a 10 s budget and at
	// most two history attempts.
	recoveryUntil    time.Time
	recoveryAttempts int

	// Certified attach position and bounded recovery state.
	exitNotified bool
	limited      bool
	attachHead   uint64
	attachCursor string
	floorCols    uint16
	floorRows    uint16
	floorOrdinal uint64
	headCols     uint16
	headRows     uint16
}

func newPaneActor(parent context.Context, api *apiClient, spec paneSpec, events chan<- paneEvent, build func(termemu.Options) (termemu.Terminal, error)) (*paneActor, error) {
	if spec.Cols <= 0 || spec.Rows <= 0 {
		return nil, fmt.Errorf("phic: pane geometry must be positive")
	}
	ctx, cancel := context.WithCancel(parent)
	p := &paneActor{spec: spec, api: api, build: build, events: events, cols: spec.Cols, rows: spec.Rows, lastInteraction: time.Now(), ctx: ctx, cancel: cancel, done: make(chan struct{}), writerDone: make(chan struct{}), outbox: make(chan paneWrite, 256), inbox: make(chan paneInput, 128), resizes: make(chan paneInput, 1), pages: make(chan pageRequest, 1), pageResults: make(chan pageResult, 1), pageDone: make(chan struct{})}
	go p.writeLoop()
	go p.pageWorker()
	go p.run()
	return p, nil
}
func (p *paneActor) sendEvent(ev paneEvent) {
	ev.Actor = p
	if p.events == nil {
		return
	}
	if ev.Kind == paneOutput {
		select {
		case p.events <- ev:
		default:
		}
		return
	}
	select {
	case p.events <- ev:
	case <-p.ctx.Done():
	}
}
func (p *paneActor) newTerminal(cols, rows int) (termemu.Terminal, error) {
	build := p.build
	if build == nil {
		build = termemu.NewGhostty
	}
	terminal, err := build(termemu.Options{Cols: cols, Rows: rows, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000, Events: termemu.EventOptions{
		OnReply: func(b []byte) {
			if b == nil {
				p.markUncertain("terminal reply buffer overflowed")
				return
			}
			p.enqueueInput(b)
		},
		OnTitle: func(s string) { p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneMetadata, Title: s}) },
		OnPWD:   func(s string) { p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneMetadata, PWD: s}) },
	}})
	if err == nil {
		p.emuCols, p.emuRows = cols, rows
	}
	return terminal, err
}

func (p *paneActor) resizeEmulator(cols, rows int) error {
	if p.emuCols == cols && p.emuRows == rows {
		return nil
	}
	if err := p.emu.Resize(cols, rows); err != nil {
		return err
	}
	p.emuCols, p.emuRows = cols, rows
	p.dirty = true
	return nil
}

func (p *paneActor) setConn(c *websocket.Conn) { p.connMu.Lock(); p.conn = c; p.connMu.Unlock() }
func (p *paneActor) getConn() *websocket.Conn {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	return p.conn
}
func (p *paneActor) enqueue(b []byte) bool {
	p.mu.Lock()
	exited := p.exited
	p.mu.Unlock()
	if exited {
		return false
	}
	if len(b) == 0 {
		return true
	}
	c := p.getConn()
	if c == nil {
		p.markUncertain("not connected; input was not sent")
		return false
	}
	select {
	case p.outbox <- paneWrite{conn: c, bytes: b}:
		return true
	default:
		p.markUncertain("input queue full; input was not sent")
		return false
	}
}
func (p *paneActor) enqueueInput(b []byte) {
	for _, chunk := range wireproto.ChunkInput(b) {
		frame, err := wireproto.EncodeInputFrame(chunk)
		if err != nil {
			p.markUncertain("input encode failed; input was not sent")
			return
		}
		if !p.enqueue(frame) {
			return
		}
	}
}

// enqueueResize encodes one resize request. Out-of-range geometry is
// refused here instead of closing the stream server-side.
func (p *paneActor) enqueueResize(cols, rows int) bool {
	if cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		p.markUncertain("resize out of range; resize was not sent")
		return false
	}
	frame, err := wireproto.EncodeResizeFrame(uint32(cols), uint32(rows))
	if err != nil {
		p.markUncertain("resize encode failed; resize was not sent")
		return false
	}
	return p.enqueue(frame)
}
func (p *paneActor) writeLoop() {
	defer close(p.writerDone)
	for {
		select {
		case <-p.ctx.Done():
			return
		case w := <-p.outbox:
			// Never deliver bytes queued for one connection through another.
			if w.conn != p.getConn() {
				continue
			}
			_ = w.conn.SetWriteDeadline(time.Now().Add(paneWriteTimeout))
			w.conn.EnableWriteCompression(len(w.bytes) >= 1024)
			if err := w.conn.WriteMessage(websocket.BinaryMessage, w.bytes); err != nil {
				p.markUncertain("input write failed; delivery is uncertain (not retried)")
				_ = w.conn.Close()
			}
		}
	}
}
func (p *paneActor) markUncertain(status string) {
	p.mu.Lock()
	already := p.uncertainInput
	p.uncertainInput = true
	p.mu.Unlock()
	if !already {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: status})
	}
}
func (p *paneActor) submit(in paneInput) {
	if in.Kind == paneInputKey || in.Kind == paneInputMouse || in.Kind == paneInputPaste || in.Kind == paneInputRaw {
		p.mu.Lock()
		blocked := p.uncertainInput || p.exited
		p.mu.Unlock()
		if blocked || p.getConn() == nil {
			p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "not connected or delivery uncertain; input was not admitted"})
			return
		}
	}
	select {
	case <-p.ctx.Done():
		return
	default:
	}
	select {
	case p.inbox <- in:
	default:
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "input backlog; action was not admitted"})
	}
}
func (p *paneActor) sendKey(ev termemu.KeyEvent) { p.submit(paneInput{Kind: paneInputKey, Key: ev}) }
func (p *paneActor) sendRaw(b []byte) {
	p.submit(paneInput{Kind: paneInputRaw, Raw: append([]byte(nil), b...)})
}
func (p *paneActor) sendPaste(b []byte) {
	p.submit(paneInput{Kind: paneInputPaste, Paste: append([]byte(nil), b...)})
}
func (p *paneActor) resize(cols, rows int)      { p.queueResize(cols, rows, false) }
func (p *paneActor) forceResize(cols, rows int) { p.queueResize(cols, rows, true) }

// The UI is the sole geometry producer. Coalesce drags to their latest size
// without dropping the final request behind an input backlog. Keep any pending
// activation/refresh force bit, even when a newer drag replaces its dimensions.
func (p *paneActor) queueResize(cols, rows int, force bool) {
	in := paneInput{Kind: paneInputResize, Cols: cols, Rows: rows, ForceResize: force}
	if p.resizes == nil {
		p.submit(in)
		return
	}
	select {
	case <-p.ctx.Done():
		return
	default:
	}
	select {
	case p.resizes <- in:
		return
	default:
	}
	select {
	case previous := <-p.resizes:
		in.ForceResize = in.ForceResize || previous.ForceResize
	default:
	}
	select {
	case p.resizes <- in:
	case <-p.ctx.Done():
	}
}
func (p *paneActor) sendFocus(focused bool) {
	p.submit(paneInput{Kind: paneInputFocus, Focused: focused})
}
func (p *paneActor) scroll(delta int) { p.submit(paneInput{Kind: paneInputScroll, Scroll: delta}) }
func (p *paneActor) loadHistory()     { p.submit(paneInput{Kind: paneInputHistory}) }
func (p *paneActor) jumpLive()        { p.submit(paneInput{Kind: paneInputLive}) }
func (p *paneActor) historyViewCopy() paneHistoryView {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.historyView
}
func (p *paneActor) sendMouse(a termemu.MouseAction, b termemu.MouseButton, m termemu.Modifier, x, y int) {
	in := paneInput{Kind: paneInputMouse}
	in.Mouse.Action, in.Mouse.Button, in.Mouse.Mods, in.Mouse.X, in.Mouse.Y = a, b, m, x, y
	p.submit(in)
}
func (p *paneActor) snapshotCopy() (termemu.Frame, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frame, p.frameOK
}
func (p *paneActor) state() (frontier, head, epoch uint64, exited bool, code int, uncertain bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frontier, p.head, p.epoch, p.exited, p.exitCode, p.uncertainInput
}
func (p *paneActor) close() {
	p.cancel()
	if c := p.getConn(); c != nil {
		_ = c.Close()
	}
	<-p.done
	<-p.writerDone
	<-p.pageDone
}
func (p *paneActor) geometry() (int, int) { p.mu.Lock(); defer p.mu.Unlock(); return p.cols, p.rows }
func (p *paneActor) epochValue() uint64   { p.mu.Lock(); defer p.mu.Unlock(); return p.epoch }
func (p *paneActor) mouseOwned() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mouseButton || p.mouseMotion || p.mouseAny
}

func (p *paneActor) dial(ctx context.Context) (*websocket.Conn, wireAttach, error) {
	if p.serverDraining {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, p.api.base.String()+"/readyz", nil)
		if err != nil {
			return nil, wireAttach{}, err
		}
		resp, err := p.api.http.Do(req)
		if err != nil {
			return nil, wireAttach{}, err
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, wireAttach{}, &apiError{Code: resp.StatusCode, Message: "server is restarting"}
		}
		p.serverDraining = false
	}
	u, err := mustWebsocketURL(p.api.base.String() + "/ws/pane/" + url.PathEscape(p.spec.Key.ID))
	if err != nil {
		return nil, wireAttach{}, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, Jar: p.api.http.Jar, EnableCompression: true, Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, resp, err := dialer.DialContext(ctx, u, nil)
	if err != nil {
		if resp != nil {
			return nil, wireAttach{}, &apiError{Code: resp.StatusCode, Message: "WebSocket: " + resp.Status}
		}
		return nil, wireAttach{}, err
	}
	if conn.Subprotocol() != wireproto.TerminalSubprotocol {
		_ = conn.Close()
		return nil, wireAttach{}, fmt.Errorf("%w: server did not select the terminal subprotocol", errProtocol)
	}
	conn.SetReadLimit(wireproto.MaxTerminalMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
	var h wireAttach
	if err == nil && mt != websocket.BinaryMessage {
		err = fmt.Errorf("%w: attach is not binary", errProtocol)
	}
	if err == nil {
		h.Header, err = ParseAttachHead(msg)
		if err != nil {
			err = fmt.Errorf("%w: invalid attach: %v", errProtocol, err)
		}
	}
	if err != nil {
		closeWithCode(conn, closeCodeForReadError(err), "invalid attach")
		return nil, h, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(paneReadTimeout))
	conn.SetPingHandler(func(s string) error {
		_ = conn.SetReadDeadline(time.Now().Add(paneReadTimeout))
		return conn.WriteControl(websocket.PongMessage, []byte(s), time.Now().Add(paneWriteTimeout))
	})
	return conn, h, nil
}
func (p *paneActor) readLoop(ctx context.Context, conn *websocket.Conn, reads chan<- paneRead, done chan<- struct{}) {
	defer close(done)
	for {
		mt, b, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
		if err == nil {
			_ = conn.SetReadDeadline(time.Now().Add(paneReadTimeout))
			if mt != websocket.BinaryMessage {
				err = fmt.Errorf("%w: nonbinary pane frame", errProtocol)
			}
		}
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, net.ErrClosed) {
			// Bounded close codes keep the server and the native peer in
			// agreement about why the stream stopped.
			closeWithCode(conn, closeCodeForReadError(err), "pane stream failed")
		}
		select {
		case reads <- paneRead{bytes: b, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}
func (p *paneActor) run() {
	defer close(p.done)
	defer p.cancel()
	emu, err := p.newTerminal(p.cols, p.rows)
	if err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
		return
	}
	p.emu = emu
	defer func() { _ = p.emu.Close() }() // Disposal stays on the parser owner.
	if err = p.attachAndRun(); err != nil && p.ctx.Err() == nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
	}
}
func (p *paneActor) attachAndRun() error {
	backoff := 200 * time.Millisecond
	for {
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
		conn, h, err := p.dial(p.ctx)
		if err == nil {
			reads := make(chan paneRead, 8)
			readerDone := make(chan struct{})
			ctx, cancel := context.WithCancel(p.ctx)
			p.setConn(conn)
			go p.readLoop(ctx, conn, reads, readerDone)
			p.reads = reads
			p.held, p.heldBytes, p.heldOverflow = nil, 0, false
			err = p.bootstrap(h)
			if p.exited {
				if !p.exitNotified {
					p.finalizeKnownExit()
				}
				err = errPaneExited
			}
			if err == nil {
				p.mu.Lock()
				p.uncertainInput = false
				p.mu.Unlock()
				p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "connected"})
				err = p.consume(reads)
			}
			if p.exited && !p.exitNotified {
				p.finalizeKnownExit()
				err = errPaneExited
			}
			if errors.Is(err, errHeldOverflow) || errors.Is(err, errPageDeadline) {
				p.limited = true
			}
			p.reads = nil
			p.setConn(nil)
			cancel()
			_ = conn.Close()
			<-readerDone
			if errors.Is(err, errPaneExited) {
				return nil
			}
		}
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
		if permanent(err) || errors.Is(err, errInvalidRecording) {
			return err
		}
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "reconnecting: " + err.Error()})
		select {
		case <-p.ctx.Done():
			return p.ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(3*time.Second, backoff*2)
	}
}

var errPaneExited = errors.New("phic: pane exited")
var errPaneResize = errors.New("phic: resize could not be queued; reconnect required")

func (p *paneActor) bootstrap(h wireAttach) error {
	header := h.Header
	p.mu.Lock()
	epoch, frontier, exited, attached := p.epoch, p.frontier, p.exited, p.epochSet
	p.mu.Unlock()
	if exited {
		return errPaneExited
	}
	cold := !attached || epoch != header.GetEpoch()
	if attached && cold {
		p.endRecovery()
		p.limited = false
	}
	floor := header.GetOldest()
	// A reconnect can outlive the window it was reading: the certified
	// floor moved past the local frontier and the prefix is gone.
	lostFloor := attached && !cold && frontier < floor
	// Older frames carry only the spawn grid; the floor and head grids
	// then equal it and the ordinal starts at zero.
	floorCols, floorRows := header.GetFloorCols(), header.GetFloorRows()
	if floorCols == 0 || floorRows == 0 {
		floorCols, floorRows = header.GetInitialCols(), header.GetInitialRows()
	}
	headCols, headRows := header.GetHeadCols(), header.GetHeadRows()
	if headCols == 0 || headRows == 0 {
		headCols, headRows = floorCols, floorRows
	}
	p.floorCols, p.floorRows = uint16(floorCols), uint16(floorRows)
	p.headCols, p.headRows = uint16(headCols), uint16(headRows)
	p.floorOrdinal = 0
	if cursor := header.GetFloorEventCursor(); cursor != "" {
		by, err := parseReplayPosition(cursor)
		if err != nil || by.epoch != header.GetEpoch() || by.seq != floor {
			return errProtocol
		}
		p.floorOrdinal = by.ordinal
	} else if floor != 0 {
		return errProtocol
	}
	if p.limited || p.recoveryExhausted() {
		p.limited = true
		if err := p.adoptHead(header); err != nil {
			return err
		}
		p.dirty = false // retain the last painted frame until new live output
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "history unavailable; showing live output only"})
		return nil
	}
	p.beginRecovery()
	if cold || lostFloor {
		if err := p.adoptFloor(header); err != nil {
			return err
		}
		frontier = floor
		if !p.spec.Fresh {
			fence, err := parseReplayPosition(header.GetEventCursor())
			if err != nil {
				return err
			}
			p.historicalUntil = &fence
		}
		p.spec.Fresh = false
	}
	head := header.GetHead()
	if frontier > head {
		return fmt.Errorf("%w: invalid attach frontier", errProtocol)
	}
	p.mu.Lock()
	p.oldest, p.epoch, p.epochSet, p.head = floor, header.GetEpoch(), true, max(p.head, head)
	p.mu.Unlock()
	p.attachHead, p.attachCursor = head, header.GetEventCursor()
	deadline := p.recoveryDeadline()
	if fence := p.historicalUntil; fence != nil {
		if err := p.recoverFrom(deadline, frontier, fence.seq, fence.String()); err != nil {
			return err
		}
		p.mu.Lock()
		frontier = p.frontier
		p.mu.Unlock()
		p.historicalUntil = nil
	}
	if err := p.recoverFrom(deadline, frontier, p.attachHead, p.attachCursor); err != nil {
		return err
	}
	if err := p.flushHeld(); err != nil {
		if !errors.Is(err, errHeldOverflow) {
			return err
		}
		return p.enterLimited("live output hold overflow")
	}
	if p.exited {
		return nil
	}
	// Request the desired panel size; only its committed geometry frame
	// may resize the parser. Queued output still belongs to the old grid.
	cols, rows := p.geometry()
	if !p.enqueueResize(cols, rows) {
		return errPaneResize
	}
	p.endRecovery()
	p.dirty = true
	return p.refreshFrame()
}

// adoptFloor resets the parser at the certified floor. Every byte below
// it is gone, so replay starts there under the floor grid.
func (p *paneActor) adoptFloor(h *wspb.TerminalAttach) error {
	p.attachHead, p.attachCursor = h.GetHead(), h.GetEventCursor()
	return p.resetAt(h.GetEpoch(), h.GetOldest(), h.GetHead(), p.floorCols, p.floorRows, h.GetOldest(), p.floorOrdinal)
}

// adoptHead resets the parser at the certified head. The held live tail
// supplies every byte after it.
func (p *paneActor) adoptHead(h *wspb.TerminalAttach) error {
	pos, err := parseReplayPosition(h.GetEventCursor())
	if err != nil {
		return errProtocol
	}
	p.attachHead, p.attachCursor = h.GetHead(), h.GetEventCursor()
	return p.resetAt(h.GetEpoch(), h.GetOldest(), h.GetHead(), p.headCols, p.headRows, h.GetHead(), pos.ordinal)
}

// resetAt installs a fresh parser at a certified position. The caller
// owns the actor goroutine; no other goroutine touches the emulator.
func (p *paneActor) resetAt(epoch, oldest, head uint64, cols, rows uint16, pos, ordinal uint64) error {
	if cols == 0 || rows == 0 {
		return errProtocol
	}
	p.returnLive()
	emu, err := p.newTerminal(int(cols), int(rows))
	if err != nil {
		return err
	}
	if p.emu != nil {
		_ = p.emu.Close()
	}
	p.emu = emu
	p.historyOffset = 0
	p.replayOrdinal = ordinal
	p.historicalUntil = nil
	p.mu.Lock()
	p.epoch, p.epochSet, p.oldest = epoch, true, oldest
	p.frontier = pos
	p.head = max(pos, head)
	p.mu.Unlock()
	p.dirty = true
	return nil
}

func (p *paneActor) consume(reads <-chan paneRead) error {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	// No periodic paint wakeup: arm one timer only while bytes have dirtied
	// the screen. Parsing, recording frontiers, replies and input are never
	// paced; only the copied screen and its UI notification are.
	paint := time.NewTimer(time.Hour)
	paint.Stop()
	defer paint.Stop()
	var paintC <-chan time.Time
	var due time.Time
	for {
		if p.dirty {
			now := time.Now()
			p.mu.Lock()
			next := p.lastPaint.Add(panePaintInterval(now, p.lastInteraction))
			p.mu.Unlock()
			if paintC == nil || next.Before(due) {
				paint.Stop()
				paint.Reset(max(time.Duration(0), next.Sub(now)))
				paintC, due = paint.C, next
			}
		} else if paintC != nil {
			paint.Stop()
			paintC = nil
		}
		select {
		case <-p.ctx.Done():
			return p.ctx.Err()
		case r, ok := <-reads:
			if !ok {
				return io.EOF
			}
			if r.err != nil {
				return r.err
			}
			if err := p.handleFrame(r.bytes); err != nil {
				if errors.Is(err, errProtocol) || errors.Is(err, wireproto.ErrMessageTooLarge) {
					closeWithCode(p.getConn(), closeCodeForReadError(err), "invalid terminal frame")
				}
				return err
			}
		case in := <-p.inbox:
			if err := p.handleInput(in); err != nil {
				return err
			}
		case in := <-p.resizes:
			if err := p.handleInput(in); err != nil {
				return err
			}
		case <-paintC:
			paintC = nil
			if p.dirty {
				if err := p.refreshFrame(); err != nil {
					return err
				}
			}
		case <-ping.C:
			if ping, err := wireproto.EncodePingFrame(); err == nil {
				p.enqueue(ping)
			}
		}
	}
}
func (p *paneActor) handleFrame(msg []byte) error {
	if len(msg) == 0 {
		return fmt.Errorf("%w: empty terminal frame", errProtocol)
	}
	frame, err := wireproto.DecodeServerFrame(msg)
	if err != nil {
		return fmt.Errorf("%w: malformed terminal frame: %v", errProtocol, err)
	}
	switch payload := frame.GetPayload().(type) {
	case *wspb.TerminalServerFrame_Output:
		start, data, err := outputSpan(payload.Output)
		if err != nil {
			return err
		}
		p.mu.Lock()
		frontier := p.frontier
		p.mu.Unlock()
		if start > frontier {
			if err = p.recoverLiveGap(); err != nil {
				return err
			}
			if err := p.flushHeld(); err != nil {
				return err
			}
			// Recovery may have healed from a live checkpoint past
			// start: re-resolve the adopted frontier before trimming,
			// so an older queued frame never re-feeds or regresses it.
			p.mu.Lock()
			frontier = p.frontier
			p.mu.Unlock()
		}
		end := start + uint64(len(data))
		if end <= frontier {
			return nil
		}
		if start < frontier {
			data = data[frontier-start:]
		}
		if err = p.feed(data, termemu.SourceLive); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = max(p.frontier, end)
		p.head = max(p.head, end)
		p.mu.Unlock()
		if p.limited && end > p.attachHead {
			p.limited = false
			p.endRecovery()
		}
	case *wspb.TerminalServerFrame_Geometry:
		geom := payload.Geometry
		pos, err := parseReplayPosition(geom.GetEventCursor())
		if err != nil || pos.epoch != p.epochValue() || pos.seq != geom.GetAtSeq() ||
			geom.GetCols() == 0 || geom.GetCols() > 65535 || geom.GetRows() == 0 || geom.GetRows() > 65535 {
			return errProtocol
		}
		if pos.ordinal <= p.replayOrdinal {
			return nil
		} // replay already parsed it
		p.mu.Lock()
		frontier := p.frontier
		p.mu.Unlock()
		if pos.seq > frontier {
			if err := p.recoverLiveGap(); err != nil {
				return err
			}
			if err := p.flushHeld(); err != nil {
				return err
			}
			if pos.ordinal <= p.replayOrdinal {
				return nil
			}
			p.mu.Lock()
			frontier = p.frontier
			p.mu.Unlock()
		}
		if pos.seq != frontier || pos.ordinal != p.replayOrdinal+1 {
			return errProtocol
		}
		if err := p.resizeEmulator(int(geom.GetCols()), int(geom.GetRows())); err != nil {
			return err
		}
		p.replayOrdinal = pos.ordinal
	case *wspb.TerminalServerFrame_Exit:
		code, err := terminalExitCode(payload.Exit)
		if err != nil {
			return err
		}
		// Record the exit first: admission closes immediately, then the
		// finite archive drain runs.
		p.noteExit(code)
		p.finalizeKnownExit()
		return errPaneExited
	case *wspb.TerminalServerFrame_Pong:
		return nil
	case *wspb.TerminalServerFrame_DropNotice:
		return p.recoverLiveGap()
	case *wspb.TerminalServerFrame_Notification:
		if payload.Notification.GetShutdown() != nil {
			p.serverDraining = true
			// Shutdown terminates the old child before restoring the pane.
			// Reconnect instead of treating that old child's exit as final.
			return io.EOF
		}
		return nil
	case *wspb.TerminalServerFrame_Title,
		*wspb.TerminalServerFrame_BridgeState,
		*wspb.TerminalServerFrame_Settlement:
		// Browser UI hints; no terminal output, no sequence impact.
		return nil
	default:
		return fmt.Errorf("%w: unexpected terminal payload", errProtocol)
	}
	return nil
}

func (p *paneActor) recoverLiveGap() error {
	if p.recoveryExhausted() {
		return p.enterLimited("live recovery budget exhausted")
	}
	p.beginRecovery()
	err := p.recoverLatest(p.recoveryDeadline())
	if err == nil {
		p.endRecovery()
	}
	return err
}

// Exit carries no head. Capture latest once and finish that finite target,
// including zero-byte pages that advance only the resize ordinal.
func (p *paneActor) drainExit() error {
	// The archive drain is finite and independent of recovery episodes:
	// a known exit finalizes once, even when the tail is missing.
	return p.recoverLatest(time.Now().Add(paneRecoveryBudget))
}

// recoverLatest captures the current head once and pages to that finite
// fence, including zero-byte pages that only advance the ordinal.
func (p *paneActor) recoverLatest(deadline time.Time) error {
	res, err := p.latestPage(deadline)
	if err != nil {
		return err
	}
	if err := p.admitReplay(res.h, res.data, termemu.SourceLive); err != nil {
		return err
	}
	return p.recoverFrom(deadline, res.h.End, res.h.Through, res.h.ThroughCursor)
}

func (p *paneActor) latestPage(deadline time.Time) (pageResult, error) {
	p.mu.Lock()
	from := p.frontier
	p.mu.Unlock()
	epoch := p.epochValue()
	after := (replayPosition{epoch, from, p.replayOrdinal}).String()
	req := pageRequest{epoch: epoch, from: from, after: after, latest: true, deadline: deadline}
	res, err := p.fetchPage(req)
	var expired *expiredWindowError
	if err == nil || !errors.As(err, &expired) || expired.info.Epoch != epoch {
		return res, err
	}
	// The window moved past the local frontier while paging. Resume at
	// its certified floor instead of guessing the lost prefix.
	if !p.windowAdvances(expired.info, from) {
		return pageResult{}, err
	}
	if !p.exited {
		if p.recoveryExhausted() {
			return pageResult{}, p.enterLimited("history expired during recovery")
		}
		p.beginRecovery()
	}
	if err := p.adoptWindow(expired.info); err != nil {
		return pageResult{}, err
	}
	p.mu.Lock()
	from = p.frontier
	p.mu.Unlock()
	after = (replayPosition{epoch, from, p.replayOrdinal}).String()
	return p.fetchPage(pageRequest{epoch: epoch, from: from, after: after, latest: true, deadline: deadline})
}

// recoverFrom pages one finite byte/ordinal fence. Every fetch runs on
// the page worker, so input, resize, ping and paint stay live while the
// history streams in.
func (p *paneActor) recoverFrom(deadline time.Time, from, through uint64, fence string) error {
	target, err := parseReplayPosition(fence)
	if err != nil || target.epoch != p.epochValue() || target.seq != through || target.ordinal < p.replayOrdinal {
		return errInvalidRecording
	}
	resets := 0
	source := p.replaySource(fence)
	for from < through || p.replayOrdinal < target.ordinal {
		if !time.Now().Before(deadline) {
			return errPageDeadline
		}
		epoch := p.epochValue()
		after := (replayPosition{epoch, from, p.replayOrdinal}).String()
		res, err := p.fetchPage(pageRequest{epoch: epoch, from: from, through: through, after: after, fence: fence, deadline: deadline})
		if err != nil {
			var expired *expiredWindowError
			if !errors.As(err, &expired) || resets > 0 || expired.info.Epoch != p.epochValue() {
				return err
			}
			if !p.windowAdvances(expired.info, from) {
				return err
			}
			resets++
			if !p.exited {
				if p.recoveryExhausted() {
					return p.enterLimited("history expired during recovery")
				}
				p.beginRecovery()
			}
			if err := p.adoptWindow(expired.info); err != nil {
				return err
			}
			from = p.floorValue()
			through, fence = expired.info.Head, expired.info.EventCursor
			if target, err = parseReplayPosition(fence); err != nil || target.seq != through {
				return errProtocol
			}
			continue
		}
		if err := p.admitReplay(res.h, res.data, source); err != nil {
			return err
		}
		from = res.h.End
	}
	return nil
}

// replaySource marks bytes already presented before this reader attached.
func (p *paneActor) replaySource(fence string) termemu.Source {
	if p.historicalUntil != nil && fence == p.historicalUntil.String() {
		return termemu.SourceReplay
	}
	return termemu.SourceLive
}

func (p *paneActor) admitReplay(h wireproto.ReplayHeader, b []byte, source termemu.Source) error {
	if err := p.feedRecording(wireproto.RecordingHeader{Start: h.Start, End: h.End, Resizes: h.Resizes}, b, source); err != nil {
		return err
	}
	pos, err := parseReplayPosition(h.EventCursor)
	if err != nil {
		return err
	}
	p.replayOrdinal = pos.ordinal
	p.mu.Lock()
	p.frontier = h.End
	p.head = max(p.head, h.End)
	p.mu.Unlock()
	return nil
}
func (p *paneActor) feedRecording(h wireproto.RecordingHeader, b []byte, source termemu.Source) error {
	at := h.Start
	for _, r := range h.Resizes {
		offset := max(h.Start, r[0])
		if offset > at {
			if err := p.feed(b[at-h.Start:offset-h.Start], source); err != nil {
				return err
			}
			at = offset
		}
		if err := p.resizeEmulator(int(r[1]), int(r[2])); err != nil {
			return err
		}
	}
	if err := p.feed(b[at-h.Start:], source); err != nil {
		return err
	}
	p.dirty = true
	return nil
}
func (p *paneActor) feed(b []byte, source termemu.Source) error {
	for len(b) > 0 {
		n := min(len(b), 64<<10)
		if err := p.emu.Feed(b[:n], source); err != nil {
			return err
		}
		b = b[n:]
	}
	p.dirty = true
	return nil
}
func (p *paneActor) handleInput(in paneInput) error {
	// Automatic geometry checks are not user interaction.
	if in.Kind != paneInputResize && in.Kind != paneInputFocus {
		p.noteInteraction(time.Now())
	}
	p.mu.Lock()
	uncertain, exited := p.uncertainInput, p.exited
	p.mu.Unlock()
	if exited && in.Kind != paneInputScroll && in.Kind != paneInputHistory && in.Kind != paneInputLive {
		return nil
	}
	if in.Kind == paneInputResize {
		if in.Cols <= 0 || in.Rows <= 0 {
			return nil
		}
		p.mu.Lock()
		same := in.Cols == p.cols && in.Rows == p.rows
		p.cols, p.rows = in.Cols, in.Rows
		p.mu.Unlock()
		localChange := in.Cols != p.emuCols || in.Rows != p.emuRows
		if !same || localChange || in.ForceResize {
			if !p.enqueueResize(in.Cols, in.Rows) {
				return errPaneResize
			}
		}
		return nil
	}
	if in.Kind == paneInputHistory {
		p.requestHistory()
		return nil
	}
	if in.Kind == paneInputLive {
		p.returnLive()
		return nil
	}
	if in.Kind == paneInputScroll {
		target := p.emu
		p.mu.Lock()
		historyRows := p.frame.History
		p.mu.Unlock()
		if scroller, ok := target.(interface{ ScrollViewport(int) error }); ok {
			if err := scroller.ScrollViewport(in.Scroll); err != nil {
				return err
			}
			p.historyOffset = min(0, max(-historyRows, p.historyOffset+in.Scroll))
			p.dirty = true
		}
		return nil
	}
	if in.Kind != paneInputFocus {
		p.returnLive()
	}
	if uncertain {
		return nil
	}
	var b []byte
	var err error
	switch in.Kind {
	case paneInputRaw:
		if len(in.Raw) > 0 {
			p.enqueueInput(in.Raw)
		}
		return nil
	case paneInputKey:
		b, err = p.emu.EncodeKey(in.Key)
	case paneInputMouse:
		b, err = p.emu.EncodeMouse(in.Mouse.Action, in.Mouse.Button, in.Mouse.Mods, in.Mouse.X, in.Mouse.Y)
	case paneInputPaste:
		b, err = p.emu.EncodePaste(in.Paste)
	case paneInputFocus:
		if f, ok := p.emu.(interface{ EncodeFocus(bool) ([]byte, error) }); ok {
			b, err = f.EncodeFocus(in.Focused)
		}
	}
	if err != nil {
		return err
	}
	if len(b) > 0 {
		p.enqueueInput(b)
	}
	return nil
}
func (p *paneActor) refreshFrame() error {
	target := p.emu
	frame, err := target.Snapshot()
	if err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
		return err
	}
	mb, _ := p.emu.Mode(termemu.ModeMouseButton)
	mm, _ := p.emu.Mode(termemu.ModeMouseMotion)
	ma, _ := p.emu.Mode(termemu.ModeMouseAny)
	p.mu.Lock()
	p.frame = frame
	p.frameOK = true
	p.historyView = paneHistoryView{Browsing: p.historyOffset < 0}
	p.lastPaint = time.Now()
	p.mouseButton, p.mouseMotion, p.mouseAny = mb, mm, ma
	p.mu.Unlock()
	p.dirty = false
	p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneOutput})
	return nil
}
