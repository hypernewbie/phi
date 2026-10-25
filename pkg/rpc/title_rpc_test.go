package rpc

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

// titleFixture spawns an instance with preloaded messages so the request
// fallback can be seeded the way a resumed session seeds it.
func titleFixture(t *testing.T, initial []Message) (*fakeProc, *Instance, *Subscriber) {
	t.Helper()
	fp := newFakeProc()
	m := NewManagerWithSpawner(func(SpawnOptions) (Cmd, WriteCloser, ReadCloser, error) {
		return fp, fp.stdinW, fp.stdoutR, nil
	})
	inst, err := m.Spawn(SpawnOptions{Cwd: "/w/d", InitialMessages: initial})
	if err != nil {
		t.Fatal(err)
	}
	return fp, inst, inst.Subscribe()
}

// nextStateTitle consumes the next event and returns its published title.
func nextStateTitle(t *testing.T, sub *Subscriber) string {
	t.Helper()
	event := nextWireEvent(t, sub)
	if event.Evt != EvtStateChanged {
		t.Fatalf("expected a state event, got %+v", event)
	}
	state, ok := event.Data.(State)
	if !ok {
		t.Fatalf("state event data = %T, want State", event.Data)
	}
	return state.Title
}

// writePiLine writes one raw pi stdout line.
func writePiLine(t *testing.T, fp *fakeProc, line string) {
	t.Helper()
	if _, err := fp.stdoutW.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
}

// wireRaw answers one correlated request with a caller-supplied response body.
func wireRaw(t *testing.T, fp *fakeProc, inst *Instance, command, body string) {
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
	id, _ := request["id"].(string)
	writePiLine(t, fp, fmt.Sprintf(`{"type":"response","id":%q,"command":%q,%s}`, id, command, body))
	select {
	case <-result:
	case <-ctx.Done():
		t.Fatal("request did not complete")
	}
}

