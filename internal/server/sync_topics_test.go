package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
)

func topicOwner(id string) syncTopicOwner {
	return syncTopicOwner{paneID: id, processID: id + "-proc", generation: 1,
		runtimeID: id + "-runtime", sessionID: id + "-session"}
}

func TestSyncTopicBatchesCarryCompleteValuesAndAllRecipients(t *testing.T) {
	now := time.Unix(100, 0)
	e := newSyncTopicEngine("epoch-test")
	a, b := topicOwner("a"), topicOwner("b")
	if err := e.subscribeLocked(a, "topic"); err != nil {
		t.Fatal(err)
	}
	if err := e.subscribeLocked(b, "topic"); err != nil {
		t.Fatal(err)
	}
	value := `{"marker":"` + strings.Repeat("ü", 5000) + `"}`
	ok, err := e.admitPostLocked("topic", value, now)
	if err != nil || !ok {
		t.Fatalf("admit = %v, %v", ok, err)
	}
	if got := len(e.pumpLocked(now.Add(4 * time.Second))); got != 0 {
		t.Fatalf("early pump delivered %d batches", got)
	}
	deliveries := e.pumpLocked(now.Add(5 * time.Second))
	if len(deliveries) != 2 {
		t.Fatalf("deliveries = %d, want 2", len(deliveries))
	}
	for _, d := range deliveries {
		var text syncTopicBatchText
		if err := json.Unmarshal(d.batch.text, &text); err != nil {
			t.Fatal(err)
		}
		if text.Topic != "topic" || text.BatchID == "" || text.PostCount != 1 || len(text.Posts) != 1 {
			t.Fatalf("unexpected batch text: %+v", text)
		}
		if text.Posts[0].Value != value {
			t.Fatalf("batch did not carry the complete stored value")
		}
		if !strings.Contains(string(d.batch.text), "ü") {
			t.Fatalf("batch lost Unicode")
		}
	}
	if e.totalBatches != 2 {
		t.Fatalf("reserved batches = %d, want 2", e.totalBatches)
	}
}

