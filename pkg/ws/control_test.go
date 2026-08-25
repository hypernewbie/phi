package ws

import (
	"context"
	"encoding/json"
	"fmt"
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

	"github.com/hypernewbie/phi/pkg/rpc"
)

func dial(t *testing.T, h http.HandlerFunc) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func helloDial(t *testing.T, mgr *rpc.Manager) *websocket.Conn {
	c := dial(t, HandleControl(mgr, func() string { return "" }))
	if err := c.WriteJSON(Envelope{Type: "hello", V: 1}); err != nil {
		t.Fatal(err)
	}
	var welcome Envelope
	if err := c.ReadJSON(&welcome); err != nil {
		t.Fatal(err)
	}
	if welcome.Type != "welcome" {
		t.Fatalf("want welcome, got %+v", welcome)
	}
	return c
}

func call(t *testing.T, c *websocket.Conn, id, op string) Envelope {
	t.Helper()
	if err := c.WriteJSON(Envelope{Type: "call", ID: id, Op: op}); err != nil {
		t.Fatal(err)
	}
	var res Envelope
	if err := c.ReadJSON(&res); err != nil {
		t.Fatal(err)
	}
	return res
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

func readResponse(t *testing.T, c *websocket.Conn, id string) Envelope {
	t.Helper()
	for {
		var frame Envelope
		if err := c.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == rpc.ResFrame && frame.ID == id {
			return frame
		}
	}
}

func spawnControlSession(t *testing.T, c *websocket.Conn, cwd string) string {
	t.Helper()
	args, err := json.Marshal(map[string]string{"cwd": cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "spawn-session", Op: rpc.OpSpawn, Args: args}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "spawn-session")
	if response.Ok == nil || !*response.Ok {
		t.Fatalf("spawn failed: %+v", response)
	}
	var payload struct {
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(response.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Sid == "" {
		t.Fatalf("spawn response missing sid: %s", response.Data)
	}
	return payload.Sid
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

func TestControlAbortSuccessErrorAndValidation(t *testing.T) {
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

	if err := c.WriteJSON(Envelope{
		Type: rpc.CallFrame, ID: "abort-ok", Op: rpc.OpAbort, Sid: inst.ID,
		Args: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatal(err)
	}
	success := readResponse(t, c, "abort-ok")
	if success.Ok == nil || !*success.Ok || string(success.Data) != `{"aborted":true}` {
		t.Fatalf("abort success response: %+v", success)
	}

	if err := c.WriteJSON(Envelope{
		Type: rpc.CallFrame, ID: "abort-invalid", Op: rpc.OpAbort, Sid: inst.ID,
		Args: json.RawMessage(`{"extra":true}`),
	}); err != nil {
		t.Fatal(err)
	}
	invalid := readResponse(t, c, "abort-invalid")
	if invalid.Ok == nil || *invalid.Ok {
		t.Fatalf("abort validation unexpectedly succeeded: %+v", invalid)
	}
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
	if err := c.WriteJSON(Envelope{
		Type: rpc.CallFrame, ID: "abort-error", Op: rpc.OpAbort, Sid: inst.ID,
		Args: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "abort-error")
	if response.Ok == nil || *response.Ok || !strings.Contains(string(response.Error), "abort rejected") {
		t.Fatalf("abort error was not propagated: %+v", response)
	}
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
	if err := c.WriteJSON(Envelope{
		Type: rpc.CallFrame, ID: "abort-unknown", Op: rpc.OpAbort, Sid: "missing-sid",
		Args: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "abort-unknown")
	if response.Ok == nil || *response.Ok || !strings.Contains(string(response.Error), "missing-sid") {
		t.Fatalf("unknown sid abort did not surface lookup error: %+v", response)
	}
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
	done := make(chan Envelope, 1)
	go func() {
		done <- server.dispatch(ctx, Envelope{
			Type: rpc.CallFrame, ID: "abort-cancel", Op: rpc.OpAbort, Sid: inst.ID,
			Args: json.RawMessage(`{}`),
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
		if response.Ok == nil || *response.Ok {
			t.Fatalf("context cancellation did not fail abort: %+v", response)
		}
		if !strings.Contains(response.Error, "control connection closed") {
			t.Fatalf("abort error did not surface context cancellation: %+v", response)
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
	res := call(t, c, "c1", "listSessions")
	if res.ID != "c1" || res.Ok == nil || !*res.Ok {
		t.Fatalf("bad res %+v", res)
	}
}

func TestControlRejectsMissingHello(t *testing.T) {
	c := dial(t, HandleControl(rpc.NewManager(), nil))
	_ = c.WriteJSON(Envelope{Type: "call", ID: "x", Op: "listSessions"})
	var res Envelope
	if err := c.ReadJSON(&res); err != nil {
		t.Fatal(err)
	}
	if res.Ok != nil && *res.Ok {
		t.Fatal("call before hello must fail")
	}
}

func TestControlHydrateUnknownSid(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	if err := c.WriteJSON(Envelope{Type: "call", ID: "h", Op: "hydrate", Sid: "nope"}); err != nil {
		t.Fatal(err)
	}
	var res Envelope
	if err := c.ReadJSON(&res); err != nil {
		t.Fatal(err)
	}
	if res.Ok != nil && *res.Ok {
		t.Fatal("unknown sid must fail")
	}
}

func newQueueControlFixture(t *testing.T, respond func(map[string]any) (any, bool, string)) (*rpc.Manager, *controlFakeChild, *websocket.Conn, string) {
	t.Helper()
	child := newControlFakeChild()
	respondControlCommands(child, respond)
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/queue-control")
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })
	return mgr, child, c, sid
}

func TestControlQueueOperationsStrictDecode(t *testing.T) {
	_, _, c, sid := newQueueControlFixture(t, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		default:
			return map[string]any{}, true, ""
		}
	})
	epoch := "missing-until-hydrate"
	cases := []struct {
		name string
		op   string
		args string
	}{
		{"submit", rpc.OpQueueSubmit, `{"itemId":"x","sessionEpoch":"` + epoch + `","message":"x","delivery":"prompt","attachmentRefs":[],"extra":true}`},
		{"restore", rpc.OpQueueRestore, `{"itemId":"x","sessionEpoch":"` + epoch + `","extra":true}`},
		{"copy", rpc.OpQueueCopy, `{"itemId":"x","sessionEpoch":"` + epoch + `","extra":true}`},
		{"discard", rpc.OpQueueDiscard, `{"itemId":"x","sessionEpoch":"` + epoch + `","extra":true}`},
	}
	for index, testCase := range cases {
		id := fmt.Sprintf("queue-strict-%d", index)
		if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: id, Op: testCase.op, Sid: sid, Args: json.RawMessage(testCase.args)}); err != nil {
			t.Fatal(err)
		}
		response := readResponse(t, c, id)
		if response.Ok == nil || *response.Ok {
			t.Fatalf("%s unexpectedly succeeded: %+v", testCase.name, response)
		}
	}
}

func TestControlQueueAcceptedAndHydrateReattachment(t *testing.T) {
	var promptSeen atomic.Bool
	mgr, _, c, sid := newQueueControlFixture(t, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "prompt", "steer", "follow_up":
			if command["type"] == "prompt" {
				promptSeen.Store(true)
			}
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	epoch := inst.QueueSessionEpoch()
	args := fmt.Sprintf(`{"itemId":"item-control","sessionEpoch":%q,"message":"control item","delivery":"prompt","attachmentRefs":[]}`, epoch)
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "queue-submit", Op: rpc.OpQueueSubmit, Sid: sid, Args: json.RawMessage(args)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "queue-submit")
	if response.Ok == nil || !*response.Ok {
		t.Fatalf("queueSubmit failed: %+v", response)
	}
	var item rpc.QueueItem
	if err := json.Unmarshal(response.Data, &item); err != nil {
		t.Fatal(err)
	}
	if item.ID != "item-control" || item.Sid != sid || item.SessionEpoch != epoch {
		t.Fatalf("queueSubmit item = %+v", item)
	}
	if item.State != rpc.QueueSending && item.State != rpc.QueueAccepted {
		t.Fatalf("queueSubmit state = %q", item.State)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && mgrStateQueueItem(t, inst, "item-control").State != rpc.QueueAccepted {
		time.Sleep(5 * time.Millisecond)
	}
	if got := mgrStateQueueItem(t, inst, "item-control").State; got != rpc.QueueAccepted {
		t.Fatalf("queue item did not settle accepted: %q", got)
	}
	if !promptSeen.Load() {
		t.Fatal("queueSubmit did not send a correlated prompt command")
	}

	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "hydrate-one", Op: rpc.OpHydrate, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	firstHydrate := readResponse(t, c, "hydrate-one")
	var first struct {
		Queue struct {
			SessionEpoch string          `json:"sessionEpoch"`
			Items        []rpc.QueueItem `json:"items"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(firstHydrate.Data, &first); err != nil {
		t.Fatal(err)
	}
	if first.Queue.SessionEpoch != epoch || len(first.Queue.Items) != 1 || first.Queue.Items[0].ID != "item-control" {
		t.Fatalf("first hydrate queue = %+v", first.Queue)
	}
	_ = c.Close()

	second := helloDial(t, mgr)
	if err := second.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "hydrate-two", Op: rpc.OpHydrate, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	secondHydrate := readResponse(t, second, "hydrate-two")
	var secondPayload struct {
		Queue struct {
			SessionEpoch string          `json:"sessionEpoch"`
			Items        []rpc.QueueItem `json:"items"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(secondHydrate.Data, &secondPayload); err != nil {
		t.Fatal(err)
	}
	if secondPayload.Queue.SessionEpoch != epoch || len(secondPayload.Queue.Items) != 1 || secondPayload.Queue.Items[0].ID != "item-control" {
		t.Fatalf("reattached hydrate queue = %+v", secondPayload.Queue)
	}
}

func TestControlQueueLateSteerPromotion(t *testing.T) {
	var stateCalls atomic.Int32
	var promptCalls atomic.Int32
	mgr, _, c, sid := newQueueControlFixture(t, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			if stateCalls.Add(1) == 1 {
				return map[string]any{"isStreaming": true, "isCompacting": false}, true, ""
			}
			return map[string]any{"isStreaming": false, "isCompacting": false}, true, ""
		case "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "steer":
			return nil, false, "run settled"
		case "prompt":
			promptCalls.Add(1)
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	epoch := inst.QueueSessionEpoch()
	args := fmt.Sprintf(`{"itemId":"late-steer","sessionEpoch":%q,"message":"promote me","delivery":"steer","attachmentRefs":[]}`, epoch)
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "late-steer", Op: rpc.OpQueueSubmit, Sid: sid, Args: json.RawMessage(args)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "late-steer")
	if response.Ok == nil || !*response.Ok {
		t.Fatalf("late steer queueSubmit failed: %+v", response)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && (mgrStateQueueItem(t, inst, "late-steer").State != rpc.QueueAccepted || promptCalls.Load() != 1) {
		time.Sleep(5 * time.Millisecond)
	}
	item := mgrStateQueueItem(t, inst, "late-steer")
	if item.State != rpc.QueueAccepted || promptCalls.Load() != 1 {
		t.Fatalf("late steer promotion = %+v promptCalls=%d", item, promptCalls.Load())
	}
}

func mgrStateQueueItem(t *testing.T, inst *rpc.Instance, id string) rpc.QueueItem {
	t.Helper()
	for _, item := range inst.QueueSnapshotCopy().Items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("queue item %q missing from %+v", id, inst.QueueSnapshotCopy().Items)
	return rpc.QueueItem{}
}


func TestControlNewOperationsStrictDecodeAndUnknownSid(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	cases := []struct {
		name string
		op   string
		sid  string
		args string
	}{
		{"models-unknown-field", rpc.OpGetAvailableModels, "missing", `{"extra":true}`},
		{"models-null-args", rpc.OpGetAvailableModels, "missing", `null`},
		{"model-wrong-type", rpc.OpSetModel, "missing", `{"provider":1,"modelId":"m"}`},
		{"model-unknown-field", rpc.OpSetModel, "missing", `{"provider":"p","modelId":"m","extra":true}`},
		{"model-empty-provider", rpc.OpSetModel, "missing", `{"provider":"","modelId":"m"}`},
		{"thinking-list-unknown-sid", rpc.OpGetAvailableThinkingLevels, "missing", `{}`},
		{"thinking-wrong-type", rpc.OpSetThinking, "missing", `{"level":1}`},
		{"thinking-empty", rpc.OpSetThinking, "missing", `{"level":""}`},
		{"thinking-unknown-field", rpc.OpSetThinking, "missing", `{"level":"high","extra":true}`},
		{"reset-unknown-field", rpc.OpNewSession, "missing", `{"extra":true}`},
		{"reset-unknown-sid", rpc.OpNewSession, "missing", `{}`},
	}
	for index, testCase := range cases {
		if err := c.WriteJSON(Envelope{
			Type: rpc.CallFrame, ID: fmt.Sprintf("strict-%d", index), Op: testCase.op,
			Sid: testCase.sid, Args: json.RawMessage(testCase.args),
		}); err != nil {
			t.Fatal(err)
		}
		response := readResponse(t, c, fmt.Sprintf("strict-%d", index))
		if response.Ok == nil || *response.Ok {
			t.Fatalf("%s unexpectedly succeeded: %+v", testCase.name, response)
		}
	}
}

func TestDecodeStrictRejectsMalformedJSONAndTrailingValues(t *testing.T) {
	var args struct{}
	for _, raw := range []json.RawMessage{json.RawMessage(`{`), json.RawMessage(`{} {}`)} {
		if err := decodeStrict(raw, &args, true); err == nil {
			t.Fatalf("malformed/trailed args unexpectedly decoded: %s", raw)
		}
	}
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "h1", Op: rpc.OpHydrate, Sid: inst.ID, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "h2", Op: rpc.OpHydrate, Sid: inst.ID, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	inst.Emit(rpc.EvtStateChanged, nil, map[string]any{"fenced": true})
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	order := make([]string, 0, 3)
	seen := map[string]bool{}
	for len(order) < 3 {
		var frame Envelope
		if err := c.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == rpc.ResFrame && (frame.ID == "h1" || frame.ID == "h2") {
			if frame.Ok == nil || !*frame.Ok {
				t.Fatalf("hydrate failed: %+v", frame)
			}
			if !seen[frame.ID] {
				seen[frame.ID] = true
				order = append(order, frame.ID)
			}
			continue
		}
		if frame.Type == "evt" && frame.Evt == rpc.EvtStateChanged && frame.Sid == inst.ID {
			var data map[string]any
			if err := json.Unmarshal(frame.Data, &data); err != nil {
				t.Fatal(err)
			}
			if data["fenced"] == true && !seen["fenced"] {
				seen["fenced"] = true
				order = append(order, "fenced")
			}
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
	if err := c.WriteJSON(Envelope{Type: "call", ID: "hyd", Op: "hydrate", Sid: inst.ID}); err != nil {
		t.Fatal(err)
	}
	for {
		var frame Envelope
		if err := c.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == rpc.ResFrame && frame.ID == "hyd" {
			if frame.Ok == nil || !*frame.Ok {
				t.Fatalf("hydrate failed: %+v", frame)
			}
			break
		}
	}

	// Hydrate is the deterministic subscription barrier. The next spawn reuses
	// this live instance, so the event below is after subscribe and before its
	// spawn snapshot is copied without relying on a scheduler timing window.
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: []byte(`"boundary"`)}, nil)
	args, err := json.Marshal(map[string]string{"cwd": cwd, "sessionPath": sessionPath})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(Envelope{Type: "call", ID: "sp", Op: "spawn", Args: args}); err != nil {
		t.Fatal(err)
	}

	var spawn Envelope
	var events []Envelope
	for spawn.ID == "" {
		var frame Envelope
		if err := c.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "evt" && frame.Sid == inst.ID {
			events = append(events, frame)
		}
		if frame.Type == rpc.ResFrame && frame.ID == "sp" {
			spawn = frame
		}
	}
	if spawn.Ok == nil || !*spawn.Ok {
		t.Fatalf("spawn failed: %+v", spawn)
	}
	var payload struct {
		Sid      string `json:"sid"`
		Snapshot struct {
			LastSeq  uint64        `json:"lastSeq"`
			Messages []rpc.Message `json:"messages"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal(spawn.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Sid != inst.ID {
		t.Fatalf("spawn did not reuse live instance: got sid %q want %q", payload.Sid, inst.ID)
	}
	if payload.Snapshot.LastSeq != 1 || len(payload.Snapshot.Messages) != 1 {
		t.Fatalf("boundary event missing from spawn snapshot: %s", spawn.Data)
	}
	if payload.Snapshot.Messages[0].Role != "assistant" || string(payload.Snapshot.Messages[0].Content) != `"boundary"` {
		t.Fatalf("unexpected boundary snapshot message: %+v", payload.Snapshot.Messages[0])
	}

	// Emit only after the response has been read, which is after SnapshotCopy.
	inst.Emit(rpc.EvtStateChanged, nil, map[string]any{"marker": "following"})
	for {
		seenNext := false
		for _, frame := range events {
			if frame.Seq == payload.Snapshot.LastSeq+1 && frame.Evt == rpc.EvtStateChanged {
				seenNext = true
				break
			}
		}
		if seenNext {
			break
		}
		var frame Envelope
		if err := c.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "evt" && frame.Sid == inst.ID {
			events = append(events, frame)
		}
	}

	var seqs []uint64
	for _, frame := range events {
		if frame.Evt == rpc.EvtMessageEnd || frame.Evt == rpc.EvtStateChanged {
			seqs = append(seqs, frame.Seq)
		}
	}
	if len(seqs) < 2 || seqs[0] != payload.Snapshot.LastSeq || seqs[1] != payload.Snapshot.LastSeq+1 {
		t.Fatalf("event sequence was not contiguous after snapshot: got %v", seqs)
	}
}

func TestControlSpawnIncludesLowerCamelSnapshot(t *testing.T) {
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
	args, err := json.Marshal(map[string]string{"cwd": "/w/demo"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(Envelope{Type: "call", ID: "sp", Op: "spawn", Args: args}); err != nil {
		t.Fatal(err)
	}
	res := readResponse(t, c, "sp")
	if res.Ok == nil || !*res.Ok || calls.Load() != 1 {
		t.Fatalf("spawn failed: %+v", res)
	}
	var payload struct {
		Snapshot struct {
			LastSeq  uint64        `json:"lastSeq"`
			Messages []rpc.Message `json:"messages"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal(res.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Snapshot.LastSeq != 3 || payload.Snapshot.Messages == nil {
		t.Fatalf("spawn snapshot did not include bootstrap events with lower-camel fields: %s", res.Data)
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
	args, _ := json.Marshal(map[string]string{"cwd": "/w/demo"})
	if err := c.WriteJSON(Envelope{Type: "call", ID: "sp", Op: "spawn", Args: args}); err != nil {
		t.Fatal(err)
	}
	spawnRes := readResponse(t, c, "sp")
	var spawnPayload struct {
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(spawnRes.Data, &spawnPayload); err != nil {
		t.Fatal(err)
	}
	inst, err := mgr.Lookup(spawnPayload.Sid)
	if err != nil {
		t.Fatal(err)
	}
	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "user", Content: []byte(`"live"`)}, nil)
	inst.ResetTranscript()
	if err := c.WriteJSON(Envelope{Type: "call", ID: "hyd", Op: "hydrate", Sid: spawnPayload.Sid}); err != nil {
		t.Fatal(err)
	}
	hydrate := readResponse(t, c, "hyd")
	if hydrate.Ok == nil || !*hydrate.Ok {
		t.Fatalf("hydrate failed: %+v", hydrate)
	}
	var payload struct {
		LastSeq  uint64        `json:"lastSeq"`
		Messages []rpc.Message `json:"messages"`
	}
	if err := json.Unmarshal(hydrate.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Messages) != 0 || payload.LastSeq == 0 {
		t.Fatalf("hydrate did not return reset snapshot: %s", hydrate.Data)
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
	args, _ := json.Marshal(map[string]string{"cwd": "/w/demo"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "sp", Op: rpc.OpSpawn, Args: args}); err != nil {
		t.Fatal(err)
	}
	spawn := readResponse(t, c, "sp")
	if spawn.Ok == nil || !*spawn.Ok {
		t.Fatalf("spawn failed: %+v", spawn)
	}
	var spawnPayload struct {
		Sid string `json:"sid"`
	}
	if err := json.Unmarshal(spawn.Data, &spawnPayload); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "hyd", Op: rpc.OpHydrate, Sid: spawnPayload.Sid}); err != nil {
		t.Fatal(err)
	}
	hydrate := readResponse(t, c, "hyd")
	if hydrate.Ok == nil || !*hydrate.Ok {
		t.Fatalf("hydrate failed: %+v", hydrate)
	}
	var payload struct {
		State rpc.State `json:"state"`
	}
	if err := json.Unmarshal(hydrate.Data, &payload); err != nil {
		t.Fatal(err)
	}
	state := payload.State
	if state.Model != "pi-4" || state.Thinking != "high" || state.InputTokens == nil || *state.InputTokens != 11 ||
		state.OutputTokens == nil || *state.OutputTokens != 22 || state.CacheReadTokens == nil || *state.CacheReadTokens != 33 ||
		state.CacheWriteTokens == nil || *state.CacheWriteTokens != 44 || state.ContextUsedTokens == nil || *state.ContextUsedTokens != 55 ||
		state.ContextWindowTokens == nil || *state.ContextWindowTokens != 66 || len(state.Skills) != 1 || state.Skills[0] != "review" {
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
	args, _ := json.Marshal(map[string]string{"cwd": "/w/demo"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "sp", Op: rpc.OpSpawn, Args: args}); err != nil {
		t.Fatal(err)
	}
	res := readResponse(t, c, "sp")
	if res.Ok == nil || *res.Ok || !strings.Contains(res.Error, "state unavailable") {
		t.Fatalf("bootstrap failure response = %+v", res)
	}
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
	args, _ := json.Marshal(map[string]string{"cwd": cwd, "sessionPath": sessionPath})
	for _, id := range []string{"first", "second"} {
		if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: id, Op: rpc.OpSpawn, Args: args}); err != nil {
			t.Fatal(err)
		}
		res := readResponse(t, c, id)
		if res.Ok == nil || !*res.Ok {
			t.Fatalf("%s spawn failed: %+v", id, res)
		}
	}
	if got := requestCount.Load(); got != 3 {
		t.Fatalf("reused lease issued %d startup requests, want 3 total", got)
	}
}

func TestControlSpawnIDReusesInstance(t *testing.T) {
	child := newControlFakeChild()
	var spawnCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		spawnCalls.Add(1)
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
	args := json.RawMessage(`{"cwd":"/w/spawn-id-control","spawnId":"browser-spawn-1"}`)
	var firstSid string
	for index, id := range []string{"spawn-one", "spawn-two"} {
		if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: id, Op: rpc.OpSpawn, Args: args}); err != nil {
			t.Fatal(err)
		}
		response := readResponse(t, c, id)
		if response.Ok == nil || !*response.Ok {
			t.Fatalf("spawn %d failed: %+v", index, response)
		}
		var payload struct {
			Sid string `json:"sid"`
		}
		if err := json.Unmarshal(response.Data, &payload); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			firstSid = payload.Sid
		} else if payload.Sid != firstSid {
			t.Fatalf("spawn ID returned a different sid: first=%q second=%q", firstSid, payload.Sid)
		}
	}
	if spawnCalls.Load() != 3 {
		t.Fatalf("spawn ID repeated bootstrap %d Pi commands, want 3", spawnCalls.Load())
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

	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "models", Op: rpc.OpGetAvailableModels, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	modelsResponse := readResponse(t, c, "models")
	if modelsResponse.Ok == nil || !*modelsResponse.Ok {
		t.Fatalf("model discovery failed: %+v", modelsResponse)
	}
	var models struct {
		Models []map[string]string `json:"models"`
	}
	if err := json.Unmarshal(modelsResponse.Data, &models); err != nil {
		t.Fatal(err)
	}
	if len(models.Models) != 2 || models.Models[0]["provider"] != "remote" || models.Models[0]["id"] != "remote-id" || models.Models[0]["name"] != "Remote model" {
		t.Fatalf("model list was not Pi-derived: %+v", models.Models)
	}
	if _, hasModelID := models.Models[0]["modelId"]; hasModelID {
		t.Fatal("model discovery exposed Phi modelId instead of Pi id")
	}

	invalidModelArgs := json.RawMessage(`{"provider":"remote","modelId":"missing"}`)
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "bad-model", Op: rpc.OpSetModel, Sid: sid, Args: invalidModelArgs}); err != nil {
		t.Fatal(err)
	}
	invalidModel := readResponse(t, c, "bad-model")
	if invalidModel.Ok == nil || *invalidModel.Ok || setModelCalls.Load() != 0 {
		t.Fatalf("invalid model was accepted or setter wrote: response=%+v calls=%d", invalidModel, setModelCalls.Load())
	}
	validModelArgs := json.RawMessage(`{"provider":"remote","modelId":"remote-id"}`)
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "set-model", Op: rpc.OpSetModel, Sid: sid, Args: validModelArgs}); err != nil {
		t.Fatal(err)
	}
	setModelResponse := readResponse(t, c, "set-model")
	if setModelResponse.Ok == nil || !*setModelResponse.Ok || setModelCalls.Load() != 1 {
		t.Fatalf("valid model setter failed: response=%+v calls=%d", setModelResponse, setModelCalls.Load())
	}
	var modelState struct {
		State rpc.State `json:"state"`
	}
	if err := json.Unmarshal(setModelResponse.Data, &modelState); err != nil {
		t.Fatal(err)
	}
	if modelState.State.Model != "selected-model" {
		t.Fatalf("setter did not return refreshed canonical state: %+v", modelState.State)
	}

	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "levels", Op: rpc.OpGetAvailableThinkingLevels, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	levelsResponse := readResponse(t, c, "levels")
	var levels struct {
		Levels []string `json:"levels"`
	}
	if levelsResponse.Ok == nil || !*levelsResponse.Ok || json.Unmarshal(levelsResponse.Data, &levels) != nil || strings.Join(levels.Levels, ",") != "off,low,high" {
		t.Fatalf("thinking discovery failed: %+v data=%s", levelsResponse, levelsResponse.Data)
	}
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "bad-thinking", Op: rpc.OpSetThinking, Sid: sid, Args: json.RawMessage(`{"level":"unsupported"}`)}); err != nil {
		t.Fatal(err)
	}
	badThinking := readResponse(t, c, "bad-thinking")
	if badThinking.Ok == nil || *badThinking.Ok || setThinkingCalls.Load() != 0 {
		t.Fatalf("invalid thinking level was accepted or setter wrote: %+v calls=%d", badThinking, setThinkingCalls.Load())
	}
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "set-thinking", Op: rpc.OpSetThinking, Sid: sid, Args: json.RawMessage(`{"level":"high"}`)}); err != nil {
		t.Fatal(err)
	}
	setThinkingResponse := readResponse(t, c, "set-thinking")
	if setThinkingResponse.Ok == nil || !*setThinkingResponse.Ok || setThinkingCalls.Load() != 1 {
		t.Fatalf("valid thinking setter failed: %+v calls=%d", setThinkingResponse, setThinkingCalls.Load())
	}
	var thinkingState struct {
		State rpc.State `json:"state"`
	}
	if err := json.Unmarshal(setThinkingResponse.Data, &thinkingState); err != nil {
		t.Fatal(err)
	}
	if thinkingState.State.Thinking != "high" {
		t.Fatalf("thinking setter did not return refreshed canonical state: %+v", thinkingState.State)
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
	response := server.dispatch(ctx, Envelope{
		Type: rpc.CallFrame, ID: "budget", Op: rpc.OpSetModel, Sid: inst.ID,
		Args: json.RawMessage(`{"provider":"p","modelId":"m"}`),
	})
	if response.Ok == nil || *response.Ok || !strings.Contains(response.Error, "timeout") {
		t.Fatalf("shared operation budget response = %+v", response)
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
	response := server.dispatch(ctx, Envelope{
		Type: rpc.CallFrame, ID: "gate", Op: rpc.OpGetAvailableModels, Sid: inst.ID,
		Args: json.RawMessage(`{}`),
	})
	if response.Ok == nil || *response.Ok || !strings.Contains(response.Error, "timeout") {
		t.Fatalf("held gate response = %+v", response)
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "busy-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "busy-reset")
	if response.Ok == nil || *response.Ok || newSessionCalls.Load() != 0 {
		t.Fatalf("busy reset wrote Pi new_session: response=%+v calls=%d", response, newSessionCalls.Load())
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "race-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-preflightStarted:
	case <-time.After(time.Second):
		t.Fatal("reset preflight did not start")
	}
	promptArgs := json.RawMessage(`{"message":"intervening prompt"}`)
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "intervening-prompt", Op: rpc.OpPrompt, Sid: sid, Args: promptArgs}); err != nil {
		t.Fatal(err)
	}
	promptResponse := readResponse(t, c, "intervening-prompt")
	if promptResponse.Ok == nil || !*promptResponse.Ok {
		t.Fatalf("intervening prompt was not accepted: %+v", promptResponse)
	}
	close(releasePreflight)
	resetResponse := readResponse(t, c, "race-reset")
	if resetResponse.Ok == nil || *resetResponse.Ok || newSessionCalls.Load() != 0 {
		t.Fatalf("generation race did not reject before Pi write: response=%+v calls=%d", resetResponse, newSessionCalls.Load())
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "cancel-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "cancel-reset")
	var payload struct {
		Cancelled bool `json:"cancelled"`
	}
	if response.Ok == nil || !*response.Ok || json.Unmarshal(response.Data, &payload) != nil || !payload.Cancelled {
		t.Fatalf("cancelled reset response = %+v data=%s", response, response.Data)
	}
	if inst.SessionPathCopy() != "/sessions/cancelled.jsonl" || len(inst.SnapshotCopy().Messages) != 1 {
		t.Fatalf("cancelled reset changed ownership/transcript: path=%q snapshot=%+v", inst.SessionPathCopy(), inst.SnapshotCopy())
	}
}

func TestControlSuccessfulResetClearsAndRefreshesNewSessionPath(t *testing.T) {
	child := newControlFakeChild()
	var stateCalls atomic.Int32
	var newSessionCalls atomic.Int32
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state":
			call := stateCalls.Add(1)
			path := "/sessions/old.jsonl"
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "success-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "success-reset")
	if response.Ok == nil || !*response.Ok || newSessionCalls.Load() != 1 {
		t.Fatalf("successful reset failed: %+v calls=%d", response, newSessionCalls.Load())
	}
	var payload struct {
		Reset bool      `json:"reset"`
		State rpc.State `json:"state"`
	}
	if err := json.Unmarshal(response.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Reset || payload.State.Model != "fresh-model" || len(inst.SnapshotCopy().Messages) != 0 || inst.SessionPathCopy() != "/sessions/new.jsonl" {
		t.Fatalf("reset did not clear/refresh canonical state: payload=%+v path=%q snapshot=%+v", payload, inst.SessionPathCopy(), inst.SnapshotCopy())
	}
	oldLease, err := mgr.BeginSpawn(context.Background(), rpc.SpawnOptions{Cwd: "/w/reset", SessionPath: "/sessions/old.jsonl"})
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "warning-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "warning-reset")
	var payload struct {
		Reset        bool   `json:"reset"`
		StateWarning string `json:"stateWarning"`
	}
	if response.Ok == nil || !*response.Ok || json.Unmarshal(response.Data, &payload) != nil || !payload.Reset || !strings.Contains(payload.StateWarning, "post-reset state unavailable") {
		t.Fatalf("post-refresh warning response = %+v data=%s", response, response.Data)
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
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "reject-reset", Op: rpc.OpNewSession, Sid: sid, Args: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	response := readResponse(t, c, "reject-reset")
	if response.Ok == nil || *response.Ok || !strings.Contains(response.Error, "Pi refused reset") {
		t.Fatalf("Pi rejection response = %+v", response)
	}
	if inst.SessionPathCopy() != "/sessions/reject.jsonl" || len(inst.SnapshotCopy().Messages) != 1 {
		t.Fatalf("pre-acceptance rejection changed state: path=%q snapshot=%+v", inst.SessionPathCopy(), inst.SnapshotCopy())
	}
}

func TestControlStubbedOps(t *testing.T) {
	c := helloDial(t, rpc.NewManager())
	res := call(t, c, "s1", "waitViewReady")
	var payload map[string]any
	_ = json.Unmarshal(res.Data, &payload)
	if payload["stubbed"] != true {
		t.Fatalf("want stubbed ack, got %s", res.Data)
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

	args, _ := json.Marshal(map[string]string{"name": "Audit auth module"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: sid, Args: args}); err != nil {
		t.Fatal(err)
	}
	res := readResponse(t, c, "snm")
	if res.Ok == nil || !*res.Ok {
		t.Fatalf("setSessionName failed: %+v", res)
	}
	var payload struct {
		State rpc.State `json:"state"`
	}
	if err := json.Unmarshal(res.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.State.Title != "Audit auth module" {
		t.Fatalf("state.title = %q, want %q", payload.State.Title, "Audit auth module")
	}

	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	if got := inst.TitleCopy(); got != "Audit auth module" {
		t.Fatalf("inst.TitleCopy = %q, want %q", got, "Audit auth module")
	}
	var listPayload []map[string]any
	listArgs, _ := json.Marshal(struct{}{})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "ls", Op: rpc.OpListSessions, Args: listArgs}); err != nil {
		t.Fatal(err)
	}
	list := readResponse(t, c, "ls")
	if list.Ok == nil || !*list.Ok {
		t.Fatalf("listSessions failed: %+v", list)
	}
	if err := json.Unmarshal(list.Data, &listPayload); err != nil {
		t.Fatal(err)
	}
	if len(listPayload) != 1 || listPayload[0]["title"] != "Audit auth module" {
		t.Fatalf("listSessions title = %+v, want %q", listPayload, "Audit auth module")
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

	args, _ := json.Marshal(map[string]string{"name": "Audit auth module"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: sid, Args: args}); err != nil {
		t.Fatal(err)
	}
	res := readResponse(t, c, "snm")
	if res.Ok == nil || *res.Ok {
		t.Fatalf("setSessionName should reject Pi failure: %+v", res)
	}
	if !strings.Contains(res.Error, "name not allowed") {
		t.Fatalf("error = %q, want it to contain %q", res.Error, "name not allowed")
	}
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
	args, _ := json.Marshal(map[string]string{"name": "Audit auth module"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: "does-not-exist", Args: args}); err != nil {
		t.Fatal(err)
	}
	res := readResponse(t, c, "snm")
	if res.Ok == nil || *res.Ok {
		t.Fatalf("setSessionName with unknown sid should reject: %+v", res)
	}
}

func TestControlSetSessionNameStrictDecode(t *testing.T) {
	mgr, _, _ := newControlRenameManager(t, "")
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/demo")

	// Empty name is rejected.
	empty, _ := json.Marshal(map[string]string{"name": "   "})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: sid, Args: empty}); err != nil {
		t.Fatal(err)
	}
	if res := readResponse(t, c, "snm"); res.Ok == nil || *res.Ok {
		t.Fatalf("empty name should reject: %+v", res)
	}

	// Unknown field rejected by decodeStrict.
	unknown, _ := json.Marshal(map[string]string{"name": "x", "title": "y"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: sid, Args: unknown}); err != nil {
		t.Fatal(err)
	}
	if res := readResponse(t, c, "snm"); res.Ok == nil || *res.Ok {
		t.Fatalf("unknown field should reject: %+v", res)
	}
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

	args, _ := json.Marshal(map[string]string{"name": "Audit auth module"})
	if err := c.WriteJSON(Envelope{Type: rpc.CallFrame, ID: "snm", Op: rpc.OpSetSessionName, Sid: sid, Args: args}); err != nil {
		t.Fatal(err)
	}
	if res := readResponse(t, c, "snm"); res.Ok == nil || !*res.Ok {
		t.Fatalf("setSessionName failed: %+v", res)
	}

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
	response := server.dispatch(context.Background(), Envelope{
		Type: rpc.CallFrame,
		ID:   "subagent-transcript",
		Op:   rpc.OpSubagentTranscript,
		Args: json.RawMessage(`{"runId":"run-transcript-test"}`),
	})
	if response.Ok == nil || !*response.Ok {
		t.Fatalf("subagent transcript failed: %+v", response)
	}
	var payload struct {
		RunID string `json:"runId"`
		Steps []struct {
			Messages []json.RawMessage `json:"messages"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(response.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.RunID != runID {
		t.Fatalf("runId = %q, want %q", payload.RunID, runID)
	}
	if len(payload.Steps) != 1 || len(payload.Steps[0].Messages) < 1 {
		t.Fatalf("transcript steps = %+v, want one step with messages", payload.Steps)
	}

	traversal := server.dispatch(context.Background(), Envelope{
		Type: rpc.CallFrame,
		ID:   "subagent-traversal",
		Op:   rpc.OpSubagentTranscript,
		Args: json.RawMessage(`{"runId":"../x"}`),
	})
	if traversal.Ok == nil || *traversal.Ok {
		t.Fatalf("traversal runId unexpectedly succeeded: %+v", traversal)
	}

	unknown := server.dispatch(context.Background(), Envelope{
		Type: rpc.CallFrame,
		ID:   "subagent-unknown",
		Op:   rpc.OpSubagentTranscript,
		Args: json.RawMessage(`{"runId":"missing-run"}`),
	})
	if unknown.Ok == nil || *unknown.Ok || !strings.Contains(unknown.Error, "subagent run not found") {
		t.Fatalf("unknown runId response: %+v", unknown)
	}
}
