package phic

// enterLimited latches live-only recovery at a certified head. It never
// retries history until a later attach re-evaluates.
func (p *paneActor) enterLimited(status string) error {
	p.limited = true
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

func (p *paneActor) finalizeKnownExit() {
	p.reads = nil
	if err := p.drainExit(); err != nil {
		p.sendEvent(paneEvent{Key: p.spec.Key, Kind: paneStatus, Status: "final output unavailable: " + err.Error()})
	}
	p.finishExit()
}

// noteExit records the exit immediately: admission closes for new input
// and resize work while the finite archive drain still runs.
func (p *paneActor) noteExit(code int) {
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
