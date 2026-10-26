package ws

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func TestEncodeTitleFrame(t *testing.T) {
	frame, err := wireproto.EncodeTitleFrame("pane-1", "native-id", "Native title", 7)
	if err != nil {
		t.Fatal(err)
	}
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	title := server.GetTitle()
	if title == nil || title.GetPaneId() != "pane-1" || title.GetSessionId() != "native-id" || title.GetTitle() != "Native title" || title.GetRevision() != 7 {
		t.Fatalf("encoded title frame=%+v", title)
	}
}

func TestPiTitleAttachSnapshotFollowsAttachHeadAndNeverBlocks(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 2)}
	hub.AttachHot("pane-1", client)
	snapshot := pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi", SessionID: "native-id", Title: "Native title", TitleRevision: 4}
	if !hub.enqueuePiTitleSnapshot(snapshot, client) {
		t.Fatal("Pi title attach snapshot was not queued")
	}
	first, second := <-client.Send, <-client.Send
	if server, err := wireproto.DecodeServerFrame(first); err != nil || server.GetAttach() == nil {
		t.Fatalf("first attach frame = %+v err=%v, want an attach", server, err)
	}
	secondFrame, err := wireproto.DecodeServerFrame(second)
	if err != nil || secondFrame.GetTitle() == nil {
		t.Fatalf("second attach frame = %+v err=%v, want a title", secondFrame, err)
	}
	title := secondFrame.GetTitle()
	if title.GetPaneId() != snapshot.ID || title.GetSessionId() != snapshot.SessionID || title.GetTitle() != snapshot.Title || title.GetRevision() != snapshot.TitleRevision {
		t.Fatalf("attach title snapshot=%+v", title)
	}

	fullHub := NewHub(0)
	fullClient := &Client{Send: make(chan []byte, 1)}
	fullHub.Register("full-pane", fullClient)
	fullClient.Send <- []byte("already queued")
	if fullHub.enqueuePiTitleSnapshot(pty.PTYInstanceSnapshot{ID: "full-pane", Coder: "pi", SessionID: "id"}, fullClient) {
		t.Fatal("full client queue unexpectedly accepted snapshot")
	}
	fullHub.ClosePane("full-pane")
	if fullHub.enqueuePiTitleSnapshot(pty.PTYInstanceSnapshot{ID: "full-pane", Coder: "pi", SessionID: "id"}, fullClient) {
		t.Fatal("closed-pane client unexpectedly accepted snapshot")
	}
}

func TestHandleWSQueuesCurrentPiTitleAfterHotAttach(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	shell, args := getTestShellForBridge()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "native-id", pty.SpawnOptions{ID: "title-attach-pane", Title: "Saved title"})
	if err != nil {
		t.Fatalf("spawn attach-test PTY: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.Kill(instance.ID)
		_ = manager.FlushSaveState()
	})
	revision, changed := manager.SetDerivedPiTitle(instance, "native-id", home, "Native title")
	if !changed || revision != 1 {
		t.Fatalf("set attach-test title revision=%d changed=%v", revision, changed)
	}
	hub := NewHub(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, instance, manager, hub)
	}))
	defer server.Close()

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial attach: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	messageType, first, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		t.Fatalf("read attach frame: %v", err)
	}
	if messageType != websocket.BinaryMessage {
		_ = conn.Close()
		t.Fatalf("attach frame type=%d, want binary", messageType)
	}
	if server, err := wireproto.DecodeServerFrame(first); err != nil || server.GetAttach() == nil {
		_ = conn.Close()
		t.Fatalf("first frame = %+v err=%v, want an attach", server, err)
	}
	{
		messageType, frame, err := conn.ReadMessage()
		if err != nil {
			_ = conn.Close()
			t.Fatalf("read title frame: %v", err)
		}
		if messageType != websocket.BinaryMessage || len(frame) == 0 {
			_ = conn.Close()
			t.Fatalf("title frame type=%d length=%d, want binary", messageType, len(frame))
		}
		{
			server, err := wireproto.DecodeServerFrame(frame)
			if err != nil || server.GetTitle() == nil {
				_ = conn.Close()
				t.Fatalf("title frame = %+v err=%v, want a title", server, err)
			}
			title := server.GetTitle()
			if title.GetPaneId() != instance.ID || title.GetSessionId() != "native-id" || title.GetTitle() != "Native title" || title.GetRevision() != 1 {
				_ = conn.Close()
				t.Fatalf("current attach title=%+v", title)
			}
		}
	}
	_ = conn.Close()
}

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

