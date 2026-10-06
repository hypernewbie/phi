package phic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// paneKey identifies one attached pane at one origin. Pane IDs are only
// unique within a server, so the canonical origin is part of the key.
type paneKey struct {
	Origin string
	ID     string
}

func (k paneKey) String() string { return k.Origin + "#" + k.ID }

// paneSpec is everything needed to attach or label a pane.
type paneSpec struct {
	Key          paneKey
	Title        string
	Coder        string
	Dir          string
	Workspace    string
	OpenCodeMode string
	Fresh        bool // spawned by this client: startup replies are live
	Cols         int
	Rows         int
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
	Key    paneKey
	Kind   paneEventKind
	Status string
	Code   int
	Title  string
	PWD    string
}

type paneInputKind int

const (
	paneInputKey paneInputKind = iota
	paneInputMouse
	paneInputPaste
	paneInputResize
	paneInputFocus
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
	Paste   []byte
	Cols    int
	Rows    int
	Focused bool
}

// paneActor owns exactly one terminal emulator plus one WebSocket attachment.
// Every emulator call happens on its owner goroutine; the UI only reads copied
// frames and enqueues input requests.
type paneActor struct {
	spec   paneSpec
	api    *apiClient
	emu    termemu.Terminal
	build  func(termemu.Options) (termemu.Terminal, error)
	events chan<- paneEvent

	mu        sync.Mutex
	frontier  uint64
	head      uint64
	epoch     uint64
	frame     termemu.Frame
	frameOK   bool
	lastPaint time.Time
	cols      int
	rows      int

	connMu sync.Mutex
	conn   *websocket.Conn

	outbox  chan []byte
	inbox   chan paneInput
	frames  chan []byte
	readErr chan error

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	exited         bool
	exitCode       int
	closed         bool
	uncertainInput bool
	reconnectCount int

	// dirty marks emulator state that has not been snapshotted yet. The
	// owner goroutine paints only when this is set, so an idle pane costs no
	// native snapshots.
	dirty bool

	// mouse modes are cached from the owner goroutine. The UI reads these
	// flags instead of calling into the emulator off-owner.
	mouseButton bool
	mouseMotion bool
	mouseAny    bool
}

func newPaneActor(parent context.Context, api *apiClient, spec paneSpec, events chan<- paneEvent, build func(termemu.Options) (termemu.Terminal, error)) (*paneActor, error) {
	if spec.Cols <= 0 || spec.Rows <= 0 {
		return nil, fmt.Errorf("phic: pane geometry must be positive")
	}
	ctx, cancel := context.WithCancel(parent)
	p := &paneActor{
		spec:    spec,
		api:     api,
		build:   build,
		events:  events,
		cols:    spec.Cols,
		rows:    spec.Rows,
		outbox:  make(chan []byte, 256),
		inbox:   make(chan paneInput, 128),
		frames:  make(chan []byte, 64),
		readErr: make(chan error, 8),
		ctx:     ctx,
		cancel:  cancel,
		done:    make(chan struct{}),
	}
	go p.run()
	go p.writeLoop()
	return p, nil
}

// sendEvent reports actor state to the UI without ever blocking the actor.
func (p *paneActor) sendEvent(ev paneEvent) {
	if p.events == nil {
		return
	}
	select {
	case p.events <- ev:
	case <-p.ctx.Done():
	default:
		// A full UI queue is a slow UI; dropping status is safer than
		// stalling terminal admission. Output events coalesce anyway.
	}
}

func (p *paneActor) newTerminal(cols, rows int) (termemu.Terminal, error) {
	build := p.build
	if build == nil {
		build = termemu.NewGhostty
	}
	return build(termemu.Options{
		Cols:            cols,
		Rows:            rows,
		ScrollbackBytes: 64 << 20,
		ScrollbackLines: 10000,
		Events: termemu.EventOptions{
			OnReply: func(b []byte) {
				if b == nil {
					p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "terminal reply buffer overflowed"})
					return
				}
				p.enqueue(EncodeInputFrame(b))
			},
			OnTitle: func(s string) { p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneMetadata, Title: s}) },
			OnPWD:   func(s string) { p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneMetadata, PWD: s}) },
			OnBell:  func() { p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "bell"}) },
		},
	})
}

