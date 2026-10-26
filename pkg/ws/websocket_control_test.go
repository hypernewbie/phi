package ws

// M3 control-plane acceptance: every operation/no-op keeps its typed call
// and result variant, all 13 sequenced events keep their field fidelity,
// open-ended Pi data keeps its bounds and reserved keys, conversion
// failures surface instead of degrading, and ordering/fence/cleanup
// behavior is unchanged.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// newFullControlManager returns a manager over one fake Pi child that
// answers every command the 15 control operations need. Repeated commands
// are reported on the returned channel so tests can prove what reached Pi.
func newFullControlManager(t *testing.T) (*rpc.Manager, *controlFakeChild, chan string) {
	t.Helper()
	child := newControlFakeChild()
	commands := make(chan string, 64)
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		kind, _ := command["type"].(string)
		commands <- kind
		switch kind {
		case "get_state":
			return map[string]any{
				"model":               map[string]any{"name": "fake-model"},
				"thinkingLevel":       "high",
				"isStreaming":         false,
				"isCompacting":        false,
				"pendingMessageCount": 0,
			}, true, ""
		case "get_session_stats":
			return map[string]any{
				"tokens": map[string]any{"input": 11, "output": 22, "cacheRead": 5, "cacheWrite": 6},
				"contextUsage": map[string]any{
					"tokens": 3, "contextWindow": 4,
				},
			}, true, ""
		case "get_commands":
			return map[string]any{"commands": []map[string]any{}}, true, ""
		case "get_available_models":
			return map[string]any{"models": []map[string]any{
				{"provider": "remote", "id": "remote-id", "name": "Remote model"},
			}}, true, ""
		case "get_available_thinking_levels":
			return map[string]any{"levels": []string{"off", "low", "high"}}, true, ""
		case "set_session_name":
			name, _ := command["name"].(string)
			if err := emitNativeSessionInfoChanged(child, name); err != nil {
				return nil, false, err.Error()
			}
			return map[string]any{}, true, ""
		case "set_model", "set_thinking_level", "compact", "abort":
			return map[string]any{}, true, ""
		case "new_session":
			return map[string]any{"cancelled": false}, true, ""
		case "prompt":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	return mgr, child, commands
}

// resultMatchesCall reports whether the response carries the result variant
// that belongs to this call.
func resultMatchesCall(call *wspb.ControlCall, res *wspb.ControlResponse) bool {
	switch call.GetCall().(type) {
	case *wspb.ControlCall_Spawn:
		return res.GetSpawn() != nil
	case *wspb.ControlCall_ListSessions:
		return res.GetListSessions() != nil
	case *wspb.ControlCall_GetState:
		return res.GetGetState() != nil
	case *wspb.ControlCall_Hydrate:
		return res.GetHydrate() != nil
	case *wspb.ControlCall_GetMessages:
		return res.GetGetMessages() != nil
	case *wspb.ControlCall_Prompt:
		return res.GetPrompt() != nil
	case *wspb.ControlCall_GetAvailableModels:
		return res.GetGetAvailableModels() != nil
	case *wspb.ControlCall_SetModel:
		return res.GetSetModel() != nil
	case *wspb.ControlCall_GetAvailableThinkingLevels:
		return res.GetGetAvailableThinkingLevels() != nil
	case *wspb.ControlCall_SetThinking:
		return res.GetSetThinking() != nil
	case *wspb.ControlCall_NewSession:
		return res.GetNewSession() != nil
	case *wspb.ControlCall_Abort:
		return res.GetAbort() != nil
	case *wspb.ControlCall_Compact:
		return res.GetCompact() != nil
	case *wspb.ControlCall_SetSessionName:
		return res.GetSetSessionName() != nil
	case *wspb.ControlCall_SubagentTranscript:
		return res.GetSubagentTranscript() != nil
	case *wspb.ControlCall_ViewReady:
		return res.GetViewReady() != nil
	case *wspb.ControlCall_SetCapabilities:
		return res.GetSetCapabilities() != nil
	case *wspb.ControlCall_WaitViewReady:
		return res.GetWaitViewReady() != nil
	case *wspb.ControlCall_Dlg:
		return res.GetDlg() != nil
	case *wspb.ControlCall_DlgClosed:
		return res.GetDlgClosed() != nil
	case *wspb.ControlCall_ActivateTab:
		return res.GetActivateTab() != nil
	}
	return false
}

func readCloseCode(t *testing.T, c *websocket.Conn) int {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, _, err := c.ReadMessage()
		if err == nil {
			continue
		}
		var closeErr *websocket.CloseError
		if errors.As(err, &closeErr) {
			return closeErr.Code
		}
		t.Fatalf("read error = %v, want a close frame", err)
	}
}

