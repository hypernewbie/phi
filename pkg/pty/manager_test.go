package pty

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func getTestShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}

func TestManagerLifecycle(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	// Spawn a PTY instance via the manager.
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY instance: %v", err)
	}

	// Retrieve the instance and assert properties.
	retrieved, found := manager.Get(inst.ID)
	if !found {
		t.Fatal("PTY instance not found in manager registry")
	}
	if retrieved.Coder != "shell" {
		t.Errorf("Expected coder to be 'shell', got %q", retrieved.Coder)
	}
	if retrieved.SessionID != "test-session" {
		t.Errorf("Expected session ID to be 'test-session', got %q", retrieved.SessionID)
	}

	// Verify that the instance is in the active list.
	activeList := manager.ListActive()
	if len(activeList) != 1 || activeList[0].ID != inst.ID {
		t.Errorf("Expected 1 active instance in list, got %d", len(activeList))
	}

	// Kill the instance and verify it gets cleaned up.
	if err := manager.Kill(inst.ID); err != nil {
		t.Fatalf("Failed to kill PTY instance: %v", err)
	}

	// Give a tiny window for the closed channel cleanup goroutine to run.
	time.Sleep(100 * time.Millisecond)

	_, foundAfterKill := manager.Get(inst.ID)
	if foundAfterKill {
		t.Error("Expected PTY instance to be removed from manager registry after kill")
	}
}

func TestActiveWSTracking(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Registering an unknown terminal ID should return false.
	if manager.RegisterWS("non-existent-id", "c1") {
		t.Error("Registering non-existent terminal should return false")
	}

	// Register WebSocket connection.
	if !manager.RegisterWS(inst.ID, "c1") {
		t.Fatal("Failed to register WebSocket connection")
	}

	if !inst.ActiveWS {
		t.Error("Expected ActiveWS to be true after registration")
	}

	// Unregister WebSocket connection.
	manager.UnregisterWS(inst.ID, "c1")

	if inst.ActiveWS {
		t.Error("Expected ActiveWS to be false after unregistration")
	}
}

func TestPinningBypass(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// First, register the WS so active is true.
	if !manager.RegisterWS(inst.ID, "c1") {
		t.Fatal("Failed to register WS")
	}

	// Set pinning to true.
	if err := manager.SetPinned(inst.ID, true); err != nil {
		t.Fatalf("SetPinned failed: %v", err)
	}

	if inst.Pinned {
		// Unregister WS. Since the session is pinned, it should bypass the detach timer.
		manager.UnregisterWS(inst.ID, "c1")
	}

	if inst.ActiveWS {
		t.Error("Expected ActiveWS to be false")
	}

	if inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to remain nil for a pinned session")
	}
}

func TestDynamicPinToggle(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Initially unregistered, so no WS connected. Let's make sure it starts unpinned.
	if inst.Pinned {
		t.Error("Expected new session to be unpinned by default")
	}

	// Unregister WS on an unpinned, active session. It should initialise the detach timer.
	manager.UnregisterWS(inst.ID, "c1")

	if !inst.HasDetachTimer() {
		t.Fatal("Expected DetachTimer to be created when unpinned session disconnects")
	}

	// Dynamically toggle pin to true on the disconnected session.
	// This should stop the active detach timer and clear it.
	if err := manager.SetPinned(inst.ID, true); err != nil {
		t.Fatalf("SetPinned to true failed: %v", err)
	}

	if inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to be stopped and cleared after pinning")
	}

	// Dynamically toggle pin back to false on the disconnected session.
	// This should re-initialise the detach timer because the WS is still disconnected.
	if err := manager.SetPinned(inst.ID, false); err != nil {
		t.Fatalf("SetPinned to false failed: %v", err)
	}

	if !inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to be re-created after unpinning disconnected session")
	}
}

