//go:build windows

package pibridge

import (
	"strings"
	"testing"
)

func TestNewEndpointPipeLayout(t *testing.T) {
	ep, err := NewEndpoint()
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	defer ep.Cleanup()
	const prefix = `unix:\\.\pipe\phi-pi-`
	if !strings.HasPrefix(ep.Target, prefix) {
		t.Fatalf("target %q, want prefix %q", ep.Target, prefix)
	}
	name := strings.TrimPrefix(ep.Target, prefix)
	if len(name) < 32 {
		t.Fatalf("pipe name %q too short", name)
	}
	for _, c := range name {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			t.Fatalf("pipe name %q not hex", name)
		}
	}
	other, err := NewEndpoint()
	if err != nil {
		t.Fatalf("second endpoint: %v", err)
	}
	defer other.Cleanup()
	if ep.Target == other.Target {
		t.Fatal("pipe targets collide")
	}
	// Filesystem roots are ignored on Windows; the pipe shape still holds.
	rooted, err := NewEndpointWithRoots([]string{`C:\bad`, ``})
	if err != nil {
		t.Fatalf("rooted endpoint: %v", err)
	}
	defer rooted.Cleanup()
	if !strings.HasPrefix(rooted.Target, prefix) {
		t.Fatalf("rooted target %q, want prefix %q", rooted.Target, prefix)
	}
}

func TestPipeListenCloses(t *testing.T) {
	ep, err := NewEndpoint()
	if err != nil {
		t.Fatalf("endpoint: %v", err)
	}
	defer ep.Cleanup()
	lis, err := ep.Listen()
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	if err := lis.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}
