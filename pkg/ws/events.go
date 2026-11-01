package ws

import (
	"errors"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// EventsPaneID is the synthetic hub key for listen-only browser clients
// (no PTY). BroadcastAll reaches them like any pane client; pane-scoped
// APIs are never called with this key. The PaneHub's replay ring buffer
// (allocated once per server by GetOrCreatePaneHub) is never Ingest-ed
// for this key — accepted dead weight, do not add API to avoid it.
const EventsPaneID = "@events"

// HandleEventsWS serves a listen-only client that receives hub-wide
// notifications without a PTY. Inbound messages are drained and ignored.
func HandleEventsWS(w http.ResponseWriter, r *http.Request, hub *Hub) {
	logger := componentLogger().With("pane", EventsPaneID)
	if !wireproto.ClientRequestedSubprotocol(r, wireproto.EventsSubprotocol) {
		logger.Error("ws events subprotocol mismatch")
		http.Error(w, "expected WebSocket subprotocol "+wireproto.EventsSubprotocol, http.StatusUpgradeRequired)
		return
	}
	// Copy the shared upgrader: concurrent upgrades for other endpoints
	// must not observe this endpoint's subprotocol selection.
	upgrader := Upgrader
	upgrader.Subprotocols = []string{wireproto.EventsSubprotocol}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("ws upgrade error", "err", err)
		return
	}
	client := &Client{Ws: conn, Send: make(chan []byte, 256), Logger: logger}
	if fence, fenced := AuthFenceFrom(r.Context()); fenced && !hub.AdmitAuth(conn, fence) {
		logger.Warn("ws events upgrade rejected: stale access generation")
		_ = conn.Close()
		return
	}
	hub.Register(EventsPaneID, client)
	go client.WritePump()
	// Capture pongWait into a local: the pong handler can outlive this
	// function, so reading the package var directly races with tests
	// that restore it. See the matching comment in ReadPump.
	pongTimeout := pongWait

	// SetReadLimit bounds the compressed wire; ReadBoundedMessage bounds
	// the decompressed body before it is discarded.
	conn.SetReadLimit(wireproto.MaxEventsMessageBytes)
	_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
		return nil
	})
	for {
		// Listen-only: drain and ignore inbound traffic, bounded so a
		// misbehaving client cannot grow server memory without limit.
		// An oversize message closes the stream with code 1009.
		if _, _, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxEventsMessageBytes); err != nil {
			if errors.Is(err, wireproto.ErrMessageTooLarge) {
				client.closeWithCode(websocket.CloseMessageTooBig, "message too large")
			}
			break
		}
		_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
	}
	hub.Unregister(EventsPaneID, client)
	hub.ForgetAuth(conn)
	_ = conn.Close()
}
