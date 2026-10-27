package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"encoding/json"
	neturl "net/url"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/ws"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// The production pane, events, and control handlers must each consult the
// access fence themselves: removing an AdmitAuth call from one handler must
// fail a test here, not only a fencer unit test.

func dialAuthSocket(t *testing.T, serverURL, path, subprotocol string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
	conn, _, err := dialer.Dial(
		"ws"+strings.TrimPrefix(serverURL, "http")+path,
		nil,
	)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func expectClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_ = conn.SetReadDeadline(deadline)
		_, _, err := conn.ReadMessage()
		if err == nil {
			// Frames queued before the close drain first.
			continue
		}
		var netErr interface{ Timeout() bool }
		if errors.As(err, &netErr) && netErr.Timeout() {
			t.Fatal("stale socket stayed open: read timed out")
		}
		return
	}
}

func expectOpen(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err := conn.ReadMessage()
	var netErr interface{ Timeout() bool }
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("current socket closed or errored: %v", err)
	}
}

func fencedHandler(fence ws.AuthFence, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r.WithContext(ws.WithAuthFence(r.Context(), fence)))
	}
}

func TestAccessWSPaneFenceRejectsStaleUpgrade(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "fence-sid", pty.SpawnOptions{ID: "fence-pane"})
	if err != nil {
		t.Fatalf("spawn fence pane: %v", err)
	}
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)

	stale := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 1}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	}))
	defer stale.Close()
	conn := dialAuthSocket(t, stale.URL, "/ws/pane/fence-pane", wireproto.TerminalSubprotocol)
	expectClosed(t, conn)
	if _, ok := hub.LookupPane("fence-pane"); ok {
		t.Fatal("stale pane upgrade registered a client")
	}

	current := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 2}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	}))
	defer current.Close()
	conn = dialAuthSocket(t, current.URL, "/ws/pane/fence-pane", wireproto.TerminalSubprotocol)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatalf("current pane upgrade did not attach: %v", err)
	}
	if _, ok := hub.LookupPane("fence-pane"); !ok {
		t.Fatal("current pane upgrade did not register a client")
	}
}

func TestAccessWSEventsFenceRejectsStaleUpgrade(t *testing.T) {
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)

	stale := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 1}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	}))
	defer stale.Close()
	expectClosed(t, dialAuthSocket(t, stale.URL, "/ws/md-events", wireproto.EventsSubprotocol))

	current := httptest.NewServer(fencedHandler(ws.AuthFence{Generation: 2}, func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	}))
	defer current.Close()
	expectOpen(t, dialAuthSocket(t, current.URL, "/ws/md-events", wireproto.EventsSubprotocol))
}

func TestAccessWSControlFenceRejectsStaleUpgrade(t *testing.T) {
	hub := ws.NewHub(0)
	t.Cleanup(func() { _ = hub.Close() })
	hub.RotateAuth(2)
	manager := rpc.NewManager()
	handler := func(fence ws.AuthFence) http.HandlerFunc {
		return fencedHandler(fence, ws.HandleControl(hub, manager, func() string { return "" }))
	}

	stale := httptest.NewServer(handler(ws.AuthFence{Generation: 1}))
	defer stale.Close()
	expectClosed(t, dialAuthSocket(t, stale.URL, "/ws/control", wireproto.ControlSubprotocol))

	current := httptest.NewServer(handler(ws.AuthFence{Generation: 2}))
	defer current.Close()
	expectOpen(t, dialAuthSocket(t, current.URL, "/ws/control", wireproto.ControlSubprotocol))
}

// A real password change must close sockets admitted at the previous
// generation on all three routes, through the production middleware, hub,
// and handlers, and the new credential must connect afterwards.
func TestAccessWSHandlersCloseOnPasswordChange(t *testing.T) {
	withTempConfig(t)
	useTestAccessAuth(t)
	hub := testAccessUseHub(t)
	token := testAccessEnableV2(t, testAccessPassword)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(2 * time.Second) })
	shell, args := testMainShell()
	instance, err := manager.SpawnWithOptions(context.Background(), home, shell, args, "pi", "rotate-sid", pty.SpawnOptions{ID: "rotate-pane"})
	if err != nil {
		t.Fatalf("spawn rotate pane: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/pane/rotate-pane", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, instance, manager, hub)
	})
	mux.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, hub)
	})
	mux.HandleFunc("/ws/control", ws.HandleControl(hub, rpc.NewManager(), func() string { return home }))
	server := httptest.NewServer(accessAuthMiddleware(mux))
	defer server.Close()

	dial := func(path, subprotocol, credential string) *websocket.Conn {
		t.Helper()
		url := "ws" + strings.TrimPrefix(server.URL, "http") + path + "?token=" + neturl.QueryEscape(credential)
		dialer := websocket.Dialer{Subprotocols: []string{subprotocol}}
		conn, _, err := dialer.Dial(url, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", path, err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}

	pane := dial("/ws/pane/rotate-pane", wireproto.TerminalSubprotocol, token)
	_ = pane.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := pane.ReadMessage(); err != nil {
		t.Fatalf("pane attach before rotation: %v", err)
	}
	events := dial("/ws/md-events", wireproto.EventsSubprotocol, token)
	control := dial("/ws/control", wireproto.ControlSubprotocol, token)

	response := testAccessV2PasswordRequest(t, `{"password":"test-pass-5678"}`, token)
	if response.Code != http.StatusOK {
		t.Fatalf("change password: %d %s", response.Code, response.Body.String())
	}
	expectClosed(t, pane)
	expectClosed(t, events)
	expectClosed(t, control)

	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Token == "" {
		t.Fatalf("replacement token: %v %q", err, response.Body.String())
	}
	expectOpen(t, dial("/ws/md-events", wireproto.EventsSubprotocol, body.Token))
}
