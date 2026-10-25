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
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

var errProtocol = errors.New("phic: invalid terminal protocol")

// recordingCursor is attachment metadata, not a client recording. It marks
// output already presented before a menu or a switch to another pane.
type recordingCursor struct {
	epoch   uint64
	through uint64
}

type wireAttach struct {
	Header *wspb.TerminalAttach
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
	keys      *inputParser
	previous  *recordingCursor
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
	u := r.api.base.String() + "/ws/pane/" + url.PathEscape(pane)
	wsURL, err := mustWebsocketURL(u)
	if err != nil {
		return wireAttach{}, err
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, Jar: r.api.http.Jar, Subprotocols: []string{wireproto.TerminalSubprotocol}}
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
	if conn.Subprotocol() != wireproto.TerminalSubprotocol {
		_ = conn.Close()
		return wireAttach{}, fmt.Errorf("%w: server did not select the terminal subprotocol", errProtocol)
	}
	conn.SetReadLimit(wireproto.MaxTerminalMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, msg, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
	if err == nil && mt != websocket.BinaryMessage {
		err = fmt.Errorf("%w: attach is not binary", errProtocol)
	}
	var head wireAttach
	if err == nil {
		head.Header, err = ParseAttachHead(msg)
		if err != nil {
			err = fmt.Errorf("%w: %v", errProtocol, err)
		}
	}
	if err != nil {
		closeWithCode(conn, closeCodeForReadError(err), "invalid attach")
		return wireAttach{}, err
	}
	// Only the socket reader touches read deadlines. Input cannot poison reads.
	_ = conn.SetReadDeadline(time.Now().Add(paneReadTimeout))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(paneReadTimeout))
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(paneWriteTimeout))
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
	_ = r.conn.SetWriteDeadline(time.Now().Add(paneWriteTimeout))
	return r.conn.WriteMessage(websocket.BinaryMessage, frame)
}

// sendResize encodes one resize request. Geometry comes from the local
// terminal; values outside the server's 1..65535 range are refused here
// instead of closing the stream.
func (r *Relay) sendResize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		return fmt.Errorf("%w: resize out of range", errProtocol)
	}
	frame, err := wireproto.EncodeResizeFrame(uint32(cols), uint32(rows))
	if err != nil {
		return err
	}
	return r.send(frame)
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
	r.epoch = r.header.Header.GetEpoch()
	// New processes need their startup replies. A reused pane is a display
	// rebuild: suppress old queries, not native keys or new live queries.
	if r.fresh {
		close(ready)
	} else {
		r.repaint = &repaintFilter{}
	}
	err = r.sendResize(cols, rows)
	seen := r.header.Header.GetHead()
	if r.previous != nil {
		if r.previous.epoch != r.epoch {
			seen = 0
		} else {
			seen = r.previous.through
			if seen > r.header.Header.GetHead() {
				err = fmt.Errorf("%w: remembered frontier exceeds head", errProtocol)
			}
		}
	}
	if r.fresh {
		seen = r.header.Header.GetHead()
	}
	if err == nil && seen < r.header.Header.GetOldest() {
		err = r.checkpointJump(ctx, r.pane)
	}
	if err == nil {
		err = r.recoverOutput(ctx, r.pane, seen, !r.fresh)
	}
	if !r.fresh {
		close(ready)
	}
	if err == nil && r.repaint != nil {
		// This prefix was already admitted into the source frontier, but the
		// lexer held it until the historical/live boundary was established.
		before := r.written
		err = r.write(ctx, r.repaint.ResumeLive())
		r.written = before
	}
	// Bytes emitted while the view was open have never reached this native
	// terminal. Process them as live, with input enabled for new query replies.
	if err == nil {
		err = r.recoverOutput(ctx, r.pane, r.header.Header.GetHead(), false)
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
		mt, msg, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A size violation is a protocol fault, not a transient drop:
			// answer with the bounded close code and stop instead of looping.
			if errors.Is(err, wireproto.ErrMessageTooLarge) {
				closeWithCode(conn, closeCodeForReadError(err), "terminal message too large")
				return err
			}
			r.disconnect()
			if err := r.reconnect(ctx, pane); err != nil {
				return err
			}
			continue
		}
		if mt != websocket.BinaryMessage || len(msg) == 0 {
			closeWithCode(conn, websocket.CloseProtocolError, "malformed terminal frame")
			return errors.New("phic: malformed terminal frame")
		}
		frame, err := wireproto.DecodeServerFrame(msg)
		if err != nil {
			closeWithCode(conn, websocket.CloseProtocolError, "malformed terminal frame")
			return err
		}
		switch payload := frame.GetPayload().(type) {
		case *wspb.TerminalServerFrame_Output:
			start, data, err := outputSpan(payload.Output)
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
		case *wspb.TerminalServerFrame_Exit:
			// Drain retained output before reporting the backend status.
			exit := payload.Exit
			if exit == nil {
				return fmt.Errorf("%w: invalid exit frame", errProtocol)
			}
			if err := r.drainExit(ctx, pane); err != nil {
				return err
			}
			if code := exit.GetCode(); code != 0 {
				return &ExitError{Code: int(code)}
			}
			return nil
		case *wspb.TerminalServerFrame_Pong: // keepalive
		case *wspb.TerminalServerFrame_DropNotice:
			// Drain retained output before reporting the backend status.
			if err := r.drainExit(ctx, pane); err != nil {
				return err
			}
		case *wspb.TerminalServerFrame_Title,
			*wspb.TerminalServerFrame_BridgeState,
			*wspb.TerminalServerFrame_Settlement,
			*wspb.TerminalServerFrame_Notification:
			// Browser UI hints; no terminal output, no sequence impact.
		default:
			return errors.New("phic: unexpected terminal payload")
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
		if head.Header.GetEpoch() != r.epoch {
			return errors.New("phic: recording epoch changed; detach rather than merge different terminal states")
		}
		if r.written < head.Header.GetOldest() {
			if err := r.checkpointJump(ctx, pane); err != nil {
				return err
			}
		} else if r.written > head.Header.GetHead() {
			return errors.New("phic: written frontier is outside retained recording")
		}
		if err := r.recover(ctx, pane, head.Header.GetHead()); err != nil {
			return err
		}
		cols, rows, err := r.tty.Size()
		if err != nil {
			return err
		}
		return r.sendResize(cols, rows)
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
	parser := r.keys
	if parser == nil {
		parser = &inputParser{}
	}
	buf := make([]byte, 4096)
	for {
		select {
		case size := <-r.tty.Resizes():
			if size.Cols != 0 && size.Rows != 0 {
				if err := r.sendResize(int(size.Cols), int(size.Rows)); err != nil {
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
			for _, chunk := range wireproto.ChunkInput(out) {
				frame, err := wireproto.EncodeInputFrame(chunk)
				if err != nil {
					return err
				}
				if err := r.send(frame); err != nil {
					return err
				}
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
