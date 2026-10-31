package pibridge

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestAttachmentSyncboardCapabilityVersions(t *testing.T) {
	if CapabilityAttachments != "pi.attachments.v3" || CapabilityState != "pi.state.v2" {
		t.Fatalf("incompatible review protocols must be versioned: %s, %s", CapabilityAttachments, CapabilityState)
	}
	for _, enabled := range []bool{false, true} {
		caps := negotiateCapabilities([]string{
			CapabilityLifecycle, CapabilityReload, CapabilitySyncboard,
			"pi.attachments.v1", "pi.attachments.v2", "pi.state.v1",
			CapabilityAttachments, CapabilityState,
		}, enabled)
		for _, old := range []string{"pi.attachments.v1", "pi.attachments.v2", "pi.state.v1"} {
			if caps[old] {
				t.Fatalf("legacy review capability %s was aliased: %v", old, caps)
			}
		}
		if !caps[CapabilityLifecycle] || !caps[CapabilityReload] || !caps[CapabilityAttachments] || !caps[CapabilityState] || caps[CapabilitySyncboard] != enabled {
			t.Fatalf("independent capability negotiation changed: %v", caps)
		}
	}
}

func TestOlderAttachmentPeerKeepsReleasedCapabilitiesWithoutDispatch(t *testing.T) {
	for _, version := range []string{"pi.attachments.v1", "pi.attachments.v2"} {
		t.Run(version, func(t *testing.T) {
			s, sock, cleanup := testServer(t)
			defer cleanup()
			const pane = "pane-older-attachment"
			proc, token, err := s.RegisterPending(pane)
			if err != nil {
				t.Fatal(err)
			}
			s.Complete(proc)
			stream, cancel := openStream(t, sock, pane, proc, token)
			defer cancel()
			hello := reloadHello(pane, proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())
			hello.GetHello().Capabilities = append(hello.GetHello().Capabilities, version, "pi.state.v1")
			hello.GetHello().CurrentState.AttachmentReadiness = attachmentReady(nil)
			if err := stream.Send(hello); err != nil {
				t.Fatal(err)
			}
			recvAccepted(t, stream)
			state, ok := s.PaneState(proc)
			if !ok || !state.HasPeer || !slices.Contains(state.Caps, CapabilityReload) || slices.Contains(state.Caps, CapabilityAttachments) || slices.Contains(state.Caps, CapabilityState) {
				t.Fatalf("mixed-version fallback lost released capability isolation: %+v", state)
			}
			ctx, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			if err := s.RefreshState(ctx, proc); err == nil {
				t.Fatal("old live-state capability admitted a new wire request")
			}
			_, err = s.RequestAttachmentPrompt(ctx, proc, 1, "sess", "leaf", &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"}, "inspect", []AttachmentRef{{
				Basename: "att-file.bin", MIMEType: "application/octet-stream", Kind: "file", SHA256: strings.Repeat("a", 64),
			}}, false)
			var refusal *AttachmentPromptRefusal
			if !errors.As(err, &refusal) || refusal.Reason != "unavailable" {
				t.Fatalf("old attachment capability must refuse before dispatch: %v", err)
			}
		})
	}
}
