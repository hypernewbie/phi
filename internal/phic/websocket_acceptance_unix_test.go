//go:build unix

package phic

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/creack/pty"
)

// Real shell pane through the cmd/phic native console under a PTY.
// The Playwright spec supplies the isolated live server; bare Go tests skip.
func TestWebSocketProtobufLiveAcceptance(t *testing.T) {
	url, urlOK := os.LookupEnv("PHI_WS_ACCEPTANCE_URL")
	dir, dirOK := os.LookupEnv("PHI_WS_ACCEPTANCE_DIR")
	if !urlOK && !dirOK {
		t.Skip("live acceptance needs PHI_WS_ACCEPTANCE_URL and PHI_WS_ACCEPTANCE_DIR from e2e/websocket-terminal.spec.ts")
	}
	if !urlOK || !dirOK {
		t.Fatal("only one of PHI_WS_ACCEPTANCE_URL and PHI_WS_ACCEPTANCE_DIR is set; the spec must supply both or neither")
	}
	if !filepath.IsAbs(dir) {
		t.Fatalf("PHI_WS_ACCEPTANCE_DIR must be absolute, got %q", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}

	phicBin := buildAcceptancePhic(t, dir)
	consolePane := spawnAcceptanceShell(t, url)
	runAcceptanceConsole(t, phicBin, url, dir, consolePane)
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(file)))
}

func buildAcceptancePhic(t *testing.T, dir string) string {
	t.Helper()
	bin := filepath.Join(dir, "phic")
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", bin, "./cmd/phic")
	cmd.Dir = moduleRoot(t)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build cmd/phic: %v\n%s", err, out)
	}
	return bin
}

func spawnAcceptanceShell(t *testing.T, url string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"coder": "bash"})
	resp, err := http.Post(url+"/api/terminals", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("spawn shell pane: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("spawn shell pane: status %s", resp.Status)
	}
	var created struct {
		PaneID string `json:"pane_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode created pane: %v", err)
	}
	if created.PaneID == "" {
		t.Fatal("created pane has no id")
	}
	return created.PaneID
}

func awaitTape(t *testing.T, tape *ptyReader, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if bytes.Contains(tape.snapshot(), []byte(want)) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("missing %q in console output: %q", want, tape.snapshot())
}

func runAcceptanceConsole(t *testing.T, bin, url, dir, pane string) {
	t.Helper()
	home := filepath.Join(dir, "console-home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	profiles := filepath.Join(dir, "console-profiles.json")
	profileJSON, _ := json.Marshal(map[string]any{
		"profiles": []map[string]string{{"id": "acceptance", "name": "acceptance", "origin": url}},
	})
	if err := os.WriteFile(profiles, profileJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx := t.Context()
	cmd := exec.CommandContext(ctx, bin, "--server", url, "--pane", pane, "--profiles", profiles)
	cmd.Dir = dir
	cmd.Env = []string{
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"TMPDIR=" + dir,
		"TERM=xterm-256color",
		"NO_COLOR=",
		"SSH_AUTH_SOCK=",
		"TMUX=",
		"PATH=" + os.Getenv("PATH"),
		"LANG=" + os.Getenv("LANG"),
	}
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	tape := startPtyReader(master)

	mustWrite := func(data []byte) {
		t.Helper()
		if _, err := master.Write(data); err != nil {
			t.Fatalf("write console PTY: %v", err)
		}
	}

	// Submitted input reaches the pane; visible output returns.
	mustWrite([]byte("echo CONSOLE-MARKER-1\r"))
	awaitTape(t, tape, "CONSOLE-MARKER-1", 20*time.Second)

	// The console is a fullscreen TUI: the backend pane gets the inner
	// widget geometry, not the outer PTY size. Outer 120x30 maps to
	// 120-27 sidebar-2 border=91 cols and 30-6 chrome=24 rows; outer
	// 100x28 maps to 71 cols and 22 rows. Assert both sides of the
	// change so a stuck geometry cannot pass.
	awaitStty := func(want string, timeout time.Duration) {
		t.Helper()
		for deadline := time.Now().Add(timeout); time.Now().Before(deadline); {
			mustWrite([]byte("stty size\r"))
			probe := time.Now().Add(2 * time.Second)
			for time.Now().Before(probe) {
				if bytes.Contains(tape.snapshot(), []byte(want)) {
					return
				}
				time.Sleep(50 * time.Millisecond)
			}
		}
		t.Fatalf("backend never reported %q: %q", want, tape.snapshot())
	}
	awaitStty("24 91", 20*time.Second)

	// Resize flows to the backend geometry.
	if err := pty.Setsize(master, &pty.Winsize{Cols: 100, Rows: 28}); err != nil {
		t.Fatalf("resize console PTY: %v", err)
	}
	awaitStty("22 71", 20*time.Second)

	// Refresh reconnects to the same live pane: retained output survives
	// and subsequent input still lands.
	mustWrite([]byte{0x1d})
	time.Sleep(300 * time.Millisecond)
	mustWrite([]byte("R"))
	time.Sleep(2 * time.Second)
	if !bytes.Contains(tape.snapshot(), []byte("CONSOLE-MARKER-1")) {
		t.Fatal("retained marker lost across console refresh")
	}
	mustWrite([]byte("echo CONSOLE-MARKER-2\r"))
	awaitTape(t, tape, "CONSOLE-MARKER-2", 20*time.Second)

	// Pane exit status reaches the child exit status.
	mustWrite([]byte("exit 23\r"))
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		exitErr, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("phic wait: %v", err)
		}
		if exitErr.ExitCode() != 23 {
			t.Fatalf("phic exit status = %d, want 23", exitErr.ExitCode())
		}
	case <-time.After(25 * time.Second):
		t.Fatal("phic did not exit after the pane exited")
	}
	t.Logf("console case: pane %s exited 23 through the real binary", pane)
}
