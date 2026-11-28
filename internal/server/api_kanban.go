package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleKanbanVault stores the Kanban credentials in the server's config.
//
// The browser never receives the password: the server owns the Vikunja
// session (see kanban_session.go), so a client only needs to know whether
// credentials exist and which instance they point at.
func (app *Server) handleKanbanVault(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg := app.loadConfig()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"username":     cfg.KanbanUsername,
			"url":          cfg.KanbanURL,
			"has_password": cfg.KanbanPasswordEnc != "",
		})

	case http.MethodPost:
		var req struct {
			Password string `json:"password"`
			Username string `json:"username"`
			URL      string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		cfg := app.loadConfig()
		if req.Password != "" {
			enc, err := EncryptVault(req.Password)
			if err != nil {
				http.Error(w, "Failed to encrypt password: "+err.Error(), http.StatusInternalServerError)
				return
			}
			cfg.KanbanPasswordEnc = enc
		}
		if req.Username != "" {
			cfg.KanbanUsername = req.Username
		}
		if req.URL != "" {
			cfg.KanbanURL = req.URL
		}
		app.saveConfig(cfg)
		// New credentials mean the cached session belongs to the old ones.
		app.kanbanDropSession()
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		cfg := app.loadConfig()
		cfg.KanbanPasswordEnc = ""
		cfg.KanbanUsername = ""
		cfg.KanbanURL = ""
		app.saveConfig(cfg)
		app.kanbanDropSession()
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// kanbanDropSession forgets the cached Vikunja session. New credentials, a
// disconnect, or a changed instance all start from scratch.
func (app *Server) kanbanDropSession() {
	app.kanbanMu.Lock()
	app.kanbanToken = ""
	app.kanbanTokenExpiry = time.Time{}
	app.kanbanCooldownUntil = time.Time{}
	app.kanbanMu.Unlock()
}

// handleKanbanSession opens (or confirms) the server-side Kanban session.
//
// The client never logs in itself: it asks the server, the server logs in at
// most once per token lifetime, and every client of this backend shares that
// one login. A 429 from the instance is reported with the wait it asks for.
func (app *Server) handleKanbanSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token, err := app.kanbanEnsureToken(r.Context())
	if err != nil {
		app.kanbanWriteError(w, err)
		return
	}
	baseURL, _, _, credErr := app.kanbanCredentials()
	if credErr != nil {
		app.kanbanWriteError(w, credErr)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"url":     baseURL,
		"session": strings.TrimSpace(token[:min(len(token), 8)]) + "…",
	})
}

// handleKanbanAPI serves one board request against the configured instance.
//
// The token lives in the server, so no credential ever reaches the browser.
// A 401 refreshes the session exactly once; a second 401 is final.
func (app *Server) handleKanbanAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	baseURL, _, _, err := app.kanbanCredentials()
	if err != nil {
		app.kanbanWriteError(w, err)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/kanban/v1")
	target, err := kanbanUpstreamURL(baseURL, rest, r.URL.Query())
	if err != nil {
		http.Error(w, "Bad Kanban path", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, kanbanMaxBodyBytes))
	if err != nil {
		http.Error(w, "Could not read the request body", http.StatusBadRequest)
		return
	}

	resp, status, err := app.kanbanForward(r.Context(), r.Method, target, body, r.Header.Get("Content-Type"))
	if err != nil {
		app.kanbanWriteError(w, err)
		return
	}
	if status == http.StatusUnauthorized {
		// One refresh, then one replay. The upstream answers 401 before it
		// applies anything, so a replay is safe for every method.
		app.kanbanDropToken()
		resp, status, err = app.kanbanForward(r.Context(), r.Method, target, body, r.Header.Get("Content-Type"))
		if err != nil {
			app.kanbanWriteError(w, err)
			return
		}
		if status == http.StatusUnauthorized {
			app.kanbanWriteError(w, &kanbanUpstreamError{
				status:  http.StatusUnauthorized,
				message: "The Kanban session expired. Sign in again.",
			})
			return
		}
	}
	defer resp.Body.Close()
	kanbanCopyResponse(w, resp)
}

// kanbanForward performs one upstream request with the session token.
func (app *Server) kanbanForward(ctx context.Context, method, target string, body []byte, contentType string) (*http.Response, int, error) {
	token, err := app.kanbanEnsureToken(ctx)
	if err != nil {
		return nil, 0, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, kanbanRequestTimeout)
	defer cancel()
	var reader io.Reader
	if len(body) > 0 {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(reqCtx, method, target, reader)
	if err != nil {
		return nil, 0, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban request could not be built.",
		}
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: "The Kanban server could not be reached: " + err.Error(),
		}
	}
	return resp, resp.StatusCode, nil
}

// kanbanCopyResponse copies the upstream answer to the client. Set-Cookie is
// dropped: an upstream cookie must never land in phi's origin.
func kanbanCopyResponse(w http.ResponseWriter, resp *http.Response) {
	for key, values := range resp.Header {
		switch http.CanonicalHeaderKey(key) {
		case "Set-Cookie", "Connection", "Transfer-Encoding", "Keep-Alive",
			"Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer",
			"Upgrade", "Content-Length":
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// kanbanWriteError writes one client-facing Kanban error.
func (app *Server) kanbanWriteError(w http.ResponseWriter, err error) {
	var upstream *kanbanUpstreamError
	if !asUpstream(err, &upstream) {
		upstream = &kanbanUpstreamError{
			status:  http.StatusBadGateway,
			message: err.Error(),
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if upstream.retryAfter > 0 {
		seconds := int(upstream.retryAfter.Round(time.Second) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	w.WriteHeader(upstream.status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"message":             upstream.message,
		"retry_after_seconds": int(upstream.retryAfter.Round(time.Second) / time.Second),
	})
}
