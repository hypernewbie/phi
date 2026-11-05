package piapp

import (
	"context"
	"testing"
	"time"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
	"github.com/hypernewbie/phi/pkg/pty"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// openRefreshPane provisions a managed pane bound to inst and completes a
// Hello advertising caps. It returns the live stream for the fake Pi host.
func openRefreshPane(t *testing.T, b *Bridge, pane string, inst *pty.PTYInstance, caps ...string) (pibridgepb.Integration_ConnectClient, context.CancelFunc) {
	t.Helper()
	env, _, managed := b.Provision(pane, true)
	if !managed {
		t.Fatal("provision not managed")
	}
	b.Complete(inst)
	stream, cancel := dialBridge(t, b, pane, env[piBridgeEnvProcess], env[piBridgeEnvToken])
	hello := &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: env[piBridgeEnvProcess], RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_Hello{Hello: &pibridgepb.Hello{
			ProtocolVersion: 1, SessionId: "sess", RuntimeId: "rt",
			Capabilities: caps,
			CurrentState: &pibridgepb.StateSnapshot{
				State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess",
			},
		}},
	}
	if err := stream.Send(hello); err != nil {
		cancel()
		t.Fatalf("hello: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		cancel()
		t.Fatalf("accepted: %v", err)
	}
	return stream, cancel
}

func TestDispatchTerminalRefreshRoundTrip(t *testing.T) {
	b := startTestBridge(t)
	inst := &pty.PTYInstance{ID: "pane-refresh"}
	stream, cancel := openRefreshPane(t, b, "pane-refresh", inst, "pi.lifecycle.v1", "pi.terminal-refresh.v1")
	defer cancel()

	type outcome struct {
		value  wspb.TerminalRefreshOutcome
		reason string
	}
	done := make(chan outcome, 1)
	go func() {
		value, reason := b.DispatchTerminalRefresh(context.Background(), "pane-refresh", inst)
		done <- outcome{value: value, reason: reason}
	}()

	msg, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv request: %v", err)
	}
	req := msg.GetTerminalRefreshRequest()
	if req == nil {
		t.Fatalf("not a refresh request: %v", msg.GetPayload())
	}
	if req.GetRequestId() == "" || req.GetRequestId()[0] == '0' {
		t.Fatalf("request id %q is not a positive decimal", req.GetRequestId())
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: msg.GetPaneId(), ProcessId: msg.GetProcessId(), RuntimeGeneration: msg.GetRuntimeGeneration(),
		Payload: &pibridgepb.PiToPhi_TerminalRefreshAck{TerminalRefreshAck: &pibridgepb.TerminalRefreshAck{
			RequestId: req.GetRequestId(),
			Outcome:   pibridgepb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED,
		}},
	}); err != nil {
		t.Fatalf("send ack: %v", err)
	}

	select {
	case got := <-done:
		if got.value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED || got.reason != "" {
			t.Fatalf("dispatch = %v/%q, want DISPATCHED", got.value, got.reason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch did not return")
	}
}

func TestDispatchTerminalRefreshNeedsTheCurrentOwnerAndCapability(t *testing.T) {
	b := startTestBridge(t)
	inst := &pty.PTYInstance{ID: "pane-refresh-owner"}
	_, cancel := openRefreshPane(t, b, "pane-refresh-owner", inst, "pi.lifecycle.v1", "pi.terminal-refresh.v1")
	defer cancel()

	// A replaced or duplicate PTY instance never repaints the live process.
	replacement := &pty.PTYInstance{ID: "pane-refresh-owner"}
	value, reason := b.DispatchTerminalRefresh(context.Background(), "pane-refresh-owner", replacement)
	if value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || reason != "unavailable" {
		t.Fatalf("replaced owner = %v/%q, want NOT_SENT/unavailable", value, reason)
	}
	value, reason = b.DispatchTerminalRefresh(context.Background(), "missing-pane", inst)
	if value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || reason != "unavailable" {
		t.Fatalf("unknown pane = %v/%q, want NOT_SENT/unavailable", value, reason)
	}

	// An unmanaged pane has no host to repaint.
	value, reason = b.DispatchTerminalRefresh(context.Background(), "unmanaged", nil)
	if value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || reason != "unavailable" {
		t.Fatalf("unmanaged pane = %v/%q, want NOT_SENT/unavailable", value, reason)
	}
}

func TestDispatchTerminalRefreshWithoutCapabilityKeepsFallback(t *testing.T) {
	b := startTestBridge(t)
	inst := &pty.PTYInstance{ID: "pane-refresh-plain"}
	stream, cancel := openRefreshPane(t, b, "pane-refresh-plain", inst, "pi.lifecycle.v1")
	defer cancel()

	value, reason := b.DispatchTerminalRefresh(context.Background(), "pane-refresh-plain", inst)
	if value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || reason != "unavailable" {
		t.Fatalf("missing capability = %v/%q, want NOT_SENT/unavailable", value, reason)
	}
	// Nothing reached the host.
	recv := make(chan *pibridgepb.PhiToPi, 1)
	go func() {
		msg, err := stream.Recv()
		if err != nil {
			recv <- nil
			return
		}
		recv <- msg
	}()
	select {
	case msg := <-recv:
		if msg != nil && msg.GetTerminalRefreshRequest() != nil {
			t.Fatal("refresh request reached a host without the capability")
		}
	case <-time.After(200 * time.Millisecond):
	}
}

func TestDispatchTerminalRefreshNilBridge(t *testing.T) {
	var b *Bridge
	value, reason := b.DispatchTerminalRefresh(context.Background(), "pane", &pty.PTYInstance{ID: "pane"})
	if value != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT || reason != "unavailable" {
		t.Fatalf("nil bridge = %v/%q, want NOT_SENT/unavailable", value, reason)
	}
}

func TestTerminalRefreshHintFollowsTheLiveCapability(t *testing.T) {
	b := startTestBridge(t)
	inst := &pty.PTYInstance{ID: "pane-refresh-hint"}
	_, cancel := openRefreshPane(t, b, "pane-refresh-hint", inst, "pi.lifecycle.v1", "pi.terminal-refresh.v1")
	defer cancel()

	if !b.terminalRefreshHint("pane-refresh-hint") {
		t.Fatal("capable pane did not advertise its repaint hint")
	}
	if b.terminalRefreshHint("missing-pane") {
		t.Fatal("unknown pane advertised a repaint hint")
	}
}
