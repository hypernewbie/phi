package pibridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func attachmentReady(imageAvailable *bool) *pibridgepb.AttachmentReadiness {
	return &pibridgepb.AttachmentReadiness{Idle: true, ImageAvailable: imageAvailable}
}

func attachmentHello(pane, proc string, ready *pibridgepb.AttachmentReadiness) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: ProtocolVersion, SessionId: "session", RuntimeId: "runtime",
			Capabilities: []string{CapabilityLifecycle, CapabilityAttachments},
			CurrentState: &pibridgepb.StateSnapshot{
				State:     pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
				SessionId: "session", LeafId: "leaf",
				Model:               &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"},
				AttachmentReadiness: ready,
			},
		}},
	}
}

func openAttachmentStream(t *testing.T, s *Server, sock, pane string, ready *pibridgepb.AttachmentReadiness) (pibridgepb.Integration_ConnectClient, string, context.CancelFunc) {
	t.Helper()
	proc, token, err := s.RegisterPending(pane)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, pane, proc, token)
	if err := stream.Send(attachmentHello(pane, proc, ready)); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	recvAccepted(t, stream)
	return stream, proc, cancel
}

func TestRequestAttachmentPromptRoundTripWithoutCompact(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	imageAvailable := true
	stream, proc, cancel := openAttachmentStream(t, s, sock, "pane-attachment", attachmentReady(&imageAvailable))
	defer cancel()
	ref := AttachmentRef{Basename: "att-0123456789abcdef.png", SizeBytes: 8, MIMEType: "image/png", Kind: "image", SHA256: strings.Repeat("a", 64)}
	done := make(chan struct {
		result AttachmentPromptResult
		err    error
	}, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		result, err := s.RequestAttachmentPrompt(ctx, proc, 1, "session", "leaf", &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"}, "inspect", []AttachmentRef{ref}, true)
		done <- struct {
			result AttachmentPromptResult
			err    error
		}{result, err}
	}()
	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	requestCh := make(chan *pibridgepb.PhiToPi, 1)
	go func() { msg, _ := stream.Recv(); requestCh <- msg }()
	var request *pibridgepb.AttachmentPromptRequest
	select {
	case msg := <-requestCh:
		request = msg.GetAttachmentPromptRequest()
	case <-ctx.Done():
		t.Fatal("timed out waiting for attachment prompt")
	}
	if request == nil || request.GetRequestId() == "" || request.GetText() != "inspect" || len(request.GetAttachments()) != 1 || request.GetAttachments()[0].GetBasename() != ref.Basename {
		t.Fatalf("unexpected request: %+v", request)
	}
	if len(request.GetAttachments()[0].GetBasename()) == 0 {
		t.Fatal("attachment reference missing")
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-attachment", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AttachmentPromptAck{AttachmentPromptAck: &pibridgepb.AttachmentPromptAck{
			RequestId: request.GetRequestId(), Outcome: pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil || got.result.Outcome != pibridgepb.AttachmentPromptOutcome_ATTACHMENT_PROMPT_OUTCOME_DISPATCHED {
			t.Fatalf("result=%+v err=%v", got.result, got.err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for correlated ack")
	}
}

func TestRequestAttachmentPromptMissingCapabilityRefuses(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-no-attachment-cap")
	if err != nil {
		t.Fatal(err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-no-attachment-cap", proc, token)
	defer cancel()
	imageAvailable := true
	hello := attachmentHello("pane-no-attachment-cap", proc, attachmentReady(&imageAvailable))
	hello.GetHello().Capabilities = []string{CapabilityLifecycle}
	if err := stream.Send(hello); err != nil {
		t.Fatal(err)
	}
	recvAccepted(t, stream)

	ref := AttachmentRef{Basename: "att-0123456789abcdef.bin", SizeBytes: 1, MIMEType: "application/octet-stream", Kind: "file", SHA256: strings.Repeat("b", 64)}
	_, err = s.RequestAttachmentPrompt(context.Background(), proc, 1, "session", "leaf", &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"}, "inspect", []AttachmentRef{ref}, false)
	var refusal *AttachmentPromptRefusal
	if !errors.As(err, &refusal) || refusal.Reason != "unavailable" {
		t.Fatalf("error=%v, want unavailable refusal", err)
	}
	message := make(chan error, 1)
	go func() { _, recvErr := stream.Recv(); message <- recvErr }()
	select {
	case recvErr := <-message:
		if recvErr == nil {
			t.Fatal("request was sent without the attachment capability")
		}
	case <-time.After(25 * time.Millisecond):
	}
}

func TestRequestAttachmentPromptReadinessRefusals(t *testing.T) {
	cases := []struct {
		name  string
		ready *pibridgepb.AttachmentReadiness
		want  string
		image bool
	}{
		{name: "missing readiness", ready: nil, want: "unavailable"},
		{name: "busy", ready: &pibridgepb.AttachmentReadiness{Idle: false}, want: "busy"},
		{name: "queued", ready: &pibridgepb.AttachmentReadiness{Idle: true, HasPendingMessages: true}, want: "queued"},
		{name: "compaction", ready: &pibridgepb.AttachmentReadiness{Idle: true, CompactionActive: true}, want: "compaction-active"},
		{name: "bridge pending", ready: &pibridgepb.AttachmentReadiness{Idle: true, BridgePending: true}, want: "pending"},
		{name: "unknown image support", ready: &pibridgepb.AttachmentReadiness{Idle: true}, want: "unsupported-model", image: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, sock, cleanup := testServer(t)
			defer cleanup()
			stream, proc, cancel := openAttachmentStream(t, s, sock, "pane-refuse", tc.ready)
			defer cancel()
			ref := AttachmentRef{Basename: "att-0123456789abcdef.bin", SizeBytes: 0, MIMEType: "application/octet-stream", Kind: "file", SHA256: strings.Repeat("b", 64)}
			if tc.image {
				ref = AttachmentRef{Basename: "att-0123456789abcdef.png", SizeBytes: 8, MIMEType: "image/png", Kind: "image", SHA256: strings.Repeat("a", 64)}
			}
			_, err := s.RequestAttachmentPrompt(context.Background(), proc, 1, "session", "leaf", &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"}, "", []AttachmentRef{ref}, tc.image)
			var refusal *AttachmentPromptRefusal
			if !errors.As(err, &refusal) || refusal.Reason != tc.want {
				t.Fatalf("error=%v, want refusal %q", err, tc.want)
			}
			message := make(chan error, 1)
			go func() { _, recvErr := stream.Recv(); message <- recvErr }()
			select {
			case recvErr := <-message:
				if recvErr == nil {
					t.Fatal("refused request was sent to Pi")
				}
			case <-time.After(25 * time.Millisecond):
			}
		})
	}
}

func TestRequestAttachmentPromptPeerLossIsUnknown(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	imageAvailable := true
	stream, proc, cancel := openAttachmentStream(t, s, sock, "pane-loss", attachmentReady(&imageAvailable))
	ref := AttachmentRef{Basename: "att-0123456789abcdef.png", SizeBytes: 8, MIMEType: "image/png", Kind: "image", SHA256: strings.Repeat("a", 64)}
	done := make(chan error, 1)
	go func() {
		ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		_, err := s.RequestAttachmentPrompt(ctx, proc, 1, "session", "leaf", &pibridgepb.ModelSnapshot{Provider: "provider", Model: "model"}, "inspect", []AttachmentRef{ref}, true)
		done <- err
	}()
	ctx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if _, err := stream.Recv(); err != nil {
		t.Fatal(err)
	}
	cancel()
	var unknown *AttachmentPromptUnknown
	select {
	case err := <-done:
		if !errors.As(err, &unknown) {
			t.Fatalf("error=%v, want unknown", err)
		}
	case <-ctx.Done():
		t.Fatal("request did not settle unknown after peer loss")
	}
}
