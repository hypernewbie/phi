package pty

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
	"github.com/hypernewbie/phi/pkg/clipboard"
)

// crGapDur is the pause inserted after the bytes preceding a \r are written to
// the ConPTY input pipe, before the \r itself. Without it, conhost's ReadFile
// can pull both writes in a single read and re-coalesce them. Tunable for
// testing via PHI_CR_GAP_US (microseconds).
var crGapDur = func() time.Duration {
	if v := os.Getenv("PHI_CR_GAP_US"); v != "" {
		if us, err := strconv.Atoi(v); err == nil {
			return time.Duration(us) * time.Microsecond
		}
	}
	return 10 * time.Millisecond
}()

type Pty struct {
	cmd       *gopty.Cmd
	pt        gopty.Pty
	Closed    chan struct{}
	closeOnce sync.Once
	exitCode  int

	// clipFile is the path of this session's clipboard shim file
	// (e.g. /tmp/phi-shims-XXXX/clipboard.txt). Used by the API handler
	// to read clipboard content scoped to a specific PTY, rather than
	// relying on a single package-global shim path that gets overwritten
	// every time a new PTY is created. Empty for PTYs created before
	// this field existed.
	clipFile string
}

// ExitCode returns the wait status code of the PTY command.
func (p *Pty) ExitCode() int {
	return p.exitCode
}

// ClipboardFile returns the path of this PTY's clipboard shim file, or
// empty string if no shim was set up.
func (p *Pty) ClipboardFile() string {
	return p.clipFile
}

func (p *Pty) closePTY() {
	p.closeOnce.Do(func() {
		_ = p.pt.Close()
	})
}

