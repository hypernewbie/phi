package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
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
	mouseButton, mouseMotion, mouseAny bool
	connMu                             sync.Mutex
	conn                               *websocket.Conn
	outbox                             chan paneWrite
	inbox                              chan paneInput
	resizes                            chan paneInput // latest geometry, separate from input backlog
	histories                          chan historyResult
	history                            termemu.Terminal
	historyThrough, historyGen         uint64
	historyPending                     bool
	historyCancel                      context.CancelFunc
	historyOffset                      int
	ctx                                context.Context
	cancel                             context.CancelFunc
	done, writerDone                   chan struct{}
}

func newPaneActor(parent context.Context, api *apiClient, spec paneSpec, events chan<- paneEvent, build func(termemu.Options) (termemu.Terminal, error)) (*paneActor, error) {
	if spec.Cols <= 0 || spec.Rows <= 0 {
		return nil, fmt.Errorf("phic: pane geometry must be positive")
	}
	ctx, cancel := context.WithCancel(parent)
	p := &paneActor{spec: spec, api: api, build: build, events: events, cols: spec.Cols, rows: spec.Rows, lastInteraction: time.Now(), ctx: ctx, cancel: cancel, done: make(chan struct{}), writerDone: make(chan struct{}), outbox: make(chan paneWrite, 256), inbox: make(chan paneInput, 128), resizes: make(chan paneInput, 1), histories: make(chan historyResult, 1)}
	go p.writeLoop()
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
}
func (p *paneActor) geometry() (int, int) { p.mu.Lock(); defer p.mu.Unlock(); return p.cols, p.rows }
func (p *paneActor) epochValue() uint64   { p.mu.Lock(); defer p.mu.Unlock(); return p.epoch }
func (p *paneActor) mouseOwned() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mouseButton || p.mouseMotion || p.mouseAny
}

func (p *paneActor) dial(ctx context.Context) (*websocket.Conn, wireAttach, error) {
	u, err := mustWebsocketURL(p.api.base.String() + "/ws/pane/" + url.PathEscape(p.spec.Key.ID) + "?state=ghostty-ready-v1")
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
	defer func() {
		_ = p.emu.Close()
		if p.history != nil {
			_ = p.history.Close()
		}
	}() // Disposal stays on the parser owner.
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
			err = p.bootstrap(h)
			if err == nil {
				p.mu.Lock()
				p.uncertainInput = false
				p.mu.Unlock()
				p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "connected"})
				err = p.consume(reads)
			}
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
	p.mu.Lock()
	epoch, frontier, exited, attached := p.epoch, p.frontier, p.exited, p.epochSet
	p.mu.Unlock()
	if exited {
		return errPaneExited
	}
	cold := !attached
	if attached && epoch != h.Header.GetEpoch() {
		p.returnLive() // Historical views and in-flight pages belong to the old epoch.
		cols, rows := p.geometry()
		emu, err := p.newTerminal(cols, rows)
		if err != nil {
			return err
		}
		_ = p.emu.Close()
		p.emu = emu
		frontier = 0
		cold = true
		p.spec.Fresh = false
		p.mu.Lock()
		p.frontier = 0
		p.frameOK = false
		p.mu.Unlock()
	}
	ckpt := h.Header.GetCheckpoint()
	if ckpt != nil && ckpt.GetKind() == "ghostty-ready-v1" {
		restorer, ok := p.emu.(interface{ RestoreReady([]byte) error })
		if !ok {
			return fmt.Errorf("phic: emulator cannot restore bounded terminal state")
		}
		if err := restorer.RestoreReady(ckpt.GetData()); err != nil {
			return err
		}
		p.emuCols, p.emuRows = int(ckpt.GetCols()), int(ckpt.GetRows())
		if p.history == nil {
			p.historyOffset = 0
		}
		frontier = ckpt.GetThrough()
		p.mu.Lock()
		p.frontier = frontier
		p.frameOK = false
		p.mu.Unlock()
	}
	p.mu.Lock()
	p.oldest = h.Header.GetOldest()
	p.epoch = h.Header.GetEpoch()
	p.mu.Unlock()
	head := h.Header.GetHead()
	if h.Header.GetOldest() > frontier {
		if err := p.healFromLiveState(p.ctx); err != nil {
			return err
		}
		p.mu.Lock()
		frontier = p.frontier
		p.mu.Unlock()
		// The live snapshot can include output produced after this attach.
		head = max(head, frontier)
	}
	if frontier > head {
		return fmt.Errorf("%w: frontier exceeds attach head", errProtocol)
	}
	p.mu.Lock()
	p.epochSet = true
	p.head = head
	p.mu.Unlock()
	after := ""
	if ckpt := h.Header.GetCheckpoint(); ckpt != nil {
		after = ckpt.GetEventCursor()
	}
	if err := p.recover(p.ctx, frontier, head, cold && !p.spec.Fresh, after); err != nil {
		return err
	}
	cols, rows := p.geometry()
	if err := p.resizeEmulator(cols, rows); err != nil {
		return err
	}
	if !p.enqueueResize(cols, rows) {
		return errPaneResize
	}
	p.dirty = true
	return p.refreshFrame()
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
		case result := <-p.histories:
			if err := p.applyHistory(result); err != nil {
				p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "history: " + err.Error()})
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
			if err = p.recover(p.ctx, frontier, start, false, ""); err != nil {
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
	case *wspb.TerminalServerFrame_Exit:
		code, err := terminalExitCode(payload.Exit)
		if err != nil {
			return err
		}
		if err := p.drainExit(); err != nil {
			return err
		}
		p.mu.Lock()
		p.exited = true
		p.exitCode = code
		p.mu.Unlock()
		// Exit remains authoritative even if the final screen copy fails.
		_ = p.refreshFrame()
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneExited, Code: code})
		return errPaneExited
	case *wspb.TerminalServerFrame_Pong:
		return nil
	case *wspb.TerminalServerFrame_DropNotice:
		return p.drainExit()
	case *wspb.TerminalServerFrame_Title,
		*wspb.TerminalServerFrame_BridgeState,
		*wspb.TerminalServerFrame_Settlement,
		*wspb.TerminalServerFrame_Notification:
		// Browser UI hints; no terminal output, no sequence impact.
		return nil
	default:
		return fmt.Errorf("%w: unexpected terminal payload", errProtocol)
	}
	return nil
}

