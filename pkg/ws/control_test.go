package ws

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func dial(t *testing.T, h http.HandlerFunc) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	dialer := websocket.Dialer{Subprotocols: []string{wireproto.ControlSubprotocol}}
	c, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func writeFrame(t *testing.T, c *websocket.Conn, frame *wspb.ControlClientFrame) {
	t.Helper()
	raw, err := proto.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		t.Fatal(err)
	}
}

func readFrame(t *testing.T, c *websocket.Conn) *wspb.ControlServerFrame {
	t.Helper()
	_, raw, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes)
	if err != nil {
		t.Fatal(err)
	}
	frame := &wspb.ControlServerFrame{}
	if err := proto.Unmarshal(raw, frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func helloDial(t *testing.T, mgr *rpc.Manager) *websocket.Conn {
	c := dial(t, HandleControl(nil, mgr, func() string { return "" }))
	writeFrame(t, c, &wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Hello{
		Hello: &wspb.ControlHello{Version: uint32(rpc.ProtocolVersion)},
	}})
	welcome := readFrame(t, c).GetWelcome()
	if welcome == nil || welcome.GetVersion() != uint32(rpc.ProtocolVersion) {
		t.Fatalf("want welcome v%d, got %+v", rpc.ProtocolVersion, welcome)
	}
	return c
}

func sendCall(t *testing.T, c *websocket.Conn, call *wspb.ControlCall) {
	t.Helper()
	writeFrame(t, c, &wspb.ControlClientFrame{
		Payload: &wspb.ControlClientFrame_Call{Call: call},
	})
}

func readResponse(t *testing.T, c *websocket.Conn, id string) *wspb.ControlResponse {
	t.Helper()
	for {
		frame := readFrame(t, c)
		if res := frame.GetResponse(); res != nil && res.GetId() == id {
			return res
		}
	}
}

// mustCall sends one typed call and fails the test when the server answers
// with an error variant.
func mustCall(t *testing.T, c *websocket.Conn, call *wspb.ControlCall) *wspb.ControlResponse {
	t.Helper()
	sendCall(t, c, call)
	res := readResponse(t, c, call.GetId())
	if err := res.GetError(); err != nil {
		t.Fatalf("call %s failed: %s", call.GetId(), err.GetReason())
	}
	return res
}

// expectError sends one typed call and asserts the server answers with an
// error variant whose reason contains want (empty want skips that check).
func expectError(t *testing.T, c *websocket.Conn, call *wspb.ControlCall, want string) *wspb.ControlResponse {
	t.Helper()
	sendCall(t, c, call)
	res := readResponse(t, c, call.GetId())
	reason := res.GetError().GetReason()
	if reason == "" {
		t.Fatalf("call %s unexpectedly succeeded: %+v", call.GetId(), res)
	}
	if want != "" && !strings.Contains(reason, want) {
		t.Fatalf("call %s reason = %q, want it to contain %q", call.GetId(), reason, want)
	}
	return res
}

func spawnedSid(t *testing.T, res *wspb.ControlResponse) string {
	t.Helper()
	spawn := res.GetSpawn()
	if spawn == nil || spawn.GetSid() == "" {
		t.Fatalf("spawn response missing sid: %+v", res)
	}
	return spawn.GetSid()
}

func spawnControlSession(t *testing.T, c *websocket.Conn, cwd string) string {
	t.Helper()
	return spawnedSid(t, mustCall(t, c, &wspb.ControlCall{
		Id:   "spawn-session",
		Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: proto.String(cwd)}},
	}))
}

type controlFakeChild struct {
	stdoutR  *io.PipeReader
	stdoutW  *io.PipeWriter
	stdinR   *io.PipeReader
	stdinW   *io.PipeWriter
	commands chan map[string]any
}

func newControlFakeChild() *controlFakeChild {
	stdoutR, stdoutW := io.Pipe()
	stdinR, stdinW := io.Pipe()
	commands := make(chan map[string]any, 8)
	go func() {
		defer close(commands)
		decoder := json.NewDecoder(stdinR)
		for {
			var command map[string]any
			if err := decoder.Decode(&command); err != nil {
				return
			}
			commands <- command
		}
	}()
	return &controlFakeChild{stdoutR: stdoutR, stdoutW: stdoutW, stdinR: stdinR, stdinW: stdinW, commands: commands}
}

func (f *controlFakeChild) Wait() error { return nil }
func (f *controlFakeChild) Kill() error {
	_ = f.stdoutW.Close()
	return nil
}

func respondControlCommands(child *controlFakeChild, respond func(map[string]any) (any, bool, string)) {
	go func() {
		for command := range child.commands {
			data, success, message := respond(command)
			response := map[string]any{
				"type":    "response",
				"id":      command["id"],
				"command": command["type"],
				"success": success,
				"data":    data,
			}
			if message != "" {
				response["error"] = message
			}
			encoded, _ := json.Marshal(response)
			_, _ = child.stdoutW.Write(append(encoded, '\n'))
		}
	}()
}

func setupPiControlFixture(t *testing.T, cwd, name string, records ...string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	canonical, err := filepath.Abs(filepath.Clean(cwd))
	if err != nil {
		t.Fatal(err)
	}
	normalized := filepath.ToSlash(canonical)
	normalized = strings.ReplaceAll(strings.Trim(normalized, "/"), ":", "-")
	projectDir := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"
	dir := filepath.Join(home, ".pi", "agent", "sessions", projectDir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	content := strings.Join(records, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func piControlHeader(id, cwd string) string {
	encoded, _ := json.Marshal(struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		ID      string `json:"id"`
		Cwd     string `json:"cwd"`
	}{Type: "session", Version: 3, ID: id, Cwd: cwd})
	return string(encoded)
}

func TestControlAbortSuccessAndValidation(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		if command["type"] != "abort" {
			return nil, false, "unexpected command"
		}
		return nil, true, ""
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/abort"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	c := helloDial(t, mgr)

	success := mustCall(t, c, &wspb.ControlCall{
		Id:   "abort-ok",
		Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{Sid: inst.ID}},
	})
	if !success.GetAbort().GetAborted() {
		t.Fatalf("abort success response: %+v", success)
	}

	// Validation runs before the Pi lookup, so an empty sid never reaches Pi.
	expectError(t, c, &wspb.ControlCall{
		Id:   "abort-invalid",
		Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{}},
	}, "sid is required")
}

func TestControlAbortPropagatesPiError(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		return nil, false, "abort rejected"
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/abort-error"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	c := helloDial(t, mgr)
	expectError(t, c, &wspb.ControlCall{
		Id:   "abort-error",
		Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{Sid: inst.ID}},
	}, "abort rejected")
}

func TestControlAbortUnknownSidReturnsError(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		t.Fatalf("abort must not reach Pi when sid is unknown: %#v", command)
		return nil, false, ""
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/abort-unknown"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	c := helloDial(t, mgr)
	expectError(t, c, &wspb.ControlCall{
		Id:   "abort-unknown",
		Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{Sid: "missing-sid"}},
	}, "missing-sid")
}

