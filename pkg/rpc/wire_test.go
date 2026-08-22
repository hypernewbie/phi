package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCompactionClearsTranscript(t *testing.T) {
	fp := newFakeProc()
	m := NewManager()
	m.spawnFn = func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	}
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/d"})
	if err != nil {
		t.Fatal(err)
	}
	sub := inst.Subscribe()
	go func() {
		_, _ = fp.stdoutW.Write([]byte(
			`{"type":"message_end","message":{"role":"user","content":"a"}}` + "\n" +
				`{"type":"compaction_end"}` + "\n"))
	}()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-sub.Channel():
			if e.Evt == EvtTranscriptReset {
				if len(inst.SnapshotCopy().Messages) != 0 {
					t.Fatal("transcript not cleared")
				}
				return
			}
		case <-deadline:
			t.Fatal("no transcriptReset observed")
		}
	}
}

// TestMessageUpdateDataNotAliasedToScannerBuffer is a regression for the
// bufio.Scanner buffer aliasing bug: readLoop previously wrapped LineScanner's
// reusable buffer in json.RawMessage without copying, so subsequent Scan calls
// overwrote the bytes that message_start/message_update events had queued for
// downstream subscribers. This test fails on the unfixed wire.go and passes
// after the copy is introduced.
//
// Strategy:
//   - Write a message_update line with a unique marker payload.
//   - Then write >256 subsequent valid lines so the 256-cap subscriber channel
//     overflows (subscriber is dropped and channel closed) and the scanner
//     buffer is rotated past the first line's positions (>64KiB total).
//   - Drain the subscriber's channel.
//   - Assert: (a) every non-nil Data round-trips through json.Marshal/Unmarshal,
//     and (b) the FIRST message_update event's data still equals the original
//     raw line — i.e. the payload was not aliased.
func wireFixture(t *testing.T) (*fakeProc, *Instance, *Subscriber) {
	t.Helper()
	fp := newFakeProc()
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/d"})
	if err != nil {
		t.Fatal(err)
	}
	return fp, inst, inst.Subscribe()
}

func wireManagerFixture(t *testing.T) (*Manager, *fakeProc, *Instance, *Subscriber) {
	t.Helper()
	fp := newFakeProc()
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/wire"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(inst.Kill)
	return m, fp, inst, inst.Subscribe()
}

func wireResponse(t *testing.T, fp *fakeProc, inst *Instance, command string, data string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := inst.Request(ctx, command, nil)
		result <- err
	}()
	var request map[string]any
	select {
	case request = <-fp.commands:
	case <-ctx.Done():
		t.Fatal("timed out waiting for correlated request")
	}
	id, ok := request["id"].(string)
	if !ok || id == "" {
		t.Fatalf("request missing id: %#v", request)
	}
	line := fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":true,"data":%s}`+"\n", id, command, data)
	if _, err := fp.stdoutW.Write([]byte(line)); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func nextWireEvent(t *testing.T, sub *Subscriber) Event {
	t.Helper()
	select {
	case event := <-sub.Channel():
		return event
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for wire event")
		return Event{}
	}
}

