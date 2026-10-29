package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/ws"
)

func TestControlAuthRejectsNoCookie(t *testing.T) {
	// Auth state lives beside config, so this test isolates both.
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := setTestAccessRecord(auth, testAccessHash()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/control", ws.HandleControl(nil, rpc.NewManager(), nil))
	srv := httptest.NewServer(accessAuthMiddleware(mux))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/control"
	c, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil {
		_ = c.Close()
		t.Fatal("expected dial rejection without cookie")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %+v", resp)
	}
}