// enqueue puts bytes on the ordered writer queue. It never blocks the actor
// for long; a full queue is reported rather than silently dropping input.
func (p *paneActor) enqueue(b []byte) {
	if len(b) == 0 {
		return
	}
	select {
	case p.outbox <- b:
	default:
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "input queue full"})
	}
}

func (p *paneActor) setConn(c *websocket.Conn) {
	p.connMu.Lock()
	p.conn = c
	p.connMu.Unlock()
}

func (p *paneActor) getConn() *websocket.Conn {
	p.connMu.Lock()
	defer p.connMu.Unlock()
	return p.conn
}

func (p *paneActor) writeLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case b := <-p.outbox:
			c := p.getConn()
			if c == nil {
				p.markUncertain("input write: not connected")
				continue
			}
			_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.WriteMessage(websocket.BinaryMessage, b); err != nil {
				// Delivery is ambiguous. Never retry an input frame; surface
				// the uncertainty and wait for a clean connection.
				p.markUncertain("input write failed; delivery is uncertain")
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

// Input requests. Each one is encoded on the owner goroutine with the current
// emulator modes, so the UI never touches native state.
func (p *paneActor) sendKey(ev termemu.KeyEvent) {
	select {
	case p.inbox <- paneInput{Kind: paneInputKey, Key: ev}:
	default:
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: "input backlog"})
	}
}

func (p *paneActor) sendMouse(action termemu.MouseAction, button termemu.MouseButton, mods termemu.Modifier, x, y int) {
	in := paneInput{Kind: paneInputMouse}
	in.Mouse.Action, in.Mouse.Button, in.Mouse.Mods, in.Mouse.X, in.Mouse.Y = action, button, mods, x, y
	select {
	case p.inbox <- in:
	default:
	}
}

func (p *paneActor) sendPaste(b []byte) {
	select {
	case p.inbox <- paneInput{Kind: paneInputPaste, Paste: b}:
	default:
	}
}

func (p *paneActor) resize(cols, rows int) {
	select {
	case p.inbox <- paneInput{Kind: paneInputResize, Cols: cols, Rows: rows}:
	default:
	}
}

// snapshotCopy returns the latest painted frame. The frame is a deep copy
// produced by the owner goroutine, so the UI can render it freely.
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

// close detaches. Detach never sends DELETE and never pins a pane.
func (p *paneActor) close() {
	p.cancel()
	p.setConn(nil)
	<-p.done
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		if p.emu != nil {
			_ = p.emu.Close()
		}
	}
	p.mu.Unlock()
}

func (p *paneActor) dial(ctx context.Context) (*websocket.Conn, wireAttach, error) {
	u := p.api.base.String() + "/ws/pane/" + url.PathEscape(p.spec.Key.ID) + "?term_proto=hot-v1"
	wsURL, err := mustWebsocketURL(u)
	if err != nil {
		return nil, wireAttach{}, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, Jar: p.api.http.Jar}
	conn, resp, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		if resp != nil {
			return nil, wireAttach{}, &apiError{Code: resp.StatusCode, Message: "WebSocket: " + resp.Status}
		}
		return nil, wireAttach{}, fmt.Errorf("phic: connect: %w", err)
	}
	conn.SetReadLimit(4 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err == nil && mt != websocket.BinaryMessage {
		err = fmt.Errorf("%w: attach is not binary", errProtocol)
	}
	var head wireAttach
	if err == nil {
		head.Header, head.Checkpoint, err = ParseAttachHead(msg)
	}
	if err != nil {
		_ = conn.Close()
		return nil, wireAttach{}, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	return conn, head, nil
}

func (p *paneActor) readLoop(conn *websocket.Conn) {
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			select {
			case p.readErr <- err:
			case <-p.ctx.Done():
			}
			return
		}
		select {
		case p.frames <- msg:
		case <-p.ctx.Done():
			return
		}
	}
}