func TestMatchedResponseOnlyResolvesItsWaiterAndDuplicateIsHarmless(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		command string
		data    json.RawMessage
		err     error
	}
	results := make(chan result, 2)
	for _, command := range []string{"get_state", "get_session_stats"} {
		go func(command string) {
			data, err := inst.Request(ctx, command, nil)
			results <- result{command: command, data: data, err: err}
		}(command)
	}
	requests := make(map[string]string)
	ids := make(map[string]string)
	for len(requests) < 2 {
		request := <-fp.commands
		id, ok := request["id"].(string)
		if !ok || id == "" {
			t.Fatalf("request missing correlation id: %#v", request)
		}
		command, ok := request["type"].(string)
		if !ok {
			t.Fatalf("request missing command: %#v", request)
		}
		requests[id] = command
		ids[command] = id
	}
	writeResponse := func(id, command, data string) {
		t.Helper()
		line := fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":true,"data":%s}`+"\n", id, command, data)
		if _, err := fp.stdoutW.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	writeResponse("unknown-late-id", "get_state", `{}`)
	writeResponse(ids["get_session_stats"], "get_session_stats", `{"tokens":{"input":2}}`)
	first := <-results
	if first.command != "get_session_stats" || first.err != nil || string(first.data) != `{"tokens":{"input":2}}` {
		t.Fatalf("first correlated result = %+v", first)
	}
	// A duplicate response after atomic waiter claim must not resolve another
	// request or publish another metadata event.
	writeResponse(ids["get_session_stats"], "get_session_stats", `{"tokens":{"input":99}}`)
	writeResponse(ids["get_state"], "get_state", `{"model":{"name":"matched"}}`)
	second := <-results
	if second.command != "get_state" || second.err != nil || string(second.data) != `{"model":{"name":"matched"}}` {
		t.Fatalf("second correlated result = %+v", second)
	}
	for i := 0; i < 2; i++ {
		if event := nextWireEvent(t, sub); event.Evt != EvtStateChanged {
			t.Fatalf("unexpected correlated metadata event: %+v", event)
		}
	}
	select {
	case event := <-sub.Channel():
		t.Fatalf("unknown/duplicate response published event: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestGetStateMetadataUpdatesBusyQueueAndManagerSessionPath(t *testing.T) {
	m, fp, inst, sub := wireManagerFixture(t)
	wireResponse(t, fp, inst, "get_state", `{"model":{"id":"fallback"},"thinkingLevel":"high","isStreaming":true,"isCompacting":false,"pendingMessageCount":3,"sessionFile":"/sessions/fresh.jsonl","sessionId":"fresh-id"}`)
	event := nextWireEvent(t, sub)
	if event.Evt != EvtStateChanged {
		t.Fatalf("metadata did not publish stateChanged: %+v", event)
	}
	state := inst.StateCopy()
	if state.Model != "fallback" || state.Thinking != "high" || !state.Busy || state.QueueDepth != 3 {
		t.Fatalf("canonical state missing Pi metadata: %+v", state)
	}
	if inst.SessionPathCopy() != "/sessions/fresh.jsonl" {
		t.Fatalf("manager did not own session path update: %q", inst.SessionPathCopy())
	}
	if _, err := m.Lookup(inst.ID); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentEventsAndResetKeepSnapshotSequenceMonotonic(t *testing.T) {
	inst := &Instance{ID: "sequence", subs: newSubscriberSet(), snap: &Snapshot{Messages: []Message{}}}
	sub := inst.Subscribe()
	const events = 120
	var group sync.WaitGroup
	for index := 0; index < events; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			if index%3 == 0 {
				inst.ResetTranscript()
				return
			}
			inst.Emit(EvtStateChanged, nil, map[string]any{"index": index})
		}(index)
	}
	group.Wait()
	for want := uint64(1); want <= events; want++ {
		event := nextWireEvent(t, sub)
		if event.Seq != want {
			t.Fatalf("event sequence = %d, want %d", event.Seq, want)
		}
	}
	if snapshot := inst.SnapshotCopy(); snapshot.LastSeq != events {
		t.Fatalf("snapshot lastSeq = %d, want %d", snapshot.LastSeq, events)
	}
}

// TestBusyLifecycleAndAgentSettledClearing pins down the canonical
// owner of the active-turn boundary: only agent_settled clears Busy
// and emits the clearing stateChanged. agent_start opens the turn,
// agent_end and compaction_* events keep it open, and a get_state
// response with isStreaming:false isCompacting:false must not collapse
// Busy just because the canonical metadata fields read idle.
func TestBusyLifecycleAndAgentSettledClearing(t *testing.T) {
	fp, inst, sub := wireFixture(t)

	if state := inst.StateCopy(); state.Busy {
		t.Fatalf("initial state should not be busy: %+v", state)
	}

	// 1. agent_start opens the turn: Busy flips true with one stateChanged.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_start"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	event := nextWireEvent(t, sub)
	if event.Evt != EvtStateChanged {
		t.Fatalf("agent_start did not publish stateChanged: %+v", event)
	}
	if state := inst.StateCopy(); !state.Busy {
		t.Fatalf("agent_start did not set Busy=true: %+v", state)
	}

	// 2. agent_end is a Pi-side hint, not the turn boundary. No event, Busy stays true.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_end"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-sub.Channel():
		t.Fatalf("agent_end must not publish any event: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if state := inst.StateCopy(); !state.Busy {
		t.Fatalf("agent_end must not clear Busy: %+v", state)
	}

	// 3. get_state with isStreaming:false isCompacting:false between the open and the
	//    settled boundary must not clear Busy. The response itself emits a
	//    stateChanged (canonical metadata merge), but the OR-merge in
	//    parseGetState keeps Busy=true.
	wireResponse(t, fp, inst, "get_state", `{"isStreaming":false,"isCompacting":false}`)
	event = nextWireEvent(t, sub)
	if event.Evt != EvtStateChanged {
		t.Fatalf("get_state response did not publish stateChanged: %+v", event)
	}
	if state := inst.StateCopy(); !state.Busy {
		t.Fatalf("get_state with isStreaming=false,isCompacting=false must not clear Busy: %+v", state)
	}

	// 4. compaction_start inside the active turn: Busy already true, no event.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"compaction_start"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-sub.Channel():
		t.Fatalf("compaction_start must not publish event when already busy: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if state := inst.StateCopy(); !state.Busy {
		t.Fatalf("compaction_start must not clear Busy: %+v", state)
	}

	// 5. compaction_end emits EvtCompactionEnd first (raw passthrough
	//    so the chat-pi client can render its error/aborted UI against
	//    the pre-reset state), then EvtTranscriptReset to clear the
	//    stored messages. Both events take consecutive sequence numbers.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"compaction_end"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	event = nextWireEvent(t, sub)
	if event.Evt != EvtCompactionEnd {
		t.Fatalf("compaction_end did not publish compactionEnd: %+v", event)
	}
	// compactionEnd must not add or remove messages: it is a raw
	// passthrough (msg=nil). The snapshot is cleared by the immediately
	// following transcriptReset, which publishes seq N+1; the synchronous
	// broadcast pattern in publish() means snapshot.LastSeq is already
	// at N+1 by the time the subscriber reads compactionEnd, so the
	// seq-relationship must be checked across both events instead of
	// against snapshot state at compactionEnd observation time.
	if event.Seq == 0 {
		t.Fatalf("compactionEnd seq must be non-zero: %+v", event)
	}
	event = nextWireEvent(t, sub)
	if event.Evt != EvtTranscriptReset {
		t.Fatalf("compaction_end did not publish transcriptReset: %+v", event)
	}
	if event.Seq != inst.SnapshotCopy().LastSeq {
		t.Fatalf("transcriptReset seq %d does not match snapshot lastSeq %d", event.Seq, inst.SnapshotCopy().LastSeq)
	}
	if len(inst.SnapshotCopy().Messages) != 0 {
		t.Fatalf("transcriptReset did not clear snapshot messages")
	}
	if state := inst.StateCopy(); !state.Busy {
		t.Fatalf("compaction_end must not clear Busy: %+v", state)
	}

	// 6. agent_settled is the only event that clears Busy and emits the
	//    clearing stateChanged.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	event = nextWireEvent(t, sub)
	if event.Evt != EvtStateChanged {
		t.Fatalf("agent_settled did not publish stateChanged: %+v", event)
	}
	if state := inst.StateCopy(); state.Busy {
		t.Fatalf("agent_settled did not clear Busy: %+v", state)
	}

	// agent_settled also schedules a get_session_stats refresh; consume
	// the request and answer it so the follow-up goroutine completes
	// deterministically.
	select {
	case command := <-fp.commands:
		if command["type"] != "get_session_stats" {
			t.Fatalf("unexpected settled refresh: %#v", command)
		}
		id, ok := command["id"].(string)
		if !ok || id == "" {
			t.Fatalf("settled refresh missing id: %#v", command)
		}
		line := fmt.Sprintf(`{"type":"response","id":%q,"command":"get_session_stats","success":true,"data":{}}`+"\n", id)
		if _, err := fp.stdoutW.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent_settled did not refresh stats")
	}
}

func TestPiRejectionUnblocksRequestAndRemovesWaiter(t *testing.T) {
	fp, inst, _ := wireFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := inst.Request(ctx, "set_model", map[string]any{"provider": "p", "modelId": "m"})
		result <- err
	}()
	request := <-fp.commands
	id, ok := request["id"].(string)
	if !ok || id == "" {
		t.Fatalf("request missing id: %#v", request)
	}
	line := fmt.Sprintf(`{"type":"response","id":%q,"command":"set_model","success":false,"error":"model unavailable","data":null}`+"\n", id)
	if _, err := fp.stdoutW.Write([]byte(line)); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "model unavailable") {
			t.Fatalf("Pi rejection error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Pi rejection did not unblock request")
	}
	inst.pendingMu.Lock()
	pending := len(inst.pending)
	inst.pendingMu.Unlock()
	if pending != 0 {
		t.Fatalf("Pi rejection left %d pending waiters", pending)
	}
}

