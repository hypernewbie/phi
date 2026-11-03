package server

import (
	"log/slog"
	"slices"
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
	"github.com/hypernewbie/phi/internal/syncmesh"
	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

// Keep the same bounded window as the hub. A nil entry records successful
// handoff, so gap recovery cannot re-inject work already handed to the bridge.
type syncPushQueue struct {
	entries map[uint64]*syncmeshb.SyncEvent
	order   []uint64
	floor   uint64
}

func (q *syncPushQueue) add(ev *syncmeshb.SyncEvent) {
	seq := ev.GetSeq()
	if seq <= q.floor {
		return
	}
	if _, known := q.entries[seq]; known {
		return
	}
	if q.entries == nil {
		q.entries = make(map[uint64]*syncmeshb.SyncEvent)
	}
	index, _ := slices.BinarySearch(q.order, seq)
	q.order = slices.Insert(q.order, index, seq)
	q.entries[seq] = ev
	if len(q.order) > syncmesh.MaxStoredMessages {
		oldest := q.order[0]
		if dropped := q.entries[oldest]; dropped != nil {
			slog.Warn("syncboard push expired before bridge handoff", "message_id", dropped.GetMessageId())
		}
		delete(q.entries, oldest)
		q.order = q.order[1:]
		q.floor = oldest
	}
}

func (q *syncPushQueue) retry(deliver func(*syncmeshb.SyncEvent) bool) {
	for _, seq := range q.order {
		if ev := q.entries[seq]; ev != nil && deliver(ev) {
			q.entries[seq] = nil
		}
	}
}

func (app *Server) startSyncboardPush() {
	if app.syncMesh == nil {
		return
	}
	events, cancel := app.syncMesh.SubscribePush()
	done := make(chan struct{})
	app.syncPushCancel = func() { cancel(); <-done }
	go func() {
		defer close(done)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		var queue syncPushQueue
		for {
			select {
			case ev, ok := <-events:
				if !ok {
					return
				}
				if ev.GetGap() {
					// Recover the retained window before handling later live events.
					slog.Warn("syncboard push gap: recovering retained messages", "seq", ev.GetSeq())
					for _, retained := range app.syncMesh.RecentAddressed(syncmesh.MaxStoredMessages) {
						queue.add(retained)
					}
				} else {
					queue.add(ev)
				}
				queue.retry(app.deliverSyncboardPush)
			case <-ticker.C:
				// A disconnected or full pane must not require another publish
				// to receive work that never reached its bridge queue.
				queue.retry(app.deliverSyncboardPush)
			}
		}
	}()
}

func (app *Server) deliverSyncboardPush(ev *syncmeshb.SyncEvent) bool {
	if ev == nil || app.bridge == nil || ev.GetGap() {
		return false
	}
	return app.bridge.PushSyncboard(ev.GetRecipient(), pibridge.SyncboardPush{
		Seq: ev.GetSeq(), Sender: ev.GetSender(), Recipient: ev.GetRecipient(),
		Value: ev.GetValue(), UpdatedAtUnixMs: ev.GetUpdatedAtUnixMs(), MessageID: ev.GetMessageId(),
	}) == nil
}
