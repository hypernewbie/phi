package phicmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// PaneEvent is one decoded pane frame of interest to a client.
type PaneEvent struct {
	Kind string // "attach", "output", "title", "exit", "bridge_state", "drop"
	Data []byte // output payload bytes; nil otherwise
	Exit int32  // exit code, for "exit"
}

// Pane is one /ws/pane/<id> connection. The server pushes the attach
// frame on connect (live-only), then bounded output spans and lifecycle
// frames. Input is sent verbatim; phi-cmd interprets nothing.
type Pane struct {
	conn *websocket.Conn

	seq     atomic.Uint64
	maximum uint64 // last contiguous output byte received

	mu      sync.Mutex
	frames  chan PaneEvent
	dead    chan struct{}
	once    sync.Once
	deadErr error
}

// ErrPaneClosed marks a pane socket that ended.
var ErrPaneClosed = errors.New("phi-cmd: pane socket closed")

// AttachPane dials one live pane. The access cookie rides the upgrade.
func AttachPane(ctx context.Context, h *HTTP, paneID string) (*Pane, error) {
	scheme := "ws"
	if h.Base.Scheme == "https" {
		scheme = "wss"
	}
	header := http.Header{}
	if h.Client.Jar != nil {
		if u, err := h.Base.Parse("/ws/pane/" + paneID); err == nil && u != nil {
			for _, cookie := range h.Client.Jar.Cookies(u) {
				header.Add("Cookie", cookie.Name+"="+cookie.Value)
			}
		}
	}
	dialer := &websocket.Dialer{
		HandshakeTimeout: 30 * time.Second,
		Subprotocols:     []string{wireproto.TerminalSubprotocol},
	}
	conn, resp, err := dialer.DialContext(ctx, scheme+"://"+h.Base.Host+"/ws/pane/"+paneID, header)
	if err != nil {
		if resp != nil {
			if resp.StatusCode == http.StatusNotFound {
				return nil, fmt.Errorf("%w: pane %s", ErrNotFound, paneID)
			}
			if resp.StatusCode == http.StatusUnauthorized {
				return nil, fmt.Errorf("%w: pane socket refused", ErrUnauthorized)
			}
			if resp.StatusCode == http.StatusUpgradeRequired {
				return nil, fmt.Errorf("phi-cmd: pane socket requires subprotocol %s", wireproto.TerminalSubprotocol)
			}
		}
		return nil, fmt.Errorf("phi-cmd: pane dial: %w", err)
	}
	p := &Pane{conn: conn, frames: make(chan PaneEvent, 128), dead: make(chan struct{})}
	go p.readLoop()
	return p, nil
}

func (p *Pane) readLoop() {
	defer p.Close()
	for {
		mt, raw, err := wireproto.ReadBoundedMessage(p.conn, wireproto.MaxTerminalMessageBytes)
		if err != nil {
			p.fail(err)
			return
		}
		if mt != websocket.BinaryMessage {
			p.fail(fmt.Errorf("phi-cmd: text frame on pane socket"))
			return
		}
		frame, err := wireproto.DecodeServerFrame(raw)
		if err != nil {
			p.fail(err)
			return
		}
		var event PaneEvent
		switch frame.GetPayload().(type) {
		case *wspb.TerminalServerFrame_Attach:
			event.Kind = "attach"
			if head := frame.GetAttach(); head != nil && head.Head != nil {
				p.mu.Lock()
				p.maximum = head.GetHead()
				p.mu.Unlock()
			}
		case *wspb.TerminalServerFrame_Output:
			out := frame.GetOutput()
			start, data, err := outputSpan(out)
			if err != nil {
				p.fail(err)
				return
			}
			p.mu.Lock()
			if start != p.maximum {
				// A gap means a dropped span; report it rather than glue
				// unrelated bytes together.
				p.mu.Unlock()
				p.fail(fmt.Errorf("phi-cmd: pane output gap (have %d, got %d)", p.maximum, start))
				return
			}
			p.maximum = start + uint64(len(data))
			p.mu.Unlock()
			event = PaneEvent{Kind: "output", Data: data}
		case *wspb.TerminalServerFrame_Title:
			event.Kind = "title"
		case *wspb.TerminalServerFrame_Exit:
			event = PaneEvent{Kind: "exit", Exit: frame.GetExit().GetCode()}
		case *wspb.TerminalServerFrame_BridgeState:
			event.Kind = "bridge_state"
		case *wspb.TerminalServerFrame_DropNotice:
			event.Kind = "drop"
		default:
			continue // geometry, pong, settlement, notification: not pane-cmd concerns
		}
		select {
		case p.frames <- event:
		default:
			// A slow consumer must not stall the read pump.
		}
	}
}

func outputSpan(out *wspb.TerminalOutput) (uint64, []byte, error) {
	if out == nil || out.Start == nil {
		return 0, nil, fmt.Errorf("phi-cmd: pane output span missing start")
	}
	return out.GetStart(), out.GetData(), nil
}

func (p *Pane) fail(err error) {
	p.once.Do(func() {
		p.deadErr = err
		close(p.dead)
	})
}

// Close ends the pane socket.
func (p *Pane) Close() {
	p.once.Do(func() {
		p.deadErr = ErrPaneClosed
		close(p.dead)
	})
	_ = p.conn.Close()
}

// Frames is the pane event stream.
func (p *Pane) Frames() <-chan PaneEvent { return p.frames }

// Done reports socket end; Err returns why.
func (p *Pane) Done() <-chan struct{} { return p.dead }

func (p *Pane) Err() error {
	select {
	case <-p.dead:
		return p.deadErr
	default:
		return nil
	}
}

// SendInput writes raw bytes to the pane verbatim.
func (p *Pane) SendInput(data []byte) error {
	for _, chunk := range wireproto.ChunkInput(data) {
		frame, err := wireproto.EncodeInputFrame(chunk)
		if err != nil {
			return err
		}
		if err := p.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			return err
		}
	}
	return nil
}
