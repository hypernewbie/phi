package ws

import (
	"bytes"
	"fmt"
	"sync"
	"testing"
	"time"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
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

	ph, gerr := h.GetOrCreatePaneHub(paneID)
	if gerr != nil {
		t.Fatal(gerr)
	}
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

func TestHubCloseAllClientsPreservesPaneState(t *testing.T) {
	h := NewHub(0)
	client := &Client{Send: make(chan []byte, 1)}
	h.Register("pane", client)

	// A nil Ws is valid for unit-created clients; the important contract is
	// that forced live-connection cleanup does not discard pane/ring state.
	h.CloseAllClients()
	ph, gerr := h.GetOrCreatePaneHub("pane")
	if gerr != nil {
		t.Fatal(gerr)
	}
	ph.mu.Lock()
	registered := ph.clients[client]
	ph.mu.Unlock()
	if !registered {
		t.Fatal("CloseAllClients removed pane state instead of only closing sockets")
	}
}

func TestHub_BroadcastFrame(t *testing.T) {
	h := NewHub(0)

	client := &Client{
		Send: make(chan []byte, 10),
	}
	paneID := "pane-test-2"
	h.Register(paneID, client)

	frame, err := wireproto.EncodeTitleFrame(paneID, "native-id", "Native title", 7)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	h.BroadcastFrame(paneID, frame)

	select {
	case msg := <-client.Send:
		if !bytes.Equal(msg, frame) {
			t.Fatalf("Expected the pre-encoded frame %d bytes, got %d", len(frame), len(msg))
		}
		decoded, err := wireproto.DecodeServerFrame(msg)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if title := decoded.GetTitle(); title == nil || title.GetTitle() != "Native title" || title.GetRevision() != 7 {
			t.Fatalf("title = %+v", title)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for broadcast message")
	}
}

func TestBroadcastNotification(t *testing.T) {
	h := NewHub(0)

	client1 := &Client{Send: make(chan []byte, 10)}
	client2 := &Client{Send: make(chan []byte, 10)}
	events := &Client{Send: make(chan []byte, 10)}
	h.Register("pane-a", client1)
	h.Register("pane-b", client2)
	h.Register(EventsPaneID, events)

	h.BroadcastNotification(&wspb.Notification{
		Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
			Dir: proto.String("/x"),
		}},
	})

	// Pane clients receive the TerminalServerFrame wrapper.
	for _, c := range []*Client{client1, client2} {
		select {
		case msg := <-c.Send:
			frame, err := wireproto.DecodeServerFrame(msg)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if md := frame.GetNotification().GetMarkdownChanged(); md == nil || md.GetDir() != "/x" {
				t.Fatalf("wrapped notification = %+v", frame.GetNotification())
			}
		case <-time.After(100 * time.Millisecond):
			t.Fatal("Timeout waiting for BroadcastNotification message")
		}
	}
	// The events group receives the bare Notification.
	select {
	case msg := <-events.Send:
		notif, err := wireproto.DecodeNotification(msg)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if md := notif.GetMarkdownChanged(); md == nil || md.GetDir() != "/x" {
			t.Fatalf("notification = %+v", notif)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Timeout waiting for BroadcastNotification message")
	}
}

func TestHub_ConcurrentAccess(t *testing.T) {
	h := NewHub(0)
	paneID := "concurrent-pane"

	var wg sync.WaitGroup
	workers := 20
	clientsPerWorker := 10
	hello, err := wireproto.EncodeOutputFrame(0, []byte("concurrent hello"))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

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
			h.BroadcastFrame(paneID, hello)

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
	msg := func(data string) []byte {
		frame, err := wireproto.EncodeOutputFrame(0, []byte(data))
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		return frame
	}
	h.BroadcastFrame(paneID, msg("msg1"))
	h.BroadcastFrame(paneID, msg("msg2"))
	h.BroadcastFrame(paneID, msg("msg3"))

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
