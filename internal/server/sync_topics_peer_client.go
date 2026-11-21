package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/pibridge"
)

type syncTopicPeerIntent struct {
	owner syncTopicWireOwn
	topic string
}

type syncTopicPeerRetire struct {
	owner syncTopicWireOwn
	key   string
}

type syncTopicPeerPending struct {
	seq         uint64
	action      string
	owner       syncTopicWireOwn
	topic       string
	fingerprint string
	done        chan struct{}
	result      error
	retired     bool
}

type syncTopicPeerClient struct {
	app        *Server
	url        url.URL
	targetBase string
	peerID     string
	secret     string
	instance   string

	mu       sync.Mutex
	ws       *websocket.Conn
	writer   *syncTopicPeerWriter
	active   bool
	ready    bool
	blocked  bool
	terminal bool
	retired  bool
	epoch    string

	expectedPrior string
	fence         string
	stream        string
	control       uint64
	pending       *syncTopicPeerPending
	intents       map[string]syncTopicPeerIntent
	dirtyRetire   map[string]syncTopicPeerRetire
	batches       map[string]syncTopicWireOwn
	readySent     bool
	hadReady      bool
}

func newSyncTopicPeerClient(app *Server, target url.URL, targetBase, peerID, secret string) *syncTopicPeerClient {
	return &syncTopicPeerClient{
		app: app, url: target, targetBase: targetBase, peerID: peerID, secret: secret, instance: randomPeerToken(),
		intents: make(map[string]syncTopicPeerIntent), dirtyRetire: make(map[string]syncTopicPeerRetire),
		batches: make(map[string]syncTopicWireOwn),
	}
}

func (c *syncTopicPeerClient) run() {
	backoff := 500 * time.Millisecond
	for {
		if c.app.shuttingDown.Load() {
			return
		}
		c.mu.Lock()
		blocked := c.blocked
		c.mu.Unlock()
		if blocked {
			return
		}
		cfg, err := c.app.configStore().LoadWithError()
		if err != nil {
			time.Sleep(backoff)
			continue
		}
		if cfg.SyncCoordinator != c.targetBase || cfg.SyncTopicsPeerID != c.peerID {
			c.mu.Lock()
			c.blocked = true
			c.mu.Unlock()
			if c.app.bridge != nil {
				c.app.bridge.RetireSyncboardTopicBindings("peer-config-changed")
			}
			return
		}
		if cfg.SyncTopicsPeerSecret != c.secret {
			c.mu.Lock()
			c.secret = cfg.SyncTopicsPeerSecret
			c.retired = true
			c.ready = false
			c.intents = make(map[string]syncTopicPeerIntent)
			c.dirtyRetire = make(map[string]syncTopicPeerRetire)
			c.batches = make(map[string]syncTopicWireOwn)
			ws := c.ws
			c.mu.Unlock()
			if c.app.bridge != nil {
				c.app.bridge.RetireSyncboardTopicBindings("peer-secret-rotated")
			}
			if ws != nil {
				_ = ws.Close()
			}
		}
		if cfg.SyncCoordinator == "" || cfg.SyncTopicsPeerSecret == "" {
			time.Sleep(backoff)
			continue
		}
		c.mu.Lock()
		c.hadReady = false
		c.mu.Unlock()
		err = c.connect(cfg.SyncTopicsPeerSecret)
		c.mu.Lock()
		recovered := c.hadReady
		c.hadReady = false
		c.mu.Unlock()
		if err == nil || recovered {
			backoff = 500 * time.Millisecond
		} else if backoff < 5*time.Second {
			backoff *= 2
			if backoff > 5*time.Second {
				backoff = 5 * time.Second
			}
		}
		time.Sleep(backoff)
	}
}

func (c *syncTopicPeerClient) applyPeerRevocation() {
	c.mu.Lock()
	if c.dirtyRetire == nil {
		c.dirtyRetire = make(map[string]syncTopicPeerRetire)
	}
	for key, intent := range c.intents {
		c.dirtyRetire[intent.owner.Pane+"\x00"+intent.owner.Process] = syncTopicPeerRetire{
			owner: intent.owner, key: intent.owner.Pane + "\x00" + intent.owner.Process,
		}
		delete(c.intents, key)
	}
	c.retired = true
	c.ready = false
	c.active = false
	c.mu.Unlock()
	if c.app.bridge != nil {
		c.app.bridge.RetireSyncboardTopicBindings("peer-revoked")
	}
}

