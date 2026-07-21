package ws

import (
	"context"
	"encoding/binary"
	"log/slog"
	"net/http"
	"time"

	"fmt"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/pty"
	"strings"

	"github.com/gorilla/websocket"
)

var (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second
)

var Upgrader = websocket.Upgrader{
	ReadBufferSize:    1024 * 32,
	WriteBufferSize:   1024 * 32,
	EnableCompression: true,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for localhost and SSH tunnels
	},
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
			err := c.Ws.WriteMessage(websocket.BinaryMessage, msg)
			if err != nil {
				return
			}
		case <-ticker.C:
			_ = c.Ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Ws.WriteMessage(websocket.PingMessage, nil); err != nil {
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
				resizeErr := inst.Pty.Resize(cols, rows)
				if resizeErr != nil {
					logger.Error("ws pty resize error", "err", resizeErr)
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
	logger := componentLogger().With("pane", inst.ID)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := inst.Pty.Read(buf)
			if err != nil {
				break
			}
			if n > 0 {
				inst.UpdateActivity()
				if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
					logger.Debug("frame", "dir", "pty->hub", "bytes", n)
				}
				hub.Ingest(inst.ID, buf[:n])
			}
		}
		// Reap process exit status and broadcast exit event
		<-inst.Pty.Closed
		code := inst.Pty.ExitCode()
		payload := []byte(fmt.Sprintf(`{"code":%d}`, code))
		hub.Broadcast(inst.ID, 0x04, payload)
		hub.ClosePane(inst.ID)
	}()
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
	hub.AttachWithReplay(inst.ID, client)

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
