package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/pibridge"
)

func TestSyncTopicPeerAuthIsExactAndFailsClosed(t *testing.T) {
	withTempConfig(t)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = strings.Repeat("a", 64)
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": strings.Repeat("a", 64), "f2": strings.Repeat("b", 64)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	cfg, err := testStore.LoadWithError()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		peer   string
		secret string
		ok     bool
	}{
		{"f1", strings.Repeat("a", 64), true},
		{"f2", strings.Repeat("b", 64), true},
		{"f3", strings.Repeat("a", 64), false},
		{"f1", strings.Repeat("b", 64), false},
		{"f1", strings.ToUpper(strings.Repeat("a", 64)), false},
		{"f1", "", false},
	} {
		if got := peerAllowedSecret(cfg, tc.peer, tc.secret); got != tc.ok {
			t.Errorf("peer %q secret %q = %v, want %v", tc.peer, tc.secret, got, tc.ok)
		}
	}
	if validPeerSecret(strings.Repeat("g", 64)) {
		t.Fatal("non-hex secret accepted")
	}
}

func TestSyncTopicPeerRejectsUnauthorizedUpgradeBeforeWebSocket(t *testing.T) {
	withTempConfig(t)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = strings.Repeat("a", 64)
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": strings.Repeat("a", 64)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, headers := range []map[string]string{
		{},
		{syncTopicsPeerHeader: "f1"},
		{syncTopicsPeerHeader: "f1", syncTopicsSecretHeader: strings.Repeat("b", 64)},
		{syncTopicsPeerHeader: "other", syncTopicsSecretHeader: strings.Repeat("a", 64)},
	} {
		req := httptest.NewRequest(http.MethodGet, syncTopicsPeerPath, nil)
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		rec := httptest.NewRecorder()
		testServer.handleSyncTopicPeer(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("headers %v status = %d, want 401", headers, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, syncTopicsPeerPath, nil)
	req.Header.Add(syncTopicsPeerHeader, "f1")
	req.Header.Add(syncTopicsPeerHeader, "f1")
	req.Header.Set(syncTopicsSecretHeader, strings.Repeat("a", 64))
	rec := httptest.NewRecorder()
	testServer.handleSyncTopicPeer(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("duplicate peer header status = %d, want 401", rec.Code)
	}
}

func TestSyncTopicRemoteFanoutAcksOnlyMatchingHead(t *testing.T) {
	now := time.Unix(600, 0)
	e := newSyncTopicEngine("epoch-c")
	wire := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	owner := syncTopicOwnerFromWire("f1/instance", wire)
	owner.remote, owner.peerID = true, "f1/instance"
	var sent []string
	owner.remoteSend = func(b *syncTopicBatch) error {
		sent = append(sent, b.id)
		return nil
	}
	if err := e.subscribeRemoteLocked(owner, "topic"); err != nil {
		t.Fatal(err)
	}
	e.markRemoteReadyLocked("f1/instance", true)
	if _, err := e.admitPostLocked("topic", "value", now); err != nil {
		t.Fatal(err)
	}
	deliveries := e.pumpLocked(now.Add(5 * time.Second))
	if len(deliveries) != 1 || !deliveries[0].owner.remote {
		t.Fatalf("deliveries = %+v", deliveries)
	}
	e.markSentLocked(deliveries[0].owner, deliveries[0].batch.id, now)
	if err := deliveries[0].owner.remoteSend(deliveries[0].batch); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 {
		t.Fatalf("remote sends = %d", len(sent))
	}
	if e.acknowledgeLocked(owner, "wrong", deliveries[0].batch.seq, deliveries[0].batch.id) {
		t.Fatal("wrong epoch acknowledged remote head")
	}
	if !e.acknowledgeLocked(owner, "epoch-c", deliveries[0].batch.seq, deliveries[0].batch.id) {
		t.Fatal("matching remote ACK did not release")
	}
	if e.totalBatches != 0 {
		t.Fatalf("batches after ACK = %d", e.totalBatches)
	}
	e.retirePeerLocked("f1/instance")
	if e.totalSubs != 0 {
		t.Fatalf("remote retirement left subscriptions: %d", e.totalSubs)
	}
}

func TestSyncForwardFailureDoesNotMutateFollowerBoard(t *testing.T) {
	withTempConfig(t)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator = "http://127.0.0.1:1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	testServer.syncMu.Lock()
	testServer.syncStore = make(map[string]*SyncMessage)
	testServer.syncMu.Unlock()
	req := httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"k","value":"v"}`))
	rec := httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"k","value":"v"}`))
	req.Header.Set("X-Phi-Sync-Forwarded", "1")
	rec = httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("chained status = %d, want 503", rec.Code)
	}
	testServer.syncMu.Lock()
	defer testServer.syncMu.Unlock()
	if len(testServer.syncStore) != 0 {
		t.Fatalf("failed forward mutated local board: %+v", testServer.syncStore)
	}
}