func TestSmartGracePeriodRescheduling(t *testing.T) {
	// Backup original timing constants.
	origGracePeriod := GracePeriod
	origThreshold := RecentActivityThreshold

	// Configure short durations to allow quick unit testing.
	GracePeriod = 150 * time.Millisecond
	RecentActivityThreshold = 100 * time.Millisecond

	defer func() {
		GracePeriod = origGracePeriod
		RecentActivityThreshold = origThreshold
	}()

	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Disconnect WS to trigger the grace period timer.
	manager.UnregisterWS(inst.ID, "c1")

	if !inst.HasDetachTimer() {
		t.Fatal("Expected DetachTimer to be active after unregistering WS")
	}

	// Wait briefly, then simulate active terminal output by updating activity.
	time.Sleep(60 * time.Millisecond)
	inst.UpdateActivity()

	// Wait for the original 150ms grace period timer to expire.
	// Since activity was updated recently (90ms ago), it should have rescheduled rather than terminating.
	time.Sleep(120 * time.Millisecond)

	// Assert the instance is still registered and alive.
	_, found := manager.Get(inst.ID)
	if !found {
		t.Error("PTY instance was prematurely killed despite active output")
	}

	if !inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to be rescheduled and non-nil")
	}

	// Wait without calling UpdateActivity to let the rescheduled timer expire and terminate the PTY.
	time.Sleep(200 * time.Millisecond)

	// The instance should still be in the manager registry, but the PTY process should be terminated.
	instAfterIdle, foundAfterIdle := manager.Get(inst.ID)
	if !foundAfterIdle {
		t.Error("Expected PTY instance record to persist in registry")
	} else if instAfterIdle.Pty != nil {
		select {
		case <-instAfterIdle.Pty.Closed:
			// Terminated
		case <-time.After(2 * time.Second):
			t.Error("Expected PTY process to be terminated after grace period expired")
		}
	}
}

func TestGracePeriodActiveWSAndPinned(t *testing.T) {
	origGracePeriod := GracePeriod
	origThreshold := RecentActivityThreshold

	GracePeriod = 100 * time.Millisecond
	RecentActivityThreshold = 50 * time.Millisecond

	defer func() {
		GracePeriod = origGracePeriod
		RecentActivityThreshold = origThreshold
	}()

	manager := NewManager()
	shell, args := getTestShell()

	// Scenario 1: ActiveWS is true when timer expires -> should not kill and should clear timer.
	inst1, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session-1")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst1.ID)
	}()

	manager.UnregisterWS(inst1.ID, "c1") // starts timer
	if !manager.RegisterWS(inst1.ID, "c1") {
		t.Fatal("Failed to register WS")
	}

	time.Sleep(150 * time.Millisecond) // wait for timer to expire

	// Check it is still alive.
	if _, found := manager.Get(inst1.ID); !found {
		t.Error("PTY instance was killed despite ActiveWS being true")
	}

	// Scenario 2: Pinned is true when timer expires -> should not kill and should clear timer.
	inst2, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session-2")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst2.ID)
	}()

	manager.UnregisterWS(inst2.ID, "c1") // starts timer
	if err := manager.SetPinned(inst2.ID, true); err != nil {
		t.Fatalf("Failed to pin: %v", err)
	}

	time.Sleep(150 * time.Millisecond) // wait for timer to expire

	// Check it is still alive.
	if _, found := manager.Get(inst2.ID); !found {
		t.Error("PTY instance was killed despite being pinned")
	}
}

