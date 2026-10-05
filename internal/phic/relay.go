package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

var errProtocol = errors.New("phic: invalid terminal protocol")

type wireAttach struct {
	Header     wireproto.AttachHeadHeader
	Checkpoint []byte
}

type relayTerminal interface {
	ReadContext(context.Context, []byte) (int, error)
	Write([]byte) (int, error)
	Size() (int, int, error)
	Resizes() <-chan Resize
}

// Relay retains only an output frontier, not a client recording. One reader
// delivers output; one input worker writes the socket. Closing wakes both.
type Relay struct {
	tty       relayTerminal
	api       *apiClient
	mu        sync.Mutex
	conn      *websocket.Conn
	header    wireAttach
	written   uint64
	epoch     uint64
	fresh     bool
	repaint   *repaintFilter
	viewInput []byte
	pane      string
	cancel    context.CancelFunc
}

func NewRelay(tty relayTerminal, api *apiClient) *Relay { return &Relay{tty: tty, api: api} }

func (r *Relay) Connect(ctx context.Context, pane string) (wireAttach, error) {
	r.mu.Lock()
	already := r.conn != nil
	r.mu.Unlock()
	if already {
		return wireAttach{}, errors.New("phic: relay already connected")
	}
	u := r.api.base.String() + "/ws/pane/" + url.PathEscape(pane) + "?term_proto=hot-v1"
	wsURL, err := mustWebsocketURL(u)
	if err != nil {
		return wireAttach{}, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, Jar: r.api.http.Jar}
	conn, resp, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		if resp != nil {
			if resp.StatusCode < 400 {
				return wireAttach{}, fmt.Errorf("%w: WebSocket %s", errProtocol, resp.Status)
			}
			return wireAttach{}, &apiError{Code: resp.StatusCode, Message: "WebSocket: " + resp.Status}
		}
		return wireAttach{}, fmt.Errorf("phic: connect: %w", err)
	}
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancel()
	conn.SetReadLimit(4 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err == nil && mt != websocket.BinaryMessage {
		err = fmt.Errorf("%w: attach is not binary", errProtocol)
	}
	var head wireAttach
	if err == nil {
		head.Header, head.Checkpoint, err = ParseAttachHead(msg)
		if err != nil {
			err = fmt.Errorf("%w: %v", errProtocol, err)
		}
	}
	if err != nil {
		_ = conn.Close()
		return wireAttach{}, err
	}
	// Only the socket reader touches read deadlines. Input cannot poison reads.
	_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	r.mu.Lock()
	r.conn = conn
	r.header = head
	r.pane = pane
	r.mu.Unlock()
	return head, nil
}

func (r *Relay) send(frame []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn == nil {
		return errors.New("phic: input disconnected; not retried because delivery is ambiguous")
	}
	_ = r.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return r.conn.WriteMessage(websocket.BinaryMessage, frame)
}
func (r *Relay) Close() {
	r.mu.Lock()
	cancel := r.cancel
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	r.disconnect()
}

func (r *Relay) disconnect() {
	r.mu.Lock()
	conn := r.conn
	r.conn = nil
	r.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (r *Relay) Run(ctx context.Context) error {
	if r.conn == nil {
		return errors.New("phic: relay not connected")
	}
	ctx, cancel := context.WithCancel(ctx)
	r.mu.Lock()
	r.cancel = cancel
	r.mu.Unlock()
	// Closing is safe concurrently with a blocked socket reader.
	closed := make(chan struct{})
	go func() { <-ctx.Done(); r.Close(); close(closed) }()
	inputDone := make(chan error, 1)
	ready := make(chan struct{})
	go func() {
		select {
		case <-ready:
		case <-ctx.Done():
			inputDone <- ctx.Err()
			return
		}
		err := r.runInput(ctx)
		inputDone <- err
		cancel()
	}()
	defer func() { cancel(); <-closed; <-inputDone }()
	cols, rows, err := r.tty.Size()
	if err != nil || cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		return errors.New("phic: terminal has no usable geometry")
	}
	r.epoch = r.header.Header.Epoch
	if r.header.Header.Oldest != 0 {
		return errors.New("phic: recording prefix unavailable; cannot reconstruct terminal")
	}
	// New processes need their startup replies. A reused pane is a display
	// rebuild: suppress old queries, not native keys or new live queries.
	if r.fresh {
		close(ready)
	} else {
		r.repaint = &repaintFilter{}
	}
	err = r.send(wireproto.EncodeResizeFrame(uint16(cols), uint16(rows)))
	if err == nil {
		err = r.recoverOutput(ctx, r.pane, r.header.Header.Head, !r.fresh)
	}
	if !r.fresh {
		close(ready)
	}
	if err == nil {
		err = r.live(ctx, r.pane)
	}
	if ctx.Err() != nil {
		select {
		case inputErr := <-inputDone:
			inputDone <- inputErr
			if errors.Is(inputErr, errDetach) || errors.Is(inputErr, context.Canceled) {
				return nil
			}
			if inputErr != nil {
				return inputErr
			}
		default:
		}
		if errors.Is(err, context.Canceled) {
			return nil
		}
	}
	return err
}