func TestSyncForwardInvalidConfigDoesNotFallBack(t *testing.T) {
	path := withTempConfig(t)
	if err := os.WriteFile(path, []byte("sync_coordinator = \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	testServer.syncMu.Lock()
	testServer.syncStore = make(map[string]*SyncMessage)
	testServer.syncMu.Unlock()
	req := httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(`{"key":"k","value":"v"}`))
	rec := httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("invalid config fell back to local mutation")
	}
	testServer.syncMu.Lock()
	defer testServer.syncMu.Unlock()
	if len(testServer.syncStore) != 0 {
		t.Fatalf("invalid config mutated local board: %+v", testServer.syncStore)
	}
}

func TestSyncTopicPeerSecretsStayOutOfBrowserPayloads(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	peer := "peer-private-1"
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = peer
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{peer: secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	configBody := configResponseBody(t)
	exportResponse := httptest.NewRecorder()
	testServer.handleConfigExport(exportResponse, httptest.NewRequest(http.MethodGet, "/api/config/export", nil))
	var exported struct {
		Config string `json:"config"`
	}
	if err := json.Unmarshal(exportResponse.Body.Bytes(), &exported); err != nil {
		t.Fatal(err)
	}
	exportBody, err := DecodeConfigData(exported.Config, "PHICONFIG")
	if err != nil {
		t.Fatal(err)
	}
	statusResponse := httptest.NewRecorder()
	testServer.handleSyncTopicsStatus(statusResponse, httptest.NewRequest(http.MethodGet, "/api/sync/topics/status", nil))
	for name, body := range map[string][]byte{
		"config": []byte(configBody), "export": exportBody, "status": statusResponse.Body.Bytes(),
	} {
		for _, secretPart := range []string{secret, peer, "sync_topics"} {
			if bytes.Contains(body, []byte(secretPart)) {
				t.Errorf("%s payload exposed %q: %s", name, secretPart, body)
			}
		}
	}
}

func TestSyncForwardRefusesOversizedPostBeforeUpstream(t *testing.T) {
	withTempConfig(t)
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator = upstream.URL
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	body := `{"key":"k","value":"` + strings.Repeat("x", maxSyncTopicPostBytes) + `"}`
	rec := httptest.NewRecorder()
	testServer.handleSyncMessages(rec, httptest.NewRequest(http.MethodPost, "/api/sync/messages", strings.NewReader(body)))
	if rec.Code != http.StatusRequestEntityTooLarge ||
		rec.Body.String() != `{"syncboard_admission":"refused","reason":"too-large"}` {
		t.Fatalf("oversized forward refusal = %d %q", rec.Code, rec.Body.String())
	}
	if hits.Load() != 0 {
		t.Fatal("oversized request reached the coordinator")
	}
}

func TestSyncForwardBlockedWriterHitsInjectedDeadline(t *testing.T) {
	withTempConfig(t)
	chunk := bytes.Repeat([]byte("x"), 64<<10)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		for i := 0; i < 2048; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator = upstream.URL
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	previous := syncForwardWriteTimeout
	syncForwardWriteTimeout = 50 * time.Millisecond
	defer func() { syncForwardWriteTimeout = previous }()
	handlerReturned := make(chan struct{})
	follower := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		testServer.handleSyncMessages(w, r)
		close(handlerReturned)
	}))
	defer follower.Close()
	resp, err := http.Get(follower.URL + "/api/sync/messages")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// The test client never reads the body. A blocked downstream writer must
	// end the relay at its injected deadline rather than holding it forever.
	select {
	case <-handlerReturned:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked downstream writer held the relay past its deadline")
	}
}