func TestWebSocketRejectsCrossOriginUpgrade(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = Upgrader.Upgrade(w, r, nil)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	header := http.Header{"Origin": []string{"https://not-phi.example"}}
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err == nil {
		t.Fatal("cross-origin WebSocket upgrade unexpectedly succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin response: got %#v, want HTTP 403", resp)
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

	hub := NewHub(0)
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
		client.ReadPump(inst, manager, hub, nil)
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

// TestHandleWS_DiedInPlaceReportsRealExitCode: died-in-place PTY must send 0x04 with the real exit code, not -1.
func TestHandleWS_DiedInPlaceReportsRealExitCode(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("USERPROFILE", tmpHome)

	shell, args := getTestShellForBridge()

	manager := pty.NewManager()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "died-in-place")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.Kill(inst.ID)
		_ = manager.FlushSaveState()
	})
	if err := manager.FlushSaveState(); err != nil {
		t.Fatalf("FlushSaveState: %v", err)
	}

	drainHub := NewHub(0)
	StartPTYReadLoop(inst, drainHub)
	if _, err := inst.Pty.Write([]byte("exit\r\n")); err != nil {
		t.Fatalf("write exit command: %v", err)
	}
	select {
	case <-inst.Pty.Closed:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for shell to exit")
	}

	assertionHub := NewHub(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, assertionHub)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	// The dead-Pty branch sends the attach frame, then the exit frame
	// with the real exit code.
	_, attachRaw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach: %v", err)
	}
	attachFrame, err := wireproto.DecodeServerFrame(attachRaw)
	if err != nil || attachFrame.GetAttach() == nil {
		t.Fatalf("first frame = %+v err=%v, want an attach", attachFrame, err)
	}
	_, exitRaw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("expected an exit frame, got read error: %v", err)
	}
	exitFrame, err := wireproto.DecodeServerFrame(exitRaw)
	if err != nil || exitFrame.GetExit() == nil {
		t.Fatalf("second frame = %+v err=%v, want an exit", exitFrame, err)
	}
	if code := exitFrame.GetExit().GetCode(); code != 0 {
		t.Errorf("died-in-place PTY should report its real exit code 0 (clean 'exit' command), not the ghost sentinel -1; got %d", code)
	}
}

// TestHandleWS_LoggerCarriesCompAndPane (L4): HandleWS's per-connection
// logger — used for frame traces, upgrade/PTY errors, and overflow lines —
// carries comp="ws" and pane=<inst.ID>. There is no hand-minted conn id
// (correlating distinct connections to the same pane is what the
// otel-build-only ws.connection span, via its own trace id, is for).
func TestHandleWS_LoggerCarriesCompAndPane(t *testing.T) {
	rh := installRecordingHandler(t)
	shell, args := getTestShellForBridge()

	manager := pty.NewManager()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "comp-pane-test")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer func() { _ = manager.Kill(inst.ID) }()

	hub := NewHub(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, hub)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	// Drain the attach frame; WritePump's debug frame trace
	// on the way out carries this connection's comp+pane attrs.
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("read attach frame: %v", err)
	}

	var found bool
	for _, r := range rh.records() {
		attrs := attrMap(r)
		if fmt.Sprint(attrs["comp"]) == "ws" && fmt.Sprint(attrs["pane"]) == inst.ID {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected at least one captured log record with comp=ws and pane=<inst.ID>")
	}
}

func getTestShellForBridge() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}
