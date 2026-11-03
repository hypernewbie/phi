package ws

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"google.golang.org/protobuf/proto"

	"github.com/hypernewbie/phi/pkg/rpc"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// queueControlFixture spawns one control session backed by a fake Pi child
// that answers the spawn bootstrap and every queue prompt.
func queueControlFixture(t *testing.T) (*websocket.Conn, string) {
	t.Helper()
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		switch command["type"] {
		case "get_state", "get_session_stats", "get_commands":
			return map[string]any{}, true, ""
		case "prompt", "steer", "follow_up":
			return map[string]any{}, true, ""
		default:
			return nil, false, "unexpected command"
		}
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	t.Cleanup(func() {
		for _, inst := range mgr.List() {
			inst.Kill()
		}
	})
	c := helloDial(t, mgr)
	sid := spawnControlSession(t, c, "/w/queue")
	return c, sid
}

// queueSessionEpoch reads the ledger epoch the client must echo on every queue
// call. The hydrate payload is the only source, so every queue test starts here.
func queueSessionEpoch(t *testing.T, c *websocket.Conn, sid string) string {
	t.Helper()
	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "queue-epoch",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: sid}},
	})
	epoch := res.GetHydrate().GetQueue().GetSessionEpoch()
	if epoch == "" {
		t.Fatal("hydrate did not publish a queue session epoch")
	}
	return epoch
}

