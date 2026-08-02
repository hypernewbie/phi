package main

import (
	"strings"

	"net/http"
	"net/http/httptest"
	"testing"
)

// The sync board is machine-to-machine: this phi instance is the coordinator
// and other machines POST to it with no browser session. Enabling the access
// password broke that with "access authentication required".
//
// The bypass has to stay narrow. Exempting /api/sync/* outright would leave
// the board readable and writable by anyone who can reach the port on an
// otherwise password-protected phi, so these tests pin the boundaries.

func syncReq(t *testing.T, path, header, token string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	if header != "" {
		r.Header.Set(header, token)
	}
	return r
}

func TestSyncTokenAuthorized(t *testing.T) {
	t.Run("no token configured grants nothing", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.SyncToken = ""
		saveConfig(cfg)
		// Fail closed: an install that never opted in must be exactly as
		// locked down as before the bypass existed.
		if syncTokenAuthorized(syncReq(t, "/api/sync/messages", "X-Phi-Sync-Token", "")) {
			t.Fatal("empty configured token authorized an empty header")
		}
		if syncTokenAuthorized(syncReq(t, "/api/sync/messages", "X-Phi-Sync-Token", "anything")) {
			t.Fatal("empty configured token authorized a supplied token")
		}
	})

	t.Run("correct token authorizes sync paths", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.SyncToken = "s3cret-token"
		saveConfig(cfg)
		for _, p := range []string{"/api/sync/messages", "/api/sync/messages/", "/api/sync/messages/somekey"} {
			if !syncTokenAuthorized(syncReq(t, p, "X-Phi-Sync-Token", "s3cret-token")) {
				t.Fatalf("valid token rejected for %s", p)
			}
		}
	})

	t.Run("bearer form also works", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.SyncToken = "s3cret-token"
		saveConfig(cfg)
		if !syncTokenAuthorized(syncReq(t, "/api/sync/messages", "Authorization", "Bearer s3cret-token")) {
			t.Fatal("bearer token rejected")
		}
		if !syncTokenAuthorized(syncReq(t, "/api/sync/messages", "Authorization", "bearer s3cret-token")) {
			t.Fatal("lowercase bearer rejected")
		}
	})

	t.Run("wrong token is rejected", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.SyncToken = "s3cret-token"
		saveConfig(cfg)
		for _, bad := range []string{"", "nope", "s3cret-toke", "s3cret-tokenn", "S3CRET-TOKEN"} {
			if syncTokenAuthorized(syncReq(t, "/api/sync/messages", "X-Phi-Sync-Token", bad)) {
				t.Fatalf("token %q was accepted", bad)
			}
		}
	})

	t.Run("does not unlock anything outside the sync board", func(t *testing.T) {
		withTempConfig(t)
		cfg := loadConfig()
		cfg.SyncToken = "s3cret-token"
		saveConfig(cfg)
		// The whole point of scoping: this credential travels to other
		// machines, so it must not open the terminal or config API.
		for _, p := range []string{
			"/api/terminals",
			"/api/config",
			"/api/config/sync-token",
			"/api/sync",
			"/api/sync/other",
			"/ws/terminal",
			"/api/sync/messagesX",
		} {
			if syncTokenAuthorized(syncReq(t, p, "X-Phi-Sync-Token", "s3cret-token")) {
				t.Fatalf("sync token authorized %s", p)
			}
		}
	})
}

func TestSyncTokenEndpoint(t *testing.T) {
	t.Run("generates on first read and is stable after", func(t *testing.T) {
		withTempConfig(t)
		w := httptest.NewRecorder()
		handleSyncToken(w, httptest.NewRequest(http.MethodGet, "/api/config/sync-token", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status %d", w.Code)
		}
		first := loadConfig().SyncToken
		if first == "" {
			t.Fatal("no token generated")
		}

		w2 := httptest.NewRecorder()
		handleSyncToken(w2, httptest.NewRequest(http.MethodGet, "/api/config/sync-token", nil))
		if loadConfig().SyncToken != first {
			t.Fatal("token changed on a plain read")
		}
	})

	t.Run("rotate issues a new token", func(t *testing.T) {
		withTempConfig(t)
		w := httptest.NewRecorder()
		handleSyncToken(w, httptest.NewRequest(http.MethodGet, "/api/config/sync-token", nil))
		first := loadConfig().SyncToken

		r := httptest.NewRequest(http.MethodPost, "/api/config/sync-token", strings.NewReader(`{"rotate":true}`))
		handleSyncToken(httptest.NewRecorder(), r)
		second := loadConfig().SyncToken
		if second == "" || second == first {
			t.Fatalf("rotate did not issue a new token (%q -> %q)", first, second)
		}
		// The old one must stop working, which is how a machine is revoked.
		if syncTokenAuthorized(syncReq(t, "/api/sync/messages", "X-Phi-Sync-Token", first)) {
			t.Fatal("rotated-out token still authorizes")
		}
	})
}
