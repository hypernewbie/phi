package pty

import (
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
	if manager.RegisterWS("non-existent-id") {
		t.Error("Registering non-existent terminal should return false")
	}

	// Register WebSocket connection.
	if !manager.RegisterWS(inst.ID) {
		t.Fatal("Failed to register WebSocket connection")
	}

	if !inst.ActiveWS {
		t.Error("Expected ActiveWS to be true after registration")
	}

	// Unregister WebSocket connection.
	manager.UnregisterWS(inst.ID)

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
	if !manager.RegisterWS(inst.ID) {
		t.Fatal("Failed to register WS")
	}

	// Set pinning to true.
	if err := manager.SetPinned(inst.ID, true); err != nil {
		t.Fatalf("SetPinned failed: %v", err)
	}

	if !inst.Pinned {
		t.Error("Expected Pinned to be true")
	}

	// Unregister WS. Since the session is pinned, it should bypass the detach timer.
	manager.UnregisterWS(inst.ID)

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
	manager.UnregisterWS(inst.ID)

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
	manager.UnregisterWS(inst.ID)

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

	// The instance should now be terminated due to inactivity.
	_, foundAfterIdle := manager.Get(inst.ID)
	if foundAfterIdle {
		t.Error("Expected PTY instance to be killed after grace period expired with no activity")
	}
}
