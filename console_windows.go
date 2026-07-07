//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func enableVirtualTerminalProcessing() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	setConsoleMode := kernel32.NewProc("SetConsoleMode")
	getConsoleMode := kernel32.NewProc("GetConsoleMode")
	getStdHandle := kernel32.NewProc("GetStdHandle")

	// STD_OUTPUT_HANDLE = -11 -> 0xFFFFFFF5
	stdOutHandle := uintptr(0xFFFFFFF5)
	handle, _, _ := getStdHandle.Call(stdOutHandle)
	if handle == 0 || handle == uintptr(^uintptr(0)) {
		return
	}

	var mode uint32
	ret, _, _ := getConsoleMode.Call(handle, uintptr(unsafe.Pointer(&mode)))
	if ret == 0 {
		return
	}

	// ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
	mode |= 0x0004
	setConsoleMode.Call(handle, uintptr(mode))
}