// ResolveCommand checks if a specific binary exists, particularly for agy.
// It tries common install locations across platforms before falling back to PATH lookup.
func ResolveCommand(command string) string {
	if command == "agy" {
		home, _ := os.UserHomeDir()
		candidates := []string{
			filepath.Join(home, ".gemini", "antigravity-cli", "bin", "agy"),
		}
		for _, p := range candidates {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return command
}

// validateWorkingDir confirms dir exists and is a directory. An empty dir is allowed
// (the PTY inherits the server process's cwd). A missing dir is reported with a clear,
// actionable error rather than letting it surface later as the kernel's misleading
// "fork/exec <shell>: no such file or directory" — which blames the binary, not the
// path. This commonly happens when a config carries paths from another machine.
func validateWorkingDir(dir string) error {
	if dir == "" {
		return nil
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("project directory %q doesn't exist on this machine", dir)
	}
	return nil
}

// Start spawns a PTY-backed process. ctx is accepted for the caller's
// pty.spawn span (Manager.Spawn wraps this call) and MUST NOT be used to
// cancel the spawned process itself — the terminal outlives the HTTP
// request that created it (phi's 30-min detach-and-survive grace period),
// so tying it to a request-scoped ctx would kill every terminal the
// instant its spawn request returns. cmd.Start()/cmd.Wait() below are
// deliberately left on their own non-cancellable lifetime.
//
// envOverrides (optional) lets the caller inject per-child environment
// values from a resolved coder profile. The map is merged into the
// os.Environ-derived construction with case-insensitive key matching
// on Windows. Phi-owned shim variables (PATH with the shim dir
// prepended, PHI_CLIPBOARD_FILE) always win; envOverrides cannot
// override them. On Windows the SHELL-strip is bypassed when the
// override map explicitly carries a SHELL key.
func Start(ctx context.Context, dir string, command string, args []string, envOverrides ...map[string]string) (*Pty, error) {
	resolvedCmd := ResolveCommand(command)

	// Resolve the full path before creating the command — go-pty's Windows
	// path resolver incorrectly joins Dir+command when Dir is set.
	resolvedPath, err := exec.LookPath(resolvedCmd)
	if err != nil {
		return nil, fmt.Errorf("command %q not found in PATH — is it installed?", resolvedCmd)
	}

	// Validate the working directory up front so a stale/cross-platform path produces a
	// clear message instead of the kernel's misleading "fork/exec <shell>" ENOENT later.
	if err := validateWorkingDir(dir); err != nil {
		return nil, err
	}

	pt, err := gopty.New()
	if err != nil {
		return nil, err
	}

	// Create session-isolated temporary directory for clipboard shims
	tempDir, err := os.MkdirTemp("", "phi-shims-")
	if err != nil {
		_ = pt.Close()
		return nil, fmt.Errorf("failed to create temp directory for clipboard shims: %v", err)
	}
	clipFile := filepath.Join(tempDir, "clipboard.txt")
	clipboard.SetLastClipboardFile(clipFile)

	if err := createShims(tempDir, clipFile); err != nil {
		_ = os.RemoveAll(tempDir)
		_ = pt.Close()
		return nil, fmt.Errorf("failed to create clipboard shims: %v", err)
	}

	cmd := pt.Command(resolvedPath, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()

	// Prepend tempDir to PATH
	pathKey := "PATH"
	pathVal := os.Getenv("PATH")
	for i, env := range cmd.Env {
		if strings.HasPrefix(strings.ToUpper(env), "PATH=") {
			parts := strings.SplitN(env, "=", 2)
			pathKey = parts[0]
			pathVal = parts[1]
			cmd.Env = append(cmd.Env[:i], cmd.Env[i+1:]...)
			break
		}
	}
	var newPath string
	if runtime.GOOS == "windows" {
		newPath = fmt.Sprintf("%s=%s;%s", pathKey, tempDir, pathVal)
	} else {
		newPath = fmt.Sprintf("%s=%s:%s", pathKey, tempDir, pathVal)
	}
	cmd.Env = append(cmd.Env, newPath)
	cmd.Env = append(cmd.Env, fmt.Sprintf("PHI_CLIPBOARD_FILE=%s", clipFile))

	// Merge per-coder env overrides on top of the inherited environment.
	// Case-insensitive on Windows; PHI_CLIPBOARD_FILE and PATH-with-shim
	// win over any override that targets the same key (R4).
	merged := mergeEnvOverrides(cmd.Env, envOverrides, runtime.GOOS == "windows")
	cmd.Env = merged

	// On Windows, strip any stray UNIX-like SHELL environment variable to prevent
	// cross-platform tools (like Pi Coder) from trying to run commands via a broken/WSL bash.
	// Skip the strip when the caller explicitly set SHELL in envOverrides — a
	// custom profile that says "I want SHELL" wins over the cross-platform
	// safety net.
	if runtime.GOOS == "windows" {
		shellOverridden := false
		for _, ov := range envOverrides {
			for k := range ov {
				if strings.EqualFold(k, "SHELL") {
					shellOverridden = true
					break
				}
			}
			if shellOverridden {
				break
			}
		}
		if !shellOverridden {
			var cleanEnv []string
			for _, env := range cmd.Env {
				if !strings.HasPrefix(strings.ToUpper(env), "SHELL=") {
					cleanEnv = append(cleanEnv, env)
				}
			}
			cmd.Env = cleanEnv
		}
	}

	hasTerm := false
	hasDisplay := false
	for _, env := range cmd.Env {
		if strings.HasPrefix(strings.ToUpper(env), "TERM=") {
			hasTerm = true
		}
		if strings.HasPrefix(strings.ToUpper(env), "DISPLAY=") || strings.HasPrefix(strings.ToUpper(env), "WAYLAND_DISPLAY=") {
			hasDisplay = true
		}
	}
	if !hasTerm {
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	}
	// Enable 24-bit true colour support for agents.
	cmd.Env = append(cmd.Env, "COLORTERM=truecolor")

	// On Linux/BSD, if no display server env var is present, inject dummy DISPLAY and WAYLAND_DISPLAY.
	// This tricks headless tools (e.g. Python pyperclip used by Aider) into attempting clipboard calls,
	// which are then successfully intercepted by our PATH shims.
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" && !hasDisplay {
		cmd.Env = append(cmd.Env, "DISPLAY=:99", "WAYLAND_DISPLAY=wayland-99")
	}

	if err := cmd.Start(); err != nil {
		_ = pt.Close()
		return nil, err
	}

	p := &Pty{
		cmd:      cmd,
		pt:       pt,
		Closed:   make(chan struct{}),
		clipFile: clipFile,
		exitCode: -1,
	}

	go func() {
		waitErr := cmd.Wait()
		if waitErr == nil {
			p.exitCode = 0
		} else if exitErr, ok := waitErr.(*exec.ExitError); ok {
			p.exitCode = exitErr.ExitCode()
		}
		p.closePTY()
		_ = os.RemoveAll(tempDir) // remove shim dir BEFORE signaling done
		close(p.Closed)           // Closed now means "process exited AND cleaned up"
	}()

	return p, nil
}

// mergeEnvOverrides layers envOverrides on top of base. Reserved keys
// (PATH, PHI_CLIPBOARD_FILE) cannot be overridden by callers; their
// managed values from Start are preserved verbatim. All other keys
// are replaced when present in the override maps. The last override
// map wins when multiple carry the same key, so the optional
// variadic shape keeps the common no-overrides path zero-cost.
//
// Windows is case-insensitive for env-var keys, so PATH, Path, and
// path all collide. The first base occurrence is replaced; later
// case-different entries are dropped to keep the environment free
// of duplicates the kernel would silently merge anyway.
func mergeEnvOverrides(base []string, overrides []map[string]string, windowsCI bool) []string {
	if len(overrides) == 0 {
		return base
	}
	// Reserved keys must keep their Start-managed values: PATH is
	// rewritten by Start to prepend the shim dir, and PHI_CLIPBOARD_FILE
	// is the session-isolated clipboard sink. A custom profile must
	// not be able to either inject a fake clipboard sink or strip the
	// shim directory.
	reserved := func(k string) bool {
		return strings.EqualFold(k, "PATH") || strings.EqualFold(k, "PHI_CLIPBOARD_FILE")
	}

	// Index base by key for fast lookup.
	out := make([]string, 0, len(base))
	index := make(map[string]int, len(base))
	for _, e := range base {
		k := strings.SplitN(e, "=", 2)[0]
		if _, exists := findKey(index, k, windowsCI); exists {
			// Drop duplicate entries (rare; can happen with both
			// "Path" and "PATH" in os.Environ on Windows).
			continue
		}
		index[k] = len(out)
		out = append(out, e)
	}

	// Apply each override map in order. Last write wins.
	for _, ov := range overrides {
		for k, v := range ov {
			if reserved(k) {
				continue
			}
			entry := k + "=" + v
			if idx, exists := findKey(index, k, windowsCI); exists {
				out[idx] = entry
			} else {
				index[k] = len(out)
				out = append(out, entry)
			}
		}
	}
	return out
}

func findKey(index map[string]int, key string, windowsCI bool) (int, bool) {
	if idx, ok := index[key]; ok {
		return idx, true
	}
	if !windowsCI {
		return 0, false
	}
	for k, idx := range index {
		if strings.EqualFold(k, key) {
			return idx, true
		}
	}
	return 0, false
}

func (p *Pty) Read(b []byte) (int, error) {
	return p.pt.Read(b)
}

func (p *Pty) Write(b []byte) (int, error) {
	// On Windows, a carriage return that shares a single ConPTY input-pipe
	// write with preceding bytes gets coalesced: charm/Bubble Tea's input
	// reader (opencode, claude, agy, pi) treats the bulk chunk as a bracketed
	// paste and inserts the newline literally instead of registering a distinct
	// Enter keypress. Writing each \r on its own — with a brief flush gap after
	// the preceding bytes so conhost drains them in a separate ReadFile — makes
	// Enter fire. A lone \r (direct-mode typing) has no preceding bytes and so
	// incurs no gap.
	if runtime.GOOS != "windows" || !bytes.ContainsRune(b, '\r') {
		return p.pt.Write(b)
	}

	total := 0
	rest := b
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\r')
		if i < 0 {
			n, err := p.pt.Write(rest)
			total += n
			return total, err
		}
		if i > 0 {
			n, err := p.pt.Write(rest[:i])
			total += n
			if err != nil {
				return total, err
			}
			if crGapDur > 0 {
				time.Sleep(crGapDur)
			}
		}
		n, err := p.pt.Write([]byte{'\r'})
		total += n
		if err != nil {
			return total, err
		}
		rest = rest[i+1:]
	}
	return total, nil
}

func (p *Pty) Resize(cols, rows uint16) error {
	return p.pt.Resize(int(cols), int(rows))
}

func (p *Pty) Kill() error {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	p.closePTY()
	return nil
}

// Terminate asks the child to exit cleanly: SIGTERM on Unix (agents can
// catch it and flush session state); Windows has no SIGTERM, so fall back
// to Kill. Escalation to SIGKILL is the caller's job (see Manager.Shutdown).
func (p *Pty) Terminate() error {
	if p.cmd.Process == nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		return p.cmd.Process.Kill()
	}
	return p.cmd.Process.Signal(syscall.SIGTERM)
}

