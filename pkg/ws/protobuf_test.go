package ws

// M1 terminal core and admission over real WebSockets. Every frame here
// is a generated protobuf message; the negotiated subprotocol is the
// endpoint token. Input, resize, and exit run against real PTYs.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

func protobufTestServer(t *testing.T, hub *Hub, manager *pty.Manager, inst *pty.PTYInstance) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		HandleWS(w, r, inst, manager, hub)
	}))
	t.Cleanup(server.Close)
	return server
}

func terminalURL(server *httptest.Server) string {
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

func dialTerminal(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{
		Subprotocols:     []string{wireproto.TerminalSubprotocol},
		HandshakeTimeout: 5 * time.Second,
	}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if conn.Subprotocol() != wireproto.TerminalSubprotocol {
		t.Fatalf("negotiated subprotocol %q", conn.Subprotocol())
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	return conn
}

func readServerFrame(t *testing.T, conn *websocket.Conn) *wspb.TerminalServerFrame {
	t.Helper()
	mt, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Fatalf("message type %d, want binary", mt)
	}
	frame, err := wireproto.DecodeServerFrame(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return frame
}

func sendClientFrame(t *testing.T, conn *websocket.Conn, frame *wspb.TerminalClientFrame) {
	t.Helper()
	raw, err := proto.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func expectClose(t *testing.T, conn *websocket.Conn, code int) {
	t.Helper()
	_, _, err := conn.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != code {
		t.Fatalf("close = %v, want code %d", err, code)
	}
}

func aliveGhost(id string) *pty.PTYInstance {
	return &pty.PTYInstance{ID: id, Pty: &pty.Pty{Closed: make(chan struct{})}}
}

func TestWebSocketProtobufTerminalCore(t *testing.T) {
	t.Run("attach before output stays ordered", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("core-pane")
		server := protobufTestServer(t, hub, manager, inst)

		hub.Ingest(inst.ID, []byte("old bytes"))
		conn := dialTerminal(t, terminalURL(server))

		attach := readServerFrame(t, conn).GetAttach()
		if attach == nil {
			t.Fatal("first frame is not an attach")
		}
		if attach.Epoch == nil || attach.Oldest == nil || attach.Head == nil {
			t.Fatal("attach left a frontier absent")
		}
		if attach.GetHead() != uint64(len("old bytes")) || attach.GetOldest() != 0 {
			t.Fatalf("attach frontiers oldest=%d head=%d", attach.GetOldest(), attach.GetHead())
		}
		if attach.GetCheckpoint() != nil {
			t.Fatalf("no checkpoint stored, got %+v", attach.GetCheckpoint())
		}

		hub.Ingest(inst.ID, []byte("live bytes"))
		out := readServerFrame(t, conn).GetOutput()
		if out == nil {
			t.Fatal("second frame is not output")
		}
		if out.GetStart() != uint64(len("old bytes")) || string(out.GetData()) != "live bytes" {
			t.Fatalf("output start=%d data=%q", out.GetStart(), out.GetData())
		}
	})

	t.Run("input reaches the PTY", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		t.Cleanup(func() { manager.Shutdown(100 * time.Millisecond) })
		shell, args := getTestShellForBridge()
		inst, err := manager.Spawn(context.Background(), t.TempDir(), shell, args, "shell", "")
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		StartPTYReadLoop(inst, hub)
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}

		before := inst.LastInputAt
		sendClientFrame(t, conn, &wspb.TerminalClientFrame{
			Payload: &wspb.TerminalClientFrame_Input{Input: []byte("echo CORE123\r")},
		})
		// The server dispatches asynchronously; the echo below proves the
		// bytes reached the PTY, and only then is LastInputAt checked.
		deadline := time.Now().Add(10 * time.Second)
		for {
			if time.Now().After(deadline) {
				t.Fatal("typed input never echoed back")
			}
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			mt, raw, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if mt != websocket.BinaryMessage {
				t.Fatalf("message type %d, want binary", mt)
			}
			frame, err := wireproto.DecodeServerFrame(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if out := frame.GetOutput(); out != nil && bytes.Contains(out.GetData(), []byte("CORE123")) {
				if !inst.LastInputAt.After(before) {
					t.Fatal("echo arrived but input dispatch was not recorded")
				}
				return
			}
		}
	})

	t.Run("resize is recorded", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		t.Cleanup(func() { manager.Shutdown(100 * time.Millisecond) })
		shell, args := getTestShellForBridge()
		inst, err := manager.Spawn(context.Background(), t.TempDir(), shell, args, "shell", "")
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		hub.Ingest(inst.ID, []byte("shell output"))
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}

		sendClientFrame(t, conn, &wspb.TerminalClientFrame{
			Payload: &wspb.TerminalClientFrame_Resize{Resize: &wspb.TerminalResize{
				Cols: proto.Uint32(100),
				Rows: proto.Uint32(30),
			}},
		})
		deadline := time.Now().Add(3 * time.Second)
		for {
			rec, ok := hub.Recording(inst.ID, 0, 1<<20)
			if ok {
				for _, m := range rec.Resizes {
					if m.Cols == 100 && m.Rows == 30 {
						return
					}
				}
			}
			if time.Now().After(deadline) {
				t.Fatal("resize marker 100x30 never recorded")
			}
			time.Sleep(50 * time.Millisecond)
		}
	})

	t.Run("invalid resize closes with 1002", func(t *testing.T) {
		cases := map[string]*wspb.TerminalResize{
			"zero cols":    {Cols: proto.Uint32(0), Rows: proto.Uint32(30)},
			"zero rows":    {Cols: proto.Uint32(100), Rows: proto.Uint32(0)},
			"cols too big": {Cols: proto.Uint32(65536), Rows: proto.Uint32(30)},
			"missing rows": {Cols: proto.Uint32(100)},
		}
		for name, resize := range cases {
			t.Run(name, func(t *testing.T) {
				hub := NewHub(4096)
				manager := pty.NewManager()
				inst := aliveGhost("resize-pane")
				server := protobufTestServer(t, hub, manager, inst)
				conn := dialTerminal(t, terminalURL(server))
				if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
					t.Fatal("first frame is not an attach")
				}
				sendClientFrame(t, conn, &wspb.TerminalClientFrame{
					Payload: &wspb.TerminalClientFrame_Resize{Resize: resize},
				})
				expectClose(t, conn, websocket.CloseProtocolError)
			})
		}
	})

	t.Run("ping answers pong", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("ping-pane")
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
		sendClientFrame(t, conn, &wspb.TerminalClientFrame{
			Payload: &wspb.TerminalClientFrame_Ping{Ping: &wspb.TerminalPing{}},
		})
		if pong := readServerFrame(t, conn).GetPong(); pong == nil {
			t.Fatal("ping was not answered with a pong")
		}
	})

	t.Run("oversize input closes with 1009 and never dispatches", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("oversize-pane")
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
		sendClientFrame(t, conn, &wspb.TerminalClientFrame{
			Payload: &wspb.TerminalClientFrame_Input{
				Input: bytes.Repeat([]byte("x"), wireproto.MaxTerminalMessageBytes+1),
			},
		})
		expectClose(t, conn, websocket.CloseMessageTooBig)
		if !inst.LastInputAt.IsZero() {
			t.Fatal("oversize input reached pane dispatch")
		}
	})

	t.Run("malformed bytes close with 1002", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("malformed-pane")
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, []byte("not-protobuf\xff\xfe")); err != nil {
			t.Fatalf("write: %v", err)
		}
		expectClose(t, conn, websocket.CloseProtocolError)
		if !inst.LastInputAt.IsZero() {
			t.Fatal("malformed bytes reached pane dispatch")
		}
	})

	t.Run("live PTY death broadcasts a signed exit", func(t *testing.T) {
		hub := NewHub(4096)
		manager := pty.NewManager()
		t.Cleanup(func() { manager.Shutdown(100 * time.Millisecond) })
		shell, args := getTestShellForBridge()
		inst, err := manager.Spawn(context.Background(), t.TempDir(), shell, args, "shell", "")
		if err != nil {
			t.Fatalf("spawn: %v", err)
		}
		StartPTYReadLoop(inst, hub)
		server := protobufTestServer(t, hub, manager, inst)
		conn := dialTerminal(t, terminalURL(server))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
		sendClientFrame(t, conn, &wspb.TerminalClientFrame{
			Payload: &wspb.TerminalClientFrame_Input{Input: []byte("exit\r")},
		})
		deadline := time.Now().Add(10 * time.Second)
		for {
			if time.Now().After(deadline) {
				t.Fatal("PTY death never broadcast an exit")
			}
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			frame := readServerFrame(t, conn)
			if exit := frame.GetExit(); exit != nil {
				if exit.GetCode() != 0 {
					t.Fatalf("exit code = %d, want 0", exit.GetCode())
				}
				return
			}
		}
	})
}

