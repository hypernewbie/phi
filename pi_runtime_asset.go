package main

import (
	"bytes"
	_ "embed"
	"fmt"
)

// The canonical Pi extension runtime travels inside the Phi binary so
// binary-only installations load the same artifact the source checkout
// builds. Both build modes embed this file; a missing file fails the
// build, while an empty or corrupt one fails here at startup, never
// silently. Rebuild with pnpm build:pi-phi.
//
//go:embed bonus/pi-phi/dist/pi-phi-extension.cjs
var piPhiRuntimeAsset []byte

// The stamped bundle version travels alongside the runtime for the
// stable-path gate: phi rewrites its stable copy only when this
// version is newer than the installed one. Stamped by
// scripts/pi-phi-build.mjs from the package version.
//
//go:embed bonus/pi-phi/dist/VERSION
var piPhiVersionAsset string

// piPhiRuntimeMarker is a stable bundle string that must survive
// embedding. It trips on truncation or a wrong-file embed, not malice.
var piPhiRuntimeMarker = []byte("PHI_PI_BRIDGE_ENDPOINT")

// piPhiRuntime returns the canonical extension bytes after a sanity
// check. An absent or corrupt asset disables provisioning; it never
// blocks Pi startup.
func piPhiRuntime() ([]byte, error) {
	if len(piPhiRuntimeAsset) == 0 {
		return nil, fmt.Errorf("pi-phi: extension runtime missing; run pnpm build:pi-phi")
	}
	if !bytes.Contains(piPhiRuntimeAsset, piPhiRuntimeMarker) {
		return nil, fmt.Errorf("pi-phi: extension runtime corrupt")
	}
	return piPhiRuntimeAsset, nil
}
