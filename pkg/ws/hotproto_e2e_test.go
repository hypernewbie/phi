package ws

// End-to-end hot-v1 negotiation over a real WebSocket: the query param
// must switch HandleWS to the live-only attach, and the byte stream the
// client observes must be 0x08 ATTACH_HEAD followed by contiguous 0x09
// LIVE_OUTPUT frames — never the legacy replay or 0x06.

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
)

func hotServer(t *testing.T, hub *Hub, manager *pty.Manager, inst *pty.PTYInstance) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, hub)
	}))
}

func TestHandleWS_HotV1Negotiation(t *testing.T) {
	hub := NewHub(4096)
	manager := pty.NewManager()
	inst := &pty.PTYInstance{
		ID:  "hot-pane",
		Pty: &pty.Pty{Closed: make(chan struct{})}, // alive ghost: not closed
	}
	server := hotServer(t, hub, manager, inst)
	defer server.Close()

	// Pre-attach output must NOT be replayed to a hot client.
	hub.Ingest(inst.ID, []byte("old bytes"))

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?term_proto=hot-v1"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	// First frame: ATTACH_HEAD.
	mt, frame, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach head: %v", err)
	}
	if mt != websocket.BinaryMessage || len(frame) < 5 || frame[0] != 0x08 {
		t.Fatalf("expected 0x08 ATTACH_HEAD, got %v", frame)
	}
	n := binary.BigEndian.Uint32(frame[1:5])
	var hdr attachHeadJSON
	if err := json.Unmarshal(frame[5:5+n], &hdr); err != nil {
		t.Fatalf("attach head json: %v", err)
	}
	if hdr.Head != uint64(len("old bytes")) || hdr.Oldest != 0 {
		t.Fatalf("attach head = %+v", hdr)
	}
	if hdr.Ckpt != nil {
		t.Fatalf("no checkpoint stored, got %+v", hdr.Ckpt)
	}

	// Post-attach ingest must arrive as a contiguous 0x09 frame.
	hub.Ingest(inst.ID, []byte("live bytes"))
	_, frame2, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read live frame: %v", err)
	}
	if frame2[0] != 0x09 {
		t.Fatalf("expected 0x09 LIVE_OUTPUT, got type 0x%02x", frame2[0])
	}
	if got := binary.BigEndian.Uint64(frame2[1:9]); got != uint64(len("old bytes")) {
		t.Fatalf("live startSeq = %d, want %d", got, len("old bytes"))
	}
	if string(frame2[9:]) != "live bytes" {
		t.Fatalf("live payload = %q", frame2[9:])
	}
}

func TestHandleWS_LegacyDefaultIsReplay(t *testing.T) {
	hub := NewHub(4096)
	manager := pty.NewManager()
	inst := &pty.PTYInstance{
		ID:  "legacy-pane",
		Pty: &pty.Pty{Closed: make(chan struct{})},
	}
	server := hotServer(t, hub, manager, inst)
	defer server.Close()

	hub.Ingest(inst.ID, []byte("old bytes"))

	// No term_proto: legacy replay path must behave exactly as before.
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))

	_, frame, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read replay: %v", err)
	}
	if frame[0] != 0x01 || string(frame[1:]) != "old bytes" {
		t.Fatalf("expected legacy 0x01 replay, got %v", frame)
	}
	_, frame2, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read replay-complete: %v", err)
	}
	if frame2[0] != 0x06 || len(frame2) != 1 {
		t.Fatalf("expected bare 0x06 replay-complete, got %v", frame2)
	}
}