func TestSyncCoordinatorSelfAliasIsRejected(t *testing.T) {
	app := &Server{port: 7070}
	for _, raw := range []string{
		"http://127.0.0.1:7070",
		"http://localhost:7070",
		"http://[::1]:7070",
	} {
		if !app.syncCoordinatorIsSelf(raw) {
			t.Errorf("self alias %q was not detected", raw)
		}
	}
	for _, raw := range []string{
		"http://127.0.0.1:7071",
		"https://example.test:7070",
		"http://127.0.0.1:7070/prefix",
		"http://127.0.0.1:7070?x=1",
	} {
		if app.syncCoordinatorIsSelf(raw) {
			t.Errorf("non-self %q was rejected", raw)
		}
	}
}

func TestSyncTopicPeerRegistryRefusesSecondOnlineInstanceAndRetainsRetirement(t *testing.T) {
	app := &Server{
		syncTopics:     newSyncTopicEngine("epoch-c"),
		syncTopicPeers: newSyncTopicPeerRegistry(),
	}
	conn := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	cohort, err := app.peerRegistry().bind(app, "f1", "instance-1", "", conn)
	if err != nil {
		t.Fatal(err)
	}
	conn.cohort = cohort
	cohort.conn = conn
	if cohort.fence == "" || cohort.stream == "" {
		t.Fatal("cohort has no fence or stream")
	}
	other := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	if _, err := app.peerRegistry().bind(app, "f1", "instance-2", cohort.fence, other); !errors.Is(err, errSyncTopicPeerConflict) {
		t.Fatalf("second online instance err = %v, want conflict", err)
	}
	oldStream := cohort.stream
	reconnect := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	same, err := app.peerRegistry().bind(app, "f1", "instance-1", cohort.fence, reconnect)
	if err != nil {
		t.Fatal(err)
	}
	if same.fence != cohort.fence || same.stream == oldStream {
		t.Fatalf("same-instance rebind = %+v, want retained fence and new stream", same)
	}
	reconnect.cohort = same
	app.peerRegistry().closeConn(app, conn) // stale close must not clear the new stream
	if same.conn != reconnect || same.state != "online" {
		t.Fatalf("stale close changed cohort: %+v", same)
	}
	app.peerRegistry().revoke(app, "f1", "revoked")
	if !same.retired || same.ready {
		t.Fatalf("revoked cohort = %+v", same)
	}
	after := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	recovered, err := app.peerRegistry().bind(app, "f1", "instance-1", same.fence, after)
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.retired {
		t.Fatal("bindings_retired was not retained for the fenced cohort")
	}
}