func TestMetadataResponsesMergeState(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	wireResponse(t, fp, inst, "get_state", `{"model":{"name":"pi-4"},"thinkingLevel":"high"}`)
	event := nextWireEvent(t, sub)
	state := inst.StateCopy()
	if event.Evt != EvtStateChanged || state.Model != "pi-4" || state.Thinking != "high" {
		t.Fatalf("state metadata not merged: event=%+v state=%+v", event, state)
	}
	wireResponse(t, fp, inst, "get_state", `{"model":{"id":"fallback-id"}}`)
	nextWireEvent(t, sub)
	if state = inst.StateCopy(); state.Model != "fallback-id" {
		t.Fatalf("model id fallback not merged: %+v", state)
	}
	wireResponse(t, fp, inst, "get_session_stats", `{"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextUsage":{"tokens":42000,"contextWindow":200000}}`)
	nextWireEvent(t, sub)
	state = inst.StateCopy()
	if state.InputTokens == nil || *state.InputTokens != 0 ||
		state.OutputTokens == nil || *state.OutputTokens != 0 ||
		state.CacheReadTokens == nil || *state.CacheReadTokens != 0 ||
		state.CacheWriteTokens == nil || *state.CacheWriteTokens != 0 ||
		state.ContextUsedTokens == nil || *state.ContextUsedTokens != 42000 ||
		state.ContextWindowTokens == nil || *state.ContextWindowTokens != 200000 {
		t.Fatalf("stats metadata not merged: %+v", state)
	}
	wireResponse(t, fp, inst, "get_commands", `{"commands":[{"source":"skill","name":"one","path":"/secret"},{"source":"extension","name":"nope"},{"source":"skill","name":"one"},{"source":"skill","name":"two"}]}`)
	nextWireEvent(t, sub)
	state = inst.StateCopy()
	if len(state.Skills) != 2 || state.Skills[0] != "one" || state.Skills[1] != "two" {
		t.Fatalf("skills metadata not filtered: %+v", state.Skills)
	}
}