func (c *syncTopicPeerClient) connect(secret string) error {
	dialer := websocket.Dialer{
		Subprotocols:     []string{syncTopicsPeerProtocol},
		HandshakeTimeout: syncTopicsPeerHandshakeTimeout,
	}
	header := http.Header{}
	header.Set(syncTopicsPeerHeader, c.peerID)
	header.Set(syncTopicsSecretHeader, secret)
	ws, resp, err := dialer.Dial(c.url.String(), header)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			const refusal = `{"sync_topics":"refused","reason":"not-authorized"}`
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
			// A failed upgrade can expose only a bounded error-body prefix.
			// Require its declared complete length too; a truncated or chunked
			// prefix cannot prove permanent revocation.
			if readErr == nil && resp.ContentLength == int64(len(refusal)) && string(body) == refusal {
				c.applyPeerRevocation()
			}
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		c.mu.Lock()
		c.active = false
		c.ready = false
		c.mu.Unlock()
		return err
	}
	ws.SetReadLimit(syncTopicsPeerFrame)
	_ = ws.SetReadDeadline(time.Now().Add(syncTopicsPeerHandshakeTimeout))
	offerFrame, err := readPeerFrame(ws)
	if err != nil || offerFrame.Type != "offer" || offerFrame.Version != syncTopicsPeerVersion ||
		offerFrame.Epoch == "" || len(offerFrame.Epoch) > syncTopicsPeerMaxID || !validPeerState(offerFrame.State) {
		_ = ws.Close()
		return errors.New("invalid peer offer")
	}
	offer := *offerFrame
	c.mu.Lock()
	if c.epoch != offer.Epoch {
		c.epoch = offer.Epoch
		c.expectedPrior = offer.Fence
		c.fence = ""
		c.stream = ""
		c.control = 0
		c.pending = nil
		c.terminal = false
		c.retired = false
		c.ready = false
		c.readySent = false
		c.intents = make(map[string]syncTopicPeerIntent)
		c.dirtyRetire = make(map[string]syncTopicPeerRetire)
		c.batches = make(map[string]syncTopicWireOwn)
		c.mu.Unlock()
		if c.app.bridge != nil {
			c.app.bridge.SetSyncboardTopicEpoch(offer.Epoch)
		}
		c.mu.Lock()
	} else if c.expectedPrior == "" && offer.Fence != "" {
		c.expectedPrior = offer.Fence
	}
	if c.expectedPrior == "" {
		c.expectedPrior = offer.Fence
	}
	prior := c.expectedPrior
	c.mu.Unlock()
	_ = ws.SetWriteDeadline(time.Now().Add(syncTopicsPeerHandshakeTimeout))
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch,
		Instance: c.instance, Prior: prior,
	}); err != nil {
		_ = ws.Close()
		return err
	}
	_ = ws.SetReadDeadline(time.Now().Add(syncTopicsPeerHandshakeTimeout))
	boundFrame, err := readPeerFrame(ws)
	if err != nil || boundFrame.Type != "bound" || boundFrame.Epoch != offer.Epoch ||
		boundFrame.Fence == "" || boundFrame.Stream == "" || !validPeerState(boundFrame.State) {
		_ = ws.Close()
		return errors.New("invalid peer bound")
	}
	bound := *boundFrame
	c.mu.Lock()
	wasTerminal := c.terminal
	writer := newSyncTopicPeerWriter(ws)
	c.ws = ws
	c.writer = writer
	c.fence = bound.Fence
	c.stream = bound.Stream
	c.active = true
	c.ready = false
	c.readySent = false
	c.terminal = bound.State == "terminal" || wasTerminal
	if c.terminal {
		c.control = math.MaxUint64
		c.pending = nil
		c.dirtyRetire = make(map[string]syncTopicPeerRetire)
		_ = c.writeLocked(syncTopicPeerFrame{
			Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
			Control: canonicalCounter(math.MaxUint64), Action: "retire_cohort",
		})
	}
	if bound.Retired {
		c.retired = true
		c.intents = make(map[string]syncTopicPeerIntent)
		c.batches = make(map[string]syncTopicWireOwn)
	}
	pending := c.pending
	if c.retired {
		c.mu.Unlock()
		if c.app.bridge != nil {
			c.app.bridge.RetireSyncboardTopicBindings("peer-retired")
		}
		c.mu.Lock()
	}
	if c.terminal {
		// The terminal reservation was sent above. No ready is permitted.
	} else if pending != nil {
		_ = c.writeLocked(syncTopicPeerFrame{
			Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
			Control: canonicalCounter(pending.seq), Action: pending.action,
			Owner: &pending.owner, Topic: pending.topic,
		})
	} else {
		c.pumpControlLocked()
	}
	c.mu.Unlock()
	heartbeatStop, heartbeatDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		c.heartbeat(ws, heartbeatStop)
	}()
	defer func() {
		close(heartbeatStop)
		writer.close()
		<-heartbeatDone
		c.mu.Lock()
		if c.ws == ws {
			c.active = false
			c.ready = false
			c.ws = nil
			c.writer = nil
		}
		c.mu.Unlock()
	}()
	_ = ws.SetReadDeadline(time.Now().Add(syncTopicsPeerReadTimeout))
	ws.SetPongHandler(func(string) error { return ws.SetReadDeadline(time.Now().Add(syncTopicsPeerReadTimeout)) })
	for {
		var frame syncTopicPeerFrame
		messageType, data, err := ws.ReadMessage()
		if err != nil || messageType != websocket.TextMessage || validatePeerFrameSize(data) != nil || json.Unmarshal(data, &frame) != nil {
			return errSyncTopicPeerNotReady
		}
		switch frame.Type {
		case "result":
			c.handleResult(&frame)
		case "ready_ack":
			c.handleReadyAck(&frame)
		case "batch":
			c.handleBatch(&frame)
		case "refused":
			c.mu.Lock()
			c.blocked = true
			c.mu.Unlock()
			return errors.New("peer refused")
		default:
			return errors.New("unknown peer frame")
		}
	}
}

