package update

import (
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

// detect is the pure logic function for testability.
func detect(buildSource, exePath, goSum string) string {
	normPath := filepath.ToSlash(exePath)
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