// run is the owner goroutine. It serializes connect, replay, live output,
// input encoding, resize, and disposal.
func (p *paneActor) run() {
	defer close(p.done)
	defer p.setConn(nil)

	emu, err := p.newTerminal(p.cols, p.rows)
	if err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
		return
	}
	p.mu.Lock()
	p.emu = emu
	p.mu.Unlock()

	if err := p.attachAndRun(); err != nil && !errors.Is(err, context.Canceled) && p.ctx.Err() == nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneError, Status: err.Error()})
	}
}

// attachAndRun connects, bootstraps, and consumes frames until detach. A
// recoverable read failure reconnects with bounded backoff; an epoch change
// rebuilds the emulator instead of merging different terminal states.
func (p *paneActor) attachAndRun() error {
	backoff := 200 * time.Millisecond
	for {
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
		conn, head, err := p.dial(p.ctx)
		if err != nil {
			if permanent(err) {
				return err
			}
			select {
			case <-p.ctx.Done():
				return p.ctx.Err()
			case <-time.After(backoff):
			}
			if backoff < 3*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = 200 * time.Millisecond
		p.setConn(conn)
		go p.readLoop(conn)
		if err := p.bootstrap(head); err != nil {
			_ = conn.Close()
			p.setConn(nil)
			if permanent(err) {
				return err
			}
			select {
			case <-p.ctx.Done():
				return p.ctx.Err()
			case <-time.After(backoff):
			}
			continue
		}
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "connected"})
		err = p.consume(conn)
		p.setConn(nil)
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
		if errors.Is(err, errPaneExited) {
			return nil
		}
		if permanent(err) {
			return err
		}
		p.reconnectCount++
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "reconnecting"})
		select {
		case <-p.ctx.Done():
			return p.ctx.Err()
		case <-time.After(backoff):
		}
		if backoff < 3*time.Second {
			backoff *= 2
		}
	}
}

// bootstrap replays the historical prefix into a fresh or reconnected
// emulator, then prepares the live frontier.
func (p *paneActor) bootstrap(head wireAttach) error {
	h := head.Header
	p.mu.Lock()
	epoch := p.epoch
	frontier := p.frontier
	exited := p.exited
	p.mu.Unlock()

	if exited {
		return errPaneExited
	}
	if epoch != 0 && h.Epoch != epoch {
		// A different recording epoch cannot share terminal state. Rebuild
		// from the start of the new recording rather than mixing screens.
		if err := p.rebuildEmulator(); err != nil {
			return err
		}
		frontier = 0
	}
	if h.Oldest != 0 {
		return errors.New("phic: recording prefix unavailable; cannot reconstruct terminal")
	}
	if frontier > h.Head {
		return fmt.Errorf("%w: frontier exceeds attach head", errProtocol)
	}
	p.mu.Lock()
	p.epoch = h.Epoch
	p.head = h.Head
	p.mu.Unlock()
	if frontier < h.Head {
		if err := p.recover(p.ctx, frontier, h.Head, true); err != nil {
			return err
		}
	}
	// Fresh panes need live startup replies. Existing panes treat everything
	// before the attach head as historical.
	cols, rows := p.geometry()
	p.enqueue(wireproto.EncodeResizeFrame(uint16(cols), uint16(rows)))
	p.mu.Lock()
	p.frontier = h.Head
	p.mu.Unlock()
	return nil
}

func (p *paneActor) rebuildEmulator() error {
	cols, rows := p.geometry()
	emu, err := p.newTerminal(cols, rows)
	if err != nil {
		return err
	}
	p.mu.Lock()
	old := p.emu
	p.emu = emu
	p.frame = termemu.Frame{}
	p.frameOK = false
	p.frontier = 0
	p.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	return nil
}

func (p *paneActor) geometry() (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cols, p.rows
}

var errPaneExited = errors.New("phic: pane exited")

