package ws

import (
	"testing"
)

// Concept 7: wire compression is unconditional. Localhost profiles
// measure a fat zero-latency pipe, not the real path (remote host to a
// tablet on a bad link); no loopback number ever gets a vote on the wire
// format. This pins the production upgrader: permessage-deflate stays
// negotiated, never conditional on a benchmark or a flag.
func TestProductionUpgraderKeepsCompression(t *testing.T) {
	if !Upgrader.EnableCompression {
		t.Fatal("production WebSocket upgrader must keep EnableCompression=true")
	}
}
