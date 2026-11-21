package server

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/config"
)

const (
	syncTopicsPeerPath     = "/ws/sync-topics"
	syncTopicsPeerHeader   = "X-Phi-Sync-Topics-Peer"
	syncTopicsSecretHeader = "X-Phi-Sync-Topics-Secret"
	syncTopicsPeerFrame    = 256 * 1024
	syncTopicsPeerLimit    = 64
)

var (
	syncTopicsPeerHandshakeTimeout = 5 * time.Second
	syncTopicsPeerReadTimeout      = 30 * time.Second
	syncTopicsPeerPingInterval     = 10 * time.Second
	syncTopicsPeerControlTimeout   = 5 * time.Second
)

var (
	errSyncTopicPeerNotReady = errors.New("sync topic peer not ready")
	errSyncTopicPeerConflict = errors.New("sync topic peer conflict")
)

type syncTopicCohort struct {
	key      string
	peerID   string
	instance string
	fence    string
	stream   string
	secret   string
	state    string
	retired  bool
	terminal bool
	ready    bool

	lastControl     uint64
	lastFingerprint string
	lastResult      string
	lastReason      string

	conn *syncTopicPeerConn
}

type syncTopicPeerRegistry struct {
	mu     sync.Mutex
	ops    sync.Mutex
	byKey  map[string]*syncTopicCohort
	byPeer map[string]*syncTopicCohort
}

func newSyncTopicPeerRegistry() *syncTopicPeerRegistry {
	return &syncTopicPeerRegistry{
		byKey:  make(map[string]*syncTopicCohort),
		byPeer: make(map[string]*syncTopicCohort),
	}
}

func (app *Server) peerRegistry() *syncTopicPeerRegistry {
	return app.syncTopicPeers
}

type syncTopicPeerConn struct {
	app    *Server
	ws     *websocket.Conn
	peerID string
	secret string
	cohort *syncTopicCohort
	writer *syncTopicPeerWriter
	closed chan struct{}
	once   sync.Once
}

func (c *syncTopicPeerConn) write(frame syncTopicPeerFrame) error {
	if c.writer == nil {
		return errSyncTopicPeerNotReady
	}
	err := c.writer.enqueue(frame)
	if err != nil && frame.Type != "batch" {
		c.close()
	}
	return err
}

func (c *syncTopicPeerConn) close() {
	c.once.Do(func() {
		if c.closed != nil {
			close(c.closed)
		}
		if c.writer != nil {
			c.writer.close()
		} else if c.ws != nil {
			_ = c.ws.Close()
		}
	})
}

