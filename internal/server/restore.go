package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/hypernewbie/phi/internal/config"
	"github.com/hypernewbie/phi/internal/piapp"
	"github.com/hypernewbie/phi/pkg/coders"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/ws"
)

type terminalLaunchError struct {
	status int
	err    error
}

func (e terminalLaunchError) Error() string { return e.err.Error() }

// One launch path for normal requests and restored tabs. Backend policy lives
// in the registry/adapters; restoration only supplies saved tab intent.
func (app *Server) spawnTerminal(ctx context.Context, c coders.Coder, req SpawnRequest, cfg config.Config, opts pty.SpawnOptions, probe bool) (*pty.PTYInstance, error) {
	bad := func(err error) (*pty.PTYInstance, error) { return nil, terminalLaunchError{http.StatusBadRequest, err} }
	if err := coders.VerifyOpenCode(ctx, c); err != nil {
		return bad(err)
	}
	// The selected agent must fail rather than silently run the other one,
	// and its settings must be launchable. This check sits in the shared spawn
	// path so hand-edited config and restores are covered, and it runs before
	// bridge provisioning or platform wrapping.
	if c.ID == "pi" {
		mode := effectivePiMode(c)
		settings := launchSettingsFor(cfg, mode)
		if err := validateLaunchFields(mode, settings); err != nil {
			return bad(err)
		}
		// Psi must be installed before a pane claims to be Psi. Pi's empty
		// setting keeps the registry default, which the existing spawn error
		// already reports, so only a configured Pi command is looked up here.
		if mode == piModePsi || settings.Command != "" {
			if err := checkExecutable(mode, settings.Command); err != nil {
				return bad(err)
			}
		}
	}
	if c.SessionSource == "opencode_v2" && req.SessionID != "" {
		if err := session.ValidateOpenCodeV2Resume(ctx, c, req.SessionID); err != nil {
			return bad(err)
		}
	}
	// Pi writes its session file only once the first message is sent. A pane
	// that was opened but never used keeps an ID that cannot be resumed, and
	// `pi --session <id>` exits with "No session found matching". Treat a
	// missing Pi session as fresh instead of launching a dead pane; the UI
	// restart sends the pane's ID back through this same path. Psi keeps its
	// own behaviour because its session storage is not Pi's file store.
	if c.ID == "pi" && c.SessionSource == "pi_files" && effectivePiMode(c) == piModePi && req.SessionID != "" {
		cwd := req.Cwd
		if cwd == "" {
			cwd = c.DefaultCwd
		}
		if cwd == "" {
			cwd = app.activeCWD
		}
		if !piSessionExists(cwd, req.SessionID) {
			log.Printf("[spawn] pi session %q is not saved for %s; starting fresh", req.SessionID, cwd)
			req.SessionID = ""
		}
	}
	id := req.SessionID
	if id == "" {
		c, id = coders.FreshSession(c)
	}
	// Bridge provisioning precedes launch resolution so credentials and
	// extension args enter the plan. The pane ID is fixed up front for
	// managed coders; SpawnWithOptions adopts an explicit opts.ID.
	var bridgeEnv map[string]string
	var bridgeExtArgs []string
	bridge := app.bridgeOrNil()
	managedPane := bridge != nil && piapp.ForCoder(c.ID)
	if managedPane {
		if opts.ID == "" {
			opts.ID = pty.GenerateID()
		}
		var managed bool
		bridgeEnv, bridgeExtArgs, managed = bridge.Provision(opts.ID, !cfg.PiBridgeNoInject && piBridgeInjectsExtension(c))
		_ = managed // recorded; the launch proceeds on either path
	}
	revokeBridge := func() {
		if managedPane && opts.ID != "" {
			bridge.RevokePane(opts.ID)
		}
	}
	plan, err := coders.ResolveLaunch(c, coders.SpawnRequest{Coder: req.Coder, Cwd: req.Cwd, SessionID: req.SessionID, ExtraArgs: req.ExtraArgs, ExtensionArgs: bridgeExtArgs}, coders.LaunchOptions{
		Config: coders.ConfigView{PiOffline: cfg.PiOffline, ClaudeDangerouslySkipPermissions: cfg.ClaudeDangerouslySkipPermissions}, DefaultCwd: app.activeCWD,
	})
	if err != nil {
		revokeBridge()
		return bad(err)
	}
	opts.Title, opts.Workspace, opts.OpenCodeMode = req.Title, req.Workspace, c.OpenCodeMode
	opts.PiMode = c.PiMode
	if c.ID == "pi" {
		// Store the resolved agent so a saved tab restores the same one even
		// after the default changes.
		opts.PiMode = effectivePiMode(c)
	}
	opts.Cols, opts.Rows = req.Cols, req.Rows
	opts.ExtraArgs = req.ExtraArgs
	var inst *pty.PTYInstance
	nativeObserver := session.ResumeReferenceObserver(c, func(nativeID string) { app.pty.BindSession(inst, nativeID) })
	firstOutput := make(chan struct{})
	outputSeen := false
	opts.ObserveOutput = func(data []byte) {
		if !outputSeen {
			outputSeen = true
			close(firstOutput)
		}
		if nativeObserver != nil {
			nativeObserver(data)
		}
	}
	inst, err = app.pty.SpawnWithOptions(ctx, plan.Cwd, plan.Command, plan.Args, c.ID, id, opts, plan.Env, bridgeEnv)
	if err != nil {
		revokeBridge()
		return nil, terminalLaunchError{http.StatusInternalServerError, err}
	}
	if managedPane {
		bridge.Complete(inst)
	}
	if app.titles != nil {
		app.titles.Register(inst)
	}
	// Open the journal with the actual PTY geometry and record the
	// restored size before the read loop admits new output. Failures
	// are not fatal: Ingest retries the open until storage recovers.
	if err := app.hub.InitPaneJournal(inst.ID, inst.Pty.Cols, inst.Pty.Rows); err != nil {
		log.Printf("[ws] pane %s: terminal journal open failed; ingest will retry: %v", inst.ID, err)
	} else if req.Cols != 0 && req.Rows != 0 {
		if err := app.hub.RecordRestoreGeometry(inst.ID, req.Cols, req.Rows); err != nil {
			log.Printf("[ws] pane %s: terminal restore geometry failed: %v", inst.ID, err)
		}
	}
	ws.StartPTYReadLoop(inst, app.hub)
	if probe {
		// Catch immediate CLI resume/config failures before publishing a dead
		// process as a restored tab. A failure does not block other tabs.
		// A child can take time to receive its first scheduling slice.
		// Start the probe after its first output, not after fork/exec.
		select {
		case <-firstOutput:
		case <-inst.Pty.Closed:
			_ = app.pty.Kill(inst.ID)
			revokeBridge() // synchronous: the restore retry reuses this tab ID
			return nil, fmt.Errorf("backend exited before restoration (code %d)", inst.Pty.ExitCode())
		case <-ctx.Done():
			if inst.IsPtyDead() {
				_ = app.pty.Kill(inst.ID)
				revokeBridge()
				return nil, ctx.Err()
			}
			return inst, nil // a valid silent custom backend
		}
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-inst.Pty.Closed:
			timer.Stop()
			_ = app.pty.Kill(inst.ID)
			revokeBridge()
			return nil, fmt.Errorf("backend exited during restoration (code %d)", inst.Pty.ExitCode())
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			_ = app.pty.Kill(inst.ID)
			revokeBridge()
			return nil, ctx.Err()
		}
	}
	session.AfterSpawn(c, id, plan.Cwd)
	return inst, nil
}