func TestControlAbortContextCancellationSurfacesAsError(t *testing.T) {
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/abort-cancel"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	_ = helloDial(t, mgr)
	server := &controlServer{mgr: mgr}

	// The child never answers the abort; the operation context drives the
	// outcome. We capture the abort command so the test does not race the
	// server's writer.
	abortSent := make(chan struct{})
	go func() {
		select {
		case <-child.commands:
		case <-time.After(time.Second):
			return
		}
		close(abortSent)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *wspb.ControlResponse, 1)
	go func() {
		done <- server.dispatch(ctx, &wspb.ControlCall{
			Id:   "abort-cancel",
			Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{Sid: inst.ID}},
		})
	}()
	select {
	case <-abortSent:
	case <-time.After(time.Second):
		t.Fatal("abort was not issued to Pi")
	}
	cancel()
	select {
	case response := <-done:
		reason := response.GetError().GetReason()
		if reason == "" {
			t.Fatalf("context cancellation did not fail abort: %+v", response)
		}
		if !strings.Contains(reason, "control connection closed") {
			t.Fatalf("abort error did not surface context cancellation: %q", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("abort operation did not return after context cancel")
	}
}

func TestPiSpawnOptionsRejectsUnknownPath(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "worktree")
	if _, err := piSpawnOptions(cwd, filepath.Join(cwd, "unknown.jsonl")); err == nil {
		t.Fatal("unknown session path should be rejected before spawning")
	}
}

func TestPiSpawnOptionsLoadsActiveBranch(t *testing.T) {
	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	path := setupPiControlFixture(t, cwd, "resume.jsonl",
		piControlHeader("resume-id", cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"saved root"}]}}`,
		`{"type":"message","id":"abandoned","parentId":"root","message":{"role":"user","content":[{"type":"text","text":"abandoned"}]}}`,
		`{"type":"message","id":"active","parentId":"root","message":{"role":"assistant","content":[{"type":"text","text":"saved text"}]}}`,
	)
	opts, err := piSpawnOptions(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if opts.Cwd != cwd || opts.SessionPath != path || len(opts.InitialMessages) != 2 {
		t.Fatalf("unexpected resume options: %+v", opts)
	}
	if opts.InitialMessages[1].Role != "assistant" {
		t.Fatalf("unexpected second initial message role: %+v", opts.InitialMessages[1])
	}
	var content []map[string]any
	if err := json.Unmarshal(opts.InitialMessages[1].Content, &content); err != nil {
		t.Fatalf("second initial message content is not a JSON array: %v (raw=%s)", err, string(opts.InitialMessages[1].Content))
	}
	if len(content) != 1 {
		t.Fatalf("expected exactly one content segment, got %d: %+v", len(content), content)
	}
	if content[0]["type"] != "text" || content[0]["text"] != "saved text" {
		t.Fatalf("expected text segment saved text, got %+v", content[0])
	}
}

func TestPiSpawnOptionsPreservesStructuredToolHistory(t *testing.T) {
	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	path := setupPiControlFixture(t, cwd, "resume.jsonl",
		piControlHeader("resume-id", cwd),
		`{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"read please"}]}}`,
		`{"type":"message","id":"call","parentId":"root","message":{"role":"assistant","content":[{"type":"thinking","thinking":"fetch"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"file_path":"/work/example.ts","offset":1,"limit":5}}]}}`,
		`{"type":"message","id":"abandoned","parentId":"root","message":{"role":"assistant","content":[{"type":"text","text":"abandoned branch"}]}}`,
		`{"type":"message","id":"result","parentId":"call","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"line one"}],"isError":false,"details":{"diff":"+1 ok"}}}`,
	)
	opts, err := piSpawnOptions(cwd, path)
	if err != nil {
		t.Fatal(err)
	}
	if opts.SessionPath != path {
		t.Fatalf("session path not propagated: %+v", opts)
	}
	if len(opts.InitialMessages) != 3 {
		t.Fatalf("expected 3 active-branch messages, got %d: %+v", len(opts.InitialMessages), opts.InitialMessages)
	}
	roles := []string{
		opts.InitialMessages[0].Role,
		opts.InitialMessages[1].Role,
		opts.InitialMessages[2].Role,
	}
	wantRoles := []string{"user", "assistant", "toolResult"}
	for i, want := range wantRoles {
		if roles[i] != want {
			t.Fatalf("message %d role: want %q got %q (full=%+v)", i, want, roles[i], opts.InitialMessages)
		}
	}
	var assistantSegments []map[string]any
	if err := json.Unmarshal(opts.InitialMessages[1].Content, &assistantSegments); err != nil {
		t.Fatalf("assistant content not JSON array: %v (raw=%s)", err, string(opts.InitialMessages[1].Content))
	}
	var toolCall map[string]any
	for _, seg := range assistantSegments {
		if seg["type"] == "toolCall" {
			toolCall = seg
			break
		}
	}
	if toolCall == nil {
		t.Fatalf("assistant content missing toolCall segment: %+v", assistantSegments)
	}
	if toolCall["id"] != "call_1" || toolCall["name"] != "read" {
		t.Fatalf("assistant toolCall fields lost: %+v", toolCall)
	}
	args, ok := toolCall["arguments"].(map[string]any)
	if !ok {
		t.Fatalf("assistant toolCall arguments not object: %+v", toolCall["arguments"])
	}
	if args["file_path"] != "/work/example.ts" || args["offset"].(float64) != 1 || args["limit"].(float64) != 5 {
		t.Fatalf("assistant toolCall arguments lost: %+v", args)
	}
	tr := opts.InitialMessages[2]
	if tr.ToolCallId != "call_1" || tr.ToolName != "read" {
		t.Fatalf("toolResult pair fields lost: %+v", tr)
	}
	if tr.IsError == nil || *tr.IsError {
		t.Fatalf("toolResult isError=false not preserved: %+v", tr.IsError)
	}
	var diff map[string]any
	if err := json.Unmarshal(tr.Details, &diff); err != nil {
		t.Fatalf("toolResult details not JSON object: %v (raw=%s)", err, string(tr.Details))
	}
	if diff["diff"] != "+1 ok" {
		t.Fatalf("toolResult details.diff not preserved: %+v", diff)
	}
	for _, msg := range opts.InitialMessages {
		text := string(msg.Content)
		if strings.Contains(text, "Used tool") || strings.Contains(text, "Tool Output") {
			t.Fatalf("flattened legacy prose leaked into resumed snapshot: %s", text)
		}
	}
}

func TestControlHelloWelcomeListSessions(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "c1",
		Call: &wspb.ControlCall_ListSessions{ListSessions: &wspb.ListSessionsCall{}},
	})
	if res.GetId() != "c1" || res.GetListSessions() == nil {
		t.Fatalf("bad res %+v", res)
	}
}

func TestControlRejectsMissingHello(t *testing.T) {
	c := dial(t, HandleControl(nil, rpc.NewManager(), nil))
	sendCall(t, c, &wspb.ControlCall{
		Id:   "x",
		Call: &wspb.ControlCall_ListSessions{ListSessions: &wspb.ListSessionsCall{}},
	})
	// The endpoint refuses the call and closes before any welcome, so the
	// next read must fail instead of returning a response frame.
	if _, _, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes); err == nil {
		t.Fatal("call before hello must not be answered")
	}
}

func TestControlHydrateUnknownSid(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	expectError(t, c, &wspb.ControlCall{
		Id:   "h",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: "nope"}},
	}, "nope")
}

func TestControlNewOperationsValidationAndUnknownSid(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	cases := []struct {
		name   string
		call   *wspb.ControlCall
		reason string
	}{
		{"models-unknown-sid", &wspb.ControlCall{Id: "v0",
			Call: &wspb.ControlCall_GetAvailableModels{GetAvailableModels: &wspb.GetAvailableModelsCall{Sid: "missing"}}}, "missing"},
		{"model-empty-provider", &wspb.ControlCall{Id: "v1",
			Call: &wspb.ControlCall_SetModel{SetModel: &wspb.SetModelCall{Sid: "missing", Provider: "", ModelId: "m"}}},
			"provider and modelId are required"},
		{"model-empty-id", &wspb.ControlCall{Id: "v2",
			Call: &wspb.ControlCall_SetModel{SetModel: &wspb.SetModelCall{Sid: "missing", Provider: "p", ModelId: ""}}},
			"provider and modelId are required"},
		{"thinking-levels-unknown-sid", &wspb.ControlCall{Id: "v3",
			Call: &wspb.ControlCall_GetAvailableThinkingLevels{GetAvailableThinkingLevels: &wspb.GetAvailableThinkingLevelsCall{Sid: "missing"}}},
			"missing"},
		{"thinking-empty-level", &wspb.ControlCall{Id: "v4",
			Call: &wspb.ControlCall_SetThinking{SetThinking: &wspb.SetThinkingCall{Sid: "missing", Level: ""}}},
			"level is required"},
		{"reset-unknown-sid", &wspb.ControlCall{Id: "v5",
			Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: "missing"}}}, "missing"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			expectError(t, c, testCase.call, testCase.reason)
		})
	}
}

