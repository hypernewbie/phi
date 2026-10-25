package ws

// Terminal protocol: end-to-end negotiation over a real WebSocket. The
// subprotocol must switch HandleWS to the live-only attach, and the
// stream the client observes must be an attach frame followed by
// contiguous output frames — never a history replay.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func hotServer(t *testing.T, hub *Hub, manager *pty.Manager, inst *pty.PTYInstance) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, hub)
	}))
}

func TestHandleWS_ProtobufNegotiation(t *testing.T) {
	hub := NewHub(4096)
	manager := pty.NewManager()
	inst := &pty.PTYInstance{
		ID:  "hot-pane",
		Pty: &pty.Pty{Closed: make(chan struct{})}, // alive ghost: not closed
	}
	server := hotServer(t, hub, manager, inst)
	defer server.Close()

	// Pre-attach output must NOT be replayed to the client.
	hub.Ingest(inst.ID, []byte("old bytes"))

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if conn.Subprotocol() != wireproto.TerminalSubprotocol {
		t.Fatalf("negotiated subprotocol %q", conn.Subprotocol())
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	// First frame: attach.
	mt, frame, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type %d, want binary", mt)
	}
	serverFrame, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		t.Fatalf("decode attach: %v", err)
	}
	attach := serverFrame.GetAttach()
	if attach == nil {
		t.Fatal("first frame is not an attach")
	}
	if attach.GetHead() != uint64(len("old bytes")) || attach.GetOldest() != 0 {
		t.Fatalf("attach = %+v", attach)
	}
	if attach.GetCheckpoint() != nil {
		t.Fatalf("no checkpoint stored, got %+v", attach.GetCheckpoint())
	}

	// Post-attach ingest must arrive as a contiguous output frame.
	hub.Ingest(inst.ID, []byte("live bytes"))
	_, frame2, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read live frame: %v", err)
	}
	out, err := wireproto.DecodeServerFrame(frame2)
	if err != nil {
		t.Fatalf("decode live frame: %v", err)
	}
	if out.GetOutput() == nil {
		t.Fatal("second frame is not output")
	}
	if got := out.GetOutput().GetStart(); got != uint64(len("old bytes")) {
		t.Fatalf("live start = %d, want %d", got, len("old bytes"))
	}
	if string(out.GetOutput().GetData()) != "live bytes" {
		t.Fatalf("live payload = %q", out.GetOutput().GetData())
	}
}

// Attach-path byte bound: a client must observe only a small attach frame
// before going live, however much the ring retains. Deterministic: frame
// sizes only, no timing.
func TestProtobufAttachBounded(t *testing.T) {
	payload := bytes.Repeat([]byte("0123456789ABCDEF"), (200*1024)/16)
	if len(payload) != 200*1024 {
		t.Fatalf("bad fixture size %d", len(payload))
	}
	hub := NewHub(256 * 1024)
	manager := pty.NewManager()
	inst := &pty.PTYInstance{
		ID:  "hot-pane",
		Pty: &pty.Pty{Closed: make(chan struct{})},
	}
	server := hotServer(t, hub, manager, inst)
	defer server.Close()
	hub.Ingest("hot-pane", payload)
	hotURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	conn, _, err := dialer.Dial(hotURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, head, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach: %v", err)
	}
	serverFrame, err := wireproto.DecodeServerFrame(head)
	if err != nil || serverFrame.GetAttach() == nil {
		t.Fatalf("expected an attach frame, got %+v err=%v", serverFrame, err)
	}
	if len(head) >= 4096 {
		t.Fatalf(
			"attach shipped %d bytes for a %d-byte ring; want header-only (<4KiB)",
			len(head), len(payload),
		)
	}
}
