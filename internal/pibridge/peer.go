package pibridge

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

// connectStream is the minimal bidirectional-stream surface peer needs.
// Both the generated gRPC server stream and test fakes satisfy it.
type connectStream interface {
	Send(*pibridgepb.PhiToPi) error
	Recv() (*pibridgepb.PiToPhi, error)
	Context() context.Context
}

// peer is one active Connect stream for a lease. It owns a bounded
// outbound queue (16 messages / 256 KiB) and one serialized writer. Queue
// overflow or a blocked send closes only this peer with an explicit gRPC
// status and preserves the lease's authoritative journal and last state.
type peer struct {
	generation uint64
	sessionID  string

	stream connectStream
	ctx    context.Context
	cancel context.CancelFunc

	sendCh chan *pibridgepb.PhiToPi
	done   chan struct{}

	mu          sync.Mutex
	outstanding int // queued + in-flight messages
	queuedBytes int // queued + in-flight bytes
	closed      bool
	closeCode   codes.Code
	closeMsg    string

	histMu      sync.Mutex
	histPending map[string]chan HistoryResult

	modelsMu           sync.Mutex
	modelsPending      map[string]chan ModelsResult
	setPending         map[string]chan SetModelResult
	thinkingPending    map[string]chan ThinkingLevelsResult
	setThinkingPending map[string]chan SetThinkingResult
	skillsMu           sync.Mutex
	skillsPending      map[string]chan SkillsResult
	invokeSkillPending map[string]chan InvokeSkillResult

	syncboardMu        sync.Mutex
	syncboardHighWater uint64
	syncboardPending   map[uint64]struct{}

	writerDone chan struct{}
}

func newPeer(generation uint64, sessionID string, stream connectStream) *peer {
	parent := context.Background()
	if stream != nil {
		parent = stream.Context()
	}
	ctx, cancel := context.WithCancel(parent)
	return &peer{
		generation: generation,
		sessionID:  sessionID,
		stream:     stream,
		ctx:        ctx,
		cancel:     cancel,
		sendCh:     make(chan *pibridgepb.PhiToPi, maxQueuedMessages),
		done:       make(chan struct{}),
		histPending: make(
			map[string]chan HistoryResult,
		),
		modelsPending: make(
			map[string]chan ModelsResult,
		),
		setPending: make(
			map[string]chan SetModelResult,
		),
		thinkingPending:    make(map[string]chan ThinkingLevelsResult),
		setThinkingPending: make(map[string]chan SetThinkingResult),
		skillsPending:      make(map[string]chan SkillsResult),
		invokeSkillPending: make(map[string]chan InvokeSkillResult),
		syncboardPending:   make(map[uint64]struct{}),
		writerDone:         make(chan struct{}),
	}
}

// send enqueues one outbound message. It returns false when the peer is
// closed or the bounded queue overflows; overflow closes the peer with
// RESOURCE_EXHAUSTED and preserves lease state for resynchronization.
// The bound covers queued plus in-flight messages, so a blocked writer
// cannot hide an extra message outside the queue.
func (p *peer) send(msg *pibridgepb.PhiToPi) bool {
	return p.enqueue(msg, true, false)
}

// sendNonfatal enqueues one outbound message without closing the peer
// on overflow. On-demand requests (history, models, set-model) use it:
// a recall attempt must never end the lifecycle stream. Callers fail
// only their own request.
func (p *peer) sendNonfatal(msg *pibridgepb.PhiToPi) bool {
	return p.enqueue(msg, false, false)
}

// sendSyncboardNonfatal leaves reserved queue room for lifecycle messages.
func (p *peer) sendSyncboardNonfatal(msg *pibridgepb.PhiToPi) bool {
	return p.enqueue(msg, false, true)
}

func (p *peer) enqueue(msg *pibridgepb.PhiToPi, fatalOverflow, reserveLifecycle bool) bool {
	size := proto.Size(msg)
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return false
	}
	maxMessages, maxBytes := maxQueuedMessages, maxQueuedBytes
	if reserveLifecycle {
		maxMessages -= syncboardLifecycleHeadroomMessages
		maxBytes -= syncboardLifecycleHeadroomBytes
	}
	if p.outstanding >= maxMessages || p.queuedBytes+size > maxBytes {
		p.mu.Unlock()
		if fatalOverflow {
			p.closeWith(codes.ResourceExhausted, "bounded send queue full")
		}
		return false
	}
	p.outstanding++
	p.queuedBytes += size
	p.mu.Unlock()
	select {
	case p.sendCh <- msg:
		return true
	case <-p.done:
		p.mu.Lock()
		p.outstanding--
		p.queuedBytes -= size
		if p.outstanding < 0 {
			p.outstanding = 0
		}
		if p.queuedBytes < 0 {
			p.queuedBytes = 0
		}
		p.mu.Unlock()
		return false
	}
}

// closeWith idempotently records the terminal status and releases the
// reader and writer. Callers return the recorded status from Connect.
func (p *peer) closeWith(code codes.Code, msg string) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.closeCode = code
	p.closeMsg = msg
	p.mu.Unlock()
	p.cancel()
	close(p.done)
}

// closeErr returns the recorded terminal status, or nil when open.
func (p *peer) closeErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		return nil
	}
	return status.Error(p.closeCode, p.closeMsg)
}

// runWriter serializes outbound sends. A send with no progress for
// blockedSendTimeout stops the affected stream with UNAVAILABLE.
func (p *peer) runWriter() {
	defer close(p.writerDone)
	for {
		select {
		case <-p.done:
			return
		case msg := <-p.sendCh:
			err := p.sendWithTimeout(msg)
			p.mu.Lock()
			p.outstanding--
			p.queuedBytes -= proto.Size(msg)
			if p.outstanding < 0 {
				p.outstanding = 0
			}
			if p.queuedBytes < 0 {
				p.queuedBytes = 0
			}
			p.mu.Unlock()
			if err != nil {
				return
			}
		case <-p.stream.Context().Done():
			p.closeWith(codes.Canceled, "stream context done")
			return
		}
	}
}

// sendWithTimeout performs one blocking Send and stops the peer when it
// makes no progress within blockedSendTimeout or fails.
func (p *peer) sendWithTimeout(msg *pibridgepb.PhiToPi) error {
	type result struct{ err error }
	resCh := make(chan result, 1)
	go func() { resCh <- result{err: p.stream.Send(msg)} }()
	timer := time.NewTimer(blockedSendTimeout)
	defer timer.Stop()
	select {
	case res := <-resCh:
		if res.err != nil {
			if s, ok := status.FromError(res.err); ok {
				p.closeWith(s.Code(), s.Message())
			} else {
				p.closeWith(codes.Unavailable, "send failed")
			}
			return res.err
		}
		return nil
	case <-timer.C:
		p.closeWith(codes.Unavailable, "blocked send timeout")
		return status.Error(codes.Unavailable, "blocked send timeout")
	case <-p.done:
		return status.Error(codes.Canceled, "peer closed")
	case <-p.stream.Context().Done():
		p.closeWith(codes.Canceled, "stream context done")
		return status.Error(codes.Canceled, "stream context done")
	}
}
