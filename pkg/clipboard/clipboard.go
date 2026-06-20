package clipboard

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

var (
	LastClipboardFile string
	ClipboardMutex    sync.RWMutex
)

func SetLastClipboardFile(path string) {
	ClipboardMutex.Lock()
	defer ClipboardMutex.Unlock()
	LastClipboardFile = path
}

func GetLastClipboardFile() string {
	ClipboardMutex.RLock()
	defer ClipboardMutex.RUnlock()
	return LastClipboardFile
}

// Read retrieves plain text from a clipboard source.
//
// If shimPath is non-empty and the file exists with content, that content
// is returned (this is the per-PTY session-isolated shim). Otherwise the
// function falls through to the host system clipboard (PowerShell Get-Clipboard
// on Windows, pbpaste on macOS, wl-paste/xclip/xsel on Linux).
//
// Returns ("", nil) when no content is available — callers should treat empty
// string as "nothing to copy" rather than as an error.
func Read(shimPath string) (string, error) {
	// Prefer the explicit shim path when provided. This is what callers should
	// pass when they know which PTY session's clipboard they want — passing
	// a per-session path avoids the multi-PTY ambiguity that comes from
	// relying on a package-global LastClipboardFile.
	if shimPath != "" {
		if data, err := os.ReadFile(shimPath); err == nil {
			text := string(data)
			// Trim PowerShell-style trailing whitespace so a shim file that's
			// never been written to (the common "blank newline" symptom)
			// doesn't masquerade as content.
			text = strings.TrimRight(text, "\r\n")
			if text != "" {
				return text, nil
			}
			// shim file exists but is empty — fall through to system clipboard
		}
	} else if legacy := GetLastClipboardFile(); legacy != "" {
		// Legacy fallback: callers that haven't been updated to pass a
		// per-PTY path. Keeps the package-global working for tests and
		// any third-party consumers.
		if data, err := os.ReadFile(legacy); err == nil {
			text := strings.TrimRight(string(data), "\r\n")
			if text != "" {
				return text, nil
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "windows":
		// Ensure UTF-8 output encoding in PowerShell so non-ASCII characters don't get garbled.
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard")
	case "darwin":
		cmd = exec.CommandContext(ctx, "pbpaste")
	case "linux":
		// Check for wl-clipboard first (Wayland), then fallback to X11 utilities like xclip or xsel.
		if _, err := exec.LookPath("wl-paste"); err == nil {
			cmd = exec.CommandContext(ctx, "wl-paste", "-n")
		} else if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-o")
		} else if _, err := exec.LookPath("xsel"); err == nil {
			cmd = exec.CommandContext(ctx, "xsel", "--clipboard", "--output")
		} else {
			return "", nil
		}
	default:
		return "", nil
	}

	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		// Headless servers lack display/session contexts; fallback gracefully.
		return "", nil
	}

	res := out.String()
	// PowerShell stdout redirection typically appends a trailing carriage return and newline.
	if runtime.GOOS == "windows" {
		res = strings.TrimSuffix(res, "\r\n")
		res = strings.TrimSuffix(res, "\n")
	}
	res = strings.TrimRight(res, "\r\n")
	return res, nil
}