// Typed frames carry no unknown fields, so the old strict-JSON rejection
// class is gone. What still must hold is that a malformed frame never
// reaches dispatch: the frame decoder fails closed and the connection ends.
func TestControlRejectsMalformedFrames(t *testing.T) {
	mgr := rpc.NewManager()
	t.Run("garbage-binary", func(t *testing.T) {
		c := helloDial(t, mgr)
		if err := c.WriteMessage(websocket.BinaryMessage, []byte{0xff, 0xfe, 0xfd}); err != nil {
			t.Fatal(err)
		}
		if _, _, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes); err == nil {
			t.Fatal("undecodable frame was accepted")
		}
	})
	t.Run("missing-call", func(t *testing.T) {
		c := helloDial(t, mgr)
		writeFrame(t, c, &wspb.ControlClientFrame{})
		if _, _, err := wireproto.ReadBoundedMessage(c, wireproto.MaxControlMessageBytes); err == nil {
			t.Fatal("frame without a call was accepted")
		}
	})
}

func TestControlHydrateFenceFlushesEventAfterLatestHydrate(t *testing.T) {
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/fence"})
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Kill()
	// Keep hydrate responses large enough that both workers remain in flight
	// while the post-fence event reaches the egress loop.
	for i := 0; i < 5000; i++ {
		inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: json.RawMessage(`"seed"`)}, nil)
	}
	c := helloDial(t, mgr)
	sendCall(t, c, &wspb.ControlCall{Id: "h1",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})
	sendCall(t, c, &wspb.ControlCall{Id: "h2",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})
	time.Sleep(20 * time.Millisecond)
	inst.Emit(rpc.EvtStateChanged, nil, map[string]any{"model": map[string]any{"name": "fenced"}})
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	order := make([]string, 0, 3)
	seen := map[string]bool{}
	for len(order) < 3 {
		frame := readFrame(t, c)
		if res := frame.GetResponse(); res != nil {
			if err := res.GetError(); err != nil {
				t.Fatalf("hydrate failed: %s", err.GetReason())
			}
			id := res.GetId()
			if (id == "h1" || id == "h2") && !seen[id] {
				seen[id] = true
				order = append(order, id)
			}
			continue
		}
		ev := frame.GetEvent()
		if ev != nil && ev.GetSid() == inst.ID && ev.GetStateChanged() != nil && !seen["fenced"] {
			seen["fenced"] = true
			order = append(order, "fenced")
		}
	}
	if len(order) != 3 || order[2] != "fenced" {
		t.Fatalf("latest hydrate fence flushed event before response: order=%v", order)
	}
}

func TestControlSpawnSnapshotBoundaryKeepsFollowingEvent(t *testing.T) {
	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	sessionPath := setupPiControlFixture(t, cwd, "resume.jsonl", piControlHeader("resume-id", cwd))
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: cwd, SessionPath: sessionPath})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })

	c := helloDial(t, mgr)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	mustCall(t, c, &wspb.ControlCall{
		Id:   "hyd",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: inst.ID}},
	})

	// Hydrate is the deterministic subscription barrier. The next spawn reuses
	// this live instance, so the event below is after subscribe and before its
	// spawn snapshot is copied without relying on a scheduler timing window.
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: []byte(`"boundary"`)}, nil)
	sendCall(t, c, &wspb.ControlCall{Id: "sp",
		Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: proto.String(cwd), SessionPath: proto.String(sessionPath)}}})

	var spawn *wspb.ControlResponse
	var events []*wspb.ControlEvent
	for spawn == nil {
		frame := readFrame(t, c)
		if ev := frame.GetEvent(); ev != nil && ev.GetSid() == inst.ID {
			events = append(events, ev)
		}
		if res := frame.GetResponse(); res != nil && res.GetId() == "sp" {
			spawn = res
		}
	}
	if err := spawn.GetError(); err != nil {
		t.Fatalf("spawn failed: %s", err.GetReason())
	}
	payload := spawn.GetSpawn()
	if payload.GetSid() != inst.ID {
		t.Fatalf("spawn did not reuse live instance: got sid %q want %q", payload.GetSid(), inst.ID)
	}
	snapshot := payload.GetSession()
	if snapshot.GetLastSeq() != 1 || len(snapshot.GetMessages()) != 1 {
		t.Fatalf("boundary event missing from spawn snapshot: %+v", snapshot)
	}
	message := snapshot.GetMessages()[0]
	if message.GetRole() != "assistant" || message.GetContent().GetStringValue() != "boundary" {
		t.Fatalf("unexpected boundary snapshot message: %+v", message)
	}

	// Emit only after the response has been read, which is after SnapshotCopy.
	inst.Emit(rpc.EvtStateChanged, nil, map[string]any{"model": map[string]any{"name": "following"}})
	for {
		seenNext := false
		for _, ev := range events {
			if ev.GetSeq() == snapshot.GetLastSeq()+1 && ev.GetStateChanged() != nil {
				seenNext = true
				break
			}
		}
		if seenNext {
			break
		}
		if ev := readFrame(t, c).GetEvent(); ev != nil && ev.GetSid() == inst.ID {
			events = append(events, ev)
		}
	}

	var seqs []uint64
	for _, ev := range events {
		if ev.GetMessageEnd() != nil || ev.GetStateChanged() != nil {
			seqs = append(seqs, ev.GetSeq())
		}
	}
	if len(seqs) < 2 || seqs[0] != snapshot.GetLastSeq() || seqs[1] != snapshot.GetLastSeq()+1 {
		t.Fatalf("event sequence was not contiguous after snapshot: got %v", seqs)
	}
}

func TestControlSpawnIncludesBootstrapSnapshot(t *testing.T) {
	var calls atomic.Int32
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		calls.Add(1)
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "sp",
		Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: proto.String("/w/demo")}},
	})
	if calls.Load() != 1 {
		t.Fatalf("spawn calls = %d, want 1", calls.Load())
	}
	snapshot := res.GetSpawn().GetSession()
	if snapshot.GetLastSeq() != 3 || len(snapshot.GetMessages()) != 0 {
		t.Fatalf("spawn snapshot did not include the bootstrap events: %+v", snapshot)
	}
}

func TestControlSpawnHydrateUsesCurrentSnapshot(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "user", Content: []byte(`"live"`)}, nil)
	inst.ResetTranscript()
	hydrate := mustCall(t, c, &wspb.ControlCall{
		Id:   "hyd",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: sid}},
	})
	snapshot := hydrate.GetHydrate().GetSession()
	if len(snapshot.GetMessages()) != 0 || snapshot.GetLastSeq() == 0 {
		t.Fatalf("hydrate did not return reset snapshot: %+v", snapshot)
	}
}