func TestMultipleConcurrentWebSockets(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Register first WS connection.
	if !manager.RegisterWS(inst.ID, "c1") {
		t.Fatal("Failed to register first WS")
	}
	if !inst.ActiveWS || inst.ActiveWSCount != 1 {
		t.Errorf("Expected ActiveWS=true, ActiveWSCount=1, got ActiveWS=%v, ActiveWSCount=%d", inst.ActiveWS, inst.ActiveWSCount)
	}

	// Register second WS connection.
	if !manager.RegisterWS(inst.ID, "c2") {
		t.Fatal("Failed to register second WS")
	}
	if !inst.ActiveWS || inst.ActiveWSCount != 2 {
		t.Errorf("Expected ActiveWS=true, ActiveWSCount=2, got ActiveWS=%v, ActiveWSCount=%d", inst.ActiveWS, inst.ActiveWSCount)
	}

	// Unregister first connection. ActiveWS should remain true, ActiveWSCount should be 1, and no timer should be started.
	manager.UnregisterWS(inst.ID, "c1")
	if !inst.ActiveWS || inst.ActiveWSCount != 1 {
		t.Errorf("Expected ActiveWS=true, ActiveWSCount=1, got ActiveWS=%v, ActiveWSCount=%d", inst.ActiveWS, inst.ActiveWSCount)
	}
	if inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to be nil since one WebSocket connection remains active")
	}

	// Unregister second connection. ActiveWS should now be false, ActiveWSCount should be 0, and a timer should be started.
	manager.UnregisterWS(inst.ID, "c2")
	if inst.ActiveWS || inst.ActiveWSCount != 0 {
		t.Errorf("Expected ActiveWS=false, ActiveWSCount=0, got ActiveWS=%v, ActiveWSCount=%d", inst.ActiveWS, inst.ActiveWSCount)
	}
	if !inst.HasDetachTimer() {
		t.Error("Expected DetachTimer to be active after all WebSockets have disconnected")
	}
}

func TestWSIdempotency(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Register first WS connection.
	if !manager.RegisterWS(inst.ID, "c1") {
		t.Fatal("Failed to register WS")
	}
	// Register same WS connection again (e.g. retry/double connect). ActiveWSCount should remain 1.
	if !manager.RegisterWS(inst.ID, "c1") {
		t.Fatal("Failed to register WS again")
	}

	if inst.ActiveWSCount != 1 {
		t.Errorf("Expected ActiveWSCount=1 under idempotent registration, got %d", inst.ActiveWSCount)
	}

	// Unregister same WS connection. ActiveWSCount should become 0.
	manager.UnregisterWS(inst.ID, "c1")
	if inst.ActiveWSCount != 0 {
		t.Errorf("Expected ActiveWSCount=0 after unregistering, got %d", inst.ActiveWSCount)
	}

	// Unregister again. ActiveWSCount should remain 0 and not decrement further.
	manager.UnregisterWS(inst.ID, "c1")
	if inst.ActiveWSCount != 0 {
		t.Errorf("Expected ActiveWSCount=0 after duplicate unregistration, got %d", inst.ActiveWSCount)
	}
}

func TestStartIdleWatcher(t *testing.T) {
	manager := NewManager()

	// Use a real PTY so the idle watcher treats this as a live session.
	// (Dead/restored tabs with Pty=nil are skipped — the restore banner
	// flow handles those separately; see LoadState.)
	shell, args := getTestShell()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "pi", "test-idle-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY instance: %v", err)
	}
	defer func() { _ = manager.Kill(inst.ID) }()

	// Drive the instance into an idle state directly. UpdateActivity sets
	// Busy=true at time=now; we then rewind BusyStartTime + LastOutputAt
	// so the idle threshold (>3s) trips on the next watcher tick.
	inst.UpdateActivity()
	inst.mu.Lock()
	inst.Coder = "pi"
	inst.Title = "Test Pi Session"
	inst.IsBusy = true
	inst.Busy = true
	inst.BusyStartTime = time.Now().Add(-10 * time.Second)
	inst.LastOutputAt = time.Now().Add(-4 * time.Second)
	inst.NotifiedIdle = false
	inst.mu.Unlock()

	called := make(chan bool, 1)
	manager.StartIdleWatcher(func(info IdleNotification) {
		if info.PaneID == inst.ID && info.Title == "Test Pi Session" && info.Coder == "pi" {
			called <- true
		}
	})

	select {
	case <-called:
		// Success
	case <-time.After(3 * time.Second):
		t.Fatal("StartIdleWatcher callback was not invoked within 3 seconds")
	}

	inst.mu.Lock()
	if inst.IsBusy {
		t.Error("Expected IsBusy to be set to false after idle watcher run")
	}
	if !inst.NotifiedIdle {
		t.Error("Expected NotifiedIdle to be set to true")
	}
	inst.mu.Unlock()

	// Test excluded coder (bash)
	instBash := &PTYInstance{
		ID:            "test-bash-id",
		Coder:         "bash",
		Title:         "Test Shell Session",
		IsBusy:        true,
		BusyStartTime: time.Now().Add(-10 * time.Second),
		LastOutputAt:  time.Now().Add(-4 * time.Second),
	}
	manager.mu.Lock()
	manager.instances[instBash.ID] = instBash
	manager.mu.Unlock()

	bashCalled := false
	manager.StartIdleWatcher(func(info IdleNotification) {
		if info.PaneID == "test-bash-id" {
			bashCalled = true
		}
	})

	time.Sleep(2500 * time.Millisecond)
	if bashCalled {
		t.Error("IdleWatcher should not trigger for excluded coder 'bash'")
	}
}