// TestWebSocketProtobufControlOperations covers all 15 operations and the
// six accepted no-ops over one live connection: each call carries its typed
// arguments, each response carries the matching result variant, and an
// invalid call comes back as a correlated error.
func TestWebSocketProtobufControlOperations(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	mgr, _, _ := newFullControlManager(t)
	c := helloDial(t, mgr)

	// spawn is the first operation: it creates the session every later
	// call scopes to.
	var sid string
	t.Run("spawn", func(t *testing.T) {
		spawnCall := &wspb.ControlCall{Id: "op-spawn", Call: &wspb.ControlCall_Spawn{
			Spawn: &wspb.SpawnCall{Cwd: proto.String("/w/operations")}}}
		spawnResponse := mustCall(t, c, spawnCall)
		if !resultMatchesCall(spawnCall, spawnResponse) {
			t.Fatalf("spawn result variant does not match its call: %+v", spawnResponse)
		}
		sid = spawnedSid(t, spawnResponse)
	})
	inst, err := mgr.Lookup(sid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { inst.Kill() })

	runID := setupSubagentFixture(t)

	inst.Emit(rpc.EvtMessageEnd, &rpc.Message{
		Role:    "assistant",
		Content: json.RawMessage(`"hydrate-seed"`),
	}, nil)

	cases := []struct {
		name string
		call *wspb.ControlCall
		want func(*testing.T, *wspb.ControlResponse)
	}{
		{"listSessions", &wspb.ControlCall{Id: "op-listSessions", Call: &wspb.ControlCall_ListSessions{
			ListSessions: &wspb.ListSessionsCall{}}}, func(t *testing.T, res *wspb.ControlResponse) {
			sessions := res.GetListSessions().GetSessions()
			if len(sessions) != 1 || sessions[0].GetSid() != sid || sessions[0].GetCwd() != "/w/operations" {
				t.Fatalf("session list = %+v", sessions)
			}
		}},
		{"getState", &wspb.ControlCall{Id: "op-getState", Call: &wspb.ControlCall_GetState{
			GetState: &wspb.GetStateCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			state := res.GetGetState().GetState()
			if state.GetModel() != "fake-model" || state.GetThinking() != "high" || state.GetInputTokens() != 11 {
				t.Fatalf("state = %+v", state)
			}
		}},
		{"hydrate", &wspb.ControlCall{Id: "op-hydrate", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			snapshot := res.GetHydrate().GetSession()
			if snapshot == nil || len(snapshot.GetMessages()) != 1 {
				t.Fatalf("hydrate snapshot = %+v", snapshot)
			}
			if got := snapshot.GetMessages()[0].GetContent().GetStringValue(); got != "hydrate-seed" {
				t.Fatalf("hydrate content = %q", got)
			}
			if snapshot.GetState().GetModel() != "fake-model" {
				t.Fatalf("hydrate state = %+v", snapshot.GetState())
			}
		}},
		{"getMessages", &wspb.ControlCall{Id: "op-getMessages", Call: &wspb.ControlCall_GetMessages{
			GetMessages: &wspb.GetMessagesCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			messages := res.GetGetMessages().GetSession().GetMessages()
			if len(messages) != 1 || messages[0].GetRole() != "assistant" {
				t.Fatalf("messages = %+v", messages)
			}
		}},
		{"prompt", &wspb.ControlCall{Id: "op-prompt", Call: &wspb.ControlCall_Prompt{
			Prompt: &wspb.PromptCall{Sid: sid, Message: "hello"}}}, func(t *testing.T, res *wspb.ControlResponse) {
			if !res.GetPrompt().GetAccepted() {
				t.Fatalf("prompt was not accepted: %+v", res.GetPrompt())
			}
		}},
		{"getAvailableModels", &wspb.ControlCall{Id: "op-getAvailableModels", Call: &wspb.ControlCall_GetAvailableModels{
			GetAvailableModels: &wspb.GetAvailableModelsCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			models := res.GetGetAvailableModels().GetModels()
			if len(models) != 1 || models[0].GetProvider() != "remote" || models[0].GetId() != "remote-id" || models[0].GetName() != "Remote model" {
				t.Fatalf("models = %+v", models)
			}
		}},
		{"setModel", &wspb.ControlCall{Id: "op-setModel", Call: &wspb.ControlCall_SetModel{
			SetModel: &wspb.SetModelCall{Sid: sid, Provider: "remote", ModelId: "remote-id"}}}, func(t *testing.T, res *wspb.ControlResponse) {
			if got := res.GetSetModel().GetState().GetModel(); got != "fake-model" {
				t.Fatalf("setModel state model = %q", got)
			}
		}},
		{"getAvailableThinkingLevels", &wspb.ControlCall{Id: "op-getAvailableThinkingLevels", Call: &wspb.ControlCall_GetAvailableThinkingLevels{
			GetAvailableThinkingLevels: &wspb.GetAvailableThinkingLevelsCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			levels := res.GetGetAvailableThinkingLevels().GetLevels()
			if strings.Join(levels, ",") != "off,low,high" {
				t.Fatalf("thinking levels = %v", levels)
			}
		}},
		{"setThinking", &wspb.ControlCall{Id: "op-setThinking", Call: &wspb.ControlCall_SetThinking{
			SetThinking: &wspb.SetThinkingCall{Sid: sid, Level: "high"}}}, func(t *testing.T, res *wspb.ControlResponse) {
			if got := res.GetSetThinking().GetState().GetThinking(); got != "high" {
				t.Fatalf("setThinking state = %q", got)
			}
		}},
		{"newSession", &wspb.ControlCall{Id: "op-newSession", Call: &wspb.ControlCall_NewSession{
			NewSession: &wspb.NewSessionCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			result := res.GetNewSession()
			if result.GetCancelled() || !result.GetReset_() || result.GetStateWarning() != "" {
				t.Fatalf("newSession result = %+v", result)
			}
			if result.GetState().GetModel() != "fake-model" {
				t.Fatalf("newSession state = %+v", result.GetState())
			}
		}},
		{"abort", &wspb.ControlCall{Id: "op-abort", Call: &wspb.ControlCall_Abort{
			Abort: &wspb.AbortCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			if !res.GetAbort().GetAborted() {
				t.Fatalf("abort result = %+v", res.GetAbort())
			}
		}},
		{"compact", &wspb.ControlCall{Id: "op-compact", Call: &wspb.ControlCall_Compact{
			Compact: &wspb.CompactCall{Sid: sid}}}, func(t *testing.T, res *wspb.ControlResponse) {
			if res.GetCompact().GetStateWarning() != "" {
				t.Fatalf("compact warning = %q", res.GetCompact().GetStateWarning())
			}
			if res.GetCompact().GetState() != nil && res.GetCompact().GetState().GetModel() != "fake-model" {
				t.Fatalf("compact state = %+v", res.GetCompact().GetState())
			}
		}},
		{"setSessionName", &wspb.ControlCall{Id: "op-setSessionName", Call: &wspb.ControlCall_SetSessionName{
			SetSessionName: &wspb.SetSessionNameCall{Sid: sid, Name: "renamed"}}}, func(t *testing.T, res *wspb.ControlResponse) {
			state := res.GetSetSessionName().GetState()
			if state.GetTitle() != "renamed" || state.GetSid() != sid {
				t.Fatalf("setSessionName state = %+v", state)
			}
		}},
		{"subagentTranscript", &wspb.ControlCall{Id: "op-subagentTranscript", Call: &wspb.ControlCall_SubagentTranscript{
			SubagentTranscript: &wspb.SubagentTranscriptCall{RunId: runID}}}, func(t *testing.T, res *wspb.ControlResponse) {
			transcript := res.GetSubagentTranscript()
			if transcript.GetRunId() != runID || len(transcript.GetSteps()) != 1 || len(transcript.GetSteps()[0].GetMessages()) == 0 {
				t.Fatalf("subagent transcript = %+v", transcript)
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := mustCall(t, c, tc.call)
			if !resultMatchesCall(tc.call, response) {
				t.Fatalf("%s result variant does not match its call: %+v", tc.name, response)
			}
			tc.want(t, response)
		})
	}

	noOps := []struct {
		name string
		call *wspb.ControlCall
	}{
		{"viewReady", &wspb.ControlCall{Id: "noop-viewReady", Call: &wspb.ControlCall_ViewReady{
			ViewReady: &wspb.ViewReadyCall{Sid: proto.String(sid)}}}},
		{"setCapabilities", &wspb.ControlCall{Id: "noop-setCapabilities", Call: &wspb.ControlCall_SetCapabilities{
			SetCapabilities: &wspb.SetCapabilitiesCall{Sid: proto.String(sid)}}}},
		{"waitViewReady", &wspb.ControlCall{Id: "noop-waitViewReady", Call: &wspb.ControlCall_WaitViewReady{
			WaitViewReady: &wspb.WaitViewReadyCall{Sid: proto.String(sid)}}}},
		{"dlg", &wspb.ControlCall{Id: "noop-dlg", Call: &wspb.ControlCall_Dlg{
			Dlg: &wspb.DlgCall{Sid: proto.String(sid)}}}},
		{"dlgClosed", &wspb.ControlCall{Id: "noop-dlgClosed", Call: &wspb.ControlCall_DlgClosed{
			DlgClosed: &wspb.DlgClosedCall{Sid: proto.String(sid)}}}},
		{"activateTab", &wspb.ControlCall{Id: "noop-activateTab", Call: &wspb.ControlCall_ActivateTab{
			ActivateTab: &wspb.ActivateTabCall{Sid: proto.String(sid)}}}},
	}
	for _, tc := range noOps {
		t.Run(tc.name, func(t *testing.T) {
			response := mustCall(t, c, tc.call)
			if !resultMatchesCall(tc.call, response) {
				t.Fatalf("%s no-op result variant does not match: %+v", tc.name, response)
			}
		})
	}

	// A decodable call with a valid id but invalid arguments answers with a
	// correlated error and never reaches Pi.
	t.Run("correlated_error_keeps_id", func(t *testing.T) {
		call := &wspb.ControlCall{Id: "op-setModel-invalid", Call: &wspb.ControlCall_SetModel{
			SetModel: &wspb.SetModelCall{Sid: sid}}}
		response := expectError(t, c, call, "provider and modelId are required")
		if response.GetId() != call.GetId() {
			t.Fatalf("error id = %q, want %q", response.GetId(), call.GetId())
		}
	})
}

// TestWebSocketProtobufControlEvents covers all 13 sequenced event variants,
// the full/error-only state split, transcript fidelity, nullable counters,
// and optional flags.
func TestWebSocketProtobufControlEvents(t *testing.T) {
	cases := []struct {
		name string
		data any
		msg  *rpc.Message
		want func(*testing.T, *wspb.ControlEvent)
	}{
		{"stateChanged_full", rpc.State{
			Sid: "sid", Title: "t", Cwd: "/c", Model: "m", Thinking: "high",
			InputTokens: int64Ptr(1), OutputTokens: int64Ptr(0),
			Skills: []string{"s"}, Busy: true, Status: "live", QueueDepth: 2,
			SessionPath: "/p.jsonl",
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			state := ev.GetStateChanged().GetState()
			if state == nil || state.GetModel() != "m" || !state.GetBusy() || state.GetQueueDepth() != 2 {
				t.Fatalf("full state = %+v", state)
			}
			if state.GetInputTokens() != 1 || state.GetOutputTokens() != 0 {
				t.Fatalf("token counters = %v/%v, want 1/0", state.GetInputTokens(), state.GetOutputTokens())
			}
			if !state.ProtoReflect().Has(state.ProtoReflect().Descriptor().Fields().ByName("output_tokens")) {
				t.Fatal("zero counter must stay present")
			}
		}},
		{"stateChanged_error_only", map[string]any{"error": "stale"}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			if got := ev.GetStateChanged().GetError().GetReason(); got != "stale" {
				t.Fatalf("error-only update = %q", got)
			}
			if ev.GetStateChanged().GetState() != nil {
				t.Fatal("error-only update must not carry a state")
			}
		}},
		{"messageStart", map[string]any{"message": map[string]any{
			"role": "assistant", "content": []any{},
		}}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			start := ev.GetMessageStart()
			if start.GetRole() != "assistant" || start.GetMessage() == nil {
				t.Fatalf("messageStart = %+v", start)
			}
		}},
		{"messageUpdate", map[string]any{"assistantMessageEvent": map[string]any{
			"type": "text_delta", "contentIndex": json.Number("0"), "delta": "hi",
		}}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			update := ev.GetMessageUpdate()
			if update.GetType() != "text_delta" || update.GetDelta() != "hi" || update.GetContentIndex() != 0 {
				t.Fatalf("messageUpdate = %+v", update)
			}
		}},
		{"messageEnd", map[string]any{"message": map[string]any{
			"role": "toolResult", "content": "done", "details": map[string]any{"exit": json.Number("0")},
			"toolCallId": "call-1", "toolName": "bash", "isError": false,
			"stopReason": "toolUse", "errorMessage": "",
		}}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			end := ev.GetMessageEnd().GetMessage()
			if end.GetRole() != "toolResult" || end.GetToolName() != "bash" {
				t.Fatalf("messageEnd = %+v", end)
			}
			if end.IsError == nil || end.GetIsError() {
				t.Fatalf("isError must stay present and false: %+v", end.IsError)
			}
			if end.GetStopReason() != "toolUse" {
				t.Fatalf("stopReason = %q", end.GetStopReason())
			}
			if end.ErrorMessage != nil {
				t.Fatalf("empty errorMessage must stay absent: %q", end.GetErrorMessage())
			}
		}},
		{"transcriptReset", nil, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			if _, ok := ev.GetEvent().(*wspb.ControlEvent_TranscriptReset); !ok {
				t.Fatalf("transcriptReset variant = %T", ev.GetEvent())
			}
		}},
		{"rpcExited", map[string]any{"reason": "exited"}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			if got := ev.GetRpcExited().GetReason(); got != "exited" {
				t.Fatalf("rpcExited reason = %q", got)
			}
		}},
		{"subagentFleet", map[string]any{"runs": []any{map[string]any{"id": "r1"}}}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			if ev.GetSubagentFleet().GetFleet() == nil {
				t.Fatal("fleet payload missing")
			}
		}},
		{"autoRetryStart", map[string]any{
			"attempt": json.Number("1"), "maxAttempts": json.Number("3"),
			"delayMs": json.Number("500"), "errorMessage": "rate limited",
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			start := ev.GetAutoRetryStart()
			if start.GetAttempt() != 1 || start.GetMaxAttempts() != 3 || start.GetDelayMs() != 500 {
				t.Fatalf("autoRetryStart = %+v", start)
			}
			if start.GetErrorMessage() != "rate limited" {
				t.Fatalf("errorMessage = %q", start.GetErrorMessage())
			}
		}},
		{"autoRetryEnd", map[string]any{
			"success": false, "attempt": json.Number("2"), "finalError": "nope",
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			end := ev.GetAutoRetryEnd()
			if end.GetSuccess() || end.GetAttempt() != 2 || end.GetFinalError() != "nope" {
				t.Fatalf("autoRetryEnd = %+v", end)
			}
			if end.Success == nil {
				t.Fatal("success=false must stay present")
			}
		}},
		{"summarizationRetryScheduled", map[string]any{
			"attempt": json.Number("1"), "maxAttempts": json.Number("2"),
			"delayMs": json.Number("1000"), "errorMessage": "busy",
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			scheduled := ev.GetSummarizationRetryScheduled()
			if scheduled.GetAttempt() != 1 || scheduled.GetMaxAttempts() != 2 || scheduled.GetDelayMs() != 1000 {
				t.Fatalf("summarizationRetryScheduled = %+v", scheduled)
			}
		}},
		{"summarizationRetryFinished", map[string]any{
			"success": true, "attempt": json.Number("1"),
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			finished := ev.GetSummarizationRetryFinished()
			if !finished.GetSuccess() || finished.GetAttempt() != 1 {
				t.Fatalf("summarizationRetryFinished = %+v", finished)
			}
		}},
		{"compactionEnd", map[string]any{
			"aborted": false, "reason": "manual", "errorMessage": "partial",
			"result": map[string]any{"summary": "s"},
		}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			end := ev.GetCompactionEnd()
			if end.GetReason() != "manual" || end.GetErrorMessage() != "partial" {
				t.Fatalf("compactionEnd = %+v", end)
			}
			if end.Aborted == nil || end.GetAborted() {
				t.Fatal("aborted=false must stay present")
			}
			if end.GetResult() == nil {
				t.Fatal("compaction result payload missing")
			}
		}},
		{"extensionError", map[string]any{"error": "kaput"}, nil, func(t *testing.T, ev *wspb.ControlEvent) {
			if got := ev.GetExtensionError().GetError(); got != "kaput" {
				t.Fatalf("extensionError = %q", got)
			}
		}},
	}

	for i, tc := range cases {
		name := tc.name
		t.Run(name, func(t *testing.T) {
			wire, err := eventToWire(rpc.Event{
				Type: "evt", Evt: evtForCase(name), Sid: "sid", Seq: uint64(i + 1), Data: tc.data,
			})
			if err != nil {
				t.Fatalf("eventToWire(%s) error = %v", name, err)
			}
			raw, err := proto.Marshal(wire)
			if err != nil {
				t.Fatal(err)
			}
			decoded := &wspb.ControlEvent{}
			if err := proto.Unmarshal(raw, decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.GetSid() != "sid" || decoded.GetSeq() != uint64(i+1) {
				t.Fatalf("event header = %q/%d", decoded.GetSid(), decoded.GetSeq())
			}
			if decoded.GetEvent() == nil {
				t.Fatal("event variant missing")
			}
			tc.want(t, decoded)
		})
	}

	// Transcript fidelity: the converted message still carries the source
	// values, both before and after a generated encode/decode round trip.
	t.Run("transcript_fidelity", func(t *testing.T) {
		wire, err := messageToWire(rpc.Message{
			Role:       "toolResult",
			Content:    json.RawMessage(`{"text":"done","nested":{"k":[1,2,{"deep":true}]},"__proto__":"kept"}`),
			Details:    json.RawMessage(`{"exit":0,"empty":{}}`),
			ToolCallId: "call-1",
			ToolName:   "bash",
			IsError:    boolPtr(false),
			Ts:         7,
			StopReason: "toolUse",
		})
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]any{
			"__proto__": "kept",
			"nested":    map[string]any{"k": []any{json.Number("1"), json.Number("2"), map[string]any{"deep": true}}},
			"text":      "done",
		}
		if got := externalToAny(t, wire.GetContent()); !reflect.DeepEqual(got, want) {
			t.Fatalf("content conversion changed the source: %#v", got)
		}
		if got := externalToAny(t, wire.GetDetails()); !reflect.DeepEqual(got, map[string]any{"exit": json.Number("0"), "empty": map[string]any{}}) {
			t.Fatalf("details conversion changed the source: %#v", got)
		}
		if wire.GetRole() != "toolResult" || wire.GetToolCallId() != "call-1" || wire.GetToolName() != "bash" {
			t.Fatalf("pairing metadata = %+v", wire)
		}
		if wire.IsError == nil || wire.GetIsError() || wire.GetStopReason() != "toolUse" || wire.GetTs() != 7 {
			t.Fatalf("optional fields = %+v", wire)
		}
		raw, err := proto.Marshal(wire)
		if err != nil {
			t.Fatal(err)
		}
		decoded := &wspb.Message{}
		if err := proto.Unmarshal(raw, decoded); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(wire, decoded) {
			t.Fatalf("message round trip lost data: %+v vs %+v", wire, decoded)
		}
	})

	// The live message_end payload is raw JSON in production. Content and
	// details must keep their source bytes so duplicate keys are rejected and
	// values are not silently rewritten.
	t.Run("message_end_raw_json", func(t *testing.T) {
		if _, err := messageEndToWire(map[string]any{
			"message": json.RawMessage(`{"role":"assistant","content":{"a":1,"a":2}}`),
		}); err == nil {
			t.Fatal("duplicate keys in raw content must be rejected")
		}
		if _, err := messageEndToWire(map[string]any{
			"message": json.RawMessage(`{"role":"assistant","content":"x","content":"y"}`),
		}); err == nil {
			t.Fatal("duplicate top-level keys must be rejected")
		}
		event, err := messageEndToWire(map[string]any{
			"message": json.RawMessage(`{"role":"toolResult","content":{"nested":{"k":[1,{"deep":true}]}},"details":null,"toolCallId":"call-9","isError":false}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		message := event.GetMessage()
		if message.GetRole() != "toolResult" || message.GetToolCallId() != "call-9" {
			t.Fatalf("message = %+v", message)
		}
		if message.IsError == nil || message.GetIsError() {
			t.Fatal("isError=false must stay present")
		}
		if message.GetDetails().GetNullValue() == nil {
			t.Fatal("explicit null details must stay an ExternalNull")
		}
		content := externalToAny(t, message.GetContent()).(map[string]any)
		nested := content["nested"].(map[string]any)["k"].([]any)
		if len(nested) != 2 || nested[0] != json.Number("1") {
			t.Fatalf("content = %#v", content)
		}
	})

	t.Run("raw_external_event_values", func(t *testing.T) {
		start, err := eventToWire(rpc.Event{
			Evt:  rpc.EvtMessageStart,
			Data: json.RawMessage(`{"type":"message_start","message":{"role":"assistant","content":{"text":"started"}}}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		message := start.GetMessageStart()
		if message.GetRole() != "assistant" || externalToAny(t, message.GetMessage()).(map[string]any)["content"].(map[string]any)["text"] != "started" {
			t.Fatalf("messageStart = %+v", message)
		}

		compaction, err := eventToWire(rpc.Event{
			Evt:  rpc.EvtCompactionEnd,
			Data: json.RawMessage(`{"type":"compaction_end","aborted":false,"result":{"summary":"complete"}}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		if compaction.GetCompactionEnd().Aborted == nil || compaction.GetCompactionEnd().GetAborted() {
			t.Fatalf("aborted=false was lost: %+v", compaction.GetCompactionEnd())
		}
		if got := externalToAny(t, compaction.GetCompactionEnd().GetResult()).(map[string]any)["summary"]; got != "complete" {
			t.Fatalf("compaction result = %#v", got)
		}
	})

	t.Run("raw_external_events_reject_duplicate_keys", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			evt  string
			data json.RawMessage
		}{
			{
				name: "message_start",
				evt:  rpc.EvtMessageStart,
				data: json.RawMessage(`{"type":"message_start","message":{"role":"assistant","content":{"x":1,"x":2}}}`),
			},
			{
				name: "compaction_end",
				evt:  rpc.EvtCompactionEnd,
				data: json.RawMessage(`{"type":"compaction_end","result":{"x":1,"x":2}}`),
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				if _, err := eventToWire(rpc.Event{Evt: tc.evt, Data: tc.data}); err == nil {
					t.Fatal("duplicate external keys must be rejected")
				}
			})
		}
	})

	// Live events carry the same presence rules as the stored snapshot: an
	// omitted details key stays absent, an explicit null stays a null.
	t.Run("message_details_presence", func(t *testing.T) {
		live, err := messageEndToWire(map[string]any{"message": map[string]any{
			"role": "assistant", "content": "done",
		}})
		if err != nil {
			t.Fatal(err)
		}
		if live.GetMessage().Details != nil {
			t.Fatalf("omitted details must stay absent: %+v", live.GetMessage().Details)
		}
		if got := live.GetMessage().GetContent().GetStringValue(); got != "done" {
			t.Fatalf("content = %q", got)
		}

		explicit, err := messageEndToWire(map[string]any{"message": map[string]any{
			"role": "assistant", "content": "done", "details": nil,
		}})
		if err != nil {
			t.Fatal(err)
		}
		if explicit.GetMessage().GetDetails().GetNullValue() == nil {
			t.Fatal("explicit null details must stay an ExternalNull")
		}

		// The snapshot path reads stored raw JSON, where an empty value means
		// absence.
		snapshot, err := messageToWire(rpc.Message{Role: "assistant", Content: json.RawMessage(`"done"`)})
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.Details != nil {
			t.Fatalf("empty stored details must stay absent: %+v", snapshot.Details)
		}
		if !proto.Equal(snapshot, live.GetMessage()) {
			t.Fatalf("live message differs from the snapshot message: %+v vs %+v", live.GetMessage(), snapshot)
		}
	})

	// Nullable counters and optional flags: absent stays absent, zero stays
	// present, and an empty session path cannot erase a published path.
	t.Run("nullable_counters", func(t *testing.T) {
		empty := stateToWire(rpc.State{Sid: "s"})
		if empty.InputTokens != nil || empty.OutputTokens != nil || empty.SessionPath != nil {
			t.Fatalf("absent counters/path must stay absent: %+v", empty)
		}
		zero := stateToWire(rpc.State{Sid: "s", InputTokens: int64Ptr(0)})
		if zero.InputTokens == nil || zero.GetInputTokens() != 0 {
			t.Fatalf("zero counter must stay present: %+v", zero.InputTokens)
		}
		withPath := stateToWire(rpc.State{Sid: "s", SessionPath: "/p.jsonl"})
		if withPath.GetSessionPath() != "/p.jsonl" {
			t.Fatalf("session path = %q", withPath.GetSessionPath())
		}
		bare, err := messageToWire(rpc.Message{Role: "assistant"})
		if err != nil {
			t.Fatal(err)
		}
		if bare.StopReason != nil || bare.ErrorMessage != nil || bare.ToolCallId != nil || bare.ToolName != nil {
			t.Fatalf("empty optional strings must stay absent: %+v", bare)
		}
		present, err := messageToWire(rpc.Message{
			Role: "assistant", StopReason: "aborted", ErrorMessage: "boom", ToolName: "bash",
		})
		if err != nil {
			t.Fatal(err)
		}
		if present.GetStopReason() != "aborted" || present.GetErrorMessage() != "boom" || present.GetToolName() != "bash" {
			t.Fatalf("present optional strings were dropped: %+v", present)
		}
	})
}

func evtForCase(name string) string {
	switch name {
	case "stateChanged_full", "stateChanged_error_only":
		return rpc.EvtStateChanged
	case "messageStart":
		return rpc.EvtMessageStart
	case "messageUpdate":
		return rpc.EvtMessageUpdate
	case "messageEnd":
		return rpc.EvtMessageEnd
	case "transcriptReset":
		return rpc.EvtTranscriptReset
	case "rpcExited":
		return rpc.EvtRpcExited
	case "subagentFleet":
		return rpc.EvtSubagentFleet
	case "autoRetryStart":
		return rpc.EvtAutoRetryStart
	case "autoRetryEnd":
		return rpc.EvtAutoRetryEnd
	case "summarizationRetryScheduled":
		return rpc.EvtSummarizationRetryScheduled
	case "summarizationRetryFinished":
		return rpc.EvtSummarizationRetryFinished
	case "compactionEnd":
		return rpc.EvtCompactionEnd
	case "extensionError":
		return rpc.EvtExtensionError
	}
	return name
}

// externalToAny rebuilds Go values from an ExternalValue so a test can
// compare the conversion against its source instead of against itself.
func externalToAny(t *testing.T, value *wspb.ExternalValue) any {
	t.Helper()
	if value == nil {
		return nil
	}
	switch kind := value.GetKind().(type) {
	case *wspb.ExternalValue_NullValue:
		return nil
	case *wspb.ExternalValue_BoolValue:
		return kind.BoolValue
	case *wspb.ExternalValue_StringValue:
		return kind.StringValue
	case *wspb.ExternalValue_IntValue:
		return json.Number(strconv.FormatInt(kind.IntValue, 10))
	case *wspb.ExternalValue_NumberValue:
		return kind.NumberValue
	case *wspb.ExternalValue_ObjectValue:
		object := map[string]any{}
		for _, entry := range kind.ObjectValue.GetEntries() {
			object[entry.GetKey()] = externalToAny(t, entry.GetValue())
		}
		return object
	case *wspb.ExternalValue_ListValue:
		list := make([]any, 0, len(kind.ListValue.GetValues()))
		for _, item := range kind.ListValue.GetValues() {
			list = append(list, externalToAny(t, item))
		}
		return list
	}
	t.Fatalf("unknown external value variant %T", value.GetKind())
	return nil
}

func int64Ptr(value int64) *int64 { return &value }
func boolPtr(value bool) *bool    { return &value }

func mustExternal(t *testing.T, value any) *wspb.ExternalValue {
	t.Helper()
	converted, err := externalFromAny(value)
	if err != nil {
		t.Fatalf("externalFromAny(%v) error = %v", value, err)
	}
	return converted
}

// setupSubagentFixture writes one async-subagent status file whose run
// resolves to a fork session, returning the run id.
func setupSubagentFixture(t *testing.T) string {
	t.Helper()
	// Fork transcripts must sit under the Pi sessions root, so this fixture
	// owns HOME for the test.
	t.Setenv("HOME", t.TempDir())
	cwd := t.TempDir()
	forkPath := filepath.Join(os.Getenv("HOME"), ".pi", "agent", "sessions", "fixture-project", "run-0", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(forkPath), 0755); err != nil {
		t.Fatal(err)
	}
	records := strings.Join([]string{
		piControlHeader("fork-id", cwd),
		`{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"fork hello"}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(forkPath, []byte(records), 0644); err != nil {
		t.Fatal(err)
	}
	runID := "run-m3-" + strings.ReplaceAll(filepath.Base(t.TempDir()), "-", "")
	statusPath := filepath.Join(os.TempDir(), "pi-subagents-m3", "async-subagent-runs", runID, "status.json")
	if err := os.MkdirAll(filepath.Dir(statusPath), 0755); err != nil {
		t.Fatal(err)
	}
	status, err := json.Marshal(map[string]any{
		"runId": runID,
		"cwd":   cwd,
		"steps": []map[string]string{{"label": "First step", "sessionFile": forkPath}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statusPath, status, 0644); err != nil {
		t.Fatal(err)
	}
	return runID
}

// TestWebSocketProtobufExternalValues covers the reserved-key
// representation, duplicate keys, presence, depth/node boundaries, and
// finite numbers for open-ended Pi data.
func TestWebSocketProtobufExternalValues(t *testing.T) {
	t.Run("reserved_keys", func(t *testing.T) {
		value, err := externalFromAny(map[string]any{
			"__proto__":   "kept",
			"constructor": "also-kept",
			"plain":       true,
		})
		if err != nil {
			t.Fatal(err)
		}
		entries := value.GetObjectValue().GetEntries()
		if len(entries) != 3 {
			t.Fatalf("entries = %d, want 3", len(entries))
		}
		// Object keys are sorted, so __proto__ sorts first.
		if entries[0].GetKey() != "__proto__" || entries[0].GetValue().GetStringValue() != "kept" {
			t.Fatalf("reserved key lost: %+v", entries[0])
		}
		raw, err := proto.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		decoded := &wspb.ExternalValue{}
		if err := proto.Unmarshal(raw, decoded); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(value, decoded) {
			t.Fatal("reserved keys did not survive the wire round trip")
		}
	})

	t.Run("raw_json_duplicate_keys", func(t *testing.T) {
		// A decoded map would silently keep one value; the token walk must
		// reject the source instead.
		if _, err := externalFromJSON(json.RawMessage(`{"a":1,"a":2}`)); err == nil || !strings.Contains(err.Error(), "duplicate object key") {
			t.Fatalf("duplicate json keys error = %v", err)
		}
		if _, err := externalFromJSON(json.RawMessage(`{"outer":{"b":true,"b":false}}`)); err == nil {
			t.Fatal("nested duplicate keys must be rejected")
		}
		if _, err := externalFromJSON(json.RawMessage(`{"secret-token-12345":1,"secret-token-12345":2}`)); err == nil ||
			strings.Contains(err.Error(), "secret-token-12345") {
			t.Fatalf("duplicate-key error must not echo the source key: %v", err)
		}
		if _, err := externalFromJSON(json.RawMessage(`{"a":1,"b":2}`)); err != nil {
			t.Fatalf("distinct keys must be accepted: %v", err)
		}
	})

	t.Run("raw_json_reserved_keys", func(t *testing.T) {
		value, err := externalFromJSON(json.RawMessage(`{"__proto__":"kept","constructor":1,"plain":true}`))
		if err != nil {
			t.Fatal(err)
		}
		got := externalToAny(t, value).(map[string]any)
		if got["__proto__"] != "kept" || got["constructor"] != json.Number("1") || got["plain"] != true {
			t.Fatalf("reserved keys lost in conversion: %#v", got)
		}
	})

	t.Run("raw_json_bounds", func(t *testing.T) {
		// The root is depth 1, so 23 brackets put `true` at depth 24.
		rawDeep := strings.Repeat(`[`, 23) + "true" + strings.Repeat(`]`, 23)
		if _, err := externalFromJSON(json.RawMessage(rawDeep)); err != nil {
			t.Fatalf("raw depth 24 must be accepted: %v", err)
		}
		rawTooDeep := strings.Repeat(`[`, 24) + "true" + strings.Repeat(`]`, 24)
		if _, err := externalFromJSON(json.RawMessage(rawTooDeep)); !errors.Is(err, errExternalBound) {
			t.Fatalf("raw depth 25 error = %v, want the depth bound", err)
		}
		rawWide := "[" + strings.Repeat("true,", 99_998) + "true]"
		if _, err := externalFromJSON(json.RawMessage(rawWide)); err != nil {
			t.Fatalf("raw 100000 nodes must be accepted: %v", err)
		}
		rawTooWide := "[" + strings.Repeat("true,", 99_999) + "true]"
		if _, err := externalFromJSON(json.RawMessage(rawTooWide)); !errors.Is(err, errExternalBound) {
			t.Fatalf("raw 100001 nodes error = %v, want the node bound", err)
		}
		if _, err := externalFromJSON(json.RawMessage(`{"a":1} trailing`)); err == nil {
			t.Fatal("trailing data must be rejected")
		}
	})

	t.Run("duplicate_keys", func(t *testing.T) {
		// The wire type can carry duplicate keys; the JS decoder is the
		// runtime that must reject them before building an object
		// (test-js/websocket-control-protobuf.test.js).
		value := &wspb.ExternalValue{Kind: &wspb.ExternalValue_ObjectValue{
			ObjectValue: &wspb.ExternalObject{Entries: []*wspb.ExternalEntry{
				{Key: "a", Value: &wspb.ExternalValue{Kind: &wspb.ExternalValue_BoolValue{BoolValue: true}}},
				{Key: "a", Value: &wspb.ExternalValue{Kind: &wspb.ExternalValue_BoolValue{BoolValue: false}}},
			}},
		}}
		raw, err := proto.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		decoded := &wspb.ExternalValue{}
		if err := proto.Unmarshal(raw, decoded); err != nil {
			t.Fatal(err)
		}
		if got := len(decoded.GetObjectValue().GetEntries()); got != 2 {
			t.Fatalf("duplicate entries = %d, want 2 preserved for the decoder check", got)
		}
		// The encoder never produces duplicates from a Go map.
		fromMap, err := externalFromAny(map[string]any{"a": true})
		if err != nil {
			t.Fatal(err)
		}
		if got := len(fromMap.GetObjectValue().GetEntries()); got != 1 {
			t.Fatalf("encoder produced %d entries for one map key", got)
		}
	})

	t.Run("absent_null_false_zero", func(t *testing.T) {
		value := mustExternal(t, map[string]any{
			"none":  nil,
			"no":    false,
			"zero":  json.Number("0"),
			"ratio": json.Number("0.5"),
			"empty": map[string]any{},
			"list":  []any{},
		})
		byKey := map[string]*wspb.ExternalValue{}
		for _, entry := range value.GetObjectValue().GetEntries() {
			byKey[entry.GetKey()] = entry.GetValue()
		}
		if byKey["none"].GetNullValue() == nil {
			t.Fatal("null lost")
		}
		if byKey["no"].GetBoolValue() {
			t.Fatal("false lost")
		}
		if _, ok := byKey["no"].GetKind().(*wspb.ExternalValue_BoolValue); !ok {
			t.Fatalf("false must stay a bool variant: %T", byKey["no"].GetKind())
		}
		if _, ok := byKey["zero"].GetKind().(*wspb.ExternalValue_IntValue); !ok {
			t.Fatalf("integral number must stay an int variant: %T", byKey["zero"].GetKind())
		}
		if got := byKey["ratio"].GetNumberValue(); got != 0.5 {
			t.Fatalf("ratio = %v", got)
		}
		if object, ok := byKey["empty"].GetKind().(*wspb.ExternalValue_ObjectValue); !ok || len(object.ObjectValue.GetEntries()) != 0 {
			t.Fatalf("empty object must stay an empty object variant: %T", byKey["empty"].GetKind())
		}
		if list, ok := byKey["list"].GetKind().(*wspb.ExternalValue_ListValue); !ok || len(list.ListValue.GetValues()) != 0 {
			t.Fatalf("empty list must stay an empty list variant: %T", byKey["list"].GetKind())
		}
	})

	t.Run("depth_boundary", func(t *testing.T) {
		if _, err := externalFromAny(nestedExternal(24)); err != nil {
			t.Fatalf("depth 24 must be accepted: %v", err)
		}
		if _, err := externalFromAny(nestedExternal(25)); !errors.Is(err, errExternalBound) {
			t.Fatalf("depth 25 error = %v, want the depth bound", err)
		}
	})

	t.Run("node_boundary", func(t *testing.T) {
		if _, err := externalFromAny(boolList(99_999)); err != nil {
			t.Fatalf("100000 nodes must be accepted: %v", err)
		}
		if _, err := externalFromAny(boolList(100_000)); !errors.Is(err, errExternalBound) {
			t.Fatalf("100001 nodes error = %v, want the node bound", err)
		}
	})

	t.Run("integers_beyond_js_safe_range", func(t *testing.T) {
		// Pi sends arbitrary JSON numbers. An integer a JS number cannot hold
		// exactly must travel as a double: int_value is reserved for values
		// the browser can convert without losing precision, and the browser
		// rejects a wider int_value as a bound violation.
		big, ok := mustExternal(t, json.Number("9007199254740992")).GetKind().(*wspb.ExternalValue_NumberValue)
		if !ok {
			t.Fatalf("2^53 must travel as a double: %T", mustExternal(t, json.Number("9007199254740992")).GetKind())
		}
		if big.NumberValue != 9007199254740992 {
			t.Fatalf("2^53 double = %v", big.NumberValue)
		}
		if _, ok := mustExternal(t, json.Number("9007199254740991")).GetKind().(*wspb.ExternalValue_IntValue); !ok {
			t.Fatal("the largest safe integer must stay an int variant")
		}
		if _, ok := mustExternal(t, int64(1)<<62).GetKind().(*wspb.ExternalValue_NumberValue); !ok {
			t.Fatal("a wide int64 must travel as a double")
		}
		if _, ok := mustExternal(t, json.Number("-9007199254740992")).GetKind().(*wspb.ExternalValue_NumberValue); !ok {
			t.Fatal("a wide negative integer must travel as a double")
		}
	})

	t.Run("finite_numbers", func(t *testing.T) {
		if _, err := externalFromAny(math.NaN()); err == nil {
			t.Fatal("NaN must be rejected")
		}
		if _, err := externalFromAny(math.Inf(1)); err == nil {
			t.Fatal("+Inf must be rejected")
		}
		if _, err := externalFromAny(json.Number("1e400")); err == nil {
			t.Fatal("overflowing json.Number must be rejected")
		}
		if _, err := externalFromAny(make(chan int)); err == nil {
			t.Fatal("unsupported kinds must be rejected")
		}
		if _, err := externalFromAny(map[string]any{"n": math.NaN()}); err == nil {
			t.Fatal("nested nonfinite numbers must be rejected")
		}
	})
}

func nestedExternal(depth int) any {
	var value any = true
	for level := 1; level < depth; level++ {
		value = []any{value}
	}
	return value
}

func boolList(count int) []any {
	values := make([]any, count)
	for i := range values {
		values[i] = true
	}
	return values
}

// TestWebSocketProtobufConversionFailures covers correlated result errors,
// visible stream failure on event conversion, retained authoritative state,
// cleanup, and no replay of mutating calls.
func TestWebSocketProtobufConversionFailures(t *testing.T) {
	t.Run("correlated_result_error", func(t *testing.T) {
		mgr, _, commands := newFullControlManager(t)
		c := helloDial(t, mgr)
		sid := spawnControlSession(t, c, "/w/failure-result")
		drainCommands(commands)

		call := &wspb.ControlCall{Id: "bad-set-model", Call: &wspb.ControlCall_SetModel{
			SetModel: &wspb.SetModelCall{Sid: sid}}}
		response := expectError(t, c, call, "provider and modelId are required")
		if response.GetId() != call.GetId() {
			t.Fatalf("correlated error id = %q", response.GetId())
		}
		assertNoCommand(t, commands, "set_model")

		// Unrelated calls keep working on the same connection.
		other := mustCall(t, c, &wspb.ControlCall{Id: "after-error", Call: &wspb.ControlCall_GetState{
			GetState: &wspb.GetStateCall{Sid: sid}}})
		if other.GetGetState().GetState() == nil {
			t.Fatalf("state after a correlated error = %+v", other)
		}
	})

	t.Run("result_conversion_error_is_correlated", func(t *testing.T) {
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/failure-convert"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { inst.Kill() })
		before := inst.SnapshotCopy()
		// A stored message with undecodable external content makes the
		// snapshot conversion fail; the call must answer with an error
		// instead of an empty success.
		inst.Emit(rpc.EvtMessageEnd, &rpc.Message{
			Role:    "assistant",
			Content: json.RawMessage(`{not json`),
		}, nil)

		c := helloDial(t, mgr)
		call := &wspb.ControlCall{Id: "hydrate-convert", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}}
		response := expectError(t, c, call, "content")
		if response.GetId() != call.GetId() {
			t.Fatalf("result conversion error id = %q", response.GetId())
		}
		if response.GetHydrate() != nil {
			t.Fatal("a failed result conversion must not send an empty success")
		}
		after := inst.SnapshotCopy()
		if len(after.Messages) != len(before.Messages)+1 {
			t.Fatalf("failed conversion changed the transcript: %d -> %d", len(before.Messages), len(after.Messages))
		}
		if after.LastSeq == before.LastSeq {
			t.Fatal("authoritative sequence state was rolled back")
		}
	})

	t.Run("event_conversion_error_closes_stream", func(t *testing.T) {
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/failure-event"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { inst.Kill() })
		c := helloDial(t, mgr)
		// Subscribe before the poison event so the conversion path runs.
		mustCall(t, c, &wspb.ControlCall{Id: "hydrate-sub", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})
		before := inst.SnapshotCopy()
		inst.Emit(rpc.EvtMessageEnd, nil, struct{ Poison int }{Poison: 1})
		if code := readCloseCode(t, c); code != websocket.CloseInternalServerErr {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseInternalServerErr)
		}
		after := inst.SnapshotCopy()
		if after.LastSeq != before.LastSeq+1 {
			t.Fatalf("authoritative sequence advanced to %d, want %d", after.LastSeq, before.LastSeq+1)
		}
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			if mgr.SubscriptionCount(inst) == 0 {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("stream failure left %d manager subscriptions", mgr.SubscriptionCount(inst))
	})

	t.Run("mutating_call_is_not_replayed", func(t *testing.T) {
		mgr, _, commands := newFullControlManager(t)
		c := helloDial(t, mgr)
		sid := spawnControlSession(t, c, "/w/failure-replay")
		drainCommands(commands)

		// One mutation completes, then a later result conversion fails.
		mustCall(t, c, &wspb.ControlCall{Id: "replay-set", Call: &wspb.ControlCall_SetThinking{
			SetThinking: &wspb.SetThinkingCall{Sid: sid, Level: "high"}}})
		inst, err := mgr.Lookup(sid)
		if err != nil {
			t.Fatal(err)
		}
		if got := inst.StateCopy().Thinking; got != "high" {
			t.Fatalf("mutation did not land: thinking = %q", got)
		}
		inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: json.RawMessage(`{bad`)}, nil)
		expectError(t, c, &wspb.ControlCall{Id: "replay-hydrate", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: sid}}}, "")
		// The executed mutation reached Pi once and is not replayed after the
		// failure.
		assertCommandCount(t, commands, "set_thinking_level", 1)
		time.Sleep(50 * time.Millisecond)
		assertNoCommand(t, commands, "set_thinking_level")
		if got := inst.StateCopy().Thinking; got != "high" {
			t.Fatalf("state changed after the failed response: %q", got)
		}
	})

	t.Run("subagent_fleet_raw_json_is_delivered", func(t *testing.T) {
		// rpc publishes the fleet payload as raw JSON in production. It must
		// convert and arrive without closing the connection.
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/failure-fleet"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { inst.Kill() })
		c := helloDial(t, mgr)
		mustCall(t, c, &wspb.ControlCall{Id: "fleet-sub", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})

		inst.Emit(rpc.EvtSubagentFleet, nil, json.RawMessage(`{"runs":[{"id":"run-1","status":"running"}],"truncated":false}`))

		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			frame := readFrame(t, c)
			ev := frame.GetEvent()
			if ev == nil || ev.GetSubagentFleet() == nil {
				continue
			}
			fleet := externalToAny(t, ev.GetSubagentFleet().GetFleet()).(map[string]any)
			runs, ok := fleet["runs"].([]any)
			if !ok || len(runs) != 1 {
				t.Fatalf("fleet payload = %#v", fleet)
			}
			if fleet["truncated"] != false {
				t.Fatalf("fleet flags = %#v", fleet)
			}
			// Still usable: a normal call answers on the same connection.
			mustCall(t, c, &wspb.ControlCall{Id: "fleet-after", Call: &wspb.ControlCall_GetState{
				GetState: &wspb.GetStateCall{Sid: inst.ID}}})
			return
		}
	})

	t.Run("getMessages_subscribes_on_fresh_connection", func(t *testing.T) {
		// Legacy getMessages subscribed the connection, so later events must
		// still arrive. An already-subscribed test connection would hide a
		// dropped subscription.
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/failure-getmessages"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { inst.Kill() })
		c := helloDial(t, mgr)

		res := mustCall(t, c, &wspb.ControlCall{Id: "gm", Call: &wspb.ControlCall_GetMessages{
			GetMessages: &wspb.GetMessagesCall{Sid: inst.ID}}})
		if res.GetGetMessages() == nil {
			t.Fatalf("getMessages result = %+v", res)
		}
		if mgr.SubscriptionCount(inst) != 1 {
			t.Fatalf("subscriptions after getMessages = %d, want 1", mgr.SubscriptionCount(inst))
		}

		inst.Emit(rpc.EvtMessageEnd, nil, map[string]any{"message": map[string]any{
			"role": "assistant", "content": "late",
		}})
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			ev := readFrame(t, c).GetEvent()
			if ev == nil || ev.GetMessageEnd() == nil {
				continue
			}
			if got := ev.GetMessageEnd().GetMessage().GetContent().GetStringValue(); got != "late" {
				t.Fatalf("event after getMessages = %q", got)
			}
			return
		}
	})

	t.Run("result_encoding_failure_is_correlated", func(t *testing.T) {
		// A typed result that cannot be marshalled still answers its call.
		data, err := encodeResponseFrame(&wspb.ControlResponse{
			Id: "encoding-1",
			Result: &wspb.ControlResponse_SetSessionName{SetSessionName: &wspb.StateResult{
				State: &wspb.ControlState{Sid: string([]byte{0xff, 0xfe})},
			}},
		})
		if err != nil {
			t.Fatalf("fallback frame did not encode: %v", err)
		}
		frame := &wspb.ControlServerFrame{}
		if err := proto.Unmarshal(data, frame); err != nil {
			t.Fatal(err)
		}
		res := frame.GetResponse()
		if res.GetId() != "encoding-1" || res.GetError().GetReason() != "result encoding failed" {
			t.Fatalf("fallback response = %+v", res)
		}
	})

	t.Run("event_encoding_failure_closes_1011", func(t *testing.T) {
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/failure-event-encoding"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { inst.Kill() })
		c := helloDial(t, mgr)
		mustCall(t, c, &wspb.ControlCall{Id: "enc-sub", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})

		// A Go string with invalid UTF-8 reaches the event encoder unchanged;
		// proto.Marshal then refuses it, which must close with 1011 instead of
		// looking like a dead socket.
		inst.Emit(rpc.EvtMessageEnd, nil, map[string]any{"message": map[string]any{
			"role": "assistant", "content": string([]byte{0xff}),
		}})
		if code := readCloseCode(t, c); code != websocket.CloseInternalServerErr {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseInternalServerErr)
		}
	})

	t.Run("text_frames_are_rejected", func(t *testing.T) {
		mgr, _, commands := newFullControlManager(t)
		// Text hello: the upgrade stays open, the first frame closes 1002.
		rawDial := dial(t, HandleControl(mgr, func() string { return "" }))
		hello, err := proto.Marshal(&wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Hello{
			Hello: &wspb.ControlHello{Version: uint32(rpc.ProtocolVersion)},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if err := rawDial.WriteMessage(websocket.TextMessage, hello); err != nil {
			t.Fatal(err)
		}
		if code := readCloseCode(t, rawDial); code != websocket.CloseProtocolError {
			t.Fatalf("text hello close code = %d, want %d", code, websocket.CloseProtocolError)
		}

		// Text call after a valid binary hello: close 1002, no dispatch.
		c := helloDial(t, mgr)
		call, err := proto.Marshal(&wspb.ControlClientFrame{Payload: &wspb.ControlClientFrame_Call{
			Call: &wspb.ControlCall{Id: "text-call", Call: &wspb.ControlCall_Spawn{
				Spawn: &wspb.SpawnCall{Cwd: proto.String("/w/text-frame")}}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if err := c.WriteMessage(websocket.TextMessage, call); err != nil {
			t.Fatal(err)
		}
		if code := readCloseCode(t, c); code != websocket.CloseProtocolError {
			t.Fatalf("text call close code = %d, want %d", code, websocket.CloseProtocolError)
		}
		assertNoCommand(t, commands, "get_state")
		if _, err := mgr.Lookup(""); err == nil {
			t.Fatal("text frame spawned a session")
		}
	})
}

// TestWebSocketProtobufControlOrdering covers concurrent ids, overlapping
// hydrate fences, compact/abort concurrency, the per-operation budgets, and
// subscription cleanup.
func TestWebSocketProtobufControlOrdering(t *testing.T) {
	t.Run("concurrent_overlap", func(t *testing.T) {
		// Two calls must be in flight at the same time: one is held inside Pi
		// while the other already answers on the same connection.
		child := newControlFakeChild()
		gate := make(chan struct{})
		entered := make(chan struct{})
		var hold atomic.Bool
		respondControlCommands(child, func(command map[string]any) (any, bool, string) {
			switch command["type"] {
			case "get_available_models":
				if hold.Load() {
					close(entered)
					<-gate
				}
				return map[string]any{"models": []map[string]any{
					{"provider": "remote", "id": "remote-id", "name": "Remote model"},
				}}, true, ""
			case "get_state":
				return map[string]any{
					"model": map[string]any{"name": "m"}, "thinkingLevel": "low",
					"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0,
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
		sid := spawnControlSession(t, c, "/w/order-ids")
		hold.Store(true)

		sendCall(t, c, &wspb.ControlCall{Id: "held-models", Call: &wspb.ControlCall_GetAvailableModels{
			GetAvailableModels: &wspb.GetAvailableModelsCall{Sid: sid}}})
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("held call never reached Pi")
		}
		sendCall(t, c, &wspb.ControlCall{Id: "free-list", Call: &wspb.ControlCall_ListSessions{
			ListSessions: &wspb.ListSessionsCall{}}})
		free := readResponse(t, c, "free-list")
		if free.GetListSessions() == nil {
			t.Fatalf("listSessions response variant = %+v", free)
		}
		close(gate)
		held := readResponse(t, c, "held-models")
		if len(held.GetGetAvailableModels().GetModels()) != 1 {
			t.Fatalf("models response variant = %+v", held)
		}
	})

	t.Run("concurrent_burst", func(t *testing.T) {
		// Every call in a burst answers once, with its own id and variant.
		mgr, _, _ := newFullControlManager(t)
		c := helloDial(t, mgr)
		sid := spawnControlSession(t, c, "/w/order-burst")
		const calls = 32
		for i := 0; i < calls; i++ {
			sendCall(t, c, &wspb.ControlCall{
				Id:   fmt.Sprintf("burst-%d", i),
				Call: &wspb.ControlCall_GetState{GetState: &wspb.GetStateCall{Sid: sid}},
			})
		}
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		seen := make(map[string]bool, calls)
		for len(seen) < calls {
			res := readFrame(t, c).GetResponse()
			if res == nil {
				continue
			}
			if !strings.HasPrefix(res.GetId(), "burst-") {
				continue
			}
			if seen[res.GetId()] {
				t.Fatalf("duplicate response id %q", res.GetId())
			}
			if res.GetGetState() == nil || res.GetError() != nil {
				t.Fatalf("burst response %q = %+v", res.GetId(), res)
			}
			seen[res.GetId()] = true
		}
	})

	t.Run("overlapping_hydrate_fences", func(t *testing.T) {
		mgr, _, _ := newFullControlManager(t)
		inst, err := mgr.Spawn(rpc.SpawnOptions{Cwd: "/w/order-fence"})
		if err != nil {
			t.Fatal(err)
		}
		defer inst.Kill()
		for i := 0; i < 5000; i++ {
			inst.Emit(rpc.EvtMessageEnd, &rpc.Message{Role: "assistant", Content: json.RawMessage(`"seed"`)}, nil)
		}
		c := helloDial(t, mgr)
		sendCall(t, c, &wspb.ControlCall{Id: "fence-1", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})
		sendCall(t, c, &wspb.ControlCall{Id: "fence-2", Call: &wspb.ControlCall_Hydrate{
			Hydrate: &wspb.HydrateCall{Sid: inst.ID}}})
		time.Sleep(20 * time.Millisecond)
		inst.Emit(rpc.EvtStateChanged, nil, map[string]any{"error": "after-fence"})

		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		order := make([]string, 0, 3)
		for len(order) < 3 {
			frame := readFrame(t, c)
			if res := frame.GetResponse(); res != nil {
				id := res.GetId()
				if (id == "fence-1" || id == "fence-2") && !containsString(order, id) {
					order = append(order, id)
				}
				continue
			}
			if ev := frame.GetEvent(); ev != nil && ev.GetSid() == inst.ID {
				if !containsString(order, "fenced-event") {
					order = append(order, "fenced-event")
				}
			}
		}
		if order[0] != "fence-1" || order[1] != "fence-2" || order[2] != "fenced-event" {
			t.Fatalf("hydrate fence order = %v, want [fence-1 fence-2 fenced-event]", order)
		}
	})

	t.Run("compact_abort", func(t *testing.T) {
		child := newControlFakeChild()
		respondControlCommands(child, func(command map[string]any) (any, bool, string) {
			switch command["type"] {
			case "get_state":
				return map[string]any{
					"model": map[string]any{"name": "m"}, "thinkingLevel": "low",
					"isStreaming": false, "isCompacting": false, "pendingMessageCount": 0,
				}, true, ""
			case "get_session_stats", "get_commands":
				return map[string]any{}, true, ""
			case "compact", "abort":
				return map[string]any{}, true, ""
			default:
				return nil, false, "unexpected command"
			}
		})
		mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
			return child, child.stdinW, child.stdoutR, nil
		})
		c := helloDial(t, mgr)
		sid := spawnControlSession(t, c, "/w/order-compact")
		inst, err := mgr.Lookup(sid)
		if err != nil {
			t.Fatal(err)
		}

		// Hold the control gate exactly like a compact in flight.
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

		sendCall(t, c, &wspb.ControlCall{Id: "compact-long", Call: &wspb.ControlCall_Compact{
			Compact: &wspb.CompactCall{Sid: sid}}})
		// Abort bypasses the control gate while compact holds it.
		abort := mustCall(t, c, &wspb.ControlCall{Id: "abort-during", Call: &wspb.ControlCall_Abort{
			Abort: &wspb.AbortCall{Sid: sid}}})
		if !abort.GetAbort().GetAborted() {
			t.Fatalf("abort during compact = %+v", abort)
		}
		close(release)
		compact := readResponse(t, c, "compact-long")
		if compact.GetCompact() == nil {
			t.Fatalf("compact response after release = %+v", compact)
		}
	})

	t.Run("timeout_budgets", func(t *testing.T) {
		if ControlOperationTimeout != 30*time.Second {
			t.Fatalf("operation budget = %v, want 30s", ControlOperationTimeout)
		}
		if CompactOperationTimeout != 10*time.Minute {
			t.Fatalf("compact budget = %v, want 10m", CompactOperationTimeout)
		}
	})

	t.Run("disconnect_cleanup", func(t *testing.T) {
		mgr, _, _ := newFullControlManager(t)
		c := helloDial(t, mgr)
		sid := spawnControlSession(t, c, "/w/order-cleanup")
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
			if mgr.SubscriptionCount(inst) == 0 {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("disconnect left %d manager subscriptions", mgr.SubscriptionCount(inst))
	})
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func drainCommands(commands chan string) {
	for {
		select {
		case <-commands:
		default:
			return
		}
	}
}

func assertNoCommand(t *testing.T, commands chan string, want string) {
	t.Helper()
	for {
		select {
		case kind := <-commands:
			if kind == want {
				t.Fatalf("command %q reached Pi when it should not have", want)
			}
		default:
			return
		}
	}
}

// assertCommandCount drains the observed Pi commands and requires exactly
// want occurrences of kind.
func assertCommandCount(t *testing.T, commands chan string, kind string, want int) {
	t.Helper()
	got := 0
	var seen []string
	for {
		select {
		case observed := <-commands:
			seen = append(seen, observed)
			if observed == kind {
				got++
			}
		default:
			if got != want {
				t.Fatalf("command %q reached Pi %d times, want %d (observed %v)", kind, got, want, seen)
			}
			return
		}
	}
}
