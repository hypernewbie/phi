package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hypernewbie/phi/pkg/clipboard"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
)

// paneInputPayload composes the exact byte sequence the main UI's staged
// Send produces (sendStagedInput in web/terminal.js): trimmed text,
// bracketed-paste wrapped when longer than 16 runes or multiline, then a
// carriage return. Never "\n" — the TUI coders (pi, claude, opencode, agy)
// only register Enter on CR, while a shell's line discipline maps CR to NL
// anyway (ICRNL), so CR is correct for both. The bracketed-paste wrap keeps
// long prompts from trickle-rendering / tripping TUI autocomplete. The
// trailing CR rides in the same write; pkg/pty's Write splits it onto its
// own ConPTY pipe write on Windows so conhost registers a distinct Enter.
func paneInputPayload(text string) string {
	payload := strings.TrimSpace(text)
	// Rune count mirrors the JS `payload.length` threshold (UTF-16 units;
	// rune count is the closest Go equivalent for the "is this big" check).
	if utf8.RuneCountInString(payload) > 16 || strings.Contains(payload, "\n") {
		payload = "\x1b[200~" + payload + "\x1b[201~"
	}
	return payload + "\r"
}

func handleFallback(w http.ResponseWriter, r *http.Request) {
	// Log requests briefly.
	log.Printf("[http] %s %s", r.Method, r.URL.Path)

	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/pin") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		id = strings.TrimSuffix(id, "/pin")

		var req struct {
			Pinned bool `json:"pinned"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		err := ptyManager.SetPinned(id, req.Pinned)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/mark") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		id = strings.TrimSuffix(id, "/mark")

		var req struct {
			Marked bool `json:"marked"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		err := ptyManager.SetMarked(id, req.Marked)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/title") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		id = strings.TrimSuffix(id, "/title")

		var req struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		err := ptyManager.SetTitle(id, req.Title)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	// Remote keyboard (web/input.html): write text to a pane's PTY stdin.
	// Reader-blind by construction — no hub/ring/checkpoint state is
	// touched, so attached sessions never notice the extra writer.
	// Auth: same accessAuthMiddleware gate as every /api route.
	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/input") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		id = strings.TrimSuffix(id, "/input")

		var req struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.Text) == "" {
			http.Error(w, "empty input", http.StatusBadRequest)
			return
		}

		inst, ok := ptyManager.Get(id)
		if !ok || inst.Pty == nil {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		if _, err := inst.Pty.Write([]byte(paneInputPayload(req.Text))); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/terminals/") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		err := ptyManager.Kill(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/recording") {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/terminals/"), "/recording")
		var from, through uint64
		if v, err := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64); err == nil {
			from = v
		}
		if v, err := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64); err == nil {
			through = v
		}
		var wantEpoch uint64
		var hasEpoch bool
		if v, err := strconv.ParseUint(r.URL.Query().Get("epoch"), 10, 64); err == nil {
			wantEpoch = v
			hasEpoch = true
		}
		rec, ok := wsHub.Recording(id, from, through)
		if !ok {
			http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
			return
		}
		if hasEpoch && rec.Epoch != wantEpoch {
			http.Error(w, "epoch mismatch", http.StatusConflict)
			return
		}
		// Hash-cache negotiation: the client declares the chunks it
		// already holds; verified prefixes are skipped and only the
		// first uncovered run is returned (same envelope). Fully
		// covered spans answer 204 with no body. Absent or garbage
		// declarations behave exactly as before (full range).
		if have := r.URL.Query().Get("have"); have != "" {
			mfrom, mthrough, haveAll := ws.MissingRun(from, through, rec.Data, rec.Start, ws.ParseHave(have))
			if haveAll {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if mfrom > from {
				// Re-derive the run from the narrowed span so Start/End
				// and markers stay consistent with the bytes sent.
				rec, ok = wsHub.Recording(id, mfrom, mthrough)
				if !ok {
					http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
					return
				}
				if hasEpoch && rec.Epoch != wantEpoch {
					http.Error(w, "epoch mismatch", http.StatusConflict)
					return
				}
			}
		}
		resizes := make([][3]uint64, 0, len(rec.Resizes))
		for _, m := range rec.Resizes {
			resizes = append(resizes, [3]uint64{m.AtSeq, uint64(m.Cols), uint64(m.Rows)})
		}
		hdr, _ := json.Marshal(ws.RecordingHeaderJSON{
			Epoch: rec.Epoch, Start: rec.Start, End: rec.End, Resizes: resizes,
		})
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		var lenb [4]byte
		binary.BigEndian.PutUint32(lenb[:], uint32(len(hdr)))
		_, _ = w.Write(lenb[:])
		_, _ = w.Write(hdr)
		_, _ = w.Write(rec.Data)
		return
	}

	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/checkpoint") {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/terminals/"), "/checkpoint")
		var req struct {
			Epoch   uint64 `json:"epoch"`
			Through uint64 `json:"through"`
			Cols    uint16 `json:"cols"`
			Rows    uint16 `json:"rows"`
			Ansi    string `json:"ansi"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, ws.MaxCheckpointBytes*2+4096))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ansi := []byte(req.Ansi)
		if len(ansi) > ws.MaxCheckpointBytes {
			http.Error(w, "checkpoint too large", http.StatusRequestEntityTooLarge)
			return
		}
		if !wsHub.StoreCheckpoint(id, ws.CheckpointUpload{
			Epoch: req.Epoch, Through: req.Through, Cols: req.Cols, Rows: req.Rows, Ansi: ansi,
		}) {
			http.Error(w, "stale checkpoint (epoch/through mismatch)", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/ws/pane/") {
		id := strings.TrimPrefix(r.URL.Path, "/ws/pane/")
		inst, ok := ptyManager.Get(id)
		if !ok {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		ws.HandleWS(w, r, inst, ptyManager, wsHub)
		return
	}

	// Fallback to static file server (embedded web assets).
	serveStatic(w, r)
}

func handleGetCoders(w http.ResponseWriter, r *http.Request) {
	ensureCoderManager()
	list := coderManager.List()
	descriptors := coders.DescriptorsFor(list)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(descriptors)
}

func handleGetSessions(w http.ResponseWriter, r *http.Request) {
	ensureCoderManager()
	coderID := r.URL.Query().Get("coder")
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	c, ok := coderManager.Get(coderID)
	if !ok {
		http.Error(w, "Invalid coder", http.StatusBadRequest)
		return
	}

	sessions, err := session.ListSessions(r.Context(), c, cwd)
	if err != nil {
		if errors.Is(err, session.ErrAdapterUnknown) {
			http.Error(w, "Unsupported session_source: "+c.SessionSource, http.StatusBadRequest)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if sessions == nil {
		sessions = []session.Session{}
	}

	// Sort sessions so that the most recently updated sessions are returned first.
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].TimeUpdated.After(sessions[j].TimeUpdated)
	})

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(sessions)
}

// ensureCoderManager lazily initializes the global coder manager so
// handler-level unit tests that drive handleGetCoders / handleSpawnTerminal
// without going through main() still have a usable registry. Production
// always sets coderManager in main.go; this fallback only fires in
// tests that drive a single handler.
func ensureCoderManager() {
	if coderManager == nil {
		coderManager = coders.NewManager()
	}
}

type SpawnRequest struct {
	Coder     string   `json:"coder"`
	Cwd       string   `json:"cwd"`
	SessionID string   `json:"session_id"`
	ExtraArgs []string `json:"extra_args"`
	Title     string   `json:"title"`
	Workspace string   `json:"workspace"`
}

func handleSpawnTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		instances := ptyManager.ListActive()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(instances)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ensureCoderManager()

	var req SpawnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Re-attach to running PTY instance if already spawned
	if req.SessionID != "" {
		for _, inst := range ptyManager.ListActive() {
			if inst.Coder == req.Coder && inst.SessionID == req.SessionID {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]string{
					"pane_id":    inst.ID,
					"session_id": inst.SessionID,
				})
				return
			}
		}
	}

	c, ok := coderManager.Get(req.Coder)
	if !ok {
		http.Error(w, "Unknown coder type", http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	plan, err := coders.ResolveLaunch(c, coders.SpawnRequest{
		Coder:     req.Coder,
		Cwd:       req.Cwd,
		SessionID: req.SessionID,
		ExtraArgs: req.ExtraArgs,
	}, coders.LaunchOptions{
		Config: coders.ConfigView{
			PiOffline:                        cfg.PiOffline,
			ClaudeDangerouslySkipPermissions: cfg.ClaudeDangerouslySkipPermissions,
		},
		DefaultCwd: activeCWD,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	spawnDir := plan.Cwd

	inst, err := ptyManager.Spawn(r.Context(), spawnDir, plan.Command, plan.Args, req.Coder, req.SessionID, plan.Env)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	inst.Title = req.Title
	inst.Workspace = req.Workspace

	// Provider-specific post-spawn side effects (agy sidecar cwd
	// update, future per-coder hooks) live in session.AfterSpawn
	// rather than being baked into the spawn handler (R5).
	session.AfterSpawn(c, req.SessionID, spawnDir)

	// A new pane may be the first live one in this cwd/worktree, so it
	// can widen the markdown watch set.
	if mdWatcher != nil {
		mdWatcher.Recompute()
	}

	ws.StartPTYReadLoop(inst, wsHub)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pane_id":    inst.ID,
		"session_id": inst.SessionID,
	})
}

type MetaRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func handleSessionMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req MetaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err := session.SaveAgySessionName(req.ID, req.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func handleFSAutocomplete(w http.ResponseWriter, r *http.Request) {
	typed := r.URL.Query().Get("path")
	expanded := expandHome(typed)

	parent := filepath.Dir(expanded)
	prefix := filepath.Base(expanded)

	if strings.HasSuffix(typed, "/") || typed == "" {
		parent = expanded
		if parent == "" {
			parent = "/"
		}
		prefix = ""
	}

	files, err := os.ReadDir(parent)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]string{})
		return
	}

	var suggestions []string
	for _, f := range files {
		if !f.IsDir() || strings.HasPrefix(f.Name(), ".") {
			continue // Skip non-directories and hidden items
		}
		name := f.Name()
		if strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			suggPath := filepath.Join(parent, name)
			// Return path starting with ~ if the user typed ~
			if strings.HasPrefix(typed, "~") {
				home, err := os.UserHomeDir()
				if err == nil {
					suggPath = strings.Replace(suggPath, home, "~", 1)
				}
			}
			suggestions = append(suggestions, suggPath)
		}
	}

	if len(suggestions) > 10 {
		suggestions = suggestions[:10]
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(suggestions)
}

func handleGetWorktrees(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	wts, err := session.ListGitWorktrees(r.Context(), cwd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cfg := loadConfig()
	activeWT := cfg.ActiveWorktrees[cwd]

	// Find if we have an active worktree. If not, default to current cwd or first one.
	hasActive := false
	for i := range wts {
		if activeWT != "" && wts[i].Path == activeWT {
			wts[i].Active = true
			hasActive = true
		}
		if exp, exists := cfg.ExpandedWorktrees[wts[i].Path]; exists {
			wts[i].Expanded = exp
		} else {
			wts[i].Expanded = false // Default closed
		}
	}

	// Fallback to mark active
	if !hasActive && len(wts) > 0 {
		// Try to match exact cwd first, otherwise fallback to first one
		matched := false
		for i := range wts {
			if wts[i].Path == cwd {
				wts[i].Active = true
				matched = true
				break
			}
		}
		if !matched {
			wts[0].Active = true
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(wts)
}

func handleGetWorktreeDirtyStates(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	wts, err := session.ListGitWorktrees(r.Context(), cwd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	paths := make([]string, 0, len(wts))
	for _, wt := range wts {
		paths = append(paths, wt.Path)
	}

	states := session.WorktreeDirtyStates(r.Context(), paths)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(states)
}

type WorktreeStateRequest struct {
	Workspace      string          `json:"workspace"`
	ActiveWorktree string          `json:"active_worktree"`
	Expanded       map[string]bool `json:"expanded"`
}

func handleWorktreeStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req WorktreeStateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if cfg.ExpandedWorktrees == nil {
		cfg.ExpandedWorktrees = make(map[string]bool)
	}
	if cfg.ActiveWorktrees == nil {
		cfg.ActiveWorktrees = make(map[string]string)
	}

	if req.ActiveWorktree != "" && req.Workspace != "" {
		cfg.ActiveWorktrees[req.Workspace] = req.ActiveWorktree
	}

	for path, exp := range req.Expanded {
		cfg.ExpandedWorktrees[path] = exp
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

// handleSystemCPU returns the current system-wide CPU percent (0.0–100.0)
// for the ambient CPU indicator in the UI header. Polled by the
// frontend at 1s; cheap enough to handle synchronously without caching.
// On sampling failure, returns 0.0 with HTTP 200 (the UI treats 0 as
// 'no data, leave indicator idle').
func handleSystemCPU(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()

	stats, err := cpuSampler.Sample(ctx)
	if err != nil {
		// Don't 500 — the CPU indicator is decorative. Return a zero
		// sample so the UI clears any active state.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(system.Stats{
			CPUPercent: 0,
			Timestamp:  time.Now(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(stats)
}

func handleGetClipboard(w http.ResponseWriter, r *http.Request) {
	// Resolve the clipboard source. When the frontend passes a ?pane=<id>
	// query parameter, we read from that specific PTY's session-isolated
	// shim file rather than the package-global shim path (which gets
	// overwritten on every new PTY and is ambiguous when multiple
	// sessions exist). When no pane is provided, fall back to legacy
	// behavior (system clipboard, or package-global shim if set).
	var shimPath string
	if pane := r.URL.Query().Get("pane"); pane != "" {
		if ptyManager != nil {
			if inst, ok := ptyManager.Get(pane); ok && inst != nil && inst.Pty != nil {
				shimPath = inst.Pty.ClipboardFile()
			}
		}
	}

	text, err := clipboard.Read(shimPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read remote clipboard: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	// Include "empty" and "source" so the JS layer can distinguish a real
	// copy from a fallback-to-empty (the bug that caused "Synced!" to
	// appear on blank clipboard writes over remote/headless sessions).
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"text":   text,
		"empty":  strings.TrimSpace(text) == "",
		"source": clipboardSource(shimPath),
	})
}

// clipboardSource reports where the clipboard content was read from,
// for diagnostic / toast purposes in the frontend.
func clipboardSource(shimPath string) string {
	if shimPath != "" {
		return "shim"
	}
	return "system"
}

func handleGetSessionTranscript(w http.ResponseWriter, r *http.Request) {
	ensureCoderManager()
	coder := r.URL.Query().Get("coder")
	id := r.URL.Query().Get("id")
	cwd := r.URL.Query().Get("cwd")

	c, ok := coderManager.Get(coder)
	if !ok {
		http.Error(w, "Invalid coder", http.StatusBadRequest)
		return
	}
	if !c.Capabilities.Transcript {
		http.Error(w, "Unsupported coder type", http.StatusBadRequest)
		return
	}

	messages, err := session.GetTranscript(r.Context(), c, cwd, id)
	if err != nil {
		if errors.Is(err, session.ErrAdapterUnknown) {
			http.Error(w, "Unsupported coder type", http.StatusBadRequest)
			return
		}
		if errors.Is(err, session.ErrTranscriptUnsupported) {
			http.Error(w, "Unsupported coder type", http.StatusBadRequest)
			return
		}
		http.Error(w, fmt.Sprintf("Failed to fetch session transcript: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(messages)
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if target == "" {
		http.Error(w, "Missing url parameter", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequest(r.Method, target, r.Body)
	if err != nil {
		http.Error(w, "Failed to create proxy request: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Copy headers from incoming request to the proxy request
	for k, vv := range r.Header {
		for _, v := range vv {
			req.Header.Add(k, v)
		}
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Proxy request failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy headers from proxy response to client response
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	// Copy response body to client response
	io.Copy(w, resp.Body)
}

func handleGetVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"version":        Version,
		"commit":         Commit,
		"date":           Date,
		"build_source":   BuildSource,
		"install_method": update.DetectInstallMethod(BuildSource),
		"started_at":     fmt.Sprintf("%d", StartedAt),
	})
}

// buildCoderArgs was removed when handleSpawnTerminal started routing
// through coders.ResolveLaunch. The launch-resolver tests at
// pkg/coders/coders_test.go exercise the same argv-assembly logic
// without needing a PTY to spawn.
