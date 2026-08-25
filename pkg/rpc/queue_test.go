package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func queueFixture(t *testing.T) (*fakeProc, *Instance, *Subscriber) {
	t.Helper()
	fp, inst, sub := wireFixture(t)
	t.Cleanup(inst.Kill)
	return fp, inst, sub
}

func nextQueueCommand(t *testing.T, fp *fakeProc) map[string]any {
	t.Helper()
	select {
	case command := <-fp.commands:
		return command
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for queue command")
		return nil
	}
}

func writeQueueResponse(t *testing.T, fp *fakeProc, command map[string]any, success bool, message string, data string) {
	t.Helper()
	id, ok := command["id"].(string)
	if !ok || id == "" {
		t.Fatalf("queue command has no id: %#v", command)
	}
	if data == "" {
		data = "null"
	}
	errorField := ""
	if message != "" {
		errorField = fmt.Sprintf(`,"error":%q`, message)
	}
	line := fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":%t,"data":%s%s}`+"\n", id, command["type"], success, data, errorField)
	if _, err := fp.stdoutW.Write([]byte(line)); err != nil {
		t.Fatal(err)
	}
}

func queueItemByID(t *testing.T, inst *Instance, id string) QueueItem {
	t.Helper()
	for _, item := range inst.QueueSnapshotCopy().Items {
		if item.ID == id {
			return item
		}
	}
	t.Fatalf("queue item %q not found in %+v", id, inst.QueueSnapshotCopy().Items)
	return QueueItem{}
}

func waitQueueState(t *testing.T, inst *Instance, id string, want QueueState) QueueItem {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		item := queueItemByID(t, inst, id)
		if item.State == want {
			return item
		}
		time.Sleep(time.Millisecond)
	}
	item := queueItemByID(t, inst, id)
	t.Fatalf("queue item %q state = %q, want %q; item=%+v", id, item.State, want, item)
	return item
}

func assertNoQueueCommand(t *testing.T, fp *fakeProc) {
	t.Helper()
	select {
	case command := <-fp.commands:
		t.Fatalf("unexpected second queue command: %#v", command)
	case <-time.After(100 * time.Millisecond):
	}
}

type queueImageResolver struct {
	attachments []QueueAttachment
	released    []string
}

func (r *queueImageResolver) ResolveAttachments(_ context.Context, _ string, _ string, _ string, _ string, refs []string) ([]QueueAttachment, error) {
	out := make([]QueueAttachment, len(refs))
	for index, ref := range refs {
		for _, attachment := range r.attachments {
			if attachment.Ref == ref {
				out[index] = cloneQueueItem(QueueItem{Attachments: []QueueAttachment{attachment}}).Attachments[0]
				break
			}
		}
		if out[index].Ref == "" {
			return nil, fmt.Errorf("unknown ref %s", ref)
		}
	}
	return out, nil
}

func (r *queueImageResolver) ReleaseAttachments(_ context.Context, _ string, _ string, _ string, _ string, refs []string) error {
	r.released = append(r.released, refs...)
	return nil
}

func (r *queueImageResolver) CopyAttachments(_ context.Context, _ string, _ string, _ string, _ string, source []QueueAttachment) ([]QueueAttachment, error) {
	out := make([]QueueAttachment, len(source))
	for index, attachment := range source {
		out[index] = attachment
		out[index].Ref = attachment.Ref + "-copy"
	}
	return out, nil
}

type blockingReleaseResolver struct {
	queueImageResolver
	entered chan struct{}
	unblock chan struct{}
}

func (r *blockingReleaseResolver) ReleaseAttachments(ctx context.Context, owner, sid, epoch, itemID string, refs []string) error {
	select {
	case <-r.entered:
	default:
		close(r.entered)
	}
	select {
	case <-r.unblock:
	case <-ctx.Done():
		return ctx.Err()
	}
	r.released = append(r.released, refs...)
	return nil
}

