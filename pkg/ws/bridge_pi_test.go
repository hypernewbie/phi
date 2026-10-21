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
	"github.com/hypernewbie/phi/pkg/pty"
)

// drainFrames empties a client queue without blocking.
func drainFrames(ch chan []byte) [][]byte {
	var out [][]byte
	for {
		select {
		case f := <-ch:
			out = append(out, f)
		default:
			return out
		}
	}
}

func TestBroadcastBridgeDeliversControlFrame(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send // ATTACH_HEAD
	hub.BroadcastBridge("pane-1", []byte(`{"type":"pi-bridge-settled"}`))
	select {
	case frame := <-client.Send:
		if len(frame) == 0 || frame[0] != 0x02 {
			t.Fatalf("frame type=%v, want 0x02", frame)
		}
		var control struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(frame[1:], &control); err != nil || control.Type != "pi-bridge-settled" {
			t.Fatalf("payload=%s err=%v", frame[1:], err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bridge frame not delivered")
	}
}

func TestBroadcastBridgeUnknownPaneIsNoop(t *testing.T) {
	hub := NewHub(0)
	hub.BroadcastBridge("no-such-pane", []byte(`{}`))
}

func TestBroadcastBridgeFullClientClosesForReconnect(t *testing.T) {
	hub := NewHub(0)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		client := &Client{Ws: conn, Send: make(chan []byte, 4)}
		hub.Register("pane-1", client)
		// Fill the queue; no writer drains it.
		for i := 0; i < 4; i++ {
			client.Send <- []byte{0x01}
		}
		hub.BroadcastBridge("pane-1", []byte(`{"type":"pi-bridge-settled"}`))
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatal("expected the congested connection to close")
	}
}

// A full client at attach time must not block the attach: the snapshot
// is refused so the client reconnects and retries the attach.
func TestBridgeAttachSnapshotFullQueueIsRefused(t *testing.T) {
	hub := NewHub(0)
	hub.SetBridgeAttach(func(pty.PTYInstanceSnapshot) []byte {
		return []byte(`{"type":"pi-bridge-state"}`)
	})
	client := &Client{Send: make(chan []byte, 1)}
	hub.Register("pane-1", client)
	client.Send <- []byte{0x01} // the queue is full
	if hub.enqueueBridgeSnapshot(pty.PTYInstanceSnapshot{ID: "pane-1"}, client) {
		t.Fatal("attach snapshot queued into a full client")
	}
	if len(client.Send) != 1 {
		t.Fatalf("queued frames=%d, want 1 (nothing evicted)", len(client.Send))
	}
}

// A bridge-managed pane must not lose a queued control frame to PTY
// output: the output path closes the congested client instead of
// evicting the queued control, so the attach snapshot replays the state
// after the reconnect.
func TestManagedPaneOutputClosesFullClientInsteadOfEvicting(t *testing.T) {
	hub := NewHub(0)
	hub.SetBridgeAttach(func(pty.PTYInstanceSnapshot) []byte {
		return []byte(`{"type":"pi-bridge-state"}`)
	})
	client := &Client{Send: make(chan []byte, 3)}
	hub.Register("pane-1", client)
	// The attach snapshot marks the pane bridge-managed.
	if !hub.enqueueBridgeSnapshot(pty.PTYInstanceSnapshot{ID: "pane-1"}, client) {
		t.Fatal("attach snapshot not queued")
	}
	// Fill the queue; no writer drains it.
	client.Send <- []byte{0x01, 'a'}
	client.Send <- []byte{0x01, 'b'}
	if err := hub.Ingest("pane-1", []byte("output")); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	// Nothing was evicted and the output never entered the queue: the
	// congested client is closed for reconnect instead.
	frames := drainFrames(client.Send)
	if len(frames) != 3 {
		t.Fatalf("queued frames=%d, want 3 (nothing evicted)", len(frames))
	}
	if frames[0][0] != 0x02 {
		t.Fatalf("queued control evicted by output: %v", frames[0])
	}
	for _, f := range frames {
		if bytes.Equal(f, []byte{0x01, 'o', 'u', 't', 'p', 'u', 't'}) {
			t.Fatal("output queued on a managed pane")
		}
	}
}

// An unmanaged pane keeps the default drop policy: a full queue evicts
// the oldest frame to make room for the new output.
func TestUnmanagedPaneOutputKeepsDropPolicy(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 2)}
	hub.Register("pane-1", client)
	client.Send <- []byte{0x01, 'o', 'l', 'd'}
	client.Send <- []byte{0x01, 'n', 'e', 'w'}
	if err := hub.Ingest("pane-1", []byte("output")); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	frames := drainFrames(client.Send)
	for _, f := range frames {
		if bytes.Equal(f, []byte{0x01, 'o', 'u', 't', 'p', 'u', 't'}) {
			return
		}
	}
	t.Fatalf("output not queued on an unmanaged pane: %v", frames)
}

func TestBroadcastBridgeLeavesQueuedFramesUndisturbed(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send // ATTACH_HEAD
	queued := []byte{0x01, 'o', 'u', 't'}
	client.Send <- queued
	hub.BroadcastBridge("pane-1", []byte(`{}`))
	first := <-client.Send
	if len(first) == 0 || first[0] != 0x01 {
		t.Fatalf("queued output disturbed: %v", first)
	}
}

