package pibridge

import (
	"fmt"

	"google.golang.org/grpc/metadata"
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

// negotiateCapabilities intersects client-advertised names with the
// server-supported set. Unknown names are ignored, never an error.
func negotiateCapabilities(advised []string) map[string]bool {
	supported := map[string]bool{CapabilityLifecycle: true, CapabilityHistory: true}
	out := map[string]bool{}
	for _, c := range advised {
		if supported[c] {
			out[c] = true
		}
	}
	return out
}
