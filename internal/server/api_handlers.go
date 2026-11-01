package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/pkg/clipboard"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
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

func (app *Server) handleFallback(w http.ResponseWriter, r *http.Request) {
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

		err := app.pty.SetPinned(id, req.Pinned)
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

		err := app.pty.SetMarked(id, req.Marked)
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

		inst, ok := app.pty.Get(id)
		if !ok || inst == nil {
			http.Error(w, "terminal instance not found", http.StatusNotFound)
			return
		}
		if inst.Coder == "pi" {
			if strings.TrimSpace(req.Title) == "" {
				http.Error(w, "Pi session name must be nonblank", http.StatusBadRequest)
				return
			}
			for _, character := range req.Title {
				if unicode.IsControl(character) {
					http.Error(w, "Pi session name cannot contain control characters", http.StatusBadRequest)
					return
				}
			}
			if inst.Pty == nil || inst.IsPtyDead() {
				http.Error(w, "Pi terminal is not live", http.StatusConflict)
				return
			}
			command := []byte("/name " + req.Title + "\r")
			inst.UpdateInput()
			written, err := inst.Pty.Write(command)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			if written != len(command) {
				http.Error(w, "short write delivering Pi session name", http.StatusBadGateway)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}

		err := app.pty.SetTitle(id, req.Title)
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

		inst, ok := app.pty.Get(id)
		if !ok || inst.Pty == nil {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		inst.UpdateInput()
		if _, err := inst.Pty.Write([]byte(paneInputPayload(req.Text))); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/terminals/") {
		id := strings.TrimPrefix(r.URL.Path, "/api/terminals/")
		err := app.pty.Kill(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/state") {
		http.Error(w, "server-rendered terminal state is retired; replay with /replay", http.StatusUpgradeRequired)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/replay") {
		app.handleTerminalReplay(w, r)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/recording") {
		http.Error(w, "terminal recording v1 is retired; replay with /replay", http.StatusUpgradeRequired)
		return
	}

	if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/terminals/") && strings.HasSuffix(r.URL.Path, "/checkpoint") {
		// Client checkpoint uploads stay: mobile clients keep sending
		// them and local previews keep working. The v2 attach never
		// serves a stored checkpoint; raw replay is the only recovery.
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
		if !app.hub.StoreCheckpoint(id, ws.CheckpointUpload{
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
		inst, ok := app.pty.Get(id)
		if !ok {
			http.Error(w, "Pane not found", http.StatusNotFound)
			return
		}
		ws.HandleWS(w, r, inst, app.pty, app.hub)
		return
	}

	// Fallback to static assets (embedded by default, disk with --web).
	app.static.ServeHTTP(w, r)
}

func (app *Server) handleGetCoders(w http.ResponseWriter, r *http.Request) {
	app.ensureCoderManager()
	list := app.coders.List()
	descriptors := coders.DescriptorsFor(list)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(descriptors)
}

func (app *Server) handleGetSessions(w http.ResponseWriter, r *http.Request) {
	app.ensureCoderManager()
	coderID := r.URL.Query().Get("coder")
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = app.activeCWD
	}

	c, ok := app.coders.Get(coderID)
	if !ok {
		http.Error(w, "Invalid coder", http.StatusBadRequest)
		return
	}

	limit, offset := 0, 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			http.Error(w, "Invalid limit", http.StatusBadRequest)
			return
		}
		limit = value
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil {
			http.Error(w, "Invalid offset", http.StatusBadRequest)
			return
		}
		offset = value
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}

	sessions, err := session.ListSessionsPage(r.Context(), c, cwd, offset, limit)
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

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(sessions)
}

// ensureCoderManager lazily initializes the global coder manager so
// handler-level unit tests that drive handleGetCoders / handleSpawnTerminal
// without going through main() still have a usable registry. Production
// always sets Coders in main.go; this fallback only fires in
// tests that drive a single handler.
func (app *Server) ensureCoderManager() {
	if app.coders == nil {
		app.coders = coders.NewManager()
	}
}

