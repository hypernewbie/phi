package server

import (
	"net/url"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
)

func TestSyncTopicRemoteRetirementCannotCancelReplacementGeneration(t *testing.T) {
	e := newSyncTopicEngine("epoch")
	owner := syncTopicOwner{paneID: "remote:f1:pane", processID: "proc", generation: 2, remote: true, peerID: "f1", remoteSend: func(*syncTopicBatch) error { return nil }}
	if err := e.subscribeRemoteLocked(owner, "alerts"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("alerts", "value", time.Now()); err != nil {
		t.Fatal(err)
	}
	stale := owner
	stale.generation--
	e.retireOwnerLocked(stale)
	if e.totalSubs != 1 || e.totalBatches != 1 {
		t.Fatal("delayed retirement canceled a replacement generation")
	}
	e.retireOwnerLocked(owner)
	if e.totalSubs != 0 || e.totalBatches != 0 {
		t.Fatal("matching retirement did not cancel its own work")
	}
}

func TestSyncTopicFollowerIntentAndRetirementAreGenerationScoped(t *testing.T) {
	client := newSyncTopicPeerClient(&Server{}, url.URL{}, "", "f1", "")
	owner := pibridge.SyncboardOwner{PaneID: "pane", ProcessID: "proc", Generation: 2}
	wire := *wireOwnerFromPibridge(owner)
	key := "pane\x00proc\x00alerts"
	client.active, client.ready, client.epoch = true, true, "epoch"
	client.intents[key] = syncTopicPeerIntent{owner: wire, topic: "alerts"}
	stale := owner
	stale.Generation--
	if err := client.Register(stale, "alerts"); err == nil {
		t.Fatal("a different generation inherited an existing subscription")
	}
	client.active = false
	client.RetireOwner(stale, "epoch")
	if _, ok := client.intents[key]; !ok {
		t.Fatal("delayed retirement removed a replacement intent")
	}
	client.RetireOwner(owner, "epoch")
	client.RetireOwner(stale, "epoch")
	if len(client.intents) != 0 || client.dirtyRetire["pane\x00proc"].owner.Generation != owner.Generation {
		t.Fatal("a delayed fence overwrote a newer pending retirement")
	}
}

func TestSyncTopicCapturedBatchCannotMoveToReplacementCohort(t *testing.T) {
	app := New(Options{})
	registry := app.peerRegistry()
	first := &syncTopicPeerConn{app: app, peerID: "f1", writer: pausedSyncTopicWriter()}
	cohort, err := registry.bind(app, "f1", "first", "", first)
	if err != nil {
		t.Fatal(err)
	}
	first.cohort = cohort
	wire := &syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1}
	registry.control(app, first, &syncTopicPeerFrame{
		Type: "control", Epoch: app.syncTopics.epoch, Fence: cohort.fence, Stream: cohort.stream,
		Control: "1", Action: "register", Owner: wire, Topic: "alerts",
	})
	captured := app.syncTopics.owners["remote:f1:pane\x00proc"].remoteSend
	registry.closeConn(app, first)
	replacement := &syncTopicPeerConn{app: app, peerID: "f1", writer: pausedSyncTopicWriter()}
	next, err := registry.bind(app, "f1", "replacement", cohort.fence, replacement)
	if err != nil {
		t.Fatal(err)
	}
	next.ready = true
	if err := captured(&syncTopicBatch{id: "old", seq: 1, topic: "alerts", text: []byte("old value")}); err == nil {
		t.Fatal("captured old work was retargeted to a replacement cohort")
	}
	if len(replacement.writer.queue) != 0 {
		t.Fatal("old cohort bytes entered the replacement stream")
	}
}
