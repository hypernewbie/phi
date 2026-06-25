package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/clipboard"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/system"
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
	inst.Title = req.Title
	inst.Workspace = req.Workspace

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

func appendUntrackedDiff(out []byte, fname string, content []byte, ansi bool) []byte {
	trimmed := strings.TrimRight(string(content), "\n")
	lines := []string{}
	if trimmed != "" {
		lines = strings.Split(trimmed, "\n")
	}
	lineCount := len(lines)

	header := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[1m" + s + "\x1b[0m"
	}
	oldFile := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[31m" + s + "\x1b[0m"
	}
	newFile := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[32m" + s + "\x1b[0m"
	}
	plusLine := func(s string) string {
		if !ansi {
			return s
		}
		return "\x1b[32m" + s + "\x1b[0m"
	}

	out = append(out, []byte(header(fmt.Sprintf("diff --git a/%s b/%s\n", fname, fname)))...)
	out = append(out, []byte("new file mode 100644\n")...)
	out = append(out, []byte(oldFile("--- /dev/null\n"))...)
	out = append(out, []byte(newFile(fmt.Sprintf("+++ b/%s\n", fname)))...)
	out = append(out, []byte(fmt.Sprintf("@@ -0,0 +1,%d @@\n", lineCount))...)
	for _, line := range lines {
		out = append(out, []byte(plusLine("+"+line+"\n"))...)
	}
	if len(lines) == 0 {
		out = append(out, []byte("\n")...)
	}
	return out
}

func handleRawDiff(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	commit := r.URL.Query().Get("commit")
	contextVal := r.URL.Query().Get("context")
	ansi := r.URL.Query().Get("ansi") == "1"
	if cwd == "" {
		cwd = activeCWD
	}

	contextLines := "3"
	if contextVal == "30" {
		contextLines = "30"
	}

	colorFlag := "--no-color"
	if ansi {
		colorFlag = "--color=always"
	}

	var cmd *exec.Cmd
	if commit == "staged" {
		cmd = exec.Command("git", "diff", "--cached", "-w", colorFlag, "-U"+contextLines)
	} else if commit == "" || commit == "unstaged" {
		cmd = exec.Command("git", "diff", "-w", colorFlag, "-U"+contextLines)
	} else {
		cmd = exec.Command("git", "show", "-w", colorFlag, "-U"+contextLines, commit)
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

	if commit == "" || commit == "unstaged" {
		statusCmd := exec.Command("git", "status", "--porcelain")
		statusCmd.Dir = cwd
		statusOut, _ := statusCmd.Output()
		for _, line := range strings.Split(strings.TrimSpace(string(statusOut)), "\n") {
			if !strings.HasPrefix(line, "?? ") {
				continue
			}
			fname := strings.TrimPrefix(line, "?? ")
			content, readErr := os.ReadFile(filepath.Join(cwd, fname))
			if readErr != nil {
				continue
			}
			if len(out) > 0 && out[len(out)-1] != '\n' {
				out = append(out, '\n')
			}
			out = appendUntrackedDiff(out, fname, content, ansi)
		}
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(out)
}

func handleRawStatus(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	cmd := exec.Command("git", "--no-pager", "-c", "color.status=always", "status", "--short", "--branch")
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
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
		"workspaces":                cfg.Workspaces,
		"active_cwd":                activeCWD,
		"theme_color":               cfg.ThemeColor,
		"hostname":                  hName,
		"model_presets":             cfg.ModelPresets,
		"quick_commands":            cfg.QuickCommands,
		"terminal_commands":         cfg.TerminalCommands,
		"markdown_dirs":             cfg.MarkdownDirs,
		"use_existing_terminal_tab": cfg.UseExistingTerminalTab,
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

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.QuickCommands = listReq
			saveConfig(cfg)
			w.WriteHeader(http.StatusOK)
			return
		}

		// Try parsing as a single quick command
		var singleReq struct {
			Name    string `json:"name"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, "Invalid payload format. Expected single command or list of commands.", http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}
		if singleReq.Command == "" {
			http.Error(w, "Missing command", http.StatusBadRequest)
			return
		}

		found := false
		for i, qc := range cfg.QuickCommands {
			if qc.Name == singleReq.Name {
				cfg.QuickCommands[i].Command = singleReq.Command
				found = true
				break
			}
		}
		if !found {
			cfg.QuickCommands = append(cfg.QuickCommands, QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		var singleReq struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}

		newCmds := []QuickCommand{}
		for _, qc := range cfg.QuickCommands {
			if qc.Name != singleReq.Name {
				newCmds = append(newCmds, qc)
			}
		}
		cfg.QuickCommands = newCmds
		saveConfig(cfg)
	}

	w.WriteHeader(http.StatusOK)
}

func handleTerminalCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()

	if r.Method == http.MethodPost {
		// Try parsing as slice/array first for bulk overwrite
		var listReq []QuickCommand
		if err := json.Unmarshal(bodyBytes, &listReq); err == nil {
			cfg.TerminalCommands = listReq
			saveConfig(cfg)
			w.WriteHeader(http.StatusOK)
			return
		}

		// Try parsing as a single quick command
		var singleReq struct {
			Name    string `json:"name"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, "Invalid payload format. Expected single command or list of commands.", http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}
		if singleReq.Command == "" {
			http.Error(w, "Missing command", http.StatusBadRequest)
			return
		}

		found := false
		for i, tc := range cfg.TerminalCommands {
			if tc.Name == singleReq.Name {
				cfg.TerminalCommands[i].Command = singleReq.Command
				found = true
				break
			}
		}
		if !found {
			cfg.TerminalCommands = append(cfg.TerminalCommands, QuickCommand{Name: singleReq.Name, Command: singleReq.Command})
		}
		saveConfig(cfg)
	} else if r.Method == http.MethodDelete {
		var singleReq struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(bodyBytes, &singleReq); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if singleReq.Name == "" {
			http.Error(w, "Missing name", http.StatusBadRequest)
			return
		}

		newCmds := []QuickCommand{}
		for _, tc := range cfg.TerminalCommands {
			if tc.Name != singleReq.Name {
				newCmds = append(newCmds, tc)
			}
		}
		cfg.TerminalCommands = newCmds
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

type MarkdownPasteRequest struct {
	Cwd       string `json:"cwd"`
	Dir       string `json:"dir"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	Overwrite bool   `json:"overwrite"`
}

type MarkdownDeleteRequest struct {
	Cwd  string `json:"cwd"`
	Path string `json:"path"`
}

type MarkdownCopyAllWorktreesRequest struct {
	Cwd  string `json:"cwd"`
	Dir  string `json:"dir"`
	Path string `json:"path"`
}

func markdownAllowedDirs(cwd string, cfg Config) ([]string, error) {
	var allowed []string
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(cwd, dir)
		}
		absDir, err := filepath.Abs(absDir)
		if err != nil {
			continue
		}
		allowed = append(allowed, absDir)
	}
	return allowed, nil
}

func markdownPathAllowed(absPath string, allowedDirs []string) bool {
	for _, absDir := range allowedDirs {
		if strings.HasPrefix(absPath, absDir+string(filepath.Separator)) || absPath == absDir {
			return true
		}
	}
	return false
}

func resolveMarkdownTargetDir(cwd string, dir string) (string, error) {
	absDir := dir
	if !filepath.IsAbs(dir) {
		absDir = filepath.Join(cwd, dir)
	}
	return filepath.Abs(absDir)
}

func normalizeMarkdownFilename(name string) string {
	name = strings.TrimSpace(name)
	name = filepath.Base(name)
	if !strings.HasSuffix(strings.ToLower(name), ".md") {
		name += ".md"
	}
	return name
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
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	absPath, err := filepath.Abs(path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(absPath, allowedDirs) {
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

func handleMarkdownPaste(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownPasteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	name := normalizeMarkdownFilename(req.Name)
	if name == "" || name == ".md" {
		http.Error(w, "Invalid filename", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	targetDir, err := resolveMarkdownTargetDir(cwd, req.Dir)
	if err != nil {
		http.Error(w, "Invalid target directory", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(targetDir, allowedDirs) && !markdownPathAllowed(targetDir+string(filepath.Separator), allowedDirs) {
		http.Error(w, "Target directory not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		http.Error(w, "Failed to create target directory: "+err.Error(), http.StatusInternalServerError)
		return
	}
	targetPath := filepath.Join(targetDir, name)
	if _, err := os.Stat(targetPath); err == nil && !req.Overwrite {
		http.Error(w, "File already exists", http.StatusConflict)
		return
	}
	if err := os.WriteFile(targetPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"path": targetPath, "name": name})
}

func handleMarkdownDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	absPath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if strings.ToLower(filepath.Ext(absPath)) != ".md" {
		http.Error(w, "Only .md files allowed", http.StatusForbidden)
		return
	}
	if !markdownPathAllowed(absPath, allowedDirs) {
		http.Error(w, "Path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	if err := os.Remove(absPath); err != nil {
		http.Error(w, "Failed to delete file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func handleMarkdownCopyAllWorktrees(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownCopyAllWorktreesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	if req.Dir == "" {
		http.Error(w, "Missing markdown dir", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	sourcePath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, "Invalid source path", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(sourcePath, allowedDirs) {
		http.Error(w, "Source path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		http.Error(w, "Failed to read source file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if filepath.IsAbs(req.Dir) {
		http.Error(w, "Copy to all worktrees requires a workspace-relative markdown dir", http.StatusBadRequest)
		return
	}
	wts, err := session.ListGitWorktrees(cwd)
	if err != nil {
		http.Error(w, "Failed to list worktrees: "+err.Error(), http.StatusInternalServerError)
		return
	}
	name := filepath.Base(sourcePath)
	copied := 0
	for _, wt := range wts {
		targetDir := filepath.Join(wt.Path, req.Dir)
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			continue
		}
		targetPath := filepath.Join(targetDir, name)
		if err := os.WriteFile(targetPath, content, 0644); err != nil {
			continue
		}
		copied++
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"copied": copied})
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

func handleUseExistingTerminalTab(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	cfg.UseExistingTerminalTab = req.Enabled
	saveConfig(cfg)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": cfg.UseExistingTerminalTab})
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

func handleGetWorktreeDirtyStates(w http.ResponseWriter, r *http.Request) {
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}

	wts, err := session.ListGitWorktrees(cwd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	paths := make([]string, 0, len(wts))
	for _, wt := range wts {
		paths = append(paths, wt.Path)
	}

	states := session.WorktreeDirtyStates(paths)
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
		ModelPresets     ModelPresetsMap `json:"model_presets"`
		QuickCommands    []QuickCommand  `json:"quick_commands"`
		TerminalCommands []QuickCommand  `json:"terminal_commands"`
	}{
		ModelPresets:     cfg.ModelPresets,
		QuickCommands:    cfg.QuickCommands,
		TerminalCommands: cfg.TerminalCommands,
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
		ModelPresets     ModelPresetsMap `json:"model_presets"`
		QuickCommands    []QuickCommand  `json:"quick_commands"`
		TerminalCommands []QuickCommand  `json:"terminal_commands"`
	}

	if err := json.Unmarshal(jsonData, &importedData); err != nil {
		http.Error(w, "Failed to parse configuration JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	cfg := loadConfig()
	if importedData.ModelPresets != nil {
		cfg.ModelPresets = importedData.ModelPresets
	}
	if len(importedData.QuickCommands) > 0 {
		cfg.QuickCommands = importedData.QuickCommands
	}
	if len(importedData.TerminalCommands) > 0 {
		cfg.TerminalCommands = importedData.TerminalCommands
	}

	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}