type SpawnRequest struct {
	Coder        string   `json:"coder"`
	Cwd          string   `json:"cwd"`
	SessionID    string   `json:"session_id"`
	ExtraArgs    []string `json:"extra_args"`
	Title        string   `json:"title"`
	Workspace    string   `json:"workspace"`
	OpenCodeMini bool     `json:"opencode_mini,omitempty"`
	PiPsi        bool     `json:"pi_psi,omitempty"`
	Cols         uint16   `json:"cols,omitempty"`
	Rows         uint16   `json:"rows,omitempty"`
}

func (app *Server) terminalOpenCodeMode(inst *pty.PTYInstance) string {
	if inst.OpenCodeMode != "" {
		return inst.OpenCodeMode
	}
	if app.coders != nil {
		if c, ok := app.coders.Get(inst.Coder); ok {
			return c.OpenCodeMode
		}
	}
	return ""
}

func (app *Server) terminalPiMode(inst *pty.PTYInstance) string {
	if inst.PiMode != "" {
		return inst.PiMode
	}
	if app.coders != nil {
		if c, ok := app.coders.Get(inst.Coder); ok {
			return c.PiMode
		}
	}
	return ""
}

func (app *Server) handleSpawnTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		instances := app.pty.ListActive()
		type terminalView struct {
			pty.PTYInstanceSnapshot
			ActiveWS      bool
			ActiveWSCount int
			PiBridge      *piapp.BridgePaneState `json:"pi_bridge,omitempty"`
		}
		views := make([]terminalView, 0, len(instances))
		for _, inst := range instances {
			snapshot := inst.Snapshot()
			snapshot.OpenCodeMode = app.terminalOpenCodeMode(inst)
			snapshot.PiMode = app.terminalPiMode(inst)
			view := terminalView{PTYInstanceSnapshot: snapshot, ActiveWS: snapshot.ActiveWS, ActiveWSCount: snapshot.ActiveWSCount}
			if piapp.ForCoder(snapshot.Coder) && snapshot.PiMode != "psi" {
				state := app.bridgeOrNil().PaneSnapshot(snapshot.ID)
				view.PiBridge = &state
			}
			views = append(views, view)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(views)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	app.ensureCoderManager()

	var req SpawnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if (req.Cols == 0) != (req.Rows == 0) {
		http.Error(w, "cols and rows must both be supplied", http.StatusBadRequest)
		return
	}
	c, ok := app.coders.Get(req.Coder)
	if req.OpenCodeMini {
		var err error
		c, err = coders.OpenCodeMini(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	if req.PiPsi {
		var err error
		c, err = coders.PiPsi(c)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	// Reattach only to the requested presentation of this session. Mini
	// and full TUI clients may coexist; never replace a running process.
	if req.SessionID != "" {
		for _, inst := range app.pty.ListActive() {
			snapshot := inst.Snapshot()
			if snapshot.Coder == req.Coder && snapshot.SessionID == req.SessionID {
				mode := app.terminalOpenCodeMode(inst)
				if req.Coder == "opencode" && ok && c.OpenCodeMode != "" && mode != c.OpenCodeMode {
					continue
				}
				piMode := app.terminalPiMode(inst)
				if req.Coder == "pi" && ok && c.PiMode != "" && piMode != c.PiMode {
					continue
				}
				w.Header().Set("Content-Type", "application/json")
				payload := map[string]any{"pane_id": snapshot.ID, "session_id": snapshot.SessionID}
				if mode != "" {
					payload["opencode_mode"] = mode
				}
				if piMode != "" {
					payload["pi_mode"] = piMode
				}
				if piapp.ForCoder(snapshot.Coder) && piMode != "psi" {
					payload["pi_bridge"] = app.bridgeOrNil().PaneSnapshot(snapshot.ID)
				}
				_ = json.NewEncoder(w).Encode(payload)
				return
			}
		}
	}

	if !ok {
		http.Error(w, "Unknown coder type", http.StatusBadRequest)
		return
	}

	inst, err := app.spawnTerminal(r.Context(), c, req, app.loadConfig(), pty.SpawnOptions{}, false)
	if err != nil {
		status := http.StatusInternalServerError
		if launchErr, ok := err.(terminalLaunchError); ok {
			status = launchErr.status
		}
		http.Error(w, err.Error(), status)
		return
	}

	// A new pane may be the first live one in this cwd/worktree, so it
	// can widen the markdown watch set.
	if app.mdWatcher != nil {
		app.mdWatcher.Recompute()
	}

	w.Header().Set("Content-Type", "application/json")
	payload := map[string]any{"pane_id": inst.ID, "session_id": inst.Snapshot().SessionID}
	if c.OpenCodeMode != "" {
		payload["opencode_mode"] = c.OpenCodeMode
	}
	if c.PiMode != "" {
		payload["pi_mode"] = c.PiMode
	}
	if piapp.ForCoder(inst.Coder) && inst.PiMode != "psi" {
		payload["pi_bridge"] = app.bridgeOrNil().PaneSnapshot(inst.ID)
	}
	_ = json.NewEncoder(w).Encode(payload)
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

func (app *Server) handleGetWorktrees(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = app.activeCWD
	}

	wts, err := session.ListGitWorktrees(r.Context(), cwd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cfg := app.loadConfig()
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

func (app *Server) handleGetWorktreeDirtyStates(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = app.activeCWD
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

func (app *Server) handleWorktreeStateUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req WorktreeStateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := app.loadConfig()
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

	app.saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

// handleSystemCPU returns the current system-wide CPU percent (0.0–100.0)
// for the ambient CPU indicator in the UI header. Polled by the
// frontend every 10s, and only while its tab is visible with low power
// mode off; cheap enough to handle synchronously without caching.
// On sampling failure, returns 0.0 with HTTP 200 (the UI treats 0 as
// 'no data, leave indicator idle').
func (app *Server) handleSystemCPU(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()

	stats, err := app.cpu.Sample(ctx)
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

func (app *Server) handleGetClipboard(w http.ResponseWriter, r *http.Request) {
	// Resolve the clipboard source. When the frontend passes a ?pane=<id>
	// query parameter, we read from that specific PTY's session-isolated
	// shim file rather than the package-global shim path (which gets
	// overwritten on every new PTY and is ambiguous when multiple
	// sessions exist). When no pane is provided, fall back to legacy
	// behavior (system clipboard, or package-global shim if set).
	var shimPath string
	if pane := r.URL.Query().Get("pane"); pane != "" {
		if app.pty != nil {
			if inst, ok := app.pty.Get(pane); ok && inst != nil && inst.Pty != nil {
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

func (app *Server) handleGetSessionTranscript(w http.ResponseWriter, r *http.Request) {
	app.ensureCoderManager()
	coder := r.URL.Query().Get("coder")
	id := r.URL.Query().Get("id")
	cwd := r.URL.Query().Get("cwd")

	c, ok := app.coders.Get(coder)
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

// terminalProtocolVersion is the raw-replay terminal protocol version
// advertised in /api/version. v2 clients refuse servers that report a
// different version (or none); v1 clients are blocked by HTTP 426 on
// the pane socket and the retired recovery endpoints.
const terminalProtocolVersion = "2"

func (app *Server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"api":               "1",
		"version":           app.version,
		"commit":            app.commit,
		"date":              app.date,
		"build_source":      app.buildSource,
		"install_method":    update.DetectInstallMethod(app.buildSource),
		"started_at":        fmt.Sprintf("%d", app.startedAt),
		"terminal_protocol": terminalProtocolVersion,
	})
}

// buildCoderArgs was removed when handleSpawnTerminal started routing
// through coders.ResolveLaunch. The launch-resolver tests at
// pkg/coders/coders_test.go exercise the same argv-assembly logic
// without needing a PTY to spawn.