var savedPaneID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

func (app *Server) restoreSavedTabs() {
	tabs, err := pty.ReadSavedTabs()
	if err != nil {
		log.Printf("[tabs] cannot read saved tabs; continuing startup: %v", err)
		return
	}
	app.pty.BeginRestore()
	defer app.pty.EndRestore()
	pty.SortSavedTabs(tabs)
	seen := map[string]bool{}
	jobs := make(chan pty.SavedTab)
	var workers sync.WaitGroup
	// Bounded parallel startup: slow/broken native history must not hold up
	// every other backend or require a separate supervisor process.
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for tab := range jobs {
				app.restoreSavedTab(tab)
			}
		}()
	}
	for _, tab := range tabs {
		if !savedPaneID.MatchString(tab.ID) || seen[tab.ID] || tab.Coder == "diff" || tab.Coder == "git-log" || tab.Coder == "git-status" {
			continue
		}
		seen[tab.ID] = true
		jobs <- tab
	}
	close(jobs)
	workers.Wait()
	if err := app.pty.FlushSaveState(); err != nil {
		log.Printf("[tabs] restore snapshot: %v", err)
	}
}

func (app *Server) restoreSavedTab(tab pty.SavedTab) {
	cfg := app.loadConfig()
	c, known := app.coders.Get(tab.Coder)
	if !known {
		c = app.coders.MustGet("bash")
	}
	if known && c.ID == "opencode" {
		// The registry chooses the default for NEW panes, not the generation
		// of a saved pane. Separate configured executables remain authoritative.
		if (tab.OpenCodeMode == "legacy") != (c.OpenCodeMode == "legacy") {
			c = coders.NewManagerWithOptions(coders.BuiltinOptions{OpenCodeLegacy: tab.OpenCodeMode == "legacy", OpenCodeCommand: cfg.OpenCodeCommand, OpenCodeLegacyCommand: cfg.OpenCodeLegacyCommand}).MustGet("opencode")
		}
		if tab.OpenCodeMode == "mini" {
			if mini, err := coders.OpenCodeMini(c); err == nil {
				c = mini
			}
		}
		if tab.OpenCodeMode == "tui" && c.OpenCodeMode == "mini" {
			c = coders.OpenCodeTUI(c)
		}
	}
	if known && c.ID == "pi" {
		// A saved pane keeps the agent it was created with; the configured
		// default only affects new panes. Unknown saved modes fall back to Pi.
		savedMode := tab.PiMode
		if !validPiMode(savedMode) {
			savedMode = piModePi
		}
		if selected, err := selectPiLaunch(c, savedMode, false, cfg); err == nil {
			c = selected
		} else {
			log.Printf("[tabs] %s: saved agent unavailable (%v); restoring as Pi", tab.ID, err)
		}
	}
	req := SpawnRequest{Coder: c.ID, Cwd: tab.Cwd, Workspace: tab.Workspace, Title: tab.Title, SessionID: tab.SessionID, ExtraArgs: tab.ExtraArgs}
	if !known || c.IsShell {
		req.SessionID = ""
	}
	if !known {
		req.ExtraArgs = nil
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		req.Cwd = app.activeCWD
	}
	if req.SessionID != "" && c.SessionSource != "none" && c.SessionSource != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		type historyResult struct {
			items []session.Session
			err   error
		}
		history := make(chan historyResult, 1)
		go func() {
			items, err := session.ListSessions(ctx, c, req.Cwd)
			history <- historyResult{items, err}
		}()
		var items []session.Session
		var err error
		select {
		case result := <-history:
			items, err = result.items, result.err
		case <-ctx.Done():
			err = ctx.Err()
		}
		cancel()
		found := false
		for _, item := range items {
			if item.ID == req.SessionID || item.SessionPath == req.SessionID {
				found = true
				break
			}
		}
		if err != nil || !found {
			log.Printf("[tabs] %s: native resume unavailable (%v, found=%t); starting fresh", tab.ID, err, found)
			req.SessionID = ""
		}
	}
	opts := pty.SpawnOptions{ID: tab.ID, Pinned: tab.Pinned, Marked: tab.Marked, PiMode: tab.PiMode}
	attempt := func(profile coders.Coder, probe bool) error {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		_, err := app.spawnTerminal(ctx, profile, req, cfg, opts, probe)
		return err
	}
	if err := attempt(c, true); err == nil {
		return
	} else {
		log.Printf("[tabs] %s: resume launch failed: %v", tab.ID, err)
	}
	req.SessionID = ""
	if err := attempt(c, true); err == nil {
		return
	} else {
		log.Printf("[tabs] %s: backend unavailable: %v; using Shell", tab.ID, err)
	}
	// Last-resort live slot, not a phantom. Do not feed agent flags to a shell.
	req.Coder = "bash"
	req.ExtraArgs = nil
	if err := attempt(coders.NewManager().MustGet("bash"), true); err != nil {
		log.Printf("[tabs] %s: Shell unavailable; continuing startup: %v", tab.ID, err)
	}
}

// piBridgeInjectsExtension reports whether a coder receives the bundled Phi
// bridge extension argument. Native psi speaks the protocol itself, so it
// gets the environment but never --extension.
func piBridgeInjectsExtension(c coders.Coder) bool { return c.PiMode != "psi" }

// piSessionExists reports whether Pi has a saved session with this exact ID
// for the working directory. A listing failure counts as missing: a launch
// must prefer a fresh session over a resume that cannot succeed.
func piSessionExists(cwd, id string) bool {
	sessions, err := session.ListPiSessions(cwd)
	if err != nil {
		return false
	}
	for _, candidate := range sessions {
		if candidate.ID == id {
			return true
		}
	}
	return false
}