func TestManagerPersistence(t *testing.T) {
	tmpDir := t.TempDir()
	testTabsPath = filepath.Join(tmpDir, "tabs-test.json")
	defer func() { testTabsPath = "" }()

	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "persist-test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY instance: %v", err)
	}

	// Spawn() schedules a debounced save (plan §3.3: 500ms). Force the
	// flush synchronously so the test doesn't race the timer.
	if err := manager.FlushSaveState(); err != nil {
		t.Fatalf("FlushSaveState after Spawn: %v", err)
	}

	if _, err := os.Stat(testTabsPath); err != nil {
		t.Errorf("Expected tabs state file to be created: %v", err)
	}

	// Create a new manager and load state
	manager2 := NewManager()
	if err := manager2.LoadState(); err != nil {
		t.Fatalf("Failed to load state: %v", err)
	}

	inst2, found := manager2.Get(inst.ID)
	if !found {
		t.Fatal("Failed to retrieve restored PTY instance")
	}
	if inst2.SessionID != "persist-test-session" {
		t.Errorf("Expected restored session ID 'persist-test-session', got %q", inst2.SessionID)
	}
	if inst2.Pty != nil {
		t.Error("Restored PTY instance should have Pty = nil (dead process)")
	}

	// Kill the instance in first manager to clean up resources
	if err := manager.Kill(inst.ID); err != nil {
		t.Errorf("Failed to kill instance: %v", err)
	}
}

// TestManagerScheduleSaveDebounce verifies that rapid Spawn/Kill calls
// coalesce into a single file write via the 500ms debounce (plan §3.3).
func TestManagerScheduleSaveDebounce(t *testing.T) {
	tmpDir := t.TempDir()
	testTabsPath = filepath.Join(tmpDir, "tabs-debounce.json")
	defer func() { testTabsPath = "" }()

	manager := NewManager()
	shell, args := getTestShell()

	// Three rapid mutations before the debounce fires.
	for i := 0; i < 3; i++ {
		_, err := manager.Spawn(context.Background(), "", shell, args, "shell", "debounce-test")
		if err != nil {
			t.Fatalf("Spawn %d: %v", i, err)
		}
	}

	// File should NOT exist yet (debounce timer hasn't fired).
	if _, err := os.Stat(testTabsPath); err == nil {
		t.Error("expected tabs file to NOT exist before debounce flush, but it does")
	}

	// Flush the debounce.
	if err := manager.FlushSaveState(); err != nil {
		t.Fatalf("FlushSaveState: %v", err)
	}

	// Now the file should exist.
	if _, err := os.Stat(testTabsPath); err != nil {
		t.Errorf("expected tabs file after FlushSaveState: %v", err)
	}

	// Cleanup
	list := manager.ListActive()
	for _, inst := range list {
		_ = manager.Kill(inst.ID)
	}
}

