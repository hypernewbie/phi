package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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

	"github.com/hypernewbie/phi/internal/access"
	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/gitapi"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/server"
	"github.com/hypernewbie/phi/internal/webassets"
	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/prompt_history"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/restart"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"google.golang.org/protobuf/proto"
)

var (
	piBridge *piapp.Bridge
	piAPI    = piapp.NewAPI(
		func() *piapp.Bridge { return piBridge },
		func() *attachments.AttachmentStore { return attachments.Default },
		func() *pty.Manager { return server.PTY },
	)
	gitAPI = gitapi.New(
		func() string { return server.ActiveCWD },
		func() *pty.Manager { return server.PTY },
		func() []string { return server.WorkspaceRoots(loadConfig()) },
	)
	piTitleService *piTerminalTitleService
	updateChecker  *update.Checker
	updateApplier  *update.Applier
	_              = atomic.Bool{}

	// Build identity, stamped by the linker. The server package serves them.
	Version     = "dev"
	Commit      = "none"
	Date        = "unknown"
	BuildSource = "source"
)

func rollbackPreviousBinary() (string, error) {
	release, err := access.AcquireRollbackGuard(configStore())
	if err != nil {
		return "", err
	}
	defer release()
	return update.Rollback()
}

func main() {
	enableVirtualTerminalProcessing()
	portFlag := flag.Int("port", 7070, "Port to run Go web server on")
	diagnosticsDirFlag := flag.String("diagnostics-dir", "", "Enable private loopback diagnostics and write connection files under this absolute directory. Only takes effect in a binary built with -tags=profiling.")
	ipFlag := flag.String("ip", "lan", `IP to bind. "lan" (default) binds loopback + every LAN (RFC 1918) + Tailscale (100.64/10) interface on the host. Use 0.0.0.0 to expose on every interface (public internet reachable), or an explicit IP to bind just one address.`)
	webFlag := flag.String("web", "", "Directory to serve web assets from instead of embedded assets")
	dataDirFlag := flag.String("data-dir", "", "Absolute directory for Phi state (default ~/.phi); does not change HOME or assistant settings")
	versionFlag := flag.Bool("version", false, "Print version and exit")
	rollbackFlag := flag.Bool("rollback", false, "Roll back to the previously installed binary (undoes the last self-update) and exit")
	logLevelFlag := flag.String("log-level", "", "Log level: debug|info|warn|error (default: info, or PHI_LOG env var)")
	// Registered unconditionally (not behind //go:build otel) so a default
	// build parses identical args — it just never has anywhere to send the
	// endpoint. obs.Init's body is the only tag-split part (plan §B).
	otelEndpointFlag := flag.String("otel-endpoint", "", "OTLP/gRPC collector endpoint for OpenTelemetry export (host:port). Only takes effect in a binary built with -tags=otel. Falls back to PHI_OTEL_ENDPOINT.")
	flag.Parse()

	if *diagnosticsDirFlag != "" && !filepath.IsAbs(*diagnosticsDirFlag) {
		fmt.Fprintln(os.Stderr, "--diagnostics-dir must be an absolute path")
		os.Exit(2)
	}

	if *dataDirFlag != "" {
		if !filepath.IsAbs(*dataDirFlag) {
			fmt.Fprintln(os.Stderr, "--data-dir must be an absolute path")
			os.Exit(2)
		}
		system.SetPhiDataDir(filepath.Clean(*dataDirFlag))
	}

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
		restored, err := rollbackPreviousBinary()
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
	server.ActiveCWD, err = os.Getwd()
	if err != nil {
		slog.Error("failed to resolve current working directory", "err", err)
		os.Exit(1)
	}

	if *webFlag != "" {
		diskRoot, err := webassets.OpenDiskRoot(*webFlag)
		if err != nil {
			slog.Error("failed to open web asset directory", "dir", *webFlag, "err", err)
			os.Exit(1)
		}
		defer diskRoot.Close()
		server.Static = webassets.NewDisk(diskRoot.FS())
		slog.Info("serving web assets from disk", "dir", diskRoot.Name())
	}

	log.Printf("[main] Starting Phi in CWD: %s", server.ActiveCWD)

	// Ensure config directory exists and contains CWD as a workspace
	cfg, err := loadConfigWithError()
	if err != nil {
		slog.Error("config read failed", "path", configFilePath(), "err", err)
		os.Exit(1)
	}
	// The manager resolves both collaborators at call time: server.Hub is assigned
	// later in startup, and configStore follows the active data dir.
	server.ConfigStore = configStore
	server.Access = func() *access.Manager { return access.Default }
	access.Default = access.NewManager(configStore, func() *ws.Hub { return server.Hub })
	if err := access.Default.Configure(cfg.AccessPasswordHash); err != nil {
		slog.Error("invalid access password configuration", "err", err)
		os.Exit(1)
	}
	if err := access.Default.ValidateOrigins(); err != nil {
		slog.Error("invalid auth_origins configuration", "err", err)
		os.Exit(1)
	}
	if !access.Default.StateOwned() {
		slog.Warn("another phi instance owns the access state for this directory; " +
			"this instance serves the UI but refuses all authentication until it exits")
	}
	found := false
	for _, wsPath := range cfg.Workspaces {
		if wsPath == server.ActiveCWD {
			found = true
			break
		}
	}
	if !found {
		cfg.Workspaces = append(cfg.Workspaces, server.ActiveCWD)
		if access.Default.StateOwned() {
			saveConfig(cfg)
		}
	}

	// Initialize PTY and WebSocket subsystems
	server.PTY = pty.NewManager()
	server.Coders = coders.NewManagerWithOptions(coders.BuiltinOptions{
		OpenCodeLegacy:        cfg.OpenCodeLegacy,
		OpenCodeCommand:       cfg.OpenCodeCommand,
		OpenCodeLegacyCommand: cfg.OpenCodeLegacyCommand,
		PsiCommand:            cfg.PsiCommand,
	})
	// Load custom backend files from ~/.phi/backends/*.json. Built-ins
	// are already seeded by NewManager; custom profiles patch / add.
	// Per-file failures are logged inside LoadFromDir and skipped so a
	// single malformed file never breaks startup (R3).
	if err := server.Coders.LoadFromDir(customBackendsDir(), func(s string) { log.Print(s) }); err != nil {
		log.Printf("[backends] failed to load custom backends: %v", err)
	}
	rpcMgr := rpc.NewManager()
	// Saved tabs are restored as new live processes after the hub exists.
	// Never deserialize OS process handles or publish nil-PTY ghosts.
	if err := LoadSyncStore(); err != nil {
		log.Printf("[sync] Failed to load sync store state: %v", err)
	}
	server.PTY.StartIdleWatcher(func(info pty.IdleNotification) {
		cfg := loadConfig()
		host := reportedHostname(cfg)

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
	startOpenCodeIdleWatcher()
	server.Hub = ws.NewHub(*cfg.ReplayBufferBytes)
	gitAPI.StartReadLoop = func(inst *pty.PTYInstance) { ws.StartPTYReadLoop(inst, server.Hub) }
	// Adopt the generation loaded from config so the first upgrade is admitted
	// and later password changes fence older sockets.
	server.Hub.RotateAuth(access.Default.AccessGeneration())
	// Re-check every socket admission against live auth state: a family
	// revocation or an expiring token between the middleware decision and the
	// upgrade must refuse the connection rather than serve it.
	server.Hub.SetAuthValidator(access.Default.AdmitsFence)
	if err := server.Hub.SetRecordingDirectory(filepath.Join(system.PhiDataDir(), "recordings")); err != nil {
		slog.Error("terminal recording directory unavailable", "err", err)
	}
	server.Pi = piAPI
	server.Git = gitAPI
	server.Version, server.Commit, server.Date, server.BuildSource = Version, Commit, Date, BuildSource
	attachments.Default, err = attachments.OpenAttachmentStore()
	if err != nil {
		slog.Warn("Pi attachments unavailable", "err", err)
		attachments.Default = nil
	} else {
		defer func() { _ = attachments.Default.Close() }()
	}
	attachments.SetPaneManager(func() *pty.Manager { return server.PTY })
	// The Pi bridge serves before saved Pi tabs restore so relaunched
	// panes provision against a live listener. A nil bridge (listener
	// failure) leaves every launch on the unmanaged path.
	piBridge = piapp.StartBridge(server.Hub, piPhiRuntime, strings.TrimSpace(piPhiVersionAsset))
	if piBridge != nil {
		piBridge.Syncboard = http.HandlerFunc(handleSyncMessages)
		piBridge.LoadConfig = loadConfigWithError
	}
	restoreSavedTabs()
	// Expiry starts only after restoration completes so saved panes
	// are live (and protected) before the first sweep runs.
	server.Hub.StartRetentionSweeps()
	piTitleService = newPiTerminalTitleService(server.PTY, server.Hub)
	piTitleService.Start()

	// Markdown watcher: fswatch over the resolved markdownDirs of every
	// live pane cwd. Fires a markdown-changed Notification so open UIs
	// can silently refresh the md file list. Watch set follows panes, not
	// browsers: a worktree nobody has a pane in is not covered (accepted
	// edge).
	server.MDWatcher, err = fswatch.New(server.MarkdownWatchDirs, func(dir string) {
		server.Hub.BroadcastNotification(&wspb.Notification{
			Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
				Dir: proto.String(dir),
			}},
		})
	})
	if err != nil {
		slog.Warn("fswatch unavailable; markdown panel won't live-update", "err", err)
	} else {
		server.MDWatcher.Filter = fswatch.ExtFilter(".md")
		server.MDWatcher.Start()
	}

	// Without --web, use embedded assets from any working directory.
	// Ordinary builds embed web/ raw; release builds decompress webdist/.
	if server.Static == nil {
		root, precompressed, subErr := newWebRoot()
		if subErr != nil {
			slog.Error("failed to load embedded web assets", "err", subErr)
			os.Exit(1)
		}
		// compression_enabled is captured once here; toggling it needs a restart.
		server.Static = webassets.New(root, precompressed, cfg.CompressionEnabled)
	}

	// API Routing
	http.HandleFunc("/api/auth/status", access.HandleAccessAuthStatus)
	http.HandleFunc("/api/auth/login", access.HandleAccessAuthLogin)
	http.HandleFunc("/api/auth/password", access.HandleAccessPassword)
	http.HandleFunc("/api/auth/v2/status", access.HandleAccessV2Status)
	http.HandleFunc("/api/auth/v2/login", access.HandleAccessV2Login)
	http.HandleFunc("/api/auth/v2/password", access.HandleAccessV2Password)
	http.HandleFunc("/api/auth/v2/refresh", access.HandleAccessV2Refresh)
	http.HandleFunc("/api/auth/v2/logout", access.HandleAccessV2Logout)
	http.HandleFunc("/api/coders", handleGetCoders)
	http.HandleFunc("/api/sessions", handleGetSessions)
	http.HandleFunc("/api/terminals", handleSpawnTerminal)
	http.HandleFunc("/api/session-meta", handleSessionMeta)
	http.HandleFunc("/api/diff", gitAPI.HandleGetDiff)
	http.HandleFunc("/api/git/raw-diff", gitAPI.HandleRawDiff)
	http.HandleFunc("/api/git/raw-status", gitAPI.HandleRawStatus)
	http.HandleFunc("/api/git/raw-log", gitAPI.HandleRawLog)
	http.HandleFunc("/api/git/commits", gitAPI.HandleGetCommits)
	http.HandleFunc("/api/git/info", gitAPI.HandleGitInfo)
	http.HandleFunc("/api/git/status-files", gitAPI.HandleGitStatusFiles)
	http.HandleFunc("/api/git/action", gitAPI.HandleGitAction)
	http.HandleFunc("/api/config", server.HandleConfig)
	http.HandleFunc("/api/config/pushover", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			server.HandleGetPushoverConfig(w, r)
		} else if r.Method == http.MethodPost {
			server.HandlePostPushoverConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/pushover/test", server.HandleTestPushover)
	http.HandleFunc("/api/config/webhook", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			server.HandleGetWebhookConfig(w, r)
		} else if r.Method == http.MethodPost {
			server.HandlePostWebhookConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/webhook/test", server.HandleTestWebhook)
	http.HandleFunc("/api/config/simplepush", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			server.HandleGetSimplepushConfig(w, r)
		} else if r.Method == http.MethodPost {
			server.HandlePostSimplepushConfig(w, r)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
	http.HandleFunc("/api/config/simplepush/test", server.HandleTestSimplepush)
	http.HandleFunc("/api/config/kanban-vault", server.HandleKanbanVault)
	http.HandleFunc("/api/config/export", server.HandleConfigExport)
	http.HandleFunc("/api/config/import", server.HandleConfigImport)
	http.HandleFunc("/api/config/export-models", server.HandleConfigExportModels)
	http.HandleFunc("/api/config/import-models", server.HandleConfigImportModels)
	// Cmds export was split in v0.7.16: quick_commands (sent to active PTY)
	// and terminal_commands (spawn new shell tabs) are now separate concepts
	// with their own endpoints. The legacy /api/config/export-cmds route is
	// gone; /api/config/import-cmds stays for paste backwards-compat.
	http.HandleFunc("/api/config/export-quick-commands", server.HandleConfigExportQuickCommands)
	http.HandleFunc("/api/config/export-terminal-commands", server.HandleConfigExportTerminalCommands)
	http.HandleFunc("/api/config/import-cmds", server.HandleConfigImportCmds)
	http.HandleFunc("/api/config/workspaces", server.HandleWorkspaceToggle)
	http.HandleFunc("/api/config/models", server.HandleModelPresets)
	http.HandleFunc("/api/config/thinking-presets", server.HandleThinkingPresets)
	http.HandleFunc("/api/fs/autocomplete", handleFSAutocomplete)
	http.HandleFunc("/api/fs/list", server.HandleFSList)
	http.HandleFunc("/api/fs/browse", server.HandleFSBrowse)
	http.HandleFunc("/api/config/theme", server.HandleThemeUpdate)
	http.HandleFunc("/api/config/appearance", server.HandleAppearanceUpdate)
	http.HandleFunc("/api/config/mobile-appearance", server.HandleMobileAppearance)
	http.HandleFunc("/api/config/mobile-appearance/fence", server.HandleMobileAppearanceFence)
	http.HandleFunc("/api/git/worktrees", handleGetWorktrees)
	http.HandleFunc("/api/git/worktree-dirty", handleGetWorktreeDirtyStates)
	http.HandleFunc("/api/config/worktree-state", handleWorktreeStateUpdate)
	http.HandleFunc("/api/config/quick-commands", server.HandleQuickCommands)
	http.HandleFunc("/api/config/terminal-commands", server.HandleTerminalCommands)
	http.HandleFunc("/api/config/markdown-dirs", server.HandleMarkdownDirs)
	http.HandleFunc("/api/config/use-existing-terminal-tab", server.HandleUseExistingTerminalTab)
	http.HandleFunc("/api/config/use-hidden-terminal", server.HandleUseHiddenTerminal)
	http.HandleFunc("/api/cmd/run", server.HandleRunCommand)
	http.HandleFunc("/api/cmd/batch-run", server.HandleRunCommand)
	http.HandleFunc("/api/config/fast-mode", server.HandleFastMode)
	http.HandleFunc("/api/config/pi-offline", server.HandlePiOffline)
	http.HandleFunc("/api/config/pi-bridge-no-inject", server.HandlePiBridgeNoInject)
	http.HandleFunc("/api/config/claude-dangerously-skip-permissions", server.HandleClaudeDangerouslySkipPermissions)
	http.HandleFunc("/api/config/agy-theme-ansi", server.HandleAgyThemeAnsi)
	http.HandleFunc("/api/config/auto-reconnect", server.HandleAutoReconnect)
	http.HandleFunc("/api/opencode/service", handleOpenCodeService)
	http.HandleFunc("/api/opencode/service/stop", handleOpenCodeServiceStop)
	http.HandleFunc("/api/config/opencode-idle-stop", server.HandleOpenCodeIdleStop)
	http.HandleFunc("/api/markdown/files", server.HandleMarkdownFiles)
	http.HandleFunc("/api/markdown/file", server.HandleMarkdownFile)
	http.HandleFunc("/api/markdown/asset", server.HandleMarkdownAsset)
	http.HandleFunc("/api/file/asset", server.HandleFileAsset)
	http.HandleFunc("/api/markdown/paste", server.HandleMarkdownPaste)
	http.HandleFunc("/api/markdown/delete", server.HandleMarkdownDelete)
	http.HandleFunc("/api/markdown/copy-all-worktrees", server.HandleMarkdownCopyAllWorktrees)
	http.HandleFunc("/api/markdown/export-bundle", server.HandleMarkdownExportBundle)
	http.HandleFunc("/api/markdown/import-bundle", server.HandleMarkdownImportBundle)
	http.HandleFunc("/ws/md-events", func(w http.ResponseWriter, r *http.Request) {
		ws.HandleEventsWS(w, r, server.Hub)
	})
	http.HandleFunc("/api/prompt-history/append", handlePromptHistoryAppend)
	http.HandleFunc("/api/prompt-history/recent", handlePromptHistoryRecent)
	http.HandleFunc("/api/pi-history", piAPI.HandlePiBridgeHistory)
	http.HandleFunc("/api/pi-bridge/models", piAPI.HandlePiBridgeModels)
	http.HandleFunc("/api/pi-bridge/model", piAPI.HandlePiBridgeSetModel)
	http.HandleFunc("/api/pi-bridge/thinking-levels", piAPI.HandlePiBridgeThinkingLevels)
	http.HandleFunc("/api/pi-bridge/thinking", piAPI.HandlePiBridgeSetThinking)
	http.HandleFunc("/api/pi-bridge/compact", piAPI.HandlePiBridgeCompact)
	http.HandleFunc("/api/pi-bridge/reload", piAPI.HandlePiBridgeReload)
	http.HandleFunc("/api/pi-bridge/skills", piAPI.HandlePiBridgeSkills)
	http.HandleFunc("/api/pi-bridge/skill", piAPI.HandlePiBridgeInvokeSkill)
	http.HandleFunc("/api/pi-bridge/attachments/context", piAPI.HandlePiBridgeAttachmentContext)
	http.HandleFunc("/api/pi-bridge/attachments", piAPI.HandlePiBridgeAttachments)
	http.HandleFunc("/api/attachments/v2/browse", attachments.HandleV2Browse)
	http.HandleFunc("/api/attachments/v2/server-items", attachments.HandleV2ServerItem)
	http.HandleFunc("/api/attachments/v2/items/", attachments.HandleV2Item)
	http.HandleFunc("/api/pi-bridge/transcript-search", piAPI.HandlePiBridgeTranscriptSearch)
	http.HandleFunc("/api/attachments", attachments.HandleClipboard)
	http.HandleFunc("/api/clipboard", handleGetClipboard)
	http.HandleFunc("/api/system/cpu", handleSystemCPU)
	http.HandleFunc("/api/session-transcript", handleGetSessionTranscript)
	http.HandleFunc("/api/proxy", handleProxy)
	http.HandleFunc("/api/sync/messages/", handleSyncMessages)
	http.HandleFunc("/api/sync/messages", handleSyncMessages)
	http.HandleFunc("/api/config/sync-coordinator", handleSyncCoordinator)

	http.HandleFunc("/api/version", handleGetVersion)
	http.HandleFunc("/api/peers/status", server.HandleGetPeersStatus)
	http.HandleFunc("/api/config/peers", server.HandleConfigPeers)

	http.HandleFunc("/api/update/status", server.HandleUpdateStatus)
	http.HandleFunc("/api/update/check", server.HandleUpdateCheck)
	http.HandleFunc("/api/update/apply", server.HandleUpdateApply)
	http.HandleFunc("/api/update/progress", server.HandleUpdateProgress)
	http.HandleFunc("/api/restart", handleRestart)
	http.HandleFunc("/api/diag", server.HandleDiag)

	// Start fleet poller with current peer config
	server.StartFleetPoller()

	// Start update checker (release builds only; dev builds hide the badge anyway).
	if BuildSource == "release" {
		updateChecker = update.NewChecker(Version, update.DetectInstallMethod(BuildSource))
		updateChecker.LoadCache()
		go obs.DoFeature("updates", func(_ context.Context) {
			// Stagger startup so we don't hammer GitHub on cold boot.
			time.Sleep(30 * time.Second)
			runGatedUpdateCheck(updateChecker, "Initial check")

			// Re-check hourly; CheckIfStale/ShouldRunRealCheck gate the actual network call.
			ticker := time.NewTicker(1 * time.Hour)
			for range ticker.C {
				runGatedUpdateCheck(updateChecker, "Periodic check")
			}
		})

		// Construct the applier so /api/update/apply + /api/update/progress
		// work, even though only npm/standalone installs can use them.
		updateApplier = update.NewApplier(Version, update.DetectInstallMethod(BuildSource))
		server.InstallUpdater(updateChecker, updateApplier)

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
	http.HandleFunc("/livez", server.HandleLivez)
	http.HandleFunc("/healthz", server.HandleLivez) // alias
	http.HandleFunc("/readyz", server.HandleReadyz)
	http.HandleFunc("/", handleFallback)
	http.HandleFunc("/ws/control", ws.HandleControl(server.Hub, rpcMgr, func() string { return server.ActiveCWD }))

	closeDiagnostics := startPrivateDiagnostics(*diagnosticsDirFlag)

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
			closeDiagnostics()
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
			access.Default.BeginRestart()
			piBridge.Stop()
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
	bindFailedFatal := func(err error) {
		closeDiagnostics()
		slog.Error("bind failed", "err", err)
		os.Exit(1)
	}

	if *ipFlag == "lan" {
		detected := bindaddr.Detect()
		hasNonLoopback := false
		for _, a := range detected {
			if a.Kind != bindaddr.Loopback {
				hasNonLoopback = true
				break
			}
		}
		if !hasNonLoopback {
			log.Printf("[bind] no LAN/Tailnet interfaces detected — binding loopback only. Use --ip to override.")
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

	if piBridge != nil {
		piBridge.SetListenerAddr(listeners[0].Addr())
	}
	server.Port = listeners[0].Addr().(*net.TCPAddr).Port
	printWelcomeBanner(cfg, boundAddrs, server.Port)
	var serveErr error
	shutdownServers, serveErr = serveAndCapture(listeners)
	closeDiagnostics()
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

// bannerColors is the RGB tuple per theme name used by the welcome banner.
// MUST stay in sync with web/theme.js ACCENT_COLORS keys — drift silently
// falls back to purple in printWelcomeBanner. The test
// TestBannerColorsCoversAllAccentColors enforces this.
//
// NOTE: When adding a new theme color, you must update:
//  1. web/app.js: Add properties in ACCENT_COLORS
//  2. web/index.html: Add <option> in #accent-color-select
//  3. main.go: Add entry in bannerColors below
//  4. bonus/: Add matching theme profiles to bonus/vim_themes/,
//     bonus/pi_themes/, bonus/opencode_themes/, and bonus/btop_themes/
var bannerColors = map[string][]int{
	"purple":  {124, 106, 247},
	"blue":    {56, 189, 248},
	"green":   {16, 185, 129},
	"amber":   {251, 191, 36},
	"red":     {248, 113, 113},
	"pink":    {236, 72, 153},
	"teal":    {20, 184, 166},
	"indigo":  {99, 102, 241},
	"orange":  {249, 115, 22},
	"cyan":    {6, 182, 212},
	"rose":    {244, 63, 94},
	"lime":    {132, 204, 22},
	"white":   {255, 255, 255},
	"gold":    {212, 175, 55},
	"canary":  {255, 238, 16},
	"copper":  {211, 84, 0},
	"mint":    {46, 213, 115},
	"violet":  {167, 139, 250},
	"emerald": {5, 150, 105},
	"neon":    {26, 121, 255},
	"coral":   {224, 122, 95},
	"fuchsia": {217, 70, 239},
	"arc":     {41, 82, 255},
	"ember":   {255, 69, 0},
	"fog":     {148, 163, 184},
	"ash":     {168, 162, 158},
	"dusk":    {184, 169, 201},
	"pine":    {132, 165, 157},
	"fern":    {156, 175, 136},
}

func printWelcomeBanner(cfg Config, addrs []bindaddr.Addr, port int) {
	rgb, ok := bannerColors[strings.ToLower(cfg.ThemeColor)]
	if !ok {
		rgb = bannerColors["purple"]
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

	host := reportedHostname(cfg)
	coordinatorAddr := &net.TCPAddr{Port: port}
	if len(addrs) > 0 {
		coordinatorAddr.IP = addrs[0].IP
	}

	fmt.Printf("%s── Status Dump ──────────────────────────────────────────%s\n", dimEsc, resetEsc)
	fmt.Printf("  %sCWD:%s          %s\n", colorEsc, resetEsc, server.ActiveCWD)
	fmt.Printf("  %sWorkspaces:%s   %d active\n", colorEsc, resetEsc, len(cfg.Workspaces))
	fmt.Printf("  %sHostname:%s     %s\n", colorEsc, resetEsc, strings.ToUpper(host))
	fmt.Printf("  %sCoordinator:%s  %s\n", colorEsc, resetEsc, cfg.SyncCoordinatorURL(coordinatorAddr))
	fmt.Printf("  %sPort:%s         %d\n", colorEsc, resetEsc, port)
	fmt.Printf("  %sTheme:%s        %s\n", colorEsc, resetEsc, cfg.ThemeColor)
	fmt.Printf("%s────────────────────────────────────────────────────────%s\n\n", dimEsc, resetEsc)

	// Bind summary. In lan-detect mode this prints one labelled line
	// per successfully bound interface (loopback, each LAN IP, each
	// Tailnet IP). In explicit --ip mode it prints one line. Called
	// AFTER binds so the banner only advertises URLs we actually serve.
	firstLoopback := true
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
			if firstLoopback {
				fmt.Printf("  %sServer running on:%s %s%s%s\n", boldEsc, resetEsc, boldEsc, url, resetEsc)
				fmt.Printf("    %slocal%s\n", dimEsc, resetEsc)
				firstLoopback = false
			} else {
				fmt.Printf("    %s%-8s%s %s%s%s\n", dimEsc, a.Kind.String()+":", resetEsc, boldEsc, url, resetEsc)
			}
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
	handler := obs.WrapHTTP(access.Middleware(obs.WrapTimingHTTP(http.DefaultServeMux)))
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
//  1. server.ShuttingDown = true (so /readyz returns 503 and k8s removes us
//     from the service endpoints pool).
//  2. server.PTY.BeginDrain() (so new spawn requests are rejected during
//     the drain window).
//  3. sleep drainDelay (k8s picks up the 503 and stops sending traffic).
//  4. flush state to disk (so a restart picks up where we left off).
//  5. server.Hub.BroadcastShutdown (tell browsers to show the bulk-disconnect
//     banner).
//  6. small sleep (lets the WS 0x05 frame flush; matches current
//     behavior).
//  7. server.PTY.Shutdown(ptyGrace) — SIGTERM each agent, wait bounded
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
	server.ShuttingDown.Store(true) // /readyz -> 503
	stopOpenCodeIdleWatcher()
	if server.MDWatcher != nil {
		server.MDWatcher.Close()
	}
	if server.PTY != nil {
		server.PTY.BeginDrain() // reject new PTY spawns for the whole drain window
	}
	if piTitleService != nil {
		piTitleService.Close()
	}
	if drainDelay > 0 {
		time.Sleep(drainDelay)
	}
	if err := flushStateForRestart(); err != nil {
		slog.Error("shutdown flush failed", "err", err)
	}
	if server.Hub != nil {
		server.Hub.BroadcastShutdown("shutdown")
	}
	time.Sleep(200 * time.Millisecond) // let the WS 0x05 frame flush
	if server.PTY != nil {
		server.PTY.Shutdown(ptyGrace)
		// Native exit notices can publish the exact resume ID during drain.
		readCtx, readCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		server.PTY.WaitForReadLoops(readCtx)
		readCancel()
		if err := server.PTY.FlushSaveState(); err != nil {
			slog.Error("shutdown tab snapshot", "err", err)
		}
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
	return filepath.Join(system.PhiDataDir(), "prompt_history.json")
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
