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
	got := negotiateCapabilities([]string{CapabilityLifecycle, CapabilityThinking, "unknown.future.v9"})
	if !got[CapabilityLifecycle] || !got[CapabilityThinking] {
		t.Fatalf("known caps dropped: %v", got)
	}
	if got["unknown.future.v9"] {
		t.Fatalf("unknown cap accepted: %v", got)
	}
	if len(negotiateCapabilities(nil)) != 0 {
		t.Fatal("empty advise must yield empty accepted set")
	}
}
