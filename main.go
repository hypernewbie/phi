package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/fleet"
	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/prompt_history"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/restart"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
)

//go:embed all:web
var webFS embed.FS

var (
	ptyManager  *pty.Manager
	wsHub       *ws.Hub
	mdWatcher   *fswatch.Watcher
	cpuSampler  = system.NewSampler()
	activeCWD   string
	webRoot     fs.FS
	fleetPoller = fleet.NewPoller()

	Version     = "dev"
	Commit      = "none"
	Date        = "unknown"
	BuildSource = "source"

	// shuttingDown flips true on SIGTERM/SIGINT (or a programmatic trigger)
	// so /readyz returns 503 and the load balancer drains us. Set inside
	// gracefulShutdown, NOT inside the signal handler directly, so the
	// /readyz 503 stays in lockstep with the actual drain starting.
	shuttingDown atomic.Bool

	// StartedAt is the unix-second timestamp of server startup. Returned
	// in /api/version so the front-end can detect a server restart
	// (the value jumps forward when the user restarts phi) and clear
	// localStorage references to tabs that no longer exist.
	StartedAt = time.Now().Unix()
)

func main() {
	enableVirtualTerminalProcessing()
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	ipFlag := flag.String("ip", "lan", `IP to bind. "lan" (default) binds loopback + every LAN (RFC 1918) + Tailscale (100.64/10) interface on the host. Use 0.0.0.0 to expose on every interface (public internet reachable), or an explicit IP to bind just one address.`)
	versionFlag := flag.Bool("version", false, "Print version and exit")
	rollbackFlag := flag.Bool("rollback", false, "Roll back to the previously installed binary (undoes the last self-update) and exit")
	logLevelFlag := flag.String("log-level", "", "Log level: debug|info|warn|error (default: info, or PHI_LOG env var)")
	// Registered unconditionally (not behind //go:build otel) so a default
	// build parses identical args — it just never has anywhere to send the
	// endpoint. obs.Init's body is the only tag-split part (plan §B).
	otelEndpointFlag := flag.String("otel-endpoint", "", "OTLP/gRPC collector endpoint for OpenTelemetry export (host:port). Only takes effect in a binary built with -tags otel. Falls back to PHI_OTEL_ENDPOINT.")
	flag.Parse()

	initLogging(*logLevelFlag)

	otelEndpoint := *otelEndpointFlag
	if otelEndpoint == "" {
		otelEndpoint = os.Getenv("PHI_OTEL_ENDPOINT")
	}
	obsShutdown, obsErr := obs.Init(context.Background(), otelEndpoint)
	if obsErr != nil {
		log.Printf("[main] obs.Init: %v", obsErr)
	}

	if *versionFlag {
		fmt.Printf("Phi %s (commit: %s, built: %s, source: %s)\n", Version, Commit, Date, BuildSource)
		os.Exit(0)
	}

	if *rollbackFlag {
		restored, err := update.Rollback()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Rollback failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Rolled back to previous binary: %s\nRestart phi normally to run it.\n", restored)
		os.Exit(0)
	}

	// The directory Phi is launched from becomes the default workspace.
	// Switch between projects from the workspace picker in the UI.
	var err error
	activeCWD, err = os.Getwd()
	if err != nil {
		slog.Error("failed to resolve current working directory", "err", err)
		os.Exit(1)
	}

	log.Printf("[main] Starting Phi in CWD: %s", activeCWD)

	// Ensure config directory exists and contains CWD as a workspace
	cfg := loadConfig()
	if err := accessAuth.configure(cfg.AccessPasswordHash); err != nil {
		slog.Error("invalid access password configuration", "err", err)
		os.Exit(1)
	}
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
	// Do NOT call LoadState() here. tabs.json holds PTYInstance
	// metadata for tabs the server was managing in its previous life,
	// but in this codebase the underlying PTY process is always a
	// child of the Go process — it dies with us. So loading tabs.json
	// resurrects entries with Pty == nil: terminal-shaped zombies
	// that the front-end renders as closed-but-not-closable black
	// boxes after a server restart. Users have to click X on each.
	// Just start with an empty Manager. tabs.json continues to be
	// written during this session (pin/mark tracking) so any future
	// revival mechanism (tmux-backed, out-of-process, etc.) has the
	// metadata to work with.
	if err := LoadSyncStore(); err != nil {
		log.Printf("[sync] Failed to load sync store state: %v", err)
	}
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
	wsHub = ws.NewHub(*cfg.ReplayBufferBytes)

	// Markdown watcher: fswatch over the resolved markdownDirs of every
	// live pane cwd. Fires 0x07 md-changed so open UIs can silently
	// refresh the md file list. Watch set follows panes, not browsers:
	// a worktree nobody has a pane in is not covered (accepted edge).
	mdWatcher, err = fswatch.New(markdownWatchDirs, func(dir string) {
		payload, _ := json.Marshal(map[string]string{"dir": dir})
		wsHub.BroadcastAll(0x07, payload) // 0x07: md-changed
	})
	if err != nil {
		slog.Warn("fswatch unavailable; markdown panel won't live-update", "err", err)
	} else {
		mdWatcher.Filter = fswatch.ExtFilter(".md")
		mdWatcher.Start()
	}

	// Embedded web assets (served when running an installed binary from any dir)
	var subErr error
	webRoot, subErr = fs.Sub(webFS, "web")
	if subErr != nil {
		slog.Error("failed to load embedded web assets", "err", subErr)
		os.Exit(1)
	}

	// API Routing
	http.HandleFunc("/api/auth/status", handleAccessAuthStatus)
	http.HandleFunc("/api/auth/login", handleAccessAuthLogin)
	http.HandleFunc("/api/auth/password", handleAccessPassword)
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
	http.HandleFunc("/api/fs/list", handleFSList)
	http.HandleFunc("/api/config/theme", handleThemeUpdate)
	http.HandleFunc("/api/config/appearance", handleAppearanceUpdate)
	http.HandleFunc("/api/git/worktrees", handleGetWorktrees)
	http.HandleFunc("/api/git/worktree-dirty", handleGetWorktreeDirtyStates)
	http.HandleFunc("/api/config/worktree-state", handleWorktreeStateUpdate)
	http.HandleFunc("/api/config/quick-commands", handleQuickCommands)
	http.HandleFunc("/api/config/terminal-commands", handleTerminalCommands)
	http.HandleFunc("/api/config/markdown-dirs", handleMarkdownDirs)
	http.HandleFunc("/api/config/use-existing-terminal-tab", handleUseExistingTerminalTab)
	http.HandleFunc("/api/config/fast-mode", handleFastMode)
	http.HandleFunc("/api/config/pi-offline", handlePiOffline)
	http.HandleFunc("/api/config/auto-reconnect", handleAutoReconnect)
	http.HandleFunc("/api/markdown/files", handleMarkdownFiles)
	http.HandleFunc("/api/markdown/file", handleMarkdownFile)
	http.HandleFunc("/api/markdown/asset", handleMarkdownAsset)
	http.HandleFunc("/api/markdown/paste", handleMarkdownPaste)
	http.HandleFunc("/api/markdown/delete", handleMarkdownDelete)
	http.HandleFunc("/api/markdown/copy-all-worktrees", handleMarkdownCopyAllWorktrees)
	http.HandleFunc("/api/markdown/export-bundle", handleMarkdownExportBundle)
	http.HandleFunc("/api/markdown/import-bundle", handleMarkdownImportBundle)
	http.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, wsHub)
	})
	http.HandleFunc("/api/prompt-history/append", handlePromptHistoryAppend)
	http.HandleFunc("/api/prompt-history/recent", handlePromptHistoryRecent)
	http.HandleFunc("/api/attachments", handleAttachments)
	http.HandleFunc("/api/clipboard", handleGetClipboard)
	http.HandleFunc("/api/system/cpu", handleSystemCPU)
	http.HandleFunc("/api/session-transcript", handleGetSessionTranscript)
	http.HandleFunc("/api/proxy", handleProxy)
	http.HandleFunc("/api/sync/messages/", handleSyncMessages)
	http.HandleFunc("/api/sync/messages", handleSyncMessages)
	http.HandleFunc("/api/config/sync-coordinator", handleSyncCoordinator)

	http.HandleFunc("/api/version", handleGetVersion)
	http.HandleFunc("/api/peers/status", handleGetPeersStatus)
	http.HandleFunc("/api/config/peers", handleConfigPeers)

	http.HandleFunc("/api/update/status", handleUpdateStatus)
	http.HandleFunc("/api/update/check", handleUpdateCheck)
	http.HandleFunc("/api/update/apply", handleUpdateApply)
	http.HandleFunc("/api/update/progress", handleUpdateProgress)
	http.HandleFunc("/api/restart", handleRestart)
	http.HandleFunc("/api/diag", handleDiag)

	// Start fleet poller with current peer config
	startFleetPoller()

	// Start update checker (release builds only; dev builds hide the badge anyway).
	if BuildSource == "release" {
		updateChecker = update.NewChecker(Version, update.DetectInstallMethod(BuildSource))
		updateChecker.LoadCache()
		go func() {
			// Stagger startup so we don't hammer GitHub on cold boot.
			time.Sleep(30 * time.Second)
			runGatedUpdateCheck(updateChecker, "Initial check")

			// Re-check hourly; CheckIfStale/ShouldRunRealCheck gate the actual network call.
			ticker := time.NewTicker(1 * time.Hour)
			for range ticker.C {
				runGatedUpdateCheck(updateChecker, "Periodic check")
			}
		}()

		// Construct the applier so /api/update/apply + /api/update/progress
		// work, even though only npm/standalone installs can use them.
		updateApplier = update.NewApplier(Version, update.DetectInstallMethod(BuildSource))

		// Best-effort cleanup of stale .old, delayed so operators can run `phi --rollback`.
		go func() {
			if removed, err := update.ScheduleOldBinaryCleanup(); err != nil {
				log.Printf("[update] CleanupOldBinary: %v", err)
			} else if removed != "" {
				log.Printf("[update] Removed stale previous binary: %s", removed)
			}
		}()
	}

	// Custom route for DELETE /api/terminals/:id and WS /ws/pane/:id
	http.HandleFunc("/livez", handleLivez)
	http.HandleFunc("/healthz", handleLivez) // alias
	http.HandleFunc("/readyz", handleReadyz)
	http.HandleFunc("/", handleFallback)

	// Graceful shutdown listener. The signal handler drains via
	// gracefulShutdown (PHI_SHUTDOWN_* env tunables) instead of the old
	// sleep+Exit — k8s-friendly without changing Ctrl-C on a tty because
	// the drain defaults to 0 so the user-visible shutdown time is
	// unchanged for local development.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)
	var shutdownServers []*http.Server
	var shutdownOnce sync.Once
	go func() {
		sig := <-sigChan
		slog.Info("graceful shutdown initiated", "signal", sig.String())
		shutdownOnce.Do(func() {
			// A human pressing Ctrl-C wants out now. The long graces exist
			// for orchestrated draining (k8s, systemd), which is precisely
			// when there is no tty. Interactive shutdown used to wait up to
			// 10s for PTYs plus 15s for HTTP; the old comment claimed a tty
			// was unaffected, but that only ever applied to the drain delay.
			// Safe to shorten because Manager.Shutdown now SIGKILLs whatever
			// is left instead of leaving it to be orphaned on exit.
			//
			// Note Manager.Shutdown waits 2x the value it is given, so 1s
			// here is a 2s ceiling. That ceiling only applies to a child
			// that ignores SIGTERM: the wait returns the moment the last
			// PTY deregisters, so a well-behaved agent still exits at once.
			ptyGrace, httpGrace := 5*time.Second, 15*time.Second
			if isInteractiveTTY() {
				ptyGrace, httpGrace = 1*time.Second, 1*time.Second
			}
			gracefulShutdown(
				shutdownServers,
				envDuration("PHI_SHUTDOWN_DRAIN", 0),
				envDuration("PHI_SHUTDOWN_PTY_GRACE", ptyGrace),
				envDuration("PHI_SHUTDOWN_GRACE", httpGrace),
			)
			if err := obsShutdown(context.Background()); err != nil {
				slog.Error("obs shutdown", "err", err)
			}
			os.Exit(0)
		})
	}()

	// Bind phase. Banner prints AFTER successful binds so it only
	// advertises URLs we actually serve.
	var listeners []net.Listener
	var boundAddrs []bindaddr.Addr
	bindFailedFatal := func(err error) { slog.Error("bind failed", "err", err); os.Exit(1) }

	if *ipFlag == "lan" {
		detected := bindaddr.Detect()
		if len(detected) == 1 {
			log.Printf("[bind] no LAN/Tailnet interfaces detected — binding 127.0.0.1 only. Use --ip to override.")
		}
		for _, a := range detected {
			addr := net.JoinHostPort(a.IP.String(), strconv.Itoa(*portFlag))
			ln, err := restart.BindWithRetry(addr, 5*time.Second, 100*time.Millisecond)
			if err != nil {
				// Log-and-continue: a single LAN bind failing (e.g. a
				// service squatting on the same address) shouldn't kill
				// the other listeners. serveAll will Fatal if nothing
				// actually bound.
				log.Printf("[bind] %s (%s) failed: %v — continuing", addr, a.Kind, err)
				continue
			}
			listeners = append(listeners, ln)
			boundAddrs = append(boundAddrs, a)
		}
		if len(listeners) == 0 {
			bindFailedFatal(fmt.Errorf("failed to bind any detected interface on port %d", *portFlag))
		}
	} else {
		// Explicit --ip (0.0.0.0, a specific address, hostname, etc.).
		// Preserves the pre-existing single-listener behavior.
		addr := net.JoinHostPort(*ipFlag, strconv.Itoa(*portFlag))
		ln, err := restart.BindWithRetry(addr, 5*time.Second, 100*time.Millisecond)
		if err != nil {
			bindFailedFatal(fmt.Errorf("failed to bind %s: %w", addr, err))
		}
		listeners = append(listeners, ln)
		// Classify for banner labelling. Anything that's an IP we can
		// parse goes through bindaddr.IsAllowed-equivalent checks; for
		// hostnames/0.0.0.0 we fall back to a generic LAN label.
		parsed := net.ParseIP(*ipFlag)
		kind := bindaddr.LAN
		if parsed != nil {
			detected := bindaddr.Detect() // reuses classification logic
			kind = bindaddr.LAN
			for _, a := range detected {
				if a.IP.Equal(parsed) {
					kind = a.Kind
					break
				}
			}
			if parsed.Equal(net.IPv4zero) || parsed.IsUnspecified() {
				kind = bindaddr.LAN // labelled "LAN" with a "(public)" note in the banner
			}
		}
		boundAddrs = []bindaddr.Addr{{IP: parsed, Kind: kind}}
	}

	printWelcomeBanner(cfg, boundAddrs, *portFlag)
	var serveErr error
	shutdownServers, serveErr = serveAndCapture(listeners)
	if serveErr != nil {
		slog.Error("serve failed", "err", serveErr)
		os.Exit(1)
	}
}