func TestBridgeAttachSnapshotFollowsTitleAndNeverBlocks(t *testing.T) {
	hub := NewHub(0)
	hub.SetBridgeAttach(func(snapshot pty.PTYInstanceSnapshot) []byte {
		return []byte(`{"type":"pi-bridge-state","pane_id":"` + snapshot.ID + `"}`)
	})
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	snapshot := pty.PTYInstanceSnapshot{ID: "pane-1", Coder: "pi", SessionID: "native-id", Title: "Native title", TitleRevision: 4}
	if !hub.enqueuePiTitleSnapshot(snapshot, client) {
		t.Fatal("title snapshot not queued")
	}
	if !hub.enqueueBridgeSnapshot(snapshot, client) {
		t.Fatal("bridge snapshot not queued")
	}
	frames := [][]byte{<-client.Send, <-client.Send, <-client.Send}
	if frames[0][0] != 0x08 || frames[1][0] != 0x02 || frames[2][0] != 0x02 {
		t.Fatalf("attach order wrong: %v %v %v", frames[0][0], frames[1][0], frames[2][0])
	}
	var control struct {
		Type   string `json:"type"`
		PaneID string `json:"pane_id"`
	}
	if err := json.Unmarshal(frames[2][1:], &control); err != nil || control.Type != "pi-bridge-state" {
		t.Fatalf("bridge payload=%s err=%v", frames[2][1:], err)
	}
}

func TestBridgeAttachSnapshotNilSendsNothing(t *testing.T) {
	hub := NewHub(0)
	hub.SetBridgeAttach(func(pty.PTYInstanceSnapshot) []byte { return nil })
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	if hub.enqueueBridgeSnapshot(pty.PTYInstanceSnapshot{ID: "pane-1"}, client) {
		t.Fatal("nil attach payload must send nothing")
	}
	if len(client.Send) != 1 {
		t.Fatalf("unexpected frames queued: %d", len(client.Send))
	}
}

func TestOnPaneExitHookDispatches(t *testing.T) {
	hub := NewHub(0)
	var got string
	var code int
	hub.SetOnPaneExit(func(inst *pty.PTYInstance, c int) {
		got, code = inst.ID, c
	})
	inst := &pty.PTYInstance{ID: "pane-9"}
	hub.notifyPaneExit(inst, 3)
	if got != "pane-9" || code != 3 {
		t.Fatalf("hook got (%q,%d)", got, code)
	}
	(&Hub{}).notifyPaneExit(inst, 0) // nil hook is a no-op
}

// A delayed old read-loop exit after a same-ID retry must not broadcast
// a false exit, close the replacement's clients/history, or fire the
// lease hook. The current exit still cleans up fully.
func TestStaleExitPreservesReplacementPane(t *testing.T) {
	hub := NewHub(0)
	var exits []*pty.PTYInstance
	hub.SetOnPaneExit(func(inst *pty.PTYInstance, c int) {
		exits = append(exits, inst)
	})
	oldInst := &pty.PTYInstance{ID: "pane-1"}
	newInst := &pty.PTYInstance{ID: "pane-1"}
	hub.notePaneOwner(oldInst)
	oldClient := &Client{Send: make(chan []byte, 8)}
	hub.Register("pane-1", oldClient)
	if err := hub.Ingest("pane-1", []byte("old output")); err != nil {
		t.Fatalf("ingest old: %v", err)
	}
	drainFrames(oldClient.Send)
	// Retry reuses the pane ID with a new instance.
	hub.notePaneOwner(newInst)
	newClient := &Client{Send: make(chan []byte, 8)}
	hub.Register("pane-1", newClient)
	if err := hub.Ingest("pane-1", []byte("new output")); err != nil {
		t.Fatalf("ingest new: %v", err)
	}
	drainFrames(oldClient.Send)
	drainFrames(newClient.Send)
	if hub.exitPaneForOwner(oldInst, 1) {
		t.Fatal("stale exit ran cleanup")
	}
	if _, ok := hub.LookupPane("pane-1"); !ok {
		t.Fatal("stale exit deleted replacement pane")
	}
	select {
	case frame := <-newClient.Send:
		t.Fatalf("stale exit sent frame to new client: %v", frame)
	default:
	}
	// The replacement pane still ingests and delivers: clients open.
	if err := hub.Ingest("pane-1", []byte("after stale")); err != nil {
		t.Fatalf("ingest after stale: %v", err)
	}
	select {
	case frame := <-newClient.Send:
		if len(frame) == 0 || frame[0] != 0x01 {
			t.Fatalf("expected output frame, got %v", frame)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("new client missed output after stale exit")
	}
	drainFrames(oldClient.Send)
	if len(exits) != 0 {
		t.Fatalf("stale exit fired hook %d times, lease would revoke", len(exits))
	}
	if !hub.exitPaneForOwner(newInst, 0) {
		t.Fatal("current exit skipped cleanup")
	}
	if _, ok := hub.LookupPane("pane-1"); ok {
		t.Fatal("current exit did not delete pane")
	}
	foundExit := false
	for {
		frame, ok := <-newClient.Send
		if !ok {
			break
		}
		if len(frame) > 0 && frame[0] == 0x04 {
			foundExit = true
			if !strings.Contains(string(frame[1:]), `"code":0`) {
				t.Fatalf("exit payload %s", frame[1:])
			}
		}
	}
	if !foundExit {
		t.Fatal("current exit did not broadcast to new client")
	}
	if len(exits) != 1 || exits[0] != newInst {
		t.Fatalf("exits %+v, want one new-inst hook", exits)
	}
}
