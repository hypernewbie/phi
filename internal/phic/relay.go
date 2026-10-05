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

// Relay owns one WebSocket and two goroutines: server -> TTY
// and TTY -> server. The plan's invariants: one writer owns
// terminal output, one writer owns WebSocket writes.
type Relay struct {
	conn   *websocket.Conn
	tty    *TTY
	api    *apiClient
	closed atomic.Bool
}

func NewRelay(tty *TTY, api *apiClient) *Relay {
	return &Relay{tty: tty, api: api}
}

// Connect dials /ws/pane/:id?term_proto=hot-v1 and reads the
// ATTACH_HEAD response.
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
	return wireAttach{Header: hdr, Checkpoint: ckpt}, nil
}

// Run is the live phase. Returns on disconnect, signal, or error.
func (r *Relay) Run(ctx context.Context) error {
	if r.conn == nil {
		return errors.New("phic: relay not connected")
	}
	defer r.Close()
	go r.readServerToTTY(ctx)
	r.runInput(ctx)
	return nil
}

// readServerToTTY writes 0x09 payloads to the TTY. Reserved
// frames (0x04 exit, 0x02 control) are not terminal output.
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
			continue
		}
		_, _ = r.tty.Write(payload)
	}
}

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

func (r *Relay) Close() {
	if r.closed.Swap(true) {
		return
	}
	if r.conn != nil {
		_ = r.conn.Close()
	}
}

// wireAttach is the ATTACH_HEAD response.
type wireAttach struct {
	Header     wireproto.AttachHeadHeader
	Checkpoint []byte
}

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