func TestMetadataStatsUnknownContextAndResponses(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	wireResponse(t, fp, inst, "get_session_stats", `{"tokens":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4},"contextUsage":{"tokens":42000,"contextWindow":200000}}`)
	nextWireEvent(t, sub)
	wireResponse(t, fp, inst, "get_session_stats", `{"tokens":{"input":11,"output":12,"cacheRead":13,"cacheWrite":14}}`)
	nextWireEvent(t, sub)
	state := inst.StateCopy()
	if state.ContextUsedTokens != nil || state.ContextWindowTokens != nil {
		t.Fatalf("omitted context usage should clear cached context: %+v", state)
	}
	if state.InputTokens == nil || *state.InputTokens != 11 ||
		state.OutputTokens == nil || *state.OutputTokens != 12 ||
		state.CacheReadTokens == nil || *state.CacheReadTokens != 13 ||
		state.CacheWriteTokens == nil || *state.CacheWriteTokens != 14 {
		t.Fatalf("independent token values were not preserved: %+v", state)
	}
	wireResponse(t, fp, inst, "get_session_stats", `{"tokens":{"input":11,"output":12,"cacheRead":13,"cacheWrite":14},"contextUsage":{"tokens":42000,"contextWindow":null}}`)
	nextWireEvent(t, sub)
	state = inst.StateCopy()
	if state.ContextUsedTokens == nil || *state.ContextUsedTokens != 42000 {
		t.Fatalf("known context usage should be merged: %+v", state)
	}
	if state.ContextWindowTokens != nil {
		t.Fatalf("null context window should remain unknown: %+v", state)
	}
}