func TestControlSpawnBootstrapsHydrateState(t *testing.T) {
	child := newControlFakeChild()
	commands := make(chan string, 3)
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		kind, _ := command["type"].(string)
		commands <- kind
		switch kind {
		case "get_state":
			return map[string]any{
				"model":               map[string]any{"name": "pi-4"},
				"thinkingLevel":       "high",
				"isStreaming":         false,
				"isCompacting":        false,
				"pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats":
			return map[string]any{
				"tokens": map[string]any{
					"input": 11, "output": 22, "cacheRead": 33, "cacheWrite": 44,
				},
				"contextUsage": map[string]any{"tokens": 55, "contextWindow": 66},
			}, true, ""
		case "get_commands":
			return map[string]any{"commands": []map[string]any{
				{"source": "skill", "name": "review"},
				{"source": "extension", "name": "ignored"},
			}}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")
	hydrate := mustCall(t, c, &wspb.ControlCall{
		Id:   "hyd",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: sid}},
	})
	state := hydrate.GetHydrate().GetSession().GetState()
	if state.GetModel() != "pi-4" || state.GetThinking() != "high" || state.GetInputTokens() != 11 ||
		state.GetOutputTokens() != 22 || state.GetCacheReadTokens() != 33 || state.GetCacheWriteTokens() != 44 ||
		state.GetContextUsedTokens() != 55 || state.GetContextWindowTokens() != 66 ||
		strings.Join(state.GetSkills(), ",") != "review" {
		t.Fatalf("hydrate state is missing bootstrap metadata: %+v", state)
	}
	got := []string{<-commands, <-commands, <-commands}
	want := []string{"get_state", "get_session_stats", "get_commands"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("startup commands = %v, want %v", got, want)
	}
}

func TestControlSpawnBootstrapFailureDoesNotPublishSession(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		if command["type"] == "get_state" {
			return nil, false, "state unavailable"
		}
		return nil, false, "unexpected command"
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	expectError(t, c, &wspb.ControlCall{
		Id:   "sp",
		Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: proto.String("/w/demo")}},
	}, "state unavailable")
	if got := mgr.List(); len(got) != 0 {
		t.Fatalf("failed bootstrap published %d sessions", len(got))
	}
}

func TestControlSpawnReusedLeaseDoesNotBootstrapAgain(t *testing.T) {
	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "worktree"))
	if err != nil {
		t.Fatal(err)
	}
	sessionPath := setupPiControlFixture(t, cwd, "resume.jsonl", piControlHeader("resume-id", cwd))
	child := newControlFakeChild()
	var requestCount atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		requestCount.Add(1)
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	for _, id := range []string{"first", "second"} {
		mustCall(t, c, &wspb.ControlCall{
			Id:   id,
			Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{Cwd: proto.String(cwd), SessionPath: proto.String(sessionPath)}},
		})
	}
	if got := requestCount.Load(); got != 3 {
		t.Fatalf("reused lease issued %d startup requests, want 3 total", got)
	}
}

func TestControlCompactRunsPiCompactAndReturnsRefreshedState(t *testing.T) {
	child := newControlFakeChild()
	var compactCalls atomic.Int32
	var stateCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "compact":
			compactCalls.Add(1)
			return map[string]any{}, true, ""
		case "get_state":
			// Bootstrap returns "bootstrap"; the post-compact refresh must
			// return distinct values so a deleted refresh cannot pass.
			if stateCalls.Add(1) >= 2 {
				return map[string]any{
					"model":               map[string]any{"name": "m-compacted"},
					"thinkingLevel":       "high",
					"isStreaming":         false,
					"isCompacting":        false,
					"pendingMessageCount": 0,
				}, true, ""
			}
			return map[string]any{
				"model":               map[string]any{"name": "bootstrap"},
				"thinkingLevel":       "low",
				"isStreaming":         false,
				"isCompacting":        false,
				"pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/compact")
	t.Cleanup(func() {
		if inst, err := mgr.Lookup(sid); err == nil {
			inst.Kill()
		}
	})

	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "compact-ok",
		Call: &wspb.ControlCall_Compact{Compact: &wspb.CompactCall{Sid: sid}},
	})
	if compactCalls.Load() != 1 {
		t.Fatalf("compact calls = %d, want 1", compactCalls.Load())
	}
	state := response.GetCompact().GetState()
	if state.GetModel() != "m-compacted" || state.GetThinking() != "high" {
		t.Fatalf("compact did not return refreshed canonical state: %+v", state)
	}

	// Validation still runs before any Pi write for an unknown sid.
	expectError(t, c, &wspb.ControlCall{
		Id:   "compact-reject",
		Call: &wspb.ControlCall_Compact{Compact: &wspb.CompactCall{Sid: "missing-sid"}},
	}, "missing-sid")
	if compactCalls.Load() != 1 {
		t.Fatalf("rejected compact reached Pi: calls=%d", compactCalls.Load())
	}
}

func TestControlCompactRefreshFailureSurfacesWarningNotFailure(t *testing.T) {
	child := newControlFakeChild()
	var compactCalls atomic.Int32
	var stateCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "compact":
			compactCalls.Add(1)
			return map[string]any{}, true, ""
		case "get_state":
			if stateCalls.Add(1) >= 2 {
				// Post-compact refresh fails after compaction completed.
				return nil, false, "state refresh rejected"
			}
			return map[string]any{
				"model":               map[string]any{"name": "bootstrap"},
				"thinkingLevel":       "low",
				"isStreaming":         false,
				"isCompacting":        false,
				"pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/compact-warn")
	t.Cleanup(func() {
		if inst, err := mgr.Lookup(sid); err == nil {
			inst.Kill()
		}
	})

	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "compact-warn",
		Call: &wspb.ControlCall_Compact{Compact: &wspb.CompactCall{Sid: sid}},
	})
	if compactCalls.Load() != 1 {
		t.Fatalf("completed compaction reported as failure: %+v", response)
	}
	if response.GetCompact().GetStateWarning() == "" {
		t.Fatalf("refresh failure did not surface a warning: %+v", response.GetCompact())
	}
}

func TestControlAbortBypassesControlGateHeldByCompact(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		if command["type"] != "abort" {
			return nil, false, "unexpected command"
		}
		return nil, true, ""
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/abort-gate"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	c := helloDial(t, mgr)

	// Hold the control gate exactly like a long-running compact would.
	// WithControl runs fn only after acquiring the gate, so closing `held`
	// proves the gate is ours.
	held := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_, _ = inst.WithControl(context.Background(), func(context.Context) (any, error) {
			close(held)
			<-release
			return nil, nil
		})
	}()
	<-held
	t.Cleanup(func() { close(release) })

	// If abort queued behind the gate it would hit the operation deadline;
	// a short read deadline keeps the failure mode fast.
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "abort-gate",
		Call: &wspb.ControlCall_Abort{Abort: &wspb.AbortCall{Sid: inst.ID}},
	})
	if !response.GetAbort().GetAborted() {
		t.Fatalf("abort was starved by the control gate: %+v", response)
	}
}

