package ws

import (
	"fmt"
	"log"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// componentLogger returns the "ws" component-tagged base logger, derived
// from whatever slog.Default() currently is. Deliberately NOT a package
// var baked in at init time: package-level vars in an imported package
// initialize before main() runs, i.e. before initLogging() installs the
// real handler (and before a test's installRecordingHandler swaps the
// default) — a cached var would permanently hold the wrong handler and
// silently stop honoring --log-level / PHI_LOG_FORMAT, or drop out of a
// test's recorder entirely. Recomputing per call is cheap (called once per
// connection/pane, never per frame) and always reflects the live default.
func componentLogger() *slog.Logger {
	return slog.Default().With("comp", "ws")
}

type Client struct {
	Ws              *websocket.Conn
	Send            chan []byte
	LastDropWarning time.Time
	FullSince       time.Time

	// Logger carries this client's comp=ws + conn+pane fields (set by
	// HandleWS, built on componentLogger()) so every log line for its
	// lifetime — writes, overflow, frame traces — correlates back to the
	// same connection. Nil for Clients built directly in tests; logger()
	// falls back to componentLogger().
	Logger *slog.Logger
}

// logger returns c.Logger if set, else componentLogger() — nil-safe so
// tests that construct a bare &Client{} keep working unchanged.
func (c *Client) logger() *slog.Logger {
	if c != nil && c.Logger != nil {
		return c.Logger
	}
	return componentLogger()
}

type PaneHub struct {
	clients map[*Client]bool
	mu      sync.Mutex
	Ring    *RingBuffer
}

type Hub struct {
	panes             map[string]*PaneHub
	mu                sync.RWMutex
	replayBufferBytes int
}

func NewHub(replayBufferBytes int) *Hub {
	return &Hub{
		panes:             make(map[string]*PaneHub),
		replayBufferBytes: replayBufferBytes,
	}
}

func (h *Hub) SetReplayBufferBytes(bytes int) {
	h.mu.Lock()
	h.replayBufferBytes = bytes
	h.mu.Unlock()
}

func (h *Hub) GetOrCreatePaneHub(paneID string) *PaneHub {
	h.mu.Lock()
	defer h.mu.Unlock()

	ph, exists := h.panes[paneID]
	if !exists {
		var ring *RingBuffer
		if h.replayBufferBytes > 0 {
			ring = NewRingBuffer(h.replayBufferBytes)
		}
		ph = &PaneHub{
			clients: make(map[*Client]bool),
			Ring:    ring,
		}
		h.panes[paneID] = ph
	}
	return ph
}

func (h *Hub) Register(paneID string, client *Client) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	ph.clients[client] = true
	ph.mu.Unlock()
	log.Printf("[ws] Registered client for pane %s", paneID)
}

func (h *Hub) AttachWithReplay(paneID string, client *Client) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// 1. Snapshot and replay history
	if ph.Ring != nil {
		snap := ph.Ring.Snapshot()
		if len(snap) > 0 {
			const chunkSize = 32 * 1024
			for i := 0; i < len(snap); i += chunkSize {
				end := i + chunkSize
				if end > len(snap) {
					end = len(snap)
				}
				chunk := snap[i:end]
				frame := make([]byte, len(chunk)+1)
				frame[0] = 0x01 // PTY Output Stdout
				copy(frame[1:], chunk)
				client.Send <- frame
			}
		}
	}

	// 2. Send 0x06 replay-complete frame
	client.Send <- []byte{0x06}

	// 3. Register for live updates
	ph.clients[client] = true
	log.Printf("[ws] Registered client for pane %s (with history replay)", paneID)
}

func (h *Hub) Unregister(paneID string, client *Client) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	ph.mu.Lock()
	if _, ok := ph.clients[client]; ok {
		delete(ph.clients, client)
		close(client.Send)
	}
	ph.mu.Unlock()
	log.Printf("[ws] Unregistered client from pane %s", paneID)
}

func (h *Hub) ClosePane(paneID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.panes, paneID)
	log.Printf("[ws] Closed pane %s and deleted its ring buffer", paneID)
}