func (c *syncTopicPeerClient) sendReadyLocked() {
	if c.ws == nil || c.ready || c.readySent || c.terminal || c.pending != nil || len(c.dirtyRetire) > 0 {
		return
	}
	c.readySent = true
	_ = c.writeLocked(syncTopicPeerFrame{
		Type: "ready", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
		Last: canonicalCounter(c.control),
	})
}

func (c *syncTopicPeerClient) handleReadyAck(frame *syncTopicPeerFrame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if frame.Epoch != c.epoch || frame.Fence != c.fence || frame.Stream != c.stream {
		return
	}
	last, ok := parsePeerCounter(frame.Last, true)
	if !ok || last != c.control {
		return
	}
	c.ready = true
	c.readySent = false
	c.retired = false
	c.hadReady = true
	c.pumpControlLocked()
}

func (c *syncTopicPeerClient) handleResult(frame *syncTopicPeerFrame) {
	c.mu.Lock()
	pending := c.pending
	if pending == nil || frame.Epoch != c.epoch || frame.Fence != c.fence || frame.Stream != c.stream {
		c.mu.Unlock()
		return
	}
	seq, ok := parsePeerCounter(frame.Control, false)
	if !ok || seq != pending.seq {
		c.mu.Unlock()
		return
	}
	c.control = seq
	if c.writer != nil {
		c.writer.confirmControl(frame.Control)
	}
	c.pending = nil
	if frame.Result == "ok" && pending.action == "register" && !pending.retired {
		c.intents[pending.ownerKey()] = syncTopicPeerIntent{owner: pending.owner, topic: pending.topic}
	}
	if frame.Result != "ok" || pending.retired {
		pending.result = errSyncTopicPeerNotReady
	}
	close(pending.done)
	c.pumpControlLocked()
	c.mu.Unlock()
}

func (p *syncTopicPeerPending) ownerKey() string {
	return p.owner.Pane + "\x00" + p.owner.Process + "\x00" + p.topic
}

