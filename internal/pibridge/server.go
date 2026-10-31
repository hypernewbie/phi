package pibridge

import (
	"encoding/hex"
	"fmt"
	"io"
	"slices"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// Server owns one local IPC gRPC service for provisioned Pi processes.
// It holds process leases, authenticates streams, enforces bounds, and
// retains bounded lifecycle state.
type Server struct {
	pibridgepb.UnimplementedIntegrationServer

	reg *registry

	grpcServer       *grpc.Server
	onSettled        func(paneID, processID string, generation, runID uint64, outcome pibridgepb.RunOutcome)
	onState          func(paneID, processID string, generation, pubRev uint64, running, hasState bool, model, thinkingLevel string, caps []string, usage *ContextUsage, readiness *Readiness, reload *ReloadReadiness)
	onPeerDown       func(paneID, processID string, generation uint64)
	histSeq          atomic.Uint64
	modelsSeq        atomic.Uint64
	setSeq           atomic.Uint64
	thinkingSeq      atomic.Uint64
	setThinkingSeq   atomic.Uint64
	skillsSeq        atomic.Uint64
	invokeSkillSeq   atomic.Uint64
	syncboardHandler SyncboardHandler
	attachmentSeq  atomic.Uint64
	stateSeq       atomic.Uint64
	// compactSeq allocates monotonic server-side Compact request
	// IDs. IDs are positive canonical decimal uint64 strings,
	// never wrap, and are never reused or browser-supplied.
	compactSeq atomic.Uint64
	// reloadSeq allocates monotonic server-side Reload request
	// IDs with the same uniqueness contract as compactSeq.
	reloadSeq atomic.Uint64
	// pubSeq is the server-owned publication sequence behind
	// telemetry_revision. It is allocated at lease creation and at
	// each accepted Hello/state change, so delayed stream callbacks
	// can be fenced without touching the Pi wire schema.
	pubSeq atomic.Uint64
}

// NewServer creates a bridge server with bounded gRPC limits and no TCP
// listener. Callers serve it on a private IPC listener from NewEndpoint.
func NewServer() *Server {
	s := &Server{reg: newRegistry()}
	s.grpcServer = grpc.NewServer(
		grpc.MaxRecvMsgSize(maxMessageBytes),
		grpc.MaxSendMsgSize(maxMessageBytes),
		grpc.MaxHeaderListSize(maxMetadataBytes),
	)
	pibridgepb.RegisterIntegrationServer(s.grpcServer, s)
	return s
}

// GRPCServer exposes the configured gRPC server for Serve.
func (s *Server) GRPCServer() *grpc.Server {
	return s.grpcServer
}

// SetOnSettled registers the callback fired once for each freshly appended
// settlement edge (duplicates and out-of-order edges never fire), including
// offline edges merged from a Hello journal. Set before
// serving; the callback runs on a stream goroutine, must return quickly,
// and must not call back into the Server.
func (s *Server) SetOnSettled(fn func(paneID, processID string, generation, runID uint64, outcome pibridgepb.RunOutcome)) {
	s.onSettled = fn
}

// SetOnState registers the callback fired after each accepted snapshot
// (hello or state) updates the stored lease state. Same contract as
// SetOnSettled; the callback receives copies, never shared slices.
// pubRev is the server-owned publication revision for this exact
// acceptance; hasState is false when the runtime published no snapshot
// (model/thinking level/usage stay unknown, never invented). usage
// and readiness are copies of the accepted telemetry, nil when the
// snapshot carried none: unknown usage is distinct from zero and from
// an absent capability.
func (s *Server) SetOnState(fn func(paneID, processID string, generation, pubRev uint64, running, hasState bool, model, thinkingLevel string, caps []string, usage *ContextUsage, readiness *Readiness, reload *ReloadReadiness)) {
	s.onState = fn
}

// fireState reports one acceptance to the state callback. The
// revision, snapshot, and capabilities are captured under the lease
// lock by the caller; fireState never re-reads them, so a delayed
// callback reports the state it accepted, never a newer
// replacement. A nil snapshot keeps model/usage unknown. Delivery
// is serialized per lease with peer-down callbacks, and a
// replaced or revoked peer is dropped, so no stale state lands
// after its peer went down.
func (s *Server) fireState(l *lease, p *peer, pubRev uint64, snap *pibridgepb.StateSnapshot, caps []string) {
	if s.onState == nil {
		return
	}
	l.notifyMu.Lock()
	defer l.notifyMu.Unlock()
	l.mu.Lock()
	if l.peer != p || l.state == leaseRevoked || l.maxGen != p.generation {
		l.mu.Unlock()
		return
	}
	paneID, processID, generation := l.paneID, l.processID, p.generation
	l.mu.Unlock()
	hasState := snap != nil
	running := snap != nil && snap.GetState() == pibridgepb.LogicalState_LOGICAL_STATE_RUNNING
	model, thinkingLevel := "", ""
	if snap != nil {
		thinkingLevel = snap.GetThinkingLevel()
		if m := snap.GetModel(); m != nil {
			model = m.GetProvider() + "/" + m.GetModel()
		}
	}
	s.onState(paneID, processID, generation, pubRev, running, hasState, model, thinkingLevel, caps, copyContextUsage(snap), copyReadiness(snap), copyReloadReadiness(snap))
}

// SetOnPeerDown registers the callback fired once when the active peer
// of a lease disconnects. Same contract as SetOnSettled; the host uses
// it to publish current connection availability. Replacements do not
// fire: detaching a peer that is no longer active is a no-op.
func (s *Server) SetOnPeerDown(fn func(paneID, processID string, generation uint64)) {
	s.onPeerDown = fn
}

// SetSyncboardHandler enables the Syncboard capability. Call before serving.
// Without a handler, the server does not negotiate pi.syncboard.v1.
func (s *Server) SetSyncboardHandler(fn SyncboardHandler) {
	s.syncboardHandler = fn
}

// Stop drains gracefully for shutdownDrainTimeout, then force-stops.
func (s *Server) Stop() {
	done := make(chan struct{})
	go func() {
		s.grpcServer.GracefulStop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(shutdownDrainTimeout):
		s.grpcServer.Stop()
	}
}

// RegisterPending creates a pending lease for a pane before spawn. It
// returns the opaque process nonce and hex-encoded 32-byte token for the
// child environment only. Never log or persist the token.
func (s *Server) RegisterPending(paneID string) (processID, tokenHex string, err error) {
	if paneID == "" {
		return "", "", fmt.Errorf("pibridge: pane id required")
	}
	l, err := s.reg.registerPending(paneID)
	if err != nil {
		return "", "", err
	}
	l.mu.Lock()
	l.pubRev = s.pubSeq.Add(1)
	l.mu.Unlock()
	return l.processID, hex.EncodeToString(l.token[:]), nil
}

// PublicationRevision reports the lease's latest publication revision:
// the creation baseline before any Hello, or the newest accepted
// Hello/state change. It reports false when the process has no lease.
func (s *Server) PublicationRevision(processID string) (uint64, bool) {
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return 0, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.pubRev, true
}

// Complete marks a pending lease live after successful spawn.
func (s *Server) Complete(processID string) {
	s.reg.complete(processID)
}

// Revoke removes a lease and closes its peer.
func (s *Server) Revoke(processID string) {
	s.reg.revoke(processID)
}

// Stats reports active streams and leases for tests.
func (s *Server) Stats() (activeStreams, leases int) {
	s.reg.mu.Lock()
	defer s.reg.mu.Unlock()
	leases = len(s.reg.byProcess)
	for _, l := range s.reg.byProcess {
		l.mu.Lock()
		if l.peer != nil {
			activeStreams++
		}
		l.mu.Unlock()
	}
	return activeStreams, leases
}

// ContextUsage is a validated copy of one context telemetry sample.
// A nil *ContextUsage means the snapshot carried no measurement:
// unknown usage, distinct from zero and from an absent capability.
// Each known field preserves explicit presence: a zero token count
// stays a present zero, never unknown.
type ContextUsage struct {
	Tokens     float64
	Window     float64
	Percent    float64
	HasTokens  bool
	HasWindow  bool
	HasPercent bool
}

// Readiness is a copy of one compaction-readiness sample. A nil
// *Readiness means the snapshot carried none (capability absent or
// APIs missing), distinct from a present all-false sample.
type Readiness struct {
	Idle               bool
	HasPendingMessages bool
	CompactionActive   bool
	BridgePending      bool
}

// ReloadReadiness is a copy of one native-reload readiness sample.
// A nil *ReloadReadiness means the snapshot carried none, distinct
// from a present sample. RunID, ContextRevision, and HighWater
// preserve explicit presence: a known zero stays present, never
// unknown, and an absent high-water mark stays absent.
type ReloadReadiness struct {
	RunID              uint64
	HasRunID           bool
	ContextRevision    uint64
	HasContextRevision bool
	Idle               bool
	HasPendingMessages bool
	CompactionActive   bool
	CompactPending     bool
	ReloadPending      bool
	HighWater          uint64
	HasHighWater       bool
}

// AttachmentReadiness is sampled independently of Compact. A nil image
// modality means that the current model is unknown.
type AttachmentReadiness struct {
	Idle               bool
	HasPendingMessages bool
	CompactionActive   bool
	BridgePending      bool
	ImageAvailable     *bool
}

// copyContextUsage copies validated telemetry out of a snapshot. A
// nil snapshot or absent sample yields nil (unknown), never zero.
func copyContextUsage(snap *pibridgepb.StateSnapshot) *ContextUsage {
	u := snap.GetContextUsage()
	if u == nil {
		return nil
	}
	out := &ContextUsage{}
	if t := u.Tokens; t != nil {
		out.Tokens, out.HasTokens = *t, true
	}
	if w := u.ContextWindow; w != nil {
		out.Window, out.HasWindow = *w, true
	}
	if p := u.Percent; p != nil {
		out.Percent, out.HasPercent = *p, true
	}
	return out
}

// copyReloadReadiness copies the reload-readiness sample out of a
// snapshot. A nil snapshot or absent sample yields nil, never an
// invented sample. Known zero counters stay present.
func copyReloadReadiness(snap *pibridgepb.StateSnapshot) *ReloadReadiness {
	r := snap.GetReloadReadiness()
	if r == nil {
		return nil
	}
	out := &ReloadReadiness{
		Idle:               r.GetIdle(),
		HasPendingMessages: r.GetHasPendingMessages(),
		CompactionActive:   r.GetCompactionActive(),
		CompactPending:     r.GetCompactPending(),
		ReloadPending:      r.GetReloadPending(),
	}
	if v := r.RunId; v != nil {
		out.RunID, out.HasRunID = *v, true
	}
	if v := r.ContextRevision; v != nil {
		out.ContextRevision, out.HasContextRevision = *v, true
	}
	if v := r.HighWater; v != nil {
		out.HighWater, out.HasHighWater = *v, true
	}
	return out
}

// copyReadiness copies the readiness sample out of a snapshot. A nil
// snapshot or absent sample yields nil, never an invented sample.
func copyAttachmentReadiness(snap *pibridgepb.StateSnapshot) *AttachmentReadiness {
	r := snap.GetAttachmentReadiness()
	if r == nil {
		return nil
	}
	var imageAvailable *bool
	if r.ImageAvailable != nil {
		v := *r.ImageAvailable
		imageAvailable = &v
	}
	return &AttachmentReadiness{
		Idle: r.GetIdle(), HasPendingMessages: r.GetHasPendingMessages(),
		CompactionActive: r.GetCompactionActive(), BridgePending: r.GetBridgePending(),
		ImageAvailable: imageAvailable,
	}
}

func copyReadiness(snap *pibridgepb.StateSnapshot) *Readiness {
	r := snap.GetCompactReadiness()
	if r == nil {
		return nil
	}
	return &Readiness{
		Idle:               r.GetIdle(),
		HasPendingMessages: r.GetHasPendingMessages(),
		CompactionActive:   r.GetCompactionActive(),
		BridgePending:      r.GetBridgePending(),
	}
}

// StateView is the nonsecret lease inspection surface for the host and
// tests. It carries no tokens, process nonces beyond the lookup key, or
// payloads. Session, leaf, model, thinking level, capability, and runtime identities are
// the same values published to browsers and logs.
type StateView struct {
	HasPeer       bool
	HasState      bool
	State         pibridgepb.LogicalState
	Revision      uint64
	PubRev        uint64
	JournalFirst  uint64
	JournalLast   uint64
	JournalGap    bool
	Generation    uint64
	RuntimeID     string
	Caps          []string
	SessionID     string
	LeafID        string
	Model         string
	ModelProvider string
	ModelID       string
	ThinkingLevel string
	// Context and Readiness are copies of the retained snapshot's
	// telemetry, nil when it carried none. Unknown usage is
	// distinct from zero and from an absent capability.
	Context             *ContextUsage
	Readiness           *Readiness
	AttachmentReadiness *AttachmentReadiness
	// Reload is the retained reload-readiness copy, nil when the
	// snapshot carried none. Known zero counters stay present.
	Reload *ReloadReadiness
}

// PaneState returns the nonsecret lease view for one process. It reports
// false when the process has no lease.
func (s *Server) paneStateLocked(l *lease) StateView {
	view := StateView{
		HasPeer:    l.peer != nil,
		Generation: l.maxGen,
		PubRev:     l.pubRev,
		RuntimeID:  l.runtimeID,
		SessionID:  l.sessionID,
	}
	view.Caps = append(view.Caps, l.caps...)
	if l.lastState != nil {
		view.HasState = true
		view.State = l.lastState.State
		view.Revision = l.lastState.StateRevision
		if l.lastState.SessionId != "" {
			view.SessionID = l.lastState.SessionId
		}
		view.LeafID = l.lastState.LeafId
		if m := l.lastState.Model; m != nil {
			view.Model = m.Provider + "/" + m.Model
			view.ModelProvider = m.Provider
			view.ModelID = m.Model
		}
		view.ThinkingLevel = l.lastState.GetThinkingLevel()
		view.Context = copyContextUsage(l.lastState)
		view.Readiness = copyReadiness(l.lastState)
		view.Reload = copyReloadReadiness(l.lastState)
		view.AttachmentReadiness = copyAttachmentReadiness(l.lastState)
		if view.AttachmentReadiness != nil && (l.compact != nil || l.reload != nil || l.attachment != nil) {
			view.AttachmentReadiness.BridgePending = true
		}
	}
	return view
}

func (s *Server) PaneState(processID string) (StateView, bool) {
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return StateView{}, false
	}
	l.mu.Lock()
	view := s.paneStateLocked(l)
	l.mu.Unlock()
	_, gap, first, last := l.jrn.snapshot()
	view.JournalFirst = first
	view.JournalLast = last
	view.JournalGap = gap
	return view, true
}

