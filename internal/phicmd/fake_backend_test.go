package phicmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// fakeBackend is one Phi origin serving REST, /ws/control, and
// /ws/pane/<id>, speaking the real JSON and protobuf shapes. Command
// tests point phi-cmd at it through a real profiles document.
type fakeBackend struct {
	mu sync.Mutex
	ts *httptest.Server

	// REST behavior
	authEnabled bool
	password    string
	cookies     map[string]bool
	ident       map[string]any
	coders      any
	sessions    []map[string]any
	terminals   []map[string]any
	rawDiff     string
	runResults  map[string]any
	requests    []string

	// Control behavior: sid -> canned state; prompt triggers a scripted turn.
	instances   map[string]*wspb.ControlState
	promptSeen  []string
	turnScript  func(b *fakeBackend, conn *websocket.Conn, sid, message string)
	paneEcho    bool
	paneHead    uint64
	paneInput   []byte
	paneInputOK *sync.Cond // signals a pane input arrival
	controlDown bool       // refuse the control socket (auth)
}

// waitForPaneInput blocks until the fake's pane handler has observed
// want bytes. The command exits when its frame is written, not when the
// server goroutine has read it, so assertions must wait.
func (b *fakeBackend) waitForPaneInput(t *testing.T, want string) {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for string(b.paneInput) != want && time.Now().Before(deadline) {
		b.paneInputOK.Wait()
	}
	if string(b.paneInput) != want {
		t.Fatalf("input bytes: %q (want %q)", b.paneInput, want)
	}
}

