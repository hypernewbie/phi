package pty

import (
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
	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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

	if inst.DetachTimer != nil {
		t.Error("Expected DetachTimer to remain nil for a pinned session")
	}
}

func TestDynamicPinToggle(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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

	if inst.DetachTimer == nil {
		t.Fatal("Expected DetachTimer to be created when unpinned session disconnects")
	}

	// Dynamically toggle pin to true on the disconnected session.
	// This should stop the active detach timer and clear it.
	if err := manager.SetPinned(inst.ID, true); err != nil {
		t.Fatalf("SetPinned to true failed: %v", err)
	}

	if inst.DetachTimer != nil {
		t.Error("Expected DetachTimer to be stopped and cleared after pinning")
	}

	// Dynamically toggle pin back to false on the disconnected session.
	// This should re-initialise the detach timer because the WS is still disconnected.
	if err := manager.SetPinned(inst.ID, false); err != nil {
		t.Fatalf("SetPinned to false failed: %v", err)
	}

	if inst.DetachTimer == nil {
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

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY: %v", err)
	}
	defer func() {
		_ = manager.Kill(inst.ID)
	}()

	// Disconnect WS to trigger the grace period timer.
	manager.UnregisterWS(inst.ID, "c1")

	if inst.DetachTimer == nil {
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

	if inst.DetachTimer == nil {
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
		default:
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
	inst1, err := manager.Spawn("", shell, args, "shell", "test-session-1")
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
	inst2, err := manager.Spawn("", shell, args, "shell", "test-session-2")
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

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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
	if inst.DetachTimer != nil {
		t.Error("Expected DetachTimer to be nil since one WebSocket connection remains active")
	}

	// Unregister second connection. ActiveWS should now be false, ActiveWSCount should be 0, and a timer should be started.
	manager.UnregisterWS(inst.ID, "c2")
	if inst.ActiveWS || inst.ActiveWSCount != 0 {
		t.Errorf("Expected ActiveWS=false, ActiveWSCount=0, got ActiveWS=%v, ActiveWSCount=%d", inst.ActiveWS, inst.ActiveWSCount)
	}
	if inst.DetachTimer == nil {
		t.Error("Expected DetachTimer to be active after all WebSockets have disconnected")
	}
}

func TestWSIdempotency(t *testing.T) {
	manager := NewManager()
	shell, args := getTestShell()

	inst, err := manager.Spawn("", shell, args, "shell", "test-session")
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

	inst := &PTYInstance{
		ID:            "test-idle-id",
		Coder:         "pi",
		Title:         "Test Pi Session",
		IsBusy:        true,
		BusyStartTime: time.Now().Add(-10 * time.Second),
		LastOutputAt:  time.Now().Add(-4 * time.Second),
	}

	manager.mu.Lock()
	manager.instances[inst.ID] = inst
	manager.mu.Unlock()

	called := make(chan bool, 1)
	manager.StartIdleWatcher(func(info IdleNotification) {
		if info.PaneID == "test-idle-id" && info.Title == "Test Pi Session" && info.Coder == "pi" {
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

	inst, err := manager.Spawn("", shell, args, "shell", "persist-test-session")
	if err != nil {
		t.Fatalf("Failed to spawn PTY instance: %v", err)
	}

	// Verify file was written
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

