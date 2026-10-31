package pibridge

import (
	"strings"
	"testing"

	"google.golang.org/grpc/metadata"
)

func TestMetadataSizeBound(t *testing.T) {
	md := metadata.Pairs(metadataPaneKey, "p", metadataProcessKey, "q", metadataTokenKey, strings.Repeat("a", 64))
	if err := checkMetadataSize(md); err != nil {
		t.Fatalf("small metadata rejected: %v", err)
	}
	big := metadata.Pairs("x-pad", strings.Repeat("y", maxMetadataBytes+1))
	if err := checkMetadataSize(big); err == nil {
		t.Fatal("oversized metadata accepted")
	}
}

func TestNegotiateCapabilities(t *testing.T) {
	got := negotiateCapabilities([]string{CapabilityLifecycle, CapabilityThinking, "unknown.future.v9", CapabilitySyncboard}, false)
	if !got[CapabilityLifecycle] || !got[CapabilityThinking] {
		t.Fatalf("known caps dropped: %v", got)
	}
	if got["unknown.future.v9"] || got[CapabilitySyncboard] {
		t.Fatalf("unknown or unconfigured cap accepted: %v", got)
	}
	enabled := negotiateCapabilities([]string{CapabilitySyncboard}, true)
	if !enabled[CapabilitySyncboard] {
		t.Fatal("configured Syncboard capability not accepted")
	}
	if len(negotiateCapabilities(nil, false)) != 0 {
		t.Fatal("empty advise must yield empty accepted set")
	}
}
