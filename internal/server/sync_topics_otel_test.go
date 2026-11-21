//go:build otel

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/pkg/obs"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestSyncTopicPeerCredentialsStayOutOfLogsAndSpans(t *testing.T) {
	withTempConfig(t)
	secret, wrong := strings.Repeat("ab", 32), strings.Repeat("cd", 32)
	if _, err := testStore.Update(func(cfg *config.Config) error {
		cfg.SyncTopicsPeerSecret = secret
		cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	restore := obs.SetEnabledForTest(true)
	defer func() {
		restore()
		otel.SetTracerProvider(previous)
		_ = provider.Shutdown(context.Background())
	}()
	var logs bytes.Buffer
	oldLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(oldLogger)
	handlerDone := make(chan struct{}, 2)
	handler := testServer.Handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() { handlerDone <- struct{}{} }()
		handler.ServeHTTP(w, r)
	}))
	defer srv.Close()
	target := "ws" + strings.TrimPrefix(srv.URL, "http") + syncTopicsPeerPath
	scenarios := []string{"wrong", "missing", "duplicate", "oversized", "invalid-bind", "malformed-control", "revoked", "config-error"}
	for _, scenario := range scenarios {
		credential := secret
		if scenario == "wrong" {
			credential = wrong
		}
		headers := http.Header{}
		headers.Set(syncTopicsPeerHeader, "f1")
		headers.Set(syncTopicsSecretHeader, credential)
		switch scenario {
		case "missing":
			headers.Del(syncTopicsSecretHeader)
		case "duplicate":
			headers.Add(syncTopicsSecretHeader, credential)
		case "oversized":
			headers.Set(syncTopicsSecretHeader, strings.Repeat(credential, 128))
		}
		ws, response, err := websocket.DefaultDialer.Dial(target, headers)
		if scenario == "wrong" || scenario == "missing" || scenario == "duplicate" || scenario == "oversized" {
			if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("%s credential was not refused", scenario)
			}
			_ = response.Body.Close()
		} else {
			if err != nil {
				t.Fatal("authorized peer upgrade failed")
			}
			_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
			var offer, bound syncTopicPeerFrame
			if err := ws.ReadJSON(&offer); err != nil {
				_ = ws.Close()
				t.Fatal(err)
			}
			bind := syncTopicPeerFrame{Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch, Instance: "log-test", Prior: offer.Fence}
			if scenario == "invalid-bind" {
				bind.Version++
				bind.Value = secret
			}
			if err := ws.WriteJSON(bind); err != nil {
				_ = ws.Close()
				t.Fatal(err)
			}
			if scenario == "invalid-bind" {
				if _, _, err := ws.ReadMessage(); err == nil {
					_ = ws.Close()
					t.Fatal("invalid bind was not closed")
				}
			} else {
				if err := ws.ReadJSON(&bound); err != nil || bound.Type != "bound" {
					_ = ws.Close()
					t.Fatal("authorized bind failed")
				}
				switch scenario {
				case "malformed-control":
					_ = ws.WriteMessage(websocket.TextMessage, []byte(`{"private":"`+secret+`"`))
				case "revoked":
					if _, err := testStore.Update(func(cfg *config.Config) error {
						cfg.SyncTopicsAllowedPeers = nil
						return nil
					}); err != nil {
						t.Fatal(err)
					}
					testServer.peerRegistry().sweep(testServer)
				case "config-error":
					if err := os.WriteFile(testStore.PrimaryPath(), []byte(`sync_topics_peer_secret = `+secret+` !`), 0o600); err != nil {
						t.Fatal(err)
					}
					testStore.ResetCache()
					_ = ws.WriteJSON(syncTopicPeerFrame{Type: "control", Epoch: bound.Epoch, Fence: bound.Fence, Stream: bound.Stream, Control: "1", Action: "register"})
				}
				if _, _, err := ws.ReadMessage(); err == nil {
					_ = ws.Close()
					t.Fatalf("%s stream was not closed", scenario)
				}
			}
			_ = ws.Close()
		}
		select {
		case <-handlerDone:
		case <-time.After(2 * time.Second):
			t.Fatal("peer handler did not finish")
		}
		if scenario == "revoked" {
			if _, err := testStore.Update(func(cfg *config.Config) error {
				cfg.SyncTopicsAllowedPeers = map[string]string{"f1": secret}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Exercise follower upgrade failures too. Only a complete, fixed-length
	// authority refusal may cancel accepted work; all errors stay redacted.
	for _, scenario := range []string{"complete", "unavailable", "malformed", "incomplete"} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(syncTopicsSecretHeader) != secret {
				t.Error("follower did not send its credential in the private header")
			}
			body, status := `{"sync_topics":"refused","reason":"not-authorized"}`, http.StatusUnauthorized
			switch scenario {
			case "unavailable":
				status = http.StatusServiceUnavailable
			case "malformed":
				body += secret
			case "incomplete":
				w.Header().Set("Content-Length", strconv.Itoa(len(body)+1))
			}
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}))
		target, err := url.Parse("ws" + strings.TrimPrefix(upstream.URL, "http") + syncTopicsPeerPath)
		if err != nil {
			upstream.Close()
			t.Fatal(err)
		}
		client := newSyncTopicPeerClient(&Server{}, *target, upstream.URL, "f1", secret)
		if err := client.connect(secret); err == nil || strings.Contains(err.Error(), secret) {
			upstream.Close()
			t.Fatal("follower failure was missing or exposed a credential")
		}
		upstream.Close()
	}
	if len(recorder.Ended()) < len(scenarios) {
		t.Fatal("peer failure boundaries emitted no completed spans")
	}
	for _, span := range recorder.Ended() {
		data, err := json.Marshal(tracetest.SpanStubFromReadOnlySpan(span))
		if err != nil {
			t.Fatal(err)
		}
		for _, credential := range []string{secret, wrong} {
			if bytes.Contains(data, []byte(credential)) || strings.Contains(logs.String(), credential) {
				t.Fatal("a peer credential leaked into logs or span data")
			}
		}
	}
}