// serveAndCapture is serveAll + capturing the per-listener *http.Server
// slice so the SIGTERM handler can call Shutdown on each. Returns the
// last non-nil error from any listener (same semantics as serveAll).
func serveAndCapture(listeners []net.Listener) ([]*http.Server, error) {
	servers, errCh := serveAll(listeners)
	var last error
	for range servers {
		if err := <-errCh; err != nil {
			slog.Error("listener exited", "err", err)
			last = err
		}
	}
	if last != nil {
		return servers, fmt.Errorf("all listeners exited, last error: %w", last)
	}
	return servers, nil
}

// runGatedUpdateCheck runs one check if due (CheckIfStale + ShouldRunRealCheck gate it).
func runGatedUpdateCheck(checker *update.Checker, label string) {
	if !checker.CheckIfStale() || !checker.ShouldRunRealCheck() {
		return
	}
	result := checker.RunCheck(false)
	if result.Err != nil {
		log.Printf("[update] %s failed: %v", label, result.Err)
		return
	}
	if result.Latest != "" {
		log.Printf("[update] %s: current=%s latest=%s available=%v",
			label, Version, result.Latest, result.Latest != Version)
	}
}

func printWelcomeBanner(cfg Config, addrs []bindaddr.Addr, port int) {
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
		"canary": {255, 238, 16},
		"copper": {211, 84, 0},
		"mint":   {46, 213, 115},
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
	fmt.Printf("  %sPort:%s         %d\n", colorEsc, resetEsc, port)
	fmt.Printf("  %sTheme:%s        %s\n", colorEsc, resetEsc, cfg.ThemeColor)
	fmt.Printf("%s────────────────────────────────────────────────────────%s\n\n", dimEsc, resetEsc)

	// Bind summary. In lan-detect mode this prints one labelled line
	// per successfully bound interface (loopback, each LAN IP, each
	// Tailnet IP). In explicit --ip mode it prints one line. Called
	// AFTER binds so the banner only advertises URLs we actually serve.
	for _, a := range addrs {
		url := fmt.Sprintf("http://%s:%d", a.IP.String(), port)
		switch {
		case a.IP.Equal(net.IPv4zero):
			// Explicit 0.0.0.0 bind — flag the public exposure so the
			// user isn't surprised when their firewall ignores it.
			fmt.Printf("  %sServer running on:%s %s%s%s %s(all interfaces, public reachable)%s\n",
				boldEsc, resetEsc, boldEsc, url, resetEsc, dimEsc, resetEsc)
			fmt.Printf("    %slocal:           http://localhost:%d%s\n", dimEsc, port, resetEsc)
		case a.Kind == bindaddr.Loopback:
			fmt.Printf("  %sServer running on:%s %s%s%s\n", boldEsc, resetEsc, boldEsc, url, resetEsc)
			fmt.Printf("    %slocal%s\n", dimEsc, resetEsc)
		default:
			fmt.Printf("    %s%-8s%s %s%s%s\n", dimEsc, a.Kind.String()+":", resetEsc, boldEsc, url, resetEsc)
		}
	}
	fmt.Printf("\n")
}

