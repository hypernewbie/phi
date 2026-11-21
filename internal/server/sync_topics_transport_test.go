package server

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/pibridge"
)

func TestSyncTopicPeerHealthyIdleLinkSurvivesHeartbeats(t *testing.T) {
	for _, scenario := range []string{"ordinary", "retirement-recovery"} {
		t.Run(scenario, func(t *testing.T) {
			withTempConfig(t)
			secret := strings.Repeat("a", 64)
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			oldPing, oldRead := syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout
			syncTopicsPeerPingInterval = 20 * time.Millisecond
			syncTopicsPeerReadTimeout = 150 * time.Millisecond
			defer func() { syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout = oldPing, oldRead }()
			handlerDone := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				testServer.handleSyncTopicPeer(w, r)
			}))
			defer srv.Close()
			target, err := url.Parse("ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath)
			if err != nil {
				t.Fatal(err)
			}
			client := newSyncTopicPeerClient(testServer, *target, srv.URL, "f1", secret)
			if scenario == "retirement-recovery" {
				client.epoch = testServer.syncTopics.epoch
				for _, pane := range []string{"old-a", "old-b"} {
					key := pane + "\x00proc"
					client.dirtyRetire[key] = syncTopicPeerRetire{
						owner: syncTopicWireOwn{Pane: pane, Process: "proc", Generation: 1}, key: key,
					}
				}
			}
			connectDone := make(chan error, 1)
			go func() { connectDone <- client.connect(secret) }()
			defer func() {
				client.mu.Lock()
				ws := client.ws
				client.mu.Unlock()
				if ws != nil {
					_ = ws.Close()
				}
				select {
				case <-connectDone:
				case <-time.After(2 * time.Second):
					t.Error("follower reader did not stop")
				}
				select {
				case <-handlerDone:
				case <-time.After(2 * time.Second):
					t.Error("coordinator reader did not stop")
				}
			}()
			deadline := time.Now().Add(2 * time.Second)
			for {
				client.mu.Lock()
				ready := client.ready
				client.mu.Unlock()
				if ready {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("follower did not become ready")
				}
				time.Sleep(time.Millisecond)
			}
			if scenario == "retirement-recovery" {
				client.mu.Lock()
				drained := client.control == 2 && len(client.dirtyRetire) == 0 && client.pending == nil
				client.mu.Unlock()
				if !drained {
					t.Fatal("ready preceded ordered retirement recovery")
				}
			}
			// Survive several read deadlines with no application traffic, then prove
			// that the original stream still processes a registration end to end.
			time.Sleep(3 * syncTopicsPeerReadTimeout)
			owner := pibridge.SyncboardOwner{PaneID: "pane", ProcessID: "proc", Generation: 1}
			if err := client.Register(owner, "alerts"); err != nil {
				t.Fatalf("healthy idle stream lost registration: %v", err)
			}
		})
	}
}

