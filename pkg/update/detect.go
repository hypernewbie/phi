package update

import (
	"os"
	"runtime/debug"
	"strings"
)

// detect is the pure logic function for testability.
func detect(buildSource, exePath, goSum string) string {
	// Normalise to forward slashes. filepath.ToSlash is a no-op on
	// Linux/Unix (where backslashes aren't path separators), which
	// breaks the windows-path test on non-Windows CI runners. Use an
	// unconditional replace so this works on every OS.
	normPath := strings.ReplaceAll(exePath, "\\", "/")
	if buildSource == "release" && strings.Contains(normPath, "node_modules/@hypernewbie/phi-code") {
		return "npm"
	}
	if buildSource == "release" {
		return "standalone"
	}
	if goSum != "" {
		return "go-install"
	}
	return "dev"
}

// DetectInstallMethod determines how Phi was installed based on build stamps and binary path.
func DetectInstallMethod(buildSource string) string {
	exePath, err := os.Executable()
	if err != nil {
		exePath = ""
	}
	var goSum string
	if info, ok := debug.ReadBuildInfo(); ok {
		goSum = info.Main.Sum
	}
	return detect(buildSource, exePath, goSum)
}
