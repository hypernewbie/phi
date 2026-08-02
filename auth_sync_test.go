package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The sync board is machine-to-machine: this phi instance is the coordinator
// and other machines POST to it with no browser session. Setting an access
// password broke that with "access authentication required".
//
// The board carries coordination metadata between the operator's own machines,
// and anyone who can reach this port can already reach the web UI, the
// terminals and the file tree -- so it is simply exempt. What these tests pin
// is the *scope* of that exemption: it must not become a general hole.

func authedHandler() http.Handler {
	return accessAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("reached"))
	}))
}

func TestSyncBoardBypassesAccessAuth(t *testing.T) {
	withTempConfig(t)
	auth := useTestAccessAuth(t)
	if err := auth.configure(testAccessHash()); err != nil {
		t.Fatal(err)
	}
	if !auth.enabled() {
		t.Fatal("access auth should be enabled for this test to mean anything")
	}
	h := authedHandler()

	t.Run("sync message paths are reachable without a session", func(t *testing.T) {
		for _, p := range []string{
			"/api/sync/messages",
			"/api/sync/messages/",
			"/api/sync/messages/somekey",
		} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("%s: got %d, want 200 -- sync board must work without a browser session", p, w.Code)
			}
		}
	})

	t.Run("writes are reachable too, not just reads", func(t *testing.T) {
		// Posting is the half that actually broke; a read-only exemption
		// would still leave syncing dead.
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/sync/messages/key", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("POST got %d, want 200", w.Code)
		}
	})

	t.Run("the exemption does not leak to the rest of the API", func(t *testing.T) {
		// The blast radius is the point. Anything that is not a sync message
		// endpoint must still require a session -- including the coordinator
		// setting, which controls where this instance syncs to.
		for _, p := range []string{
			"/api/terminals",
			"/api/config",
			"/api/config/sync-coordinator",
			"/api/sync",
			"/api/sync/other",
			"/api/sync/messagesX",
			"/ws/terminal",
		} {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("%s: got %d, want 401 -- the sync exemption must not widen", p, w.Code)
			}
		}
	})
}

func TestSyncBoardPathMatching(t *testing.T) {
	in := []string{"/api/sync/messages", "/api/sync/messages/", "/api/sync/messages/a/b"}
	out := []string{"/api/sync", "/api/sync/", "/api/sync/messagesX", "/api/config", "/api/sync/message"}
	for _, p := range in {
		if !isSyncBoardPath(p) {
			t.Errorf("%s should be a sync board path", p)
		}
	}
	for _, p := range out {
		if isSyncBoardPath(p) {
			t.Errorf("%s should NOT be a sync board path", p)
		}
	}
}