func createShims(tempDir string, clipboardFile string) error {
	pbcopyContent := fmt.Sprintf(`#!/bin/sh
cat > %q
`, clipboardFile)

	pbpasteContent := fmt.Sprintf(`#!/bin/sh
if [ -f %q ]; then
	cat %q
fi
`, clipboardFile, clipboardFile)

	wlcopyContent := pbcopyContent
	wlpasteContent := pbpasteContent

	xclipContent := fmt.Sprintf(`#!/bin/sh
is_paste=0
for arg in "$@"; do
	if [ "$arg" = "-o" ] || [ "$arg" = "-out" ]; then
		is_paste=1
	fi
done
if [ "$is_paste" -eq 1 ]; then
	if [ -f %q ]; then
		cat %q
	fi
else
	cat > %q
fi
`, clipboardFile, clipboardFile, clipboardFile)

	xselContent := fmt.Sprintf(`#!/bin/sh
is_paste=0
for arg in "$@"; do
	if [ "$arg" = "-o" ] || [ "$arg" = "--output" ]; then
		is_paste=1
	fi
done
if [ "$is_paste" -eq 1 ]; then
	if [ -f %q ]; then
		cat %q
	fi
else
	cat > %q
fi
`, clipboardFile, clipboardFile, clipboardFile)

	shims := map[string]string{
		"pbcopy":   pbcopyContent,
		"pbpaste":  pbpasteContent,
		"wl-copy":  wlcopyContent,
		"wl-paste": wlpasteContent,
		"xclip":    xclipContent,
		"xsel":     xselContent,
	}

	for name, content := range shims {
		path := filepath.Join(tempDir, name)
		if err := os.WriteFile(path, []byte(content), 0700); err != nil {
			return err
		}
	}

	if runtime.GOOS == "windows" {
		safePSClipFile := strings.ReplaceAll(clipboardFile, "'", "''")

		pbcopyBat := fmt.Sprintf(`@echo off
powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Out-File -FilePath '%s' -Encoding utf8"
`, safePSClipFile)
		pbpasteBat := fmt.Sprintf(`@echo off
if exist "%s" (
	type "%s"
)
`, clipboardFile, clipboardFile)

		xclipBat := fmt.Sprintf(`@echo off
set is_paste=0
for %%a in (%%*) do (
	if "%%a"=="-o" set is_paste=1
	if "%%a"=="-out" set is_paste=1
)
if "%%is_paste%%"=="1" (
	if exist "%s" type "%s"
) else (
	powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Out-File -FilePath '%s' -Encoding utf8"
)
`, clipboardFile, clipboardFile, safePSClipFile)

		xselBat := fmt.Sprintf(`@echo off
set is_paste=0
for %%a in (%%*) do (
	if "%%a"=="-o" set is_paste=1
	if "%%a"=="--output" set is_paste=1
)
if "%%is_paste%%"=="1" (
	if exist "%s" type "%s"
) else (
	powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Out-File -FilePath '%s' -Encoding utf8"
)
`, clipboardFile, clipboardFile, safePSClipFile)

		batShims := map[string]string{
			"pbcopy.bat":   pbcopyBat,
			"pbpaste.bat":  pbpasteBat,
			"wl-copy.bat":  pbcopyBat,
			"wl-paste.bat": pbpasteBat,
			"xclip.bat":    xclipBat,
			"xsel.bat":     xselBat,
		}

		for name, content := range batShims {
			path := filepath.Join(tempDir, name)
			if err := os.WriteFile(path, []byte(content), 0700); err != nil {
				return err
			}
		}
	}

	return nil
}
