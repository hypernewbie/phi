package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

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

	Version     = "dev"
	Commit      = "none"
	Date        = "unknown"
	BuildSource = "source"
)

func main() {
	enableVirtualTerminalProcessing()
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	ipFlag := flag.String("ip", "0.0.0.0", "IP address to bind the Go web server to")
	versionFlag := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Printf("Phi %s (commit: %s, built: %s, source: %s)\n", Version, Commit, Date, BuildSource)
		os.Exit(0)
	}

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
	ptyManager.StartIdleWatcher(func(info pty.IdleNotification) {
		cfg := loadConfig()
		host, _ := os.Hostname()
		if host == "" {
			host = "localhost"
		}

		projName := filepath.Base(info.Workspace)
		if projName == "." || projName == "" || projName == "/" || projName == "\\" {
			if info.Cwd != "" {
				projName = filepath.Base(info.Cwd)
			} else {
				projName = "phi"
			}
		}

		colorEmoji := themeEmoji(cfg.ThemeColor)
		durationStr := info.Duration.Truncate(time.Second).String()

		notifTitle := fmt.Sprintf("[%s] %s @ %s %s", info.Coder, projName, host, colorEmoji)
		notifMsg := fmt.Sprintf("⚡ Task Finished (took %s)\n🤖 Session: %s\n📁 Project: %s\n💻 Host: %s",
			durationStr, info.Title, projName, host)

		if cfg.PushoverEnabled && cfg.PushoverUserKey != "" && cfg.PushoverAppToken != "" {
			_ = sendPushoverNotification(cfg.PushoverUserKey, cfg.PushoverAppToken, notifTitle, notifMsg)
		}
		if cfg.WebhookEnabled && cfg.WebhookURL != "" {
			_ = sendWebhookNotification(cfg.WebhookURL, notifTitle, notifMsg)
		}
		if cfg.SimplepushEnabled && cfg.SimplepushKey != "" {
			_ = sendSimplepushNotification(cfg.SimplepushKey, notifTitle, notifMsg, "phi_idle")
		}
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
	http.HandleFunc("/api/config/pushover", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleGetPushoverConfig(w, r)
		} else if r.Method == http.MethodPost {
			handlePostPushoverConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/pushover/test", handleTestPushover)
	http.HandleFunc("/api/config/webhook", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleGetWebhookConfig(w, r)
		} else if r.Method == http.MethodPost {
			handlePostWebhookConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/webhook/test", handleTestWebhook)
	http.HandleFunc("/api/config/simplepush", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleGetSimplepushConfig(w, r)
		} else if r.Method == http.MethodPost {
			handlePostSimplepushConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/simplepush/test", handleTestSimplepush)
	http.HandleFunc("/api/config/kanban-vault", handleKanbanVault)
	http.HandleFunc("/api/config/export", handleConfigExport)
	http.HandleFunc("/api/config/import", handleConfigImport)
	http.HandleFunc("/api/config/export-models", handleConfigExportModels)
	http.HandleFunc("/api/config/import-models", handleConfigImportModels)
	// Cmds export was split in v0.7.16: quick_commands (sent to active PTY)
	// and terminal_commands (spawn new shell tabs) are now separate concepts
	// with their own endpoints. The legacy /api/config/export-cmds route is
	// gone; /api/config/import-cmds stays for paste backwards-compat.
	http.HandleFunc("/api/config/export-quick-commands", handleConfigExportQuickCommands)
	http.HandleFunc("/api/config/export-terminal-commands", handleConfigExportTerminalCommands)
	http.HandleFunc("/api/config/import-cmds", handleConfigImportCmds)
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
	http.HandleFunc("/api/sync/messages/", handleSyncMessages)
	http.HandleFunc("/api/sync/messages", handleSyncMessages)
	http.HandleFunc("/api/config/sync-coordinator", handleSyncCoordinator)

	http.HandleFunc("/api/version", handleGetVersion)

	// Custom route for DELETE /api/terminals/:id and WS /ws/pane/:id
	http.HandleFunc("/", handleFallback)

	addr := fmt.Sprintf("%s:%d", *ipFlag, *portFlag)
	printWelcomeBanner(cfg, *ipFlag, *portFlag)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func printWelcomeBanner(cfg Config, ip string, port int) {
	// NOTE: When adding a new theme color, you must update:
	// 1. web/app.js: Add properties in ACCENT_COLORS
	// 2. web/index.html: Add <option> in #accent-color-select
	// 3. main.go: Add entry in printWelcomeBanner colors map
	// 4. bonus/: Add matching theme profiles to bonus/vim_themes/, bonus/pi_themes/, bonus/opencode_themes/, and bonus/btop_themes/
	colors := map[string][]int{
		"purple": {124, 106, 247},
		"blue":   {56, 189, 248},
		"green":  {16, 185, 129},
		"amber":  {251, 191, 36},
		"red":    {248, 113, 113},
		"pink":   {236, 72, 153},
		"teal":   {20, 184, 166},
		"indigo": {99, 102, 241},
		"orange": {249, 115, 22},
		"cyan":   {6, 182, 212},
		"rose":   {244, 63, 94},
		"lime":   {132, 204, 22},
		"white":  {255, 255, 255},
		"gold":   {212, 175, 55},
	}

	rgb, ok := colors[cfg.ThemeColor]
	if !ok {
		rgb = colors["purple"]
	}

	colorEsc := fmt.Sprintf("\x1b[38;2;%d;%d;%dm", rgb[0], rgb[1], rgb[2])
	resetEsc := "\x1b[0m"
	boldEsc := "\x1b[1m"
	dimEsc := "\x1b[2m"

	fmt.Printf("\n")
	fmt.Printf("%s    ____  __     _%s\n", colorEsc, resetEsc)
	fmt.Printf("%s   / __ \\/ /_   (_)%s\n", colorEsc, resetEsc)
	fmt.Printf("%s  / /_/ / /__ \\  /%s\n", colorEsc, resetEsc)
	fmt.Printf("%s / ____/ / / // /%s\n", colorEsc, resetEsc)
	fmt.Printf("%s/_/   /_/ /_//_/%s   %sControl Center for AI Coding%s\n\n", colorEsc, resetEsc, boldEsc, resetEsc)

	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}

	fmt.Printf("%s── Status Dump ──────────────────────────────────────────%s\n", dimEsc, resetEsc)
	fmt.Printf("  %sCWD:%s          %s\n", colorEsc, resetEsc, activeCWD)
	fmt.Printf("  %sWorkspaces:%s   %d active\n", colorEsc, resetEsc, len(cfg.Workspaces))
	fmt.Printf("  %sHostname:%s     %s\n", colorEsc, resetEsc, strings.ToUpper(host))
	fmt.Printf("  %sCoordinator:%s  %s\n", colorEsc, resetEsc, cfg.SyncCoordinator)
	fmt.Printf("  %sBound IP:%s     %s\n", colorEsc, resetEsc, ip)
	fmt.Printf("  %sPort:%s         %d\n", colorEsc, resetEsc, port)
	fmt.Printf("  %sTheme:%s        %s\n", colorEsc, resetEsc, cfg.ThemeColor)
	fmt.Printf("%s────────────────────────────────────────────────────────%s\n\n", dimEsc, resetEsc)

	fmt.Printf("  Server running on: %shttp://%s:%d%s\n", boldEsc, ip, port, resetEsc)
	if ip == "0.0.0.0" {
		fmt.Printf("  Or locally:        %shttp://localhost:%d%s\n", boldEsc, port, resetEsc)
	}
	fmt.Printf("\n")
}
