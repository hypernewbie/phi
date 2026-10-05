package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

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
func spawnTerminal(ctx context.Context, c coders.Coder, req SpawnRequest, cfg Config, opts pty.SpawnOptions, probe bool) (*pty.PTYInstance, error) {
	bad := func(err error) (*pty.PTYInstance, error) { return nil, terminalLaunchError{http.StatusBadRequest, err} }
	if err := coders.VerifyOpenCode(ctx, c); err != nil {
		return bad(err)
	}
	if c.SessionSource == "opencode_v2" && req.SessionID != "" {
		if err := session.ValidateOpenCodeV2Resume(ctx, c, req.SessionID); err != nil {
			return bad(err)
		}
	}
	id := req.SessionID
	if id == "" {
		c, id = coders.FreshSession(c)
	}
	plan, err := coders.ResolveLaunch(c, coders.SpawnRequest{Coder: req.Coder, Cwd: req.Cwd, SessionID: req.SessionID, ExtraArgs: req.ExtraArgs}, coders.LaunchOptions{
		Config: coders.ConfigView{PiOffline: cfg.PiOffline, ClaudeDangerouslySkipPermissions: cfg.ClaudeDangerouslySkipPermissions}, DefaultCwd: activeCWD,
	})
	if err != nil {
		return bad(err)
	}
	opts.Title, opts.Workspace, opts.OpenCodeMode = req.Title, req.Workspace, c.OpenCodeMode
	opts.Cols, opts.Rows = req.Cols, req.Rows
	opts.ExtraArgs = req.ExtraArgs
	var inst *pty.PTYInstance
	nativeObserver := session.ResumeReferenceObserver(c, func(nativeID string) { ptyManager.BindSession(inst, nativeID) })
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
	inst, err = ptyManager.SpawnWithOptions(ctx, plan.Cwd, plan.Command, plan.Args, c.ID, id, opts, plan.Env)
	if err != nil {
		return nil, terminalLaunchError{http.StatusInternalServerError, err}
	}
	if req.Cols != 0 && req.Rows != 0 {
		wsHub.RecordResize(inst.ID, req.Cols, req.Rows)
	}
	ws.StartPTYReadLoop(inst, wsHub)
	if probe {
		// Catch immediate CLI resume/config failures before publishing a dead
		// process as a restored tab. A failure does not block other tabs.
		// A child can take time to receive its first scheduling slice.
		// Start the probe after its first output, not after fork/exec.
		select {
		case <-firstOutput:
		case <-inst.Pty.Closed:
			_ = ptyManager.Kill(inst.ID)
			return nil, fmt.Errorf("backend exited before restoration (code %d)", inst.Pty.ExitCode())
		case <-ctx.Done():
			if inst.IsPtyDead() {
				_ = ptyManager.Kill(inst.ID)
				return nil, ctx.Err()
			}
			return inst, nil // a valid silent custom backend
		}
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-inst.Pty.Closed:
			timer.Stop()
			_ = ptyManager.Kill(inst.ID)
			return nil, fmt.Errorf("backend exited during restoration (code %d)", inst.Pty.ExitCode())
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			_ = ptyManager.Kill(inst.ID)
			return nil, ctx.Err()
		}
	}
	session.AfterSpawn(c, id, plan.Cwd)
	return inst, nil
}

var savedPaneID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

func restoreSavedTabs() {
	tabs, err := pty.ReadSavedTabs()
	if err != nil {
		log.Printf("[tabs] cannot read saved tabs; continuing startup: %v", err)
		return
	}
	ptyManager.BeginRestore()
	defer ptyManager.EndRestore()
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
				restoreSavedTab(tab)
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
	if err := ptyManager.FlushSaveState(); err != nil {
		log.Printf("[tabs] restore snapshot: %v", err)
	}
}

func restoreSavedTab(tab pty.SavedTab) {
	cfg := loadConfig()
	c, known := coderManager.Get(tab.Coder)
	if !known {
		c = coderManager.MustGet("bash")
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
	req := SpawnRequest{Coder: c.ID, Cwd: tab.Cwd, Workspace: tab.Workspace, Title: tab.Title, SessionID: tab.SessionID, ExtraArgs: tab.ExtraArgs}
	if !known || c.IsShell {
		req.SessionID = ""
	}
	if !known {
		req.ExtraArgs = nil
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		req.Cwd = activeCWD
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
	opts := pty.SpawnOptions{ID: tab.ID, Pinned: tab.Pinned, Marked: tab.Marked}
	attempt := func(profile coders.Coder, probe bool) error {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		_, err := spawnTerminal(ctx, profile, req, cfg, opts, probe)
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