func TestSyncTopicRemoteDeliveryWaitsForReady(t *testing.T) {
	now := time.Unix(700, 0)
	e := newSyncTopicEngine("epoch-c")
	wire := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	owner := syncTopicOwnerFromWire("f1/instance", wire)
	owner.remote, owner.peerID = true, "f1/instance"
	owner.remoteSend = func(*syncTopicBatch) error { return nil }
	if err := e.subscribeRemoteLocked(owner, "topic"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.admitPostLocked("topic", "value", now); err != nil {
		t.Fatal(err)
	}
	if got := e.pumpLocked(now.Add(6 * time.Second)); len(got) != 0 {
		t.Fatalf("delivery before ready = %+v", got)
	}
	e.markRemoteReadyLocked("f1/instance", true)
	got := e.pumpLocked(now.Add(6 * time.Second))
	if len(got) != 1 {
		t.Fatalf("delivery after ready = %+v", got)
	}
	e.markSentLocked(got[0].owner, got[0].batch.id, now.Add(6*time.Second))
	if again := e.pumpLocked(now.Add(6*time.Second + 499*time.Millisecond)); len(again) != 0 {
		t.Fatalf("remote head retried before 500ms: %+v", again)
	}
	if retry := e.pumpLocked(now.Add(6*time.Second + 500*time.Millisecond)); len(retry) != 1 {
		t.Fatalf("remote head was not retried: %+v", retry)
	}
}

func TestSyncTopicPeerHandshakeReadyAndBatchAck(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(testServer.handleSyncTopicPeer))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath
	header := http.Header{}
	header.Set(syncTopicsPeerHeader, "f1")
	header.Set(syncTopicsSecretHeader, secret)
	ws, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		status := 0
		body := ""
		if resp != nil {
			status = resp.StatusCode
			data, _ := io.ReadAll(resp.Body)
			body = string(data)
		}
		t.Fatalf("dial: %v status=%d body=%q", err, status, body)
	}
	defer ws.Close()
	var offer syncTopicPeerFrame
	if err := ws.ReadJSON(&offer); err != nil || offer.Type != "offer" || offer.Epoch != testServer.syncTopics.epoch {
		t.Fatalf("offer = %+v err=%v", offer, err)
	}
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch,
		Instance: "instance-1", Prior: offer.Fence,
	}); err != nil {
		t.Fatal(err)
	}
	var bound syncTopicPeerFrame
	if err := ws.ReadJSON(&bound); err != nil || bound.Type != "bound" || bound.State != "online" {
		t.Fatalf("bound = %+v err=%v", bound, err)
	}
	owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "control", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream,
		Control: "1", Action: "register", Owner: &owner, Topic: "alerts",
	}); err != nil {
		t.Fatal(err)
	}
	var result syncTopicPeerFrame
	if err := ws.ReadJSON(&result); err != nil || result.Type != "result" || result.Result != "ok" {
		t.Fatalf("register result = %+v err=%v", result, err)
	}
	// An exact semantic retry returns the retained result and does not
	// create a second subscription.
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "control", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream,
		Control: "1", Action: "register", Owner: &owner, Topic: "alerts",
	}); err != nil {
		t.Fatal(err)
	}
	if err := ws.ReadJSON(&result); err != nil || result.Type != "result" || result.Result != "ok" {
		t.Fatalf("duplicate register result = %+v err=%v", result, err)
	}
	testServer.syncMu.RLock()
	subs := testServer.syncTopics.totalSubs
	testServer.syncMu.RUnlock()
	if subs != 1 {
		t.Fatalf("duplicate register subscriptions = %d, want 1", subs)
	}
	now := time.Now()
	testServer.syncMu.Lock()
	if _, err := testServer.syncTopics.admitPostLocked("alerts", "value", now); err != nil {
		testServer.syncMu.Unlock()
		t.Fatal(err)
	}
	testServer.syncMu.Unlock()
	_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "ready", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream, Last: "1",
	}); err != nil {
		t.Fatal(err)
	}
	var readyAck syncTopicPeerFrame
	if err := ws.ReadJSON(&readyAck); err != nil || readyAck.Type != "ready_ack" {
		t.Fatalf("ready_ack = %+v err=%v", readyAck, err)
	}
	testServer.syncMu.Lock()
	deliveries := testServer.syncTopics.pumpLocked(now.Add(6 * time.Second))
	for _, d := range deliveries {
		testServer.syncTopics.markSentLocked(d.owner, d.batch.id, now.Add(6*time.Second))
	}
	testServer.syncMu.Unlock()
	for _, d := range deliveries {
		if err := d.owner.remoteSend(d.batch); err != nil {
			t.Fatal(err)
		}
	}
	var batch syncTopicPeerFrame
	if err := ws.ReadJSON(&batch); err != nil || batch.Type != "batch" || batch.BatchID == "" || batch.Value == "" {
		t.Fatalf("batch = %+v err=%v", batch, err)
	}
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "ack", Epoch: batch.Epoch, Fence: batch.Fence, Stream: batch.Stream,
		Owner: batch.Owner, BatchID: batch.BatchID, Seq: batch.Seq,
	}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		testServer.syncMu.RLock()
		total := testServer.syncTopics.totalBatches
		testServer.syncMu.RUnlock()
		if total == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	testServer.syncMu.RLock()
	released := testServer.syncTopics.totalBatches == 0
	testServer.syncMu.RUnlock()
	if !released {
		t.Fatal("matching ACK did not release the batch")
	}
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "control", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream,
		Control: "2", Action: "retire_owner", Owner: &owner,
	}); err != nil {
		t.Fatal(err)
	}
	if err := ws.ReadJSON(&result); err != nil || result.Type != "result" || result.Result != "ok" {
		t.Fatalf("retire_owner result = %+v err=%v", result, err)
	}
	testServer.syncMu.RLock()
	subs = testServer.syncTopics.totalSubs
	testServer.syncMu.RUnlock()
	if subs != 0 {
		t.Fatalf("retire_owner left %d subscriptions", subs)
	}
}

