package ws

// M2 events endpoint and cross-endpoint admission over real WebSockets.
// Every frame here is a generated protobuf message; each endpoint
// negotiates its own token. The events socket receives bare
// Notifications while pane clients receive the TerminalServerFrame
// wrapper for the same broadcast.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

func eventsTestServer(t *testing.T, hub *Hub) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleEventsWS(w, r, hub)
	}))
	t.Cleanup(server.Close)
	return server
}

func dialEvents(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{
		Subprotocols:     []string{wireproto.EventsSubprotocol},
		HandshakeTimeout: 5 * time.Second,
	}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if conn.Subprotocol() != wireproto.EventsSubprotocol {
		t.Fatalf("negotiated subprotocol %q", conn.Subprotocol())
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	return conn
}

func readNotification(t *testing.T, conn *websocket.Conn) *wspb.Notification {
	t.Helper()
	mt, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type %d, want binary", mt)
	}
	notif, err := wireproto.DecodeNotification(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return notif
}

func TestWebSocketProtobufEvents(t *testing.T) {
	t.Run("correct token is accepted", func(t *testing.T) {
		hub := NewHub(0)
		conn := dialEvents(t, terminalURL(eventsTestServer(t, hub)))
		waitForEventsClientCount(t, hub, 1)
		_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Fatal("idle events socket unexpectedly delivered a frame")
		}
	})

	t.Run("missing token is rejected with 426", func(t *testing.T) {
		hub := NewHub(0)
		_, resp, err := websocket.DefaultDialer.Dial(terminalURL(eventsTestServer(t, hub)), nil)
		if err == nil {
			t.Fatal("upgrade without a subprotocol unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("response = %#v, want HTTP 426", resp)
		}
	})

	t.Run("wrong token is rejected with 426", func(t *testing.T) {
		hub := NewHub(0)
		dialer := websocket.Dialer{
			Subprotocols:     []string{wireproto.TerminalSubprotocol},
			HandshakeTimeout: 5 * time.Second,
		}
		_, resp, err := dialer.Dial(terminalURL(eventsTestServer(t, hub)), nil)
		if err == nil {
			t.Fatal("upgrade with the pane token unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("response = %#v, want HTTP 426", resp)
		}
	})

	t.Run("bounded inbound traffic is drained and ignored", func(t *testing.T) {
		hub := NewHub(0)
		conn := dialEvents(t, terminalURL(eventsTestServer(t, hub)))
		waitForEventsClientCount(t, hub, 1)
		if err := conn.WriteMessage(websocket.BinaryMessage, bytes.Repeat([]byte("x"), wireproto.MaxEventsMessageBytes)); err != nil {
			t.Fatalf("write: %v", err)
		}
		// The socket stays open: the next broadcast still arrives.
		hub.BroadcastNotification(&wspb.Notification{
			Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
				Dir: proto.String("/tmp/docs"),
			}},
		})
		if md := readNotification(t, conn).GetMarkdownChanged(); md == nil || md.GetDir() != "/tmp/docs" {
			t.Fatalf("notification = %+v, want markdown dir /tmp/docs", md)
		}
	})

	t.Run("oversize inbound closes with 1009", func(t *testing.T) {
		hub := NewHub(0)
		conn := dialEvents(t, terminalURL(eventsTestServer(t, hub)))
		waitForEventsClientCount(t, hub, 1)
		if err := conn.WriteMessage(websocket.BinaryMessage, bytes.Repeat([]byte("x"), wireproto.MaxEventsMessageBytes+1)); err != nil {
			t.Fatalf("write: %v", err)
		}
		expectClose(t, conn, websocket.CloseMessageTooBig)
	})

	t.Run("sync and shutdown variants decode", func(t *testing.T) {
		hub := NewHub(0)
		conn := dialEvents(t, terminalURL(eventsTestServer(t, hub)))
		waitForEventsClientCount(t, hub, 1)
		hub.BroadcastNotification(&wspb.Notification{
			Kind: &wspb.Notification_SyncChanged{SyncChanged: &wspb.SyncChanged{
				Action: proto.String("upsert"),
				Key:    proto.String("board-1"),
				Msg: &wspb.SyncMessageState{
					Key:             proto.String("board-1"),
					Value:           proto.String("hello"),
					CreatedAtUnixMs: proto.Int64(1700000000000),
					UpdatedAtUnixMs: proto.Int64(1700000001000),
				},
			}},
		})
		sync := readNotification(t, conn).GetSyncChanged()
		if sync == nil || sync.GetAction() != "upsert" || sync.GetKey() != "board-1" {
			t.Fatalf("sync = %+v", sync)
		}
		if sync.GetMsg().GetValue() != "hello" || sync.GetMsg().GetUpdatedAtUnixMs() != 1700000001000 {
			t.Fatalf("sync msg = %+v", sync.GetMsg())
		}
		hub.BroadcastShutdown("restart")
		if shutdown := readNotification(t, conn).GetShutdown(); shutdown == nil || shutdown.GetReason() != "restart" {
			t.Fatalf("shutdown = %+v", shutdown)
		}
	})

	t.Run("pane clients receive the terminal wrapper", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("events-routing-pane")
		paneConn := dialTerminal(t, terminalURL(protobufTestServer(t, hub, manager, inst)))
		if attach := readServerFrame(t, paneConn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
		eventsConn := dialEvents(t, terminalURL(eventsTestServer(t, hub)))
		waitForEventsClientCount(t, hub, 1)

		hub.BroadcastNotification(&wspb.Notification{
			Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
				Dir: proto.String("/tmp/docs"),
			}},
		})
		// The events socket receives the bare Notification.
		if md := readNotification(t, eventsConn).GetMarkdownChanged(); md == nil || md.GetDir() != "/tmp/docs" {
			t.Fatalf("events notification = %+v", md)
		}
		// The pane socket receives the same payload wrapped in a
		// TerminalServerFrame, so its decoder never branches on bytes.
		frame := readServerFrame(t, paneConn)
		wrapped := frame.GetNotification()
		if wrapped == nil {
			t.Fatalf("pane frame = %+v, want notification wrapper", frame.GetPayload())
		}
		if md := wrapped.GetMarkdownChanged(); md == nil || md.GetDir() != "/tmp/docs" {
			t.Fatalf("wrapped notification = %+v", wrapped)
		}
	})
}