func (c *syncTopicPeerClient) Register(owner pibridge.SyncboardOwner, topic string) error {
	wire := *wireOwnerFromPibridge(owner)
	c.mu.Lock()
	var pending *syncTopicPeerPending
	var fresh, exhausted bool
	prepare := func() error {
		if c.blocked || !c.active || !c.ready || c.terminal {
			return errSyncTopicPeerNotReady
		}
		key := wire.Pane + "\x00" + wire.Process + "\x00" + topic
		if intent, ok := c.intents[key]; ok {
			if intent.owner != wire {
				return errSyncTopicPeerNotReady
			}
			return nil
		}
		if len(c.intents) >= maxSyncTopicPeerIntents || len(c.dirtyRetire) > 0 {
			return errSyncTopicPeerNotReady
		}
		if c.pending != nil {
			if c.pending.action != "register" || c.pending.ownerKey() != key || c.pending.owner != wire {
				return errSyncTopicPeerNotReady
			}
			pending = c.pending
			return nil
		}
		if c.control >= math.MaxUint64-1 {
			exhausted = true
			return errSyncTopicPeerNotReady
		}
		pending = &syncTopicPeerPending{
			seq: c.control + 1, action: "register", owner: wire, topic: topic,
			done: make(chan struct{}),
		}
		pending.fingerprint = peerControlFingerprint(&syncTopicPeerFrame{
			Action: pending.action, Owner: &pending.owner, Topic: pending.topic,
		})
		c.pending = pending
		c.readySent = false
		fresh = true
		return nil
	}
	var err error
	if c.app.bridge == nil {
		err = prepare()
	} else {
		// Pin the native binding through intent selection or control staging.
		// Enqueue frames only after the bridge releases its admission locks.
		err = c.app.bridge.WithSyncboardTopicOwners([]pibridge.SyncboardOwner{owner}, c.epoch, func(valid []pibridge.SyncboardOwner) error {
			if len(valid) != 1 {
				return pibridge.ErrTopicUnavailable
			}
			return prepare()
		})
	}
	if exhausted {
		c.exhaustControlLocked()
	}
	if err != nil || pending == nil {
		c.mu.Unlock()
		return err
	}
	if !fresh {
		c.mu.Unlock()
		return waitPeerResult(pending)
	}
	err = c.writeLocked(syncTopicPeerFrame{
		Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
		Control: canonicalCounter(pending.seq), Action: pending.action,
		Owner: &pending.owner, Topic: pending.topic,
	})
	if err != nil {
		c.pending = nil
	}
	c.mu.Unlock()
	if err != nil {
		return errSyncTopicPeerNotReady
	}
	go c.retryPending(pending)
	return waitPeerResult(pending)
}

func waitPeerResult(pending *syncTopicPeerPending) error {
	select {
	case <-pending.done:
		return pending.result
	case <-time.After(syncTopicsPeerControlTimeout):
		return errSyncTopicPeerNotReady
	}
}

func (c *syncTopicPeerClient) retryPending(pending *syncTopicPeerPending) {
	timer := time.NewTimer(syncTopicsPeerControlTimeout)
	defer timer.Stop()
	select {
	case <-pending.done:
		return
	case <-timer.C:
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		c.mu.Lock()
		if c.pending != pending || !c.active {
			c.mu.Unlock()
			return
		}
		_ = c.writeLocked(syncTopicPeerFrame{
			Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
			Control: canonicalCounter(pending.seq), Action: pending.action,
			Owner: &pending.owner, Topic: pending.topic,
		})
		c.mu.Unlock()
		select {
		case <-pending.done:
			return
		case <-ticker.C:
		}
	}
}

func (c *syncTopicPeerClient) RetireOwner(owner pibridge.SyncboardOwner, epoch string) {
	wire := *wireOwnerFromPibridge(owner)
	key := wire.Pane + "\x00" + wire.Process
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.epoch == "" || epoch != c.epoch || c.terminal {
		return
	}
	if c.pending != nil && c.pending.action == "register" && c.pending.owner == wire {
		c.pending.retired = true
	}
	for intentKey, intent := range c.intents {
		if intent.owner == wire {
			delete(c.intents, intentKey)
		}
	}
	if previous, ok := c.dirtyRetire[key]; ok && previous.owner.Generation > wire.Generation {
		return
	}
	if _, exists := c.dirtyRetire[key]; !exists && len(c.dirtyRetire) >= maxSyncTopicPeerIntents {
		c.exhaustControlLocked()
		return
	}
	c.dirtyRetire[key] = syncTopicPeerRetire{owner: wire, key: key}
	c.pumpControlLocked()
}