func TestSyncTopicPeerTerminalReservationIsBoundedAndFinal(t *testing.T) {
	app := &Server{
		syncTopics:     newSyncTopicEngine("epoch-c"),
		syncTopicPeers: newSyncTopicPeerRegistry(),
	}
	conn := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	cohort, err := app.peerRegistry().bind(app, "f1", "instance-1", "", conn)
	if err != nil {
		t.Fatal(err)
	}
	conn.cohort = cohort
	cohort.conn = conn
	cohort.terminal = true
	app.peerRegistry().control(app, conn, &syncTopicPeerFrame{
		Type: "control", Epoch: app.syncTopics.epoch, Fence: cohort.fence, Stream: cohort.stream,
		Control: canonicalCounter(math.MaxUint64), Action: "retire_cohort",
	})
	if !cohort.terminal || cohort.lastControl != math.MaxUint64 || cohort.lastResult != "ok" {
		t.Fatalf("terminal control = %+v", cohort)
	}
	app.peerRegistry().control(app, conn, &syncTopicPeerFrame{
		Type: "control", Epoch: app.syncTopics.epoch, Fence: cohort.fence, Stream: cohort.stream,
		Control: canonicalCounter(math.MaxUint64), Action: "retire_cohort",
	})
	if cohort.lastResult != "ok" {
		t.Fatalf("terminal reservation repeat = %+v", cohort)
	}
}

func TestSyncTopicPeerSweepRetiresLiveAuthorityLoss(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	app := testServer
	conn := &syncTopicPeerConn{app: app, peerID: "f1", secret: secret}
	cohort, err := app.peerRegistry().bind(app, "f1", "instance-1", "", conn)
	if err != nil {
		t.Fatal(err)
	}
	conn.cohort = cohort
	cohort.conn = conn
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsAllowedPeers = map[string]string{}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	app.peerRegistry().sweep(app)
	if !cohort.retired || cohort.conn != nil {
		t.Fatalf("authority loss did not retire cohort: %+v", cohort)
	}
}

func TestSyncTopicPartitionRetainsHeadUntilReadyAndRejectsStaleAck(t *testing.T) {
	now := time.Unix(800, 0)
	e := newSyncTopicEngine("epoch-c")
	wire := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	owner := syncTopicOwnerFromWire("f1/instance", wire)
	owner.remote, owner.peerID = true, "f1/instance"
	owner.remoteSend = func(*syncTopicBatch) error { return nil }
	if err := e.subscribeRemoteLocked(owner, "topic"); err != nil {
		t.Fatal(err)
	}
	e.markRemoteReadyLocked("f1/instance", true)
	if _, err := e.admitPostLocked("topic", "value", now); err != nil {
		t.Fatal(err)
	}
	first := e.pumpLocked(now.Add(6 * time.Second))
	if len(first) != 1 {
		t.Fatalf("first delivery = %+v", first)
	}
	e.markSentLocked(first[0].owner, first[0].batch.id, now.Add(6*time.Second))
	e.markRemoteReadyLocked("f1/instance", false)
	if lost := e.pumpLocked(now.Add(7 * time.Second)); len(lost) != 0 {
		t.Fatalf("partition delivered more work: %+v", lost)
	}
	e.markRemoteReadyLocked("f1/instance", true)
	retained := e.pumpLocked(now.Add(7 * time.Second))
	if len(retained) != 1 || retained[0].batch.id != first[0].batch.id {
		t.Fatalf("reconnect did not retain head: %+v", retained)
	}
	if e.acknowledgeLocked(owner, "other-epoch", retained[0].batch.seq, retained[0].batch.id) {
		t.Fatal("stale epoch ACK released the head")
	}
	if e.acknowledgeLocked(owner, "epoch-c", retained[0].batch.seq+1, retained[0].batch.id) {
		t.Fatal("stale sequence ACK released the head")
	}
	if !e.acknowledgeLocked(owner, "epoch-c", retained[0].batch.seq, retained[0].batch.id) {
		t.Fatal("matching ACK did not release the head")
	}
}