// InspectForTest is PaneState for the interop harness.
func (s *Server) InspectForTest(processID string) (StateView, bool) {
	return s.PaneState(processID)
}

// FloodForTest enqueues count dummy ProtocolError messages to exercise
// the slow-peer bound. It returns how many enqueued before overflow.
// Test-only; production sends Accepted once plus rare ProtocolErrors.
func (s *Server) FloodForTest(processID string, count int) int {
	l, ok := s.reg.lookupByProcess(processID)
	if !ok {
		return 0
	}
	l.mu.Lock()
	p := l.peer
	pane := l.paneID
	proc := l.processID
	var gen uint64
	if p != nil {
		gen = p.generation
	}
	l.mu.Unlock()
	if p == nil {
		return 0
	}
	sent := 0
	for i := 0; i < count; i++ {
		msg := &pibridgepb.PhiToPi{
			PaneId:            pane,
			ProcessId:         proc,
			RuntimeGeneration: gen,
			Payload: &pibridgepb.PhiToPi_ProtocolError{
				ProtocolError: &pibridgepb.ProtocolError{Code: pibridgepb.ProtocolErrorCode_PROTOCOL_ERROR_BAD_PAYLOAD, SafeMessage: "flood"},
			},
		}
		if !p.send(msg) {
			break
		}
		sent++
	}
	return sent
}

