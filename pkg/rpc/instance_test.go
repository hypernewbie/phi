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
	if !i.retainExtensionUIDialog(ExtensionUIDialog{ID: "dialog-a", Method: "select", Title: "A", CreatedAt: 1}) ||
		!i.retainExtensionUIDialog(ExtensionUIDialog{ID: "dialog-b", Method: "confirm", Title: "B", CreatedAt: 2}) {
		t.Fatal("failed to retain test dialogs")
	}
	sub := i.Subscribe()
	i.OnExit("crash")
	first := <-sub.Channel()
	second := <-sub.Channel()
	third := <-sub.Channel() // readable: dialog close broadcasts precede rpcExited
	if first.Evt != EvtExtensionUIClosed || second.Evt != EvtExtensionUIClosed || third.Evt != EvtRpcExited {
		t.Fatalf("exit event order = %+v, %+v, %+v", first, second, third)
	}
	for _, event := range []Event{first, second} {
		data, _ := json.Marshal(event.Data)
		if !strings.Contains(string(data), `"reason":"childExit"`) {
			t.Fatalf("dialog close reason = %s", data)
		}
	}
	if got := len(i.ExtensionUIDialogsCopy()); got != 0 {
		t.Fatalf("dialogs remained after exit: %d", got)
	}
	i.OnExit("again") // idempotent
	// CloseAll runs on the first OnExit, so a second call cannot broadcast.
	if got := len(sub.Channel()); got != 0 {
		t.Fatalf("unexpected buffered events after idempotent OnExit: %d", got)
	}
}

func TestExtensionUIResponseFirstAnswerWins(t *testing.T) {
	fp, inst, _ := wireFixture(t)
	if !inst.retainExtensionUIDialog(ExtensionUIDialog{ID: "answer-once", Method: "input", Title: "Value"}) {
		t.Fatal("failed to retain dialog")
	}
	results := make(chan struct {
		resolved bool
		err      error
	}, 2)
	for _, value := range []string{"first", "second"} {
		go func(value string) {
			resolved, err := inst.ResolveExtensionUIDialog("answer-once", &value, nil, false)
			results <- struct {
				resolved bool
				err      error
			}{resolved, err}
		}(value)
	}
	resolved := 0
	for index := 0; index < 2; index++ {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.resolved {
			resolved++
		}
	}
	if resolved != 1 {
		t.Fatalf("resolved answers = %d, want exactly one", resolved)
	}
	command := nextInstanceCommand(t, fp)
	if command["type"] != "extension_ui_response" || command["id"] != "answer-once" {
		t.Fatalf("dialog response command = %#v", command)
	}
	select {
	case duplicate := <-fp.commands:
		t.Fatalf("second dialog response was written: %#v", duplicate)
	case <-time.After(100 * time.Millisecond):
	}
}

func nextInstanceCommand(t *testing.T, fp *fakeProc) map[string]any {
	t.Helper()
	select {
	case command := <-fp.commands:
		return command
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for instance command")
		return nil
	}
}

func TestExtensionUIResponseDoesNotWaitBehindControlGate(t *testing.T) {
	writer := newByteWiseWriter()
	inst := testInstanceWithWriter(writer)
	if !inst.retainExtensionUIDialog(ExtensionUIDialog{ID: "not-gated", Method: "confirm", Title: "Continue"}) {
		t.Fatal("failed to retain dialog")
	}
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
	confirmed := true
	result := make(chan error, 1)
	go func() {
		_, err := inst.ResolveExtensionUIDialog("not-gated", nil, &confirmed, false)
		result <- err
	}()
	select {
	case line := <-writer.records:
		var response map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(line), &response); err != nil {
			t.Fatal(err)
		}
		if response["type"] != "extension_ui_response" || response["confirmed"] != true {
			t.Fatalf("direct dialog response = %#v", response)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("dialog response waited behind control gate")
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	close(release)
}

func TestExtensionUITimeoutAndLateAnswer(t *testing.T) {
	_, inst, sub := wireFixture(t)
	if !inst.retainExtensionUIDialog(ExtensionUIDialog{ID: "timeout", Method: "select", Title: "Pick", Timeout: 20}) {
		t.Fatal("failed to retain timeout dialog")
	}
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-sub.Channel():
			if event.Evt != EvtExtensionUIClosed {
				continue
			}
			data, _ := json.Marshal(event.Data)
			if string(data) != `{"id":"timeout","reason":"timeout"}` {
				t.Fatalf("timeout close data = %s", data)
			}
			resolved, err := inst.ResolveExtensionUIDialog("timeout", nil, nil, true)
			if err != nil || resolved {
				t.Fatalf("late timeout answer = resolved:%v err:%v", resolved, err)
			}
			return
		case <-deadline:
			t.Fatal("dialog timeout did not emit close event")
		}
	}
}

func TestExtensionUIEditorHasNoSyntheticTimeout(t *testing.T) {
	_, inst, sub := wireFixture(t)
	if !inst.retainExtensionUIDialog(ExtensionUIDialog{ID: "editor", Method: "editor", Title: "Edit", Timeout: 10}) {
		t.Fatal("failed to retain editor dialog")
	}
	select {
	case event := <-sub.Channel():
		t.Fatalf("editor received synthetic timeout event: %+v", event)
	case <-time.After(40 * time.Millisecond):
	}
	value := "done"
	resolved, err := inst.ResolveExtensionUIDialog("editor", &value, nil, false)
	if err != nil || !resolved {
		t.Fatalf("editor answer = resolved:%v err:%v", resolved, err)
	}
}

func TestExtensionUICancelOnChildExit(t *testing.T) {
	fp, inst, sub := wireFixture(t)
	if !inst.retainExtensionUIDialog(ExtensionUIDialog{ID: "exit-dialog", Method: "confirm", Title: "Exit"}) {
		t.Fatal("failed to retain exit dialog")
	}
	inst.OnExit("child-exit")
	first := <-sub.Channel()
	second := <-sub.Channel()
	if first.Evt != EvtExtensionUIClosed || second.Evt != EvtRpcExited {
		t.Fatalf("child exit events = %+v, %+v", first, second)
	}
	select {
	case command := <-fp.commands:
		t.Fatalf("child exit wrote dialog response: %#v", command)
	case <-time.After(100 * time.Millisecond):
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

func TestQueuePromptWriteDoesNotWaitBehindControlGate(t *testing.T) {
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
	item, err := inst.SubmitQueue(context.Background(), "queued", "epoch", "queued prompt", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.State != QueueSending {
		t.Fatalf("queue item state = %q, want sending", item.State)
	}
	select {
	case line := <-writer.records:
		var prompt map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(line), &prompt); err != nil {
			t.Fatal(err)
		}
		if prompt["type"] != "prompt" || prompt["message"] != "queued prompt" {
			t.Fatalf("queue prompt write = %#v", prompt)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("queue prompt waited behind control gate")
	}
	close(release)
	inst.OnExit("test-queue-write")
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
