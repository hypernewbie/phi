package server

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hypernewbie/phi/internal/piapp"
)

func pausedSyncTopicWriter() *syncTopicPeerWriter {
	return &syncTopicPeerWriter{wake: make(chan struct{}, 1)}
}

func TestSyncTopicPeerWriterBoundsAndCoalescesEncodedFrames(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		want  int
	}{
		{"frames", "small", syncTopicsPeerQueueFrames},
		{"bytes", strings.Repeat("x", 96*1024), 2},
		{"escaped-bytes", strings.Repeat("\x00", 16*1024), 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writer := pausedSyncTopicWriter()
			for i := 0; i < tc.want; i++ {
				frame := syncTopicPeerFrame{Type: "batch", BatchID: fmt.Sprint(i), Value: tc.value}
				if err := writer.enqueue(frame); err != nil {
					t.Fatal(err)
				}
				// Same-stream retries consume no second frame or byte reservation.
				if err := writer.enqueue(frame); err != nil {
					t.Fatal(err)
				}
			}
			charged := writer.bytes
			if err := writer.enqueue(syncTopicPeerFrame{Type: "batch", BatchID: "overflow", Value: tc.value}); !errors.Is(err, errSyncTopicCapacity) {
				t.Fatalf("overflow = %v", err)
			}
			if len(writer.queue) != tc.want || writer.bytes != charged || charged > syncTopicsPeerQueueBytes {
				t.Fatalf("overflow evicted or overcharged retained frames: frames=%d bytes=%d", len(writer.queue), writer.bytes)
			}
		})
	}
}

func TestSyncTopicPeerWriterConfirmationCancelsOnlyUnsentControlRetry(t *testing.T) {
	writer := pausedSyncTopicWriter()
	frames := []syncTopicPeerFrame{
		{Type: "control", Control: "1"},
		{Type: "control", Control: "2"},
		{Type: "result", Control: "2"},
		{Type: "control", Control: "3"},
	}
	for _, frame := range frames {
		if err := writer.enqueue(frame); err != nil {
			t.Fatal(err)
		}
	}
	writer.active = writer.queue[0]
	writer.confirmControl("1") // An in-flight write cannot be recalled.
	writer.confirmControl("2")
	if len(writer.queue) != 3 || writer.queue[0] != writer.active || writer.queue[1].kind != "result" || writer.queue[2].control != "3" {
		t.Fatalf("confirmation dropped unrelated or in-flight work: %+v", writer.queue)
	}
	charged := 0
	for _, pending := range writer.queue {
		charged += len(pending.data)
	}
	if writer.bytes != charged {
		t.Fatalf("confirmation byte accounting = %d, want %d", writer.bytes, charged)
	}
}

func TestSyncTopicPeerQueuePressurePreservesReservationsAndOtherOwnerProgress(t *testing.T) {
	app := New(Options{})
	app.bridge = &piapp.Bridge{} // Only remote owners are dispatched below.
	slow, healthy := pausedSyncTopicWriter(), pausedSyncTopicWriter()
	for i := 0; i < syncTopicsPeerQueueFrames; i++ {
		if err := slow.enqueue(syncTopicPeerFrame{Type: "batch", BatchID: fmt.Sprint(i)}); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	for _, tc := range []struct {
		pane   string
		writer *syncTopicPeerWriter
	}{{"slow", slow}, {"healthy", healthy}} {
		writer := tc.writer
		owner := syncTopicOwner{paneID: tc.pane, processID: "proc", generation: 1, remote: true, peerID: tc.pane}
		owner.remoteSend = func(batch *syncTopicBatch) error {
			return writer.enqueue(syncTopicPeerFrame{Type: "batch", BatchID: batch.id, Value: string(batch.text)})
		}
		if err := app.syncTopics.subscribeRemoteLocked(owner, "alerts"); err != nil {
			t.Fatal(err)
		}
		app.syncTopics.markRemoteReadyLocked(owner.peerID, true)
	}
	if _, err := app.syncTopics.admitPostLocked("alerts", "value", now); err != nil {
		t.Fatal(err)
	}
	app.pumpSyncTopics(now.Add(syncTopicBatchWindow))
	slowOwner := app.syncTopics.owners["slow\x00proc"]
	healthyOwner := app.syncTopics.owners["healthy\x00proc"]
	if len(healthy.queue) != 1 || !healthyOwner.batches[0].sent || slowOwner.batches[0].sent || app.syncTopics.totalBatches != 2 {
		t.Fatal("a full peer queue blocked another owner or released an unacknowledged reservation")
	}
	// A later pump can retry the same slow head without allocating work.
	slow.queue, slow.bytes = nil, 0
	app.pumpSyncTopics(now.Add(syncTopicBatchWindow + time.Millisecond))
	if len(slow.queue) != 1 || app.syncTopics.totalBatches != 2 || len(healthy.queue) != 1 {
		t.Fatal("queue recovery lost a head, duplicated a send, or allocated another reservation")
	}
}
