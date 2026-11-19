//go:build otel

package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	for _, credential := range []string{wrong, secret} {
		headers := http.Header{}
		headers.Set(syncTopicsPeerHeader, "f1")
		headers.Set(syncTopicsSecretHeader, credential)
		ws, response, err := websocket.DefaultDialer.Dial(target, headers)
		if credential == wrong {
			if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
				t.Fatal("invalid credential was not refused")
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
			if err := ws.WriteJSON(syncTopicPeerFrame{Type: "bind", Version: syncTopicsPeerVersion, Epoch: offer.Epoch, Instance: "log-test", Prior: offer.Fence}); err != nil {
				_ = ws.Close()
				t.Fatal(err)
			}
			if err := ws.ReadJSON(&bound); err != nil || bound.Type != "bound" {
				_ = ws.Close()
				t.Fatal("authorized bind failed")
			}
			_ = ws.Close()
		}
		select {
		case <-handlerDone:
		case <-time.After(2 * time.Second):
			t.Fatal("peer handler did not finish")
		}
	}
	if len(recorder.Ended()) < 2 {
		t.Fatal("peer boundary emitted no completed auth and upgrade spans")
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
