package ws

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"

	"fmt"
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

func (c *Client) ReadPump(inst *pty.PTYInstance, manager *pty.Manager, hub *Hub) {
	logger := c.logger()
	defer func() {
		hub.Unregister(inst.ID, c)
		manager.UnregisterWS(inst.ID, fmt.Sprintf("%p", c))
		_ = c.Ws.Close()
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
	logger := slog.Default().With("pane", inst.ID)
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

// newConnID mints a 16-hex-char id from crypto/rand, mirroring the format
// of the M2 HTTP trace id (see logging.go's newTraceID in package main) —
// used as a WS conn id when the upgrade request carried no X-Request-Id.
func newConnID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%016x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func HandleWS(w http.ResponseWriter, r *http.Request, inst *pty.PTYInstance, manager *pty.Manager, hub *Hub) {
	// Reuse the M2 HTTP request-id of the upgrade request as the conn id —
	// one id links the "GET /ws/pane/..." log line to every frame this
	// connection ever sends. traceMiddleware (package main) already set
	// this response header before routing reached us; fall back to a fresh
	// id if it's absent (e.g. a test that calls HandleWS directly).
	connID := w.Header().Get("X-Request-Id")
	if connID == "" {
		connID = newConnID()
	}
	logger := slog.Default().With("conn", connID, "pane", inst.ID)

	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("ws upgrade error", "err", err)
		return
	}

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
		}()
		return
	}

	client.ReadPump(inst, manager, hub)
}
