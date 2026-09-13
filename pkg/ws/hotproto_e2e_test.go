package ws

// Hot-v1 protocol: end-to-end negotiation over a real WebSocket. The
// query param must switch HandleWS to the live-only attach, and the byte
// stream the client observes must be 0x08 ATTACH_HEAD followed by
// contiguous 0x09 LIVE_OUTPUT frames — never the legacy replay or 0x06.

import (
	"bytes"
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

// Attach-path byte bound: the "faster by a LOT" claim as a regression
// gate. With a 200 KiB ring, a hot client must observe only a small
// ATTACH_HEAD before going live, while a legacy client still receives
// every retained byte. Deterministic: frame sizes only, no timing.
func TestHotAttachBoundedWhileLegacyReplaysAll(t *testing.T) {
	payload := bytes.Repeat([]byte("0123456789ABCDEF"), (200*1024)/16)
	if len(payload) != 200*1024 {
		t.Fatalf("bad fixture size %d", len(payload))
	}

	newPane := func(hub *Hub, id string) (*httptest.Server, *pty.PTYInstance) {
		manager := pty.NewManager()
		inst := &pty.PTYInstance{
			ID:  id,
			Pty: &pty.Pty{Closed: make(chan struct{})},
		}
		return hotServer(t, hub, manager, inst), inst
	}

	// Hot: header only, no replay bytes.
	hub := NewHub(256 * 1024)
	server, _ := newPane(hub, "hot-pane")
	defer server.Close()
	hub.Ingest("hot-pane", payload)
	hotURL := "ws" + strings.TrimPrefix(server.URL, "http") + "?term_proto=hot-v1"
	conn, _, err := websocket.DefaultDialer.Dial(hotURL, nil)
	if err != nil {
		t.Fatalf("dial hot: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, head, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach head: %v", err)
	}
	if head[0] != 0x08 {
		t.Fatalf("expected 0x08 ATTACH_HEAD, got 0x%02x", head[0])
	}
	if len(head) >= 4096 {
		t.Fatalf(
			"hot attach shipped %d bytes for a %d-byte ring; want header-only (<4KiB)",
			len(head), len(payload),
		)
	}

	// Legacy: every retained byte, then 0x06.
	hub2 := NewHub(256 * 1024)
	server2, _ := newPane(hub2, "legacy-pane")
	defer server2.Close()
	hub2.Ingest("legacy-pane", payload)
	legacyURL := "ws" + strings.TrimPrefix(server2.URL, "http")
	conn2, _, err := websocket.DefaultDialer.Dial(legacyURL, nil)
	if err != nil {
		t.Fatalf("dial legacy: %v", err)
	}
	defer conn2.Close()
	_ = conn2.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, replay, err := conn2.ReadMessage()
	if err != nil {
		t.Fatalf("read replay: %v", err)
	}
	if replay[0] != 0x01 {
		t.Fatalf("expected 0x01 replay chunks, got 0x%02x", replay[0])
	}
	// Replay is chunked at 32 KiB per frame; accumulate to 0x06.
	got := len(replay) - 1
	for {
		_, f, err := conn2.ReadMessage()
		if err != nil {
			t.Fatalf("read replay chunk: %v", err)
		}
		if len(f) == 1 && f[0] == 0x06 {
			break
		}
		if f[0] != 0x01 {
			t.Fatalf("expected 0x01 chunk or 0x06 done, got 0x%02x", f[0])
		}
		got += len(f) - 1
	}
	if got != len(payload) {
		t.Fatalf(
			"legacy replay = %d bytes, want full %d-byte ring",
			got, len(payload),
		)
	}
}
