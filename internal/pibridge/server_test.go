package pibridge

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// testServer starts a bridge Server on a native Unix socket in /tmp.
// It returns the server, socket path, and cleanup.
func testServer(t *testing.T) (*Server, string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "phi-pi-test-")
	if err != nil {
		t.Fatalf("tmpdir: %v", err)
	}
	sock := filepath.Join(dir, "s.sock")
	lis, err := net.Listen("unix", sock)
	if err != nil {
		os.RemoveAll(dir)
		t.Fatalf("listen: %v", err)
	}
	s := NewServer()
	go func() { _ = s.GRPCServer().Serve(lis) }()
	// Wait for serve.
	time.Sleep(20 * time.Millisecond)
	return s, sock, func() {
		s.Stop()
		lis.Close()
		os.RemoveAll(dir)
	}
}

func dialUnix(t *testing.T, sock string) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient("passthrough:///unused",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return net.Dial("unix", sock)
		}),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessageBytes), grpc.MaxCallSendMsgSize(maxMessageBytes)),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func outgoingCtx(pane, proc, token string) context.Context {
	return metadata.NewOutgoingContext(context.Background(), metadata.Pairs(
		metadataPaneKey, pane, metadataProcessKey, proc, metadataTokenKey, token,
	))
}

func openStream(t *testing.T, sock, pane, proc, token string) (pibridgepb.Integration_ConnectClient, context.CancelFunc) {
	t.Helper()
	conn := dialUnix(t, sock)
	client := pibridgepb.NewIntegrationClient(conn)
	ctx, cancel := context.WithTimeout(outgoingCtx(pane, proc, token), 10*time.Second)
	stream, err := client.Connect(ctx)
	if err != nil {
		cancel()
		t.Fatalf("Connect: %v", err)
	}
	return stream, cancel
}

func testHello(pane, proc string, gen uint64, caps ...string) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_Hello{
			Hello: &pibridgepb.Hello{
				ProtocolVersion: ProtocolVersion,
				SessionId:       "sess", RuntimeId: "rt", Capabilities: caps,
				CurrentState: &pibridgepb.StateSnapshot{
					State:     pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
					SessionId: "sess", LeafId: "leaf",
					Model: &pibridgepb.ModelSnapshot{Provider: "p", Model: "m"},
				},
			},
		},
	}
}

func recvAccepted(t *testing.T, stream pibridgepb.Integration_ConnectClient) *pibridgepb.Accepted {
	t.Helper()
	msg, err := stream.Recv()
	if err != nil {
		t.Fatalf("recv Accepted: %v", err)
	}
	acc := msg.GetAccepted()
	if acc == nil {
		t.Fatalf("first server message not Accepted: %v", msg.GetPayload())
	}
	return acc
}

func TestConnectWrongToken(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-auth")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-auth", proc, strings.Repeat("0", 64))
	defer cancel()
	_ = token
	if err := stream.Send(testHello("pane-auth", proc, 1, CapabilityLifecycle)); err != nil {
		return // send failed: also auth rejection evidence
	}
	_, err = stream.Recv()
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("code=%v, want Unauthenticated", status.Code(err))
	}
}

func TestConnectPaneMismatch(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-a")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-b", proc, token)
	defer cancel()
	_ = stream.Send(testHello("pane-b", proc, 1, CapabilityLifecycle))
	_, err = stream.Recv()
	if got := status.Code(err); got != codes.PermissionDenied && got != codes.Unauthenticated {
		t.Fatalf("code=%v, want PermissionDenied/Unauthenticated", got)
	}
}

func TestConnectVersionRejected(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-ver")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-ver", proc, token)
	defer cancel()
	hello := testHello("pane-ver", proc, 1, CapabilityLifecycle)
	hello.GetHello().ProtocolVersion = 999
	if err := stream.Send(hello); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Server may send ProtocolError before the status; drain until error.
	for {
		_, err := stream.Recv()
		if err != nil {
			if status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("code=%v, want FailedPrecondition", status.Code(err))
			}
			return
		}
	}
}