// consume processes frames and input until the pane exits or the connection
// drops.
func (p *paneActor) consume(conn *websocket.Conn) error {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	paint := time.NewTicker(16 * time.Millisecond)
	defer paint.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return p.ctx.Err()
		case msg := <-p.frames:
			if err := p.handleFrame(msg); err != nil {
				if errors.Is(err, errPaneExited) {
					return errPaneExited
				}
				return err
			}
		case err := <-p.readErr:
			return fmt.Errorf("phic: output disconnected: %w", err)
		case in := <-p.inbox:
			if err := p.handleInput(in); err != nil {
				return err
			}
		case <-paint.C:
			if p.takeDirty() {
				p.refreshFrame()
			}
		case <-ping.C:
			select {
			case p.outbox <- []byte{wireproto.FramePing}:
			default:
			}
		}
	}
}

func (p *paneActor) handleFrame(msg []byte) error {
	if len(msg) == 0 {
		return nil
	}
	switch msg[0] {
	case wireproto.FrameLiveOutput:
		start, data, err := ParseLiveOutput(msg)
		if err != nil {
			return err
		}
		p.mu.Lock()
		frontier := p.frontier
		p.mu.Unlock()
		if start > frontier {
			if err := p.recover(p.ctx, frontier, start, true); err != nil {
				return err
			}
		}
		end := start + uint64(len(data))
		if end <= frontier {
			return nil
		}
		if start < frontier {
			data = data[frontier-start:]
		}
		if err := p.feed(data, termemu.SourceLive); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = end
		if end > p.head {
			p.head = end
		}
		p.mu.Unlock()
		p.markOutput()
	case wireproto.FrameExit:
		if len(msg) != 2 {
			return fmt.Errorf("%w: invalid exit frame", errProtocol)
		}
		if err := p.drainExit(); err != nil {
			return err
		}
		p.mu.Lock()
		p.exited = true
		p.exitCode = int(msg[1])
		p.mu.Unlock()
		p.refreshFrame()
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneExited, Code: int(msg[1])})
		return errPaneExited
	case 0x02: // JSON control. Gaps are caught by sequence.
		return p.control(msg[1:])
	case wireproto.FramePong: // keepalive
		return nil
	case wireproto.FrameAttachHead, wireproto.FrameInput:
		return fmt.Errorf("%w: unexpected frame 0x%x", errProtocol, msg[0])
	default:
		return nil
	}
	return nil
}

func (p *paneActor) control(data []byte) error {
	var v struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		return fmt.Errorf("phic: invalid control message: %w", err)
	}
	if v.Type == "output-dropped" {
		return p.drainExit()
	}
	return nil
}

// drainExit fetches any retained output the live stream has not delivered.
func (p *paneActor) drainExit() error {
	for {
		p.mu.Lock()
		frontier, head := p.frontier, p.head
		p.mu.Unlock()
		if frontier >= head {
			return nil
		}
		end := pageEnd(frontier, head)
		h, data, err := p.api.recording(p.ctx, p.spec.Key.ID, p.epochValue(), frontier, end)
		if err != nil {
			return err
		}
		if uint64(len(data)) != end-frontier {
			return fmt.Errorf("%w: unavailable exit interval", errInvalidRecording)
		}
		_ = h
		if err := p.feed(data, termemu.SourceReplay); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = end
		p.mu.Unlock()
	}
}

// recover fetches [from, through) in bounded pages and replays them.
func (p *paneActor) recover(ctx context.Context, from, through uint64, historical bool) error {
	for from < through {
		end := pageEnd(from, through)
		_, data, err := p.fetch(ctx, from, end)
		if err != nil {
			return err
		}
		if uint64(len(data)) != end-from {
			return fmt.Errorf("%w: unavailable interval", errInvalidRecording)
		}
		source := termemu.SourceLive
		if historical {
			source = termemu.SourceReplay
		}
		if err := p.feed(data, source); err != nil {
			return err
		}
		p.mu.Lock()
		p.frontier = end
		p.mu.Unlock()
		from = end
	}
	return nil
}

