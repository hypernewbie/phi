package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/clipboard"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
)

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
	http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
}

func handleGetCoders(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(coders.Registry)
}

func handleGetSessions(w http.ResponseWriter, r *http.Request) {
	coder := r.URL.Query().Get("coder")
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	var sessions []session.Session
	var err error

	switch coder {
	case "opencode":
		sessions, err = session.ListOpenCodeSessions(r.Context(), cwd)
	case "claude":
		sessions, err = session.ListClaudeSessions(cwd)
	case "pi":
		sessions, err = session.ListPiSessions(cwd)
	case "agy":
		sessions, err = session.ListAgySessions(cwd)
	case "bash":
		sessions = []session.Session{}
	default:
		http.Error(w, "Invalid coder", http.StatusBadRequest)
		return
	}

	if err != nil {
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

func getPreferredPowerShell() string {
	if _, err := exec.LookPath("pwsh"); err == nil {
		return "pwsh.exe"
	}
	return "powershell.exe"
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

	c, ok := coders.Registry[req.Coder]
	if !ok {
		http.Error(w, "Unknown coder type", http.StatusBadRequest)
		return
	}

	command := c.Command
	args := buildCoderArgs(req.Coder, c, req.SessionID, req.ExtraArgs, loadConfig().PiOffline)

	// On Unix, prefer the user's login shell ($SHELL) over hardcoded bash so that PATH
	// and aliases from the user's shell config (e.g. ~/.zshrc on macOS) are available.
	if req.Coder == "bash" && runtime.GOOS != "windows" {
		if shell := os.Getenv("SHELL"); shell != "" {
			if _, err := exec.LookPath(shell); err == nil {
				command = shell
			}
		}
	}

	// On Windows, if the requested shell is "bash", fall back to PowerShell
	// since "bash" is typically either absent or points to the WSL launcher in C:\Windows\System32
	// (which fails if Hyper-V or Virtual Machine Platform is disabled in BIOS).
	if req.Coder == "bash" && runtime.GOOS == "windows" {
		usePowerShell := true
		if lp, err := exec.LookPath("bash"); err == nil {
			// Git Bash or MSYS2 is safe, but System32/bash.exe is the WSL launcher.
			if !strings.Contains(strings.ToLower(lp), "system32") {
				usePowerShell = false
			}
		}
		if usePowerShell {
			command = getPreferredPowerShell()
			args = []string{"-NoLogo"}
		}
	}

	// On Windows, wrap all coder executions in PowerShell/pwsh to resolve npm/script path wrappers cleanly
	if req.Coder != "bash" && req.Coder != "pwsh" && runtime.GOOS == "windows" {
		shellCmd := getPreferredPowerShell()

		// Use PowerShell's call operator (&) with individually single-quoted arguments.
		// Single quotes in PowerShell are literal (no variable expansion or backtick escaping).
		// Any embedded single quotes are escaped by doubling them (' -> '').
		var parts []string
		parts = append(parts, fmt.Sprintf("& '%s'", strings.ReplaceAll(command, "'", "''")))
		for _, a := range args {
			parts = append(parts, fmt.Sprintf("'%s'", strings.ReplaceAll(a, "'", "''")))
		}

		command = shellCmd
		args = []string{"-NoLogo", "-Command", strings.Join(parts, " ")}
	}

	spawnDir := req.Cwd
	if spawnDir == "" {
		spawnDir = activeCWD
	}

	inst, err := ptyManager.Spawn(r.Context(), spawnDir, command, args, req.Coder, req.SessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	inst.Title = req.Title
	inst.Workspace = req.Workspace

	if req.Coder == "agy" && req.SessionID != "" {
		_ = session.SaveAgySessionCwd(req.SessionID, spawnDir)
	}

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
	coder := r.URL.Query().Get("coder")
	id := r.URL.Query().Get("id")
	cwd := r.URL.Query().Get("cwd")

	var messages []session.Message
	var err error

	switch coder {
	case "opencode":
		messages, err = session.GetOpenCodeSessionTranscript(r.Context(), id)
	case "pi":
		messages, err = session.GetPiSessionTranscript(cwd, id)
	default:
		http.Error(w, "Unsupported coder type", http.StatusBadRequest)
		return
	}

	if err != nil {
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

// buildCoderArgs assembles the argv for a coder spawn: the registry's base
// args, an optional session resume, the pi --offline opt-in, then any
// caller-supplied extras.
//
// Split out of handleCreateTerminal so it is reachable from tests without
// spawning a real PTY. Keep it that way -- a test that re-implements this
// logic instead of calling it would pass while the handler was broken.
func buildCoderArgs(coderID string, c coders.Coder, sessionID string, extra []string, piOffline bool) []string {
	// Copy rather than append onto the registry's slice: coders.Registry is
	// process-wide shared state, and appending to c.Args could write into a
	// backing array other spawns read. It is len 0 today so append always
	// reallocates, but that is a property of the registry literal, not a
	// guarantee it will keep.
	args := append([]string(nil), c.Args...)

	if sessionID != "" && c.ResumeArg != "" {
		args = append(args, c.ResumeArg, sessionID)
	}

	// pi's --offline skips its startup network calls. Opt-in via config so an
	// airgapped or metered host can avoid them. Scoped to pi: the flag is
	// pi's own and other coders would reject it.
	if coderID == "pi" && piOffline {
		args = append(args, "--offline")
	}

	return append(args, extra...)
}
