package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"os/exec"
	"runtime"
	"sort"
	"strings"

	"github.com/hypernewbie/phi/pkg/clipboard"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/diff"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
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
		sessions, err = session.ListOpenCodeSessions(cwd)
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
}

func handleSpawnTerminal(w http.ResponseWriter, r *http.Request) {
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
	var args []string
	if req.SessionID != "" && c.ResumeArg != "" {
		args = append(c.Args, c.ResumeArg, req.SessionID)
	} else {
		args = c.Args
	}
	args = append(args, req.ExtraArgs...)

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
		
		var fullCmd string
		if len(args) > 0 {
			var escaped []string
			for _, a := range args {
				if strings.Contains(a, " ") {
					escaped = append(escaped, fmt.Sprintf(`"%s"`, a))
				} else {
					escaped = append(escaped, a)
				}
			}
			fullCmd = fmt.Sprintf("%s %s", command, strings.Join(escaped, " "))
		} else {
			fullCmd = command
		}
		
		command = shellCmd
		args = []string{"-NoLogo", "-Command", fullCmd}
	}

	spawnDir := req.Cwd
	if spawnDir == "" {
		spawnDir = activeCWD
	}

	inst, err := ptyManager.Spawn(spawnDir, command, args, req.Coder, req.SessionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if req.Coder == "agy" && req.SessionID != "" {
		_ = session.SaveAgySessionCwd(req.SessionID, spawnDir)
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

func handleGetDiff(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	diffType := r.URL.Query().Get("type")
	commit := r.URL.Query().Get("commit")
	if cwd == "" {
		cwd = activeCWD
	}

	var inst *pty.PTYInstance
	var err error

	if diffType == "log" {
		inst, err = diff.SpawnLog(cwd, ptyManager)
	} else if diffType == "status" {
		inst, err = diff.SpawnStatus(cwd, ptyManager)
	} else {
		inst, err = diff.SpawnDiff(cwd, commit, ptyManager)
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	ws.StartPTYReadLoop(inst, wsHub)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pane_id": inst.ID,
	})
}

func handleRawDiff(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	commit := r.URL.Query().Get("commit")
	contextVal := r.URL.Query().Get("context")
	if cwd == "" {
		cwd = activeCWD
	}

	// Validate context parameter to prevent arbitrary flags
	contextLines := "3"
	if contextVal == "30" {
		contextLines = "30"
	}

	var cmd *exec.Cmd
	if commit == "" || commit == "unstaged" {
		cmd = exec.Command("git", "diff", "-w", "--no-color", "-U"+contextLines)
	} else {
		cmd = exec.Command("git", "show", "-w", "--no-color", "-U"+contextLines, commit)
	}
	cmd.Dir = cwd

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			http.Error(w, fmt.Sprintf("Git error: %s", string(exitErr.Stderr)), http.StatusInternalServerError)
			return
		}
		http.Error(w, fmt.Sprintf("Git error: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(out)
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	hName, _ := os.Hostname()
	hName = strings.ToUpper(hName)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"workspaces":     cfg.Workspaces,
		"active_cwd":     activeCWD,
		"theme_color":    cfg.ThemeColor,
		"hostname":       hName,
		"model_presets":  cfg.ModelPresets,
		"quick_commands": cfg.QuickCommands,
		"markdown_dirs":  cfg.MarkdownDirs,
	})
}

func handleWorkspaceToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	path := expandHome(req["path"])
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		found := false
		for _, wsPath := range cfg.Workspaces {
			if wsPath == path {
				found = true
				break
			}
		}
		if !found {
			cfg.Workspaces = append(cfg.Workspaces, path)
			saveConfig(cfg)
		}
	} else if r.Method == http.MethodDelete {
		newWS := []string{}
		for _, wsPath := range cfg.Workspaces {
			if wsPath != path {
				newWS = append(newWS, wsPath)
			}
		}
		cfg.Workspaces = newWS
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleModelPresets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	model := strings.TrimSpace(req["model"])
	coder := strings.TrimSpace(req["coder"])
	if model == "" {
		http.Error(w, "Missing model", http.StatusBadRequest)
		return
	}
	if coder == "" {
		coder = "pi"
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		if cfg.ModelPresets == nil {
			cfg.ModelPresets = make(ModelPresetsMap)
		}
		found := false
		for _, m := range cfg.ModelPresets[coder] {
			if m == model {
				found = true
				break
			}
		}
		if !found {
			cfg.ModelPresets[coder] = append(cfg.ModelPresets[coder], model)
			saveConfig(cfg)
		}
	} else if r.Method == http.MethodDelete {
		if cfg.ModelPresets != nil {
			newPresets := []string{}
			for _, m := range cfg.ModelPresets[coder] {
				if m != model {
					newPresets = append(newPresets, m)
				}
			}
			cfg.ModelPresets[coder] = newPresets
			saveConfig(cfg)
		}
	}

	w.WriteHeader(http.StatusOK)
}

func handleQuickCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name    string `json:"name"`
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "Missing name", http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		if req.Command == "" {
			http.Error(w, "Missing command", http.StatusBadRequest)
			return
		}
		found := false
		for i, qc := range cfg.QuickCommands {
			if qc.Name == req.Name {
				cfg.QuickCommands[i].Command = req.Command
				found = true
				break
			}
		}
		if !found {
			cfg.QuickCommands = append(cfg.QuickCommands, QuickCommand{Name: req.Name, Command: req.Command})
		}
		saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		newCmds := []QuickCommand{}
		for _, qc := range cfg.QuickCommands {
			if qc.Name != req.Name {
				newCmds = append(newCmds, qc)
			}
		}
		cfg.QuickCommands = newCmds
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleMarkdownDirs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	dir := req["dir"]
	if dir == "" {
		http.Error(w, "Missing dir", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	if r.Method == http.MethodPost {
		for _, d := range cfg.MarkdownDirs {
			if d == dir {
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		cfg.MarkdownDirs = append(cfg.MarkdownDirs, dir)
	} else {
		newDirs := []string{}
		for _, d := range cfg.MarkdownDirs {
			if d != dir {
				newDirs = append(newDirs, d)
			}
		}
		cfg.MarkdownDirs = newDirs
	}
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

type MDFileEntry struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Dir  string `json:"dir"`
}

func handleMarkdownFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	files := []MDFileEntry{}
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(cwd, dir)
		}
		entries, err := os.ReadDir(absDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
				continue
			}
			files = append(files, MDFileEntry{
				Path: filepath.Join(absDir, entry.Name()),
				Name: entry.Name(),
				Dir:  dir,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(files)
}

func handleMarkdownFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}
	if strings.ToLower(filepath.Ext(path)) != ".md" {
		http.Error(w, "Only .md files allowed", http.StatusForbidden)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	absPath, err := filepath.Abs(path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	allowed := false
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(cwd, dir)
		}
		absDir, _ = filepath.Abs(absDir)
		if strings.HasPrefix(absPath, absDir+string(filepath.Separator)) || absPath == absDir {
			allowed = true
			break
		}
	}
	if !allowed {
		http.Error(w, "Path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	content, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
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

func handleThemeUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	color := req["color"]
	if color == "" {
		http.Error(w, "Missing color", http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	cfg.ThemeColor = color
	saveConfig(cfg)

	w.WriteHeader(http.StatusOK)
}

func handleGetWorktrees(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	wts, err := session.ListGitWorktrees(cwd)
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

func handleGetClipboard(w http.ResponseWriter, r *http.Request) {
	text, err := clipboard.Read()
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to read remote clipboard: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"text": text,
	})
}

func handleGetSessionTranscript(w http.ResponseWriter, r *http.Request) {
	coder := r.URL.Query().Get("coder")
	id := r.URL.Query().Get("id")
	cwd := r.URL.Query().Get("cwd")

	var messages []session.Message
	var err error

	switch coder {
	case "opencode":
		messages, err = session.GetOpenCodeSessionTranscript(id)
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

type CommitEntry struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
}

func handleGetCommits(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	// Run git log to fetch the last 10 commits on active branch
	cmd := exec.Command("git", "log", "-10", "--format=%h|%s")
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]CommitEntry{})
		return
	}

	var commits []CommitEntry
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) == 2 {
			commits = append(commits, CommitEntry{
				Hash:    parts[0],
				Subject: parts[1],
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(commits)
}

func handleConfigExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cfg := loadConfig()
	exportData := struct {
		ThemeColor    string          `json:"theme_color"`
		ModelPresets  ModelPresetsMap `json:"model_presets"`
		QuickCommands []QuickCommand  `json:"quick_commands"`
	}{
		ThemeColor:    cfg.ThemeColor,
		ModelPresets:  cfg.ModelPresets,
		QuickCommands: cfg.QuickCommands,
	}

	jsonData, err := json.Marshal(exportData)
	if err != nil {
		http.Error(w, "Failed to serialize export data: "+err.Error(), http.StatusInternalServerError)
		return
	}

	b64Payload := base64.StdEncoding.EncodeToString(jsonData)
	
	const salt = "phi_super_secret_salt_2026"
	hasher := sha256.New()
	hasher.Write([]byte(b64Payload + salt))
	hashHex := hex.EncodeToString(hasher.Sum(nil))

	formatted := fmt.Sprintf("PHICONFIG:%s:%s", hashHex, b64Payload)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"config": formatted,
	})
}

func handleConfigImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Config string `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	raw := strings.TrimSpace(req.Config)
	if !strings.HasPrefix(raw, "PHICONFIG:") {
		http.Error(w, "Invalid configuration format (missing sentinel)", http.StatusBadRequest)
		return
	}

	parts := strings.Split(raw, ":")
	if len(parts) != 3 {
		http.Error(w, "Malformed configuration string", http.StatusBadRequest)
		return
	}

	hashHex := parts[1]
	b64Payload := parts[2]

	const salt = "phi_super_secret_salt_2026"
	hasher := sha256.New()
	hasher.Write([]byte(b64Payload + salt))
	expectedHash := hex.EncodeToString(hasher.Sum(nil))

	if hashHex != expectedHash {
		http.Error(w, "Configuration signature verification failed (corrupted or altered data)", http.StatusBadRequest)
		return
	}

	jsonData, err := base64.StdEncoding.DecodeString(b64Payload)
	if err != nil {
		http.Error(w, "Failed to decode configuration payload", http.StatusBadRequest)
		return
	}

	var importedData struct {
		ThemeColor    string          `json:"theme_color"`
		ModelPresets  ModelPresetsMap `json:"model_presets"`
		QuickCommands []QuickCommand  `json:"quick_commands"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if importedData.ThemeColor != "" {
		cfg.ThemeColor = importedData.ThemeColor
	}
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}
	if len(importedData.QuickCommands) > 0 {
		cfg.QuickCommands = importedData.QuickCommands
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
