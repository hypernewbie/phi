package server

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/hypernewbie/phi/internal/attachments"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/internal/webassets"
	"github.com/hypernewbie/phi/pkg/bindaddr"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/fswatch"
	"github.com/hypernewbie/phi/pkg/obs"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/restart"
	"github.com/hypernewbie/phi/pkg/rpc"
	"github.com/hypernewbie/phi/pkg/system"
	"github.com/hypernewbie/phi/pkg/update"
	"github.com/hypernewbie/phi/pkg/ws"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"google.golang.org/protobuf/proto"
)

// Run owns one process runtime. It may be called once; constructing a Server
// or obtaining its Handler does not start workers or bind listeners.
func (app *Server) Run(ctx context.Context) error {
	if !app.runStarted.CompareAndSwap(false, true) {
		return fmt.Errorf("server runtime can only run once")
	}
	if app.configStore() == nil {
		return errNoConfigStore
	}
	if app.options.Web == "" && app.options.Assets == nil {
		return fmt.Errorf("server: web asset loader is not installed")
	}
	defer app.closeResources()
	var err error

	if app.options.Web != "" {
		diskRoot, err := webassets.OpenDiskRoot(app.options.Web)
		if err != nil {
			slog.Error("failed to open web asset directory", "dir", app.options.Web, "err", err)
			return err
		}
		defer diskRoot.Close()
		app.static = webassets.NewDisk(diskRoot.FS())
		slog.Info("serving web assets from disk", "dir", diskRoot.Name())
	}

	log.Printf("[main] Starting Phi in CWD: %s", app.activeCWD)

	// Migrate pre-feature configs to an explicit launch default once at
	// startup. Read paths stay side-effect free after this.
	if err := app.configStore().MigratePiDefault(); err != nil {
		slog.Error("pi default migration failed", "path", app.configStore().PrimaryPath(), "err", err)
		return err
	}
	// Ensure config directory exists and contains CWD as a workspace
	cfg, err := app.configStore().LoadWithError()
	if err != nil {
		slog.Error("config read failed", "path", app.configStore().PrimaryPath(), "err", err)
		return err
	}
	// The manager resolves both collaborators at call time: app.hub is assigned
	// later in startup, and configStore follows the active data dir.
	if err := app.accessManager.Configure(cfg.AccessPasswordHash); err != nil {
		slog.Error("invalid access password configuration", "err", err)
		return err
	}
	if err := app.accessManager.ValidateOrigins(); err != nil {
		slog.Error("invalid auth_origins configuration", "err", err)
		return err
	}
	if !app.accessManager.StateOwned() {
		slog.Warn("another phi instance owns the access state for this directory; " +
			"this instance serves the UI but refuses all authentication until it exits")
	}
	found := false
	for _, wsPath := range cfg.Workspaces {
		if wsPath == app.activeCWD {
			found = true
			break
		}
	}
	if !found {
		cfg.Workspaces = append(cfg.Workspaces, app.activeCWD)
		if app.accessManager.StateOwned() {
			app.configStore().SaveLegacy(cfg)
		}
	}

	// Initialize PTY and WebSocket subsystems
	app.pty = pty.NewManager()
	app.coders = coders.NewManagerWithOptions(coders.BuiltinOptions{
		OpenCodeLegacy:        cfg.OpenCodeLegacy,
		OpenCodeCommand:       cfg.OpenCodeCommand,
		OpenCodeLegacyCommand: cfg.OpenCodeLegacyCommand,
		PsiCommand:            cfg.PsiCommand,
	})
	// Load custom backend files from ~/.phi/backends/*.json. Built-ins
	// are already seeded by NewManager; custom profiles patch / add.
	// Per-file failures are logged inside LoadFromDir and skipped so a
	// single malformed file never breaks startup (R3).
	if err := app.coders.LoadFromDir(app.customBackendsDir(), func(s string) { log.Print(s) }); err != nil {
		log.Printf("[backends] failed to load custom backends: %v", err)
	}
	app.rpc = rpc.NewManager()
	// Saved tabs are restored as new live processes after the hub exists.
	// Never deserialize OS process handles or publish nil-PTY ghosts.
	if err := app.loadSyncStore(); err != nil {
		log.Printf("[sync] Failed to load sync store state: %v", err)
	}
	app.pty.StartIdleWatcher(func(info pty.IdleNotification) {
		cfg := app.configStore().Load()
		host := ReportedHostname(cfg)

		projName := filepath.Base(info.Workspace)
		if projName == "." || projName == "" || projName == "/" || projName == "\\" {
			if info.Cwd != "" {
				projName = filepath.Base(info.Cwd)
			} else {
				projName = "phi"
			}
		}

		colorEmoji := ThemeEmoji(cfg.ThemeColor)
		durationStr := info.Duration.Truncate(time.Second).String()

		notifTitle := fmt.Sprintf("[%s] %s @ %s %s", info.Coder, projName, host, colorEmoji)
		notifMsg := fmt.Sprintf("⚡ Task Finished (took %s)\n🤖 Session: %s\n📁 Project: %s\n💻 Host: %s",
			durationStr, info.Title, projName, host)

		if cfg.PushoverEnabled && cfg.PushoverUserKey != "" && cfg.PushoverAppToken != "" {
			_ = SendPushoverNotification(cfg.PushoverUserKey, cfg.PushoverAppToken, notifTitle, notifMsg)
		}
		if cfg.WebhookEnabled && cfg.WebhookURL != "" {
			_ = SendWebhookNotification(cfg.WebhookURL, notifTitle, notifMsg)
		}
		if cfg.SimplepushEnabled && cfg.SimplepushKey != "" {
			_ = SendSimplepushNotification(cfg.SimplepushKey, notifTitle, notifMsg, "phi_idle")
		}
	})
	app.startOpenCodeIdleWatcher()
	app.hub = ws.NewHub(*cfg.ReplayBufferBytes)
	app.git.StartReadLoop = func(inst *pty.PTYInstance) { ws.StartPTYReadLoop(inst, app.hub) }
	// Adopt the generation loaded from config so the first upgrade is admitted
	// and later password changes fence older sockets.
	app.hub.RotateAuth(app.accessManager.AccessGeneration())
	// Re-check every socket admission against live auth state: a family
	// revocation or an expiring token between the middleware decision and the
	// upgrade must refuse the connection rather than serve it.
	app.hub.SetAuthValidator(app.accessManager.AdmitsFence)
	if err := app.hub.SetRecordingDirectory(filepath.Join(system.PhiDataDir(), "recordings")); err != nil {
		slog.Error("terminal recording directory unavailable", "err", err)
	}
	app.attachmentStore, err = attachments.OpenAttachmentStore()
	if err != nil {
		slog.Warn("Pi attachments unavailable", "err", err)
		app.attachmentStore = nil
	}
	app.attachmentAPI.Store = app.attachmentStore

	// The Pi bridge serves before saved Pi tabs restore so relaunched
	// panes provision against a live listener. A nil bridge (listener
	// failure) leaves every launch on the unmanaged path.
	app.bridge = piapp.StartBridge(app.hub, app.options.PiRuntime, app.options.PiVersion, app.attachmentStore)
	if app.bridge != nil {
		app.bridge.Syncboard = http.HandlerFunc(app.handleSyncMessages)
		app.bridge.LoadConfig = app.configStore().LoadWithError
	}
	app.restoreSavedTabs()
	// No retention sweep runs: the v3 journal never evicts, and the
	// retired v2 sweep must not touch pre-upgrade files. Expiry for
	// closed v3 panes arrives with the VT removal.
	app.titles = NewPiTerminalTitleService(app.pty, app.hub)
	app.titles.Start()

	// Markdown watcher: fswatch over the resolved markdownDirs of every
	// live pane cwd. Fires a markdown-changed Notification so open UIs
	// can silently refresh the md file list. Watch set follows panes, not
	// browsers: a worktree nobody has a pane in is not covered (accepted
	// edge).
	app.mdWatcher, err = fswatch.New(app.markdownWatchDirs, func(dir string) {
		app.hub.BroadcastNotification(&wspb.Notification{
			Kind: &wspb.Notification_MarkdownChanged{MarkdownChanged: &wspb.MarkdownChanged{
				Dir: proto.String(dir),
			}},
		})
	})
	if err != nil {
		slog.Warn("fswatch unavailable; markdown panel won't live-update", "err", err)
	} else {
		app.mdWatcher.Filter = fswatch.ExtFilter(".md")
		app.mdWatcher.Start()
	}

	// Without --web, use embedded assets from any working directory.
	// Ordinary builds embed web/ raw; release builds decompress webdist/.
	if app.static == nil {
		root, precompressed, subErr := app.options.Assets()
		if subErr != nil {
			slog.Error("failed to load embedded web assets", "err", subErr)
			return subErr
		}
		// compression_enabled is captured once here; toggling it needs a restart.
		app.static = webassets.New(root, precompressed, cfg.CompressionEnabled)
	}

	// API routing lives with the handlers.
	app.Handler()

	// Start fleet poller with current peer config
	app.startFleetPoller()

	// Start update checker (release builds only; dev builds hide the badge anyway).
	if app.buildSource == "release" {
		app.updateChecker = update.NewChecker(app.version, update.DetectInstallMethod(app.buildSource))
		app.updateChecker.LoadCache()
		go obs.DoFeature("updates", func(_ context.Context) {
			// Stagger startup so we don't hammer GitHub on cold boot.
			time.Sleep(30 * time.Second)
			app.runGatedUpdateCheck(app.updateChecker, "Initial check")

			// Re-check hourly; CheckIfStale/ShouldRunRealCheck gate the actual network call.
			ticker := time.NewTicker(1 * time.Hour)
			for range ticker.C {
				app.runGatedUpdateCheck(app.updateChecker, "Periodic check")
			}
		})

		// Construct the applier so /api/update/apply + /api/update/progress
		// work, even though only npm/standalone installs can use them.
		app.updateApplier = update.NewApplier(app.version, update.DetectInstallMethod(app.buildSource))
		app.installUpdater(app.updateChecker, app.updateApplier)

		// Best-effort cleanup of stale .old, delayed so operators can run `phi --rollback`.
		go func() {
			if removed, err := update.ScheduleOldBinaryCleanup(); err != nil {
				log.Printf("[update] CleanupOldBinary: %v", err)
			} else if removed != "" {
				log.Printf("[update] Removed stale previous binary: %s", removed)
			}
		}()
	}

	closeDiagnostics := app.startPrivateDiagnostics(app.options.DiagnosticsDir)
	defer closeDiagnostics()

	// Bind phase. Banner prints AFTER successful binds so it only
	// advertises URLs we actually serve.
	var listeners []net.Listener
	var boundAddrs []bindaddr.Addr

	if app.options.IP == "lan" {
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
			addr := net.JoinHostPort(a.IP.String(), strconv.Itoa(app.options.Port))
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
			return fmt.Errorf("failed to bind any detected interface on port %d", app.options.Port)
		}
	} else {
		// Explicit --ip (0.0.0.0, a specific address, hostname, etc.).
		// Preserves the pre-existing single-listener behavior.
		addr := net.JoinHostPort(app.options.IP, strconv.Itoa(app.options.Port))
		ln, err := restart.BindWithRetry(addr, 5*time.Second, 100*time.Millisecond)
		if err != nil {
			return fmt.Errorf("failed to bind %s: %w", addr, err)
		}
		listeners = append(listeners, ln)
		// Classify for banner labelling. Anything that's an IP we can
		// parse goes through bindaddr.IsAllowed-equivalent checks; for
		// hostnames/0.0.0.0 we fall back to a generic LAN label.
		parsed := net.ParseIP(app.options.IP)
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

	if app.bridge != nil {
		app.bridge.SetListenerAddr(listeners[0].Addr())
	}
	app.port = listeners[0].Addr().(*net.TCPAddr).Port
	if app.options.OnListen != nil {
		app.options.OnListen(cfg, boundAddrs, app.port)
	}
	servers, errCh := app.serveAll(listeners)
	remaining := len(servers)
	var last error
	select {
	case <-ctx.Done():
	case last = <-errCh:
		remaining--
	}
	ptyGrace, httpGrace := 5*time.Second, 15*time.Second
	if isInteractiveTTY() {
		ptyGrace, httpGrace = time.Second, time.Second
	}
	app.gracefulShutdown(servers, envDuration("PHI_SHUTDOWN_DRAIN", 0), envDuration("PHI_SHUTDOWN_PTY_GRACE", ptyGrace), envDuration("PHI_SHUTDOWN_GRACE", httpGrace))
	for ; remaining > 0; remaining-- {
		if err := <-errCh; err != nil {
			last = err
		}
	}
	if last != nil {
		return fmt.Errorf("listener exited: %w", last)
	}
	return nil
}

