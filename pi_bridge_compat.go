package main

import "github.com/hypernewbie/phi/internal/piapp"

// Bridge and its state aliases keep the process wiring readable while the
// bridge owner lives in internal/piapp.
type (
	Bridge         = piapp.Bridge
	BridgePaneState = piapp.BridgePaneState
)

// piBridgeForCoder reports whether a coder gets bridge provisioning.
func piBridgeForCoder(coderID string) bool { return piapp.ForCoder(coderID) }
