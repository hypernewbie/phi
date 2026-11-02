//go:build !windows

package server

func EnableVirtualTerminalProcessing() {
	// VT is enabled by default on Unix platforms
}
