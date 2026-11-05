package server

import (
	"reflect"
	"testing"

	"github.com/hypernewbie/phi/internal/syncmesh"
	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func TestPushQueueRetriesUnavailablePaneWithoutRepeatingHandoffs(t *testing.T) {
	var queue syncPushQueue
	queue.add(&syncmeshb.SyncEvent{Seq: 2, Recipient: "offline"})
	queue.add(&syncmeshb.SyncEvent{Seq: 4, Recipient: "live"})
	var delivered []uint64
	online := false
	deliver := func(ev *syncmeshb.SyncEvent) bool {
		if ev.GetRecipient() == "offline" && !online {
			return false
		}
		delivered = append(delivered, ev.GetSeq())
		return true
	}
	queue.retry(deliver)
	if !reflect.DeepEqual(delivered, []uint64{4}) {
		t.Fatalf("blocked pane delayed others: %v", delivered)
	}
	// A gap can recover older messages after newer ones already arrived.
	for seq := uint64(1); seq <= 4; seq++ {
		queue.add(&syncmeshb.SyncEvent{Seq: seq, Recipient: "offline"})
	}
	online = true
	queue.retry(deliver)
	queue.retry(deliver)
	if !reflect.DeepEqual(delivered, []uint64{4, 1, 2, 3}) {
		t.Fatalf("resync lost or repeated handoffs: %v", delivered)
	}
}

func TestPushQueueRetainsOnlyHubWindow(t *testing.T) {
	var queue syncPushQueue
	for seq := uint64(1); seq <= syncmesh.MaxStoredMessages+2; seq++ {
		queue.add(&syncmeshb.SyncEvent{Seq: seq})
	}
	queue.add(&syncmeshb.SyncEvent{Seq: 1}) // stale live event after resync
	if len(queue.entries) != syncmesh.MaxStoredMessages || len(queue.order) != syncmesh.MaxStoredMessages || queue.order[0] != 3 {
		t.Fatalf("queue does not match bounded hub window: count=%d first=%d", len(queue.entries), queue.order[0])
	}
}
