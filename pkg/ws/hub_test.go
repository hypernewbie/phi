package ws

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestHub_RegisterAndUnregister(t *testing.T) {
	h := NewHub(0)

	client1 := &Client{
		Send: make(chan []byte, 10),
	}
	client2 := &Client{
		Send: make(chan []byte, 10),
	}

	paneID := "pane-test-1"

	// Register clients
	h.Register(paneID, client1)
	h.Register(paneID, client2)

	ph := h.GetOrCreatePaneHub(paneID)
	ph.mu.Lock()
	clientCount := len(ph.clients)
	ph.mu.Unlock()

	if clientCount != 2 {
		t.Errorf("Expected 2 clients registered, got %d", clientCount)
	}

	// Unregister first client
	h.Unregister(paneID, client1)

	ph.mu.Lock()
	clientCount = len(ph.clients)
	ph.mu.Unlock()

	if clientCount != 1 {
		t.Errorf("Expected 1 client registered, got %d", clientCount)
	}

	// Unregister second client, the pane should persist (zero clients but retains history)
	h.Unregister(paneID, client2)

	h.mu.RLock()
	_, exists := h.panes[paneID]
	h.mu.RUnlock()

	if !exists {
		t.Error("Expected pane to persist after last client unregistered (ring buffer retention)")
	}

	// Now explicitly close the pane
	h.ClosePane(paneID)

	h.mu.RLock()
	_, existsAfterClose := h.panes[paneID]
	h.mu.RUnlock()

	if existsAfterClose {
		t.Error("Expected pane to be cleaned up after ClosePane")
	}
}

func TestHub_Broadcast(t *testing.T) {
	h := NewHub(0)

	client := &Client{
		Send: make(chan []byte, 10),
	}
	paneID := "pane-test-2"
	h.Register(paneID, client)

	payload := []byte("hello world")
	msgType := byte(1)
	h.Broadcast(paneID, msgType, payload)

	select {
	case msg := <-client.Send:
		if len(msg) != len(payload)+1 {
			t.Fatalf("Expected msg length %d, got %d", len(payload)+1, len(msg))
		}
		if msg[0] != msgType {
			t.Errorf("Expected message type %d, got %d", msgType, msg[0])
		}
		if !bytes.Equal(msg[1:], payload) {
			t.Errorf("Expected payload %q, got %q", payload, msg[1:])
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for broadcast message")
	}
}

func TestHub_ConcurrentAccess(t *testing.T) {
	h := NewHub(0)
	paneID := "concurrent-pane"

	var wg sync.WaitGroup
	workers := 20
	clientsPerWorker := 10

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			var clients []*Client
			for j := 0; j < clientsPerWorker; j++ {
				client := &Client{
					Send: make(chan []byte, 10),
				}
				h.Register(paneID, client)
				clients = append(clients, client)
			}

			// Broadcast messages
			h.Broadcast(paneID, 1, []byte("concurrent hello"))

			// Unregister clients
			for _, client := range clients {
				h.Unregister(paneID, client)
			}
		}(i)
	}

	wg.Wait()

	h.ClosePane(paneID)

	h.mu.RLock()
	_, exists := h.panes[paneID]
	h.mu.RUnlock()

	if exists {
		t.Error("Expected concurrent pane to be deleted after ClosePane")
	}
}

func TestHub_BroadcastOverflow(t *testing.T) {
	rh := installRecordingHandler(t)

	h := NewHub(1024)
	paneID := "pane-overflow-test"
	client := &Client{
		Send:   make(chan []byte, 2),
		Logger: componentLogger().With("pane", paneID),
	}
	h.Register(paneID, client)

	// Send 3 messages. The channel capacity is 2, so the 3rd will trigger overflow/dropping oldest.
	h.Broadcast(paneID, 1, []byte("msg1"))
	h.Broadcast(paneID, 1, []byte("msg2"))
	h.Broadcast(paneID, 1, []byte("msg3"))

	// Since msg1 is the oldest, it should have been dropped, and the channel should contain msg2 and msg3.
	if len(client.Send) != 2 {
		t.Fatalf("Expected channel length 2, got %d", len(client.Send))
	}

	first := <-client.Send
	if !bytes.Contains(first, []byte("msg2")) {
		t.Errorf("Expected first remaining message to be msg2, got %q", first)
	}

	second := <-client.Send
	if !bytes.Contains(second, []byte("msg3")) {
		t.Errorf("Expected second remaining message to be msg3, got %q", second)
	}

	// The overflow line must carry the offending comp+pane so the F4
	// slow-client scenario is traceable end to end (M3/L4).
	var found bool
	for _, r := range rh.records() {
		attrs := attrMap(r)
		if fmt.Sprint(attrs["comp"]) == "ws" && fmt.Sprint(attrs["pane"]) == paneID {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected the overflow log line to carry the offending comp+pane attrs")
	}
}