// serveAll starts one *http.Server per listener over the default mux and
// returns the servers so the shutdown path can drain them. Blocks until all
// listeners exit; ErrServerClosed (from Shutdown) is a clean stop, not fatal.
func serveAll(listeners []net.Listener) ([]*http.Server, <-chan error) {
	handler := obs.WrapHTTP(accessAuthMiddleware(http.DefaultServeMux))
	servers := make([]*http.Server, len(listeners))
	errCh := make(chan error, len(listeners))
	for i, ln := range listeners {
		srv := &http.Server{Handler: handler}
		servers[i] = srv
		go func(s *http.Server, l net.Listener) {
			err := s.Serve(l)
			if err != nil && err != http.ErrServerClosed {
				slog.Error("listener exited", "err", err)
				errCh <- err
				return
			}
			errCh <- nil
		}(srv, ln)
	}
	return servers, errCh
}

// envDuration parses key as a Go duration string, falling back to def on
// unset/invalid values so a malformed env var degrades gracefully instead
// of failing startup.
func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid duration env, using default", "key", key, "value", v, "default", def)
	}
	return def
}

// gracefulShutdown flips readiness to 503, waits out the drain delay (so
// the load balancer stops routing), flushes state, tells clients,
// gracefully terminates child PTYs, then drains in-flight HTTP. Returns
// when done. Sequence matches what a k8s+drain-system expects:
//  1. shuttingDown = true (so /readyz returns 503 and k8s removes us
//     from the service endpoints pool).
//  2. ptyManager.BeginDrain() (so new spawn requests are rejected during
//     the drain window).
//  3. sleep drainDelay (k8s picks up the 503 and stops sending traffic).
//  4. flush state to disk (so a restart picks up where we left off).
//  5. wsHub.BroadcastShutdown (tell browsers to show the bulk-disconnect
//     banner).
//  6. small sleep (lets the WS 0x05 frame flush; matches current
//     behavior).
//  7. ptyManager.Shutdown(ptyGrace) — SIGTERM each agent, wait bounded
//     by ptyGrace, force-kill stragglers.
//  8. drain in-flight HTTP via Server.Shutdown(ctx) within grace.
//
// isInteractiveTTY reports whether stdin is a terminal, i.e. whether a person
// is sitting in front of this process rather than an init system or container
// runtime. Redirected or piped stdin is not a char device.
func isInteractiveTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func gracefulShutdown(servers []*http.Server, drainDelay, ptyGrace, grace time.Duration) {
	shuttingDown.Store(true) // /readyz -> 503
	if mdWatcher != nil {
		mdWatcher.Close()
	}
	if ptyManager != nil {
		ptyManager.BeginDrain() // reject new PTY spawns for the whole drain window
	}
	if drainDelay > 0 {
		time.Sleep(drainDelay)
	}
	if err := flushStateForRestart(); err != nil {
		slog.Error("shutdown flush failed", "err", err)
	}
	if wsHub != nil {
		wsHub.BroadcastShutdown("shutdown")
	}
	time.Sleep(200 * time.Millisecond) // let the WS 0x05 frame flush
	if ptyManager != nil {
		ptyManager.Shutdown(ptyGrace)
	}
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	var wg sync.WaitGroup
	for _, srv := range servers {
		wg.Add(1)
		go func(s *http.Server) {
			defer wg.Done()
			if err := s.Shutdown(ctx); err != nil {
				slog.Error("http drain", "err", err)
			}
		}(srv)
	}
	wg.Wait()
}