func TestSyncTopicPeerFrameBoundsRejectOversize(t *testing.T) {
	if err := validatePeerFrameSize([]byte(`{"type":"ping"}`)); err != nil {
		t.Fatal(err)
	}
	big := make([]byte, syncTopicsPeerMaxFrame+1)
	for i := range big {
		big[i] = 'x'
	}
	if err := validatePeerFrameSize(big); err == nil {
		t.Fatal("oversized frame accepted")
	}
	if err := validatePeerFrameSize([]byte(`{"type":`)); err == nil {
		t.Fatal("truncated frame accepted")
	}
}

func TestSyncForwardStreamsLargeReadAndRejectsRedirectAndOversize(t *testing.T) {
	withTempConfig(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/sync/messages":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("["))
			_, _ = w.Write(bytes.Repeat([]byte(" "), 300*1024))
			_, _ = w.Write([]byte("]"))
		case "/api/sync/messages/redirect":
			http.Redirect(w, r, "/api/sync/messages", http.StatusFound)
		case "/api/sync/messages/large":
			_, _ = w.Write(bytes.Repeat([]byte("x"), pibridge.MaxSyncboardResponseBytes+1))
		default:
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncCoordinator = fake.URL
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/sync/messages", nil)
	rec := httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code != http.StatusOK || rec.Body.Len() < 300*1024 {
		t.Fatalf("large read status=%d bytes=%d", rec.Code, rec.Body.Len())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages/redirect", strings.NewReader(`{"value":"v"}`))
	rec = httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("redirect status = %d, want 502", rec.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/api/sync/messages/large", strings.NewReader(`{"value":"v"}`))
	rec = httptest.NewRecorder()
	testServer.handleSyncMessages(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("oversized mutation status = %d, want 502", rec.Code)
	}
}

func TestSyncTopicOneOwnerRetirementCancelsEveryTopicAndBatch(t *testing.T) {
	now := time.Unix(900, 0)
	e := newSyncTopicEngine("epoch-c")
	wire := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	owner := syncTopicOwnerFromWire("f1", wire)
	owner.remote, owner.peerID = true, "f1"
	owner.remoteSend = func(*syncTopicBatch) error { return nil }
	for _, topic := range []string{"one", "two"} {
		if err := e.subscribeRemoteLocked(owner, topic); err != nil {
			t.Fatal(err)
		}
		if _, err := e.admitPostLocked(topic, topic, now); err != nil {
			t.Fatal(err)
		}
	}
	if e.totalSubs != 2 || e.totalBatches != 2 {
		t.Fatalf("before retirement subs=%d batches=%d", e.totalSubs, e.totalBatches)
	}
	e.retireOwnerLocked(owner)
	if e.totalSubs != 0 || e.totalBatches != 0 || len(e.byTopic) != 0 {
		t.Fatalf("retirement left subs=%d batches=%d topics=%d", e.totalSubs, e.totalBatches, len(e.byTopic))
	}
}

func TestSyncTopicStaleStreamControlCannotMutateReplacement(t *testing.T) {
	app := &Server{syncTopics: newSyncTopicEngine("epoch-c"), syncTopicPeers: newSyncTopicPeerRegistry()}
	oldConn := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	cohort, err := app.peerRegistry().bind(app, "f1", "instance-1", "", oldConn)
	if err != nil {
		t.Fatal(err)
	}
	oldConn.cohort = cohort
	cohort.conn = oldConn
	newConn := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	if _, err := app.peerRegistry().bind(app, "f1", "instance-1", cohort.fence, newConn); err != nil {
		t.Fatal(err)
	}
	newConn.cohort = cohort
	owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1, RuntimeID: "rt", SessionID: "s"}
	app.peerRegistry().control(app, oldConn, &syncTopicPeerFrame{
		Type: "control", Epoch: app.syncTopics.epoch, Fence: cohort.fence, Stream: oldConn.cohort.stream,
		Control: "1", Action: "register", Owner: &owner, Topic: "topic",
	})
	if app.syncTopics.totalSubs != 0 {
		t.Fatalf("stale stream registered %d subscriptions", app.syncTopics.totalSubs)
	}
}

func TestSyncTopicPeerHalfOpenPingExpiresWithoutTopicTraffic(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	oldPing, oldRead := syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout
	syncTopicsPeerPingInterval = 20 * time.Millisecond
	syncTopicsPeerReadTimeout = 100 * time.Millisecond
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		testServer.handleSyncTopicPeer(w, r)
	}))
	defer func() {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		srv.Close()
		syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout = oldPing, oldRead
	}()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath
	header := http.Header{}
	header.Set(syncTopicsPeerHeader, "f1")
	header.Set(syncTopicsSecretHeader, secret)
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.SetPingHandler(func(string) error { return nil })
	var offer syncTopicPeerFrame
	if err := ws.ReadJSON(&offer); err != nil {
		t.Fatal(err)
	}
	if err := ws.WriteJSON(syncTopicPeerFrame{
		Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch,
		Instance: "half-open", Prior: offer.Fence,
	}); err != nil {
		t.Fatal(err)
	}
	var bound syncTopicPeerFrame
	if err := ws.ReadJSON(&bound); err != nil || bound.Type != "bound" {
		t.Fatalf("bound = %+v err=%v", bound, err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			if err := ws.WriteJSON(syncTopicPeerFrame{
				Type: "ready", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream, Last: "0",
			}); err != nil {
				return
			}
		}
	}()
	defer func() { _ = ws.Close(); <-writerDone }()
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				t.Fatal("application traffic without Pong kept the coordinator stream alive")
			}
			return
		}
	}
}

