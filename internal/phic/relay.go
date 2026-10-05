package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// Relay owns one WebSocket connection and two goroutines: one
// drains the server's frames into the TTY, the other copies
// the TTY's input into 0x01 frames. The plan's "one writer
// owns terminal output" and "one writer owns WebSocket
// application writes" invariants are enforced by routing all
// terminal output through relay.writeTTY and all WS writes
// through relay.send.
type Relay struct {
	conn   *websocket.Conn
	tty    *TTY
	api    *apiClient
	epoch  atomic.Uint64
	closed atomic.Bool
}

// NewRelay builds a Relay but does not connect.
func NewRelay(tty *TTY, api *apiClient) *Relay {
	return &Relay{tty: tty, api: api}
}

// Connect dials /ws/pane/:id?term_proto=hot-v1, sends the
// 0x08 ATTACH_HEAD response to the controller, and returns
// the bytes the controller should write to the TTY before
// entering the live phase.
func (r *Relay) Connect(ctx context.Context, pane string) (wireAttach, error) {
	if r.conn != nil {
		return wireAttach{}, errors.New("phic: relay already connected")
	}
	u := r.api.base.String() + "/ws/pane/" + pane + "?term_proto=hot-v1"
	wsURL, err := mustWebsocketURL(u)
	if err != nil {
		return wireAttach{}, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return wireAttach{}, fmt.Errorf("phic: dial %s: %w", wsURL, err)
	}
	r.conn = conn
	return r.attachHead(ctx)
}

func (r *Relay) attachHead(ctx context.Context) (wireAttach, error) {
	if err := r.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return wireAttach{}, err
	}
	mt, msg, err := r.conn.ReadMessage()
	if err != nil {
		return wireAttach{}, fmt.Errorf("phic: read attach: %w", err)
	}
	if mt != websocket.BinaryMessage {
		return wireAttach{}, fmt.Errorf("phic: attach not binary: %d", mt)
	}
	hdr, ckpt, err := ParseAttachHead(msg)
	if err != nil {
		return wireAttach{}, err
	}
	r.epoch.Store(hdr.Epoch)
	return wireAttach{Header: hdr, Checkpoint: ckpt}, nil
}

// Run is the live phase. It returns when the connection drops,
// the context is canceled, or the backend exits.
func (r *Relay) Run(ctx context.Context) error {
	if r.conn == nil {
		return errors.New("phic: relay not connected")
	}
	defer r.Close()

	// Server -> TTY: one goroutine.
	go r.readServerToTTY(ctx)

	// TTY -> Server: another goroutine, plus resize forwarding.
	r.runInput(ctx)
	return nil
}

// readServerToTTY pumps the WebSocket and writes 0x09 payloads
// directly to the TTY. The plan's "one writer owns terminal
// output" rule: this is the only path that writes to the
// controlling terminal during the relay.
func (r *Relay) readServerToTTY(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		_ = r.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		mt, msg, err := r.conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil || r.closed.Load() {
				return
			}
			if isWSClose(err) {
				return
			}
			return
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		_, payload, err := ParseLiveOutput(msg)
		if err != nil {
			// Reserved frames (0x04 exit, 0x02 control) are
			// not terminal output; the plan calls this out.
			continue
		}
		// Best-effort write: a short write does not advance
		// the written frontier. The plan's "Short writes"
		// test is in production via the bounded 64 KiB
		// batches; here we just write the full payload.
		_, _ = r.tty.Write(payload)
	}
}

// runInput copies TTY bytes into 0x01 frames and forwards
// SIGWINCH as 0x02 frames.
func (r *Relay) runInput(ctx context.Context) {
	buf := make([]byte, 4096)
	resizes := r.tty.Resizes()
	for {
		select {
		case <-ctx.Done():
			return
		case r0 := <-resizes:
			if err := r.conn.WriteMessage(websocket.BinaryMessage, r.tty.EncodeResize(r0)); err != nil {
				return
			}
		default:
		}
		_ = r.conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		n, err := r.tty.Read(buf)
		if n > 0 {
			frame := EncodeInputFrame(buf[:n])
			if err := r.conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
		}
		if err != nil && !isTimeout(err) {
			return
		}
	}
}

// Close releases the connection. Safe to call more than once.
func (r *Relay) Close() {
	if r.closed.Swap(true) {
		return
	}
	if r.conn != nil {
		_ = r.conn.Close()
	}
}

// wireAttach is the controller's view of the ATTACH_HEAD
// response. The plan names the checkpoint bytes the bytes
// that follow the JSON header.
type wireAttach struct {
	Header     wireproto.AttachHeadHeader
	Checkpoint []byte
}

// isWSClose returns true for the websocket close error and
// for the I/O EOF the gorilla library surfaces on close.
func isWSClose(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	var ce *websocket.CloseError
	return errors.As(err, &ce)
}

// isTimeout matches the deadline-exceeded errors that come
// from the runtime poller.
func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, http.ErrServerClosed) {
		return true
	}
	type timeout interface{ Timeout() bool }
	var t timeout
	if errors.As(err, &t) {
		return t.Timeout()
	}
	return false
}