func (p *paneActor) fetch(ctx context.Context, from, through uint64) (wireproto.RecordingHeader, []byte, error) {
	for {
		h, data, err := p.api.recording(ctx, p.spec.Key.ID, p.epochValue(), from, through)
		if err == nil || permanent(err) || errors.Is(err, errInvalidRecording) {
			return h, data, err
		}
		select {
		case <-ctx.Done():
			return h, nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func (p *paneActor) epochValue() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch
}

// feed admits bytes to the emulator. Only the owner goroutine calls this.
func (p *paneActor) feed(data []byte, source termemu.Source) error {
	p.mu.Lock()
	emu := p.emu
	p.mu.Unlock()
	if emu == nil {
		return errors.New("phic: emulator unavailable")
	}
	if err := emu.Feed(data, source); err != nil {
		return err
	}
	p.mu.Lock()
	p.dirty = true
	p.mu.Unlock()
	return nil
}

// handleInput encodes UI input with the current terminal modes and queues it.
func (p *paneActor) handleInput(in paneInput) error {
	p.mu.Lock()
	emu := p.emu
	uncertain := p.uncertainInput
	exited := p.exited
	p.mu.Unlock()
	if emu == nil {
		return nil
	}
	if exited {
		return nil
	}
	switch in.Kind {
	case paneInputResize:
		if in.Cols <= 0 || in.Rows <= 0 {
			return nil
		}
		p.mu.Lock()
		if in.Cols == p.cols && in.Rows == p.rows {
			p.mu.Unlock()
			return nil
		}
		p.cols, p.rows = in.Cols, in.Rows
		p.mu.Unlock()
		if err := emu.Resize(in.Cols, in.Rows); err != nil {
			return err
		}
		p.mu.Lock()
		p.dirty = true
		p.mu.Unlock()
		p.enqueue(wireproto.EncodeResizeFrame(uint16(in.Cols), uint16(in.Rows)))
	case paneInputKey:
		if uncertain {
			return nil
		}
		b, err := emu.EncodeKey(in.Key)
		if err != nil {
			return err
		}
		if len(b) > 0 {
			p.enqueue(EncodeInputFrame(b))
		}
	case paneInputMouse:
		if uncertain {
			return nil
		}
		b, err := emu.EncodeMouse(in.Mouse.Action, in.Mouse.Button, in.Mouse.Mods, in.Mouse.X, in.Mouse.Y)
		if err != nil {
			return err
		}
		if len(b) > 0 {
			p.enqueue(EncodeInputFrame(b))
		}
	case paneInputPaste:
		if uncertain {
			return nil
		}
		b, err := emu.EncodePaste(in.Paste)
		if err != nil {
			return err
		}
		if len(b) > 0 {
			p.enqueue(EncodeInputFrame(b))
		}
	}
	return nil
}

// markOutput coalesces paint notifications.
func (p *paneActor) markOutput() {
	p.mu.Lock()
	due := time.Since(p.lastPaint) > 16*time.Millisecond
	p.mu.Unlock()
	if due {
		p.refreshFrame()
	}
	p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneOutput})
}

// takeDirty reports and clears the pending-paint flag. Owner goroutine only.
func (p *paneActor) takeDirty() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	dirty := p.dirty
	p.dirty = false
	return dirty
}

// refreshFrame snapshots the emulator into the UI-visible cache. Called only
// by the owner goroutine.
func (p *paneActor) refreshFrame() {
	p.mu.Lock()
	emu := p.emu
	if emu == nil || p.closed {
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	frame, err := emu.Snapshot()
	if err != nil {
		return
	}
	// Mode queries stay on the owner goroutine; the UI reads the cache.
	mb, _ := emu.Mode(termemu.ModeMouseButton)
	mm, _ := emu.Mode(termemu.ModeMouseMotion)
	ma, _ := emu.Mode(termemu.ModeMouseAny)
	p.mu.Lock()
	p.frame = frame
	p.frameOK = true
	p.lastPaint = time.Now()
	p.dirty = false
	p.mouseButton, p.mouseMotion, p.mouseAny = mb, mm, ma
	p.mu.Unlock()
}

// mouseOwned reports whether the backend currently claims mouse input. It
// reads a cache filled by the owner goroutine and never calls the emulator.
func (p *paneActor) mouseOwned() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.mouseButton || p.mouseMotion || p.mouseAny
}