func (r *Relay) live(ctx context.Context, pane string) error {
	for {
		r.mu.Lock()
		conn := r.conn
		r.mu.Unlock()
		if conn == nil {
			return ctx.Err()
		}
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			r.disconnect()
			if err := r.reconnect(ctx, pane); err != nil {
				return err
			}
			continue
		}
		if mt != websocket.BinaryMessage || len(msg) == 0 {
			return errors.New("phic: malformed terminal frame")
		}
		switch msg[0] {
		case wireproto.FrameLiveOutput:
			start, data, err := ParseLiveOutput(msg)
			if err != nil {
				return err
			}
			if start > r.written {
				if err := r.recover(ctx, pane, start); err != nil {
					return err
				}
			}
			end := start + uint64(len(data))
			if end <= r.written {
				continue
			}
			data = data[r.written-start:]
			if err := r.output(ctx, data, false); err != nil {
				return err
			}
		case wireproto.FrameExit:
			// Drain retained output before reporting the backend status.
			if len(msg) != 2 {
				return fmt.Errorf("%w: invalid exit frame", errProtocol)
			}
			if err := r.drainExit(ctx, pane); err != nil {
				return err
			}
			if msg[1] != 0 {
				return &ExitError{Code: int(msg[1])}
			}
			return nil
		case 0x02: // JSON control. No terminal output; gaps are caught by sequence.
			if err := r.control(ctx, pane, msg[1:]); err != nil {
				return err
			}
		case 0x03: // keepalive
		case 0x01, 0x08:
			return errors.New("phic: unsequenced output or repeated attach head")
		default: // notifications are not terminal bytes
		}
	}
}

func (r *Relay) reconnect(ctx context.Context, pane string) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
		head, err := r.Connect(ctx, pane)
		if err != nil {
			if permanent(err) {
				return err
			}
			continue
		}
		if head.Header.Epoch != r.epoch {
			return errors.New("phic: recording epoch changed; detach rather than merge different terminal states")
		}
		if r.written < head.Header.Oldest || r.written > head.Header.Head {
			return errors.New("phic: written frontier is outside retained recording")
		}
		if err := r.recover(ctx, pane, head.Header.Head); err != nil {
			return err
		}
		cols, rows, err := r.tty.Size()
		if err != nil {
			return err
		}
		return r.send(wireproto.EncodeResizeFrame(uint16(cols), uint16(rows)))
	}
}
func permanent(err error) bool {
	if errors.Is(err, errProtocol) {
		return true
	}
	var e *apiError
	return errors.As(err, &e) && e.Code >= 400 && e.Code < 500 && e.Code != http.StatusTooManyRequests
}

func (r *Relay) write(ctx context.Context, data []byte) error {
	for len(data) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch := data
		if len(batch) > 64<<10 {
			batch = batch[:64<<10]
		}
		n, err := r.tty.Write(batch)
		if n < 0 || n > len(batch) {
			return errors.New("phic: invalid terminal write count")
		}
		r.written += uint64(n)
		data = data[n:]
		if err != nil {
			return fmt.Errorf("phic: terminal write: %w", err)
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	return nil
}
func (r *Relay) runInput(ctx context.Context) error {
	parser := inputParser{}
	buf := make([]byte, 4096)
	for {
		select {
		case size := <-r.tty.Resizes():
			if size.Cols != 0 && size.Rows != 0 {
				if err := r.send(wireproto.EncodeResizeFrame(size.Cols, size.Rows)); err != nil {
					return err
				}
			}
		default:
		}
		readCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		n, err := r.tty.ReadContext(readCtx, buf)
		cancel()
		var out []byte
		var commandErr error
		if n > 0 {
			out, commandErr = parser.Feed(buf[:n])
		}
		if errors.Is(err, context.DeadlineExceeded) && len(parser.sequence) > 0 {
			out = append(out, parser.FlushEscape()...)
		}
		if len(out) != 0 {
			if err := r.send(EncodeInputFrame(out)); err != nil {
				return err
			}
		}
		if commandErr != nil {
			r.viewInput = parser.rest
			return commandErr
		}
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
	}
}
