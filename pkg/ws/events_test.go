package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
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

// TestHandleEventsWS_ReceivesBroadcastNotification: a listen-only
// /ws/md-events client receives hub-wide broadcast notifications as
// bare Notification messages, and broadcasting after the client
// disconnects must not panic.
func TestHandleEventsWS_ReceivesBroadcastNotification(t *testing.T) {
	h := NewHub(0)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleEventsWS(w, r, h)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.EventsSubprotocol}}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial: %v", err)
	}
	defer conn.Close()

	// Wait until the server goroutine has registered the client before
	// broadcasting — skipping this makes the test flaky.
	waitForEventsClientCount(t, h, 1)

	h.BroadcastNotification(&wspb.Notification{
		Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
			Dir: proto.String("/tmp/docs"),
		}},
	})

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("Failed to read broadcast message: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Errorf("Expected binary message type (%d), got %d", websocket.BinaryMessage, mt)
	}
	notif, err := wireproto.DecodeNotification(msg)
	if err != nil {
		t.Fatalf("Message did not Notification-decode: %v", err)
	}
	if md := notif.GetMarkdownChanged(); md == nil || md.GetDir() != "/tmp/docs" {
		t.Fatalf("notification = %+v, want markdown dir /tmp/docs", notif)
	}

	// Close the client; the server drain loop must unregister it.
	_ = conn.Close()
	waitForEventsClientCount(t, h, 0)

	// Broadcasting with no listeners must not panic.
	h.BroadcastShutdown("shutdown")
}
