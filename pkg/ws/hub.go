package ws

import (
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

type Client struct {
	Ws   *websocket.Conn
	Send chan []byte
}

type PaneHub struct {
	clients map[*Client]bool
	mu      sync.Mutex
}

type Hub struct {
	panes map[string]*PaneHub
	mu    sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{
		panes: make(map[string]*PaneHub),
	}
}

func (h *Hub) GetOrCreatePaneHub(paneID string) *PaneHub {
	h.mu.Lock()
	defer h.mu.Unlock()

	ph, exists := h.panes[paneID]
	if !exists {
		ph = &PaneHub{
			clients: make(map[*Client]bool),
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
	empty := len(ph.clients) == 0
	ph.mu.Unlock()

	if empty {
		h.mu.Lock()
		delete(h.panes, paneID)
		h.mu.Unlock()
	}
	log.Printf("[ws] Unregistered client from pane %s", paneID)
}

func (h *Hub) Broadcast(paneID string, msgType byte, payload []byte) {
	h.mu.RLock()
	ph, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		return
	}

	// Frame message with type prefix
	msg := make([]byte, len(payload)+1)
	msg[0] = msgType
	copy(msg[1:], payload)

	ph.mu.Lock()
	defer ph.mu.Unlock()

	for client := range ph.clients {
		select {
		case client.Send <- msg:
		default:
			// Backpressure: drop newest (discard incoming message) if client channel buffer is
			// full to prevent middle-stream corruption of stateful ANSI escape sequences.
		}
	}
}
