package ws

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"fmt"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/pty"
	"strings"

	"github.com/gorilla/websocket"
)

var (
	// Backgrounded browsers and sleeping devices can pause socket processing.
	// Keep the existing ping cadence, but tolerate several missed replies.
	writeWait  = time.Minute
	pongWait   = 5 * time.Minute
	pingPeriod = 50 * time.Second
)

var Upgrader = websocket.Upgrader{
	ReadBufferSize:    1024 * 32,
	WriteBufferSize:   1024 * 32,
	EnableCompression: true,
	// Nil keeps gorilla's same-origin default. Same-origin WebSockets still
	// work through localhost and SSH tunnels; cross-site pages cannot attach
	// to a browser's authenticated terminal session.
}

func (c *Client) WritePump() {
	logger := c.logger()
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Ws.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			if !ok {
				return
			}
			_ = c.Ws.SetWriteDeadline(time.Now().Add(writeWait))
			if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
				logger.Debug("frame", "dir", "hub->client", "bytes", len(msg))
			}
			// Negotiate once, then keep tiny frames on the raw fast path.
			// Gorilla's negotiated deflate uses BestSpeed and native clients
			// and browsers inflate below the terminal byte/sequence layer.
			c.Ws.EnableWriteCompression(len(msg) >= 1024)
			err := c.Ws.WriteMessage(websocket.BinaryMessage, msg)
			if err != nil {
				// Every write-side teardown used to return silently, so a
				// disconnect left no trace at all and was indistinguishable
				// from a clean client close. Log it: a write deadline hit at
				// writeWait looks very different from a peer reset, and
				// without the distinction there is nothing to diagnose from.
				logger.Warn("ws write failed, closing connection",
					"err", err,
					"frame_bytes", len(msg),
					"queued", len(c.Send),
					"write_wait", writeWait,
					"timeout", errors.Is(err, os.ErrDeadlineExceeded))
				return
			}
		case <-ticker.C:
			_ = c.Ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				logger.Warn("ws keepalive ping failed, closing connection",
					"err", err,
					"queued", len(c.Send),
					"timeout", errors.Is(err, os.ErrDeadlineExceeded))
				return
			}
		}
	}
}

// ReadPump drains client frames for the lifetime of the connection.
// endSpan, if non-nil, closes out the ws.connection span HandleWS opened
// for this connection — called from the defer below so every teardown
// path (client-initiated close, PTY write error, read error) ends it
// exactly once.
func (c *Client) ReadPump(inst *pty.PTYInstance, manager *pty.Manager, hub *Hub, endSpan func(error)) {
	logger := c.logger()
	defer func() {
		hub.Unregister(inst.ID, c)
		manager.UnregisterWS(inst.ID, fmt.Sprintf("%p", c))
		_ = c.Ws.Close()
		if endSpan != nil {
			endSpan(nil)
		}
	}()

	// Capture pongWait into a local for the pong handler. The handler
	// runs on its own goroutine spawned by gorilla/websocket and can
	// outlive this function, so reading the package var directly
	// races with tests that restore it after defer. Snapshot once.
	pongTimeout := pongWait

	_ = c.Ws.SetReadDeadline(time.Now().Add(pongTimeout))
	c.Ws.SetPongHandler(func(string) error {
		_ = c.Ws.SetReadDeadline(time.Now().Add(pongTimeout))
		return nil
	})
	for {
		mt, message, err := c.Ws.ReadMessage()
		if err != nil {
			break
		}
		_ = c.Ws.SetReadDeadline(time.Now().Add(pongTimeout))
		if mt != websocket.BinaryMessage || len(message) == 0 {
			continue
		}

		msgType := message[0]
		payload := message[1:]

		switch msgType {
		case 0x01: // PTY stdin data
			inst.UpdateInput()
			if inst.Pty != nil {
				_, writeErr := inst.Pty.Write(payload)
				if writeErr != nil {
					logger.Error("ws pty write error", "err", writeErr)
					errMsg := writeErr.Error()
					if strings.Contains(strings.ToLower(errMsg), "closed") || strings.Contains(strings.ToLower(errMsg), "eof") {
						return
					}
				} else if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
					logger.Debug("frame", "dir", "client->pty", "bytes", len(payload))
				}
			}
		case 0x02: // Resize
			if len(payload) >= 4 && inst.Pty != nil {
				cols := binary.BigEndian.Uint16(payload[0:2])
				rows := binary.BigEndian.Uint16(payload[2:4])
				if cols == 0 || rows == 0 {
					return
				}
				// Record the resize marker at the pane's current output head
				// so archive replay can order it against output.
				// Recorded before the PTY takes the new size: bytes after the
				// marker were produced under it.
				resizeErr := inst.Pty.ResizeRecorded(cols, rows, func() { hub.RecordResize(inst.ID, cols, rows) })
				if resizeErr != nil {
					logger.Error("ws pty resize error", "err", resizeErr)
					// A refused geometry/refresh is not success. Reattach with
					// an authoritative state instead of leaving a stale TUI.
					return
				}
			}
		case 0x03: // Ping
			c.Send <- []byte{0x03} // Pong
		}
	}
}