// TestManagerLoadStateSkipsPtyNil verifies that tabs.json does NOT
// persist Pty=nil entries (dead/restored tabs) and that LoadState
// always resets Busy + LastOutputAt so the idle watcher doesn't fire
// on tabs that just came back from disk.
func TestManagerLoadStateSuppressesIdle(t *testing.T) {
	tmpDir := t.TempDir()
	testTabsPath = filepath.Join(tmpDir, "tabs-idle.json")
	defer func() { testTabsPath = "" }()

	// Hand-craft a tabs.json that has Busy=true and LastOutputAt at zero.
	payload := `[
		{
			"id": "ghost-tab",
			"coder": "pi",
			"session_id": "ghost",
			"cwd": "",
			"title": "ghost",
			"workspace": "",
			"pinned": false,
			"marked": false,
			"last_activity_unix": 0,
			"busy": true
		}
	]`
	if err := os.WriteFile(testTabsPath, []byte(payload), 0644); err != nil {
		t.Fatalf("write tabs: %v", err)
	}

	manager := NewManager()
	if err := manager.LoadState(); err != nil {
		t.Fatalf("LoadState: %v", err)
	}

	inst, ok := manager.Get("ghost-tab")
	if !ok {
		t.Fatal("expected ghost-tab to be in registry after LoadState")
	}
	if inst.Pty != nil {
		t.Error("loaded tab should have Pty=nil (process is dead)")
	}
	inst.mu.Lock()
	busy := inst.Busy
	isBusy := inst.IsBusy
	notified := inst.NotifiedIdle
	inst.mu.Unlock()
	if busy || isBusy {
		t.Errorf("loaded tab should not be Busy (was busy=true in JSON), got busy=%v isBusy=%v", busy, isBusy)
	}
	if !notified {
		t.Error("loaded tab should have NotifiedIdle=true so idle watcher skips it on startup")
	}
}

// TestIsPtyDead_GhostAndLive: nil-Pty ghost → true, live shell → false.
func TestIsPtyDead_GhostAndLive(t *testing.T) {
	ghost := &PTYInstance{ID: "ghost", Pty: nil}
	if !ghost.IsPtyDead() {
		t.Error("expected IsPtyDead() == true for a nil-Pty ghost instance")
	}

	manager := NewManager()
	shell, args := getTestShell()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "isptydead-live")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	defer func() { _ = manager.Kill(inst.ID) }()

	if inst.IsPtyDead() {
		t.Error("expected IsPtyDead() == false immediately after spawning a live shell")
	}
}

// TestIsPtyDead_DiedInPlace: naturally-exited process (not Kill'd) must be detected + excluded from SaveState.
func TestIsPtyDead_DiedInPlace(t *testing.T) {
	tmpDir := t.TempDir()
	testTabsPath = filepath.Join(tmpDir, "tabs-died-in-place.json")
	t.Cleanup(func() { testTabsPath = "" })

	manager := NewManager()
	shell, args := getTestShell()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "died-in-place-session")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() {
		_ = manager.Kill(inst.ID)
		_ = manager.FlushSaveState()
	})
	if err := manager.FlushSaveState(); err != nil {
		t.Fatalf("FlushSaveState: %v", err)
	}

	if inst.IsPtyDead() {
		t.Fatal("freshly spawned shell should not report dead yet")
	}

	// Exit naturally (not via Kill, so the record stays in the registry).
	go func() { _, _ = io.Copy(io.Discard, inst.Pty) }()
	if _, err := inst.Pty.Write([]byte("exit\r\n")); err != nil {
		t.Fatalf("failed to write exit command: %v", err)
	}

	select {
	case <-inst.Pty.Closed:
		// process exited naturally, as expected
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for shell to exit after 'exit' command")
	}

	if !inst.IsPtyDead() {
		t.Error("expected IsPtyDead() == true after the process exited naturally")
	}

	// Instance must still be in the registry (Spawn doesn't remove on natural death).
	if _, found := manager.Get(inst.ID); !found {
		t.Fatal("expected died-in-place instance to remain in the registry")
	}

	// SaveState must now skip this instance even though inst.Pty != nil.
	if err := manager.FlushSaveState(); err != nil {
		t.Fatalf("FlushSaveState: %v", err)
	}

	b, err := os.ReadFile(testTabsPath)
	if err != nil {
		t.Fatalf("reading tabs file: %v", err)
	}
	var persisted []map[string]interface{}
	if err := json.Unmarshal(b, &persisted); err != nil {
		t.Fatalf("unmarshal persisted tabs: %v", err)
	}
	for _, p := range persisted {
		if p["id"] == inst.ID {
			t.Errorf("died-in-place instance %s should NOT be persisted to tabs.json, found: %v", inst.ID, p)
		}
	}
}

