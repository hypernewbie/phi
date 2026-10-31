package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/hypernewbie/phi/internal/dshweb"
	"github.com/hypernewbie/phi/pkg/system"
)

var (
	dshServiceMu sync.Mutex
	dshService   *dshweb.Service
)

// startDshPreview registers the owned DSH service and begins async startup.
// Call once, after Phi binds. The stop hook is registered before any child
// spawns, so shutdown and serve-error paths always find the service.
func startDshPreview(cfg Config) {
	dshServiceMu.Lock()
	defer dshServiceMu.Unlock()
	if dshService != nil {
		return
	}
	svc := dshweb.NewService(dshweb.ServiceConfig{
		Enabled: cfg.DshPreviewEnabled,
		Command: cfg.DshPreviewCommand,
		Origin:  cfg.DshPreviewOrigin,
		DataDir: system.PhiDataDir(),
	}, accessAuth.admitDSH, accessAuth.currentGeneration)
	dshService = svc
	svc.Start()
}

// stopDshPreview ends the owned DSH child and closes live carrier work.
// Idempotent; safe before start.
func stopDshPreview() {
	dshServiceMu.Lock()
	svc := dshService
	dshServiceMu.Unlock()
	if svc != nil {
		svc.Stop()
	}
}

func currentDshService() *dshweb.Service {
	dshServiceMu.Lock()
	defer dshServiceMu.Unlock()
	return dshService
}

// dshRevokeLiveWork closes DSH carrier work admitted under an older auth
// generation. Runs alongside the WebSocket close, never instead of it.
func dshRevokeLiveWork() {
	if svc := currentDshService(); svc != nil {
		svc.RevokeStale()
	}
}

// dshStatusResponse is the launcher payload. Enabled is a real boolean;
// the frontend rejects any other shape.
type dshStatusResponse struct {
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`
	Mount   string `json:"mount,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// handleDshStatus reports the preview state for the launcher. It sits behind
// the global auth middleware and never carries tokens, commands, or paths.
func handleDshStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	st := dshweb.Status{State: dshweb.StateDisabled}
	if svc := currentDshService(); svc != nil {
		st = svc.Status()
	}
	resp := dshStatusResponse{Enabled: st.Enabled, State: st.State}
	if st.State == dshweb.StateReady && st.Mount != "" {
		resp.Mount = st.Mount
	}
	if st.Reason != "" && st.Reason != dshweb.ReasonNone {
		resp.Reason = st.Reason
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(resp)
}

// dshPathGuard runs before mux dispatch and rejects encoded traversal,
// encoded separators, and launch-token queries on DSH paths. It reads the
// raw escaped path so cleaning never hides an attack.
func dshPathGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		escaped := r.URL.EscapedPath()
		if r.URL.Path == "/api/dsh" || strings.HasPrefix(r.URL.Path, "/api/dsh/") || escaped == "/api/dsh" || strings.HasPrefix(escaped, "/api/dsh/") {
			w.Header().Set("Cache-Control", "no-store")
			lower := strings.ToLower(escaped)
			if strings.Contains(lower, "%2e") || strings.Contains(lower, "%2f") ||
				strings.Contains(lower, "%5c") || strings.Contains(lower, "%25") || strings.Contains(escaped, "\\") {
				http.Error(w, "invalid dsh path", http.StatusBadRequest)
				return
			}
			if strings.Contains(escaped, "/./") || strings.Contains(escaped, "/../") ||
				strings.HasSuffix(escaped, "/.") || strings.HasSuffix(escaped, "/..") {
				http.Error(w, "invalid dsh path", http.StatusBadRequest)
				return
			}
			if r.URL.Query().Has("token") {
				http.Error(w, "token query not allowed", http.StatusBadRequest)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// handleDshMount carries one browser request to the owned DSH child: route
// the ready generation, verify carrier policy, admit Phi auth, exchange the
// launch token once per browser, then reverse-proxy the rest.
func handleDshMount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	svc := currentDshService()
	if svc == nil {
		http.NotFound(w, r)
		return
	}
	st := svc.Status()
	if !st.Enabled || st.State != dshweb.StateReady {
		http.NotFound(w, r)
		return
	}
	instance, rest, ok := dshweb.SplitMount(r.URL.Path)
	if !ok || !dshweb.ValidInstance(instance) {
		http.NotFound(w, r)
		return
	}
	readyInstance, proxy, _, ok := svc.Ready()
	if !ok || instance != readyInstance {
		http.NotFound(w, r)
		return
	}
	if err := dshweb.CheckCarrierRequest(r, svc.Origin()); err != nil {
		if r.URL.Query().Has("token") {
			http.Error(w, "token query not allowed", http.StatusBadRequest)
			return
		}
		http.Error(w, "dsh carrier denied", http.StatusForbidden)
		return
	}
	lease, ok := svc.Admit(r)
	if !ok {
		http.Error(w, "access authentication required", http.StatusUnauthorized)
		return
	}
	cookieName, err := dshweb.CookieName(svc.Origin().Scheme, r.Host)
	if err != nil {
		http.Error(w, "dsh carrier denied", http.StatusForbidden)
		return
	}
	cookieValue, present, ok := dshweb.FilterUpstreamCookie(r, cookieName)
	if !ok {
		http.Error(w, "conflicting dsh session", http.StatusBadRequest)
		return
	}
	live := svc.Live()
	work, ok := live.Register(lease)
	if !ok {
		http.Error(w, "access authentication required", http.StatusUnauthorized)
		return
	}
	defer live.Unregister(work)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	if !live.SetCancel(work, cancel) {
		http.Error(w, "access authentication required", http.StatusUnauthorized)
		return
	}

	if rest == "" {
		target := r.URL.EscapedPath() + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusSeeOther)
		return
	}
	if r.Method == http.MethodGet && rest == "/" && !present {
		cookie, err := svc.BootstrapExchange(ctx, r.Host)
		if err != nil {
			http.Error(w, "dsh unavailable", http.StatusBadGateway)
			return
		}
		if live.Stale(work) {
			http.Error(w, "access authentication required", http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, cookie)
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, st.Mount, http.StatusSeeOther)
		return
	}

	outReq := r.Clone(dshweb.ContextWithLiveWork(ctx, work))
	outReq.Header.Del("Authorization")
	outReq.Header.Del("Proxy-Authorization")
	outReq.Header.Del("X-Forwarded-For")
	outReq.Header.Del("X-Forwarded-Host")
	outReq.Header.Del("X-Forwarded-Proto")
	outReq.Header.Del("Forwarded")
	// Only the DSH session cookie crosses to the child. Phi credentials
	// and unrelated cookies never leave the carrier.
	outReq.Header.Del("Cookie")
	if present {
		outReq.Header.Set("Cookie", (&http.Cookie{Name: cookieName, Value: cookieValue}).String())
	}
	proxy.ServeHTTP(live.WatchHijack(w, work), outReq)
}