// Connect implements the generated Integration service: one long-lived
// bidirectional stream per provisioned runtime.
func (s *Server) Connect(stream pibridgepb.Integration_ConnectServer) error {
	admission := time.Now()
	ctx := stream.Context()
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "missing credentials")
	}
	if err := checkMetadataSize(md); err != nil {
		return status.Error(codes.ResourceExhausted, "metadata too large")
	}
	panes := md.Get(metadataPaneKey)
	tokens := md.Get(metadataTokenKey)
	procs := md.Get(metadataProcessKey)
	if len(panes) != 1 || len(tokens) != 1 || len(procs) != 1 {
		return status.Error(codes.Unauthenticated, "credentials required")
	}
	pane, tokenHex, proc := panes[0], tokens[0], procs[0]
	if pane == "" || proc == "" || tokenHex == "" {
		return status.Error(codes.Unauthenticated, "credentials required")
	}
	l, ok := s.reg.lookupByProcess(proc)
	if !ok {
		return status.Error(codes.Unauthenticated, "unknown process")
	}
	if l.paneID != pane {
		return status.Error(codes.PermissionDenied, "pane mismatch")
	}
	if !l.authenticateToken(tokenHex) {
		return status.Error(codes.Unauthenticated, "bad token")
	}

	remaining := helloDeadline - time.Since(admission)
	if remaining <= 0 {
		return status.Error(codes.DeadlineExceeded, "hello deadline")
	}
	first, err := recvWithTimeout(stream, remaining)
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			return status.Error(codes.DeadlineExceeded, "hello deadline")
		}
		return err
	}
	if first.GetPaneId() != pane || first.GetProcessId() != proc {
		return status.Error(codes.PermissionDenied, "identity mismatch")
	}
	if first.GetRuntimeGeneration() == 0 {
		return status.Error(codes.InvalidArgument, "generation required")
	}
	if proto.Size(first) > maxHelloBytes {
		return status.Error(codes.ResourceExhausted, "hello too large")
	}
	hello := first.GetHello()
	if hello == nil {
		return status.Error(codes.InvalidArgument, "first message must be hello")
	}
	if hello.GetProtocolVersion() != ProtocolVersion {
		_ = trySendProtocolError(stream, pane, proc, first.GetRuntimeGeneration(), pibridgepb.ProtocolErrorCode_PROTOCOL_ERROR_UNSUPPORTED_VERSION, "unsupported version")
		return status.Error(codes.FailedPrecondition, "unsupported version")
	}
	if hello.GetRuntimeId() == "" || hello.GetSessionId() == "" {
		return status.Error(codes.InvalidArgument, "runtime and session required")
	}
	caps := negotiateCapabilities(hello.GetCapabilities(), s.syncboardHandler != nil)

	l.mu.Lock()
	gen := first.GetRuntimeGeneration()
	if gen < l.maxGen {
		l.mu.Unlock()
		_ = trySendProtocolError(stream, pane, proc, gen, pibridgepb.ProtocolErrorCode_PROTOCOL_ERROR_STALE_GENERATION, "stale generation")
		return status.Error(codes.FailedPrecondition, "stale generation")
	}
	sameGen := gen == l.maxGen && l.maxGen != 0
	if sameGen && (l.runtimeID != hello.GetRuntimeId() || l.sessionID != hello.GetSessionId()) {
		l.mu.Unlock()
		_ = trySendProtocolError(stream, pane, proc, gen, pibridgepb.ProtocolErrorCode_PROTOCOL_ERROR_DUPLICATE_RUNTIME, "conflicting runtime")
		return status.Error(codes.FailedPrecondition, "conflicting runtime")
	}
	snap := hello.GetCurrentState()
	if snap != nil {
		// Validate before the lease changes: a rejected hello must
		// not advance the generation or the retained state.
		if err := validateSnapshot(snap, hello.GetSessionId()); err != nil {
			l.mu.Unlock()
			return status.Error(codes.InvalidArgument, err.Error())
		}
	}
	if !sameGen {
		l.maxGen = gen
		l.runtimeID = hello.GetRuntimeId()
		l.sessionID = hello.GetSessionId()
		l.jrn.reset()
		// A new generation clears request-specific Compact
		// results: any unresolved operation belonged to the old
		// runtime. Unresolved process-owned native work still
		// reports through the fresh authoritative readiness.
		l.compact = nil
		l.attachment = nil
		// A new generation never clears an unresolved Reload:
		// the native callback outlives its runtime. The fresh
		// Hello readiness below retires it on release evidence.
	}
	type pendingSettlement struct {
		runID   uint64
		outcome pibridgepb.RunOutcome
	}
	var pending []pendingSettlement
	if snap != nil {
		if sameGen {
			// Same-generation reconnect baseline: reconcile a
			// pending-to-released transition before the
			// overwrite. A new generation already cleared the
			// Compact operation above.
			reconcileCompactRelease(l, snap)
		}
		// Reload retires only on explicit release evidence, on
		// any current snapshot: replacement alone never clears it.
		reconcileReloadRetirement(l, snap)
		l.lastState = snap
		// Merge the edges the runtime recorded while offline.
		// Duplicates are ignored; only advancing sequences land. A new
		// runtime starts from a fresh journal, so its gap stays in
		// lastState and the journal fills from live events.
		for _, r := range snap.GetJournal() {
			if l.jrn.append(r.GetEventSequence(), r.GetRunId(), r.GetSettled(), r.GetOutcome()) && r.GetSettled() {
				pending = append(pending, pendingSettlement{runID: r.GetRunId(), outcome: r.GetOutcome()})
			}
		}
	} else if !sameGen {
		l.lastState = nil
	}
	if l.state == leaseRevoked {
		l.mu.Unlock()
		return status.Error(codes.Canceled, "lease revoked")
	}
	oldPeer := l.peer
	p := newPeer(gen, hello.GetSessionId(), stream)
	l.peer = p
	l.caps = l.caps[:0]
	for c := range caps {
		l.caps = append(l.caps, c)
	}
	slices.Sort(l.caps)
	// Capture the publication under the lease lock: the revision, the
	// negotiated capabilities, and the snapshot to publish. A
	// same-generation Hello without a snapshot republishes the
	// retained state; a new generation without state keeps
	// model/usage unknown instead of inheriting the old process.
	pubRev := s.pubSeq.Add(1)
	l.pubRev = pubRev
	publish := snap
	if publish == nil && sameGen {
		publish = l.lastState
	}
	// Explicit non-nil copy, like the state path: fireState never
	// re-reads the lease.
	publishCaps := append([]string{}, l.caps...)
	l.mu.Unlock()

	if oldPeer != nil {
		oldPeer.closeWith(codes.Canceled, "replaced by reconnect")
	}
	go p.runWriter()

	// Publish offline settlements merged from the Hello journal before the
	// state snapshot, mirroring the live settled-then-state order. The
	// journal already merged under the lease lock; publishing here (after
	// unlock, before Accepted) survives an Accepted delivery failure that
	// would otherwise strand the edges as future duplicates. Fenced to the
	// installing peer so a concurrent replacement wins.
	if len(pending) > 0 && s.onSettled != nil {
		l.mu.Lock()
		current := l.peer == p && l.maxGen == gen && l.state != leaseRevoked
		l.mu.Unlock()
		if current {
			for _, st := range pending {
				s.onSettled(pane, proc, gen, st.runID, st.outcome)
			}
		}
	}

	acceptedCaps := make([]string, 0, len(caps))
	for c := range caps {
		acceptedCaps = append(acceptedCaps, c)
	}
	slices.Sort(acceptedCaps)
	accepted := &pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_Accepted{
			Accepted: &pibridgepb.Accepted{
				ProtocolVersion:   ProtocolVersion,
				Capabilities:      acceptedCaps,
				RuntimeGeneration: gen,
				RuntimeId:         hello.GetRuntimeId(),
			},
		},
	}
	if !p.send(accepted) {
		s.detachPeer(l, p)
		if err := p.closeErr(); err != nil {
			return err
		}
		return status.Error(codes.Unavailable, "peer closed")
	}
	s.fireState(l, p, pubRev, publish, publishCaps)

	for {
		msg, err := p.recv()
		if err != nil {
			s.detachPeer(l, p)
			if err == io.EOF {
				return nil
			}
			return err
		}
		if msg.GetPaneId() != pane || msg.GetProcessId() != proc || msg.GetRuntimeGeneration() != gen {
			s.detachPeer(l, p)
			_ = p.send(&pibridgepb.PhiToPi{
				PaneId: pane, ProcessId: proc, RuntimeGeneration: gen,
				Payload: &pibridgepb.PhiToPi_ProtocolError{
					ProtocolError: &pibridgepb.ProtocolError{Code: pibridgepb.ProtocolErrorCode_PROTOCOL_ERROR_BAD_IDENTITY, SafeMessage: "identity mismatch"},
				},
			})
			p.closeWith(codes.PermissionDenied, "identity mismatch")
			return status.Error(codes.PermissionDenied, "identity mismatch")
		}
		if msg.GetPayload() == nil {
			s.detachPeer(l, p)
			return status.Error(codes.InvalidArgument, "missing payload")
		}
		if err := s.handleMessage(l, p, msg); err != nil {
			s.detachPeer(l, p)
			return err
		}
	}
}

