package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/ws"
)

//go:embed all:web
var webFS embed.FS

var (
	ptyManager *pty.Manager
	wsHub      *ws.Hub
	cpuSampler = system.NewSampler()
	activeCWD  string
	webRoot    fs.FS
)



func main() {
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	ipFlag := flag.String("ip", "0.0.0.0", "IP address to bind the Go web server to")
	flag.Parse()

	// The directory Phi is launched from becomes the default workspace.
	// Switch between projects from the workspace picker in the UI.
	var err error
	activeCWD, err = os.Getwd()
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
	ptyManager.StartIdleWatcher(func(paneID, title, coder string) {
		cfg, err := loadConfig()
		if err != nil || !cfg.NtfyEnabled || cfg.NtfyTopic == "" {
			return
		}
		msg := fmt.Sprintf("Session \"%s\" (%s) finished", title, coder)
		req, _ := http.NewRequest("POST", "https://ntfy.sh/"+cfg.NtfyTopic, strings.NewReader(msg))
		req.Header.Set("Title", "Phi")
		req.Header.Set("Tags", "white_check_mark")
		_, _ = http.DefaultClient.Do(req)
	})
	wsHub = ws.NewHub()

	// Embedded web assets (served when running an installed binary from any dir)
	var subErr error
	webRoot, subErr = fs.Sub(webFS, "web")
	if subErr != nil {
		log.Fatalf("Failed to load embedded web assets: %v", subErr)
	}

	// API Routing
	http.HandleFunc("/api/coders", handleGetCoders)
	http.HandleFunc("/api/sessions", handleGetSessions)
	http.HandleFunc("/api/terminals", handleSpawnTerminal)
	http.HandleFunc("/api/session-meta", handleSessionMeta)
	http.HandleFunc("/api/diff", handleGetDiff)
	http.HandleFunc("/api/git/raw-diff", handleRawDiff)
	http.HandleFunc("/api/git/raw-status", handleRawStatus)
	http.HandleFunc("/api/git/commits", handleGetCommits)
	http.HandleFunc("/api/config", handleConfig)
	http.HandleFunc("/api/config/ntfy", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleGetNtfyConfig(w, r)
		} else if r.Method == http.MethodPost {
			handlePostNtfyConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/ntfy/test", handleTestNtfy)
	http.HandleFunc("/api/config/export", handleConfigExport)
	http.HandleFunc("/api/config/import", handleConfigImport)
	http.HandleFunc("/api/config/export-models", handleConfigExportModels)
	http.HandleFunc("/api/config/import-models", handleConfigImportModels)
	http.HandleFunc("/api/config/workspaces", handleWorkspaceToggle)
	http.HandleFunc("/api/config/models", handleModelPresets)
	http.HandleFunc("/api/fs/autocomplete", handleFSAutocomplete)
	http.HandleFunc("/api/config/theme", handleThemeUpdate)
	http.HandleFunc("/api/git/worktrees", handleGetWorktrees)
	http.HandleFunc("/api/git/worktree-dirty", handleGetWorktreeDirtyStates)
	http.HandleFunc("/api/config/worktree-state", handleWorktreeStateUpdate)
	http.HandleFunc("/api/config/quick-commands", handleQuickCommands)
	http.HandleFunc("/api/config/terminal-commands", handleTerminalCommands)
	http.HandleFunc("/api/config/markdown-dirs", handleMarkdownDirs)
	http.HandleFunc("/api/config/use-existing-terminal-tab", handleUseExistingTerminalTab)
	http.HandleFunc("/api/markdown/files", handleMarkdownFiles)
	http.HandleFunc("/api/markdown/file", handleMarkdownFile)
	http.HandleFunc("/api/markdown/paste", handleMarkdownPaste)
	http.HandleFunc("/api/markdown/delete", handleMarkdownDelete)
	http.HandleFunc("/api/markdown/copy-all-worktrees", handleMarkdownCopyAllWorktrees)
	http.HandleFunc("/api/clipboard", handleGetClipboard)
	http.HandleFunc("/api/system/cpu", handleSystemCPU)
	http.HandleFunc("/api/session-transcript", handleGetSessionTranscript)
	http.HandleFunc("/api/proxy", handleProxy)

	// Custom route for DELETE /api/terminals/:id and WS /ws/pane/:id
	http.HandleFunc("/", handleFallback)

	addr := fmt.Sprintf("%s:%d", *ipFlag, *portFlag)
	log.Printf("[main] Server running on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