func TestWebSocketProtobufTerminalAdmission(t *testing.T) {
	setup := func(t *testing.T) string {
		t.Helper()
		hub := NewHub(4096)
		manager := pty.NewManager()
		inst := aliveGhost("admission-pane")
		return terminalURL(protobufTestServer(t, hub, manager, inst))
	}

	t.Run("correct token is accepted", func(t *testing.T) {
		conn := dialTerminal(t, setup(t))
		if attach := readServerFrame(t, conn).GetAttach(); attach == nil {
			t.Fatal("first frame is not an attach")
		}
	})

	t.Run("missing token is rejected with 426", func(t *testing.T) {
		_, resp, err := websocket.DefaultDialer.Dial(setup(t), nil)
		if err == nil {
			t.Fatal("upgrade without a subprotocol unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("response = %#v, want HTTP 426", resp)
		}
	})

	t.Run("wrong token is rejected with 426", func(t *testing.T) {
		dialer := websocket.Dialer{
			Subprotocols:     []string{"bogus-proto-v1"},
			HandshakeTimeout: 5 * time.Second,
		}
		_, resp, err := dialer.Dial(setup(t), nil)
		if err == nil {
			t.Fatal("upgrade with a wrong subprotocol unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("response = %#v, want HTTP 426", resp)
		}
	})

	t.Run("cross-origin with token keeps the 403", func(t *testing.T) {
		dialer := websocket.Dialer{
			Subprotocols:     []string{wireproto.TerminalSubprotocol},
			HandshakeTimeout: 5 * time.Second,
		}
		header := http.Header{"Origin": []string{"https://not-phi.example"}}
		_, resp, err := dialer.Dial(setup(t), header)
		if err == nil {
			t.Fatal("cross-origin upgrade unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("response = %#v, want HTTP 403", resp)
		}
	})

	t.Run("shared upgrader keeps no subprotocol", func(t *testing.T) {
		if len(Upgrader.Subprotocols) != 0 {
			t.Fatalf("shared upgrader carries %q; concurrent endpoints would leak", Upgrader.Subprotocols)
		}
	})
}
