package server

import "net/http"

// handleLivez is the Kubernetes liveness probe. GET /livez (alias /healthz).
// Always 200 while the process can answer HTTP. Intentionally dependency-free
// and lock-free — a failure here means "restart the pod", so it must not be
// coupled to PTY/Hub state.
func handleLivez(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

// handleReadyz is the Kubernetes readiness probe. GET /readyz.
// 503 while draining (SIGTERM received) so k8s stops routing new traffic;
// 200 otherwise. Phi has no external backend to gate on, so the drain gate
// is the only meaningful readiness signal.
func (app *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if app.shuttingDown.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("shutting down\n"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready\n"))
}