// runGatedUpdateCheck runs one check if due (CheckIfStale + ShouldRunRealCheck gate it).
func (app *Server) runGatedUpdateCheck(checker *update.Checker, label string) {
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
			label, app.version, result.Latest, result.Latest != app.version)
	}
}

// serveAll starts one HTTP server per listener over this application's handler.
// It publishes the handles immediately so shutdown can drain active requests.
// Each listener reports its result once; ErrServerClosed is a clean stop.
func (app *Server) serveAll(listeners []net.Listener) ([]*http.Server, <-chan error) {
	handler := app.Handler()
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
//  1. app.shuttingDown = true (so /readyz returns 503 and k8s removes us
//     from the service endpoints pool).
//  2. app.pty.BeginDrain() (so new spawn requests are rejected during
//     the drain window).
//  3. sleep drainDelay (k8s picks up the 503 and stops sending traffic).
//  4. flush state to disk (so a restart picks up where we left off).
//  5. app.hub.BroadcastShutdown (tell browsers to show the bulk-disconnect
//     banner).
//  6. small sleep (lets the WS 0x05 frame flush; matches current
//     behavior).
//  7. app.pty.Shutdown(ptyGrace) — SIGTERM each agent, wait bounded
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

func (app *Server) gracefulShutdown(servers []*http.Server, drainDelay, ptyGrace, grace time.Duration) {
	app.shuttingDown.Store(true) // /readyz -> 503
	app.stopOpenCodeIdleWatcher()
	if app.mdWatcher != nil {
		app.mdWatcher.Close()
	}
	if app.pty != nil {
		app.pty.BeginDrain() // reject new PTY spawns for the whole drain window
	}
	if app.titles != nil {
		app.titles.Close()
	}
	if drainDelay > 0 {
		time.Sleep(drainDelay)
	}
	if err := app.flushStateForRestart(); err != nil {
		slog.Error("shutdown flush failed", "err", err)
	}
	if app.hub != nil {
		app.hub.BroadcastShutdown("shutdown")
	}
	time.Sleep(200 * time.Millisecond) // let the WS 0x05 frame flush
	if app.pty != nil {
		app.pty.Shutdown(ptyGrace)
		// Native exit notices can publish the exact resume ID during drain.
		readCtx, readCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		app.pty.WaitForReadLoops(readCtx)
		readCancel()
		if err := app.pty.FlushSaveState(); err != nil {
			slog.Error("shutdown tab snapshot", "err", err)
		}
	}
	// Pi RPC children are separate processes: kill them with the server so a
	// restart never leaves an orphaned Pi session behind.
	if app.rpc != nil {
		for _, inst := range app.rpc.List() {
			inst.Kill()
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
				_ = s.Close()
			}
		}(srv)
	}
	wg.Wait()
}