// detachPeer removes p from its lease when it is still the active peer.
// Journal and last state are preserved for reconnect. Clearing the
// active peer publishes one peer-down for current-availability
// tracking; detaching an already-replaced peer stays silent.
func (s *Server) detachPeer(l *lease, p *peer) {
	l.notifyMu.Lock()
	defer l.notifyMu.Unlock()
	l.mu.Lock()
	cleared := l.peer == p
	if cleared {
		l.peer = nil
	}
	pane, proc, gen := l.paneID, l.processID, p.generation
	l.mu.Unlock()
	p.closeWith(codes.Canceled, "stream closed")
	if cleared && s.onPeerDown != nil {
		s.onPeerDown(pane, proc, gen)
	}
}

// handleMessage validates and applies one Pi → Phi message. Protocol
// violations close the stream with a gRPC status. Stale peers (replaced
// or revoked) are ignored: the check runs under the lease lock and the
// journal append holds that lock, so a replacement reset cannot interleave
// with an old append. Callbacks carry the peer generation so the host can
// fence delayed old callbacks after the lock is released.
func (s *Server) handleMessage(l *lease, p *peer, msg *pibridgepb.PiToPhi) error {
	switch {
	case msg.GetHello() != nil:
		return status.Error(codes.InvalidArgument, "duplicate hello")
	case msg.GetAgentStarted() != nil:
		ev := msg.GetAgentStarted()
		if ev.GetEventSequence() == 0 || ev.GetRunId() == 0 {
			return status.Error(codes.InvalidArgument, "lifecycle ids required")
		}
		l.mu.Lock()
		if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
			l.mu.Unlock()
			return nil
		}
		l.jrn.append(ev.GetEventSequence(), ev.GetRunId(), false, pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED)
		l.mu.Unlock()
		return nil
	case msg.GetAgentSettled() != nil:
		ev := msg.GetAgentSettled()
		if ev.GetEventSequence() == 0 || ev.GetRunId() == 0 {
			return status.Error(codes.InvalidArgument, "lifecycle ids required")
		}
		switch ev.GetOutcome() {
		case pibridgepb.RunOutcome_RUN_OUTCOME_UNSPECIFIED,
			pibridgepb.RunOutcome_RUN_OUTCOME_COMPLETED,
			pibridgepb.RunOutcome_RUN_OUTCOME_ERROR,
			pibridgepb.RunOutcome_RUN_OUTCOME_ABORTED:
		default:
			return status.Error(codes.InvalidArgument, "unknown outcome")
		}
		l.mu.Lock()
		if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
			l.mu.Unlock()
			return nil
		}
		fresh := l.jrn.append(ev.GetEventSequence(), ev.GetRunId(), true, ev.GetOutcome())
		pane, proc, gen := l.paneID, l.processID, p.generation
		runID, outcome := ev.GetRunId(), ev.GetOutcome()
		l.mu.Unlock()
		if fresh {
			// Fresh edge only: duplicates and out-of-order arrivals never
			// notify. No locks are held here; the callback must not call
			// back into the Server. The generation lets the host drop a
			// delayed old callback after a replacement.
			if s.onSettled != nil {
				s.onSettled(pane, proc, gen, runID, outcome)
			}
		}
		return nil
	case msg.GetStateSnapshot() != nil:
		snap := msg.GetStateSnapshot()
		if err := validateSnapshot(snap, p.sessionID); err != nil {
			return status.Error(codes.InvalidArgument, err.Error())
		}
		l.mu.Lock()
		if l.peer != p || l.state == leaseRevoked || p.generation != l.maxGen {
			l.mu.Unlock()
			return nil
		}
		// Reconcile before the overwrite: the retained readiness
		// is the pending half of a release transition.
		reconcileCompactRelease(l, snap)
		reconcileReloadRetirement(l, snap)
		l.lastState = snap
		pubRev := s.pubSeq.Add(1)
		l.pubRev = pubRev
		// Explicit non-nil copy: fireState must not re-read the
		// lease, so an empty negotiated set still arrives as an
		// empty list rather than triggering a stored-set lookup.
		caps := append([]string{}, l.caps...)
		l.mu.Unlock()
		s.fireState(l, p, pubRev, snap, caps)
		p.stateMu.Lock()
		if ch, ok := p.statePending[snap.GetRequestId()]; ok {
			delete(p.statePending, snap.GetRequestId())
			ch <- struct{}{}
		}
		p.stateMu.Unlock()
		return nil
	case msg.GetHistoryResponse() != nil:
		s.deliverHistory(l, p, msg.GetHistoryResponse())
		return nil
	case msg.GetModelsResponse() != nil:
		s.deliverModels(l, p, msg.GetModelsResponse())
		return nil
	case msg.GetSetModelAck() != nil:
		s.deliverSetModel(l, p, msg.GetSetModelAck())
		return nil
	case msg.GetThinkingLevelsResponse() != nil:
		s.deliverThinkingLevels(l, p, msg.GetThinkingLevelsResponse())
		return nil
	case msg.GetSetThinkingAck() != nil:
		s.deliverSetThinking(l, p, msg.GetSetThinkingAck())
		return nil
	case msg.GetCompactResult() != nil:
		s.deliverCompact(l, p, msg.GetCompactResult())
		return nil
	case msg.GetReloadAck() != nil:
		s.deliverReload(l, p, msg.GetReloadAck())
		return nil
	case msg.GetSkillsResponse() != nil:
		s.deliverSkills(l, p, msg.GetSkillsResponse())
		return nil
	case msg.GetInvokeSkillAck() != nil:
		s.deliverInvokeSkill(l, p, msg.GetInvokeSkillAck())
		return nil
	case msg.GetSyncboardRequest() != nil:
		s.receiveSyncboard(l, p, msg.GetSyncboardRequest())
		return nil
	case msg.GetAttachmentPromptAck() != nil:
		s.deliverAttachmentPrompt(l, p, msg.GetAttachmentPromptAck())
		return nil
	default:
		return status.Error(codes.InvalidArgument, "unsupported payload")
	}
}

