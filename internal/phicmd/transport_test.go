package phicmd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	phiaccess "github.com/hypernewbie/phi/internal/phiaccess"
	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// fakeREST is a Phi backend's REST surface: public liveness, an optional
// access login, and gated API endpoints. It speaks the real shapes.
type fakeREST struct {
	mu sync.Mutex
	ts *httptest.Server

	authEnabled  bool
	password     string
	sessions     []map[string]any
	cookies      map[string]bool // session cookie values
	requests     []string
	coders       []map[string]any
	terminals    []map[string]any
	rawDiff      string
	runResult    map[string]any
	gateWith401  func(path string) bool
	extraHandler func(w http.ResponseWriter, r *http.Request)
}

func newFakeREST(t *testing.T) *fakeREST {
	t.Helper()
	f := &fakeREST{authEnabled: false, cookies: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if !f.authEnabled {
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": false, "authenticated": false})
			return
		}
		status := phiaccess.Status{
			Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256",
			Iterations: 10, Salt: base64.RawURLEncoding.EncodeToString([]byte("salt")),
			Challenge: fmt.Sprintf("challenge-%d", time.Now().UnixNano()),
		}
		if f.cookieOK(r) {
			status.Authenticated = true
		}
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var req struct {
			Challenge string `json:"challenge"`
			Proof     string `json:"proof"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		proof, err := phiaccess.Proof(f.password, phiaccess.Status{
			Algorithm: "pbkdf2-sha256", Iterations: 10,
			Salt:      base64.RawURLEncoding.EncodeToString([]byte("salt")),
			Challenge: req.Challenge,
		})
		if err != nil || proof != req.Proof {
			http.Error(w, "Invalid password", http.StatusUnauthorized)
			return
		}
		// The real server sets Path "/" (internal/access/auth.go); a cookie
		// without it would default to /api/auth and never match other paths.
		http.SetCookie(w, &http.Cookie{Name: "phi_session", Value: "granted", Path: "/", HttpOnly: true})
		f.cookies["granted"] = true
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hostname": "fake-host", "theme_color": "#aa0000",
			"workspaces": []string{"/w1"}, "active_cwd": "/w1",
		})
	})
	mux.HandleFunc("/api/coders", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		f.mu.Lock()
		coders := f.coders
		f.mu.Unlock()
		if coders == nil {
			coders = []map[string]any{{"id": "pi", "name": "Pi (term)", "sidebar_visible": true, "capabilities": map[string]bool{"list": true, "transcript": true, "pi_rpc": true}}}
		}
		_ = json.NewEncoder(w).Encode(coders)
	})
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		f.mu.Lock()
		sessions := f.sessions
		f.mu.Unlock()
		if sessions == nil {
			sessions = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(sessions)
	})
	mux.HandleFunc("/api/terminals", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		f.mu.Lock()
		terminals := f.terminals
		f.mu.Unlock()
		if terminals == nil {
			terminals = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(terminals)
	})
	mux.HandleFunc("/api/git/raw-diff", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		f.mu.Lock()
		diff := f.rawDiff
		f.mu.Unlock()
		_, _ = w.Write([]byte(diff))
	})
	mux.HandleFunc("/api/cmd/run", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		f.mu.Lock()
		res := f.runResult
		f.mu.Unlock()
		if res == nil {
			res = map[string]any{"results": []map[string]any{{"worktree": "/w1", "success": true, "exit_code": 0, "output": "ran", "duration_ms": 1}}}
		}
		_ = json.NewEncoder(w).Encode(res)
	})
	mux.HandleFunc("/api/session-transcript", func(w http.ResponseWriter, r *http.Request) {
		if f.denyUnauthed(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{{"role": "user", "text": "hi"}})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if f.extraHandler != nil {
			f.extraHandler(w, r)
			return
		}
		http.NotFound(w, r)
	})
	f.ts = httptest.NewServer(mux)
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeREST) url() string { return f.ts.URL }

func (f *fakeREST) cookieOK(r *http.Request) bool {
	for _, c := range r.Cookies() {
		if c.Name == "phi_session" && f.cookies[c.Value] {
			return true
		}
	}
	return false
}

// denyUnauthed applies the access middleware's contract: 401 unless the
// request carries a granted cookie (and auth is enabled).
func (f *fakeREST) denyUnauthed(w http.ResponseWriter, r *http.Request) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	if f.gateWith401 != nil && f.gateWith401(r.URL.Path) {
		http.Error(w, "access authentication required", http.StatusUnauthorized)
		return true
	}
	if !f.authEnabled || f.cookieOK(r) {
		return false
	}
	http.Error(w, "access authentication required", http.StatusUnauthorized)
	return true
}

func fixedPassword(pw string) PasswordSource {
	return func(context.Context) (string, error) { return pw, nil }
}

func TestHealthProbesWithoutCookie(t *testing.T) {
	f := newFakeREST(t)
	f.mu.Lock()
	f.authEnabled = true
	f.mu.Unlock()
	h, err := NewHTTP(f.url(), NoPassword)
	if err != nil {
		t.Fatal(err)
	}
	// Health must not attempt login even though auth is on.
	if err := h.Health(context.Background()); err != nil {
		t.Fatalf("health: %v", err)
	}
}

func TestGetWithoutAuthFailsWithHint(t *testing.T) {
	f := newFakeREST(t)
	f.mu.Lock()
	f.authEnabled = true
	f.mu.Unlock()
	h, _ := NewHTTP(f.url(), NoPassword)
	err := h.Do(context.Background(), http.MethodGet, "/api/coders", nil, nil)
	if err == nil {
		t.Fatal("expected auth failure")
	}
	if !strings.Contains(err.Error(), "PHI_CMD_PASSWORD") {
		t.Fatalf("error must name the env var: %v", err)
	}
}

func TestLoginRetryOn401(t *testing.T) {
	f := newFakeREST(t)
	f.mu.Lock()
	f.authEnabled = true
	f.password = "secret-pw"
	f.mu.Unlock()
	h, _ := NewHTTP(f.url(), fixedPassword("secret-pw"))
	var coders []map[string]any
	if err := h.Do(context.Background(), http.MethodGet, "/api/coders", nil, &coders); err != nil {
		t.Fatalf("login retry: %v", err)
	}
	if len(coders) != 1 || coders[0]["id"] != "pi" {
		t.Fatalf("coders: %+v", coders)
	}
}

func TestLoginBadPasswordIsAuthExit(t *testing.T) {
	f := newFakeREST(t)
	f.mu.Lock()
	f.authEnabled = true
	f.password = "secret-pw"
	f.mu.Unlock()
	h, _ := NewHTTP(f.url(), fixedPassword("wrong"))
	err := h.Do(context.Background(), http.MethodGet, "/api/coders", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid password") {
		t.Fatalf("want invalid-password error, got %v", err)
	}
}

func TestResponseCap(t *testing.T) {
	f := newFakeREST(t)
	f.mu.Lock()
	f.rawDiff = strings.Repeat("x", 5000)
	f.mu.Unlock()
	h, _ := NewHTTP(f.url(), NoPassword)
	h.MaxBytes = 100
	body, status, err := h.Raw(context.Background(), http.MethodGet, "/api/git/raw-diff", nil)
	if err != nil || status != 200 {
		t.Fatalf("raw: %d %v", status, err)
	}
	if len(body) != 100 {
		t.Fatalf("cap: got %d bytes", len(body))
	}
}

// ---- control fakes ----

// fakeControl speaks the real control handshake and answers calls from a
// table keyed by variant name. Events can be pushed on demand.
type fakeControl struct {
	ts         *httptest.Server
	conns      []*websocket.Conn
	mu         sync.Mutex
	sawCalls   []string
	helloOK    bool
	responder  func(call *wspb.ControlCall) *wspb.ControlResponse
	eventHooks []func(conn *websocket.Conn)
}

func newFakeControl(t *testing.T) *fakeControl {
	t.Helper()
	fc := &fakeControl{}
	upgrader := websocket.Upgrader{Subprotocols: []string{wireproto.ControlSubprotocol}}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/control", func(w http.ResponseWriter, r *http.Request) {
		if !wireproto.ClientRequestedSubprotocol(r, wireproto.ControlSubprotocol) {
			http.Error(w, "expected subprotocol", http.StatusUpgradeRequired)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxControlMessageBytes)
		if err != nil || mt != websocket.BinaryMessage {
			return
		}
		frame := &wspb.ControlClientFrame{}
		if err := proto.Unmarshal(raw, frame); err != nil {
			return
		}
		hello := frame.GetHello()
		fc.mu.Lock()
		fc.helloOK = hello != nil && hello.GetVersion() == uint32(rpc.ProtocolVersion)
		grpcOK := fc.helloOK
		fc.mu.Unlock()
		if !grpcOK {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseProtocolError, "expected hello v1"), time.Now().Add(time.Second))
			return
		}
		welcome, _ := proto.Marshal(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Welcome{
			Welcome: &wspb.ControlWelcome{Version: uint32(rpc.ProtocolVersion)},
		}})
		if err := conn.WriteMessage(websocket.BinaryMessage, welcome); err != nil {
			return
		}
		fc.mu.Lock()
		fc.conns = append(fc.conns, conn)
		fc.mu.Unlock()
		for {
			mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxControlMessageBytes)
			if err != nil {
				return
			}
			if mt != websocket.BinaryMessage {
				return
			}
			frame := &wspb.ControlClientFrame{}
			if err := proto.Unmarshal(raw, frame); err != nil {
				return
			}
			call := frame.GetCall()
			if call == nil {
				return
			}
			fc.mu.Lock()
			fc.sawCalls = append(fc.sawCalls, callVariant(call))
			responder := fc.responder
			fc.mu.Unlock()
			var resp *wspb.ControlResponse
			if responder != nil {
				resp = responder(call)
			}
			if resp == nil {
				resp = &wspb.ControlResponse{Id: call.GetId(), Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "no responder"}}}
			}
			resp.Id = call.GetId()
			out, _ := proto.Marshal(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Response{Response: resp}})
			if err := conn.WriteMessage(websocket.BinaryMessage, out); err != nil {
				return
			}
		}
	})
	fc.ts = httptest.NewServer(mux)
	t.Cleanup(fc.ts.Close)
	return fc
}

func callVariant(call *wspb.ControlCall) string {
	switch call.GetCall().(type) {
	case *wspb.ControlCall_Spawn:
		return "spawn"
	case *wspb.ControlCall_ListSessions:
		return "list_sessions"
	case *wspb.ControlCall_GetState:
		return "get_state"
	case *wspb.ControlCall_Hydrate:
		return "hydrate"
	case *wspb.ControlCall_GetMessages:
		return "get_messages"
	case *wspb.ControlCall_Prompt:
		return "prompt"
	case *wspb.ControlCall_GetAvailableModels:
		return "get_available_models"
	case *wspb.ControlCall_SetModel:
		return "set_model"
	case *wspb.ControlCall_GetAvailableThinkingLevels:
		return "get_available_thinking_levels"
	case *wspb.ControlCall_SetThinking:
		return "set_thinking"
	case *wspb.ControlCall_NewSession:
		return "new_session"
	case *wspb.ControlCall_Abort:
		return "abort"
	case *wspb.ControlCall_SetSessionName:
		return "set_session_name"
	}
	return "unknown"
}

func (fc *fakeControl) url() string {
	return "ws" + strings.TrimPrefix(fc.ts.URL, "http") + "/ws/control"
}

func dialFakeControl(t *testing.T, fc *fakeControl) *Control {
	t.Helper()
	h, err := NewHTTP(fc.ts.URL, NoPassword)
	if err != nil {
		t.Fatal(err)
	}
	c, err := DialControl(context.Background(), h)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestControlHandshakeAndHelloVersion(t *testing.T) {
	fc := newFakeControl(t)
	c := dialFakeControl(t, fc)
	_, _ = c.ListSessions(context.Background())
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if !fc.helloOK {
		t.Fatal("server did not see a valid hello v1")
	}
}

func TestControlRejectsWrongHello(t *testing.T) {
	fc := newFakeControl(t)
	dialer := &websocket.Dialer{Subprotocols: []string{wireproto.ControlSubprotocol}, HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.Dial(fc.url(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	bad, _ := proto.Marshal(&wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Hello{Hello: &wspb.ControlHello{Version: 99}}})
	if err := conn.WriteMessage(websocket.BinaryMessage, bad); err == nil {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, _, err = conn.ReadMessage()
		if err == nil {
			t.Fatal("server accepted a wrong hello version")
		}
	}
}

func TestControlSubprotocolIsRequired(t *testing.T) {
	fc := newFakeControl(t)
	dialer := &websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	_, resp, err := dialer.Dial(fc.url(), nil)
	if err == nil {
		t.Fatal("dial without subprotocol should fail")
	}
	if resp == nil || resp.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("want 426, got %+v", resp)
	}
}

// Every typed helper must encode the right oneof variant, correlate by
// id, and decode its result.
func TestControlOpsEncodeRightVariant(t *testing.T) {
	fc := newFakeControl(t)
	fc.mu.Lock()
	fc.responder = func(call *wspb.ControlCall) *wspb.ControlResponse {
		switch v := callVariant(call); v {
		case "list_sessions":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_ListSessions{ListSessions: &wspb.ListSessionsResult{Sessions: []*wspb.SessionSummary{{Sid: "s1", Title: "t", Cwd: "/w", Status: "live"}}}}}
		case "get_state":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetState{GetState: &wspb.StateResult{State: &wspb.ControlState{Sid: call.GetGetState().GetSid(), Busy: true, Status: "live", Model: strptr("m1")}}}}
		case "hydrate":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Hydrate{Hydrate: &wspb.TranscriptResult{Session: &wspb.TranscriptSnapshot{LastSeq: 7}}}}
		case "prompt":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Prompt{Prompt: &wspb.PromptResult{Accepted: true}}}
		case "get_available_models":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableModels{GetAvailableModels: &wspb.ModelsResult{Models: []*wspb.ModelInfo{{Provider: "anthropic", Id: "claude-1"}}}}}
		case "set_model":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetModel{SetModel: &wspb.StateResult{State: &wspb.ControlState{Model: strptr("claude-1")}}}}
		case "get_available_thinking_levels":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableThinkingLevels{GetAvailableThinkingLevels: &wspb.ThinkingLevelsResult{Levels: []string{"off", "on"}}}}
		case "set_thinking":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetThinking{SetThinking: &wspb.StateResult{State: &wspb.ControlState{Thinking: strptr("on")}}}}
		case "abort":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Abort{Abort: &wspb.AbortResult{}}}
		case "set_session_name":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetSessionName{SetSessionName: &wspb.StateResult{}}}
		case "spawn":
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Spawn{Spawn: &wspb.SpawnResult{Sid: "s-new", Title: "t", Cwd: "/w"}}}
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "no responder for " + callVariant(call)}}}
	}
	fc.mu.Unlock()

	c := dialFakeControl(t, fc)
	ctx := context.Background()

	sessions, err := c.ListSessions(ctx)
	if err != nil || len(sessions) != 1 || sessions[0].Sid != "s1" {
		t.Fatalf("list_sessions: %+v %v", sessions, err)
	}
	state, err := c.State(ctx, "s1")
	if err != nil || state.GetSid() != "s1" || !state.GetBusy() {
		t.Fatalf("get_state: %+v %v", state, err)
	}
	snap, err := c.Hydrate(ctx, "s1")
	if err != nil || snap.GetLastSeq() != 7 {
		t.Fatalf("hydrate: %+v %v", snap, err)
	}
	if err := c.Prompt(ctx, "s1", "hello"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	models, err := c.Models(ctx, "s1")
	if err != nil || len(models) != 1 || models[0].GetProvider() != "anthropic" {
		t.Fatalf("models: %+v %v", models, err)
	}
	if _, err := c.SetModel(ctx, "s1", "anthropic", "claude-1"); err != nil {
		t.Fatalf("set_model: %v", err)
	}
	levels, err := c.ThinkingLevels(ctx, "s1")
	if err != nil || len(levels) != 2 {
		t.Fatalf("thinking levels: %+v %v", levels, err)
	}
	if _, err := c.SetThinking(ctx, "s1", "on"); err != nil {
		t.Fatalf("set_thinking: %v", err)
	}
	if err := c.Abort(ctx, "s1"); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if err := c.SetSessionName(ctx, "s1", "renamed"); err != nil {
		t.Fatalf("set_session_name: %v", err)
	}
	spawned, err := c.Spawn(ctx, "/w", "", "spawn-1")
	if err != nil || spawned.GetSid() != "s-new" {
		t.Fatalf("spawn: %+v %v", spawned, err)
	}

	fc.mu.Lock()
	defer fc.mu.Unlock()
	want := []string{"list_sessions", "get_state", "hydrate", "prompt", "get_available_models",
		"set_model", "get_available_thinking_levels", "set_thinking", "abort", "set_session_name", "spawn"}
	if len(fc.sawCalls) != len(want) {
		t.Fatalf("call count: %v", fc.sawCalls)
	}
	for i := range want {
		if fc.sawCalls[i] != want[i] {
			t.Fatalf("call %d: got %s want %s", i, fc.sawCalls[i], want[i])
		}
	}
}

func TestControlErrorVariantAndTimeout(t *testing.T) {
	fc := newFakeControl(t)
	fc.mu.Lock()
	fc.responder = func(call *wspb.ControlCall) *wspb.ControlResponse {
		if callVariant(call) == "get_state" {
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "unknown session xyz"}}}
		}
		// prompt: never answer -> client timeout
		return nil
	}
	fc.mu.Unlock()
	c := dialFakeControl(t, fc)

	err := func() error {
		_, err := c.State(context.Background(), "nope")
		return err
	}()
	if err == nil || !strings.Contains(err.Error(), "unknown session") {
		t.Fatalf("want unknown-session error, got %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	promptErr := c.Prompt(ctx, "s1", "x")
	if promptErr == nil {
		t.Fatal("expected timeout error")
	}
}

func strptr(s string) *string { return &s }

// ---- pane fakes ----

// fakePane serves /ws/pane/<id>: attach on connect, echo input as output
// spans, optional scripted frames.
type fakePane struct {
	ts       *httptest.Server
	mu       sync.Mutex
	sawInput []byte
	head     uint64
	onInput  func(conn *websocket.Conn, data []byte, head uint64)
	missing  bool
}

func newFakePane(t *testing.T) *fakePane {
	t.Helper()
	fp := &fakePane{}
	upgrader := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/pane/", func(w http.ResponseWriter, r *http.Request) {
		if !wireproto.ClientRequestedSubprotocol(r, wireproto.TerminalSubprotocol) {
			http.Error(w, "expected subprotocol", http.StatusUpgradeRequired)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/ws/pane/")
		fp.mu.Lock()
		missing := fp.missing || id == "gone"
		fp.mu.Unlock()
		if missing {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		fp.mu.Lock()
		head := fp.head
		fp.mu.Unlock()
		attach := encodeAttach(t, head)
		if err := conn.WriteMessage(websocket.BinaryMessage, attach); err != nil {
			return
		}
		for {
			mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
			if err != nil {
				return
			}
			if mt != websocket.BinaryMessage {
				return
			}
			frame, err := wireproto.DecodeClientFrame(raw)
			if err != nil {
				return
			}
			if input := frame.GetInput(); input != nil {
				fp.mu.Lock()
				fp.sawInput = append(fp.sawInput, input...)
				head = fp.head
				onInput := fp.onInput
				fp.mu.Unlock()
				if onInput != nil {
					onInput(conn, input, head)
				}
			}
		}
	})
	fp.ts = httptest.NewServer(mux)
	t.Cleanup(fp.ts.Close)
	return fp
}

func encodeAttach(t *testing.T, head uint64) []byte {
	t.Helper()
	epoch, oldest, cols, rows := uint64(1), uint64(0), uint32(80), uint32(24)
	frame, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch: &epoch, Oldest: &oldest, Head: &head,
		InitialCols: &cols, InitialRows: &rows,
		EventCursor: strptr("1:0:0"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func (fp *fakePane) url() string { return "ws" + strings.TrimPrefix(fp.ts.URL, "http") }

func TestPaneAttachInputOutput(t *testing.T) {
	fp := newFakePane(t)
	fp.mu.Lock()
	fp.head = 100
	fp.onInput = func(conn *websocket.Conn, data []byte, head uint64) {
		out, _ := wireproto.EncodeOutputFrame(head, []byte("echo:"+string(data)))
		_ = conn.WriteMessage(websocket.BinaryMessage, out)
	}
	fp.mu.Unlock()

	h, _ := NewHTTP(fp.ts.URL, NoPassword)
	p, err := AttachPane(context.Background(), h, "pane-1")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	// The attach frame must arrive first.
	select {
	case ev := <-p.Frames():
		if ev.Kind != "attach" {
			t.Fatalf("first frame: %s", ev.Kind)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no attach frame")
	}

	if err := p.SendInput([]byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-p.Frames():
		if ev.Kind != "output" || string(ev.Data) != "echo:ls\r" {
			t.Fatalf("output event: %s %q", ev.Kind, ev.Data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no echo output")
	}
	fp.mu.Lock()
	defer fp.mu.Unlock()
	if string(fp.sawInput) != "ls\r" {
		t.Fatalf("input verbatim: %q", fp.sawInput)
	}
}

func TestPaneOutputGapDetected(t *testing.T) {
	fp := newFakePane(t)
	fp.mu.Lock()
	fp.head = 10
	fp.onInput = func(conn *websocket.Conn, data []byte, head uint64) {
		// A span that starts past the head is a gap.
		out, _ := wireproto.EncodeOutputFrame(head+5, []byte("future"))
		_ = conn.WriteMessage(websocket.BinaryMessage, out)
	}
	fp.mu.Unlock()

	h, _ := NewHTTP(fp.ts.URL, NoPassword)
	p, err := AttachPane(context.Background(), h, "pane-2")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	<-p.Frames() // attach
	if err := p.SendInput([]byte("x")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
		if p.Err() == nil || !strings.Contains(p.Err().Error(), "gap") {
			t.Fatalf("want gap error, got %v", p.Err())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("gap not detected")
	}
}

func TestPaneMissingIsNotFound(t *testing.T) {
	fp := newFakePane(t)
	h, _ := NewHTTP(fp.ts.URL, NoPassword)
	_, err := AttachPane(context.Background(), h, "gone")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want not-found, got %v", err)
	}
}

func TestPaneExitEvent(t *testing.T) {
	fp := newFakePane(t)
	h, _ := NewHTTP(fp.ts.URL, NoPassword)
	p, err := AttachPane(context.Background(), h, "pane-3")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	<-p.Frames() // attach
	fp.mu.Lock()
	conn := fp.ts
	_ = conn
	fp.mu.Unlock()
	// Push an exit frame from the server side by closing: instead simulate
	// via a direct write on the underlying connection is not exposed, so
	// drive it through onInput.
	fp.mu.Lock()
	fp.onInput = func(conn *websocket.Conn, data []byte, head uint64) {
		frame, _ := wireproto.EncodeExitFrame(3)
		_ = conn.WriteMessage(websocket.BinaryMessage, frame)
	}
	fp.mu.Unlock()
	if err := p.SendInput([]byte("q")); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-p.Frames():
		if ev.Kind != "exit" || ev.Exit != 3 {
			t.Fatalf("exit event: %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no exit event")
	}
}
