package server

import (
	"time"

	"github.com/hypernewbie/phi/internal/pibridge"
)

// wireSyncTopics connects the local engine to the native bridge. The
// subscription callback enters admission; the ACK callback re-enters pump
// after the bridge has released its own locks.
func (app *Server) wireSyncTopics() {
	if app.bridge == nil || app.syncTopics == nil {
		return
	}
	app.startSyncTopicsPeer()
	go app.peerRegistry().sweepLoop(app)
	app.bridge.SetSyncboardTopicEpoch(app.syncTopics.epoch)
	app.bridge.SetSyncboardTopicRetireHandler(func(retirement pibridge.SyncboardTopicRetirement) {
		app.retireSyncTopicOwner(retirement)
	})
	app.bridge.SetSyncboardTopicSubscriber(func(owner pibridge.SyncboardOwner, topic string) error {
		if app.syncTopicPeer != nil {
			return app.syncTopicPeer.Register(owner, topic)
		}
		app.syncMu.Lock()
		defer app.syncMu.Unlock()
		err := app.syncTopics.subscribeLocked(syncTopicOwnerFromBridge(owner), topic)
		switch {
		case err == nil:
			return nil
		case err == errSyncTopicInvalid:
			return errSyncTopicInvalid
		case err == errSyncTopicTooLarge:
			return errSyncTopicTooLarge
		default:
			return errSyncTopicCapacity
		}
	})
	app.bridge.SetSyncboardTopicAckHandler(func(owner pibridge.SyncboardOwner, epoch string, seq uint64, batchID string) {
		if app.syncTopicPeer != nil && app.syncTopicPeer.Ack(owner, epoch, seq, batchID) {
			return
		}
		app.syncMu.Lock()
		ok := app.syncTopics.acknowledgeLocked(syncTopicOwnerFromBridge(owner), epoch, seq, batchID)
		app.syncMu.Unlock()
		if ok {
			app.pumpSyncTopics(time.Now())
		}
	})
}

func syncTopicOwnerFromBridge(owner pibridge.SyncboardOwner) syncTopicOwner {
	return syncTopicOwner{
		paneID: owner.PaneID, processID: owner.ProcessID,
		generation: owner.Generation, runtimeID: owner.RuntimeID, sessionID: owner.SessionID,
	}
}

// retireSyncTopicOwner cancels the captured local owner and forwards the
// retirement to a configured coordinator. The native tuple check keeps a
// delayed fence from cancelling a replacement generation.
func (app *Server) retireSyncTopicOwner(retirement pibridge.SyncboardTopicRetirement) {
	app.syncMu.Lock()
	app.syncTopics.retireGenerationLocked(syncTopicOwnerFromBridge(retirement.Owner))
	app.syncMu.Unlock()
	if app.syncTopicPeer != nil {
		app.syncTopicPeer.RetireOwner(retirement.Owner, retirement.Epoch)
	}
}

// pumpSyncTopics seals expired batches and dispatches at most one head per
// owner. Bridge admission runs outside the board lock.
func (app *Server) pumpSyncTopics(now time.Time) {
	if app.syncTopics == nil || app.bridge == nil {
		return
	}
	app.syncMu.Lock()
	deliveries := app.syncTopics.pumpLocked(now)
	for _, d := range deliveries {
		app.syncTopics.markSentLocked(d.owner, d.batch.id, now)
	}
	app.syncMu.Unlock()
	for _, d := range deliveries {
		if d.owner.remote {
			err := d.owner.remoteSend(d.batch)
			if err != nil {
				app.syncMu.Lock()
				app.syncTopics.markUnsentLocked(d.owner, d.batch.id)
				app.syncMu.Unlock()
			}
			continue
		}
		err := app.bridge.SendSyncboardTopic(pibridge.SyncboardTopicPush{
			Owner: pibridge.SyncboardOwner{
				PaneID: d.owner.paneID, ProcessID: d.owner.processID,
				RuntimeID: d.owner.runtimeID, SessionID: d.owner.sessionID,
				Generation: d.owner.generation,
			},
			Seq: d.batch.seq, Topic: d.batch.topic, Epoch: app.syncTopics.epoch,
			Value: d.batch.text, BatchID: d.batch.id, UpdatedAt: d.batch.created.UnixMilli(),
		})
		if err != nil {
			app.syncMu.Lock()
			app.syncTopics.markUnsentLocked(d.owner, d.batch.id)
			app.syncMu.Unlock()
		}
	}
}

func (app *Server) startSyncTopicsDelivery() {
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			if app.shuttingDown.Load() {
				return
			}
			app.pumpSyncTopics(time.Now())
		}
	}()
}
