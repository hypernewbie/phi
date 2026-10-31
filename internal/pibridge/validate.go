package pibridge

import (
	"fmt"
	"math"

	"google.golang.org/grpc/metadata"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// metadataSize sums key and value bytes in gRPC metadata.
func metadataSize(md metadata.MD) int {
	n := 0
	for k, vs := range md {
		n += len(k)
		for _, v := range vs {
			n += len(v)
		}
	}
	return n
}

// checkMetadataSize rejects oversized gRPC metadata.
func checkMetadataSize(md metadata.MD) error {
	if metadataSize(md) > maxMetadataBytes {
		return fmt.Errorf("pibridge: metadata exceeds %d bytes", maxMetadataBytes)
	}
	return nil
}

// maxSafeInteger bounds validated telemetry magnitudes (2^53-1, the
// JSON-safe integer range shared with the extension and browsers).
const maxSafeInteger = 9007199254740991

// validateContextUsage rejects one context telemetry sample with a
// nonfinite, negative, over-magnitude, or nonpositive-window field,
// or a percent without its token count. A nil sample (unknown
// usage) is valid, and explicit zero stays a present zero, never
// unknown. Invalid samples must never become authoritative state.
func validateContextUsage(u *pibridgepb.ContextUsageSnapshot) error {
	if u == nil {
		return nil
	}
	if t := u.Tokens; t != nil {
		if math.IsNaN(*t) || math.IsInf(*t, 0) || *t < 0 || *t > maxSafeInteger {
			return fmt.Errorf("pibridge: invalid context tokens")
		}
	}
	if w := u.ContextWindow; w != nil {
		if math.IsNaN(*w) || math.IsInf(*w, 0) || *w <= 0 || *w > maxSafeInteger {
			return fmt.Errorf("pibridge: invalid context window")
		}
	}
	if p := u.Percent; p != nil {
		if math.IsNaN(*p) || math.IsInf(*p, 0) || *p < 0 || *p > maxSafeInteger {
			return fmt.Errorf("pibridge: invalid context percent")
		}
		if u.Tokens == nil {
			return fmt.Errorf("pibridge: context percent without tokens")
		}
	}
	return nil
}

// negotiateCapabilities intersects client-advertised names with the
// server-supported set. Unknown names are ignored, never an error.
func negotiateCapabilities(advised []string, syncboardEnabled bool) map[string]bool {
	supported := map[string]bool{CapabilityLifecycle: true, CapabilityHistory: true, CapabilityModels: true, CapabilityThinking: true, CapabilityContext: true, CapabilityCompact: true, CapabilityReload: true, CapabilitySkills: true, CapabilityAttachments: true, CapabilityState: true}
	if syncboardEnabled {
		supported[CapabilitySyncboard] = true
	}
	out := map[string]bool{}
	for _, c := range advised {
		if supported[c] {
			out[c] = true
		}
	}
	return out
}