// ---------- prompt_history handlers ----------

// promptHistoryStoreMu serializes lazyInit against concurrent first-call
// initialization. After init succeeds, the *Store itself is goroutine-safe
// (Store.mu protects every mutator). On corrupt-file init we cache a
// sentinel empty store with no path — writes fail with "no path
// configured", reads return []. That surfaces the persistence failure
// (500 on append, [] on recent) without panicking.
var (
	promptHistoryStoreMu sync.Mutex
	promptHistoryStore   *prompt_history.Store
	promptHistoryLoadErr error
)

func promptHistoryPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "."
	}
	return filepath.Join(home, ".phi", "prompt_history.json")
}

func promptHistoryLazyStore() (*prompt_history.Store, error) {
	promptHistoryStoreMu.Lock()
	defer promptHistoryStoreMu.Unlock()
	if promptHistoryStore != nil || promptHistoryLoadErr != nil {
		// Already initialized (success or recorded failure). Reuse.
		if promptHistoryStore == nil {
			// Empty sentinel store, plus the recorded error so the
			// handlers can surface it.
			return &prompt_history.Store{}, promptHistoryLoadErr
		}
		return promptHistoryStore, nil
	}
	s, err := prompt_history.Load(promptHistoryPath())
	if err != nil {
		log.Printf("[prompt_history] failed to load %s: %v", promptHistoryPath(), err)
		promptHistoryLoadErr = err
		// Cache a path-less empty store. Appends to this will fail at
		// persist time, signalling the corrupt state to the caller.
		return &prompt_history.Store{}, err
	}
	promptHistoryStore = s
	return s, nil
}

func handlePromptHistoryAppend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Text string `json:"text"`
		Cwd  string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	s, err := promptHistoryLazyStore()
	if err != nil {
		http.Error(w, "history load: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := s.Append(req.Text, req.Cwd); err != nil {
		http.Error(w, "history persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "count": s.Len()})
}

func handlePromptHistoryRecent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	n := 20
	if v := r.URL.Query().Get("n"); v != "" {
		if parsed, perr := strconv.Atoi(v); perr == nil && parsed > 0 && parsed <= 200 {
			n = parsed
		}
	}
	s, _ := promptHistoryLazyStore() // error ignored here; Recent on empty store returns []
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.Recent(cwd, n))
}
