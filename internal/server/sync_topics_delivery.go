package server

import (
	"time"

	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/pibridge"
)

// wireSyncTopics connects the local engine to the native bridge. The
// subscription callback enters admission; the ACK callback re-enters pump
// after the bridge has released its own locks.
func (app *Server) wireSyncTopics() {
	_, _ = app.loadSyncConfig()
	if app.bridge == nil || app.syncTopics == nil {
		return
	}
	app.bridge.SetSyncboardTopicEpoch(app.syncTopics.epoch)
	app.bridge.SetSyncboardTopicRetireHandler(func(retirement pibridge.SyncboardTopicRetirement) {
		app.retireSyncTopicOwner(retirement)
	})
	app.bridge.SetSyncboardTopicSubscriber(func(owner pibridge.SyncboardOwner, topic string) error {
		cfg, err := app.loadSyncConfig()
		if err != nil || (cfg.SyncCoordinator != "" && app.syncTopicPeer == nil) {
			return pibridge.ErrTopicUnavailable
		}
		if app.syncTopicPeer != nil {
			return app.syncTopicPeer.Register(owner, topic)
		}
		app.syncMu.Lock()
		defer app.syncMu.Unlock()
		return app.bridge.WithSyncboardTopicOwners([]pibridge.SyncboardOwner{owner}, app.syncTopics.epoch, func(valid []pibridge.SyncboardOwner) error {
			if len(valid) != 1 {
				return pibridge.ErrTopicUnavailable
			}
			switch app.syncTopics.subscribeLocked(syncTopicOwnerFromBridge(owner), topic) {
			case nil:
				return nil
			case errSyncTopicInvalid:
				return piapp.ErrSyncTopicInvalid
			case errSyncTopicTooLarge:
				return piapp.ErrSyncTopicTooLarge
			default:
				return piapp.ErrSyncTopicCapacity
			}
		})
	})
	app.bridge.SetSyncboardTopicAckHandler(func(owner pibridge.SyncboardOwner, epoch string, seq uint64, batchID string) {
		if _, err := app.loadSyncConfig(); err != nil {
			return
		}
		if app.syncTopicPeer != nil {
			app.syncTopicPeer.Ack(owner, epoch, seq, batchID)
			return
		}
		app.syncMu.Lock()
		ok := app.syncTopics.acknowledgeLocked(syncTopicOwnerFromBridge(owner), epoch, seq, batchID)
		app.syncMu.Unlock()
		if ok {
			app.pumpSyncTopics(time.Now())
		}
	})
	// Install the bridge epoch and callbacks before a follower can connect.
	app.startSyncTopicsPeer()
	go app.peerRegistry().sweepLoop(app)
}

// withSyncTopicOwnersLocked keeps every selected local identity current
// through the board/topic commit. Stale owners are retired before capacity is
// evaluated. Remote owners are ordered by cohort controls under syncMu.
func (app *Server) withSyncTopicOwnersLocked(topic string, commit func() error) error {
	if app.bridge == nil {
		return commit()
	}
	var owners []pibridge.SyncboardOwner
	for key := range app.syncTopics.byTopic[topic] {
		owner := app.syncTopics.owners[key]
		if owner != nil && !owner.remote {
			owners = append(owners, pibridge.SyncboardOwner{
				PaneID: owner.paneID, ProcessID: owner.processID, Generation: owner.generation,
				RuntimeID: owner.runtimeID, SessionID: owner.sessionID,
			})
		}
	}
	if len(owners) == 0 {
		return commit()
	}
	return app.bridge.WithSyncboardTopicOwners(owners, app.syncTopics.epoch, func(valid []pibridge.SyncboardOwner) error {
		current := make(map[pibridge.SyncboardOwner]bool, len(valid))
		for _, owner := range valid {
			current[owner] = true
		}
		for _, owner := range owners {
			if !current[owner] {
				app.syncTopics.retireGenerationLocked(syncTopicOwnerFromBridge(owner))
			}
		}
		return commit()
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
	if app.configStore() != nil {
		if _, err := app.loadSyncConfig(); err != nil {
			return
		}
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
