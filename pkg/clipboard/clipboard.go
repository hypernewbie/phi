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

// Read retrieves the plain text content currently stored in the host system's clipboard.
// It detects the operating system and runs the appropriate native command to fetch it.
func Read() (string, error) {
	// First check session-isolated clipboard shim file
	if shimPath := GetLastClipboardFile(); shimPath != "" {
		if data, err := os.ReadFile(shimPath); err == nil {
			return string(data), nil
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
		return "", err
	}

	res := out.String()
	// PowerShell stdout redirection typically appends a trailing carriage return and newline.
	if runtime.GOOS == "windows" {
		res = strings.TrimSuffix(res, "\r\n")
		res = strings.TrimSuffix(res, "\n")
	}
	return res, nil
}
