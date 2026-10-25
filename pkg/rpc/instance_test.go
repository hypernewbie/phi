package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSeqMonotonic(t *testing.T) {
	i := &Instance{ID: "x", subs: newSubscriberSet()}
	sub := i.Subscribe()
	i.Emit("one", nil, nil)
	i.Emit("two", nil, nil)
	i.Emit("three", nil, nil)
	a, b, c := (<-sub.Channel()).Seq, (<-sub.Channel()).Seq, (<-sub.Channel()).Seq
	if !(a < b && b < c) {
		t.Fatalf("not monotonic: %d %d %d", a, b, c)
	}
}

func TestEmitAppendsMessageAndSeq(t *testing.T) {
	i := &Instance{ID: "x", subs: newSubscriberSet()}
	sub := i.Subscribe()
	i.Emit(EvtMessageEnd, &Message{Role: "assistant", Content: []byte(`"hi"`)}, nil)
	snap := i.SnapshotCopy()
	if len(snap.Messages) != 1 || snap.LastSeq != 1 {
		t.Fatalf("bad snapshot: %+v", snap)
	}
	e := <-sub.Channel()
	if e.Seq != 1 || e.Evt != EvtMessageEnd {
		t.Fatalf("bad event: %+v", e)
	}
}

func TestOnExitBroadcastsBeforeClose(t *testing.T) {
	i := &Instance{ID: "x", subs: newSubscriberSet()}
	sub := i.Subscribe()
	i.OnExit("crash")
	e := <-sub.Channel() // readable: broadcast precedes CloseAll
	if e.Evt != EvtRpcExited {
		t.Fatalf("want rpcExited, got %+v", e)
	}
	i.OnExit("again") // idempotent
	// CloseAll runs on the first OnExit, so the channel is closed; a receive
	// on a closed channel returns the zero value immediately. Check the buffer
	// length instead: a second broadcast would have queued an event before
	// the close.
	if got := len(sub.Channel()); got != 0 {
		t.Fatalf("unexpected buffered events after idempotent OnExit: %d", got)
	}
}

func TestResetTranscriptClearsMessages(t *testing.T) {
	i := &Instance{ID: "x", subs: newSubscriberSet()}
	i.Emit(EvtMessageEnd, &Message{Role: "user", Content: []byte(`"a"`)}, nil)
	i.ResetTranscript()
	if got := i.SnapshotCopy().Messages; len(got) != 0 {
		t.Fatalf("want empty, got %d", len(got))
	}
}

func TestScanLinesNoCR(t *testing.T) {
	adv, tok, err := ScanLinesNoCR([]byte("hi\r\n"), false)
	if err != nil || adv != 4 || string(tok) != "hi" {
		t.Fatalf("adv=%d tok=%q err=%v", adv, tok, err)
	}
	adv, tok, err = ScanLinesNoCR([]byte("hi\n"), false)
	if err != nil || adv != 3 || string(tok) != "hi" {
		t.Fatalf("adv=%d tok=%q err=%v", adv, tok, err)
	}
}

func TestLineScanner(t *testing.T) {
	s := NewLineScanner(io.NopCloser(strings.NewReader("{\"a\":1}\n{\"b\":2}\n")))
	for want := 0; want < 2; want++ {
		line, ok, err := s.Next()
		if err != nil || !ok {
			t.Fatalf("line %d: ok=%v err=%v", want, ok, err)
		}
		if len(line) == 0 {
			t.Fatalf("line %d empty", want)
		}
	}
	if _, ok, _ := s.Next(); ok {
		t.Fatal("expected EOF")
	}
}

type byteWiseWriter struct {
	mu      sync.Mutex
	data    bytes.Buffer
	records chan []byte
}

func newByteWiseWriter() *byteWiseWriter {
	return &byteWiseWriter{records: make(chan []byte, 512)}
}

func (w *byteWiseWriter) Close() error { return nil }