func TestSyncTopicPeerHandshakeCandidateExpiresBeforeBind(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	old := syncTopicsPeerHandshakeTimeout
	syncTopicsPeerHandshakeTimeout = 50 * time.Millisecond
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		testServer.handleSyncTopicPeer(w, r)
	}))
	defer func() {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		srv.Close()
		syncTopicsPeerHandshakeTimeout = old
	}()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath
	header := http.Header{}
	header.Set(syncTopicsPeerHeader, "f1")
	header.Set(syncTopicsSecretHeader, secret)
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	var offer syncTopicPeerFrame
	if err := ws.ReadJSON(&offer); err != nil || offer.Type != "offer" {
		t.Fatalf("offer = %+v err=%v", offer, err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("handshake candidate stayed open past its bind deadline")
	}
	testServer.peerRegistry().mu.Lock()
	cohort := testServer.peerRegistry().byKey["f1"]
	testServer.peerRegistry().mu.Unlock()
	if cohort != nil {
		t.Fatalf("expired candidate allocated a cohort: %+v", cohort)
	}
}

func TestSyncTopicPeerLostBoundRebindsSameInstance(t *testing.T) {
	withTempConfig(t)
	secret := strings.Repeat("a", 64)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerID = "f1"
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(testServer.handleSyncTopicPeer))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath
	dial := func() *websocket.Conn {
		header := http.Header{}
		header.Set(syncTopicsPeerHeader, "f1")
		header.Set(syncTopicsSecretHeader, secret)
		ws, _, err := websocket.DefaultDialer.Dial(wsURL, header)
		if err != nil {
			t.Fatal(err)
		}
		return ws
	}
	first := dial()
	var offer syncTopicPeerFrame
	if err := first.ReadJSON(&offer); err != nil {
		t.Fatal(err)
	}
	if err := first.WriteJSON(syncTopicPeerFrame{
		Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch,
		Instance: "lost-bound", Prior: offer.Fence,
	}); err != nil {
		t.Fatal(err)
	}
	var bound syncTopicPeerFrame
	if err := first.ReadJSON(&bound); err != nil || bound.Type != "bound" {
		t.Fatalf("first bound = %+v err=%v", bound, err)
	}
	first.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		testServer.peerRegistry().mu.Lock()
		cohort := testServer.peerRegistry().byPeer["f1"]
		offline := cohort != nil && cohort.state == "offline"
		testServer.peerRegistry().mu.Unlock()
		if offline {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first stream did not close")
		}
		time.Sleep(10 * time.Millisecond)
	}
	second := dial()
	defer second.Close()
	if err := second.ReadJSON(&offer); err != nil {
		t.Fatal(err)
	}
	if err := second.WriteJSON(syncTopicPeerFrame{
		Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch,
		Instance: "lost-bound", Prior: offer.Fence,
	}); err != nil {
		t.Fatal(err)
	}
	if err := second.ReadJSON(&bound); err != nil || bound.Type != "bound" || bound.Fence != offer.Fence {
		t.Fatalf("same-instance rebind = %+v err=%v", bound, err)
	}
}

