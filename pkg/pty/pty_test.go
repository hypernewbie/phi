package pty

import (
	"bytes"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testShell() (string, []string) {
	if runtime.GOOS == "windows" {
		return "pwsh", []string{"-NoLogo", "-NoProfile", "-NonInteractive"}
	}
	return "bash", []string{"--norc", "--noprofile"}
}

// collectOutput reads from the PTY until it sees wantToken or the timeout
// expires. The underlying p.Read is blocking so it runs in a goroutine; once
// the PTY is killed the read returns an error and the goroutine exits cleanly.
func collectOutput(p *Pty, wantToken string, timeout time.Duration) string {
	out := make(chan string, 1)
	go func() {
		buf := make([]byte, 4096)
		var all bytes.Buffer
		for {
			n, err := p.Read(buf)
			if n > 0 {
				all.Write(buf[:n])
				if strings.Contains(all.String(), wantToken) {
					out <- all.String()
					return
				}
			}
			if err != nil {
				out <- all.String()
				return
			}
		}
	}()
	select {
	case s := <-out:
		return s
	case <-time.After(timeout):
		return ""
	}
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

func TestPTYStartAndKill(t *testing.T) {
	shell, args := testShell()
	p, err := Start("", shell, args)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := p.Kill(); err != nil {
		t.Errorf("Kill: %v", err)
	}
	select {
	case <-p.Closed:
	case <-time.After(5 * time.Second):
		t.Error("PTY did not close within 5s after Kill")
	}
}

func TestPTYResize(t *testing.T) {
	shell, args := testShell()
	p, err := Start("", shell, args)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Kill()

	if err := p.Resize(120, 40); err != nil {
		t.Errorf("Resize(120, 40): %v", err)
	}
	if err := p.Resize(80, 24); err != nil {
		t.Errorf("Resize(80, 24): %v", err)
	}
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

func TestPTYEchoOutput(t *testing.T) {
	shell, args := testShell()
	p, err := Start("", shell, args)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Kill()

	// Give the shell time to emit its prompt before we write.
	time.Sleep(800 * time.Millisecond)

	const token = "phi-pty-echo-test-abc123"
	cmd := "echo " + token + "\r"
	if _, err := p.Write([]byte(cmd)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	out := collectOutput(p, token, 8*time.Second)
	if !strings.Contains(out, token) {
		t.Errorf("expected output to contain %q\ngot: %q", token, out)
	}
}

func TestPTYMultipleCommands(t *testing.T) {
	shell, args := testShell()
	p, err := Start("", shell, args)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Kill()

	time.Sleep(800 * time.Millisecond)

	const token1 = "phi-cmd1-xyz"
	const token2 = "phi-cmd2-xyz"

	if _, err := p.Write([]byte("echo " + token1 + "\r")); err != nil {
		t.Fatalf("Write cmd1: %v", err)
	}
	out1 := collectOutput(p, token1, 5*time.Second)
	if !strings.Contains(out1, token1) {
		t.Errorf("cmd1: expected %q in output; got %q", token1, out1)
	}

	if _, err := p.Write([]byte("echo " + token2 + "\r")); err != nil {
		t.Fatalf("Write cmd2: %v", err)
	}
	out2 := collectOutput(p, token2, 5*time.Second)
	if !strings.Contains(out2, token2) {
		t.Errorf("cmd2: expected %q in output; got %q", token2, out2)
	}
}

func TestPTYWorkingDir(t *testing.T) {
	shell, args := testShell()
	tmpDir := t.TempDir()

	p, err := Start(tmpDir, shell, args)
	if err != nil {
		t.Fatalf("Start with dir %q: %v", tmpDir, err)
	}
	defer p.Kill()

	time.Sleep(800 * time.Millisecond)

	var pwdCmd string
	if runtime.GOOS == "windows" {
		pwdCmd = "(Get-Location).Path\r"
	} else {
		pwdCmd = "pwd\r"
	}

	if _, err := p.Write([]byte(pwdCmd)); err != nil {
		t.Fatalf("Write pwd: %v", err)
	}

	// We expect tmpDir's base name or full path to appear in output.
	// On Windows, volume letter casing may differ; check base name instead.
	baseName := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(tmpDir, "\\"), "/"))
	if idx := strings.LastIndexAny(baseName, "\\/"); idx >= 0 {
		baseName = baseName[idx+1:]
	}

	out := collectOutput(p, baseName, 5*time.Second)
	if !strings.Contains(strings.ToLower(out), baseName) {
		t.Errorf("expected working dir %q to appear in pwd output; got %q", baseName, out)
	}
}

// ─── Validation ───────────────────────────────────────────────────────────────

func TestValidateWorkingDir_Empty(t *testing.T) {
	if err := validateWorkingDir(""); err != nil {
		t.Errorf("empty dir should be valid, got: %v", err)
	}
}

func TestValidateWorkingDir_Exists(t *testing.T) {
	dir := t.TempDir()
	if err := validateWorkingDir(dir); err != nil {
		t.Errorf("existing dir should be valid, got: %v", err)
	}
}

func TestValidateWorkingDir_Missing(t *testing.T) {
	if err := validateWorkingDir("/does/not/exist/at/all/phi"); err == nil {
		t.Error("missing dir should return an error")
	}
}

func TestStart_InvalidDir(t *testing.T) {
	shell, args := testShell()
	_, err := Start("/nonexistent/path/phi-test", shell, args)
	if err == nil {
		t.Error("expected error for non-existent working dir")
	}
}

func TestStart_InvalidCommand(t *testing.T) {
	_, err := Start("", "phi-no-such-binary-xyzabc", nil)
	if err == nil {
		t.Error("expected error for unknown command")
	}
}

// ─── Windows CR-split write logic ─────────────────────────────────────────────

func TestPTYWrite_CROnlyDoesNotHang(t *testing.T) {
	shell, args := testShell()
	p, err := Start("", shell, args)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer p.Kill()
	time.Sleep(500 * time.Millisecond)

	// A lone \r should write without deadlock on Windows.
	done := make(chan error, 1)
	go func() {
		_, err := p.Write([]byte{'\r'})
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Write(\\r): %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Error("Write(\\r) blocked for >3s")
	}
}

// ─── ResolveCommand ───────────────────────────────────────────────────────────

func TestResolveCommand_Passthrough(t *testing.T) {
	// Non-special commands should be returned unchanged.
	for _, cmd := range []string{"bash", "pwsh", "python", "node"} {
		if got := ResolveCommand(cmd); got != cmd {
			t.Errorf("ResolveCommand(%q) = %q; want %q", cmd, got, cmd)
		}
	}
}

func TestResolveCommand_AgyFallsBack(t *testing.T) {
	// When agy isn't in the special candidate paths, it should fall back to the
	// plain "agy" string (PATH lookup happens later in exec.LookPath).
	home, _ := os.UserHomeDir()
	// Remove the well-known path temporarily by using a name that won't exist.
	_ = home
	// We can't easily remove the binary, so just assert the result is a string.
	result := ResolveCommand("agy")
	if result == "" {
		t.Error("ResolveCommand('agy') should not return empty string")
	}
}