func StartPTYReadLoop(inst *pty.PTYInstance, hub *Hub) {
	if inst.Pty == nil {
		return
	}
	done := inst.BeginReadLoop()
	if done == nil {
		return
	}
	// Register the owner before the goroutine starts: a same-ID retry
	// must win over a delayed old exit that is still draining.
	hub.notePaneOwner(inst)
	logger := componentLogger().With("pane", inst.ID)
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := inst.Pty.Read(buf)
			if n > 0 {
				if inst.ObserveOutput != nil {
					inst.ObserveOutput(buf[:n])
				}
				inst.UpdateActivity()
				if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
					logger.Debug("frame", "dir", "pty->hub", "bytes", n)
				}
				for {
					if err := hub.Ingest(inst.ID, buf[:n]); err == nil {
						break
					} else {
						logger.Error("recording write failed; holding PTY output for retry", "err", err)
						time.Sleep(100 * time.Millisecond)
					}
				}
			}
			if err != nil {
				break
			}
		}
		// Reap process exit status and run the guarded exit: a stale old
		// loop after a same-ID retry skips broadcast, close, and hook.
		<-inst.Pty.Closed
		code := inst.Pty.ExitCode()
		hub.exitPaneForOwner(inst, code)
	}()
}

type sessionTitleControlJSON struct {
	Type      string `json:"type"`
	PaneID    string `json:"pane_id"`
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
	Revision  uint64 `json:"revision"`
}

// EncodeSessionTitleControl produces the JSON payload for the existing 0x02
// control channel. The caller supplies the frame byte when sending it.
func EncodeSessionTitleControl(paneID, sessionID, title string, revision uint64) []byte {
	payload, err := json.Marshal(sessionTitleControlJSON{
		Type:      "session-title",
		PaneID:    paneID,
		SessionID: sessionID,
		Title:     title,
		Revision:  revision,
	})
	if err != nil {
		return nil
	}
	return payload
}

// enqueueBridgeSnapshot appends the Pi-bridge attach snapshot after the
// normal attach frames. A full client is closed instead of dropping the
// frame: the client reconnects and retries the attach, so bridge state is
// never silently lost to congestion.
func (h *Hub) enqueueBridgeSnapshot(snapshot pty.PTYInstanceSnapshot, client *Client) bool {
	if h.bridgeAttach == nil || client == nil {
		return false
	}
	payload := h.bridgeAttach(snapshot)
	if payload == nil {
		return false
	}
	ph, ok := h.LookupPane(snapshot.ID)
	if !ok {
		return false
	}
	frame := append([]byte{0x02}, payload...)
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if !ph.clients[client] {
		return false
	}
	// The bridge produced a snapshot for this pane: from here on its
	// attachments use the close-on-overflow policy.
	ph.bridgeManaged = true
	select {
	case client.Send <- frame:
		return true
	default:
		client.logger().Warn("ws bridge snapshot blocked; closing for reconnect", "pane", snapshot.ID)
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return false
	}
}

// enqueuePiTitleSnapshot appends the current Pi title after the normal attach
// frames. It holds the pane lock while checking registration so Unregister and
// ClosePane cannot close Send between the check and this nonblocking send.
func (h *Hub) enqueuePiTitleSnapshot(snapshot pty.PTYInstanceSnapshot, client *Client) bool {
	if snapshot.Coder != "pi" || snapshot.SessionID == "" || client == nil {
		return false
	}
	ph, ok := h.LookupPane(snapshot.ID)
	if !ok {
		return false
	}
	payload := EncodeSessionTitleControl(snapshot.ID, snapshot.SessionID, snapshot.Title, snapshot.TitleRevision)
	if payload == nil {
		return false
	}
	frame := append([]byte{0x02}, payload...)
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if !ph.clients[client] {
		return false
	}
	select {
	case client.Send <- frame:
		return true
	default:
		return false
	}
}

func HandleWS(w http.ResponseWriter, r *http.Request, inst *pty.PTYInstance, manager *pty.Manager, hub *Hub) {
	// Correlation is via the structured comp=ws + pane=<id> attrs on this
	// connection's logger (both builds) — no hand-minted conn id. Under
	// -tags otel, the ws.connection span below gives each connection its
	// own real trace id (obs.Span is a no-op + debug line in the default
	// build), spanning the connection's lifetime rather than the short
	// upgrade request.
	logger := componentLogger().With("pane", inst.ID)

	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("ws upgrade error", "err", err)
		return
	}

	_, endSpan := obs.Span(r.Context(), "ws.connection", "pane", inst.ID)

	client := &Client{
		Ws:     conn,
		Send:   make(chan []byte, 65536),
		Logger: logger,
	}

	manager.RegisterWS(inst.ID, fmt.Sprintf("%p", client))
	client.NativeState = r.URL.Query().Get("state") == "ghostty-ready-v1"
	client.AnsiState = r.URL.Query().Get("state") == "ansi-v1"
	if r.URL.Query().Get("term_proto") == "hot-v1" {
		// Live-only attach: no replay enters the live terminal. The
		// client bootstraps its screen from the opaque checkpoint in
		// ATTACH_HEAD plus a bounded recording delta fetched over HTTP.
		hub.AttachHot(inst.ID, client)
	} else {
		hub.AttachWithReplay(inst.ID, client)
	}
	// Snapshot manager state only; the asynchronous title service supplies a
	// later push after any cold file read completes. ATTACH_HEAD remains first.
	hub.enqueuePiTitleSnapshot(inst.Snapshot(), client)
	hub.enqueueBridgeSnapshot(inst.Snapshot(), client)

	go client.WritePump()

	if inst.IsPtyDead() {
		// Ghost (nil Pty, code -1) or died-in-place (real exit code available).
		code := -1
		if inst.Pty != nil {
			code = inst.Pty.ExitCode()
		}
		payload := []byte(fmt.Sprintf(`{"code":%d}`, code))
		hub.Broadcast(inst.ID, 0x04, payload)
		go func() {
			time.Sleep(100 * time.Millisecond)
			hub.Unregister(inst.ID, client)
			manager.UnregisterWS(inst.ID, fmt.Sprintf("%p", client))
			_ = conn.Close()
			endSpan(nil)
		}()
		return
	}

	client.ReadPump(inst, manager, hub, endSpan)
}
