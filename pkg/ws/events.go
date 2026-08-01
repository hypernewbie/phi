package ws

import (
	"net/http"
	"time"
)

// EventsPaneID is the synthetic hub key for listen-only browser clients
// (no PTY). BroadcastAll reaches them like any pane client; pane-scoped
// APIs are never called with this key. The PaneHub's replay ring buffer
// (allocated once per server by GetOrCreatePaneHub) is never Ingest-ed
// for this key — accepted dead weight, do not add API to avoid it.
const EventsPaneID = "@events"

// HandleEventsWS serves a listen-only client that receives hub-wide
// BroadcastAll frames (0x07 md-changed, 0x05 shutdown) without a PTY.
// Inbound messages are drained and ignored.
func HandleEventsWS(w http.ResponseWriter, r *http.Request, hub *Hub) {
	logger := componentLogger().With("pane", EventsPaneID)
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("ws upgrade error", "err", err)
		return
	}
	client := &Client{Ws: conn, Send: make(chan []byte, 256), Logger: logger}
	hub.Register(EventsPaneID, client)
	go client.WritePump()
	// Capture pongWait into a local: the pong handler can outlive this
	// function, so reading the package var directly races with tests
	// that restore it. See the matching comment in ReadPump.
	pongTimeout := pongWait

	_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
		return nil
	})
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
		_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
	}
	hub.Unregister(EventsPaneID, client)
	_ = conn.Close()
}
