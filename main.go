package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/diff"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/ws"
)

//go:embed all:web
var webFS embed.FS

var (
	ptyManager *pty.Manager
	wsHub      *ws.Hub
	activeCWD  string
)

type Config struct {
	Workspaces        []string          `json:"workspaces"`
	ThemeColor        string            `json:"theme_color"`
	ExpandedWorktrees map[string]bool   `json:"expanded_worktrees"`
	ActiveWorktrees   map[string]string `json:"active_worktrees"`
}

func expandHome(path string) string {
	if len(path) > 0 && path[0] == '~' {
		home, err := os.UserHomeDir()
		if err == nil {
			return home + path[1:]
		}
	}
	return path
}

func loadConfig() Config {
	path := expandHome("~/.phi/config.json")
	var cfg Config
	b, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	if cfg.Workspaces == nil {
		cfg.Workspaces = []string{}
	}
	if cfg.ThemeColor == "" {
		cfg.ThemeColor = "purple"
	}
	if cfg.ExpandedWorktrees == nil {
		cfg.ExpandedWorktrees = make(map[string]bool)
	}
	if cfg.ActiveWorktrees == nil {
		cfg.ActiveWorktrees = make(map[string]string)
	}
	return cfg
}

func saveConfig(cfg Config) {
	path := expandHome("~/.phi/config.json")
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	b, _ := json.MarshalIndent(cfg, "", "  ")
	_ = os.WriteFile(path, b, 0644)
}

func main() {
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	cwdFlag := flag.String("cwd", "", "Active project workspace directory")
	flag.Parse()

	// Resolve CWD
	var err error
	if *cwdFlag != "" {
		activeCWD, err = filepath.Abs(expandHome(*cwdFlag))
	} else {
		activeCWD, err = os.Getwd()
	}
	if err != nil {
		log.Fatalf("Failed to resolve current working directory: %v", err)
	}

	log.Printf("[main] Starting Phi in CWD: %s", activeCWD)

	// Ensure config directory exists and contains CWD as a workspace
	cfg := loadConfig()
	found := false
	for _, wsPath := range cfg.Workspaces {
		if wsPath == activeCWD {
			found = true
			break
		}
	}
	if !found {
		cfg.Workspaces = append(cfg.Workspaces, activeCWD)
		saveConfig(cfg)
	}

	// Initialize PTY and WebSocket subsystems
	ptyManager = pty.NewManager()
	wsHub = ws.NewHub()

	// Embedded web assets (served when running an installed binary from any dir)
	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("Failed to load embedded web assets: %v", err)
	}

	// API Routing
	http.HandleFunc("/api/coders", handleGetCoders)
	http.HandleFunc("/api/sessions", handleGetSessions)
	http.HandleFunc("/api/terminals", handleSpawnTerminal)
	http.HandleFunc("/api/session-meta", handleSessionMeta)
	http.HandleFunc("/api/diff", handleGetDiff)
	http.HandleFunc("/api/config", handleConfig)
	http.HandleFunc("/api/config/workspaces", handleWorkspaceToggle)
	http.HandleFunc("/api/fs/autocomplete", handleFSAutocomplete)
	http.HandleFunc("/api/config/theme", handleThemeUpdate)
	http.HandleFunc("/api/git/worktrees", handleGetWorktrees)
	http.HandleFunc("/api/config/worktree-state", handleWorktreeStateUpdate)

	// Custom route for DELETE /api/terminals/:id and WS /ws/pane/:id
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Log requests briefly
		log.Printf("[http] %s %s", r.Method, r.URL.Path)

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

		// Fallback to static file server (embedded web assets)
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
	})

	addr := fmt.Sprintf("0.0.0.0:%d", *portFlag)
	log.Printf("[main] Server running on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
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

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(sessions)
}

type SpawnRequest struct {
	Coder     string `json:"coder"`
	Cwd       string `json:"cwd"`
	SessionID string `json:"session_id"`
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

	var args []string
	if req.SessionID != "" && c.ResumeArg != "" {
		args = append(c.Args, c.ResumeArg, req.SessionID)
	} else {
		args = c.Args
	}

	spawnDir := req.Cwd
	if spawnDir == "" {
		spawnDir = activeCWD
	}

	inst, err := ptyManager.Spawn(spawnDir, c.Command, args, req.Coder, req.SessionID)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to spawn PTY: %v", err), http.StatusInternalServerError)
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
	if cwd == "" {
		cwd = activeCWD
	}

	var inst *pty.PTYInstance
	var err error

	if diffType == "log" {
		inst, err = diff.SpawnLog(cwd, ptyManager)
	} else {
		inst, err = diff.SpawnDiff(cwd, ptyManager)
	}

	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to spawn git PTY: %v", err), http.StatusInternalServerError)
		return
	}

	ws.StartPTYReadLoop(inst, wsHub)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pane_id": inst.ID,
	})
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	cfg := loadConfig()
	hName, _ := os.Hostname()
	hName = strings.ToUpper(hName)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"workspaces":  cfg.Workspaces,
		"active_cwd":  activeCWD,
		"theme_color": cfg.ThemeColor,
		"hostname":    hName,
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
