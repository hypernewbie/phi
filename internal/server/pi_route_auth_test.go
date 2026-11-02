package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTranscriptSearchRouteUsesAccessAuthGate(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	// auth.db is authoritative after migration; configure() leaves the gate
	// disabled, so commit the verifier through the password transaction.
	if err := setTestAccessRecord(auth, testAccessHash()); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pi-bridge/transcript-search", testServer.pi.HandlePiBridgeTranscriptSearch)
	protected := testServer.accessManager.Middleware(mux)
	req := httptest.NewRequest(http.MethodPost, "/api/pi-bridge/transcript-search", strings.NewReader(
		`{"pane":"unknown","query":"needle","generation":"1","initial":true}`,
	))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d, want 401", rec.Code)
	}
}
