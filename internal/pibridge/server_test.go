package pibridge

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// testServer starts a bridge Server on a native Unix socket under the
// controlled OS temporary root. It returns the server, socket path,
// and cleanup.
func testServer(t *testing.T) (*Server, string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "phi-pi-test-")
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

func testState(pane, proc string, gen uint64, provider, model string) *pibridgepb.PiToPhi {
	return &pibridgepb.PiToPhi{
		PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
		Payload: &pibridgepb.PiToPhi_StateSnapshot{StateSnapshot: &pibridgepb.StateSnapshot{
			State:     pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
			SessionId: "sess", LeafId: "leaf",
			Model: &pibridgepb.ModelSnapshot{Provider: provider, Model: model},
		}},
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

type stateCall struct {
	gen, rev      uint64
	running       bool
	hasState      bool
	model         string
	thinkingLevel string
	caps          []string
}

func waitStateCalls(t *testing.T, mu *sync.Mutex, calls *[]stateCall, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(*calls)
		mu.Unlock()
		if n >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("state calls %d, want %d", n, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A delayed same-generation callback must report the state it accepted,
// never a newer replacement's capabilities, and the retained lease must
// keep the newest acceptance. A's state callback is held on a barrier
// while B reconnects; delivery is serialized, so B lands after the
// release, and neither A's captured payload nor B's retained state
// may disturb the other.
func TestServerHeldCallbackReportsCapturedState(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-race")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)

	var mu sync.Mutex
	var calls []stateCall
	heldA := make(chan struct{})
	releaseA := make(chan struct{})
	var heldOnce sync.Once
	s.SetOnState(func(_, _ string, gen, rev uint64, running, hasState bool, model, thinkingLevel string, caps []string, _ *ContextUsage, _ *Readiness, _ *ReloadReadiness) {
		if model == "provA/modelA" {
			heldOnce.Do(func() { close(heldA) })
			<-releaseA
		}
		mu.Lock()
		calls = append(calls, stateCall{gen: gen, rev: rev, running: running, hasState: hasState, model: model, thinkingLevel: thinkingLevel, caps: append([]string(nil), caps...)})
		mu.Unlock()
	})

	// A connects with no capabilities and no Hello snapshot.
	streamA, cancelA := openStream(t, sock, "pane-race", proc, token)
	defer cancelA()
	helloA := testHello("pane-race", proc, 1)
	helloA.GetHello().CurrentState = nil
	if err := streamA.Send(helloA); err != nil {
		t.Fatalf("hello A: %v", err)
	}
	recvAccepted(t, streamA)
	waitStateCalls(t, &mu, &calls, 1)

	// A's state snapshot blocks in the callback.
	if err := streamA.Send(testState("pane-race", proc, 1, "provA", "modelA")); err != nil {
		t.Fatalf("state A: %v", err)
	}
	select {
	case <-heldA:
	case <-time.After(5 * time.Second):
		t.Fatal("A callback never held")
	}

	// B reconnects the same generation with capabilities and state.
	// Accepted precedes B's callback, but the callback itself
	// cannot land until A releases: delivery is serialized per
	// lease. B's Hello overwrites the stored caps while A is
	// held, so the released A still proves captured-not-reread.
	streamB, cancelB := openStream(t, sock, "pane-race", proc, token)
	defer cancelB()
	helloB := testHello("pane-race", proc, 1, CapabilityLifecycle)
	helloB.GetHello().GetCurrentState().Model = &pibridgepb.ModelSnapshot{Provider: "provB", Model: "modelB"}
	if err := streamB.Send(helloB); err != nil {
		t.Fatalf("hello B: %v", err)
	}
	recvAccepted(t, streamB)
	close(releaseA)
	waitStateCalls(t, &mu, &calls, 3)

	mu.Lock()
	defer mu.Unlock()
	if calls[0].hasState || calls[0].model != "" {
		t.Fatalf("A hello %+v, want stateless baseline", calls[0])
	}
	if !calls[1].hasState || calls[1].model != "provA/modelA" || len(calls[1].caps) != 0 {
		t.Fatalf("released A %+v, want captured empty caps", calls[1])
	}
	if calls[2].model != "provB/modelB" || len(calls[2].caps) != 1 || calls[2].caps[0] != CapabilityLifecycle {
		t.Fatalf("B %+v, want modelB with lifecycle caps", calls[2])
	}
	if calls[1].rev >= calls[2].rev {
		t.Fatalf("A rev %d not older than B rev %d", calls[1].rev, calls[2].rev)
	}
	view, ok := s.InspectForTest(proc)
	if !ok || view.Model != "provB/modelB" || view.PubRev != calls[2].rev {
		t.Fatalf("retained %+v, want modelB at rev %d", view, calls[2].rev)
	}
}

// A same-generation Hello without a snapshot republishes the retained
// state; a new generation without state keeps model/usage unknown
// instead of inheriting the old process.
func TestServerHelloWithoutStateRepublishRules(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-repub")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)

	var mu sync.Mutex
	var calls []stateCall
	s.SetOnState(func(_, _ string, gen, rev uint64, running, hasState bool, model, thinkingLevel string, caps []string, _ *ContextUsage, _ *Readiness, _ *ReloadReadiness) {
		mu.Lock()
		calls = append(calls, stateCall{gen: gen, rev: rev, running: running, hasState: hasState, model: model, thinkingLevel: thinkingLevel, caps: append([]string(nil), caps...)})
		mu.Unlock()
	})

	streamA, cancelA := openStream(t, sock, "pane-repub", proc, token)
	defer cancelA()
	helloA := testHello("pane-repub", proc, 1, CapabilityLifecycle)
	helloA.GetHello().GetCurrentState().Model = &pibridgepb.ModelSnapshot{Provider: "provA", Model: "modelA"}
	helloA.GetHello().GetCurrentState().ThinkingLevel = "high"
	if err := streamA.Send(helloA); err != nil {
		t.Fatalf("hello A: %v", err)
	}
	recvAccepted(t, streamA)
	waitStateCalls(t, &mu, &calls, 1)

	// Same generation, no snapshot: republish retained modelA.
	streamB, cancelB := openStream(t, sock, "pane-repub", proc, token)
	defer cancelB()
	helloB := testHello("pane-repub", proc, 1, CapabilityLifecycle)
	helloB.GetHello().CurrentState = nil
	if err := streamB.Send(helloB); err != nil {
		t.Fatalf("hello B: %v", err)
	}
	recvAccepted(t, streamB)
	waitStateCalls(t, &mu, &calls, 2)

	// New generation, no snapshot: unknown, never inherited.
	streamC, cancelC := openStream(t, sock, "pane-repub", proc, token)
	defer cancelC()
	helloC := testHello("pane-repub", proc, 2, CapabilityLifecycle)
	helloC.GetHello().RuntimeId = "rt2"
	helloC.GetHello().CurrentState = nil
	if err := streamC.Send(helloC); err != nil {
		t.Fatalf("hello C: %v", err)
	}
	recvAccepted(t, streamC)
	waitStateCalls(t, &mu, &calls, 3)

	mu.Lock()
	defer mu.Unlock()
	if !calls[0].hasState || calls[0].model != "provA/modelA" || calls[0].thinkingLevel != "high" {
		t.Fatalf("A %+v, want modelA", calls[0])
	}
	if !calls[1].hasState || calls[1].model != "provA/modelA" || calls[1].thinkingLevel != "high" || calls[1].rev <= calls[0].rev {
		t.Fatalf("B %+v, want republished modelA at a newer revision", calls[1])
	}
	if calls[2].hasState || calls[2].model != "" || calls[2].thinkingLevel != "" || calls[2].rev <= calls[1].rev {
		t.Fatalf("C %+v, want unknown state at a newer revision", calls[2])
	}
	view, ok := s.InspectForTest(proc)
	if !ok || view.HasState || view.Model != "" || view.ThinkingLevel != "" {
		t.Fatalf("retained %+v, want no state after gen2 hello", view)
	}
}

// An unrecognized thinking level name must not reject the hello or tear
// down the bridge: future Pi releases may add levels. The value passes
// through bounded and degrades to unknown downstream.
func TestServerHelloUnknownThinkingLevelAccepted(t *testing.T) {
	s, sock, cleanup := testServer(t)
	defer cleanup()
	proc, token, err := s.RegisterPending("pane-future-level")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	s.Complete(proc)

	var mu sync.Mutex
	var calls []stateCall
	s.SetOnState(func(_, _ string, gen, rev uint64, running, hasState bool, model, thinkingLevel string, caps []string, _ *ContextUsage, _ *Readiness, _ *ReloadReadiness) {
		mu.Lock()
		calls = append(calls, stateCall{gen: gen, rev: rev, running: running, hasState: hasState, model: model, thinkingLevel: thinkingLevel, caps: append([]string(nil), caps...)})
		mu.Unlock()
	})

	stream, cancel := openStream(t, sock, "pane-future-level", proc, token)
	defer cancel()
	hello := testHello("pane-future-level", proc, 1, CapabilityLifecycle, CapabilityThinking)
	hello.GetHello().GetCurrentState().ThinkingLevel = "ultra"
	if err := stream.Send(hello); err != nil {
		t.Fatalf("hello: %v", err)
	}
	recvAccepted(t, stream)
	waitStateCalls(t, &mu, &calls, 1)

	mu.Lock()
	defer mu.Unlock()
	if !calls[0].hasState || calls[0].thinkingLevel != "ultra" {
		t.Fatalf("calls %+v, want accepted state with pass-through level", calls)
	}
	view, ok := s.InspectForTest(proc)
	if !ok || !view.HasState || view.ThinkingLevel != "ultra" {
		t.Fatalf("retained %+v, want pass-through level", view)
	}
}
