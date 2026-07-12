package ws

import (
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Client struct {
	Ws              *websocket.Conn
	Send            chan []byte
	LastDropWarning time.Time
	FullSince       time.Time
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
		select {
		case client.Send <- msg:
			client.FullSince = time.Time{}
		default:
			now := time.Now()
			if client.FullSince.IsZero() {
				client.FullSince = now
			} else if now.Sub(client.FullSince) > 30*time.Second {
				log.Printf("[ws] Client send buffer full for >30s, closing connection")
				if client.Ws != nil {
					_ = client.Ws.Close()
				}
				continue
			}

			droppedCount := 0
			for {
				select {
				case <-client.Send:
					droppedCount++
				default:
				}
				select {
				case client.Send <- msg:
					break
				default:
					if droppedCount > 100 {
						break
					}
					continue
				}
				break
			}

			if now.Sub(client.LastDropWarning) > 5*time.Second {
				client.LastDropWarning = now
				warningMsg := make([]byte, 1+48)
				warningMsg[0] = 0x01
				copy(warningMsg[1:], []byte("\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n"))
				select {
				case client.Send <- warningMsg:
				default:
				}
			}
		}
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
		select {
		case client.Send <- msg:
			client.FullSince = time.Time{}
		default:
			now := time.Now()
			if client.FullSince.IsZero() {
				client.FullSince = now
			} else if now.Sub(client.FullSince) > 30*time.Second {
				log.Printf("[ws] Client send buffer full for >30s, closing connection")
				if client.Ws != nil {
					_ = client.Ws.Close()
				}
				continue
			}

			droppedCount := 0
			for {
				select {
				case <-client.Send:
					droppedCount++
				default:
				}
				select {
				case client.Send <- msg:
					break
				default:
					if droppedCount > 100 {
						break
					}
					continue
				}
				break
			}

			if now.Sub(client.LastDropWarning) > 5*time.Second {
				client.LastDropWarning = now
				warningMsg := make([]byte, 1+48)
				warningMsg[0] = 0x01
				copy(warningMsg[1:], []byte("\r\n\x1b[33m[phi: output dropped — slow client]\x1b[0m\r\n"))
				select {
				case client.Send <- warningMsg:
				default:
				}
			}
		}
	}
}

func (h *Hub) BroadcastShutdown() {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := []byte{0x05}

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