func (c *syncTopicPeerClient) pumpControlLocked() {
	if !c.active || c.terminal || c.pending != nil || len(c.dirtyRetire) == 0 {
		c.sendReadyLocked()
		return
	}
	if c.control >= math.MaxUint64-1 {
		c.exhaustControlLocked()
		return
	}
	keys := make([]string, 0, len(c.dirtyRetire))
	for key := range c.dirtyRetire {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	item := c.dirtyRetire[keys[0]]
	delete(c.dirtyRetire, keys[0])
	if c.control == math.MaxUint64 {
		c.dirtyRetire[keys[0]] = item
		return
	}
	pending := &syncTopicPeerPending{
		seq: c.control + 1, action: "retire_owner", owner: item.owner,
		done: make(chan struct{}),
	}
	c.pending = pending
	c.readySent = false
	err := c.writeLocked(syncTopicPeerFrame{
		Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
		Control: canonicalCounter(pending.seq), Action: pending.action, Owner: &pending.owner,
	})
	if err != nil {
		c.pending = nil
		c.dirtyRetire[keys[0]] = item
		return
	}
	go c.retryPending(pending)
}

func (c *syncTopicPeerClient) exhaustControlLocked() {
	if c.terminal {
		return
	}
	c.terminal = true
	c.control = math.MaxUint64
	c.pending = nil
	c.dirtyRetire = make(map[string]syncTopicPeerRetire)
	c.intents = make(map[string]syncTopicPeerIntent)
	c.batches = make(map[string]syncTopicWireOwn)
	if c.ws != nil {
		_ = c.writeLocked(syncTopicPeerFrame{
			Type: "control", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
			Control: canonicalCounter(math.MaxUint64), Action: "retire_cohort",
		})
	}
}

func (c *syncTopicPeerClient) Ack(owner pibridge.SyncboardOwner, epoch string, seq uint64, batchID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.active || !c.ready || c.epoch != epoch {
		return false
	}
	stored, ok := c.batches[batchID]
	if !ok || stored.Pane != owner.PaneID || stored.Process != owner.ProcessID ||
		stored.Generation != owner.Generation || stored.RuntimeID != owner.RuntimeID ||
		stored.SessionID != owner.SessionID {
		return false
	}
	wire := wireOwnerFromPibridge(owner)
	if err := c.writeLocked(syncTopicPeerFrame{
		Type: "ack", Epoch: c.epoch, Fence: c.fence, Stream: c.stream,
		Owner: wire, BatchID: batchID, Seq: canonicalCounter(seq),
	}); err != nil {
		return false
	}
	delete(c.batches, batchID)
	return true
}

func (c *syncTopicPeerClient) handleBatch(frame *syncTopicPeerFrame) {
	c.mu.Lock()
	if !c.active || !c.ready || c.epoch != frame.Epoch || c.fence != frame.Fence || c.stream != frame.Stream ||
		frame.Owner == nil || !validPeerOwner(frame.Owner) || !validPeerTopic(frame.Topic) ||
		!validPeerID(frame.BatchID) {
		c.mu.Unlock()
		return
	}
	seq, ok := parsePeerCounter(frame.Seq, false)
	if !ok {
		c.mu.Unlock()
		return
	}
	if len(c.batches) >= maxSyncTopicPeerBatches {
		c.mu.Unlock()
		return
	}
	value, err := base64.StdEncoding.DecodeString(frame.Value)
	if err != nil || len(value) > syncTopicsPeerMaxValue {
		c.mu.Unlock()
		return
	}
	owner := *frame.Owner
	batchID := frame.BatchID
	c.batches[batchID] = owner
	epoch := c.epoch
	c.mu.Unlock()
	err = c.app.bridge.SendSyncboardTopic(pibridge.SyncboardTopicPush{
		Owner: pibridge.SyncboardOwner{
			PaneID: owner.Pane, ProcessID: owner.Process, RuntimeID: owner.RuntimeID,
			SessionID: owner.SessionID, Generation: owner.Generation,
		},
		Seq: seq, Topic: frame.Topic, Epoch: epoch, Value: value, BatchID: batchID,
		UpdatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		c.mu.Lock()
		delete(c.batches, batchID)
		c.mu.Unlock()
	}
}

func (c *syncTopicPeerClient) heartbeat(ws *websocket.Conn, stop <-chan struct{}) {
	ticker := time.NewTicker(syncTopicsPeerPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if err := ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(syncTopicsPeerControlTimeout)); err != nil {
				_ = ws.Close()
				return
			}
		}
	}
}

func (c *syncTopicPeerClient) writeLocked(frame syncTopicPeerFrame) error {
	if c.writer == nil {
		return errSyncTopicPeerNotReady
	}
	err := c.writer.enqueue(frame)
	if err != nil {
		// All follower frames are recoverable controls or ACKs. Closing a
		// saturated stream prevents a lost ready/control from wedging it;
		// retained intents and coordinator reservations survive reconnect.
		_ = c.ws.Close()
	}
	return err
}
