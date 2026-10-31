//go:build darwin || linux

package dshweb

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRealOwnedTreeCleanup(t *testing.T) {
	for _, crash := range []bool{false, true} {
		t.Run(fmt.Sprintf("crash=%t", crash), func(t *testing.T) {
			dir := t.TempDir()
			pidFile := filepath.Join(dir, "descendant.pid")
			script := filepath.Join(dir, "child.sh")
			tail := "wait\n"
			if crash {
				tail = "exit 1\n"
			}
			// Child inherits the output pipes; leader exit alone must not
			// strand either that child or the pipe-drainer goroutines.
			content := fmt.Sprintf("#!/bin/sh\nsleep 30 &\necho $! > %q\n%s", pidFile, tail)
			if err := os.WriteFile(script, []byte(content), 0700); err != nil {
				t.Fatal(err)
			}
			clock := newFakeClock(time.Now())
			s := NewService(ServiceConfig{Enabled: true, Command: script, Origin: testOrigin(t), DataDir: t.TempDir(), Clock: clock, TempBase: dir}, allowAll, func() uint64 { return 1 })
			defer s.Stop()
			s.Start()
			var pid int
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				data, err := os.ReadFile(pidFile)
				if err == nil {
					pid, _ = strconv.Atoi(strings.TrimSpace(string(data)))
					if pid > 0 {
						break
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
			if pid <= 0 {
				t.Fatal("owned descendant did not report PID")
			}
			if !crash {
				for clock.pendingTimers() == 0 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
				clock.Advance(startupTimeout + time.Second)
			}
			waitState(t, s, StateUnavailable)
			s.Stop()
			state, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "stat=").Output()
			// A zombie is dead; its new OS parent owns final reaping.
			if err == nil && !strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
				t.Fatalf("owned descendant %d remains live: %q", pid, state)
			}
			runs, err := filepath.Glob(filepath.Join(dir, "phi-dsh-run-*"))
			if err != nil || len(runs) != 0 {
				t.Fatalf("runtime temp left behind: %v (%v)", runs, err)
			}
		})
	}
}
