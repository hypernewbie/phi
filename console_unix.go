//go:build !windows

package main

func enableVirtualTerminalProcessing() {
	// VT is enabled by default on Unix platforms
}