func validateSnapshot(snap *pibridgepb.StateSnapshot, sessionID string) error {
	switch snap.GetState() {
	case pibridgepb.LogicalState_LOGICAL_STATE_UNSPECIFIED,
		pibridgepb.LogicalState_LOGICAL_STATE_IDLE,
		pibridgepb.LogicalState_LOGICAL_STATE_RUNNING:
	default:
		return fmt.Errorf("unknown logical state")
	}
	if snap.GetSessionId() != "" && sessionID != "" && snap.GetSessionId() != sessionID {
		return fmt.Errorf("snapshot session mismatch")
	}
	for _, r := range snap.GetJournal() {
		if r.GetEventSequence() == 0 || r.GetRunId() == 0 {
			return fmt.Errorf("journal ids required")
		}
	}
	if len(snap.GetJournal()) > maxJournalRecords {
		return fmt.Errorf("journal too large")
	}
	if len(snap.GetRequestId()) > 64 {
		return fmt.Errorf("snapshot request id too large")
	}
	if len(snap.GetThinkingLevel()) > maxThinkingLevel {
		return fmt.Errorf("thinking level too large")
	}
	// Unknown level names pass through and degrade to unknown downstream:
	// a future Pi release may add a level, and that must not tear down
	// the whole bridge.
	if err := validateContextUsage(snap.GetContextUsage()); err != nil {
		return err
	}
	if readiness := snap.GetAttachmentReadiness(); readiness != nil && readiness.GetImageAvailable() {
		model := snap.GetModel()
		if model == nil || model.GetProvider() == "" || model.GetModel() == "" {
			return fmt.Errorf("attachment image availability without model")
		}
	}
	return nil
}