func TestHelloLifecycleHandshake(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-hi")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	stream, cancel := openStream(t, sock, "pane-hi", proc, token)
	defer cancel()
	if err := stream.Send(testHello("pane-hi", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send hello: %v", err)
	}
	acc := recvAccepted(t, stream)
	if acc.GetProtocolVersion() != ProtocolVersion {
		t.Fatalf("accepted version %d", acc.GetProtocolVersion())
	}
	if len(acc.GetCapabilities()) != 1 || acc.GetCapabilities()[0] != CapabilityLifecycle {
		t.Fatalf("accepted caps %v", acc.GetCapabilities())
	}
	// Lifecycle events are retained without closing the stream.
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-hi", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentStarted{AgentStarted: &pibridgepb.AgentStarted{EventSequence: 1, RunId: 1}},
	}); err != nil {
		t.Fatalf("send started: %v", err)
	}
	if err := stream.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-hi", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentSettled{AgentSettled: &pibridgepb.AgentSettled{EventSequence: 2, RunId: 1, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED}},
	}); err != nil {
		t.Fatalf("send settled: %v", err)
	}
	// Unknown capability is ignored, not an error.
	if err := stream.CloseSend(); err != nil {
		t.Fatalf("close send: %v", err)
	}
}

func TestStaleGenerationRejected(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-gen")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-gen", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-gen", proc, 2, CapabilityLifecycle)); err != nil {
		t.Fatalf("send gen2: %v", err)
	}
	recvAccepted(t, first)

	second, cancelSecond := openStream(t, sock, "pane-gen", proc, token)
	defer cancelSecond()
	if err := second.Send(testHello("pane-gen", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send gen1: %v", err)
	}
	for {
		_, err := second.Recv()
		if err != nil {
			if status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("stale code=%v", status.Code(err))
			}
			return
		}
	}
}

func TestConflictingRuntimeRejected(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-dup")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-dup", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-dup", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, first)
	second, cancelSecond := openStream(t, sock, "pane-dup", proc, token)
	defer cancelSecond()
	conflict := testHello("pane-dup", proc, 1, CapabilityLifecycle)
	conflict.GetHello().RuntimeId = "different-rt"
	if err := second.Send(conflict); err != nil {
		t.Fatalf("send conflict: %v", err)
	}
	for {
		_, err := second.Recv()
		if err != nil {
			if status.Code(err) != codes.FailedPrecondition {
				t.Fatalf("conflict code=%v", status.Code(err))
			}
			return
		}
	}
}

func TestRejectedHelloKeepsLeaseGeneration(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-bad")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-bad", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-bad", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send gen1: %v", err)
	}
	recvAccepted(t, first)

	// A newer generation with an invalid snapshot is refused. The
	// refusal must leave the lease on generation 1.
	bad, cancelBad := openStream(t, sock, "pane-bad", proc, token)
	defer cancelBad()
	invalid := testHello("pane-bad", proc, 2, CapabilityLifecycle)
	invalid.GetHello().CurrentState.SessionId = "other"
	if err := bad.Send(invalid); err != nil {
		t.Fatalf("send invalid: %v", err)
	}
	for {
		_, err := bad.Recv()
		if err != nil {
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("invalid hello code=%v, want InvalidArgument", status.Code(err))
			}
			break
		}
	}

	// Generation 1 is still live: the refused hello did not advance it.
	again, cancelAgain := openStream(t, sock, "pane-bad", proc, token)
	defer cancelAgain()
	if err := again.Send(testHello("pane-bad", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send gen1 again: %v", err)
	}
	recvAccepted(t, again)
}

func TestReconnectReplacesStreamAtomically(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-re")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-re", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-re", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, first)
	second, cancelSecond := openStream(t, sock, "pane-re", proc, token)
	defer cancelSecond()
	if err := second.Send(testHello("pane-re", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("reconnect send: %v", err)
	}
	recvAccepted(t, second)
	// Old stream must be closed by replacement.
	_, err = first.Recv()
	if status.Code(err) != codes.Canceled {
		t.Fatalf("old stream code=%v, want Canceled", status.Code(err))
	}
	active, _ := s.Stats()
	if active != 1 {
		t.Fatalf("active streams %d, want 1", active)
	}
}

func TestSameGenerationReconnectMergesJournal(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-merge")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-merge", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-merge", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, first)
	if err := first.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-merge", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentStarted{AgentStarted: &pibridgepb.AgentStarted{EventSequence: 1, RunId: 1}},
	}); err != nil {
		t.Fatalf("send started: %v", err)
	}
	// Reconnect with one offline-recorded edge: the duplicate start
	// is ignored and the new settlement merges into the journal.
	second, cancelSecond := openStream(t, sock, "pane-merge", proc, token)
	defer cancelSecond()
	hello := testHello("pane-merge", proc, 1, CapabilityLifecycle)
	hello.GetHello().GetCurrentState().Journal = []*pibridgepb.LifecycleRecord{
		{EventSequence: 1, RunId: 1},
		{EventSequence: 2, RunId: 1, Settled: true, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED},
	}
	if err := second.Send(hello); err != nil {
		t.Fatalf("reconnect send: %v", err)
	}
	recvAccepted(t, second)
	view, ok := s.PaneState(proc)
	if !ok {
		t.Fatal("lease missing after reconnect")
	}
	if view.JournalFirst != 1 || view.JournalLast != 2 {
		t.Fatalf("journal [%d,%d], want [1,2]", view.JournalFirst, view.JournalLast)
	}
}

