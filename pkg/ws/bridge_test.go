package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// TestWebSocketCompression verifies that our WebSocket Upgrader correctly negotiates
// permessage-deflate compression and successfully handles reading/writing compressed binary frames.
func TestWebSocketCompression(t *testing.T) {
	// Create a test HTTP server that upgrades connections using our configured Upgrader
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("Failed to upgrade connection: %v", err)
			return
		}
		defer conn.Close()

		// Read a message and echo it back to verify frame processing
		for {
			mt, message, err := conn.ReadMessage()
			if err != nil {
				break
			}
			err = conn.WriteMessage(mt, message)
			if err != nil {
				t.Errorf("Failed to write echoed message: %v", err)
				break
			}
		}
	}))
	defer server.Close()

	// Convert the test HTTP URL to a WebSocket URL scheme
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// Set up the client dialer with compression explicitly enabled
	dialer := websocket.Dialer{
		EnableCompression: true,
	}

	// Dial the test server
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Client failed to dial test server: %v", err)
	}
	defer conn.Close()

	// Assert that the server accepted the permessage-deflate extension in the handshake
	extHeader := resp.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(extHeader, "permessage-deflate") {
		t.Errorf("Expected 'permessage-deflate' extension in response headers, got %q", extHeader)
	}

	// Send a large, highly-compressible payload to verify the compression engine
	testMsg := []byte(strings.Repeat("compress me! ", 100))
	err = conn.WriteMessage(websocket.BinaryMessage, testMsg)
	if err != nil {
		t.Fatalf("Failed to write binary message: %v", err)
	}

	// Read and verify the echoed response matches the payload exactly
	mt, received, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("Failed to read binary message response: %v", err)
	}

	if mt != websocket.BinaryMessage {
		t.Errorf("Expected binary message type (%d), got %d", websocket.BinaryMessage, mt)
	}

	if string(received) != string(testMsg) {
		t.Errorf("Echo payload mismatch. Sent length: %d, Received length: %d", len(testMsg), len(received))
	}
}
