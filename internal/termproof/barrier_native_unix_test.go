//go:build unix

package termproof

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/term"
)

func TestNativeBarrierHelper(t *testing.T) {
	if os.Getenv("PHIC_NATIVE_BARRIER_HELPER") != "1" {
		return
	}
	state, err := term.MakeRaw(0)
	if err != nil {
		os.Exit(2)
	}
	defer term.Restore(0, state)
	request, reply, err := newParserBarrier()
	if err != nil {
		os.Exit(3)
	}
	if _, err = os.Stdout.Write(request); err != nil {
		os.Exit(4)
	}
	var received []byte
	buffer := make([]byte, 4096)
	for !bytes.Contains(received, reply) {
		n, err := os.Stdin.Read(buffer)
		if n > 0 {
			received = append(received, buffer[:n]...)
		}
		if err != nil || len(received) > maxReplayInput {
			os.Exit(5)
		}
	}
	evidence, _ := json.Marshal(map[string]string{"request": string(request), "reply": string(received)})
	if err = os.WriteFile(os.Getenv("PHIC_NATIVE_BARRIER_RESULT"), evidence, 0600); err != nil {
		os.Exit(6)
	}
}

// tmux is a real native VT implementation, outside the development-only
// headless oracle. It is a test dependency only; phic never invokes it.
func TestNativeTMUXParserBarrier(t *testing.T) {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("native tmux is not installed")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	if out, err := exec.Command(tmux, "-V").CombinedOutput(); err == nil {
		t.Logf("native parser: %s", bytes.TrimSpace(out))
	}
	socket := filepath.Join(t.TempDir(), "tmux.sock")
	result := filepath.Join(t.TempDir(), "barrier.json")
	cmd := exec.CommandContext(ctx, tmux, "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "proof", "-x", "80", "-y", "24", os.Args[0], "-test.run=^TestNativeBarrierHelper$", "-test.timeout=20s")
	cmd.Env = append(os.Environ(), "PHIC_NATIVE_BARRIER_HELPER=1", "PHIC_NATIVE_BARRIER_RESULT="+result)
	if data, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native fixture: %v: %s", err, data)
	}
	defer func() { _ = exec.Command(tmux, "-S", socket, "kill-server").Run() }()
	var evidence map[string]string
	for {
		data, err := os.ReadFile(result)
		if err == nil {
			if err = json.Unmarshal(data, &evidence); err != nil {
				t.Fatal(err)
			}
			break
		}
		select {
		case <-ctx.Done():
			pane, _ := exec.Command(tmux, "-S", socket, "capture-pane", "-p", "-t", "proof").CombinedOutput()
			panes, _ := exec.Command(tmux, "-S", socket, "list-panes", "-t", "proof").CombinedOutput()
			t.Fatalf("native parser never echoed barrier: %v (pane %q panes %q)", ctx.Err(), pane, panes)
		case <-time.After(10 * time.Millisecond):
		}
	}
	request, reply := evidence["request"], evidence["reply"]
	if len(request) < 8 || request[:3] != "\x1b[?" {
		t.Fatalf("invalid probe: %q", request)
	}
	mode := request[3 : len(request)-2]
	if _, err := strconv.ParseUint(mode, 10, 31); err != nil {
		t.Fatal(err)
	}
	if reply != "\x1b[?"+mode+";0$y" {
		t.Fatalf("native parser barrier differs: %q -> %q", request, reply)
	}
	t.Logf("native tmux parser barrier: %q -> %q", request, reply)
}