// healFromLiveState restores the current parser snapshot when the recorded
// prefix is gone. Only the live emulator is touched; a browsed historical
// book stays installed.
func (p *paneActor) healFromLiveState(ctx context.Context) error {
	header, data, err := p.api.liveState(ctx, p.spec.Key.ID, p.epochValue(), "ghostty-ready-v1")
	if err != nil {
		return err
	}
	restorer, ok := p.emu.(interface{ RestoreReady([]byte) error })
	if !ok {
		return fmt.Errorf("phic: emulator cannot restore bounded terminal state")
	}
	if err := restorer.RestoreReady(data); err != nil {
		return err
	}
	p.emuCols, p.emuRows = int(header.Ckpt.Cols), int(header.Ckpt.Rows)
	p.mu.Lock()
	p.frontier = header.Head
	p.head = max(p.head, header.Head)
	p.frameOK = false
	p.mu.Unlock()
	p.dirty = true
	return nil
}

// An exit/dropped notice carries no final frontier. Read until the recording
// actually ends, rather than treating the last received live frame as its head.
func (p *paneActor) drainExit() error {
	after := ""
	for {
		p.mu.Lock()
		from := p.frontier
		p.mu.Unlock()
		if from > ^uint64(0)-recordingPageBytes {
			return errInvalidRecording
		}
		h, b, err := p.fetch(p.ctx, from, from+recordingPageBytes, after)
		if err != nil {
			if isRecordingExpired(err) {
				if herr := p.healFromLiveState(p.ctx); herr != nil {
					return herr
				}
				after = ""
				continue
			}
			return err
		}
		after = h.EventCursor
		if err = p.feedRecording(h, b, termemu.SourceLive); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = h.End
		p.head = max(p.head, h.End)
		p.mu.Unlock()
		if len(b) < recordingPageBytes {
			return nil
		}
	}
}
func (p *paneActor) recover(ctx context.Context, from, through uint64, historical bool, after string) error {
	source := termemu.SourceLive
	if historical {
		source = termemu.SourceReplay
	}
	for from < through {
		end := pageEnd(from, through)
		h, b, err := p.fetch(ctx, from, end, after)
		if err != nil {
			if isRecordingExpired(err) {
				if herr := p.healFromLiveState(ctx); herr != nil {
					return herr
				}
				p.mu.Lock()
				frontier := p.frontier
				p.mu.Unlock()
				if frontier < through {
					return fmt.Errorf("%w: checkpoint did not cover the gap", errRecordingExpired)
				}
				return nil
			}
			return err
		}
		if h.End != end {
			return fmt.Errorf("%w: unavailable interval", errInvalidRecording)
		}
		if err = p.feedRecording(h, b, source); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = end
		p.head = max(p.head, end)
		p.mu.Unlock()
		after = h.EventCursor
		from = end
	}
	return nil
}
func (p *paneActor) fetch(ctx context.Context, from, through uint64, after string) (wireproto.RecordingHeader, []byte, error) {
	// Requests are cancellable. Permanent/malformed responses never spin forever.
	return p.api.recording(ctx, p.spec.Key.ID, p.epochValue(), from, through, after)
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
	if exited {
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
		if err := p.resizeEmulator(in.Cols, in.Rows); err != nil {
			return err
		}
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
		if p.history != nil {
			target = p.history
		}
		p.mu.Lock()
		historyRows := p.frame.History
		p.mu.Unlock()
		if p.history != nil && in.Scroll > 0 && p.historyOffset+in.Scroll >= 0 {
			p.returnLive()
			return nil
		}
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
	if p.history != nil {
		target = p.history
	}
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
	older := p.frontier > p.oldest
	if p.history != nil {
		older = p.historyThrough > p.oldest
	}
	p.historyView = paneHistoryView{
		Older:    older && (!frame.Alt || p.history != nil),
		NearTop:  frame.History+p.historyOffset <= frame.Rows,
		Browsing: p.history != nil,
		Loading:  p.historyPending,
	}
	p.lastPaint = time.Now()
	p.mouseButton, p.mouseMotion, p.mouseAny = mb, mm, ma
	p.mu.Unlock()
	p.dirty = false
	p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneOutput})
	return nil
}