func (app *Server) handleSyncTopicPeer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != syncTopicsPeerPath {
		http.NotFound(w, r)
		return
	}
	if app.configStore() == nil {
		http.Error(w, `{"sync_topics":"refused","reason":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cfg, err := app.loadSyncConfig()
	if err != nil {
		http.Error(w, `{"sync_topics":"refused","reason":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if cfg.SyncCoordinator != "" {
		http.Error(w, "Peer registration unavailable", http.StatusServiceUnavailable)
		return
	}
	if len(r.Header.Values(syncTopicsPeerHeader)) != 1 || len(r.Header.Values(syncTopicsSecretHeader)) != 1 {
		http.Error(w, `{"sync_topics":"refused","reason":"not-authorized"}`, http.StatusUnauthorized)
		return
	}
	peer := strings.TrimSpace(r.Header.Get(syncTopicsPeerHeader))
	secret := r.Header.Get(syncTopicsSecretHeader)
	if !peerAllowedSecret(cfg, peer, secret) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"sync_topics":"refused","reason":"not-authorized"}`))
		return
	}
	if !app.peerRegistry().hasCapacity(peer) {
		http.Error(w, "Peer registration capacity", http.StatusServiceUnavailable)
		return
	}
	up := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{syncTopicsPeerProtocol},
	}
	ws, err := up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(syncTopicsPeerFrame)
	conn := &syncTopicPeerConn{app: app, ws: ws, peerID: peer, secret: secret, writer: newSyncTopicPeerWriter(ws), closed: make(chan struct{})}
	defer conn.close()
	offerFence, offerState := app.peerRegistry().offer(peer)
	if err := conn.write(syncTopicPeerFrame{
		Type: "offer", Version: syncTopicsPeerVersion, Epoch: app.syncTopics.epoch,
		Fence: offerFence, State: offerState,
	}); err != nil {
		return
	}
	_ = ws.SetReadDeadline(time.Now().Add(syncTopicsPeerHandshakeTimeout))
	bindFrame, err := readPeerFrame(ws)
	if err != nil || bindFrame.Type != "bind" || bindFrame.Version != syncTopicsPeerVersion ||
		bindFrame.Epoch != app.syncTopics.epoch || !validPeerID(bindFrame.Instance) ||
		(bindFrame.Prior != "" && !validPeerID(bindFrame.Prior)) {
		return
	}
	bind := *bindFrame
	if !app.checkPeerAuthority(conn) {
		return
	}
	cohort, err := app.peerRegistry().bind(app, peer, bind.Instance, bind.Prior, conn)
	if err != nil {
		_ = conn.write(syncTopicPeerFrame{Type: "refused", Version: syncTopicsPeerVersion, Reason: peerBindReason(err)})
		return
	}
	conn.cohort = cohort
	defer app.peerRegistry().closeConn(app, conn)
	if !app.checkPeerAuthority(conn) {
		return
	}
	if err := conn.write(syncTopicPeerFrame{
		Type: "bound", Version: syncTopicsPeerVersion, Epoch: app.syncTopics.epoch,
		Fence: cohort.fence, Stream: cohort.stream, State: cohort.state, Retired: cohort.retired,
	}); err != nil {
		return
	}
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		conn.heartbeat()
	}()
	defer func() {
		conn.close()
		<-heartbeatDone
	}()
	_ = ws.SetReadDeadline(time.Now().Add(syncTopicsPeerReadTimeout))
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(time.Now().Add(syncTopicsPeerReadTimeout))
	})
	for {
		if !app.checkPeerAuthority(conn) {
			return
		}
		var frame syncTopicPeerFrame
		messageType, data, err := ws.ReadMessage()
		if err != nil || messageType != websocket.TextMessage || validatePeerFrameSize(data) != nil || json.Unmarshal(data, &frame) != nil {
			return
		}
		// Authority may change while ReadMessage waits for application data.
		if !app.checkPeerAuthority(conn) {
			return
		}
		switch frame.Type {
		case "control":
			app.peerRegistry().control(app, conn, &frame)
		case "ack":
			app.peerRegistry().ack(app, conn, &frame)
		case "ready":
			app.peerRegistry().ready(app, conn, &frame)
		default:
			return
		}
	}
}

func (app *Server) checkPeerAuthority(conn *syncTopicPeerConn) bool {
	if app.configStore() == nil {
		return false
	}
	cfg, err := app.loadSyncConfig()
	if err != nil {
		return false
	}
	if cfg.SyncCoordinator != "" || !peerAllowedSecret(cfg, conn.peerID, conn.secret) {
		app.peerRegistry().revoke(app, conn.peerID, "revoked")
		return false
	}
	return true
}

func (c *syncTopicPeerConn) heartbeat() {
	ticker := time.NewTicker(syncTopicsPeerPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-ticker.C:
			if err := c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(syncTopicsPeerControlTimeout)); err != nil {
				c.close()
				return
			}
			if !c.app.checkPeerAuthority(c) {
				c.close()
				return
			}
		}
	}
}

func peerBindReason(err error) string {
	if errors.Is(err, errSyncTopicPeerConflict) {
		return "conflict"
	}
	if errors.Is(err, errSyncTopicCapacity) {
		return "capacity"
	}
	return "refused"
}

func (r *syncTopicPeerRegistry) hasCapacity(peerID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, exists := r.byPeer[peerID]
	return exists || len(r.byKey) < syncTopicsPeerLimit
}

func (r *syncTopicPeerRegistry) offer(peerID string) (fence, state string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.byPeer[peerID]
	if current == nil {
		return "", "offline"
	}
	return current.fence, current.state
}

func (r *syncTopicPeerRegistry) bind(app *Server, peerID, instance, expected string, conn *syncTopicPeerConn) (*syncTopicCohort, error) {
	r.ops.Lock()
	defer r.ops.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	current := r.byPeer[peerID]
	if current != nil && current.instance == instance {
		if current.conn != nil && current.conn.secret != conn.secret {
			app.syncMu.Lock()
			app.syncTopics.retirePeerLocked(current.key)
			app.syncMu.Unlock()
			current.retired = true
			current.ready = false
		}
		if current.conn != nil && current.conn != conn {
			current.conn.close()
		}
		current.conn = conn
		current.secret = conn.secret
		current.stream = randomPeerToken()
		if !current.terminal {
			current.state = "online"
		}
		current.ready = false
		app.syncMu.Lock()
		app.syncTopics.markRemoteReadyLocked(current.key, false)
		app.syncMu.Unlock()
		return current, nil
	}
	if current != nil {
		if current.state == "online" && current.conn != nil {
			return nil, errSyncTopicPeerConflict
		}
		if expected != current.fence {
			return nil, errSyncTopicPeerConflict
		}
		app.syncMu.Lock()
		app.syncTopics.retirePeerLocked(current.key)
		app.syncMu.Unlock()
		if current.conn != nil {
			current.conn.close()
		}
		current.state = "offline"
		current.conn = nil
		current.ready = false
	} else if expected != "" {
		return nil, errSyncTopicPeerConflict
	}
	if current == nil && len(r.byKey) >= syncTopicsPeerLimit {
		return nil, errSyncTopicCapacity
	}
	cohort := &syncTopicCohort{
		key: peerID, peerID: peerID, instance: instance, fence: randomPeerToken(),
		stream: randomPeerToken(), secret: conn.secret, state: "online", conn: conn,
	}
	if current != nil {
		cohort.retired = current.retired
	}
	r.byKey[peerID] = cohort
	r.byPeer[peerID] = cohort
	return cohort, nil
}

func (r *syncTopicPeerRegistry) closeConn(app *Server, conn *syncTopicPeerConn) {
	r.ops.Lock()
	defer r.ops.Unlock()
	cohort := conn.cohort
	if cohort == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if cohort.conn != conn {
		return
	}
	cohort.conn = nil
	cohort.ready = false
	if !cohort.terminal {
		cohort.state = "offline"
	}
	app.syncMu.Lock()
	app.syncTopics.markRemoteReadyLocked(cohort.key, false)
	app.syncMu.Unlock()
}

func (r *syncTopicPeerRegistry) revoke(app *Server, peerID, reason string) {
	r.ops.Lock()
	defer r.ops.Unlock()
	r.mu.Lock()
	cohort := r.byPeer[peerID]
	r.mu.Unlock()
	if cohort == nil {
		return
	}
	app.syncMu.Lock()
	app.syncTopics.retirePeerLocked(cohort.key)
	app.syncMu.Unlock()
	r.mu.Lock()
	cohort.retired = true
	cohort.ready = false
	cohort.state = "offline"
	conn := cohort.conn
	cohort.conn = nil
	r.mu.Unlock()
	if conn != nil {
		conn.close()
	}
}

func (r *syncTopicPeerRegistry) ensure(conn *syncTopicPeerConn, frame *syncTopicPeerFrame, requireStream bool) (*syncTopicCohort, bool) {
	if err := validatePeerIdentity(frame.Epoch, frame.Fence, frame.Stream, requireStream); err != nil {
		return nil, false
	}
	r.mu.Lock()
	cohort := conn.cohort
	if cohort == nil || cohort.conn != conn {
		r.mu.Unlock()
		return nil, false
	}
	fence, stream := cohort.fence, cohort.stream
	r.mu.Unlock()
	conn.app.syncMu.RLock()
	epoch := conn.app.syncTopics.epoch
	conn.app.syncMu.RUnlock()
	if frame.Epoch != epoch || frame.Fence != fence || (requireStream && frame.Stream != stream) {
		return nil, false
	}
	return cohort, true
}

func (r *syncTopicPeerRegistry) sweep(app *Server) {
	cfg, err := app.loadSyncConfig()
	if err != nil {
		return
	}
	r.mu.Lock()
	peers := make([]string, 0, len(r.byPeer))
	for peer := range r.byPeer {
		peers = append(peers, peer)
	}
	r.mu.Unlock()
	for _, peer := range peers {
		r.mu.Lock()
		cohort := r.byPeer[peer]
		secret := ""
		if cohort != nil {
			secret = cohort.secret
		}
		r.mu.Unlock()
		if cohort != nil && !peerAllowedSecret(cfg, peer, secret) {
			r.revoke(app, peer, "revoked")
		}
	}
}

func (r *syncTopicPeerRegistry) sweepLoop(app *Server) {
	ticker := time.NewTicker(syncTopicsPeerPingInterval)
	defer ticker.Stop()
	for range ticker.C {
		if app.shuttingDown.Load() {
			return
		}
		r.sweep(app)
	}
}

func (r *syncTopicPeerRegistry) control(app *Server, conn *syncTopicPeerConn, frame *syncTopicPeerFrame) {
	r.ops.Lock()
	defer r.ops.Unlock()
	cohort, ok := r.ensure(conn, frame, true)
	if !ok {
		return
	}
	seq, ok := parsePeerCounter(frame.Control, false)
	if !ok || !validPeerControl(frame) {
		_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: "refused", Reason: "invalid"})
		return
	}
	r.mu.Lock()
	if cohort.retired && frame.Action == "register" {
		r.mu.Unlock()
		_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: "refused", Reason: "retired"})
		return
	}
	if cohort.terminal && frame.Action != "retire_cohort" {
		r.mu.Unlock()
		_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: "refused", Reason: "terminal"})
		return
	}
	if seq <= cohort.lastControl {
		if seq == cohort.lastControl && peerControlFingerprint(frame) == cohort.lastFingerprint {
			result, reason := cohort.lastResult, cohort.lastReason
			r.mu.Unlock()
			_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: result, Reason: reason})
			return
		}
		r.mu.Unlock()
		_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: "refused", Reason: "stale"})
		return
	}
	terminalReservation := frame.Action == "retire_cohort" && seq == math.MaxUint64
	if !terminalReservation && (seq != cohort.lastControl+1 || cohort.lastControl == math.MaxUint64) {
		r.mu.Unlock()
		_ = conn.write(syncTopicPeerFrame{Type: "result", Epoch: frame.Epoch, Fence: frame.Fence, Stream: frame.Stream, Control: frame.Control, Result: "refused", Reason: "stale"})
		return
	}
	r.mu.Unlock()

	result, reason := "ok", ""
	switch frame.Action {
	case "register":
		wire := *frame.Owner
		owner := syncTopicOwnerFromWire(cohort.key, wire)
		owner.remote = true
		owner.peerID = cohort.key
		owner.remoteSend = func(b *syncTopicBatch) error {
			return app.sendCohortBatch(cohort, &wire, b)
		}
		app.syncMu.Lock()
		err := app.syncTopics.subscribeRemoteLocked(owner, frame.Topic)
		app.syncMu.Unlock()
		if err != nil {
			result, reason = "refused", peerRefusalReason(err)
		}
	case "retire_owner":
		app.syncMu.Lock()
		app.syncTopics.retireOwnerLocked(syncTopicOwnerFromWire(cohort.key, *frame.Owner))
		app.syncMu.Unlock()
	case "retire_cohort":
		if seq != math.MaxUint64 {
			result, reason = "refused", "invalid"
			break
		}
		app.syncMu.Lock()
		app.syncTopics.retirePeerLocked(cohort.key)
		app.syncMu.Unlock()
		r.mu.Lock()
		cohort.terminal = true
		cohort.state = "terminal"
		cohort.ready = false
		r.mu.Unlock()
	}
	r.mu.Lock()
	cohort.lastControl = seq
	cohort.lastFingerprint = peerControlFingerprint(frame)
	cohort.lastResult = result
	cohort.lastReason = reason
	stream := cohort.stream
	fence := cohort.fence
	r.mu.Unlock()
	_ = conn.write(syncTopicPeerFrame{
		Type: "result", Epoch: frame.Epoch, Fence: fence, Stream: stream,
		Control: frame.Control, Result: result, Reason: reason,
	})
	if result == "ok" {
		app.pumpSyncTopics(time.Now())
	}
}

func (r *syncTopicPeerRegistry) ack(app *Server, conn *syncTopicPeerConn, frame *syncTopicPeerFrame) {
	r.ops.Lock()
	defer r.ops.Unlock()
	cohort, ok := r.ensure(conn, frame, true)
	if !ok || frame.Owner == nil || !validPeerOwner(frame.Owner) || !validPeerID(frame.BatchID) {
		return
	}
	seq, ok := parsePeerCounter(frame.Seq, false)
	if !ok {
		return
	}
	app.syncMu.Lock()
	ok = app.syncTopics.acknowledgeLocked(syncTopicOwnerFromWire(cohort.key, *frame.Owner), frame.Epoch, seq, frame.BatchID)
	app.syncMu.Unlock()
	if ok {
		app.pumpSyncTopics(time.Now())
	}
}

func (r *syncTopicPeerRegistry) ready(app *Server, conn *syncTopicPeerConn, frame *syncTopicPeerFrame) {
	r.ops.Lock()
	defer r.ops.Unlock()
	cohort, ok := r.ensure(conn, frame, true)
	if !ok {
		return
	}
	last, ok := parsePeerCounter(frame.Last, true)
	if !ok {
		return
	}
	r.mu.Lock()
	if cohort.terminal || last != cohort.lastControl {
		r.mu.Unlock()
		return
	}
	// Enqueue the barrier while delivery still sees this cohort as unready.
	// The single writer preserves this order even if a timer pumps at once.
	if err := conn.write(syncTopicPeerFrame{
		Type: "ready_ack", Epoch: frame.Epoch, Fence: cohort.fence, Stream: cohort.stream, Last: frame.Last,
	}); err != nil {
		r.mu.Unlock()
		return
	}
	cohort.ready = true
	cohort.state = "online"
	cohort.retired = false
	r.mu.Unlock()
	app.syncMu.Lock()
	app.syncTopics.markRemoteReadyLocked(cohort.key, true)
	app.syncMu.Unlock()
	app.pumpSyncTopics(time.Now())
}

func (app *Server) sendCohortBatch(expected *syncTopicCohort, wire *syncTopicWireOwn, batch *syncTopicBatch) error {
	if app.configStore() != nil {
		if _, err := app.loadSyncConfig(); err != nil {
			return errSyncTopicPeerNotReady
		}
	}
	app.peerRegistry().mu.Lock()
	cohort := app.peerRegistry().byKey[expected.key]
	if cohort != expected || !cohort.ready || cohort.conn == nil {
		app.peerRegistry().mu.Unlock()
		return errSyncTopicPeerNotReady
	}
	conn := cohort.conn
	fence, stream := cohort.fence, cohort.stream
	app.peerRegistry().mu.Unlock()
	return conn.write(syncTopicPeerFrame{
		Type: "batch", Version: syncTopicsPeerVersion, Epoch: app.syncTopics.epoch,
		Fence: fence, Stream: stream, Owner: wire, Topic: batch.topic,
		BatchID: batch.id, Seq: canonicalCounter(batch.seq),
		Value: base64.StdEncoding.EncodeToString(batch.text),
	})
}

func syncTopicOwnerFromWire(key string, wire syncTopicWireOwn) syncTopicOwner {
	return syncTopicOwner{
		paneID: "remote:" + key + ":" + wire.Pane, processID: wire.Process,
		generation: wire.Generation, runtimeID: wire.RuntimeID, sessionID: wire.SessionID,
	}
}

func peerAllowedSecret(cfg config.Config, peer, secret string) bool {
	expected, ok := cfg.SyncTopicsAllowedPeers[peer]
	return ok && validPeerSecret(secret) && peerSecretEqual(expected, secret)
}

func peerSecretEqual(expected, got string) bool {
	if !validPeerSecret(expected) || len(expected) != len(got) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

func validPeerSecret(secret string) bool {
	if len(secret) != 64 || strings.ToLower(secret) != secret {
		return false
	}
	raw, err := hex.DecodeString(secret)
	return err == nil && len(raw) == 32
}

// handleSyncTopicsStatus is a read-only local diagnostic. It exposes no
// secret and no owner identity.
func (app *Server) handleSyncTopicsStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	app.syncMu.Lock()
	owners, subs, batches := app.syncTopics.statsLocked()
	app.syncMu.Unlock()
	connected := false
	epoch := app.syncTopics.epoch
	registry := app.peerRegistry()
	registry.mu.Lock()
	for _, cohort := range registry.byPeer {
		if cohort.conn != nil {
			connected = true
			break
		}
	}
	registry.mu.Unlock()
	if app.syncTopicPeer != nil {
		app.syncTopicPeer.mu.Lock()
		connected = connected || app.syncTopicPeer.ready
		if app.syncTopicPeer.epoch != "" {
			epoch = app.syncTopicPeer.epoch
		}
		app.syncTopicPeer.mu.Unlock()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"epoch": epoch, "peer_connected": connected,
		"owners": owners, "subscriptions": subs, "batches": batches,
	})
}

func (app *Server) startSyncTopicsPeer() {
	if app.configStore() == nil {
		return
	}
	cfg, err := app.loadSyncConfig()
	if err != nil || cfg.SyncCoordinator == "" || cfg.SyncTopicsPeerID == "" || cfg.SyncTopicsPeerSecret == "" ||
		app.syncCoordinatorIsSelf(cfg.SyncCoordinator) {
		return
	}
	base, err := url.Parse(cfg.SyncCoordinator)
	if err != nil || base.Host == "" || base.User != nil {
		return
	}
	base.Path = syncTopicsPeerPath
	base.RawQuery = ""
	base.Fragment = ""
	switch base.Scheme {
	case "http":
		base.Scheme = "ws"
	case "https":
		base.Scheme = "wss"
	default:
		return
	}
	client := newSyncTopicPeerClient(app, *base, cfg.SyncCoordinator, cfg.SyncTopicsPeerID, cfg.SyncTopicsPeerSecret)
	app.syncTopicPeer = client
	go client.run()
}
