//go:build !darwin && !linux

package dshweb

import (
	"errors"
	"syscall"
)

var errUnsupportedPlatform = errors.New("dshweb: process ownership is unsupported on this platform")

func newSysAttr() *syscall.SysProcAttr { return nil }

func killProcessGroup(_ int, _ syscall.Signal) error { return errUnsupportedPlatform }

func supportedPlatform() bool { return false }