func TestControlPiAvailabilityAndSetterOutcomes(t *testing.T) {
	child := newControlFakeChild()
	var stateCalls atomic.Int32
	var setModelCalls atomic.Int32
	var setThinkingCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			call := stateCalls.Add(1)
			model := "bootstrap"
			thinking := "low"
			if call >= 2 {
				model = "selected-model"
			}
			if call >= 3 {
				thinking = "high"
			}
			return map[string]any{
				"model": map[string]any{"name": model}, "thinkingLevel": thinking,
				"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "get_available_models":
			return map[string]any{"models": []map[string]any{
				{"provider": "remote", "id": "remote-id", "name": "Remote model"},
				{"provider": "other", "id": "other-id"},
			}}, true, ""
		case "set_model":
			setModelCalls.Add(1)
			return map[string]any{}, true, ""
		case "get_available_thinking_levels":
			return map[string]any{"levels": []string{"off", "low", "high"}}, true, ""
		case "set_thinking_level":
			setThinkingCalls.Add(1)
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/controls")
	t.Cleanup(func() {
		if inst, err := mgr.Lookup(sid); err == nil {
			inst.Kill()
		}
	})

	modelsResponse := mustCall(t, c, &wspb.ControlCall{
		Id:   "models",
		Call: &wspb.ControlCall_GetAvailableModels{GetAvailableModels: &wspb.GetAvailableModelsCall{Sid: sid}},
	})
	models := modelsResponse.GetGetAvailableModels().GetModels()
	if len(models) != 2 || models[0].GetProvider() != "remote" || models[0].GetId() != "remote-id" || models[0].GetName() != "Remote model" {
		t.Fatalf("model list was not Pi-derived: %+v", models)
	}

	expectError(t, c, &wspb.ControlCall{
		Id:   "bad-model",
		Call: &wspb.ControlCall_SetModel{SetModel: &wspb.SetModelCall{Sid: sid, Provider: "remote", ModelId: "missing"}},
	}, "model is not available in Pi")
	if setModelCalls.Load() != 0 {
		t.Fatalf("invalid model reached the Pi setter: calls=%d", setModelCalls.Load())
	}
	setModelResponse := mustCall(t, c, &wspb.ControlCall{
		Id:   "set-model",
		Call: &wspb.ControlCall_SetModel{SetModel: &wspb.SetModelCall{Sid: sid, Provider: "remote", ModelId: "remote-id"}},
	})
	if setModelCalls.Load() != 1 {
		t.Fatalf("valid model setter calls = %d, want 1", setModelCalls.Load())
	}
	if got := setModelResponse.GetSetModel().GetState().GetModel(); got != "selected-model" {
		t.Fatalf("setter did not return refreshed canonical state: %q", got)
	}

	levelsResponse := mustCall(t, c, &wspb.ControlCall{
		Id:   "levels",
		Call: &wspb.ControlCall_GetAvailableThinkingLevels{GetAvailableThinkingLevels: &wspb.GetAvailableThinkingLevelsCall{Sid: sid}},
	})
	if got := strings.Join(levelsResponse.GetGetAvailableThinkingLevels().GetLevels(), ","); got != "off,low,high" {
		t.Fatalf("thinking discovery = %q, want off,low,high", got)
	}
	expectError(t, c, &wspb.ControlCall{
		Id:   "bad-thinking",
		Call: &wspb.ControlCall_SetThinking{SetThinking: &wspb.SetThinkingCall{Sid: sid, Level: "unsupported"}},
	}, "thinking level is not available in Pi")
	if setThinkingCalls.Load() != 0 {
		t.Fatalf("invalid thinking level reached the Pi setter: calls=%d", setThinkingCalls.Load())
	}
	setThinkingResponse := mustCall(t, c, &wspb.ControlCall{
		Id:   "set-thinking",
		Call: &wspb.ControlCall_SetThinking{SetThinking: &wspb.SetThinkingCall{Sid: sid, Level: "high"}},
	})
	if setThinkingCalls.Load() != 1 {
		t.Fatalf("valid thinking setter calls = %d, want 1", setThinkingCalls.Load())
	}
	if got := setThinkingResponse.GetSetThinking().GetState().GetThinking(); got != "high" {
		t.Fatalf("thinking setter did not return refreshed canonical state: %q", got)
	}
}

func TestControlOperationSharesOneContextBudgetAcrossPiRequests(t *testing.T) {
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/budget"})
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Kill()
	server := &controlServer{mgr: mgr}
	go func() {
		command := <-child.commands
		if command["type"] != "get_available_models" {
			return
		}
		response := map[string]any{
			"type": "response", "id": command["id"], "command": command["type"],
			"success": true, "data": map[string]any{"models": []map[string]any{{"provider": "p", "id": "m"}}},
		}
		encoded, _ := json.Marshal(response)
		_, _ = child.stdoutW.Write(append(encoded, '\n'))
		// Observe the setter but deliberately do not answer it. The one
		// operation context must expire here instead of starting a new budget.
		<-child.commands
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	started := time.Now()
	response := server.dispatch(ctx, &wspb.ControlCall{
		Id:   "budget",
		Call: &wspb.ControlCall_SetModel{SetModel: &wspb.SetModelCall{Sid: inst.ID, Provider: "p", ModelId: "m"}},
	})
	reason := response.GetError().GetReason()
	if !strings.Contains(reason, "timeout") {
		t.Fatalf("shared operation budget response = %q", reason)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("operation exceeded one shared context budget: %s", elapsed)
	}
	select {
	case command := <-child.commands:
		t.Fatalf("timed-out setter operation issued refresh command: %#v", command)
	default:
	}
}

func TestControlGateTimeoutWritesNoPiRecord(t *testing.T) {
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/gate"})
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Kill()
	entered := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_, _ = inst.WithControl(context.Background(), func(context.Context) (any, error) {
			close(entered)
			<-release
			return nil, nil
		})
	}()
	<-entered
	server := &controlServer{mgr: mgr}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	response := server.dispatch(ctx, &wspb.ControlCall{
		Id:   "gate",
		Call: &wspb.ControlCall_GetAvailableModels{GetAvailableModels: &wspb.GetAvailableModelsCall{Sid: inst.ID}},
	})
	if reason := response.GetError().GetReason(); !strings.Contains(reason, "timeout") {
		t.Fatalf("held gate response = %q", reason)
	}
	select {
	case command := <-child.commands:
		t.Fatalf("held gate wrote Pi command: %#v", command)
	default:
	}
	close(release)
}

func TestControlResetBusyRejectsBeforePiNewSessionWrite(t *testing.T) {
	child := newControlFakeChild()
	var newSessionCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			return map[string]any{"isStreaming": true, "isCompacting": false, "pendingMessageCount": 0}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			newSessionCalls.Add(1)
			return map[string]any{"cancelled": false}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/busy")
	expectError(t, c, &wspb.ControlCall{
		Id:   "busy-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	}, "busy")
	if newSessionCalls.Load() != 0 {
		t.Fatalf("busy reset wrote Pi new_session: calls=%d", newSessionCalls.Load())
	}
}

func TestControlResetPromptGenerationRaceRejectsWithoutNewSessionWrite(t *testing.T) {
	child := newControlFakeChild()
	preflightStarted := make(chan struct{})
	releasePreflight := make(chan struct{})
	var stateCalls atomic.Int32
	var newSessionCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			if stateCalls.Add(1) == 2 {
				close(preflightStarted)
				<-releasePreflight
			}
			return map[string]any{"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			newSessionCalls.Add(1)
			return map[string]any{"cancelled": false}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/race")
	sendCall(t, c, &wspb.ControlCall{
		Id:   "race-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	})
	select {
	case <-preflightStarted:
	case <-time.After(time.Second):
		t.Fatal("reset preflight did not start")
	}
	promptResponse := mustCall(t, c, &wspb.ControlCall{
		Id:   "intervening-prompt",
		Call: &wspb.ControlCall_Prompt{Prompt: &wspb.PromptCall{Sid: sid, Message: "intervening prompt"}},
	})
	if !promptResponse.GetPrompt().GetAccepted() {
		t.Fatalf("intervening prompt was not accepted: %+v", promptResponse)
	}
	close(releasePreflight)
	resetResponse := readResponse(t, c, "race-reset")
	if resetResponse.GetError().GetReason() == "" {
		t.Fatalf("generation race did not reject: %+v", resetResponse)
	}
	if newSessionCalls.Load() != 0 {
		t.Fatalf("generation race wrote Pi new_session: calls=%d", newSessionCalls.Load())
	}
}

func TestControlResetCancellationPreservesTranscriptAndPath(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			return map[string]any{"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			return map[string]any{"cancelled": true}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/cancel")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	mgr.UpdateSessionPath(inst, "/sessions/cancelled.jsonl")
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "user", Content: json.RawMessage(`"keep"`)}, nil)
	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "cancel-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	})
	if !response.GetNewSession().GetCancelled() {
		t.Fatalf("cancelled reset response = %+v", response.GetNewSession())
	}
	if inst.SessionPathCopy() != "/sessions/cancelled.jsonl" || len(inst.SnapshotCopy().Messages) != 1 {
		t.Fatalf("cancelled reset changed ownership/transcript: path=%q snapshot=%+v", inst.SessionPathCopy(), inst.SnapshotCopy())
	}
}

func TestControlSuccessfulResetClearsAndRefreshesNewSessionPath(t *testing.T) {
	child := newControlFakeChild()
	// Seed a published resume path for the old session: the bootstrap and
	// reset-preflight get_state responses name an existing regular file, so
	// the manager promotes it into State.SessionPath before the reset.
	oldSession := filepath.Join(t.TempDir(), "old.jsonl")
	if err := os.WriteFile(oldSession, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var stateCalls atomic.Int32
	var newSessionCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			call := stateCalls.Add(1)
			path := oldSession
			if call >= 3 {
				path = "/sessions/new.jsonl"
			}
			return map[string]any{
				"model": map[string]any{"name": "fresh-model"}, "thinkingLevel": "low",
				"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0,
				"sessionFile": path, "sessionId": path,
			}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			newSessionCalls.Add(1)
			return map[string]any{"cancelled": false}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	spawnCalls := atomic.Int32{}
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		spawnCalls.Add(1)
		if spawnCalls.Load() == 1 {
			return child, child.stdinW, child.stdoutR, nil
		}
		fresh := newControlFakeChild()
		return fresh, fresh.stdinW, fresh.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/reset")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: json.RawMessage(`"old"`)}, nil)
	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "success-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	})
	if newSessionCalls.Load() != 1 {
		t.Fatalf("successful reset calls = %d, want 1", newSessionCalls.Load())
	}
	reset := response.GetNewSession()
	if !reset.GetReset_() || reset.GetState().GetModel() != "fresh-model" ||
		len(inst.SnapshotCopy().Messages) != 0 || inst.SessionPathCopy() != "/sessions/new.jsonl" {
		t.Fatalf("reset did not clear/refresh canonical state: result=%+v path=%q snapshot=%+v", reset, inst.SessionPathCopy(), inst.SnapshotCopy())
	}
	// The old public resume path is gone and the new one is not published:
	// /sessions/new.jsonl does not exist as a regular file, so a reload
	// after Clear must open a fresh chat instead of resuming either path.
	if state := inst.StateCopy(); state.SessionPath != "" {
		t.Fatalf("successful reset kept a published resume path: %q", state.SessionPath)
	}
	oldLease, err := mgr.BeginSpawn(context.Background(), rpc.SpawnOptions{Cwd: "/w/reset", SessionPath: oldSession})
	if err != nil || !oldLease.Created() {
		t.Fatalf("old session path was still deduplicated after reset: lease=%#v err=%v", oldLease, err)
	}
	if err := mgr.FinishSpawn(oldLease, nil); err != nil {
		t.Fatal(err)
	}
	newLease, err := mgr.BeginSpawn(context.Background(), rpc.SpawnOptions{Cwd: "/w/reset", SessionPath: "/sessions/new.jsonl"})
	if err != nil || newLease.Created() || newLease.Instance() != inst {
		t.Fatalf("new session path did not deduplicate refreshed child: lease=%#v err=%v", newLease, err)
	}
}

func TestControlResetPostRefreshFailureReturnsWarningAfterClearing(t *testing.T) {
	child := newControlFakeChild()
	var stateCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			if stateCalls.Add(1) == 3 {
				return nil, false, "post-reset state unavailable"
			}
			return map[string]any{"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0, "sessionFile": "/sessions/old.jsonl"}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			return map[string]any{"cancelled": false}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/warning")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: json.RawMessage(`"stale"`)}, nil)
	response := mustCall(t, c, &wspb.ControlCall{
		Id:   "warning-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	})
	reset := response.GetNewSession()
	if !reset.GetReset_() || !strings.Contains(reset.GetStateWarning(), "post-reset state unavailable") {
		t.Fatalf("post-refresh warning result = %+v", reset)
	}
	if inst.SessionPathCopy() != "" || len(inst.SnapshotCopy().Messages) != 0 {
		t.Fatalf("warning reset revived old state: path=%q snapshot=%+v", inst.SessionPathCopy(), inst.SnapshotCopy())
	}
}

func TestControlResetPiRejectionPreservesTranscriptAndPath(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			return map[string]any{"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "new_session":
			return nil, false, "Pi refused reset"
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/reject")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	mgr.UpdateSessionPath(inst, "/sessions/reject.jsonl")
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "user", Content: json.RawMessage(`"preserve"`)}, nil)
	expectError(t, c, &wspb.ControlCall{
		Id:   "reject-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	}, "Pi refused reset")
	if inst.SessionPathCopy() != "/sessions/reject.jsonl" || len(inst.SnapshotCopy().Messages) != 1 {
		t.Fatalf("pre-acceptance rejection changed state: path=%q snapshot=%+v", inst.SessionPathCopy(), inst.SnapshotCopy())
	}
}

func TestControlStubbedOps(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "s1",
		Call: &wspb.ControlCall_WaitViewReady{WaitViewReady: &wspb.WaitViewReadyCall{}},
	})
	if !res.GetWaitViewReady().GetStubbed() {
		t.Fatalf("want stubbed ack, got %+v", res)
	}
}

func TestControlConnectionCloseReleasesManagerSubscription(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/connection-close")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	if got := mgr.SubscriptionCount(inst); got != 1 {
		t.Fatalf("subscription count before close = %d, want 1", got)
	}
	_ = c.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if got := mgr.SubscriptionCount(inst); got == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("connection close left manager subscription count at %d", mgr.SubscriptionCount(inst))
}

// newControlRenameManager returns a manager backed by a single fake child
// whose respond callback handles the bootstrap triple plus set_session_name.
// rejectName, when non-nil, makes set_session_name fail with that message.
func newControlRenameManager(t *testing.T, rejectName string) (*rpc.Manager, *controlFakeChild, chan string) {
	t.Helper()
	child := newControlFakeChild()
	commands := make(chan string, 8)
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		kind, _ := command["type"].(string)
		commands <- kind
		switch kind {
		case "get_state":
			return map[string]any{
				"model":               map[string]any{"name": "pi-4"},
				"thinkingLevel":       "high",
				"isStreaming":         false,
				"isCompacting":        false,
				"pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats":
			return map[string]any{
				"tokens": map[string]any{"input": 0, "output": 0},
			}, true, ""
		case "get_commands":
			return map[string]any{"commands": []map[string]any{}}, true, ""
		case "set_session_name":
			if rejectName != "" {
				return nil, false, rejectName
			}
			name, _ := command["name"].(string)
			if err := emitNativeSessionInfoChanged(child, name); err != nil {
				return nil, false, err.Error()
			}
			return nil, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	return mgr, child, commands
}

// readBootstrapCommands drains the bootstrap triple from the commands
// channel so the test sees only the set_session_name command afterwards.
func readBootstrapCommands(commands <-chan string) {
	for i := 0; i < 3; i++ {
		<-commands
	}
}

func TestControlSetSessionNameForwardsAndUpdatesTitle(t *testing.T) {
	mgr, _, commands := newControlRenameManager(t, "")
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")
	readBootstrapCommands(commands)

	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "snm",
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{Sid: sid, Name: "Audit auth module"}},
	})
	if got := res.GetSetSessionName().GetState().GetTitle(); got != "Audit auth module" {
		t.Fatalf("state.title = %q, want %q", got, "Audit auth module")
	}

	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	if got := inst.TitleCopy(); got != "Audit auth module" {
		t.Fatalf("inst.TitleCopy = %q, want %q", got, "Audit auth module")
	}
	list := mustCall(t, c, &wspb.ControlCall{
		Id:   "ls",
		Call: &wspb.ControlCall_ListSessions{ListSessions: &wspb.ListSessionsCall{}},
	})
	sessions := list.GetListSessions().GetSessions()
	if len(sessions) != 1 || sessions[0].GetTitle() != "Audit auth module" {
		t.Fatalf("listSessions title = %+v, want %q", sessions, "Audit auth module")
	}

	// The child received the set_session_name command with the name.
	select {
	case got := <-commands:
		if got != "set_session_name" {
			t.Fatalf("captured command = %q, want set_session_name", got)
		}
	case <-time.After(time.Second):
		t.Fatal("did not observe set_session_name command on the child")
	}
}

func TestControlSetSessionNamePiRejectionSurfacesError(t *testing.T) {
	mgr, _, commands := newControlRenameManager(t, "name not allowed")
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")
	readBootstrapCommands(commands)

	expectError(t, c, &wspb.ControlCall{
		Id:   "snm",
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{Sid: sid, Name: "Audit auth module"}},
	}, "name not allowed")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	if got := inst.TitleCopy(); got == "Audit auth module" {
		t.Fatalf("inst.TitleCopy unexpectedly updated to %q on Pi rejection", got)
	}
}

func TestControlSetSessionNameUnknownSidReturnsError(t *testing.T) {
	mgr, _, _ := newControlRenameManager(t, "")
	c := helloDial(t, mgr)
	expectError(t, c, &wspb.ControlCall{
		Id:   "snm",
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{Sid: "does-not-exist", Name: "Audit auth module"}},
	}, "does-not-exist")
}