func TestMetadataEmptySkillsAndSettledRefresh(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	wireResponse(t, fp, inst, "get_commands", `{"commands":[]}`)
	nextWireEvent(t, sub)
	if state := inst.StateCopy(); state.Skills == nil || len(state.Skills) != 0 {
		t.Fatalf("empty successful skill list should be []: %#v", state.Skills)
	}
	go func() { _, _ = fp.stdoutW.Write([]byte(`{"type":"agent_start"}` + "\n")) }()
	nextWireEvent(t, sub)
	go func() { _, _ = fp.stdoutW.Write([]byte(`{"type":"agent_end"}` + "\n")) }()
	select {
	case event := <-sub.Channel():
		t.Fatalf("agent_end must not emit a state event: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	select {
	case command := <-fp.commands:
		if command["type"] == "get_session_stats" {
			t.Fatal("agent_end must not refresh stats")
		}
	case <-time.After(100 * time.Millisecond):
	}
	go func() { _, _ = fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")) }()
	nextWireEvent(t, sub)
	select {
	case command := <-fp.commands:
		if command["type"] != "get_session_stats" {
			t.Fatalf("unexpected settled refresh: %#v", command)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent_settled did not refresh stats")
	}
}

func TestMessageUpdateDataNotAliasedToScannerBuffer(t *testing.T) {
	fp := newFakeProc()
	m := NewManager()
	m.spawnFn = func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	}
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/d"})
	if err != nil {
		t.Fatal(err)
	}
	sub := inst.Subscribe()

	// First line: unique marker so we can detect buffer aliasing.
	firstLine := []byte(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ORIGINAL_FIRST_LINE_MARKER_DO_NOT_OVERWRITE"}}`)

	// Build >256 events and >64KiB total of valid JSONL.
	var buf bytes.Buffer
	buf.Write(firstLine)
	buf.WriteByte('\n')
	const fillerCount = 1200
	for i := 0; i < fillerCount; i++ {
		line := fmt.Sprintf(
			`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"filler-%d"}}`,
			i)
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	if buf.Len() <= 64*1024 {
		t.Fatalf("test setup: payload only %d bytes, need >64KiB", buf.Len())
	}

	go func() {
		_, _ = fp.stdoutW.Write(buf.Bytes())
		_ = fp.stdoutW.Close()
	}()

	// Drain the subscriber. The channel is closed either by overflow (default
	// case in Broadcast when cap 256 is full) or by OnExit after EOF.
	deadline := time.After(5 * time.Second)
	var events []Event
drain:
	for {
		select {
		case e, ok := <-sub.Channel():
			if !ok {
				break drain
			}
			events = append(events, e)
		case <-deadline:
			t.Fatal("drain timed out")
		}
	}

	// Locate the FIRST message_update event in arrival order.
	var firstMU *Event
	for i := range events {
		if events[i].Evt == EvtMessageUpdate {
			firstMU = &events[i]
			break
		}
	}
	if firstMU == nil {
		t.Fatal("no message_update events observed")
	}

	// Probe: the FIRST message_update's Data must still equal the original
	// raw line. If wire.go aliased the scanner buffer, the bytes have been
	// overwritten by subsequent Scan calls and this comparison fails.
	raw, ok := firstMU.Data.(json.RawMessage)
	if !ok {
		t.Fatalf("first message_update Data is %T, want json.RawMessage", firstMU.Data)
	}
	if !bytes.Equal(raw, firstLine) {
		t.Fatalf("first message_update data aliased to scanner buffer:\n got: %s\nwant: %s", raw, firstLine)
	}

	// Probe the wire-format shape (assistantMessageEvent wrapper).
	var probe struct {
		AssistantMessageEvent json.RawMessage `json:"assistantMessageEvent"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("first message_update data did not unmarshal: %v", err)
	}

	// Every non-nil Data event must round-trip through json without error.
	// Aliasing would surface here as invalid JSON from the corrupted RawMessage.
	for i := range events {
		if events[i].Data == nil {
			continue
		}
		encoded, err := json.Marshal(events[i].Data)
		if err != nil {
			t.Fatalf("event[%d] (%s) data did not marshal: %v", i, events[i].Evt, err)
		}
		var v any
		if err := json.Unmarshal(encoded, &v); err != nil {
			t.Fatalf("event[%d] (%s) data round-trip failed: %v\nencoded: %s", i, events[i].Evt, err, encoded)
		}
	}
}

// TestMessageEndPreservesToolResultEnvelope is a regression for the
// chat-pi pairing bug: pi's ToolResultMessage carries toolCallId /
// toolName / isError at the envelope level (rpc.md), and the Message
// struct used to strip them — so the UI could never pair a result with
// its tool call and bash blocks stayed "running…" forever.
func TestMessageEndPreservesToolResultEnvelope(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	isErr := true
	go func() {
		_, _ = fp.stdoutW.Write([]byte(
			`{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"total 48"}],"details":{"diff":"-1 old\n+1 new"},"isError":true,"extra":"not-snapshot-content"}}` + "\n"))
	}()
	e := <-sub.Channel()
	if e.Evt != EvtMessageEnd {
		t.Fatalf("want messageEnd, got %+v", e)
	}
	messages := inst.SnapshotCopy().Messages
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	msg := messages[0]
	if msg.Role != "toolResult" || msg.ToolCallId != "call_123" || msg.ToolName != "bash" {
		t.Fatalf("envelope pairing fields lost: %+v", msg)
	}
	if msg.IsError == nil || *msg.IsError != isErr {
		t.Fatalf("isError lost: %+v", msg.IsError)
	}
	if got, want := string(msg.Content), `[{"type":"text","text":"total 48"}]`; got != want {
		t.Fatalf("snapshot content = %s, want normalized content %s", got, want)
	}
	if got, want := string(msg.Details), `{"diff":"-1 old\n+1 new"}`; got != want {
		t.Fatalf("snapshot details = %s, want %s", got, want)
	}
	// The wire event data must also carry the full raw envelope.
	encoded, err := json.Marshal(e.Data)
	if err != nil {
		t.Fatalf("event data did not marshal: %v", err)
	}
	var data struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(encoded, &data); err != nil {
		t.Fatalf("event data did not unmarshal: %v", err)
	}
	var envelope struct {
		ToolCallId string `json:"toolCallId"`
	}
	if err := json.Unmarshal(data.Message, &envelope); err != nil {
		t.Fatalf("event message envelope did not unmarshal: %v", err)
	}
	if envelope.ToolCallId != "call_123" {
		t.Fatalf("event envelope toolCallId lost: %q", envelope.ToolCallId)
	}
	if !strings.Contains(string(data.Message), `"extra":"not-snapshot-content"`) {
		t.Fatalf("event envelope lost unrelated raw fields: %s", data.Message)
	}
}

func TestMessageContentAndDetailsAreDeepCopiedAcrossPublishAndSnapshot(t *testing.T) {
	inst := &Instance{ID: "copy", subs: newSubscriberSet()}
	content := json.RawMessage(`[{"type":"text","text":"saved"}]`)
	details := json.RawMessage(`{"diff":"old"}`)
	inst.Emit(EvtMessageEnd, &Message{Role: "toolResult", Content: content, Details: details}, nil)

	content[0] = 'x'
	details[0] = 'x'
	got := inst.SnapshotCopy().Messages[0]
	if string(got.Content) != `[{"type":"text","text":"saved"}]` {
		t.Fatalf("published content was aliased: %s", got.Content)
	}
	if string(got.Details) != `{"diff":"old"}` {
		t.Fatalf("published details were aliased: %s", got.Details)
	}

	got.Content[0] = 'x'
	got.Details[0] = 'x'
	again := inst.SnapshotCopy().Messages[0]
	if string(again.Content) != `[{"type":"text","text":"saved"}]` {
		t.Fatalf("SnapshotCopy content was aliased: %s", again.Content)
	}
	if string(again.Details) != `{"diff":"old"}` {
		t.Fatalf("SnapshotCopy details were aliased: %s", again.Details)
	}
}

// TestMessageEndCapturesStopReasonAndErrorMessage covers the Milestone 1
// probe retention: the message_end probe struct now reads stopReason and
// errorMessage from pi's envelope and copies them into the snapshot
// Message so the chat-pi frontend can render the red row / per-tool
// error text without parsing pi's wire format itself.
func TestMessageEndCapturesStopReasonAndErrorMessage(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	go func() {
		_, _ = fp.stdoutW.Write([]byte(
			`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"error","errorMessage":"rate limit"}}` + "\n"))
	}()
	event := nextWireEvent(t, sub)
	if event.Evt != EvtMessageEnd {
		t.Fatalf("want messageEnd, got %+v", event)
	}
	messages := inst.SnapshotCopy().Messages
	if len(messages) != 1 {
		t.Fatalf("want 1 message, got %d", len(messages))
	}
	if messages[0].StopReason != "error" {
		t.Fatalf("StopReason lost: %q", messages[0].StopReason)
	}
	if messages[0].ErrorMessage != "rate limit" {
		t.Fatalf("ErrorMessage lost: %q", messages[0].ErrorMessage)
	}
	// Raw passthrough on the data side carries the full envelope so the
	// chat-pi client can also read stopReason / errorMessage from
	// ev.data.message without parsing the snapshot message itself.
	encoded, err := json.Marshal(event.Data)
	if err != nil {
		t.Fatalf("event data did not marshal: %v", err)
	}
	var data struct {
		Message struct {
			StopReason   string `json:"stopReason"`
			ErrorMessage string `json:"errorMessage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(encoded, &data); err != nil {
		t.Fatalf("event data did not unmarshal: %v", err)
	}
	if data.Message.StopReason != "error" || data.Message.ErrorMessage != "rate limit" {
		t.Fatalf("event envelope lost stopReason/errorMessage: %+v", data.Message)
	}
}