func TestSyncTopicFollowerRequiresPongDespiteApplicationTraffic(t *testing.T) {
	oldPing, oldRead := syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout
	syncTopicsPeerPingInterval = 20 * time.Millisecond
	syncTopicsPeerReadTimeout = 150 * time.Millisecond
	defer func() { syncTopicsPeerPingInterval, syncTopicsPeerReadTimeout = oldPing, oldRead }()
	handlerDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		ws.SetPingHandler(func(string) error { return nil })
		_ = ws.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := ws.WriteJSON(syncTopicPeerFrame{Type: "offer", Version: syncTopicsPeerVersion, Epoch: "e", State: "offline"}); err != nil {
			return
		}
		var bind syncTopicPeerFrame
		if err := ws.ReadJSON(&bind); err != nil {
			return
		}
		if err := ws.WriteJSON(syncTopicPeerFrame{Type: "bound", Epoch: "e", Fence: "f", Stream: "s", State: "online"}); err != nil {
			return
		}
		readDone := make(chan struct{})
		go func() {
			defer close(readDone)
			for {
				if _, _, err := ws.ReadMessage(); err != nil {
					return
				}
			}
		}()
		defer func() { _ = ws.Close(); <-readDone }()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-readDone:
				return
			case <-ticker.C:
				if err := ws.WriteJSON(syncTopicPeerFrame{Type: "ready_ack", Epoch: "e", Fence: "f", Stream: "s", Last: "0"}); err != nil {
					return
				}
			}
		}
	}))
	defer srv.Close()
	target, err := url.Parse("ws" + strings.TrimPrefix(srv.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	client := newSyncTopicPeerClient(&Server{}, *target, srv.URL, "f1", strings.Repeat("a", 64))
	done := make(chan error, 1)
	go func() { done <- client.connect(client.secret) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		client.mu.Lock()
		ws := client.ws
		client.mu.Unlock()
		if ws != nil {
			_ = ws.Close()
		}
		<-done
		t.Error("application traffic without Pong kept the follower stream alive")
	}
	client.mu.Lock()
	wasReady, stillActive := client.hadReady, client.active || client.ready || client.ws != nil
	client.mu.Unlock()
	if !wasReady || stillActive {
		t.Fatalf("follower state after Pong expiry: hadReady=%v active=%v", wasReady, stillActive)
	}
	<-handlerDone
}

func TestSyncTopicFollowerRevokesOnlyForCompleteAuthorityRefusal(t *testing.T) {
	const refusal = `{"sync_topics":"refused","reason":"not-authorized"}`
	for _, scenario := range []string{"complete", "unavailable", "malformed", "oversized", "incomplete", "chunked"} {
		t.Run(scenario, func(t *testing.T) {
			status, body := http.StatusUnauthorized, refusal
			switch scenario {
			case "unavailable":
				status = http.StatusServiceUnavailable
			case "malformed":
				body += " {}"
			case "oversized":
				body += strings.Repeat(" ", 4096)
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "incomplete" {
					w.Header().Set("Content-Length", strconv.Itoa(len(body)+1))
				}
				w.WriteHeader(status)
				if scenario == "chunked" {
					w.(http.Flusher).Flush()
				}
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			target, err := url.Parse("ws" + strings.TrimPrefix(srv.URL, "http"))
			if err != nil {
				t.Fatal(err)
			}
			client := newSyncTopicPeerClient(&Server{}, *target, srv.URL, "f1", strings.Repeat("a", 64))
			owner := syncTopicWireOwn{Pane: "pane", Process: "proc", Generation: 1}
			client.intents["pane\x00proc\x00alerts"] = syncTopicPeerIntent{owner: owner, topic: "alerts"}
			if err := client.connect(client.secret); err == nil {
				t.Fatal("failed upgrade unexpectedly connected")
			}
			if client.active || client.ready {
				t.Fatal("failed upgrade left the feed ready")
			}
			if scenario == "complete" {
				if !client.retired || len(client.intents) != 0 || len(client.dirtyRetire) != 1 {
					t.Fatal("complete authority refusal did not retire the owner")
				}
			} else if client.retired || len(client.intents) != 1 || len(client.dirtyRetire) != 0 {
				t.Fatal("uncertain upgrade failure permanently retired accepted work")
			}
		})
	}
}

func TestSyncTopicFollowerBlockedWriteHasDeadline(t *testing.T) {
	oldTimeout := syncTopicsPeerControlTimeout
	syncTopicsPeerControlTimeout = 50 * time.Millisecond
	defer func() { syncTopicsPeerControlTimeout = oldTimeout }()
	stop := make(chan struct{})
	handlerDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		<-stop // Deliberately never read the follower's application frames.
	}))
	defer srv.Close()
	defer func() { close(stop); <-handlerDone }()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if tcp, ok := ws.UnderlyingConn().(*net.TCPConn); ok {
		if err := tcp.SetWriteBuffer(1024); err != nil {
			t.Fatal(err)
		}
	}
	client := &syncTopicPeerClient{ws: ws, writer: newSyncTopicPeerWriter(ws)}
	defer client.writer.close()
	frame := syncTopicPeerFrame{Type: "batch", Value: strings.Repeat("x", 180*1024)}
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for {
		err := client.writer.enqueue(frame)
		if err != nil && !errors.Is(err, errSyncTopicCapacity) && !errors.Is(err, errSyncTopicPeerNotReady) {
			t.Fatal(err)
		}
		select {
		case <-client.writer.done:
			return
		case <-deadline.C:
			t.Fatal("blocked peer writer survived its write deadline")
		case <-time.After(time.Millisecond):
		}
	}
}
