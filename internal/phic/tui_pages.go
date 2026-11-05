package phic

import (
	"context"
	"errors"
	"io"
	"time"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// One bounded HTTP replay page. Fetches run on their own worker so the
// parser owner keeps handling input, resize, pings and paint while a page
// is in flight. Only the actor touches the emulator, frontier or frame.
type pageRequest struct {
	seq                  uint64
	epoch, from, through uint64
	after, fence         string
	latest               bool
	deadline             time.Time
	ctx                  context.Context
}

type pageResult struct {
	seq  uint64
	h    wireproto.ReplayHeader
	data []byte
	err  error
}

const (
	// paneRecoveryBudget bounds one history/refresh recovery episode,
	// including page reads. It survives replacement sockets.
	paneRecoveryBudget = 10 * time.Second

	// Held live output during replay. Past either bound the generation is
	// invalidated instead of growing the queue.
	paneHeldBytes = 2 << 20
	paneHeldSpans = 256
)

var (
	errPageDeadline = errors.New("phic: replay deadline reached")
	// errHeldOverflow reports that live frames outgrew the hold budget.
	// The replay itself still completed; only the held tail is unknown.
	errHeldOverflow = errors.New("phic: live hold overflow")
)

func (p *paneActor) pageWorker() {
	defer close(p.pageDone)
	for {
		select {
		case <-p.ctx.Done():
			return
		case req := <-p.pages:
			h, data, err := p.api.replay(req.ctx, p.spec.Key.ID, req.epoch, req.from, req.through, req.after, req.fence, req.latest)
			select {
			case p.pageResults <- pageResult{seq: req.seq, h: h, data: data, err: err}:
			case <-p.ctx.Done():
				return
			}
		}
	}
}

// fetchPage performs one page read without stopping the actor. Input,
// resize, ping and paint keep flowing; live frames are held in order for
// the caller to replay after the page lands.
func (p *paneActor) fetchPage(req pageRequest) (pageResult, error) {
	if req.deadline.IsZero() {
		req.deadline = p.recoveryDeadline()
	}
	ctx, cancel := context.WithDeadline(p.ctx, req.deadline)
	defer cancel()
	req.ctx = ctx
	// A bare actor (tests, single-shot recovery) has no worker: read on
	// the caller's goroutine, still bounded by the same deadline.
	if p.pages == nil || p.pageResults == nil {
		h, data, err := p.api.replay(ctx, p.spec.Key.ID, req.epoch, req.from, req.through, req.after, req.fence, req.latest)
		return pageResult{h: h, data: data, err: err}, err
	}
	// One result at a time, fenced by sequence: a result left behind by a
	// timed-out attempt is discarded instead of answering a newer request.
	p.pageSeq++
	req.seq = p.pageSeq
	timer := time.NewTimer(time.Until(req.deadline))
	defer timer.Stop()
	select {
	case p.pages <- req:
	case <-p.ctx.Done():
		return pageResult{}, p.ctx.Err()
	case <-timer.C:
		return pageResult{}, errPageDeadline
	}
	for {
		select {
		case res := <-p.pageResults:
			if res.seq != req.seq {
				continue
			}
			return res, res.err
		case <-p.ctx.Done():
			return pageResult{}, p.ctx.Err()
		case <-timer.C:
			return pageResult{}, errPageDeadline
		case r, ok := <-p.replayReads():
			if !ok {
				return pageResult{}, io.EOF
			}
			if r.err != nil {
				return pageResult{}, r.err
			}
			if err := p.holdFrame(r.bytes); err != nil {
				return pageResult{}, err
			}
		case in := <-p.inbox:
			if err := p.handleInput(in); err != nil {
				return pageResult{}, err
			}
		case in := <-p.resizes:
			if err := p.handleInput(in); err != nil {
				return pageResult{}, err
			}
		}
	}
}

// holdFrame keeps a frame that changes terminal state until the replay
// finishes. Frames with no terminal effect are dropped here; they carry
// no bytes a parser needs and no ordering requirement.
func (p *paneActor) holdFrame(msg []byte) error {
	if len(msg) == 0 {
		return errProtocol
	}
	frame, err := wireproto.DecodeServerFrame(msg)
	if err != nil {
		return errProtocol
	}
	switch payload := frame.GetPayload().(type) {
	case *wspb.TerminalServerFrame_Exit:
		code, err := terminalExitCode(payload.Exit)
		if err != nil {
			return err
		}
		p.noteExit(code)
		return nil
	case *wspb.TerminalServerFrame_Pong, *wspb.TerminalServerFrame_Title,
		*wspb.TerminalServerFrame_BridgeState, *wspb.TerminalServerFrame_Settlement:
		return nil
	}
	if p.heldBytes+len(msg) > paneHeldBytes || len(p.held) >= paneHeldSpans {
		p.heldOverflow = true
		return errHeldOverflow
	}
	p.held = append(p.held, append([]byte(nil), msg...))
	p.heldBytes += len(msg)
	return nil
}

// flushHeld replays held frames in arrival order. An overflow drops the
// whole tail and reports it, so the caller repairs it with one bounded
// fresh read instead of parsing an incomplete sequence.
func (p *paneActor) flushHeld() error {
	held := p.held
	p.held, p.heldBytes = nil, 0
	if p.heldOverflow {
		p.heldOverflow = false
		return errHeldOverflow
	}
	for _, msg := range held {
		if err := p.handleFrame(msg); err != nil {
			return err
		}
	}
	return nil
}

// beginRecovery opens one episode budget and counts its first attempt.
func (p *paneActor) beginRecovery() {
	now := time.Now()
	if p.recoveryUntil.IsZero() {
		p.recoveryUntil = now.Add(paneRecoveryBudget)
		p.recoveryAttempts = 0
		p.refreshBlocked = false
	}
	p.recoveryAttempts++
}

// endRecovery closes the episode after a usable stream.
func (p *paneActor) endRecovery() {
	p.recoveryUntil = time.Time{}
	p.recoveryAttempts = 0
	p.refreshBlocked = false
}

func (p *paneActor) recoveryDeadline() time.Time {
	if p.recoveryUntil.IsZero() {
		return time.Now().Add(paneRecoveryBudget)
	}
	return p.recoveryUntil
}

// A known Exit owns a finite archive drain even if the ghost socket closes.
func (p *paneActor) replayReads() <-chan paneRead {
	p.mu.Lock()
	exited := p.exited
	p.mu.Unlock()
	if exited {
		return nil
	}
	return p.reads
}

func (p *paneActor) recoveryExhausted() bool {
	return p.recoveryAttempts >= 2 || (!p.recoveryUntil.IsZero() && !time.Now().Before(p.recoveryUntil))
}