// TestPassthroughEventsAdvanceSequenceWithoutMutatingSnapshot pins down
// the Milestone 1 contract for the six new error/control events:
//   - each maps to its named sequenced Evt (autoRetryStart, autoRetryEnd,
//     extensionError, summarizationRetryScheduled, summarizationRetryFinished)
//   - each is a raw passthrough (msg=nil): the snapshot messages list is
//     unchanged and only lastSeq advances
//   - compaction_end is its own case (handled above) and is NOT covered here
func TestPassthroughEventsAdvanceSequenceWithoutMutatingSnapshot(t *testing.T) {
	cases := []struct {
		piEvent string
		phiEvt  string
		line    string
	}{
		{
			piEvent: "auto_retry_start",
			phiEvt:  EvtAutoRetryStart,
			line:    `{"type":"auto_retry_start","attempt":1,"maxAttempts":3}`,
		},
		{
			piEvent: "auto_retry_end",
			phiEvt:  EvtAutoRetryEnd,
			line:    `{"type":"auto_retry_end","success":false,"finalError":"boom"}`,
		},
		{
			piEvent: "extension_error",
			phiEvt:  EvtExtensionError,
			line:    `{"type":"extension_error","error":"x"}`,
		},
		{
			piEvent: "summarization_retry_scheduled",
			phiEvt:  EvtSummarizationRetryScheduled,
			line:    `{"type":"summarization_retry_scheduled","attempt":1}`,
		},
		{
			piEvent: "summarization_retry_finished",
			phiEvt:  EvtSummarizationRetryFinished,
			line:    `{"type":"summarization_retry_finished"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.piEvent, func(t *testing.T) {
			fp, inst, sub := wireFixture(t)
			if _, err := fp.stdoutW.Write([]byte(tc.line + "\n")); err != nil {
				t.Fatal(err)
			}
			event := nextWireEvent(t, sub)
			if event.Evt != tc.phiEvt {
				t.Fatalf("%s did not publish %s: got %+v", tc.piEvent, tc.phiEvt, event)
			}
			if len(inst.SnapshotCopy().Messages) != 0 {
				t.Fatalf("%s must not mutate snapshot messages: %+v", tc.piEvent, inst.SnapshotCopy().Messages)
			}
			if event.Seq != inst.SnapshotCopy().LastSeq {
				t.Fatalf("%s seq %d does not match snapshot lastSeq %d", tc.piEvent, event.Seq, inst.SnapshotCopy().LastSeq)
			}
			// Raw passthrough: data is the full JSONL line, mutable.
			raw, ok := event.Data.(json.RawMessage)
			if !ok {
				t.Fatalf("%s data type = %T, want json.RawMessage", tc.piEvent, event.Data)
			}
			if !strings.Contains(string(raw), `"type":"`+tc.piEvent+`"`) {
				t.Fatalf("%s raw payload lost type field: %s", tc.piEvent, raw)
			}
		})
	}
}

// TestCompactionEndOrderingEmitsCompactionEndBeforeTranscriptReset is a
// tighter Milestone 1 ordering test: the chat-pi client renders
// compaction-end error/aborted UI off the EvtCompactionEnd payload
// before the snapshot is cleared, so the ordering invariant matters.
// Specifically: EvtCompactionEnd.seq + 1 == EvtTranscriptReset.seq, and
// after the pair snapshot.Messages is empty.
func TestCompactionEndOrderingEmitsCompactionEndBeforeTranscriptReset(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	if _, err := fp.stdoutW.Write([]byte(`{"type":"compaction_end","reason":"auto","errorMessage":"provider 500"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	first := nextWireEvent(t, sub)
	if first.Evt != EvtCompactionEnd {
		t.Fatalf("first event must be compactionEnd, got %+v", first)
	}
	second := nextWireEvent(t, sub)
	if second.Evt != EvtTranscriptReset {
		t.Fatalf("second event must be transcriptReset, got %+v", second)
	}
	if second.Seq != first.Seq+1 {
		t.Fatalf("transcriptReset seq %d must be compactionEnd seq %d + 1", second.Seq, first.Seq)
	}
	if len(inst.SnapshotCopy().Messages) != 0 {
		t.Fatalf("compaction_end must clear snapshot messages: %+v", inst.SnapshotCopy().Messages)
	}
	// compactionEnd carries the original JSONL line so the client can
	// read reason / errorMessage / aborted without re-parsing pi's
	// wire format.
	raw, ok := first.Data.(json.RawMessage)
	if !ok {
		t.Fatalf("compactionEnd data type = %T, want json.RawMessage", first.Data)
	}
	if !strings.Contains(string(raw), `"errorMessage":"provider 500"`) {
		t.Fatalf("compactionEnd raw payload lost errorMessage: %s", raw)
	}
}
