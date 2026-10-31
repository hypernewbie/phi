package pibridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"google.golang.org/protobuf/proto"
)

func TestAttachmentReloadWireCompatibility(t *testing.T) {
	for _, tc := range []struct {
		message proto.Message
		field   string
		number  int
	}{
		{&pibridgepb.PhiToPi{}, "reloadRequest", 22},
		{&pibridgepb.PhiToPi{}, "stateRequest", 25},
		{&pibridgepb.PhiToPi{}, "attachmentPromptRequest", 24},
		{&pibridgepb.PiToPhi{}, "reloadAck", 25},
		{&pibridgepb.PiToPhi{}, "attachmentPromptAck", 27},
		{&pibridgepb.PhiToPi{}, "syncboardResponse", 23},
		{&pibridgepb.PiToPhi{}, "syncboardRequest", 26},
		{&pibridgepb.StateSnapshot{}, "reloadReadiness", 12},
		{&pibridgepb.StateSnapshot{}, "requestId", 13},
		{&pibridgepb.StateSnapshot{}, "attachmentReadiness", 14},
	} {
		t.Run(tc.field, func(t *testing.T) {
			field := tc.message.ProtoReflect().Descriptor().Fields().ByJSONName(tc.field)
			if field == nil || int(field.Number()) != tc.number {
				t.Fatalf("%s: want wire field %d, got %v", tc.field, tc.number, field)
			}
		})
	}
	caps := negotiateCapabilities([]string{CapabilityReload, "pi.attachments.v1", CapabilityAttachments}, false)
	if CapabilityAttachments != "pi.attachments.v3" || caps["pi.attachments.v1"] || !caps[CapabilityAttachments] || !caps[CapabilityReload] {
		t.Fatalf("attachment versions must not alias: %v", caps)
	}
}

func TestAttachmentReloadMutualExclusion(t *testing.T) {
	for _, first := range []string{"attachment", "reload"} {
		t.Run(first+" blocks the other mutation", func(t *testing.T) {
			s, sock, cleanup := testServer(t)
			defer cleanup()
			const pane = "pane-attachment-reload"
			proc, token, err := s.RegisterPending(pane)
			if err != nil {
				t.Fatal(err)
			}
			s.Complete(proc)
			stream, cancel := openStream(t, sock, pane, proc, token)
			defer cancel()
			hello := reloadHello(pane, proc, 1, pibridgepb.LogicalState_LOGICAL_STATE_IDLE, idleReloadReadiness())
			hello.GetHello().Capabilities = append(hello.GetHello().Capabilities, CapabilityAttachments)
			hello.GetHello().CurrentState.AttachmentReadiness = attachmentReady(nil)
			if err := stream.Send(hello); err != nil {
				t.Fatal(err)
			}
			recvAccepted(t, stream)
			revision, _ := s.PublicationRevision(proc)
			ctx, stop := context.WithTimeout(context.Background(), 3*time.Second)
			defer stop()
			attachment := func() error {
				_, err := s.RequestAttachmentPrompt(ctx, proc, 1, "sess", "leaf", &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"}, "inspect", []AttachmentRef{{
					Basename: "att-file.bin", MIMEType: "application/octet-stream", Kind: "file", SHA256: strings.Repeat("a", 64),
				}}, false)
				return err
			}
			reload := func() error {
				_, err := s.RequestReload(ctx, proc, 1, revision, 0, 0)
				return err
			}
			start, blocked := attachment, reload
			if first == "reload" {
				start, blocked = reload, attachment
			}
			done := make(chan error, 1)
			go func() { done <- start() }()
			request, err := stream.Recv()
			if err != nil {
				t.Fatal(err)
			}
			err = blocked()
			var attachmentRefusal *AttachmentPromptRefusal
			var reloadRefusal *ReloadRefusal
			if !((errors.As(err, &attachmentRefusal) && attachmentRefusal.Reason == "pending") ||
				(errors.As(err, &reloadRefusal) && reloadRefusal.Reason == "pending")) {
				t.Fatalf("second mutation must refuse as pending, got %v", err)
			}
			ack := &pibridgepb.PiToPhi{PaneId: pane, ProcessId: proc, RuntimeGeneration: 1}
			if first == "attachment" {
				if request.GetAttachmentPromptRequest() == nil {
					t.Fatalf("wrong request: %v", request.GetPayload())
				}
				ack.Payload = &pibridgepb.PiToPhi_AttachmentPromptAck{AttachmentPromptAck: &pibridgepb.AttachmentPromptAck{
					RequestId: request.GetAttachmentPromptRequest().GetRequestId(), Outcome: pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED,
				}}
			} else {
				if request.GetReloadRequest() == nil {
					t.Fatalf("wrong request: %v", request.GetPayload())
				}
				ack.Payload = &pibridgepb.PiToPhi_ReloadAck{ReloadAck: &pibridgepb.ReloadAck{
					RequestId: request.GetReloadRequest().GetRequestId(), Outcome: pibridgepb.ReloadDispatchOutcome_RELOAD_DISPATCH_OUTCOME_DISPATCHED,
				}}
			}
			if err := stream.Send(ack); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatalf("first mutation did not retain its matching acknowledgment: %v", err)
			}
		})
	}
}