func TestControlSetSessionNameValidation(t *testing.T) {
	mgr, _, _ := newControlRenameManager(t, "")
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")

	// A blank name is rejected before any Pi write.
	expectError(t, c, &wspb.ControlCall{
		Id:   "snm",
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{Sid: sid, Name: "   "}},
	}, "name is required")
}

func TestControlSetSessionNameEmitsStateChangedEvent(t *testing.T) {
	mgr, _, commands := newControlRenameManager(t, "")
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")
	readBootstrapCommands(commands)

	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	sub := mgr.Subscribe(inst)
	if sub == nil {
		t.Fatal("subscribe returned nil")
	}
	defer sub.CloseThis()

	mustCall(t, c, &wspb.ControlCall{
		Id:   "snm",
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{Sid: sid, Name: "Audit auth module"}},
	})

	deadline := time.After(time.Second)
	for {
		select {
		case ev, ok := <-sub.Channel():
			if !ok {
				t.Fatal("subscription channel closed before event arrived")
			}
			if ev.Evt != rpc.EvtStateChanged {
				continue
			}
			raw, _ := json.Marshal(ev.Data)
			var st rpc.State
			if err := json.Unmarshal(raw, &st); err != nil {
				continue
			}
			if st.Title == "Audit auth module" {
				return
			}
		case <-deadline:
			t.Fatal("did not observe stateChanged event with new title")
		}
	}
}