func newFakeBackend(t *testing.T) *fakeBackend {
	t.Helper()
	b := &fakeBackend{
		cookies:   map[string]bool{},
		instances: map[string]*wspb.ControlState{},
		ident: map[string]any{
			"hostname": "fake-host", "theme_color": "#aa0000",
			"workspaces": []string{"/w1"}, "active_cwd": "/w1",
		},
		turnScript: defaultTurnScript,
	}
	b.paneInputOK = sync.NewCond(&b.mu)
	mux := http.NewServeMux()

	// --- REST ---
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		defer b.mu.Unlock()
		if !b.authEnabled {
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": false, "authenticated": false})
			return
		}
		status := phiaccess.Status{
			Enabled: true, Version: "v1", Algorithm: "pbkdf2-sha256",
			Iterations: 10, Salt: "c2FsdA",
			Challenge: "challenge-fixed",
		}
		if b.cookieOK(r) {
			status.Authenticated = true
		}
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		defer b.mu.Unlock()
		var req struct {
			Challenge string `json:"challenge"`
			Proof     string `json:"proof"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		proof, err := phiaccess.Proof(b.password, phiaccess.Status{
			Algorithm: "pbkdf2-sha256", Iterations: 10, Salt: "c2FsdA", Challenge: req.Challenge,
		})
		if err != nil || proof != req.Proof {
			http.Error(w, "Invalid password", http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "phi_session", Value: "granted", Path: "/", HttpOnly: true})
		b.cookies["granted"] = true
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	gated := func(path string, fn func(w http.ResponseWriter)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b.mu.Lock()
			b.requests = append(b.requests, r.Method+" "+r.URL.Path)
			authed := !b.authEnabled || b.cookieOK(r)
			b.mu.Unlock()
			if !authed {
				http.Error(w, "access authentication required", http.StatusUnauthorized)
				return
			}
			fn(w)
		}
	}
	mux.HandleFunc("/api/config", gated("/api/config", func(w http.ResponseWriter) {
		b.mu.Lock()
		defer b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(b.ident)
	}))
	mux.HandleFunc("/api/coders", gated("/api/coders", func(w http.ResponseWriter) {
		b.mu.Lock()
		defer b.mu.Unlock()
		coders := b.coders
		if coders == nil {
			// The real endpoint is an object keyed by coder id with an
			// order field (pkg/coders.DescriptorsFor).
			coders = map[string]any{
				"pi":   map[string]any{"id": "pi", "order": 0, "name": "Pi (term)", "sidebar_visible": true, "capabilities": map[string]bool{"list": true, "transcript": true, "pi_rpc": true}},
				"bash": map[string]any{"id": "bash", "order": 1, "name": "Shell", "sidebar_visible": true, "is_shell": true, "capabilities": map[string]bool{"list": true}},
			}
		}
		_ = json.NewEncoder(w).Encode(coders)
	}))
	mux.HandleFunc("/api/sessions", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		authed := !b.authEnabled || b.cookieOK(r)
		b.requests = append(b.requests, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		sessions := b.sessions
		b.mu.Unlock()
		if !authed {
			http.Error(w, "access authentication required", http.StatusUnauthorized)
			return
		}
		// The real endpoint lists per coder+cwd; the fake honors coder.
		coder := r.URL.Query().Get("coder")
		out := []map[string]any{}
		for _, s := range sessions {
			if coder == "" || s["coder"] == coder {
				out = append(out, s)
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/api/terminals", gated("/api/terminals", func(w http.ResponseWriter) {
		b.mu.Lock()
		defer b.mu.Unlock()
		terminals := b.terminals
		if terminals == nil {
			terminals = []map[string]any{}
		}
		_ = json.NewEncoder(w).Encode(terminals)
	}))
	mux.HandleFunc("/api/session-transcript", gated("/api/session-transcript", func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode([]map[string]any{{"role": "user", "text": "hi"}})
	}))
	mux.HandleFunc("/api/git/raw-status", gated("/api/git/raw-status", func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("## main\nM file.go\n"))
	}))
	mux.HandleFunc("/api/git/raw-log", gated("/api/git/raw-log", func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("abc123 fix thing\n"))
	}))
	mux.HandleFunc("/api/git/raw-diff", gated("/api/git/raw-diff", func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		b.mu.Lock()
		diff := b.rawDiff
		b.mu.Unlock()
		_, _ = w.Write([]byte(diff))
	}))
	mux.HandleFunc("/api/cmd/run", gated("/api/cmd/run", func(w http.ResponseWriter) {
		b.mu.Lock()
		defer b.mu.Unlock()
		res := b.runResults
		if res == nil {
			res = map[string]any{"results": []map[string]any{{"worktree": "/w1", "success": true, "exit_code": 0, "output": "ran", "duration_ms": 2}}}
		}
		_ = json.NewEncoder(w).Encode(res)
	}))
	mux.HandleFunc("/api/version", gated("/api/version", func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]string{"version": "test"})
	}))
	mux.HandleFunc("/api/pi-bridge/model", gated("/api/pi-bridge/model", func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))

	// --- control ---
	upgrader := websocket.Upgrader{Subprotocols: []string{wireproto.ControlSubprotocol}}
	mux.HandleFunc("/ws/control", func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		down := b.controlDown
		b.mu.Unlock()
		if down || !wireproto.ClientRequestedSubprotocol(r, wireproto.ControlSubprotocol) {
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
		if proto.Unmarshal(raw, frame) != nil {
			return
		}
		if hello := frame.GetHello(); hello == nil || hello.GetVersion() != uint32(rpc.ProtocolVersion) {
			return
		}
		welcome, _ := proto.Marshal(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Welcome{
			Welcome: &wspb.ControlWelcome{Version: uint32(rpc.ProtocolVersion)},
		}})
		if conn.WriteMessage(websocket.BinaryMessage, welcome) != nil {
			return
		}
		for {
			mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxControlMessageBytes)
			if err != nil || mt != websocket.BinaryMessage {
				return
			}
			frame := &wspb.ControlClientFrame{}
			if proto.Unmarshal(raw, frame) != nil {
				return
			}
			call := frame.GetCall()
			if call == nil {
				return
			}
			resp := b.answerControl(call)
			resp.Id = call.GetId()
			out, _ := proto.Marshal(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Response{Response: resp}})
			if conn.WriteMessage(websocket.BinaryMessage, out) != nil {
				return
			}
			if prompt := call.GetPrompt(); prompt != nil {
				b.mu.Lock()
				script := b.turnScript
				b.mu.Unlock()
				if script != nil {
					script(b, conn, prompt.GetSid(), prompt.GetMessage())
				}
			}
		}
	})

	// --- pane ---
	paneUpgrader := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	mux.HandleFunc("/ws/pane/", func(w http.ResponseWriter, r *http.Request) {
		if !wireproto.ClientRequestedSubprotocol(r, wireproto.TerminalSubprotocol) {
			http.Error(w, "expected subprotocol", http.StatusUpgradeRequired)
			return
		}
		id := filepath.Base(r.URL.Path)
		b.mu.Lock()
		head, echo := b.paneHead, b.paneEcho
		b.mu.Unlock()
		if id == "gone" {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		conn, err := paneUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		epoch, oldest, cols, rows := uint64(1), uint64(0), uint32(80), uint32(24)
		attach, _ := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
			Epoch: &epoch, Oldest: &oldest, Head: &head,
			InitialCols: &cols, InitialRows: &rows, EventCursor: strptr("1:0:0"),
		})
		if conn.WriteMessage(websocket.BinaryMessage, attach) != nil {
			return
		}
		var offset uint64
		if head > 0 {
			offset = head
		}
		for {
			mt, raw, err := wireproto.ReadBoundedMessage(conn, wireproto.MaxTerminalMessageBytes)
			if err != nil || mt != websocket.BinaryMessage {
				return
			}
			frame, err := wireproto.DecodeClientFrame(raw)
			if err != nil {
				return
			}
			if input := frame.GetInput(); input != nil {
				b.mu.Lock()
				b.paneInput = append(b.paneInput, input...)
				b.paneInputOK.Broadcast()
				b.mu.Unlock()
				if echo {
					out, _ := wireproto.EncodeOutputFrame(offset, input)
					if conn.WriteMessage(websocket.BinaryMessage, out) != nil {
						return
					}
					offset += uint64(len(input))
				}
			}
		}
	})

	b.ts = httptest.NewServer(mux)
	t.Cleanup(b.ts.Close)
	return b
}

func (b *fakeBackend) url() string { return b.ts.URL }

func (b *fakeBackend) cookieOK(r *http.Request) bool {
	for _, c := range r.Cookies() {
		if c.Name == "phi_session" && b.cookies[c.Value] {
			return true
		}
	}
	return false
}

// answerControl implements the control calls the CLI uses.
func (b *fakeBackend) answerControl(call *wspb.ControlCall) *wspb.ControlResponse {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch v := call.GetCall().(type) {
	case *wspb.ControlCall_ListSessions:
		out := &wspb.ListSessionsResult{}
		for sid, st := range b.instances {
			out.Sessions = append(out.Sessions, &wspb.SessionSummary{Sid: sid, Title: st.GetTitle(), Cwd: st.GetCwd(), Status: st.GetStatus()})
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_ListSessions{ListSessions: out}}
	case *wspb.ControlCall_GetState:
		sid := v.GetState.GetSid()
		if st, ok := b.instances[sid]; ok {
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetState{GetState: &wspb.StateResult{State: st}}}
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "unknown session " + sid}}}
	case *wspb.ControlCall_Hydrate:
		sid := v.Hydrate.GetSid()
		if _, ok := b.instances[sid]; !ok {
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "unknown session " + sid}}}
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Hydrate{Hydrate: &wspb.TranscriptResult{
			Session: &wspb.TranscriptSnapshot{LastSeq: 1, State: b.instances[sid]},
		}}}
	case *wspb.ControlCall_Prompt:
		sid := v.Prompt.GetSid()
		if _, ok := b.instances[sid]; !ok {
			return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "unknown session " + sid}}}
		}
		b.promptSeen = append(b.promptSeen, sid+":"+v.Prompt.GetMessage())
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Prompt{Prompt: &wspb.PromptResult{Accepted: true}}}
	case *wspb.ControlCall_Spawn:
		sid := "spawned-1"
		b.instances[sid] = &wspb.ControlState{Sid: sid, Title: "spawned", Cwd: v.Spawn.GetCwd(), Status: "live", Busy: false}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Spawn{Spawn: &wspb.SpawnResult{Sid: sid, Title: "spawned", Cwd: v.Spawn.GetCwd()}}}
	case *wspb.ControlCall_GetAvailableModels:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableModels{GetAvailableModels: &wspb.ModelsResult{
			Models: []*wspb.ModelInfo{{Provider: "anthropic", Id: "claude-3"}, {Provider: "openai", Id: "gpt-5"}},
		}}}
	case *wspb.ControlCall_SetModel:
		sid := v.SetModel.GetSid()
		if st, ok := b.instances[sid]; ok {
			st.Model = strptr(v.SetModel.GetProvider() + "/" + v.SetModel.GetModelId())
		}
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_SetModel{SetModel: &wspb.StateResult{State: b.instances[sid]}}}
	case *wspb.ControlCall_GetAvailableThinkingLevels:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_GetAvailableThinkingLevels{GetAvailableThinkingLevels: &wspb.ThinkingLevelsResult{Levels: []string{"off", "on"}}}}
	case *wspb.ControlCall_Abort:
		return &wspb.ControlResponse{Result: &wspb.ControlResponse_Abort{Abort: &wspb.AbortResult{}}}
	}
	return &wspb.ControlResponse{Result: &wspb.ControlResponse_Error{Error: &wspb.ControlError{Reason: "unsupported call"}}}
}

// pushEvent sends one sequenced event frame on a control connection.
func (b *fakeBackend) pushEvent(conn *websocket.Conn, sid string, seq uint64, event *wspb.ControlEvent) {
	event.Sid = sid
	event.Seq = seq
	frame, err := proto.Marshal(&wspb.ControlServerFrame{Payload: &wspb.ControlServerFrame_Event{Event: event}})
	if err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.BinaryMessage, frame)
}

// defaultTurnScript answers a prompt with one assistant message and the
// session going idle, exactly the event order a real turn produces.
func defaultTurnScript(b *fakeBackend, conn *websocket.Conn, sid, message string) {
	seq := uint64(10)
	b.pushEvent(conn, sid, seq, &wspb.ControlEvent{Event: &wspb.ControlEvent_MessageStart{MessageStart: &wspb.MessageStartEvent{}}})
	b.pushEvent(conn, sid, seq+1, &wspb.ControlEvent{Event: &wspb.ControlEvent_MessageEnd{MessageEnd: &wspb.MessageEndEvent{
		Message: &wspb.Message{Role: "assistant", Content: strExternal("echo: " + message)},
	}}})
	b.mu.Lock()
	if st, ok := b.instances[sid]; ok {
		st.Busy = false
	}
	b.mu.Unlock()
	b.pushEvent(conn, sid, seq+2, &wspb.ControlEvent{Event: &wspb.ControlEvent_StateChanged{StateChanged: &wspb.StateChangedEvent{
		Change: &wspb.StateChangedEvent_State{State: &wspb.ControlState{Sid: sid, Status: "live", Busy: false}},
	}}})
}

func strExternal(s string) *wspb.ExternalValue {
	return &wspb.ExternalValue{Kind: &wspb.ExternalValue_StringValue{StringValue: s}}
}

// profileEnv writes a profiles document pointing at the backend and a
// clean phi-cmd state dir, returning the CLI argv prefix.
func profileEnv(t *testing.T, b *fakeBackend) []string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	profiles := `{"profiles":[{"id":"fake","name":"Fake","origin":"` + b.url() + `"}]}`
	path := filepath.Join(dir, "config", "phi-client", "profiles.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(profiles), 0o600); err != nil {
		t.Fatal(err)
	}
	return []string{"--profiles", path}
}

// captureRun runs the CLI in-process and returns (stdout, exitCode).
func captureRun(t *testing.T, argv ...string) (string, int) {
	t.Helper()
	old := os.Stdout
	r, wFile, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = wFile
	code := Run(argv)
	os.Stdout = old
	_ = wFile.Close()
	// The writer is closed; a plain read drains to EOF without a race.
	buf := make([]byte, 0, 64*1024)
	tmp := make([]byte, 4096)
	for {
		n, err := r.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	_ = r.Close()
	return string(buf), code
}