func TestSyncTopicCapacityRefusesEveryRecipientBeforeMutation(t *testing.T) {
	now := time.Unix(200, 0)
	e := newSyncTopicEngine("epoch-test")
	a, b := topicOwner("a"), topicOwner("b")
	for i := 0; i < maxSyncTopicBatchesPerOwner; i++ {
		topic := "a-" + string(rune('a'+i))
		if err := e.subscribeLocked(a, topic); err != nil {
			t.Fatal(err)
		}
		if _, err := e.admitPostLocked(topic, "v", now); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.subscribeLocked(b, "new"); err != nil {
		t.Fatal(err)
	}
	if err := e.subscribeLocked(a, "new"); err != nil {
		t.Fatal(err)
	}
	beforeB := len(e.owners[syncTopicOwnerKey(b)].batches)
	if _, err := e.admitPostLocked("new", "v", now); err != errSyncTopicCapacity {
		t.Fatalf("admit err = %v, want capacity", err)
	}
	if got := len(e.owners[syncTopicOwnerKey(b)].batches); got != beforeB {
		t.Fatalf("second recipient was mutated on refusal: %d -> %d", beforeB, got)
	}
	if e.totalBatches != maxSyncTopicBatchesPerOwner {
		t.Fatalf("total batches = %d", e.totalBatches)
	}
}

func TestSyncTopicFIFOBlocksUntilHeadAcknowledged(t *testing.T) {
	now := time.Unix(300, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	if err := e.subscribeLocked(o, "one"); err != nil {
		t.Fatal(err)
	}
	if err := e.subscribeLocked(o, "two"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("one", "first", now); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("two", "second", now); err != nil {
		t.Fatal(err)
	}
	first := e.pumpLocked(now.Add(5 * time.Second))
	if len(first) != 1 || first[0].batch.topic != "one" {
		t.Fatalf("first delivery = %+v", first)
	}
	e.markSentLocked(first[0].owner, first[0].batch.id, now)
	if got := e.pumpLocked(now.Add(6 * time.Second)); len(got) != 1 || got[0].batch.id != first[0].batch.id {
		t.Fatalf("sent head was not retried as the same batch: %+v", got)
	}
	if !e.acknowledgeLocked(o, "epoch-test", first[0].batch.seq, first[0].batch.id) {
		t.Fatal("head ACK did not release")
	}
	second := e.pumpLocked(now.Add(6 * time.Second))
	if len(second) != 1 || second[0].batch.topic != "two" {
		t.Fatalf("second delivery = %+v", second)
	}
	if e.acknowledgeLocked(o, "epoch-test", second[0].batch.seq, first[0].batch.id) {
		t.Fatal("stale batch id released the next head")
	}
}

func TestNormalizeSyncValueTable(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{`"text"`, "text"},
		{`null`, ""},
		{`false`, "false"},
		{`0`, "0"},
		{`[1,2]`, "[1,2]"},
		{`{"action":{"type":"button"}}`, `{"action":{"type":"button"}}`},
		{`"ü"`, "ü"},
	}
	for _, tt := range tests {
		got, err := normalizeSyncValue(json.RawMessage(tt.in))
		if err != nil || got != tt.want {
			t.Errorf("normalize(%s) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
	for _, raw := range []string{`",`, `"\xff"`, `"x" "y"`} {
		if _, err := normalizeSyncValue(json.RawMessage(raw)); err == nil {
			t.Errorf("normalize(%q) accepted invalid input", raw)
		}
	}
}

func TestSyncTopicCountersAboveTwoToThe53AndExhaustionWithoutWrap(t *testing.T) {
	now := time.Unix(400, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	if err := e.subscribeLocked(o, "topic"); err != nil {
		t.Fatal(err)
	}
	e.nextBatch = 1 << 53
	if _, err := e.admitPostLocked("topic", "v", now); err != nil {
		t.Fatal(err)
	}
	b := e.owners[syncTopicOwnerKey(o)].batches[0]
	if b.seq != (1<<53)+1 || b.id != "batch-00009007199254740993" {
		t.Fatalf("batch seq/id = %d/%s", b.seq, b.id)
	}
	if err := e.subscribeLocked(o, "fresh-topic"); err != nil {
		t.Fatal(err)
	}
	e.nextBatch = ^uint64(0)
	if _, err := e.admitPostLocked("fresh-topic", "w", now); err != errSyncTopicCapacity {
		t.Fatalf("exhausted batch counter err = %v", err)
	}
	e.nextBatch = 1
	e.nextPost = ^uint64(0)
	if _, err := e.admitPostLocked("topic", "w", now); err != errSyncTopicCapacity {
		t.Fatalf("exhausted post counter err = %v", err)
	}
	if e.nextBatch != 1 || e.nextPost != ^uint64(0) {
		t.Fatalf("counters changed on refusal: %d/%d", e.nextBatch, e.nextPost)
	}
}

func TestSyncTopicLossAndRetirementDoNotAdvanceOrRecreateWork(t *testing.T) {
	now := time.Unix(500, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	if err := e.subscribeLocked(o, "topic"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("topic", "v", now); err != nil {
		t.Fatal(err)
	}
	first := e.pumpLocked(now.Add(5 * time.Second))
	if len(first) != 1 {
		t.Fatalf("deliveries = %d", len(first))
	}
	e.markSentLocked(first[0].owner, first[0].batch.id, now)
	if got := e.pumpLocked(now.Add(10 * time.Second)); len(got) != 1 || got[0].batch.id != first[0].batch.id {
		t.Fatalf("lost batch was not retried as the same batch: %+v", got)
	}
	if e.acknowledgeLocked(o, "wrong-epoch", first[0].batch.seq, first[0].batch.id) {
		t.Fatal("wrong epoch released the head")
	}
	if !e.acknowledgeLocked(o, "epoch-test", first[0].batch.seq, first[0].batch.id) {
		t.Fatal("matching ACK did not release the head")
	}
	if got := e.pumpLocked(now.Add(10 * time.Second)); len(got) != 0 {
		t.Fatalf("acknowledged batch was redelivered: %+v", got)
	}

	if _, err := e.admitPostLocked("topic", "late", now); err != nil {
		t.Fatal(err)
	}
	e.retireOwnerLocked(o)
	if e.totalBatches != 0 || e.totalSubs != 0 {
		t.Fatalf("retirement left work: batches=%d subs=%d", e.totalBatches, e.totalSubs)
	}
	if e.acknowledgeLocked(o, "epoch-test", 2, "batch-anything") {
		t.Fatal("retired owner ACK was accepted")
	}
	if err := e.subscribeLocked(o, "topic"); err != nil {
		t.Fatalf("retired owner could not subscribe again: %v", err)
	}
}

func TestSyncTopicRemoteCapacityRefusesOneOwnerButNotAnother(t *testing.T) {
	now := time.Unix(700, 0)
	e := newSyncTopicEngine("epoch-test")
	remote := topicOwner("remote")
	remote.remote = true
	remote.peerID = "peer"
	remote.remoteSend = func(*syncTopicBatch) error { return nil }
	local := topicOwner("local")
	if err := e.subscribeRemoteLocked(remote, "remote-0"); err != nil {
		t.Fatal(err)
	}
	if err := e.subscribeLocked(local, "local"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxSyncTopicBatchesPerOwner; i++ {
		topic := "remote-" + string(rune('a'+i))
		if err := e.subscribeRemoteLocked(remote, topic); err != nil {
			t.Fatal(err)
		}
		if _, err := e.admitPostLocked(topic, "v", now); err != nil {
			t.Fatalf("remote admit %d: %v", i, err)
		}
	}
	if _, err := e.admitPostLocked("local", "v", now); err != nil {
		t.Fatalf("local owner was blocked by remote capacity: %v", err)
	}
	if err := e.subscribeRemoteLocked(remote, "remote-full"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("remote-full", "v", now); err != errSyncTopicCapacity {
		t.Fatalf("remote overflow err = %v, want capacity", err)
	}
	if got := len(e.owners[syncTopicOwnerKey(local)].batches); got != 1 {
		t.Fatalf("local batches = %d, want 1", got)
	}
}

func TestSyncTopicEncodedBoundaryRefusesBeforeMutation(t *testing.T) {
	now := time.Unix(800, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	if err := e.subscribeLocked(o, "topic"); err != nil {
		t.Fatal(err)
	}
	beforeOwners, beforeSubs, beforeBatches := e.statsLocked()
	// The raw value is below the 128 KiB post bound, but JSON escaping doubles
	// every backslash and pushes the encoded batch over the 64 KiB wire bound.
	escaped := strings.Repeat(`\`, 40*1024)
	if _, err := e.admitPostLocked("topic", escaped, now); err != errSyncTopicTooLarge {
		t.Fatalf("escaped admit err = %v, want too large", err)
	}
	afterOwners, afterSubs, afterBatches := e.statsLocked()
	if afterOwners != beforeOwners || afterSubs != beforeSubs || afterBatches != beforeBatches {
		t.Fatalf("refusal changed engine stats: %d/%d/%d -> %d/%d/%d",
			beforeOwners, beforeSubs, beforeBatches, afterOwners, afterSubs, afterBatches)
	}
	owner := e.owners[syncTopicOwnerKey(o)]
	if len(owner.batches) != 0 || len(owner.open) != 0 {
		t.Fatalf("refusal reserved work: %+v", owner)
	}
	// Unicode below the encoded bound is accepted complete and untruncated.
	value := strings.Repeat("ü", 30*1024)
	if ok, err := e.admitPostLocked("topic", value, now); err != nil || !ok {
		t.Fatalf("unicode admit = %v, %v", ok, err)
	}
	b := owner.batches[0]
	if len(b.text) > maxSyncTopicBatchTextBytes || !strings.Contains(string(b.text), value) {
		t.Fatalf("unicode batch was truncated: %d bytes", len(b.text))
	}
	if err := e.subscribeLocked(o, strings.Repeat("k", maxSyncTopicKeyBytes)); err != nil {
		t.Fatalf("longest topic rejected: %v", err)
	}
	if err := e.subscribeLocked(o, strings.Repeat("k", maxSyncTopicKeyBytes+1)); err != errSyncTopicInvalid {
		t.Fatalf("oversized topic err = %v", err)
	}
}

func TestSyncTopicStaleOwnerCannotAcknowledgeReplacement(t *testing.T) {
	now := time.Unix(900, 0)
	e := newSyncTopicEngine("epoch-test")
	old := topicOwner("same")
	if err := e.subscribeLocked(old, "topic"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("topic", "old", now); err != nil {
		t.Fatal(err)
	}
	deliveries := e.pumpLocked(now.Add(5 * time.Second))
	if len(deliveries) != 1 {
		t.Fatalf("old deliveries = %d", len(deliveries))
	}
	oldBatch := deliveries[0].batch
	e.markSentLocked(old, oldBatch.id, now)

	replacement := old
	replacement.generation++
	if err := e.subscribeLocked(replacement, "topic"); err != nil {
		t.Fatal(err)
	}
	if e.acknowledgeLocked(replacement, "epoch-test", oldBatch.seq, oldBatch.id) {
		t.Fatal("replacement accepted the retired owner's ACK")
	}
	if _, err := e.admitPostLocked("topic", "new", now); err != nil {
		t.Fatal(err)
	}
	fresh := e.pumpLocked(now.Add(6 * time.Second))
	if len(fresh) != 1 || fresh[0].batch.topic != "topic" {
		t.Fatalf("replacement delivery = %+v", fresh)
	}
	if e.acknowledgeLocked(replacement, "epoch-test", oldBatch.seq, oldBatch.id) {
		t.Fatal("stale sequence released replacement work")
	}
	if !e.acknowledgeLocked(replacement, "epoch-test", fresh[0].batch.seq, fresh[0].batch.id) {
		t.Fatal("replacement could not acknowledge its own work")
	}
}

func TestSyncTopicDeadlineUsesInjectedClock(t *testing.T) {
	now := time.Unix(1000, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	for _, topic := range []string{"one", "two"} {
		if err := e.subscribeLocked(o, topic); err != nil {
			t.Fatal(err)
		}
	}
	for _, topic := range []string{"one", "two"} {
		if _, err := e.admitPostLocked(topic, topic, now); err != nil {
			t.Fatal(err)
		}
	}
	if got := e.pumpLocked(now.Add(syncTopicBatchWindow - time.Nanosecond)); len(got) != 0 {
		t.Fatalf("deadline fired early: %+v", got)
	}
	first := e.pumpLocked(now.Add(syncTopicBatchWindow))
	if len(first) != 1 || first[0].batch.topic != "one" {
		t.Fatalf("first deadline delivery = %+v", first)
	}
	e.markSentLocked(first[0].owner, first[0].batch.id, now)
	e.acknowledgeLocked(o, "epoch-test", first[0].batch.seq, first[0].batch.id)
	second := e.pumpLocked(now.Add(syncTopicBatchWindow))
	if len(second) != 1 || second[0].batch.topic != "two" {
		t.Fatalf("second deadline delivery = %+v", second)
	}
}

func TestSyncTopicPostAfterDeadlineDoesNotWaitForTimer(t *testing.T) {
	for _, offset := range []time.Duration{-time.Nanosecond, 0, time.Second} {
		t.Run(offset.String(), func(t *testing.T) {
			now := time.Unix(1300, 0)
			e := newSyncTopicEngine("epoch-test")
			o := topicOwner("a")
			if err := e.subscribeLocked(o, "alerts"); err != nil {
				t.Fatal(err)
			}
			if _, err := e.admitPostLocked("alerts", "first", now); err != nil {
				t.Fatal(err)
			}
			if _, err := e.admitPostLocked("alerts", "second", now.Add(syncTopicBatchWindow+offset)); err != nil {
				t.Fatal(err)
			}
			batches := e.owners[syncTopicOwnerKey(o)].batches
			if offset < 0 {
				if len(batches) != 1 || len(batches[0].posts) != 2 {
					t.Fatal("a post inside the fixed window did not coalesce")
				}
				return
			}
			if len(batches) != 2 || !batches[0].sealed || len(batches[0].posts) != 1 || len(batches[1].posts) != 1 {
				t.Fatal("a late timer let a new post modify an expired batch")
			}
		})
	}
}

func TestSyncTopicDuplicateSubscribeAtCapacityStaysIdempotent(t *testing.T) {
	now := time.Unix(1100, 0)
	e := newSyncTopicEngine("epoch-test")
	o := topicOwner("a")
	for i := 0; i < maxSyncTopicSubscriptions; i++ {
		if err := e.subscribeLocked(o, "topic-"+strconv.Itoa(i)); err != nil {
			t.Fatalf("subscribe %d: %v", i, err)
		}
	}
	if err := e.subscribeLocked(o, "topic-0"); err != nil {
		t.Fatalf("duplicate subscribe at capacity = %v", err)
	}
	owners, subs, batches := e.statsLocked()
	if err := e.subscribeLocked(o, "overflow"); err != errSyncTopicCapacity {
		t.Fatalf("new subscribe at capacity = %v", err)
	}
	if gotOwners, gotSubs, gotBatches := e.statsLocked(); gotOwners != owners || gotSubs != subs || gotBatches != batches {
		t.Fatalf("capacity refusal mutated state: %d/%d/%d -> %d/%d/%d",
			owners, subs, batches, gotOwners, gotSubs, gotBatches)
	}
	if _, err := e.admitPostLocked("topic-0", "v", now); err != nil {
		t.Fatalf("existing subscription could not accept: %v", err)
	}
}

func TestSyncTopicRemoteReplacementFencesPreviousOwnerWork(t *testing.T) {
	now := time.Unix(1200, 0)
	e := newSyncTopicEngine("epoch-test")
	send := func(*syncTopicBatch) error { return nil }
	old := syncTopicOwner{
		paneID: "remote:f1:pane", processID: "proc", generation: 1,
		runtimeID: "rt-1", sessionID: "session-1", remote: true, peerID: "f1", remoteSend: send,
	}
	if err := e.subscribeRemoteLocked(old, "topic"); err != nil {
		t.Fatal(err)
	}
	e.markRemoteReadyLocked("f1", true)
	if _, err := e.admitPostLocked("topic", "old", now); err != nil {
		t.Fatal(err)
	}
	deliveries := e.pumpLocked(now.Add(5 * time.Second))
	if len(deliveries) != 1 {
		t.Fatalf("old deliveries = %d", len(deliveries))
	}
	oldBatch := deliveries[0].batch
	e.markSentLocked(old, oldBatch.id, now)

	replacement := old
	replacement.generation = 2
	replacement.runtimeID = "rt-2"
	replacement.sessionID = "session-2"
	if err := e.subscribeRemoteLocked(replacement, "topic"); err != nil {
		t.Fatal(err)
	}
	if _, _, batches := e.statsLocked(); batches != 0 {
		t.Fatalf("replacement inherited %d old batches", batches)
	}
	if e.acknowledgeLocked(replacement, "epoch-test", oldBatch.seq, oldBatch.id) {
		t.Fatal("replacement accepted the retired remote ACK")
	}
	if _, err := e.admitPostLocked("topic", "new", now); err != nil {
		t.Fatal(err)
	}
	fresh := e.pumpLocked(now.Add(10 * time.Second))
	if len(fresh) != 1 || fresh[0].owner.generation != 2 || fresh[0].owner.runtimeID != "rt-2" {
		t.Fatalf("replacement delivery = %+v", fresh)
	}
	if e.acknowledgeLocked(replacement, "epoch-test", fresh[0].batch.seq, fresh[0].batch.id) != true {
		t.Fatal("replacement could not acknowledge its own batch")
	}
}

func TestSyncTopicPostRefusalsAreTypedAndBounded(t *testing.T) {
	withTempConfig(t)
	post := func(body string) (int, string) {
		rec := httptest.NewRecorder()
		testServer.handleSyncMessages(rec, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(body)))
		return rec.Code, rec.Body.String()
	}
	for _, body := range []string{
		`{"key":"k","value":"v"} {}`,
		`{"key":"","value":"v"}`,
		`{"key":"k"}`,
		`{"key":"k","value":nullx}`,
		"{\"key\":\"k\",\"value\":\"\xff\"}",
	} {
		if status, response := post(body); status != http.StatusBadRequest || response != `{"syncboard_admission":"refused","reason":"invalid"}` {
			t.Fatalf("body %q refusal = %d %q", body, status, response)
		}
	}
	tooLarge := `{"key":"k","value":"` + strings.Repeat("x", maxSyncTopicPostBytes) + `"}`
	if status, response := post(tooLarge); status != http.StatusRequestEntityTooLarge || response != `{"syncboard_admission":"refused","reason":"too-large"}` {
		t.Fatalf("oversized refusal = %d %q", status, response)
	}

	now := time.Unix(900, 0)
	owner := topicOwner("full")
	testServer.syncMu.Lock()
	for i := 0; i < maxSyncTopicBatchesPerOwner; i++ {
		topic := "full-" + strconv.Itoa(i)
		if err := testServer.syncTopics.subscribeLocked(owner, topic); err != nil {
			testServer.syncMu.Unlock()
			t.Fatal(err)
		}
		if _, err := testServer.syncTopics.admitPostLocked(topic, "v", now); err != nil {
			testServer.syncMu.Unlock()
			t.Fatal(err)
		}
	}
	if err := testServer.syncTopics.subscribeLocked(owner, "refused-topic"); err != nil {
		testServer.syncMu.Unlock()
		t.Fatal(err)
	}
	beforeBatches := testServer.syncTopics.totalBatches
	testServer.syncMu.Unlock()
	status, response := post(`{"key":"refused-topic","value":"refused"}`)
	if status != http.StatusServiceUnavailable || response != `{"syncboard_admission":"refused","reason":"capacity"}` {
		t.Fatalf("capacity refusal = %d %q", status, response)
	}
	testServer.syncMu.Lock()
	defer testServer.syncMu.Unlock()
	if _, exists := testServer.syncStore["refused-topic"]; exists {
		t.Fatal("capacity refusal mutated the board")
	}
	if testServer.syncTopics.totalBatches != beforeBatches {
		t.Fatalf("capacity refusal reserved work: %d -> %d", beforeBatches, testServer.syncTopics.totalBatches)
	}
}

func TestSyncTopicRetirementCancelsOnlyTheCapturedLocalGeneration(t *testing.T) {
	now := time.Unix(500, 0)
	e := newSyncTopicEngine("epoch-test")
	owner := topicOwner("pane")
	if err := e.subscribeLocked(owner, "topic"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("topic", "value", now); err != nil {
		t.Fatal(err)
	}
	app := &Server{syncTopics: e}
	retirement := pibridge.SyncboardTopicRetirement{
		Owner: pibridge.SyncboardOwner{PaneID: owner.paneID, ProcessID: owner.processID,
			Generation: 2, RuntimeID: owner.runtimeID, SessionID: owner.sessionID},
		Epoch: "epoch-test",
	}
	app.retireSyncTopicOwner(retirement)
	if owners, subs, batches := e.statsLocked(); owners != 1 || subs != 1 || batches != 1 {
		t.Fatalf("stale retirement canceled the live generation: owners=%d subs=%d batches=%d", owners, subs, batches)
	}
	retirement.Owner.Generation = owner.generation
	app.retireSyncTopicOwner(retirement)
	if owners, subs, batches := e.statsLocked(); owners != 0 || subs != 0 || batches != 0 {
		t.Fatalf("matching retirement left owners=%d subs=%d batches=%d", owners, subs, batches)
	}
	if _, err := e.admitPostLocked("topic", "late", now); err != nil {
		t.Fatal(err)
	}
	if got := e.pumpLocked(now.Add(10 * time.Second)); len(got) != 0 {
		t.Fatalf("retired owner still received %+v", got)
	}
}