func TestWebSocketProtobufAdmissionIsolation(t *testing.T) {
	hub := NewHub(4096)
	manager := pty.NewManager()
	inst := aliveGhost("isolation-pane")
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/pane", func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, hub)
	})
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		HandleEventsWS(w, r, hub)
	})
	mux.Handle("/ws/control", HandleControl(rpc.NewManager(), func() string { return t.TempDir() }))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	base := terminalURL(server)

	dial := func(t *testing.T, path, token string) *websocket.Conn {
		t.Helper()
		dialer := websocket.Dialer{
			Subprotocols:     []string{token},
			HandshakeTimeout: 5 * time.Second,
		}
		conn, _, err := dialer.Dial(base+path, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", path, err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		if conn.Subprotocol() != token {
			t.Fatalf("%s negotiated %q, want %q", path, conn.Subprotocol(), token)
		}
		return conn
	}

	paneConn := dial(t, "/ws/pane", wireproto.TerminalSubprotocol)
	eventsConn := dial(t, "/ws/md-events", wireproto.EventsSubprotocol)
	controlConn := dial(t, "/ws/control", wireproto.ControlSubprotocol)

	// Each endpoint still speaks its own protocol after concurrent
	// admission: the pane socket attaches, the events socket receives a
	// bare notification, and the control socket answers a hello.
	_ = paneConn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if attach := readServerFrame(t, paneConn).GetAttach(); attach == nil {
		t.Fatal("pane socket did not attach")
	}
	waitForEventsClientCount(t, hub, 1)
	hub.BroadcastNotification(&wspb.Notification{
		Kind: &wspb.Notification_Shutdown{Shutdown: &wspb.ServerShutdown{
			Reason: proto.String("shutdown"),
		}},
	})
	_ = eventsConn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if shutdown := readNotification(t, eventsConn).GetShutdown(); shutdown == nil {
		t.Fatal("events socket did not receive the shutdown")
	}
	_ = controlConn.SetReadDeadline(time.Now().Add(10 * time.Second))
	writeFrame(t, controlConn, &wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Hello{
		Hello: &wspb.ControlHello{Version: uint32(rpc.ProtocolVersion)},
	}})
	if welcome := readFrame(t, controlConn).GetWelcome(); welcome == nil {
		t.Fatal("control socket did not welcome the hello")
	}

	// A wrong token per endpoint is still rejected after the concurrent
	// admissions above.
	for path, token := range map[string]string{
		"/ws/pane":      wireproto.EventsSubprotocol,
		"/ws/md-events": wireproto.ControlSubprotocol,
		"/ws/control":   wireproto.TerminalSubprotocol,
	} {
		dialer := websocket.Dialer{
			Subprotocols:     []string{token},
			HandshakeTimeout: 5 * time.Second,
		}
		_, resp, err := dialer.Dial(base+path, nil)
		if err == nil {
			t.Fatalf("%s accepted foreign token %q", path, token)
		}
		if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("%s response = %#v, want HTTP 426", path, resp)
		}
	}

	if len(Upgrader.Subprotocols) != 0 {
		t.Fatalf("shared upgrader carries %q; concurrent endpoints would leak", Upgrader.Subprotocols)
	}
}