func TestRPCTitleNativeOrdering(t *testing.T) {
	fp, inst, sub := wireFixture(t)

	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Native one","pendingMessageCount":2}`)
	if got := nextStateTitle(t, sub); got != "Native one" {
		t.Fatalf("initial hydration title = %q, want %q", got, "Native one")
	}
	if got := inst.TitleCopy(); got != "Native one" {
		t.Fatalf("TitleCopy = %q after hydration", got)
	}
	if state := inst.StateCopy(); state.Title != "Native one" || state.QueueDepth != 2 {
		t.Fatalf("hydrated state = %+v", state)
	}

	writePiLine(t, fp, `{"type":"session_info_changed","name":"  Native two  "}`)
	if got := nextStateTitle(t, sub); got != "Native two" {
		t.Fatalf("native event title = %q, want trimmed %q", got, "Native two")
	}

	// A repeated equal name publishes nothing.
	writePiLine(t, fp, `{"type":"session_info_changed","name":"Native two"}`)
	select {
	case event := <-sub.Channel():
		t.Fatalf("an equal native name republished state: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRPCTitleSources(t *testing.T) {
	fp, inst, sub := titleFixture(t, []Message{
		{Role: "assistant", Content: json.RawMessage(`"not a request"`)},
		{Role: "user", Content: json.RawMessage(`"Summarize the repo"`)},
	})
	if got := inst.StateCopy().Title; got != "Summarize the repo" {
		t.Fatalf("seeded fallback title = %q", got)
	}

	// A snapshot without a name keeps the fallback.
	wireResponse(t, fp, inst, "get_state", `{}`)
	if got := nextStateTitle(t, sub); got != "Summarize the repo" {
		t.Fatalf("nameless hydration title = %q", got)
	}

	// A native name wins over the fallback.
	writePiLine(t, fp, `{"type":"session_info_changed","name":"Native wins"}`)
	if got := nextStateTitle(t, sub); got != "Native wins" {
		t.Fatalf("native title = %q", got)
	}

	// An explicit native clear selects the retained fallback.
	writePiLine(t, fp, `{"type":"session_info_changed"}`)
	if got := nextStateTitle(t, sub); got != "Summarize the repo" {
		t.Fatalf("cleared native title = %q, want the fallback", got)
	}

	// A later user turn cannot replace a useful fallback.
	writePiLine(t, fp, `{"type":"message_end","message":{"role":"user","content":"Second request"}}`)
	if event := nextWireEvent(t, sub); event.Evt != EvtMessageEnd {
		t.Fatalf("expected message_end, got %+v", event)
	}
	select {
	case event := <-sub.Channel():
		t.Fatalf("a later user turn changed the fallback: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}

	// A blank or non-string name never clears a valid one.
	writePiLine(t, fp, `{"type":"session_info_changed","name":"Keep me"}`)
	if got := nextStateTitle(t, sub); got != "Keep me" {
		t.Fatalf("native title = %q", got)
	}
	writePiLine(t, fp, `{"type":"session_info_changed","name":42}`)
	select {
	case event := <-sub.Channel():
		t.Fatalf("a non-string name changed the title: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if got := inst.TitleCopy(); got != "Keep me" {
		t.Fatalf("title after malformed name = %q", got)
	}
}

func TestRPCTitleInitialSeedOnce(t *testing.T) {
	fp, inst, sub := wireFixture(t)

	wireResponse(t, fp, inst, "get_state", `{"sessionName":"First"}`)
	if got := nextStateTitle(t, sub); got != "First" {
		t.Fatalf("first seed = %q", got)
	}

	// Later snapshots update ordinary metadata only.
	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Second","pendingMessageCount":3}`)
	if got := nextStateTitle(t, sub); got != "First" {
		t.Fatalf("a later snapshot rewrote the native name: %q", got)
	}
	if state := inst.StateCopy(); state.QueueDepth != 3 {
		t.Fatalf("later snapshot dropped ordinary metadata: %+v", state)
	}
}

func TestRPCTitleClearNotRestored(t *testing.T) {
	fp, inst, sub := titleFixture(t, []Message{
		{Role: "user", Content: json.RawMessage(`"Fallback request"`)},
	})

	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Named"}`)
	if got := nextStateTitle(t, sub); got != "Named" {
		t.Fatalf("seed = %q", got)
	}

	writePiLine(t, fp, `{"type":"session_info_changed"}`)
	if got := nextStateTitle(t, sub); got != "Fallback request" {
		t.Fatalf("clear = %q", got)
	}

	// The cleared name must not come back from a later snapshot.
	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Named"}`)
	if got := nextStateTitle(t, sub); got != "Fallback request" {
		t.Fatalf("a later snapshot restored a cleared name: %q", got)
	}

	// A JSON null payload cannot change the title, and it publishes nothing.
	wireResponse(t, fp, inst, "get_state", `null`)
	select {
	case event := <-sub.Channel():
		t.Fatalf("a null snapshot published state: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if got := inst.TitleCopy(); got != "Fallback request" {
		t.Fatalf("a null snapshot changed the title: %q", got)
	}
}

func TestRPCTitleResetBoundary(t *testing.T) {
	fp, inst, sub := titleFixture(t, []Message{
		{Role: "user", Content: json.RawMessage(`"Old request"`)},
	})

	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Before reset"}`)
	if got := nextStateTitle(t, sub); got != "Before reset" {
		t.Fatalf("seed = %q", got)
	}

	// A rejected reset preserves both sources and publishes only its rejection.
	wireRaw(t, fp, inst, "new_session", `"success":false,"error":"refused"`)
	if event := nextWireEvent(t, sub); event.Evt != EvtStateChanged {
		t.Fatalf("expected the rejection notice, got %+v", event)
	}
	if got := inst.TitleCopy(); got != "Before reset" {
		t.Fatalf("rejected reset changed the title: %q", got)
	}

	// A cancelled reset preserves both sources and publishes nothing.
	wireRaw(t, fp, inst, "new_session", `"success":true,"data":{"cancelled":true}`)
	select {
	case event := <-sub.Channel():
		t.Fatalf("a cancelled reset published state: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if got := inst.TitleCopy(); got != "Before reset" {
		t.Fatalf("cancelled reset changed the title: %q", got)
	}

	// An accepted reset clears both sources and publishes the generic label
	// before the transcript reset.
	wireResponse(t, fp, inst, "new_session", `{}`)
	if got := nextStateTitle(t, sub); got != "Pi RPC · d" {
		t.Fatalf("accepted reset title = %q", got)
	}
	if event := nextWireEvent(t, sub); event.Evt != EvtTranscriptReset {
		t.Fatalf("reset did not clear the transcript after the title: %+v", event)
	}

	// A later user turn refills the fallback once.
	writePiLine(t, fp, `{"type":"message_end","message":{"role":"user","content":"After reset"}}`)
	if event := nextWireEvent(t, sub); event.Evt != EvtMessageEnd {
		t.Fatalf("expected message_end, got %+v", event)
	}
	if got := nextStateTitle(t, sub); got != "After reset" {
		t.Fatalf("post-reset fallback = %q", got)
	}

	// A failed metadata refresh after the reset cannot undo it or clear a
	// useful title.
	wireResponse(t, fp, inst, "get_state", `{"model":42}`)
	select {
	case event := <-sub.Channel():
		t.Fatalf("a malformed refresh published state: %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	if got := inst.TitleCopy(); got != "After reset" {
		t.Fatalf("a malformed refresh changed the title: %q", got)
	}

	// Compaction preserves both sources and the event order.
	writePiLine(t, fp, `{"type":"compaction_end"}`)
	if event := nextWireEvent(t, sub); event.Evt != EvtCompactionEnd {
		t.Fatalf("expected compactionEnd, got %+v", event)
	}
	if event := nextWireEvent(t, sub); event.Evt != EvtTranscriptReset {
		t.Fatalf("expected transcriptReset after compaction, got %+v", event)
	}
	if got := inst.TitleCopy(); got != "After reset" {
		t.Fatalf("compaction changed the title: %q", got)
	}
}

func TestRPCTitleConcurrentControlOrder(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Answer every request in arrival order. A rename emits its native event
	// before its response, exactly as pi does.
	var receiptMu sync.Mutex
	var receipt []string
	var responder sync.WaitGroup
	responder.Add(1)
	stop := make(chan struct{})
	go func() {
		defer responder.Done()
		for {
			select {
			case <-stop:
				return
			case request, ok := <-fp.commands:
				if !ok {
					return
				}
				id, _ := request["id"].(string)
				command, _ := request["type"].(string)
				switch command {
				case "set_session_name":
					name, _ := request["name"].(string)
					receiptMu.Lock()
					receipt = append(receipt, name)
					receiptMu.Unlock()
					_, _ = fmt.Fprintf(fp.stdoutW,
						"{\"type\":\"session_info_changed\",\"name\":%q}\n", name)
					_, _ = fmt.Fprintf(fp.stdoutW,
						"{\"type\":\"response\",\"id\":%q,\"command\":%q,\"success\":true,\"data\":{}}\n",
						id, command)
				default:
					_, _ = fmt.Fprintf(fp.stdoutW,
						"{\"type\":\"response\",\"id\":%q,\"command\":%q,\"success\":true,\"data\":{\"sessionName\":\"Hydrated\",\"pendingMessageCount\":2}}\n",
						id, command)
				}
			}
		}
	}()

	start := make(chan struct{})
	var ops sync.WaitGroup
	for i := 0; i < 4; i++ {
		name := fmt.Sprintf("Name %d", i)
		for _, command := range []string{"get_state", "set_session_name"} {
			ops.Add(1)
			go func(command, name string) {
				defer ops.Done()
				<-start
				_, err := inst.WithControl(ctx, func(requestCtx context.Context) (any, error) {
					before := inst.SnapshotCopy().LastSeq
					fields := map[string]any(nil)
					if command == "set_session_name" {
						fields = map[string]any{"name": name}
					}
					if _, err := inst.Request(requestCtx, command, fields); err != nil {
						return nil, err
					}
					if command != "set_session_name" {
						return nil, nil
					}
					// Still inside the gate: the rename must have published exactly
					// one state, and that state must carry the requested name.
					if advance := inst.SnapshotCopy().LastSeq - before; advance != 1 {
						t.Errorf("rename %q published %d states, want 1", name, advance)
					}
					if got := inst.TitleCopy(); got != name {
						t.Errorf("title inside the gate = %q, want %q", got, name)
					}
					return nil, nil
				})
				if err != nil {
					t.Errorf("%s failed: %v", command, err)
				}
			}(command, name)
		}
	}
	close(start)
	ops.Wait()

	// Sequences stay monotonic across every published state.
	var lastSeq uint64
	for {
		select {
		case event := <-sub.Channel():
			if event.Seq <= lastSeq {
				t.Fatalf("publication went backwards: %d after %d", event.Seq, lastSeq)
			}
			lastSeq = event.Seq
			continue
		default:
		}
		break
	}

	receiptMu.Lock()
	want := append([]string(nil), receipt...)
	receiptMu.Unlock()
	if len(want) == 0 {
		t.Fatal("no rename was acknowledged")
	}

	final := inst.TitleCopy()
	if final != want[len(want)-1] {
		t.Fatalf("final title = %q, want the last acknowledged %q", final, want[len(want)-1])
	}

	// A paired snapshot/state read agrees, and a later hydrate at the
	// acknowledged name keeps it along with the numeric metadata.
	close(stop)
	responder.Wait()
	if _, paired := inst.SnapshotStateCopy(); paired.Title != final {
		t.Fatalf("paired state title = %q, want %q", paired.Title, final)
	}
	wireResponse(t, fp, inst, "get_state", `{"sessionName":"Hydrated","pendingMessageCount":2}`)
	snapshot, state := inst.SnapshotStateCopy()
	if snapshot.LastSeq == 0 || state.Title != final {
		t.Fatalf("hydrate regressed the acknowledged title: %+v", state)
	}
	if state.QueueDepth != 2 {
		t.Fatalf("numeric metadata lost: %+v", state)
	}

	inst.Kill()
	responder.Wait()
}
