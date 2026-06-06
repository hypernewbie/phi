package ws

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"

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

func TestWebSocketPipes_10MB(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("Failed to upgrade: %v", err)
			return
		}
		defer conn.Close()

		for {
			mt, message, err := conn.ReadMessage()
			if err != nil {
				break
			}
			err = conn.WriteMessage(mt, message)
			if err != nil {
				t.Errorf("Failed to write: %v", err)
				break
			}
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{EnableCompression: true}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial: %v", err)
	}
	defer conn.Close()

	const payloadSize = 10 * 1024 * 1024 // 10MB
	largePayload := make([]byte, payloadSize)
	for i := range largePayload {
		largePayload[i] = byte(i % 256)
	}

	err = conn.WriteMessage(websocket.BinaryMessage, largePayload)
	if err != nil {
		t.Fatalf("Failed to write 10MB message: %v", err)
	}

	_, received, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("Failed to read 10MB message: %v", err)
	}

	if len(received) != len(largePayload) {
		t.Errorf("Length mismatch: sent %d, got %d", len(largePayload), len(received))
	} else if !bytes.Equal(received, largePayload) {
		t.Error("Payload bytes mismatch")
	}
}

func TestWebSocketKeepalive(t *testing.T) {
	origPongWait := pongWait
	origPingPeriod := pingPeriod
	defer func() {
		pongWait = origPongWait
		pingPeriod = origPingPeriod
	}()

	pongWait = 200 * time.Millisecond
	pingPeriod = 100 * time.Millisecond

	hub := NewHub()
	manager := pty.NewManager()
	inst := &pty.PTYInstance{
		ID: "test-pane",
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("Server failed to upgrade connection: %v", err)
			return
		}

		client := &Client{
			Ws:   conn,
			Send: make(chan []byte, 65536),
		}

		hub.Register(inst.ID, client)

		go client.WritePump()
		client.ReadPump(inst, manager, hub)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Client failed to dial server: %v", err)
	}
	defer conn.Close()

	errChan := make(chan error, 1)
	go func() {
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				errChan <- err
				return
			}
		}
	}()

	select {
	case err := <-errChan:
		t.Fatalf("Connection closed prematurely: %v", err)
	case <-time.After(500 * time.Millisecond):
		// Keepalive succeeded!
	}
}
