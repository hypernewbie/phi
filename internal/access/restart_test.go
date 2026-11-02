package access

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestAccessRestartRejectsOverlappingReplacement(t *testing.T) {
	withTempConfig(t)
	auth := newTestManager(t)
	if err := auth.Configure(testAccessHash()); err != nil {
		auth.close()
		t.Fatalf("configure restart auth: %v", err)
	}
	t.Cleanup(auth.close)

	execFailure := errors.New("injected exec failure")
	execStarted := make(chan struct{})
	finishExec := make(chan struct{})
	firstDone := make(chan struct{})
	released := false
	go func() {
		RestartOnUnix(auth, func() error {
			close(execStarted)
			<-finishExec
			return execFailure
		})
		close(firstDone)
	}()
	defer func() {
		if !released {
			close(finishExec)
		}
		<-firstDone
	}()
	<-execStarted

	if auth.ensureOwned() {
		t.Fatal("ownership retry escaped the first restart gate while replacement was pending")
	}
	secondExecCalls := 0
	RestartOnUnix(auth, func() error {
		secondExecCalls++
		return execFailure
	})
	if secondExecCalls != 0 {
		t.Fatal("overlapping restart launched another replacement")
	}
	if auth.ensureOwned() {
		t.Fatal("overlapping restart recovered auth before the first outcome")
	}

	released = true
	close(finishExec)
	<-firstDone
	if !auth.ensureOwned() {
		t.Fatal("auth did not recover after the first replacement failed")
	}
	auth.mu.Lock()
	recovered := !auth.restartInProgress && !auth.restartStarted && !auth.faulted
	auth.mu.Unlock()
	if !recovered {
		t.Fatal("first replacement recovery did not clear restart state")
	}
}

func TestAccessWindowsRestartRejectsConcurrentSpawn(t *testing.T) {
	withTempConfig(t)
	auth := newTestManager(t)
	if err := auth.Configure(testAccessHash()); err != nil {
		auth.close()
		t.Fatalf("configure restart auth: %v", err)
	}
	t.Cleanup(auth.close)

	spawnStarted := make(chan struct{})
	finishSpawn := make(chan struct{})
	firstDone := make(chan struct{})
	exitCode := make(chan int, 1)
	released := false
	go func() {
		RestartOnWindows(auth, func() (int, error) {
			close(spawnStarted)
			<-finishSpawn
			return 123, nil
		}, func(code int) { exitCode <- code })
		close(firstDone)
	}()
	defer func() {
		if !released {
			close(finishSpawn)
		}
		<-firstDone
	}()
	<-spawnStarted

	duplicateSpawnCalls := 0
	RestartOnWindows(auth, func() (int, error) {
		duplicateSpawnCalls++
		return 456, nil
	}, func(int) {})
	if duplicateSpawnCalls != 0 {
		t.Fatal("overlapping Windows restart spawned another child")
	}
	if !auth.ensureOwned() {
		t.Fatal("Windows restart closed auth before detached child creation succeeded")
	}

	released = true
	close(finishSpawn)
	<-firstDone
	if code := <-exitCode; code != 0 {
		t.Fatalf("Windows exit code = %d, want 0", code)
	}
	if auth.ensureOwned() {
		t.Fatal("successful Windows spawn did not retain the restart gate")
	}
}

func TestAccessRestartAuthLifecycle(t *testing.T) {
	withTempConfig(t)
	auth := newTestManager(t)
	previousAuth := Default
	Default = auth
	t.Cleanup(func() { Default = previousAuth })
	if err := auth.Configure(testAccessHash()); err != nil {
		auth.close()
		t.Fatalf("configure restart auth: %v", err)
	}
	t.Cleanup(auth.close)

	execFailure := errors.New("injected exec failure")
	execCalled := false
	RestartOnUnix(auth, func() error {
		execCalled = true
		if auth.db != nil || auth.owner.held() {
			t.Error("Unix replacement started before auth DB and ownership were closed")
		}
		status := httptest.NewRecorder()
		HandleAccessAuthStatus(status, httptest.NewRequest(http.MethodGet, "/api/auth/status", nil))
		if status.Code != http.StatusServiceUnavailable || auth.db != nil || auth.owner.held() || auth.ownedNow() {
			t.Errorf("status request reopened auth during restart: status=%d db=%v owner=%v owned=%v", status.Code, auth.db != nil, auth.owner.held(), auth.ownedNow())
		}
		contender := &accessStateLock{}
		if !contender.tryAcquire(accessV2LockPath()) {
			t.Error("auth owner lock remained held during Unix replacement")
			return execFailure
		}
		contender.release()
		return execFailure
	})
	if !execCalled {
		t.Fatal("Unix replacement was not attempted")
	}
	if !auth.ownedNow() || !auth.owner.held() || auth.db == nil || auth.faulted || auth.restartInProgress {
		t.Fatalf("failed replacement did not restore active auth ownership: owned=%v lock=%v db=%v faulted=%v restarting=%v", auth.ownedNow(), auth.owner.held(), auth.db != nil, auth.faulted, auth.restartInProgress)
	}
	contender := &accessStateLock{}
	if contender.tryAcquire(accessV2LockPath()) {
		contender.release()
		t.Fatal("recovered auth owner did not retain the ownership lock")
	}

	spawnFailure := errors.New("injected child spawn failure")
	RestartOnWindows(auth, func() (int, error) {
		if !auth.ownedNow() || !auth.owner.held() || auth.db == nil {
			t.Error("Windows auth closed before detached child creation succeeded")
		}
		return 0, spawnFailure
	}, func(int) { t.Error("Windows restart exited after detached child creation failed") })
	if !auth.ownedNow() || !auth.owner.held() || auth.db == nil {
		t.Fatal("failed Windows child creation did not preserve auth ownership")
	}

	exitCode := -1
	RestartOnWindows(auth, func() (int, error) {
		if !auth.ownedNow() || !auth.owner.held() || auth.db == nil {
			t.Error("Windows child creation did not start with active auth ownership")
		}
		return 123, nil
	}, func(code int) {
		exitCode = code
		if auth.ownedNow() || auth.owner.held() || auth.db != nil || !auth.restartInProgress {
			t.Error("Windows process exit started before auth DB was closed and restart gate was set")
		}
	})
	if exitCode != 0 {
		t.Fatalf("Windows exit code = %d, want 0", exitCode)
	}

	failedAuth := newTestManager(t)
	if err := failedAuth.Configure(testAccessHash()); err != nil {
		failedAuth.close()
		t.Fatalf("configure auth for failed recovery: %v", err)
	}
	t.Cleanup(failedAuth.close)
	RestartOnUnix(failedAuth, func() error {
		if failedAuth.db != nil || failedAuth.owner.held() {
			t.Error("Unix replacement started before auth DB and ownership were closed")
		}
		if err := os.WriteFile(accessDBPath(), []byte("corrupt"), 0o600); err != nil {
			return err
		}
		return execFailure
	})
	failedAuth.mu.Lock()
	recoveryFailedClosed := failedAuth.owned && failedAuth.faulted && failedAuth.record == nil && failedAuth.db == nil && failedAuth.restartInProgress
	failedAuth.mu.Unlock()
	if !recoveryFailedClosed {
		t.Fatal("failed auth recovery did not leave authentication unavailable")
	}
}