// TestManagerShutdown_GracefulTerminatesAndCleansUp spawns a live shell PTY,
// calls Shutdown, and asserts the process is gone, Pty.Closed is closed, and
// the per-PTY shim temp dir was removed (the reordered pty.go exit goroutine
// removes it BEFORE closing Closed, so this ordering is guaranteed).
func TestManagerShutdown_GracefulTerminatesAndCleansUp(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "shutdown-test")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	tempDir := filepath.Dir(inst.Pty.ClipboardFile())
	if _, err := os.Stat(tempDir); err != nil {
		t.Fatalf("expected shim temp dir to exist before shutdown: %v", err)
	}

	manager.Shutdown(2 * time.Second)

	// Shutdown's wait is bounded by 2x grace and returns even when a child is
	// still winding down, so the cleanup it triggers is asynchronous by
	// contract. Assert the end state by polling rather than assuming it landed
	// before Shutdown returned: a loaded CI runner overruns the 4s bound, which
	// made this fail intermittently at exactly the deadline.
	deadline := time.Now().Add(15 * time.Second)
	for {
		closed := false
		select {
		case <-inst.Pty.Closed:
			closed = true
		default:
		}
		_, statErr := os.Stat(tempDir)
		if closed && os.IsNotExist(statErr) {
			return
		}
		if time.Now().After(deadline) {
			if !closed {
				t.Error("expected inst.Pty.Closed to be closed after Shutdown")
			}
			if !os.IsNotExist(statErr) {
				t.Errorf("expected shim temp dir to be removed after Shutdown, stat err=%v", statErr)
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// TestManagerShutdown_KillsStragglers spawns a child that ignores SIGTERM
// (trap ” TERM) and confirms Shutdown still returns within its grace window
// by escalating to SIGKILL, and that the straggler's temp dir is still
// cleaned up afterward.
func TestManagerShutdown_KillsStragglers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("trap/SIGTERM semantics are Unix-only; Windows Terminate() always hard-kills")
	}

	manager := NewManager()
	inst, err := manager.Spawn(context.Background(), "", "bash", []string{"--norc", "--noprofile", "-c", "trap '' TERM; sleep 1000"}, "shell", "straggler-test")
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	tempDir := filepath.Dir(inst.Pty.ClipboardFile())

	start := time.Now()
	manager.Shutdown(300 * time.Millisecond)
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Errorf("Shutdown took too long waiting on a SIGTERM-ignoring straggler: %v", elapsed)
	}

	select {
	case <-inst.Pty.Closed:
		// SIGKILLed and cleaned up, as expected
	default:
		t.Error("expected inst.Pty.Closed to be closed after Shutdown SIGKILLed the straggler")
	}

	if _, err := os.Stat(tempDir); !os.IsNotExist(err) {
		t.Errorf("expected shim temp dir to be removed after straggler is SIGKILLed, stat err=%v", err)
	}
}

// TestBeginDrain_RejectsNewSpawns confirms that once BeginDrain has been
// called, Spawn rejects with ErrShuttingDown and creates no instance —
// closing the spawn-during-drain leak at the Manager.Spawn choke point.
func TestBeginDrain_RejectsNewSpawns(t *testing.T) {
	manager := NewManager()
	manager.BeginDrain()

	shell, args := getTestShell()
	inst, err := manager.Spawn(context.Background(), "", shell, args, "shell", "drain-test")
	if !errors.Is(err, ErrShuttingDown) {
		t.Errorf("expected ErrShuttingDown, got %v", err)
	}
	if inst != nil {
		t.Errorf("expected nil instance on rejected spawn, got %+v", inst)
	}
	if len(manager.ListActive()) != 0 {
		t.Errorf("expected no instances to be created during drain, got %d", len(manager.ListActive()))
	}
}