func TestSyncTopicStaleReadyCannotClearBindingsRetired(t *testing.T) {
	app := &Server{syncTopics: newSyncTopicEngine("epoch-c"), syncTopicPeers: newSyncTopicPeerRegistry()}
	conn := &syncTopicPeerConn{app: app, peerID: "f1", secret: strings.Repeat("a", 64)}
	cohort, err := app.peerRegistry().bind(app, "f1", "instance-1", "", conn)
	if err != nil {
		t.Fatal(err)
	}
	conn.cohort = cohort
	cohort.conn = conn
	cohort.retired = true
	cohort.lastControl = 2
	if err := app.syncTopics.subscribeRemoteLocked(syncTopicOwner{remote: true, peerID: "f1", paneID: "remote:f1:p", processID: "proc", remoteSend: func(*syncTopicBatch) error { return nil }}, "topic"); err != nil {
		t.Fatal(err)
	}
	app.syncTopics.markRemoteReadyLocked("f1", true)
	frame := syncTopicPeerFrame{Type: "ready", Epoch: app.syncTopics.epoch, Fence: cohort.fence, Stream: cohort.stream, Last: "1"}
	app.peerRegistry().ready(app, conn, &frame)
	if !cohort.retired {
		t.Fatal("stale ready cleared bindings_retired")
	}
	frame.Last = "2"
	app.peerRegistry().ready(app, conn, &frame)
	if !cohort.retired || cohort.ready {
		t.Fatal("failed ready_ack enqueue cleared retirement or enabled delivery")
	}
	conn.writer = pausedSyncTopicWriter()
	app.peerRegistry().ready(app, conn, &frame)
	if cohort.retired || !cohort.ready {
		t.Fatalf("current ready did not clear retirement: %+v", cohort)
	}
}

func TestSyncTopicThirdInstanceLosesStaleTakeoverRace(t *testing.T) {
	app := &Server{syncTopics: newSyncTopicEngine("epoch-c"), syncTopicPeers: newSyncTopicPeerRegistry()}
	secret := strings.Repeat("a", 64)
	firstConn := &syncTopicPeerConn{app: app, peerID: "f1", secret: secret}
	first, err := app.peerRegistry().bind(app, "f1", "instance-a", "", firstConn)
	if err != nil {
		t.Fatal(err)
	}
	firstConn.cohort = first
	first.conn = firstConn
	staleFence := first.fence
	app.peerRegistry().closeConn(app, firstConn)

	secondConn := &syncTopicPeerConn{app: app, peerID: "f1", secret: secret}
	second, err := app.peerRegistry().bind(app, "f1", "instance-b", staleFence, secondConn)
	if err != nil {
		t.Fatalf("permitted takeover: %v", err)
	}
	secondConn.cohort = second
	second.conn = secondConn
	if second.fence == staleFence {
		t.Fatal("takeover retained the old fence")
	}
	thirdConn := &syncTopicPeerConn{app: app, peerID: "f1", secret: secret}
	if _, err := app.peerRegistry().bind(app, "f1", "instance-c", staleFence, thirdConn); !errors.Is(err, errSyncTopicPeerConflict) {
		t.Fatalf("stale third-instance bind err = %v, want conflict", err)
	}
	if second.conn != secondConn || second.instance != "instance-b" {
		t.Fatalf("stale attempt changed the active cohort: %+v", second)
	}
	// A same-instance reconnect still wins with the current fence.
	oldStream := second.stream
	reconnect := &syncTopicPeerConn{app: app, peerID: "f1", secret: secret}
	same, err := app.peerRegistry().bind(app, "f1", "instance-b", second.fence, reconnect)
	if err != nil || same != second || same.stream == oldStream {
		t.Fatalf("same-instance reconnect = %+v, %v", same, err)
	}
}
