package ws

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// waitForEventsClientCount polls PaneStats(EventsPaneID) until the client
// count reaches want. Dial returning does not guarantee the server
// goroutine has reached Register/Unregister yet, so tests must poll
// rather than assert immediately.
func waitForEventsClientCount(t *testing.T, h *Hub, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		count, _, _ := h.PaneStats(EventsPaneID)
		if count == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	count, _, _ := h.PaneStats(EventsPaneID)
	t.Fatalf("timed out waiting for %d events client(s); have %d", want, count)
}

// TestHandleEventsWS_ReceivesBroadcastAll: a listen-only /ws/md-events
// client receives hub-wide BroadcastAll frames, and broadcasting after
// the client disconnects must not panic.
func TestHandleEventsWS_ReceivesBroadcastAll(t *testing.T) {
	h := NewHub(0)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleEventsWS(w, r, h)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial: %v", err)
	}
	defer conn.Close()

	// Wait until the server goroutine has registered the client before
	// broadcasting — skipping this makes the test flaky.
	waitForEventsClientCount(t, h, 1)

	payload := []byte(`{"dir":"/tmp/docs"}`)
	h.BroadcastAll(0x07, payload)

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("Failed to read broadcast message: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Errorf("Expected binary message type (%d), got %d", websocket.BinaryMessage, mt)
	}
	if len(msg) < 1 || msg[0] != 0x07 {
		t.Fatalf("Expected first byte 0x07, got %#v", msg)
	}
	var decoded struct {
		Dir string `json:"dir"`
	}
	if err := json.Unmarshal(msg[1:], &decoded); err != nil {
		t.Fatalf("Payload did not JSON-decode: %v (payload %q)", err, msg[1:])
	}
	if decoded.Dir != "/tmp/docs" {
		t.Errorf("Expected dir %q, got %q", "/tmp/docs", decoded.Dir)
	}
	if !bytes.Equal(msg[1:], payload) {
		t.Errorf("Expected payload %q, got %q", payload, msg[1:])
	}

	// Close the client; the server drain loop must unregister it.
	_ = conn.Close()
	waitForEventsClientCount(t, h, 0)

	// Broadcasting with no listeners must not panic.
	h.BroadcastAll(0x07, payload)
}