// queueWaitPiOwned waits until the item's ledger state is one only Pi can
// produce. The fake child answers asynchronously, so reading the state straight
// after submit races the dispatcher and reads "sending" instead of "accepted".
func queueWaitPiOwned(t *testing.T, c *websocket.Conn, sid, itemID string) {
	t.Helper()
	owned := map[string]bool{
		string(rpc.QueueAccepted): true,
		string(rpc.QueuePromoted): true,
		string(rpc.QueueConsumed): true,
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		res := mustCall(t, c, &wspb.ControlCall{
			Id:   "queue-wait-" + itemID,
			Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: sid}},
		})
		for _, item := range res.GetHydrate().GetQueue().GetItems() {
			if item.GetId() == itemID && owned[item.GetState()] {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("item %q never reached a Pi-owned state; last queue = %+v",
				itemID, res.GetHydrate().GetQueue().GetItems())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestControlQueueSubmitReturnsTypedItem covers the queue_submit variant: the
// result carries the whole item, including the ledger state and delivery.
func TestControlQueueSubmitReturnsTypedItem(t *testing.T) {
	c, sid := queueControlFixture(t)
	epoch := queueSessionEpoch(t, c, sid)

	res := mustCall(t, c, &wspb.ControlCall{
		Id: "queue-submit",
		Call: &wspb.ControlCall_QueueSubmit{QueueSubmit: &wspb.QueueSubmitCall{
			Sid:          sid,
			ItemId:       "item-1",
			SessionEpoch: epoch,
			Message:      "hello",
			Delivery:     string(rpc.QueuePrompt),
		}},
	})
	item := res.GetQueueSubmit().GetItem()
	if item.GetId() != "item-1" || item.GetMessage() != "hello" {
		t.Fatalf("queue submit item = %+v", item)
	}
	if item.GetDelivery() != string(rpc.QueuePrompt) {
		t.Fatalf("queue submit delivery = %q", item.GetDelivery())
	}
	if item.GetSid() != sid {
		t.Fatalf("queue submit sid = %q, want %q", item.GetSid(), sid)
	}
	if item.GetState() == "" {
		t.Fatal("queue submit item missing ledger state")
	}
}

// TestControlQueueSubmitValidation pins the required item id without reaching
// Eq: validation runs before the instance lookup.
func TestControlQueueSubmitValidation(t *testing.T) {
	c, sid := queueControlFixture(t)

	expectError(t, c, &wspb.ControlCall{
		Id: "queue-submit-invalid",
		Call: &wspb.ControlCall_QueueSubmit{QueueSubmit: &wspb.QueueSubmitCall{
			Sid:     sid,
			Message: "hello",
		}},
	}, "itemId is required")
}

// TestControlQueueRestoreShape covers the restore variant. The fake child
// accepts the prompt immediately, so the item is Pi-owned and restore reports
// that state instead of handing back a draft.
func TestControlQueueRestoreShape(t *testing.T) {
	c, sid := queueControlFixture(t)
	epoch := queueSessionEpoch(t, c, sid)
	mustCall(t, c, &wspb.ControlCall{
		Id: "queue-submit-restore",
		Call: &wspb.ControlCall_QueueSubmit{QueueSubmit: &wspb.QueueSubmitCall{
			Sid:          sid,
			ItemId:       "restore-me",
			SessionEpoch: epoch,
			Message:      "draft",
			Delivery:     string(rpc.QueuePrompt),
		}},
	})
	queueWaitPiOwned(t, c, sid, "restore-me")

	restored := mustCall(t, c, &wspb.ControlCall{
		Id: "queue-restore",
		Call: &wspb.ControlCall_QueueRestore{QueueRestore: &wspb.QueueRestoreCall{
			Sid: sid, ItemId: "restore-me", SessionEpoch: epoch,
		}},
	})
	if restored.GetQueueRestore().GetRestored() {
		t.Fatalf("accepted item was restored as a draft: %+v", restored.GetQueueRestore())
	}
	if restored.GetQueueRestore().GetItem().GetId() != "restore-me" {
		t.Fatalf("restore item = %+v", restored.GetQueueRestore().GetItem())
	}
	if restored.GetQueueRestore().GetReason() != "pi-owned" {
		t.Fatalf("restore reason = %q, want pi-owned", restored.GetQueueRestore().GetReason())
	}

	// An unknown item is not an error: the result explains why nothing
	// changed, so the client can leave its ledger untouched.
	missing := mustCall(t, c, &wspb.ControlCall{
		Id: "queue-restore-missing",
		Call: &wspb.ControlCall_QueueRestore{QueueRestore: &wspb.QueueRestoreCall{
			Sid: sid, ItemId: "never-created", SessionEpoch: epoch,
		}},
	})
	if missing.GetQueueRestore().GetReason() != "missing" {
		t.Fatalf("missing restore reason = %q, want missing", missing.GetQueueRestore().GetReason())
	}
}

// TestControlExtensionUIDialogValidation pins the request id requirement and
// the closed reason vocabulary before any Pi write happens.
func TestControlExtensionUIDialogValidation(t *testing.T) {
	c, sid := queueControlFixture(t)

	expectError(t, c, &wspb.ControlCall{
		Id: "dialog-response-invalid",
		Call: &wspb.ControlCall_ExtensionUiResponse{ExtensionUiResponse: &wspb.ExtensionUIResponseCall{
			Sid: sid,
		}},
	}, "requestId is required")

	expectError(t, c, &wspb.ControlCall{
		Id: "dialog-cancel-invalid",
		Call: &wspb.ControlCall_ExtensionUiCancel{ExtensionUiCancel: &wspb.ExtensionUICancelCall{
			Sid: sid, Reason: "nonsense",
		}},
	}, "reason must be tabClosed or server")
}

// TestControlExtensionUICancelReportsCount covers the successful cancel shape:
// no retained dialog means a zero count, not an error.
func TestControlExtensionUICancelReportsCount(t *testing.T) {
	c, sid := queueControlFixture(t)
	res := mustCall(t, c, &wspb.ControlCall{
		Id: "dialog-cancel",
		Call: &wspb.ControlCall_ExtensionUiCancel{ExtensionUiCancel: &wspb.ExtensionUICancelCall{
			Sid: sid, Reason: "tabClosed",
		}},
	})
	if res.GetExtensionUiCancel() == nil {
		t.Fatalf("cancel result = %+v", res)
	}
	if res.GetExtensionUiCancel().GetCancelled() != 0 {
		t.Fatalf("cancel count = %d, want 0", res.GetExtensionUiCancel().GetCancelled())
	}
}

// TestControlSpawnIDReusesInstance pins idempotent spawn: the same spawnId with
// the same arguments returns the same sid instead of starting a second child.
func TestControlSpawnIDReusesInstance(t *testing.T) {
	child := newControlFakeChild()
	respondControlCommands(child, func(command map[string]any) (any, bool, string) {
		return map[string]any{}, true, ""
	})
	mgr := rpc.NewManagerWithSpawner(func(rpc.SpawnOptions) (rpc.Cmd, rpc.WriteCloser, rpc.ReadCloser, error) {
		return child, child.stdinW, child.stdoutR, nil
	})
	t.Cleanup(func() {
		for _, inst := range mgr.List() {
			inst.Kill()
		}
	})
	c := helloDial(t, mgr)

	spawn := func(id string) string {
		res := mustCall(t, c, &wspb.ControlCall{
			Id: id,
			Call: &wspb.ControlCall_Spawn{Spawn: &wspb.SpawnCall{
				Cwd: proto.String("/w/idempotent"), SpawnId: proto.String("spawn-1"),
			}},
		})
		return spawnedSid(t, res)
	}
	first := spawn("spawn-first")
	second := spawn("spawn-second")
	if first != second {
		t.Fatalf("spawn id reuse started a second child: %q != %q", first, second)
	}
}

// TestControlHydrateCarriesQueueAndDialogs pins the hydrate payload: an empty
// ledger and no dialogs still arrive as explicit empty values.
func TestControlHydrateCarriesQueueAndDialogs(t *testing.T) {
	c, sid := queueControlFixture(t)
	res := mustCall(t, c, &wspb.ControlCall{
		Id:   "hydrate",
		Call: &wspb.ControlCall_Hydrate{Hydrate: &wspb.HydrateCall{Sid: sid}},
	})
	hydrated := res.GetHydrate()
	if hydrated == nil {
		t.Fatalf("hydrate result = %+v", res)
	}
	if hydrated.GetQueue() == nil {
		t.Fatal("hydrate omitted the queue snapshot")
	}
	if len(hydrated.GetDialogs()) != 0 {
		t.Fatalf("hydrate dialogs = %+v", hydrated.GetDialogs())
	}
}

// TestEventToWireQueueAndDialogEvents covers the four extension event variants
// added with the queue ledger and retained dialogs.
func TestEventToWireQueueAndDialogEvents(t *testing.T) {
	queueEvent, err := eventToWire(rpc.Event{
		Evt: rpc.EvtQueueChanged,
		Sid: "sid-1",
		Seq: 4,
		Data: rpc.QueueSnapshot{SessionEpoch: "epoch", Items: []rpc.QueueItem{{
			ID: "item-1", Sid: "sid-1", Delivery: rpc.QueuePrompt, State: rpc.QueueLocal,
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	changed := queueEvent.GetQueueChanged()
	if changed == nil || len(changed.GetQueue().GetItems()) != 1 {
		t.Fatalf("queue changed event = %+v", queueEvent)
	}
	if changed.GetQueue().GetSessionEpoch() != "epoch" {
		t.Fatalf("queue epoch = %q", changed.GetQueue().GetSessionEpoch())
	}

	requestEvent, err := eventToWire(rpc.Event{
		Evt:  rpc.EvtExtensionUIRequest,
		Sid:  "sid-1",
		Seq:  5,
		Data: json.RawMessage(`{"id":"d1","method":"confirm","message":"ok?"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if requestEvent.GetExtensionUiRequest().GetRequest() == nil {
		t.Fatalf("extension request event = %+v", requestEvent)
	}

	closedEvent, err := eventToWire(rpc.Event{
		Evt:  rpc.EvtExtensionUIClosed,
		Sid:  "sid-1",
		Seq:  6,
		Data: map[string]any{"id": "d1", "reason": "timeout"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if closedEvent.GetExtensionUiClosed().GetId() != "d1" || closedEvent.GetExtensionUiClosed().GetReason() != "timeout" {
		t.Fatalf("extension closed event = %+v", closedEvent)
	}

	toolEvent, err := eventToWire(rpc.Event{
		Evt:  rpc.EvtToolExecutionUpdate,
		Sid:  "sid-1",
		Seq:  7,
		Data: json.RawMessage(`{"toolCallId":"t1","status":"running"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if toolEvent.GetToolExecutionUpdate().GetPayload() == nil {
		t.Fatalf("tool execution event = %+v", toolEvent)
	}
}