func trySendProtocolError(stream pibridgepb.Integration_ConnectServer, pane, proc string, gen uint64, code pibridgepb.ProtocolErrorCode, msg string) error {
	return stream.Send(&pibridgepb.PhiToPi{
		PaneId:            pane,
		ProcessId:         proc,
		RuntimeGeneration: gen,
		Payload: &pibridgepb.PhiToPi_ProtocolError{
			ProtocolError: &pibridgepb.ProtocolError{Code: code, SafeMessage: msg},
		},
	})
}

// recvWithTimeout reads one message with a deadline from admission.
func recvWithTimeout(stream pibridgepb.Integration_ConnectServer, timeout time.Duration) (*pibridgepb.PiToPhi, error) {
	type res struct {
		msg *pibridgepb.PiToPhi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.msg, r.err
	case <-timer.C:
		return nil, status.Error(codes.DeadlineExceeded, "hello deadline")
	case <-stream.Context().Done():
		return nil, status.Error(codes.Canceled, "stream done")
	}
}

// recv reads one message unless the peer closes first.
func (p *peer) recv() (*pibridgepb.PiToPhi, error) {
	type res struct {
		msg *pibridgepb.PiToPhi
		err error
	}
	ch := make(chan res, 1)
	go func() {
		m, e := p.stream.Recv()
		ch <- res{msg: m, err: e}
	}()
	select {
	case <-p.done:
		if err := p.closeErr(); err != nil {
			return nil, err
		}
		return nil, status.Error(codes.Canceled, "peer closed")
	case r := <-ch:
		return r.msg, r.err
	case <-p.stream.Context().Done():
		return nil, status.Error(codes.Canceled, "stream done")
	}
}