func (w *byteWiseWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		w.mu.Lock()
		_ = w.data.WriteByte(b)
		w.mu.Unlock()
		runtime.Gosched()
	}
	w.records <- append([]byte(nil), p...)
	return len(p), nil
}

func (w *byteWiseWriter) bytesCopy() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.data.Bytes()...)
}

func testInstanceWithWriter(w WriteCloser) *Instance {
	return &Instance{
		ID:      "test-instance",
		stdin:   w,
		alive:   true,
		pending: make(map[string]*pendingWaiter),
		subs:    newSubscriberSet(),
		snap:    &Snapshot{Messages: []Message{}},
	}
}

func TestConcurrentPromptAndControlWritesAreWholeJSONLines(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
	const writes = 160
	var group sync.WaitGroup
	for i := 0; i < writes; i++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			var err error
			if index%2 == 0 {
				err = inst.SendPrompt(map[string]any{"type": "prompt", "message": index})
			} else {
				err = inst.Send(map[string]any{"type": "control", "index": index})
			}
			if err != nil {
				t.Errorf("write %d: %v", index, err)
			}
		}(i)
	}
	group.Wait()

	lines := bytes.Split(bytes.TrimSpace(writer.bytesCopy()), []byte{'\n'})
	if len(lines) != writes {
		t.Fatalf("got %d JSONL records, want %d", len(lines), writes)
	}
	for index, line := range lines {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("record %d was interleaved: %v; line=%q", index, err, line)
		}
	}
}

func TestResetGenerationRejectsInterveningPromptBeforeNewSessionWrite(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
	expected := inst.PromptWriteGeneration()
	if err := inst.SendPrompt(map[string]any{"type": "prompt", "message": "intervening"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := inst.RequestAfterPromptGeneration(ctx, expected, "new_session", nil); !errors.Is(err, ErrPromptChanged) {
		t.Fatalf("want ErrPromptChanged, got %v", err)
	}
	if got := len(writer.records); got != 1 {
		t.Fatalf("new_session was written after generation changed: %d records", got)
	}
}

func TestPromptAfterAtomicNewSessionWriteIsPreserved(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
	expected := inst.PromptWriteGeneration()
	result := make(chan error, 1)
	go func() {
		_, err := inst.RequestAfterPromptGeneration(context.Background(), expected, "new_session", nil)
		result <- err
	}()

	requestLine := <-writer.records
	var request map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(requestLine), &request); err != nil {
		t.Fatal(err)
	}
	id, ok := request["id"].(string)
	if !ok || id == "" || request["type"] != "new_session" {
		t.Fatalf("unexpected new_session request: %#v", request)
	}
	promptDone := make(chan error, 1)
	go func() {
		promptDone <- inst.SendPrompt(map[string]any{"type": "prompt", "message": "after-reset-write"})
	}()
	promptLine := <-writer.records
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	var prompt map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(promptLine), &prompt); err != nil {
		t.Fatal(err)
	}
	if prompt["type"] != "prompt" || prompt["message"] != "after-reset-write" {
		t.Fatalf("prompt was not preserved after atomic reset write: %#v", prompt)
	}

	waiter := inst.claimWaiter(id)
	if waiter == nil {
		t.Fatal("new_session waiter was not registered")
	}
	waiter.result <- pendingResult{response: piResponse{
		ID: id, Command: "new_session", Success: true, Data: json.RawMessage(`{"cancelled":false}`),
	}}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("new_session request failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("new_session request did not complete")
	}
}