// deliverOrDrop pushes msg to client's Send channel. If the channel is
// full, it drops the oldest queued frame(s) to make room (bounded to
// 100), injects a one-shot 5s-rate-limited "[phi: output dropped]" warning,
// and keeps the connection alive. Only after 30s of sustained fullness
// does it close the connection as a last resort. The PaneHub mu must be
// held when calling this (caller-side invariant: see Ingest/Broadcast).
func (h *Hub) deliverOrDrop(client *Client, msg []byte) {
	select {
	case client.Send <- msg:
		client.FullSince = time.Time{}
		return
	default:
	}

	now := time.Now()
	if client.FullSince.IsZero() {
		client.FullSince = now
	} else if now.Sub(client.FullSince) > 30*time.Second {
		client.logger().Warn("ws send buffer full for 30s+, closing connection")
		if client.Ws != nil {
			_ = client.Ws.Close()
		}
		return
	}

	dropped := 0
	for dropped < 100 {
		select {
		case <-client.Send:
			dropped++
		default:
		}
		select {
		case client.Send <- msg:
			client.FullSince = time.Time{}
			if dropped > 0 {
				client.logger().Warn("ws dropped stale frames for slow client, kept connection alive", "dropped", dropped)
			}
			return
		default:
			dropped++
		}
	}

	// Could not reclaim space in 100 drops: log and move on, will retry next tick.
	client.logger().Warn("ws send buffer still full after 100 drops, deferring frame")

	if now.Sub(client.LastDropWarning) > 5*time.Second {
		client.LastDropWarning = now
		warningStr := "\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n"
		warningMsg := make([]byte, 1+len(warningStr))
		warningMsg[0] = 0x01
		copy(warningMsg[1:], warningStr)
		select {
		case client.Send <- warningMsg:
		default:
		}
	}
}

func (h *Hub) Ingest(paneID string, payload []byte) {
	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	defer ph.mu.Unlock()

	// 1. Write to ring buffer
	if ph.Ring != nil {
		ph.Ring.Write(payload)
	}

	// 2. Broadcast to clients
	msg := make([]byte, len(payload)+1)
	msg[0] = 0x01
	copy(msg[1:], payload)

	for client := range ph.clients {
		h.deliverOrDrop(client, msg)
	}
}

func (h *Hub) Broadcast(paneID string, msgType byte, payload []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	msg := make([]byte, len(payload)+1)
	msg[0] = msgType
	copy(msg[1:], payload)

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		h.deliverOrDrop(client, msg)
	}
}

// BroadcastAll pushes a typed frame to every client of every pane.
// Best-effort: full client send channels drop the frame rather than
// block (same contract as BroadcastShutdown, which now delegates here).
func (h *Hub) BroadcastAll(msgType byte, payload []byte) {
	msg := make([]byte, 1+len(payload))
	msg[0] = msgType
	copy(msg[1:], payload)

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, ph := range h.panes {
		ph.mu.Lock()
		for client := range ph.clients {
			select {
			case client.Send <- msg:
			default:
			}
		}
		ph.mu.Unlock()
	}
}

// BroadcastShutdown announces server shutdown to every connected client.
// The payload is the JSON envelope {"reason":"restart"|"update"|"shutdown"}
// per WS protocol v2 §3.1, so the UI can render a distinct state and arm
// the post-restart auto-reload poller. Best-effort: if a client's send
// channel is full the message is dropped silently rather than blocking
// the shutdown path.
func (h *Hub) BroadcastShutdown(reason string) {
	if reason == "" {
		reason = "shutdown"
	}
	payload := []byte(fmt.Sprintf(`{"reason":%q}`, reason))
	h.BroadcastAll(0x05, payload)
}

// PaneStats returns (client count, ring bytes used, ring capacity) for
// a given pane. Returns (0,0,0) if the pane is unknown. Used by the
// /api/diag endpoint.
func (h *Hub) PaneStats(paneID string) (int, int, int) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()
	if !exists {
		return 0, 0, 0
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	clients := len(ph.clients)
	var used, cap int
	if ph.Ring != nil {
		used, cap = ph.Ring.Stats()
	}
	return clients, used, cap
}