func TestConcurrentClientsIndependent(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	const n = 8
	type client struct {
		proc   string
		stream pibridgepb.Integration_ConnectClient
		cancel context.CancelFunc
	}
	clients := make([]client, 0, n)
	for i := 0; i < n; i++ {
		pane := "pane-iso-" + string(rune('a'+i))
		proc, token, err := s.RegisterPending(pane)
		if err != nil {
			t.Fatalf("register %d: %v", i, err)
		}
		s.Complete(proc)
		stream, cancel := openStream(t, sock, pane, proc, token)
		hello := testHello(pane, proc, 1, CapabilityLifecycle)
		hello.GetHello().SessionId = "sess-" + pane
		hello.GetHello().RuntimeId = "rt-" + pane
		hello.GetHello().GetCurrentState().SessionId = "sess-" + pane
		if err := stream.Send(hello); err != nil {
			cancel()
			t.Fatalf("hello %d: %v", i, err)
		}
		recvAccepted(t, stream)
		clients = append(clients, client{proc: proc, stream: stream, cancel: cancel})
	}
	for i, c := range clients {
		seq := uint64(i + 1)
		if err := c.stream.Send(&pibridgepb.PiToPhi{
			PaneId: "pane-iso-" + string(rune('a'+i)), ProcessId: c.proc, RuntimeGeneration: 1,
			Payload: &pibridgepb.PiToPhi_AgentStarted{AgentStarted: &pibridgepb.AgentStarted{EventSequence: seq, RunId: seq}},
		}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	time.Sleep(100 * time.Millisecond)
	for i, c := range clients {
		l, ok := s.reg.lookupByProcess(c.proc)
		if !ok {
			t.Fatalf("lease %d missing", i)
		}
		_, _, _, last := func() ([]lifecycleRecord, bool, uint64, uint64) { return l.jrn.snapshot() }()
		if last != uint64(i+1) {
			t.Fatalf("client %d last seq %d", i, last)
		}
		c.cancel()
		_ = c.stream.CloseSend()
	}
}

// Offline settlements merged from a Hello journal must publish exactly
// once through the settlement callback, with the Hello generation.
func TestHelloOfflineSettlementPublishesOnce(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	type settlement struct {
		gen     uint64
		runID   uint64
		outcome pibridgepb.RunOutcome
	}
	var got []settlement
	s.SetOnSettled(func(_, _ string, gen, runID uint64, outcome pibridgepb.RunOutcome) {
		got = append(got, settlement{gen: gen, runID: runID, outcome: outcome})
	})
	proc, token, err := s.RegisterPending("pane-offline")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	first, cancelFirst := openStream(t, sock, "pane-offline", proc, token)
	defer cancelFirst()
	if err := first.Send(testHello("pane-offline", proc, 1, CapabilityLifecycle)); err != nil {
		t.Fatalf("send: %v", err)
	}
	recvAccepted(t, first)
	if err := first.Send(&pibridgepb.PiToPhi{
		PaneId: "pane-offline", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentStarted{AgentStarted: &pibridgepb.AgentStarted{EventSequence: 1, RunId: 1}},
	}); err != nil {
		t.Fatalf("send started: %v", err)
	}
	// Reconnect carries one offline settlement: duplicate start ignored,
	// settlement merges and publishes once.
	second, cancelSecond := openStream(t, sock, "pane-offline", proc, token)
	defer cancelSecond()
	hello := testHello("pane-offline", proc, 1, CapabilityLifecycle)
	hello.GetHello().GetCurrentState().Journal = []*pibridgepb.LifecycleRecord{
		{EventSequence: 1, RunId: 1},
		{EventSequence: 2, RunId: 1, Settled: true, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED},
	}
	if err := second.Send(hello); err != nil {
		t.Fatalf("reconnect send: %v", err)
	}
	recvAccepted(t, second)
	if len(got) != 1 || got[0].gen != 1 || got[0].runID != 1 || got[0].outcome != pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED {
		t.Fatalf("settlements %+v, want one gen1 run1 completed", got)
	}
	// A second Hello with the same journal is duplicate suppression:
	// no second publish.
	third, cancelThird := openStream(t, sock, "pane-offline", proc, token)
	defer cancelThird()
	if err := third.Send(hello); err != nil {
		t.Fatalf("duplicate hello send: %v", err)
	}
	recvAccepted(t, third)
	if len(got) != 1 {
		t.Fatalf("settlements %+v, want still one after duplicate hello", got)
	}
}

// A replaced stream cannot append to the new runtime's journal or
// overwrite its state, and its delayed callbacks carry the old
// generation for host fencing.
func TestStalePeerCannotOverwriteReplacement(t *testing.T) {
	s := NewServer()
	proc, _, err := s.RegisterPending("pane-fence")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)
	l, ok := s.reg.lookupByProcess(proc)
	if !ok {
		t.Fatal("lease missing")
	}
	// Install generation 1, then replace with generation 2.
	oldPeer := newPeer(1, "sess", nil)
	l.mu.Lock()
	l.maxGen, l.runtimeID, l.sessionID = 1, "rt1", "sess"
	l.peer = oldPeer
	l.mu.Unlock()
	newPeerObj := newPeer(2, "sess2", nil)
	l.mu.Lock()
	l.maxGen, l.runtimeID, l.sessionID = 2, "rt2", "sess2"
	l.jrn.reset()
	l.peer = newPeerObj
	l.lastState = &pibridgepb.StateSnapshot{State: pibridgepb.LogicalState_LOGICAL_STATE_IDLE, SessionId: "sess2"}
	l.mu.Unlock()
	var settled int
	s.SetOnSettled(func(_, _ string, _, _ uint64, _ pibridgepb.RunOutcome) { settled++ })
	// Old peer's settled edge must be ignored, not appended.
	if err := s.handleMessage(l, oldPeer, &pibridgepb.PiToPhi{
		PaneId: "pane-fence", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_AgentSettled{AgentSettled: &pibridgepb.AgentSettled{EventSequence: 9, RunId: 9, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED}},
	}); err != nil {
		t.Fatalf("stale settled: %v", err)
	}
	if settled != 0 {
		t.Fatal("stale peer settlement fired")
	}
	if _, _, first, last := l.jrn.snapshot(); first != 0 || last != 0 {
		t.Fatalf("journal [%d,%d], want empty after stale write", first, last)
	}
	// Old peer's snapshot must not overwrite the new runtime's state.
	if err := s.handleMessage(l, oldPeer, &pibridgepb.PiToPhi{
		PaneId: "pane-fence", ProcessId: proc, RuntimeGeneration: 1,
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: &pibridgepb.StateSnapshot{State: pibridgepb.LogicalState_LOGICAL_STATE_RUNNING, SessionId: "sess"}},
	}); err != nil {
		t.Fatalf("stale snapshot: %v", err)
	}
	l.mu.Lock()
	state := l.lastState.GetState()
	l.mu.Unlock()
	if state != pibridgepb.LogicalState_LOGICAL_STATE_IDLE {
		t.Fatalf("last state %v, want IDLE after stale snapshot", state)
	}
	// Current peer still writes.
	if err := s.handleMessage(l, newPeerObj, &pibridgepb.PiToPhi{
		PaneId: "pane-fence", ProcessId: proc, RuntimeGeneration: 2,
		Payload: &pibridgepb.PiToPhi_AgentSettled{AgentSettled: &pibridgepb.AgentSettled{EventSequence: 1, RunId: 1, Outcome: pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED}},
	}); err != nil {
		t.Fatalf("live settled: %v", err)
	}
	if settled != 1 {
		t.Fatalf("live settlements %d, want 1", settled)
	}
}