func TestRequestTimeoutAndExitRemovePendingWaiters(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := inst.Request(ctx, "get_state", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want request timeout, got %v", err)
	}
	inst.pendingMu.Lock()
	pending := len(inst.pending)
	inst.pendingMu.Unlock()
	if pending != 0 {
		t.Fatalf("timeout left %d pending waiters", pending)
	}

	inst = testInstanceWithWriter(writer)
	requestDone := make(chan error, 1)
	go func() {
		_, err := inst.Request(context.Background(), "get_state", nil)
		requestDone <- err
	}()
	<-writer.records
	inst.OnExit("test-exit")
	select {
	case err := <-requestDone:
		if !errors.Is(err, ErrNotAlive) {
			t.Fatalf("want ErrNotAlive after exit, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("exit did not unblock pending request")
	}
	inst.pendingMu.Lock()
	pending = len(inst.pending)
	inst.pendingMu.Unlock()
	if pending != 0 {
		t.Fatalf("exit left %d pending waiters", pending)
	}
}

func TestControlGateDoesNotDelayPromptWrite(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
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
	promptDone := make(chan error, 1)
	go func() { promptDone <- inst.SendPrompt(map[string]any{"type": "prompt", "message": "not-gated"}) }()
	select {
	case line := <-writer.records:
		var prompt map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(line), &prompt); err != nil || prompt["message"] != "not-gated" {
			t.Fatalf("prompt write while control gate held = %s err=%v", line, err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("prompt waited behind control gate")
	}
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	close(release)
}

func TestControlGateTimeoutDoesNotRunSecondOperation(t *testing.T) {
	inst := testInstanceWithWriter(newByteWiseWriter())
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
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	run := false
	_, err := inst.WithControl(ctx, func(context.Context) (any, error) {
		run = true
		return nil, nil
	})
	if !errors.Is(err, context.DeadlineExceeded) || run {
		t.Fatalf("second gated operation ran or returned wrong error: ran=%v err=%v", run, err)
	}
	close(release)
}

func nextStateEvent(t *testing.T, sub *Subscriber) Event {
	t.Helper()
	select {
	case event, ok := <-sub.Channel():
		if !ok {
			t.Fatal("subscription closed before the expected event")
		}
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a state event")
		return Event{}
	}
}

func TestStateTransactionDetachedMetadata(t *testing.T) {
	i := &Instance{ID: "detached", subs: newSubscriberSet()}
	inputValues := [6]int64{0, 1, 2, 3, 4, 5}
	input := State{
		InputTokens:         &inputValues[0],
		OutputTokens:        &inputValues[1],
		ContextUsedTokens:   &inputValues[2],
		ContextWindowTokens: &inputValues[3],
		CacheReadTokens:     &inputValues[4],
		CacheWriteTokens:    &inputValues[5],
		Skills:              []string{"one", "two"},
	}
	i.initState(input)
	inputRefs := []*int64{input.InputTokens, input.OutputTokens, input.ContextUsedTokens, input.ContextWindowTokens, input.CacheReadTokens, input.CacheWriteTokens}
	for index := range inputValues {
		inputValues[index] = 100 + int64(index)
	}
	input.Skills[0] = "mutated input"

	state := i.StateCopy()
	stateRefs := []*int64{state.InputTokens, state.OutputTokens, state.ContextUsedTokens, state.ContextWindowTokens, state.CacheReadTokens, state.CacheWriteTokens}
	for index, ref := range stateRefs {
		if ref == inputRefs[index] || *ref != int64(index) {
			t.Fatalf("StateCopy token %d = %v (%p), want detached value %d", index, *ref, ref, index)
		}
	}
	if state.Skills[0] != "one" {
		t.Fatalf("StateCopy skills aliased initState input: %v", state.Skills)
	}
	for index, ref := range stateRefs {
		*ref = 200 + int64(index)
	}
	state.Skills[0] = "mutated output"
	state = i.StateCopy()
	for index, ref := range []*int64{state.InputTokens, state.OutputTokens, state.ContextUsedTokens, state.ContextWindowTokens, state.CacheReadTokens, state.CacheWriteTokens} {
		if *ref != int64(index) {
			t.Fatalf("mutating StateCopy changed retained token %d to %d", index, *ref)
		}
	}
	if state.Skills[0] != "one" {
		t.Fatalf("mutating StateCopy changed retained skills: %v", state.Skills)
	}

	sub := i.Subscribe()
	publicationValues := [6]int64{10, 11, 12, 13, 14, 15}
	publicationSkills := []string{"published"}
	if !i.updateState(func(current *State) bool {
		current.InputTokens = &publicationValues[0]
		current.OutputTokens = &publicationValues[1]
		current.ContextUsedTokens = &publicationValues[2]
		current.ContextWindowTokens = &publicationValues[3]
		current.CacheReadTokens = &publicationValues[4]
		current.CacheWriteTokens = &publicationValues[5]
		current.Skills = publicationSkills
		return true
	}) {
		t.Fatal("metadata update was not published")
	}
	event := nextStateEvent(t, sub)
	published, ok := event.Data.(State)
	if !ok {
		t.Fatalf("stateChanged data type = %T, want State", event.Data)
	}
	publishedRefs := []*int64{published.InputTokens, published.OutputTokens, published.ContextUsedTokens, published.ContextWindowTokens, published.CacheReadTokens, published.CacheWriteTokens}
	retained := i.StateCopy()
	retainedRefs := []*int64{retained.InputTokens, retained.OutputTokens, retained.ContextUsedTokens, retained.ContextWindowTokens, retained.CacheReadTokens, retained.CacheWriteTokens}
	for index, ref := range publishedRefs {
		if ref == &publicationValues[index] || ref == retainedRefs[index] || *ref != 10+int64(index) {
			t.Fatalf("published token %d was not separately detached: value=%d event=%p retained=%p", index, *ref, ref, retainedRefs[index])
		}
		if retainedRefs[index] == &publicationValues[index] || *retainedRefs[index] != 10+int64(index) {
			t.Fatalf("retained token %d aliased transaction input: value=%d", index, *retainedRefs[index])
		}
	}
	if published.Skills[0] != "published" || retained.Skills[0] != "published" || &published.Skills[0] == &retained.Skills[0] || &retained.Skills[0] == &publicationSkills[0] {
		t.Fatalf("skills were not detached across input, retained state, and event: event=%v retained=%v", published.Skills, retained.Skills)
	}
	for index := range publicationValues {
		publicationValues[index] = 300 + int64(index)
	}
	publicationSkills[0] = "mutated transaction input"
	for index, ref := range publishedRefs {
		if *ref != 10+int64(index) {
			t.Fatalf("mutating transaction input changed event token %d to %d", index, *ref)
		}
	}
	if published.Skills[0] != "published" {
		t.Fatalf("mutating transaction input changed event skills: %v", published.Skills)
	}
	*published.InputTokens = 400
	published.Skills[0] = "mutated event"
	retained = i.StateCopy()
	if *retained.InputTokens != 10 || retained.Skills[0] != "published" {
		t.Fatalf("mutating event payload changed retained state: %+v", retained)
	}

	zero := int64(0)
	emptySkills := []string{}
	i.initState(State{OutputTokens: &zero, CacheReadTokens: &zero, Skills: emptySkills})
	nilEmpty := i.StateCopy()
	if nilEmpty.InputTokens != nil || nilEmpty.ContextUsedTokens != nil || nilEmpty.ContextWindowTokens != nil || nilEmpty.CacheWriteTokens != nil {
		t.Fatalf("nil token pointers were not preserved: %+v", nilEmpty)
	}
	if nilEmpty.OutputTokens == &zero || nilEmpty.CacheReadTokens == &zero || *nilEmpty.OutputTokens != 0 || *nilEmpty.CacheReadTokens != 0 {
		t.Fatalf("zero token pointers were not detached and preserved: %+v", nilEmpty)
	}
	if nilEmpty.Skills == nil || len(nilEmpty.Skills) != 0 {
		t.Fatalf("empty skills slice was not preserved: %#v", nilEmpty.Skills)
	}
	if !i.updateState(func(current *State) bool {
		current.Model = "nil-zero-empty"
		return true
	}) {
		t.Fatal("nil/zero/empty update was not published")
	}
	lastEvent := nextStateEvent(t, sub)
	publishedEmpty := lastEvent.Data.(State)
	if publishedEmpty.InputTokens != nil || publishedEmpty.ContextUsedTokens != nil || publishedEmpty.ContextWindowTokens != nil || publishedEmpty.CacheWriteTokens != nil || publishedEmpty.OutputTokens == nil || *publishedEmpty.OutputTokens != 0 || publishedEmpty.Skills == nil || len(publishedEmpty.Skills) != 0 {
		t.Fatalf("event did not preserve nil, zero, and empty metadata: %+v", publishedEmpty)
	}
}

func TestStateTransactionPublicationOrder(t *testing.T) {
	i := &Instance{ID: "ordered", subs: newSubscriberSet()}
	sub := i.Subscribe()
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	firstEntered := make(chan struct{})
	updatesDone := make(chan bool, 2)
	go func() {
		updatesDone <- i.updateState(func(state *State) bool {
			close(firstEntered)
			<-release
			state.Title = "first"
			return true
		})
	}()
	select {
	case <-firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first transaction did not enter")
	}
	secondStarted := make(chan struct{})
	go func() {
		close(secondStarted)
		updatesDone <- i.updateState(func(state *State) bool {
			state.Model = "second"
			return true
		})
	}()
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("second transaction did not start")
	}
	unblock()
	for range 2 {
		select {
		case changed := <-updatesDone:
			if !changed {
				t.Fatal("transaction was not committed")
			}
		case <-time.After(time.Second):
			t.Fatal("state transactions deadlocked")
		}
	}
	first, second := nextStateEvent(t, sub), nextStateEvent(t, sub)
	firstState, firstOK := first.Data.(State)
	secondState, secondOK := second.Data.(State)
	if first.Seq != 1 || second.Seq != 2 || first.Evt != EvtStateChanged || second.Evt != EvtStateChanged {
		t.Fatalf("events do not follow transaction commit order: first=%+v second=%+v", first, second)
	}
	if !firstOK || firstState.Title != "first" || firstState.Model != "" {
		t.Fatalf("first event did not capture first commit: %+v", first.Data)
	}
	if !secondOK || secondState.Title != "first" || secondState.Model != "second" {
		t.Fatalf("second event lost the prior commit: %+v", second.Data)
	}
	final := i.StateCopy()
	if final.Title != "first" || final.Model != "second" {
		t.Fatalf("final state lost independent updates: %+v", final)
	}
}

func TestStateTransactionPairedSnapshotRead(t *testing.T) {
	const iterations = 500
	i := &Instance{ID: "paired", subs: newSubscriberSet()}
	start := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		<-start
		for range iterations {
			i.updateState(func(state *State) bool {
				state.QueueDepth = int(i.seq + 1)
				return true
			})
			i.Emit(EvtMessageEnd, &Message{Role: "user", Content: json.RawMessage(`"boundary"`)}, nil)
		}
	}()
	close(start)
	deadline := time.Now().Add(10 * time.Second)
	var lastSeq uint64
	for {
		snapshot, state := i.SnapshotStateCopy()
		if snapshot.LastSeq < lastSeq {
			t.Fatalf("paired snapshot sequence regressed: %d after %d", snapshot.LastSeq, lastSeq)
		}
		lastSeq = snapshot.LastSeq
		messageCount := uint64(len(snapshot.Messages))
		marker := uint64(state.QueueDepth)
		if marker > snapshot.LastSeq || snapshot.LastSeq-marker > 1 {
			t.Fatalf("paired state/cursor crossed a boundary: marker=%d snapshot=%+v", marker, snapshot)
		}
		if marker == 0 {
			if messageCount != 0 || snapshot.LastSeq != 0 {
				t.Fatalf("initial state did not pair with initial snapshot: state=%+v snapshot=%+v", state, snapshot)
			}
		} else if marker != 2*messageCount-1 && marker != 2*messageCount+1 {
			t.Fatalf("paired state and transcript have different boundaries: state=%+v snapshot=%+v", state, snapshot)
		}
		select {
		case <-writerDone:
			finalSnapshot, finalState := i.SnapshotStateCopy()
			if len(finalSnapshot.Messages) != iterations || finalSnapshot.LastSeq != 2*iterations || finalState.QueueDepth != 2*iterations-1 {
				t.Fatalf("final state/snapshot boundary mismatch: state=%+v snapshot=%+v", finalState, finalSnapshot)
			}
			return
		default:
			if time.Now().After(deadline) {
				t.Fatalf("paired read loop did not observe writer completion: lastSeq=%d", lastSeq)
			}
		}
	}
}

func TestStateTransactionTitleAfterExit(t *testing.T) {
	i := &Instance{ID: "exited", Title: "before", subs: newSubscriberSet()}
	i.initState(State{Title: "before", Status: "live"})
	i.OnExit("test")
	i.SetTitle("late rename")
	if got := i.TitleCopy(); got != "before" {
		t.Fatalf("late SetTitle changed retained title: %q", got)
	}
	state := i.StateCopy()
	if state.Title != "before" || state.Status != "exited" {
		t.Fatalf("late SetTitle changed exited State: %+v", state)
	}
	if snapshot := i.SnapshotCopy(); snapshot.LastSeq != 1 {
		t.Fatalf("late SetTitle published after exit: snapshot=%+v", snapshot)
	}
}

func TestStateTransactionConcurrentExitIsTerminal(t *testing.T) {
	i := &Instance{ID: "exit", Title: "before", alive: true, subs: newSubscriberSet()}
	i.initState(State{Sid: "exit", Title: "before", Status: "live"})
	sub := i.Subscribe()
	waiter, err := i.registerWaiter("exit-pending", "get_state")
	if err != nil {
		t.Fatal(err)
	}

	titles := []string{"one", "two", "three", "four"}
	start := make(chan struct{})
	returned := make(chan struct{}, len(titles))
	for _, title := range titles {
		go func(title string) {
			<-start
			i.SetTitle(title)
			returned <- struct{}{}
		}(title)
	}
	close(start)
	i.OnExit("test")

	select {
	case result := <-waiter.result:
		if !errors.Is(result.err, ErrNotAlive) {
			t.Fatalf("pending request survived exit: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("pending request was not failed by exit")
	}
	for range titles {
		select {
		case <-returned:
		case <-time.After(2 * time.Second):
			t.Fatal("late title transaction did not return")
		}
	}

	var seen []Event
	deadline := time.After(2 * time.Second)
	for open := true; open; {
		select {
		case event, ok := <-sub.Channel():
			if !ok {
				open = false
				break
			}
			seen = append(seen, event)
		case <-deadline:
			t.Fatal("exit did not close subscribers")
		}
	}
	if len(seen) == 0 || seen[len(seen)-1].Evt != EvtRpcExited {
		t.Fatalf("exit event is not the final publication: %+v", seen)
	}
	for _, event := range seen[:len(seen)-1] {
		if event.Evt == EvtRpcExited {
			t.Fatalf("exit published more than once: %+v", seen)
		}
	}

	state := i.StateCopy()
	if state.Status != "exited" || state.Title != i.TitleCopy() {
		t.Fatalf("exit left inconsistent titles or a live status: %+v title=%q", state, i.TitleCopy())
	}
	sequence := i.SnapshotCopy().LastSeq
	if i.updateState(func(current *State) bool {
		current.Title = "revived"
		return true
	}) {
		t.Fatal("state transaction was accepted after exit")
	}
	i.SetTitle("revived")
	if after := i.SnapshotCopy().LastSeq; after != sequence {
		t.Fatalf("a late transaction published after exit: %d came after %d", after, sequence)
	}
	if final := i.StateCopy(); final.Status != "exited" || final.Title == "revived" || i.TitleCopy() == "revived" {
		t.Fatalf("exit was not terminal: %+v title=%q", final, i.TitleCopy())
	}
}