func TestQueueSubmitIncludesOrderedImages(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{
		{Ref: "ref-a", Name: "a.png", MimeType: "image/png", SizeBytes: 2, Data: []byte{1, 2}},
		{Ref: "ref-b", Name: "b.jpg", MimeType: "image/jpeg", SizeBytes: 2, Data: []byte{3, 4}},
	}}
	if _, err := inst.SubmitQueue(context.Background(), "images", epoch, "look", QueuePrompt, []string{"ref-a", "ref-b"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	command := nextQueueCommand(t, fp)
	images, ok := command["images"].([]any)
	if !ok || len(images) != 2 {
		t.Fatalf("images payload=%#v", command["images"])
	}
	for index, want := range []struct{ mime, data string }{{"image/png", "AQI="}, {"image/jpeg", "AwQ="}} {
		image, ok := images[index].(map[string]any)
		if !ok || image["type"] != "image" || image["mimeType"] != want.mime || image["data"] != want.data {
			t.Fatalf("image[%d]=%#v", index, images[index])
		}
	}
	encoded, _ := json.Marshal(queueItemByID(t, inst, "images"))
	if strings.Contains(string(encoded), "AQI=") || strings.Contains(string(encoded), "AwQ=") {
		t.Fatalf("queue metadata exposed image bytes: %s", encoded)
	}
	writeQueueResponse(t, fp, command, true, "", `{}`)
	waitQueueState(t, inst, "images", QueueAccepted)
	discarded, err := inst.QueueDiscard("images", epoch, QueueSubmitOptions{Owner: "owner", Resolver: resolver})
	if err != nil || discarded["discarded"] != false {
		t.Fatalf("accepted image item was discarded: result=%v err=%v", discarded, err)
	}
}

func TestQueueClaimReleasesAtAgentSettled(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "settled-ref", Name: "settled.png", MimeType: "image/png", Data: []byte{1, 2, 3},
	}}}
	if _, err := inst.SubmitQueue(context.Background(), "settled", epoch, "keep image", QueuePrompt, []string{"settled-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	command := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, command, true, "", `{}`)
	waitQueueState(t, inst, "settled", QueueAccepted)
	if len(resolver.released) != 0 {
		t.Fatalf("accepted queue claim released before settlement: %v", resolver.released)
	}
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	waitQueueState(t, inst, "settled", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "settled-ref" {
		t.Fatalf("settled claim releases=%v", resolver.released)
	}
	statsCommand := nextQueueCommand(t, fp)
	if statsCommand["type"] != "get_session_stats" {
		t.Fatalf("settled refresh command = %#v", statsCommand)
	}
	writeQueueResponse(t, fp, statsCommand, true, "", `{}`)
}

func TestQueueAcceptanceAfterSettlementConsumesAndPumps(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "race-ref", Name: "race.png", MimeType: "image/png", Data: []byte{1, 2, 3},
	}}}

	// Hold the initial dispatcher so both records can be prepared without
	// relying on goroutine scheduling for the ordering proof below.
	inst.queueMu.Lock()
	inst.queueSending = true
	inst.queueMu.Unlock()
	first, err := inst.SubmitQueue(context.Background(), "race-first", epoch, "first", QueuePrompt, []string{"race-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver})
	if err != nil {
		t.Fatal(err)
	}
	if first.State != QueueLocal {
		t.Fatalf("first queued state = %q, want local", first.State)
	}
	second, err := inst.SubmitQueue(context.Background(), "race-second", epoch, "second", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.State != QueueLocal {
		t.Fatalf("second queued state = %q, want local", second.State)
	}

	inst.queueMu.Lock()
	inst.queueSending = false
	nextID := inst.nextLocalQueueItemLocked()
	if inst.queueDispatchGenerations == nil {
		inst.queueDispatchGenerations = make(map[string]uint64)
	}
	// This test bypasses the transport to control response/settlement order;
	// model the completed prompt write that requestQueueItem records.
	inst.queueDispatchGenerations["race-first"] = inst.queueSettlementGeneration
	inst.queueMu.Unlock()
	if nextID != "race-first" {
		t.Fatalf("initial dispatch = %q, want race-first", nextID)
	}

	// Parse a successful Pi response, then agent_settled, while deliberately
	// deferring finishQueueAcceptance, the completion path after Request's
	// waiter resumes. Direct event handling keeps this ordering deterministic
	// instead of depending on the scheduler between two JSONL lines.
	waiter, err := inst.registerWaiter("race-acceptance")
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{}
	manager.handlePiEvent(inst, []byte(`{"type":"response","id":"race-acceptance","command":"prompt","success":true,"data":{}}`), piEvent{Type: "response"})
	manager.handlePiEvent(inst, []byte(`{"type":"agent_settled"}`), piEvent{Type: "agent_settled"})
	select {
	case result := <-waiter.result:
		if result.err != nil || !result.response.Success {
			t.Fatalf("acceptance response = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("successful acceptance was not parsed")
	}
	statsCommand := nextQueueCommand(t, fp)
	if statsCommand["type"] != "get_session_stats" {
		t.Fatalf("settled refresh command = %#v", statsCommand)
	}
	writeQueueResponse(t, fp, statsCommand, true, "", `{}`)

	inst.finishQueueAcceptance("race-first", false)
	first = waitQueueState(t, inst, "race-first", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "race-ref" {
		t.Fatalf("race claim releases = %v", resolver.released)
	}

	secondCommand := nextQueueCommand(t, fp)
	if secondCommand["type"] != "prompt" || secondCommand["message"] != "second" {
		t.Fatalf("pumped queue command = %#v", secondCommand)
	}
	writeQueueResponse(t, fp, secondCommand, true, "", `{}`)
	waitQueueState(t, inst, "race-second", QueueAccepted)
	inst.settleAcceptedQueueItems()
	waitQueueState(t, inst, "race-second", QueueConsumed)
	if got := inst.StateCopy().QueueDepth; got != 0 {
		t.Fatalf("queue depth after race and pump = %d, want 0", got)
	}
	if first.State != QueueConsumed {
		t.Fatalf("race item changed after pump = %q", first.State)
	}
}

func TestPromotedPromptSettlementBeforeResponseConsumesAndPumpsOnce(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "promoted-first-ref", Name: "promoted-first.png", MimeType: "image/png", Data: []byte{7, 8, 9},
	}}}

	// Model a rejected steer that has already been promoted, while keeping a
	// following local item behind the replacement prompt.
	inst.queueMu.Lock()
	inst.queueSending = true
	inst.queueMu.Unlock()
	if _, err := inst.SubmitQueue(context.Background(), "promoted-first", epoch, "replacement", QueueSteer, []string{"promoted-first-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	if _, err := inst.SubmitQueue(context.Background(), "promoted-following", epoch, "following", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	inst.queueMu.Lock()
	inst.queueSending = false
	if id := inst.nextLocalQueueItemLocked(); id != "promoted-first" {
		inst.queueMu.Unlock()
		t.Fatalf("dispatch id = %q, want promoted-first", id)
	}
	item := inst.queueItems["promoted-first"]
	item.State = QueuePromoted
	inst.queueItems[item.ID] = item
	delete(inst.queueDispatchGenerations, item.ID)
	inst.queueMu.Unlock()

	manager := &Manager{}
	done := make(chan struct{})
	go func() {
		inst.dispatchQueueItem("promoted-first", true)
		close(done)
	}()
	promotedCommand := nextQueueCommand(t, fp)
	if promotedCommand["type"] != "prompt" || promotedCommand["message"] != "replacement" {
		t.Fatalf("promoted prompt command = %#v", promotedCommand)
	}
	promotedID, ok := promotedCommand["id"].(string)
	if !ok || promotedID == "" {
		t.Fatalf("promoted prompt missing id: %#v", promotedCommand)
	}

	// The replacement prompt is written, then Pi settles before its correlated
	// response. Settlement must not consume or release the promoted claim.
	manager.handlePiEvent(inst, []byte(`{"type":"agent_settled"}`), piEvent{Type: "agent_settled"})
	if got := queueItemByID(t, inst, "promoted-first").State; got != QueuePromoted {
		t.Fatalf("promoted item settled before response as %q", got)
	}
	if len(resolver.released) != 0 {
		t.Fatalf("promoted claim released before response: %v", resolver.released)
	}
	inst.queueMu.Lock()
	stillSending := inst.queueSending
	inst.queueMu.Unlock()
	if !stillSending {
		t.Fatal("settlement cleared queueSending before promoted response")
	}

	respond := func(command map[string]any) {
		t.Helper()
		id, ok := command["id"].(string)
		if !ok || id == "" {
			t.Fatalf("command missing id: %#v", command)
		}
		line := fmt.Sprintf(`{"type":"response","id":%q,"command":%q,"success":true,"data":{}}`, id, command["type"])
		manager.handlePiEvent(inst, []byte(line), piEvent{Type: "response"})
	}
	respond(map[string]any{"id": promotedID, "type": promotedCommand["type"]})
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("promoted dispatch did not finish")
	}
	waitQueueState(t, inst, "promoted-first", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "promoted-first-ref" {
		t.Fatalf("promoted claim releases = %v", resolver.released)
	}

	// agent_settled also issues a stats refresh. Answer it while waiting for
	// the one and only pumped local prompt; either command may arrive first.
	var followingCommand map[string]any
	statsAnswered := false
	for followingCommand == nil || !statsAnswered {
		command := nextQueueCommand(t, fp)
		switch command["type"] {
		case "get_session_stats":
			if statsAnswered {
				t.Fatalf("duplicate settled stats refresh = %#v", command)
			}
			respond(command)
			statsAnswered = true
		case "prompt":
			if followingCommand != nil {
				t.Fatalf("duplicate pumped prompt = %#v", command)
			}
			followingCommand = command
		default:
			t.Fatalf("unexpected post-settlement command = %#v", command)
		}
	}
	if followingCommand["message"] != "following" {
		t.Fatalf("pumped prompt = %#v", followingCommand)
	}
	respond(followingCommand)
	waitQueueState(t, inst, "promoted-following", QueueAccepted)
	assertNoQueueCommand(t, fp)

	if followingCommand["message"] == "replacement" {
		t.Fatal("replacement prompt was written more than once")
	}
	inst.queueMu.Lock()
	_, tracked := inst.queueDispatchGenerations["promoted-first"]
	inst.queueMu.Unlock()
	if tracked {
		t.Fatal("promoted dispatch-generation tracking survived response settlement")
	}
}

func TestQueueSettlementBeforeNormalPromptWriteKeepsAcceptance(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "write-boundary-ref", Name: "write-boundary.png", MimeType: "image/png", Data: []byte{1, 2, 3},
	}}}

	// Enter sending without starting the goroutine. The settlement is now
	// known to precede the command's write boundary, while the write mutex
	// keeps the eventual JSONL write from happening early.
	inst.queueMu.Lock()
	inst.queueSending = true
	inst.queueMu.Unlock()
	if _, err := inst.SubmitQueue(context.Background(), "write-boundary", epoch, "write boundary", QueuePrompt, []string{"write-boundary-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	inst.queueMu.Lock()
	inst.queueSending = false
	if id := inst.nextLocalQueueItemLocked(); id != "write-boundary" {
		inst.queueMu.Unlock()
		t.Fatalf("dispatch id = %q, want write-boundary", id)
	}
	inst.queueMu.Unlock()

	inst.writeMu.Lock()
	inst.settleAcceptedQueueItems()
	done := make(chan struct{})
	go func() {
		inst.dispatchQueueItem("write-boundary", false)
		close(done)
	}()
	inst.writeMu.Unlock()

	command := nextQueueCommand(t, fp)
	if command["type"] != "prompt" || command["message"] != "write boundary" {
		t.Fatalf("write-boundary command = %#v", command)
	}
	writeQueueResponse(t, fp, command, true, "", `{}`)
	accepted := waitQueueState(t, inst, "write-boundary", QueueAccepted)
	if len(resolver.released) != 0 {
		t.Fatalf("pre-write settlement released accepted claim: %v", resolver.released)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("write-boundary dispatch did not finish")
	}
	if accepted.State != QueueAccepted {
		t.Fatalf("write-boundary item state = %q, want accepted", accepted.State)
	}

	inst.settleAcceptedQueueItems()
	waitQueueState(t, inst, "write-boundary", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "write-boundary-ref" {
		t.Fatalf("write-boundary release = %v", resolver.released)
	}
}

func TestQueueSettlementBeforePromotedPromptWriteKeepsAcceptance(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "promoted-write-ref", Name: "promoted-write.png", MimeType: "image/png", Data: []byte{4, 5, 6},
	}}}

	// The rejected steer has already been marked sending. A settlement during
	// that dispatch must advance the generation without consuming the item;
	// the state probe then promotes it before its prompt reaches Pi.
	inst.queueMu.Lock()
	inst.queueSending = true
	inst.queueMu.Unlock()
	if _, err := inst.SubmitQueue(context.Background(), "promoted-write", epoch, "promoted write", QueueSteer, []string{"promoted-write-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	inst.queueMu.Lock()
	inst.queueSending = false
	if id := inst.nextLocalQueueItemLocked(); id != "promoted-write" {
		inst.queueMu.Unlock()
		t.Fatalf("dispatch id = %q, want promoted-write", id)
	}
	item := inst.queueItems["promoted-write"]
	item.State = QueuePromoted
	inst.queueItems["promoted-write"] = item
	if inst.queueDispatchGenerations == nil {
		inst.queueDispatchGenerations = make(map[string]uint64)
	}
	// Model the rejected steer's already-written command, then remove its
	// generation exactly as finishQueueRejection does at promotion.
	inst.queueDispatchGenerations["promoted-write"] = inst.queueSettlementGeneration
	delete(inst.queueDispatchGenerations, "promoted-write")
	inst.queueSending = true
	inst.queueMu.Unlock()

	inst.writeMu.Lock()
	// This settlement is before the promoted prompt write. The missing
	// generation entry keeps the unwritten QueuePromoted item local.
	inst.settleAcceptedQueueItems()
	done := make(chan struct{})
	go func() {
		inst.dispatchQueueItem("promoted-write", true)
		close(done)
	}()
	inst.writeMu.Unlock()

	command := nextQueueCommand(t, fp)
	if command["type"] != "prompt" || command["message"] != "promoted write" {
		t.Fatalf("promoted write command = %#v", command)
	}
	writeQueueResponse(t, fp, command, true, "", `{}`)
	promoted := waitQueueState(t, inst, "promoted-write", QueueAccepted)
	if len(resolver.released) != 0 {
		t.Fatalf("pre-write settlement released promoted claim: %v", resolver.released)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("promoted write dispatch did not finish")
	}
	if promoted.State != QueueAccepted {
		t.Fatalf("promoted write item state = %q, want accepted", promoted.State)
	}
	inst.queueMu.Lock()
	stillSending := inst.queueSending
	inst.queueMu.Unlock()
	if stillSending {
		t.Fatal("promoted write left queueSending set")
	}
	assertNoQueueCommand(t, fp)

	inst.settleAcceptedQueueItems()
	waitQueueState(t, inst, "promoted-write", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "promoted-write-ref" {
		t.Fatalf("promoted write release = %v", resolver.released)
	}
}

func TestQueueSubmitIdempotentDuplicateSendsOnePiCommand(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	first, err := inst.SubmitQueue(context.Background(), "item-1", epoch, "hello", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != QueueSending {
		t.Fatalf("first item state = %q, want sending", first.State)
	}
	if got := inst.StateCopy().QueueDepth; got != 1 {
		t.Fatalf("queue depth after local creation = %d, want 1", got)
	}
	command := nextQueueCommand(t, fp)
	if command["type"] != "prompt" || command["message"] != "hello" {
		t.Fatalf("Pi command = %#v", command)
	}
	duplicate, err := inst.SubmitQueue(context.Background(), "item-1", epoch, "hello", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.ID != first.ID || duplicate.State != QueueSending {
		t.Fatalf("duplicate item = %+v, first=%+v", duplicate, first)
	}
	assertNoQueueCommand(t, fp)
	writeQueueResponse(t, fp, command, true, "", `{}`)
	accepted := waitQueueState(t, inst, "item-1", QueueAccepted)
	if accepted.Message != "hello" {
		t.Fatalf("accepted item lost message: %+v", accepted)
	}
	if len(inst.SnapshotCopy().Messages) != 0 {
		t.Fatalf("queue events mutated transcript snapshot: %+v", inst.SnapshotCopy().Messages)
	}
}

func TestQueueSubmitMismatchedDuplicateFails(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "item-1", epoch, "hello", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	command := nextQueueCommand(t, fp)
	if _, err := inst.SubmitQueue(context.Background(), "item-1", epoch, "different", QueuePrompt, nil); !errors.Is(err, ErrQueueItemMismatch) {
		t.Fatalf("mismatched duplicate error = %v", err)
	}
	writeQueueResponse(t, fp, command, true, "", `{}`)
	waitQueueState(t, inst, "item-1", QueueAccepted)
}

func TestQueueOnlyOneItemIsSending(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	first, err := inst.SubmitQueue(context.Background(), "item-1", epoch, "one", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	firstCommand := nextQueueCommand(t, fp)
	second, err := inst.SubmitQueue(context.Background(), "item-2", epoch, "two", QueueFollowUp, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != QueueSending || second.State != QueueLocal {
		t.Fatalf("queue states = first:%q second:%q", first.State, second.State)
	}
	writeQueueResponse(t, fp, firstCommand, true, "", `{}`)
	secondCommand := nextQueueCommand(t, fp)
	if secondCommand["type"] != "follow_up" {
		t.Fatalf("follow-up command = %#v", secondCommand)
	}
	waitQueueState(t, inst, "item-2", QueueSending)
	writeQueueResponse(t, fp, secondCommand, true, "", `{}`)
	waitQueueState(t, inst, "item-2", QueueAccepted)
}

func TestQueueRestoreCancelsOnlyLocalItem(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "sending", epoch, "in flight", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	firstCommand := nextQueueCommand(t, fp)
	if _, err := inst.SubmitQueue(context.Background(), "local", epoch, "restore me", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	result, err := inst.QueueRestore("local", epoch)
	if err != nil {
		t.Fatal(err)
	}
	if result["restored"] != true {
		t.Fatalf("local restore result = %#v", result)
	}
	waitQueueState(t, inst, "local", QueueCancelled)
	writeQueueResponse(t, fp, firstCommand, true, "", `{}`)
	waitQueueState(t, inst, "sending", QueueAccepted)
	assertNoQueueCommand(t, fp)
	piOwned, err := inst.QueueRestore("sending", epoch)
	if err != nil {
		t.Fatal(err)
	}
	if piOwned["restored"] != false || piOwned["reason"] != "pi-owned" {
		t.Fatalf("accepted restore result = %#v", piOwned)
	}
}

func TestQueueRestoreAtomicAgainstDispatch(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "sending", epoch, "in flight", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	firstCommand := nextQueueCommand(t, fp)
	resolver := &blockingReleaseResolver{
		queueImageResolver: queueImageResolver{attachments: []QueueAttachment{{Ref: "restore-ref", Name: "restore.png", MimeType: "image/png", Data: []byte{1}}}},
		entered:            make(chan struct{}),
		unblock:            make(chan struct{}),
	}
	if _, err := inst.SubmitQueue(context.Background(), "local", epoch, "restore", QueuePrompt, []string{"restore-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan map[string]any, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := inst.QueueRestore("local", epoch, QueueSubmitOptions{Owner: "owner", Resolver: resolver})
		resultCh <- result
		errCh <- err
	}()
	<-resolver.entered
	if got := queueItemByID(t, inst, "local").State; got != QueueCancelled {
		t.Fatalf("restore state while release blocked = %q, want cancelled", got)
	}
	writeQueueResponse(t, fp, firstCommand, true, "", `{}`)
	waitQueueState(t, inst, "sending", QueueAccepted)
	assertNoQueueCommand(t, fp)
	close(resolver.unblock)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if result := <-resultCh; result["restored"] != true {
		t.Fatalf("restore result=%#v", result)
	}
}

func TestQueueDiscardAtomicAgainstDispatch(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "sending", epoch, "in flight", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	firstCommand := nextQueueCommand(t, fp)
	resolver := &blockingReleaseResolver{
		queueImageResolver: queueImageResolver{attachments: []QueueAttachment{{Ref: "discard-ref", Name: "discard.png", MimeType: "image/png", Data: []byte{1}}}},
		entered:            make(chan struct{}),
		unblock:            make(chan struct{}),
	}
	if _, err := inst.SubmitQueue(context.Background(), "local", epoch, "discard", QueuePrompt, []string{"discard-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	resultCh := make(chan map[string]any, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := inst.QueueDiscard("local", epoch, QueueSubmitOptions{Owner: "owner", Resolver: resolver})
		resultCh <- result
		errCh <- err
	}()
	<-resolver.entered
	if got := queueItemByID(t, inst, "local").State; got != QueueCancelled {
		t.Fatalf("discard state while release blocked = %q, want cancelled", got)
	}
	writeQueueResponse(t, fp, firstCommand, true, "", `{}`)
	waitQueueState(t, inst, "sending", QueueAccepted)
	assertNoQueueCommand(t, fp)
	close(resolver.unblock)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if result := <-resultCh; result["discarded"] != true {
		t.Fatalf("discard result=%#v", result)
	}
}

func TestQueueAcceptedConsumedAndCancelledTransitions(t *testing.T) {
	fp, inst, sub := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "accepted", epoch, "settle me", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	acceptedCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, acceptedCommand, true, "", `{}`)
	waitQueueState(t, inst, "accepted", QueueAccepted)
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	waitQueueState(t, inst, "accepted", QueueConsumed)
	if got := inst.StateCopy().QueueDepth; got != 0 {
		t.Fatalf("queue depth after consumption = %d, want 0", got)
	}
	// agent_settled also schedules a stats refresh. Answer that fixture
	// command before the next queue command so the response cannot be
	// mistaken for the prompt rejection below.
	statsCommand := nextQueueCommand(t, fp)
	if statsCommand["type"] != "get_session_stats" {
		t.Fatalf("settled refresh command = %#v", statsCommand)
	}
	writeQueueResponse(t, fp, statsCommand, true, "", `{}`)

	if _, err := inst.SubmitQueue(context.Background(), "cancelled", epoch, "reject me", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	cancelCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, cancelCommand, false, "rejected", `null`)
	waitQueueState(t, inst, "cancelled", QueueCancelled)
	if got := len(sub.Channel()); got == 0 {
		t.Fatal("queue transitions did not publish events")
	}
}

func TestQueueRejectedSteerPromotesOnceWhenPiSettled(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	state := inst.StateCopy()
	state.Busy = true
	inst.SetState(state)
	if _, err := inst.SubmitQueue(context.Background(), "steer-1", epoch, "late steer", QueueSteer, nil); err != nil {
		t.Fatal(err)
	}
	steerCommand := nextQueueCommand(t, fp)
	if steerCommand["type"] != "steer" {
		t.Fatalf("steer command = %#v", steerCommand)
	}
	writeQueueResponse(t, fp, steerCommand, false, "not busy", `null`)
	getStateCommand := nextQueueCommand(t, fp)
	if getStateCommand["type"] != "get_state" {
		t.Fatalf("promotion state probe = %#v", getStateCommand)
	}
	writeQueueResponse(t, fp, getStateCommand, true, "", `{"isStreaming":false,"isCompacting":false}`)
	promoted := waitQueueState(t, inst, "steer-1", QueuePromoted)
	if promoted.Delivery != QueueSteer {
		t.Fatalf("promoted item changed delivery: %+v", promoted)
	}
	promptCommand := nextQueueCommand(t, fp)
	if promptCommand["type"] != "prompt" || promptCommand["message"] != "late steer" {
		t.Fatalf("promotion prompt = %#v", promptCommand)
	}
	writeQueueResponse(t, fp, promptCommand, true, "", `{}`)
	promoted = waitQueueState(t, inst, "steer-1", QueueAccepted)
	assertNoQueueCommand(t, fp)
	if promoted.State != QueueAccepted {
		t.Fatalf("accepted promotion changed visible state: %+v", promoted)
	}
}

func TestQueueRejectedSteerPromotionSnapshotsSettlementGeneration(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "promoted-ref", Name: "promoted.png", MimeType: "image/png", Data: []byte{1, 2, 3},
	}}}
	state := inst.StateCopy()
	state.Busy = true
	inst.SetState(state)
	if _, err := inst.SubmitQueue(context.Background(), "steer-promoted", epoch, "promote me", QueueSteer, []string{"promoted-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	steerCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, steerCommand, false, "not busy", `null`)
	getStateCommand := nextQueueCommand(t, fp)
	if getStateCommand["type"] != "get_state" {
		t.Fatalf("promotion state probe = %#v", getStateCommand)
	}

	// The state probe is deliberately answered after Pi settles. The promoted
	// prompt must use the new settlement generation rather than the rejected
	// steer's original dispatch generation.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	writeQueueResponse(t, fp, getStateCommand, true, "", `{"isStreaming":false,"isCompacting":false}`)

	var promptCommand map[string]any
	statsAnswered := false
	for promptCommand == nil {
		command := nextQueueCommand(t, fp)
		switch command["type"] {
		case "get_session_stats":
			writeQueueResponse(t, fp, command, true, "", `{}`)
			statsAnswered = true
		case "prompt":
			promptCommand = command
		default:
			t.Fatalf("promotion dispatch command = %#v", command)
		}
	}
	if promptCommand["message"] != "promote me" {
		t.Fatalf("promotion prompt = %#v", promptCommand)
	}
	promoted := waitQueueState(t, inst, "steer-promoted", QueuePromoted)
	writeQueueResponse(t, fp, promptCommand, true, "", `{}`)
	promoted = waitQueueState(t, inst, "steer-promoted", QueueAccepted)
	if promoted.State != QueueAccepted {
		t.Fatalf("accepted promoted item = %+v", promoted)
	}
	if len(resolver.released) != 0 {
		t.Fatalf("promoted claim released before subsequent settlement: %v", resolver.released)
	}
	if !statsAnswered {
		statsCommand := nextQueueCommand(t, fp)
		if statsCommand["type"] != "get_session_stats" {
			t.Fatalf("settled refresh command = %#v", statsCommand)
		}
		writeQueueResponse(t, fp, statsCommand, true, "", `{}`)
	}

	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	waitQueueState(t, inst, "steer-promoted", QueueConsumed)
	if len(resolver.released) != 1 || resolver.released[0] != "promoted-ref" {
		t.Fatalf("promoted claim releases after settlement = %v", resolver.released)
	}
	statsCommand := nextQueueCommand(t, fp)
	if statsCommand["type"] != "get_session_stats" {
		t.Fatalf("second settled refresh command = %#v", statsCommand)
	}
	writeQueueResponse(t, fp, statsCommand, true, "", `{}`)
}

func TestQueueRejectedSteerStateProbeFailureBecomesUncertain(t *testing.T) {
	oldTimeout := queueAcceptanceTimeout
	queueAcceptanceTimeout = 20 * time.Millisecond
	defer func() { queueAcceptanceTimeout = oldTimeout }()
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "steer-uncertain", epoch, "uncertain steer", QueueSteer, nil); err != nil {
		t.Fatal(err)
	}
	steerCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, steerCommand, false, "not busy", `null`)
	stateCommand := nextQueueCommand(t, fp)
	if stateCommand["type"] != "get_state" {
		t.Fatalf("state probe command = %#v", stateCommand)
	}
	item := waitQueueState(t, inst, "steer-uncertain", QueueUncertain)
	if !strings.Contains(item.Error, "state could not be confirmed") {
		t.Fatalf("uncertain steer error=%q", item.Error)
	}
	assertNoQueueCommand(t, fp)
}

func TestQueueRejectedSteerWhileBusyCancels(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	state := inst.StateCopy()
	state.Busy = true
	inst.SetState(state)
	if _, err := inst.SubmitQueue(context.Background(), "steer-busy", epoch, "busy steer", QueueSteer, nil); err != nil {
		t.Fatal(err)
	}
	steerCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, steerCommand, false, "still running", `null`)
	getStateCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, getStateCommand, true, "", `{"isStreaming":true,"isCompacting":false}`)
	cancelled := waitQueueState(t, inst, "steer-busy", QueueCancelled)
	if !strings.Contains(cancelled.Error, "steer rejected") {
		t.Fatalf("busy rejection error = %q", cancelled.Error)
	}
	assertNoQueueCommand(t, fp)
}

func TestQueueTimeoutBecomesUncertainAndNeverDispatchesAnotherItem(t *testing.T) {
	oldTimeout := queueAcceptanceTimeout
	queueAcceptanceTimeout = 20 * time.Millisecond
	defer func() { queueAcceptanceTimeout = oldTimeout }()
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "uncertain", epoch, "first", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	_ = nextQueueCommand(t, fp)
	uncertain := waitQueueState(t, inst, "uncertain", QueueUncertain)
	second, err := inst.SubmitQueue(context.Background(), "blocked", epoch, "second", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second.State != QueueLocal {
		t.Fatalf("item after uncertain delivery = %q, want local", second.State)
	}
	assertNoQueueCommand(t, fp)
	copyResult, err := inst.QueueCopy("uncertain", epoch)
	if err != nil {
		t.Fatal(err)
	}
	if copyResult["copied"] != true || copyResult["message"] != uncertain.Message {
		t.Fatalf("uncertain copy result = %#v", copyResult)
	}
	if _, err := inst.QueueDiscard("blocked", epoch); err != nil {
		t.Fatal(err)
	}
	waitQueueState(t, inst, "blocked", QueueCancelled)
	discardResult, err := inst.QueueDiscard("uncertain", epoch)
	if err != nil {
		t.Fatal(err)
	}
	if discardResult["discarded"] != true {
		t.Fatalf("uncertain discard result = %#v", discardResult)
	}
	waitQueueState(t, inst, "uncertain", QueueCancelled)
	assertNoQueueCommand(t, fp)
}

func TestQueueUncertainReleasesOriginalClaimAndCopiesFreshRefs(t *testing.T) {
	oldTimeout := queueAcceptanceTimeout
	queueAcceptanceTimeout = 20 * time.Millisecond
	defer func() { queueAcceptanceTimeout = oldTimeout }()
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	resolver := &queueImageResolver{attachments: []QueueAttachment{{
		Ref: "uncertain-ref", Name: "uncertain.png", MimeType: "image/png", Data: []byte{4, 5, 6},
	}}}
	if _, err := inst.SubmitQueue(context.Background(), "uncertain-image", epoch, "uncertain image", QueuePrompt, []string{"uncertain-ref"}, QueueSubmitOptions{Owner: "owner", Resolver: resolver}); err != nil {
		t.Fatal(err)
	}
	_ = nextQueueCommand(t, fp)
	waitQueueState(t, inst, "uncertain-image", QueueUncertain)
	if len(resolver.released) != 1 || resolver.released[0] != "uncertain-ref" {
		t.Fatalf("uncertain claim releases=%v", resolver.released)
	}
	copyResult, err := inst.QueueCopy("uncertain-image", epoch, QueueSubmitOptions{Owner: "owner", Resolver: resolver})
	if err != nil {
		t.Fatal(err)
	}
	if copyResult["copied"] != true || copyResult["attachmentRefs"].([]string)[0] != "uncertain-ref-copy" {
		t.Fatalf("uncertain copy=%#v", copyResult)
	}
}

func TestQueueTransportFailureBecomesUncertain(t *testing.T) {
	inst := &Instance{
		ID:           "transport",
		alive:        true,
		stdin:        failingStdin{},
		subs:         newSubscriberSet(),
		sessionEpoch: "epoch-transport",
		queueItems:   make(map[string]QueueItem),
	}
	inst.SetState(State{Sid: inst.ID, Status: "live"})
	item, err := inst.SubmitQueue(context.Background(), "transport-item", "epoch-transport", "write", QueuePrompt, nil)
	if err != nil {
		t.Fatal(err)
	}
	if item.State != QueueSending {
		t.Fatalf("initial transport item = %+v", item)
	}
	waitQueueState(t, inst, "transport-item", QueueUncertain)
	if _, err := inst.SubmitQueue(context.Background(), "transport-next", "epoch-transport", "next", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	if got := queueItemByID(t, inst, "transport-next").State; got != QueueLocal {
		t.Fatalf("item after transport failure = %q, want local", got)
	}
}

func TestQueueDirectPromptTextDoesNotConsumeAcceptedItems(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	for _, id := range []string{"duplicate-a", "duplicate-b"} {
		if _, err := inst.SubmitQueue(context.Background(), id, epoch, "same text", QueuePrompt, nil); err != nil {
			t.Fatal(err)
		}
		command := nextQueueCommand(t, fp)
		writeQueueResponse(t, fp, command, true, "", `{}`)
		waitQueueState(t, inst, id, QueueAccepted)
	}
	if _, err := fp.stdoutW.Write([]byte(`{"type":"queue_update","steering":[],"followUp":[]}` + "\n")); err != nil {
		t.Fatal(err)
	}
	// A direct compatibility prompt with the same text has no ledger identity.
	if _, err := fp.stdoutW.Write([]byte(`{"type":"message_end","message":{"role":"user","content":"same text"}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	for _, id := range []string{"duplicate-a", "duplicate-b"} {
		if got := queueItemByID(t, inst, id).State; got != QueueAccepted {
			t.Fatalf("direct prompt text consumed item %s: %q", id, got)
		}
	}
	if _, err := fp.stdoutW.Write([]byte(`{"type":"agent_settled"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"duplicate-a", "duplicate-b"} {
		waitQueueState(t, inst, id, QueueConsumed)
	}
	if got := inst.StateCopy().QueueDepth; got != 0 {
		t.Fatalf("queue depth after settled duplicate prompts = %d", got)
	}
}

func TestQueueAbortPreservesAcceptedItems(t *testing.T) {
	fp, inst, _ := queueFixture(t)
	epoch := inst.QueueSessionEpoch()
	if _, err := inst.SubmitQueue(context.Background(), "accepted", epoch, "keep me", QueuePrompt, nil); err != nil {
		t.Fatal(err)
	}
	promptCommand := nextQueueCommand(t, fp)
	writeQueueResponse(t, fp, promptCommand, true, "", `{}`)
	waitQueueState(t, inst, "accepted", QueueAccepted)

	result := make(chan error, 1)
	go func() {
		_, err := inst.Request(context.Background(), "abort", nil)
		result <- err
	}()
	abortCommand := nextQueueCommand(t, fp)
	if abortCommand["type"] != "abort" {
		t.Fatalf("abort command = %#v", abortCommand)
	}
	writeQueueResponse(t, fp, abortCommand, true, "", `{}`)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if got := queueItemByID(t, inst, "accepted").State; got != QueueAccepted {
		t.Fatalf("abort changed accepted item to %q", got)
	}
}
