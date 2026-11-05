package phic

import (
	"strconv"
	"time"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// Pi repaint recovery for the native client. The host redraws its live
// screen into the pane's output stream, so a fresh parser can be filled
// from live bytes instead of downloading history. One request is in
// flight at most, a receipt decides, and silence spends the episode.
//
// Every path here keeps the pre-bridge behavior available: without the
// hint (or after a refusal) the actor falls back to one bounded replay
// from the certified floor, then to live-only limited mode.

// canFastPath reports whether this attach may ask the host to repaint.
// The hint is advisory and re-read per attach; dispatch rechecks it.
func (p *paneActor) canFastPath(h *wspb.TerminalAttach) bool {
	return h.GetTerminalRefreshAvailable() && !p.refreshBlocked && !p.limited && !p.recoveryExhausted()
}

// requestRefresh sends one repaint request. It never travels as PTY
// input and is never queued behind an earlier request.
func (p *paneActor) requestRefresh(cols, rows int) bool {
	if p.refreshID != "" {
		return false
	}
	if cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 {
		return false
	}
	p.refreshSeq++
	id := strconv.FormatUint(p.refreshSeq, 10)
	frame, err := wireproto.EncodeRefreshResizeFrame(uint32(cols), uint32(rows), id)
	if err != nil {
		p.refreshBlocked = true
		return false
	}
	if !p.enqueue(frame) {
		p.refreshBlocked = true
		return false
	}
	p.refreshID = id
	p.refreshDispatched = false
	p.refreshDeadline = minTime(time.Now().Add(3*time.Second), p.recoveryDeadline())
	return true
}

func (p *paneActor) clearRefresh() {
	p.refreshID = ""
	p.refreshDispatched = false
	p.refreshDeadline = time.Time{}
}

// handleRefreshResult consumes the receipt for the one outstanding
// request. Stale and duplicate receipts change nothing.
func (p *paneActor) handleRefreshResult(res *wspb.TerminalRefreshResult) error {
	if res == nil || p.refreshID == "" || res.GetRequestId() != p.refreshID || p.refreshDispatched || p.exited {
		return nil
	}
	outcome := res.GetOutcome()
	if outcome == wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED {
		p.refreshDispatched = true
		p.refreshDeadline = p.recoveryDeadline()
		p.completeRefresh()
		p.dirty = true
		return nil
	}
	p.clearRefresh()
	return p.fallbackAfterRefresh()
}

// fallbackAfterRefresh performs the single bounded history replay an
// episode is allowed. A spent budget or a failed replay latches live-only
// mode instead of retrying.
func (p *paneActor) fallbackAfterRefresh() error {
	p.refreshBlocked = true
	if p.recoveryExhausted() {
		return p.enterLimited("Pi could not repaint; showing live output only")
	}
	p.beginRecovery()
	if err := p.resetAtFloor(); err != nil {
		return p.enterLimited("history could not be recovered: " + err.Error())
	}
	deadline := p.recoveryDeadline()
	if p.attachHead > 0 {
		if err := p.recoverFrom(deadline, p.floorValue(), p.attachHead, p.attachCursor); err != nil {
			if p.exited {
				return err
			}
			return p.enterLimited("history could not be recovered: " + err.Error())
		}
	}
	if err := p.flushHeld(); err != nil {
		return p.enterLimited("live output gap: " + err.Error())
	}
	cols, rows := p.geometry()
	if !p.enqueueResize(cols, rows) {
		return errPaneResize
	}
	p.endRecovery()
	p.dirty = true
	return p.refreshFrame()
}

// enterLimited latches live-only recovery at a certified head. It never
// retries history or refresh until a later attach re-evaluates.
func (p *paneActor) enterLimited(status string) error {
	p.limited = true
	p.refreshBlocked = true
	p.clearRefresh()
	p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: status})
	// Only a fresh atomic attach can certify a head after discarded frames.
	return errHeldOverflow
}

// adoptWindow resumes at the floor a 409 certified, dropping the bytes
// below it instead of inventing them.
func (p *paneActor) windowAdvances(info replayWindow, from uint64) bool {
	floor, err := parseReplayPosition(info.FloorEventCursor)
	return err == nil && (info.Oldest > from || (info.Oldest == from && floor.ordinal > p.replayOrdinal))
}

func (p *paneActor) adoptWindow(info replayWindow) error {
	floor, err := parseReplayPosition(info.FloorEventCursor)
	if err != nil || floor.epoch != info.Epoch || floor.seq != info.Oldest {
		return errProtocol
	}
	head, err := parseReplayPosition(info.EventCursor)
	if err != nil || head.epoch != info.Epoch || head.seq != info.Head || head.ordinal < floor.ordinal {
		return errProtocol
	}
	if info.FloorCols == 0 || info.FloorRows == 0 || info.HeadCols == 0 || info.HeadRows == 0 ||
		info.FloorCols > 65535 || info.FloorRows > 65535 || info.HeadCols > 65535 || info.HeadRows > 65535 {
		return errProtocol
	}
	p.floorCols, p.floorRows, p.floorOrdinal = uint16(info.FloorCols), uint16(info.FloorRows), floor.ordinal
	p.headCols, p.headRows = uint16(info.HeadCols), uint16(info.HeadRows)
	p.attachHead, p.attachCursor = info.Head, info.EventCursor
	return p.resetAt(info.Epoch, info.Oldest, info.Head, p.floorCols, p.floorRows, info.Oldest, floor.ordinal)
}

func (p *paneActor) resetAtFloor() error {
	p.mu.Lock()
	floor, epoch := p.oldest, p.epoch
	p.mu.Unlock()
	return p.resetAt(epoch, floor, p.attachHead, p.floorCols, p.floorRows, floor, p.floorOrdinal)
}

func (p *paneActor) floorValue() uint64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.oldest
}

// refreshDue reports the next deadline while a receipt is pending.
func (p *paneActor) refreshDue() (time.Time, bool) {
	if p.refreshID == "" {
		return time.Time{}, false
	}
	return p.refreshDeadline, true
}

// refreshTimeout spends the request when no receipt arrived in time.
// The request is never resent.
func (p *paneActor) refreshTimeout() error {
	if p.refreshID == "" {
		return nil
	}
	p.clearRefresh()
	return p.fallbackAfterRefresh()
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func (p *paneActor) completeRefresh() {
	p.mu.Lock()
	frontier := p.frontier
	p.mu.Unlock()
	if p.refreshDispatched && frontier > p.attachHead {
		p.clearRefresh()
		p.endRecovery()
	}
}

func (p *paneActor) finalizeKnownExit() {
	p.reads = nil
	if err := p.drainExit(); err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "final output unavailable: " + err.Error()})
	}
	p.finishExit()
}

// noteExit records the exit immediately: admission closes for new input,
// resize and refresh work while the finite archive drain still runs.
func (p *paneActor) noteExit(code int) {
	p.clearRefresh()
	p.refreshBlocked = true
	p.mu.Lock()
	p.exited = true
	p.exitCode = code
	p.mu.Unlock()
}

// finishExit emits the one authoritative exit event after the drain.
func (p *paneActor) finishExit() {
	if p.exitNotified {
		return
	}
	p.exitNotified = true
	p.mu.Lock()
	code := p.exitCode
	p.mu.Unlock()
	_ = p.refreshFrame()
	p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneExited, Code: code})
}
