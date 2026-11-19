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

func TestSyncTopicFollowerRetirementCancelsPendingRegistration(t *testing.T) {
	for _, scenario := range []string{"matching", "stale-generation", "other-runtime", "other-session"} {
		t.Run(scenario, func(t *testing.T) {
			client := newSyncTopicPeerClient(&Server{}, url.URL{}, "", "f1", "")
			owner := pibridge.SyncboardOwner{PaneID: "pane", ProcessID: "proc", Generation: 2, RuntimeID: "runtime", SessionID: "session"}
			client.epoch, client.fence, client.stream = "epoch", "fence", "stream"
			pending := &syncTopicPeerPending{
				seq: 1, action: "register", owner: *wireOwnerFromPibridge(owner), topic: "alerts",
				done: make(chan struct{}),
			}
			client.pending = pending
			retired := owner
			switch scenario {
			case "stale-generation":
				retired.Generation--
			case "other-runtime":
				retired.RuntimeID = "other"
			case "other-session":
				retired.SessionID = "other"
			}
			client.RetireOwner(retired, "epoch")
			client.handleResult(&syncTopicPeerFrame{
				Type: "result", Epoch: client.epoch, Fence: client.fence, Stream: client.stream,
				Control: "1", Result: "ok",
			})
			canceled := scenario == "matching"
			if (len(client.intents) == 0) != canceled {
				t.Fatal("late registration result did not respect the exact retired owner")
			}
			if err := waitPeerResult(pending); (err != nil) != canceled {
				t.Fatal("registration caller received the wrong retirement outcome")
			}
			if len(client.dirtyRetire) != 1 || client.control != 1 {
				t.Fatal("retirement lost the coordinator cancellation or control order")
			}
		})
	}
}

func TestSyncTopicFollowerRegistrationResultReachesEveryWaiter(t *testing.T) {
	for _, result := range []string{"ok", "refused"} {
		t.Run(result, func(t *testing.T) {
			client := newSyncTopicPeerClient(&Server{}, url.URL{}, "", "f1", "")
			client.epoch, client.fence, client.stream = "epoch", "fence", "stream"
			pending := &syncTopicPeerPending{
				seq: 1, action: "register", owner: syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1}, topic: "alerts",
				done: make(chan struct{}),
			}
			client.pending = pending
			started, completed := make(chan struct{}, 2), make(chan error, 2)
			for i := 0; i < 2; i++ {
				go func() {
					started <- struct{}{}
					completed <- waitPeerResult(pending)
				}()
			}
			<-started
			<-started
			frame := &syncTopicPeerFrame{
				Type: "result", Epoch: client.epoch, Fence: client.fence, Stream: client.stream,
				Control: "1", Result: result,
			}
			client.handleResult(frame)
			client.handleResult(frame)
			for i := 0; i < 2; i++ {
				select {
				case err := <-completed:
					if (err == nil) != (result == "ok") {
						t.Fatal("coalesced registration callers received different results")
					}
				case <-time.After(time.Second):
					t.Fatal("a coalesced registration caller missed the definitive result")
				}
			}
		})
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