func TestSubagentTranscriptOp(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	cwd, err := filepath.Abs(filepath.Join(t.TempDir(), "project"))
	if err != nil {
		t.Fatal(err)
	}
	parentPath := setupPiControlFixture(t, cwd, "parent.jsonl", piControlHeader("parent-id", cwd))
	forkPath := filepath.Join(filepath.Dir(parentPath), "20260822T000000_fork", "run-0", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(forkPath), 0755); err != nil {
		t.Fatal(err)
	}
	forkRecords := strings.Join([]string{
		piControlHeader("fork-id", cwd),
		`{"type":"message","id":"message-1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"fork hello"}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(forkPath, []byte(forkRecords), 0644); err != nil {
		t.Fatal(err)
	}

	const runID = "run-transcript-test"
	statusPath := filepath.Join(os.TempDir(), "pi-subagents-test", "async-subagent-runs", runID, "status.json")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	status, err := json.Marshal(map[string]any{
		"runId": runID,
		"cwd":   cwd,
		"steps": []map[string]string{{
			"label":       "First step",
			"sessionFile": forkPath,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, status, 0644); err != nil {
		t.Fatal(err)
	}

	server := &controlServer{mgr: rpc.NewManager()}
	response := server.dispatch(context.Background(), &wspb.ControlCall{
		Id:   "subagent-transcript",
		Call: &wspb.ControlCall_SubagentTranscript{SubagentTranscript: &wspb.SubagentTranscriptCall{RunId: "run-transcript-test"}},
	})
	transcript := response.GetSubagentTranscript()
	if transcript == nil || transcript.GetRunId() != runID {
		t.Fatalf("subagent transcript response = %+v", response)
	}
	steps := transcript.GetSteps()
	if len(steps) != 1 || len(steps[0].GetMessages()) < 1 {
		t.Fatalf("transcript steps = %+v, want one step with messages", steps)
	}

	traversal := server.dispatch(context.Background(), &wspb.ControlCall{
		Id:   "subagent-traversal",
		Call: &wspb.ControlCall_SubagentTranscript{SubagentTranscript: &wspb.SubagentTranscriptCall{RunId: "../x"}},
	})
	if traversal.GetError().GetReason() == "" {
		t.Fatalf("traversal runId unexpectedly succeeded: %+v", traversal)
	}

	unknown := server.dispatch(context.Background(), &wspb.ControlCall{
		Id:   "subagent-unknown",
		Call: &wspb.ControlCall_SubagentTranscript{SubagentTranscript: &wspb.SubagentTranscriptCall{RunId: "missing-run"}},
	})
	if !strings.Contains(unknown.GetError().GetReason(), "subagent run not found") {
		t.Fatalf("unknown runId response: %+v", unknown)
	}
}

func nextStateTransactionCommand(t *testing.T, child *controlFakeChild) map[string]any {
	t.Helper()
	select {
	case command, ok := <-child.commands:
		if !ok {
			t.Fatal("fake Pi command stream closed")
		}
		return command
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Pi command")
		return nil
	}
}

func respondStateTransactionCommand(t *testing.T, child *controlFakeChild, command map[string]any, success bool, data any, message string) {
	t.Helper()
	response := map[string]any{
		"type":    "response",
		"id":      command["id"],
		"command": command["type"],
		"success": success,
		"data":    data,
	}
	if message != "" {
		response["error"] = message
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := child.stdoutW.Write(append(encoded, '\n')); err != nil {
		t.Fatalf("write Pi response: %v", err)
	}
}

func emitNativeSessionInfoChanged(child *controlFakeChild, name string) error {
	encoded, err := json.Marshal(map[string]any{"type": "session_info_changed", "name": name})
	if err != nil {
		return err
	}
	_, err = child.stdoutW.Write(append(encoded, '\n'))
	return err
}

func respondNativeRename(t *testing.T, child *controlFakeChild, command map[string]any, name string) {
	t.Helper()
	if err := emitNativeSessionInfoChanged(child, name); err != nil {
		t.Fatalf("write native name event: %v", err)
	}
	respondStateTransactionCommand(t, child, command, true, map[string]any{}, "")
}

func stateTransactionControlFixture(t *testing.T, cwd string) (*rpc.Manager, *controlFakeChild, *rpc.Instance) {
	t.Helper()
	child := newControlFakeChild()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(inst.Kill)
	return mgr, child, inst
}

func stateTransactionRenameCall(id, sid, name string) *wspb.ControlCall {
	return &wspb.ControlCall{
		Id: id,
		Call: &wspb.ControlCall_SetSessionName{SetSessionName: &wspb.SetSessionNameCall{
			Sid: sid, Name: name,
		}},
	}
}

// This schedule answers stats before the rename ack; the root lost-update
// regression is TestStateTransactionPublicationOrder in pkg/rpc.
func TestStateTransactionIndependentUpdates(t *testing.T) {
	mgr, child, inst := stateTransactionControlFixture(t, "/w/state-independent")
	server := &controlServer{mgr: mgr}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	renameDone := make(chan *wspb.ControlResponse, 1)
	go func() {
		renameDone <- server.dispatch(ctx, stateTransactionRenameCall("rename", inst.ID, "renamed"))
	}()
	nameCommand := nextStateTransactionCommand(t, child)
	if nameCommand["type"] != "set_session_name" {
		t.Fatalf("first native command = %v, want set_session_name", nameCommand["type"])
	}

	statsDone := make(chan error, 1)
	go func() {
		_, err := inst.Request(ctx, "get_session_stats", nil)
		statsDone <- err
	}()
	statsCommand := nextStateTransactionCommand(t, child)
	if statsCommand["type"] != "get_session_stats" {
		t.Fatalf("second native command = %v, want get_session_stats", statsCommand["type"])
	}
	stats := map[string]any{
		"tokens":       map[string]any{"input": 7, "output": 0, "cacheRead": 2, "cacheWrite": 3},
		"contextUsage": map[string]any{"tokens": 5, "contextWindow": 200000},
	}
	respondStateTransactionCommand(t, child, statsCommand, true, stats, "")
	select {
	case err := <-statsDone:
		if err != nil {
			t.Fatalf("stats request failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stats request did not complete")
	}
	respondNativeRename(t, child, nameCommand, "renamed")
	var renameResponse *wspb.ControlResponse
	select {
	case renameResponse = <-renameDone:
	case <-time.After(2 * time.Second):
		t.Fatal("rename control did not complete")
	}
	if renameResponse.GetError() != nil {
		t.Fatalf("rename control failed: %+v", renameResponse.GetError())
	}
	state := inst.StateCopy()
	resultState := renameResponse.GetSetSessionName().GetState()
	if state.Title != "renamed" || resultState.GetTitle() != "renamed" {
		t.Fatalf("rename did not commit both titles: retained=%+v response=%+v", state, resultState)
	}
	if state.InputTokens == nil || *state.InputTokens != 7 || state.OutputTokens == nil || *state.OutputTokens != 0 || state.CacheReadTokens == nil || *state.CacheReadTokens != 2 || state.CacheWriteTokens == nil || *state.CacheWriteTokens != 3 || state.ContextUsedTokens == nil || *state.ContextUsedTokens != 5 || state.ContextWindowTokens == nil || *state.ContextWindowTokens != 200000 {
		t.Fatalf("concurrent stats were lost during rename: %+v", state)
	}
	if resultState.InputTokens == nil || resultState.GetInputTokens() != 7 || resultState.CacheWriteTokens == nil || resultState.GetCacheWriteTokens() != 3 {
		t.Fatalf("rename acknowledgement omitted concurrent stats: %+v", resultState)
	}
}

func TestStateTransactionRenameGate(t *testing.T) {
	mgr, child, inst := stateTransactionControlFixture(t, "/w/state-rename-gate")
	server := &controlServer{mgr: mgr}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	firstDone := make(chan *wspb.ControlResponse, 1)
	go func() {
		firstDone <- server.dispatch(ctx, stateTransactionRenameCall("first", inst.ID, "first title"))
	}()
	firstCommand := nextStateTransactionCommand(t, child)
	if firstCommand["type"] != "set_session_name" {
		t.Fatalf("first native command = %v, want set_session_name", firstCommand["type"])
	}
	secondDone := make(chan *wspb.ControlResponse, 1)
	go func() {
		secondDone <- server.dispatch(ctx, stateTransactionRenameCall("second", inst.ID, "second title"))
	}()
	respondNativeRename(t, child, firstCommand, "first title")
	secondCommand := nextStateTransactionCommand(t, child)
	if secondCommand["type"] != "set_session_name" {
		t.Fatalf("second native command = %v, want set_session_name", secondCommand["type"])
	}
	respondNativeRename(t, child, secondCommand, "second title")

	responses := make(map[string]*wspb.ControlResponse, 2)
	for range 2 {
		select {
		case response := <-firstDone:
			responses[response.GetId()] = response
			firstDone = nil
		case response := <-secondDone:
			responses[response.GetId()] = response
			secondDone = nil
		case <-time.After(2 * time.Second):
			t.Fatal("serialized rename controls did not complete")
		}
	}
	for id, wantTitle := range map[string]string{"first": "first title", "second": "second title"} {
		response := responses[id]
		if response == nil || response.GetError() != nil {
			t.Fatalf("rename %s failed: %+v", id, response)
		}
		if got := response.GetSetSessionName().GetState().GetTitle(); got != wantTitle {
			t.Fatalf("rename %s acknowledgement title = %q, want %q", id, got, wantTitle)
		}
	}
	if title := inst.TitleCopy(); title != "second title" {
		t.Fatalf("retained title = %q, want last gated rename", title)
	}
	if title := inst.StateCopy().Title; title != "second title" {
		t.Fatalf("State title = %q, want last gated rename", title)
	}
}

func TestStateTransactionResetKeepsMessageAcceptedAfterResponse(t *testing.T) {
	child := newControlFakeChild()
	writeFrame := func(frame map[string]any) {
		encoded, _ := json.Marshal(frame)
		_, _ = child.stdoutW.Write(append(encoded, '\n'))
	}
	go func() {
		for command := range child.commands {
			kind, _ := command["type"].(string)
			response := map[string]any{
				"type": "response", "id": command["id"], "command": kind, "success": true,
			}
			switch kind {
			case "get_state":
				response["data"] = map[string]any{"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0}
			case "get_session_stats", "get_commands":
				response["data"] = map[string]any{}
			case "new_session":
				response["data"] = map[string]any{"cancelled": false}
			default:
				response["success"] = false
				response["error"] = "unexpected command"
			}
			writeFrame(response)
			if kind == "new_session" {
				writeFrame(map[string]any{
					"type":    "message_end",
					"message": map[string]any{"role": "user", "content": "after-reset"},
				})
			}
		}
	}()
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/boundary")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	mgr.UpdateSessionPath(inst, "/sessions/old.jsonl")
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "user", Content: json.RawMessage(`"old"`)}, nil)
	sendCall(t, c, &wspb.ControlCall{
		Id:   "boundary-reset",
		Call: &wspb.ControlCall_NewSession{NewSession: &wspb.NewSessionCall{Sid: sid}},
	})
	response := readResponse(t, c, "boundary-reset")
	if response.GetError() != nil || !response.GetNewSession().GetReset_() {
		t.Fatalf("reset failed: %+v", response)
	}
	if inst.SessionPathCopy() != "" {
		t.Fatalf("reset kept raw session ownership: %q", inst.SessionPathCopy())
	}
	if state := inst.StateCopy(); state.SessionPath != "" {
		t.Fatalf("reset kept the published resume path: %q", state.SessionPath)
	}
	messages := inst.SnapshotCopy().Messages
	if len(messages) != 1 || !strings.Contains(string(messages[0].Content), "after-reset") {
		t.Fatalf("reset erased a message accepted after its response: %+v", messages)
	}
}

// protoString is a helper for the optional string fields of typed calls.
func protoString(value string) *string { return &value }
