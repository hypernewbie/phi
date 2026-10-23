package ws

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/hypernewbie/phi/internal/termstate"
)

// stateAnchorBudget and stateAnchorCount bound legacy parser checkpoint
// files during non-destructive legacy import. New groups use the bounded
// base-checkpoint set owned by the retention group instead.
const stateAnchorBudget = 32 << 20
const stateAnchorCount = 32
const historyCheckpointRows = 1024

// ErrStatePositionMismatch distinguishes a different lifetime/frontier from
// a retryable recording or parser reconstruction failure.
var ErrStatePositionMismatch = errors.New("archive position mismatch")

// errStateBaseUnavailable reports a missing or unusable retained base
// checkpoint on the live reconstruction path. Callers must not poison
// the pane with it: restoration resumes once a valid base exists.
var errStateBaseUnavailable = errors.New("retained base checkpoint unavailable")

type stateAnchor struct {
	through    uint64
	compressed []byte
	path       string
}

func restoreAnchor(data []byte) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, (64<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(out) > 64<<20 {
		return nil, fmt.Errorf("parser checkpoint exceeds decompressed bound")
	}
	return out, nil
}

func decodeStateAnchors(data []byte) ([]stateAnchor, int, error) {
	if len(data) < 8 || string(data[:4]) != "PHI1" {
		return nil, 0, fmt.Errorf("invalid parser checkpoint file")
	}
	count := int(binary.LittleEndian.Uint32(data[4:8]))
	if count > stateAnchorCount {
		return nil, 0, fmt.Errorf("too many parser checkpoints")
	}
	at, total := 8, 0
	anchors := make([]stateAnchor, 0, count)
	for range count {
		if at+12 > len(data) {
			return nil, 0, io.ErrUnexpectedEOF
		}
		through := binary.LittleEndian.Uint64(data[at : at+8])
		n := int(binary.LittleEndian.Uint32(data[at+8 : at+12]))
		at += 12
		if n < 0 || at+n > len(data) || total+n > stateAnchorBudget {
			return nil, 0, fmt.Errorf("invalid parser checkpoint length")
		}
		anchors = append(anchors, stateAnchor{through: through, compressed: append([]byte(nil), data[at:at+n]...)})
		total += n
		at += n
	}
	if at != len(data) {
		return nil, 0, fmt.Errorf("trailing parser checkpoint bytes")
	}
	return anchors, total, nil
}
func loadStateAnchors(path string) ([]stateAnchor, int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	if info.Size() < 8 || info.Size() > stateAnchorBudget+stateAnchorCount*12+8 {
		return nil, 0, fmt.Errorf("invalid parser checkpoint size")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	return decodeStateAnchors(data)
}

// retainedBase is a usable persistent parser base: the exact parser at
// `through` with zero historical scrollback. afterOrdinal is the ordered
// resize boundary the base consumed: replay applies only markers with
// higher ordinals, so same-position resizes apply exactly once.
type retainedBase struct {
	through      uint64
	compressed   []byte
	afterOrdinal uint64
}

// retainedBaseLocked returns the newest usable base at or below through.
// An unreadable newer base falls back to an older retained base, never
// to sequence zero once the prefix is gone.
func (ph *PaneHub) retainedBaseLocked(through uint64) (*retainedBase, error) {
	for _, idx := range ph.recording.baseCandidates(through) {
		gz, err := ph.recording.readBase(idx)
		if err != nil || len(gz) == 0 {
			continue
		}
		// Resize ordinals are 1-based, so the base consumed everything
		// below its segment's start ordinal. Decode rejects a zero
		// start ordinal, so this subtraction cannot underflow.
		return &retainedBase{through: ph.recording.segs[idx].start, compressed: gz, afterOrdinal: ph.recording.segs[idx].startOrdinal - 1}, nil
	}
	if ph.recording.start == 0 {
		// Nothing was ever evicted: a fresh parser at zero is exact.
		return nil, nil
	}
	return nil, fmt.Errorf("no retained base checkpoint at or below %d: %w", through, errStateBaseUnavailable)
}

func (ph *PaneHub) discardStateLocked() {
	if ph.state != nil {
		_ = ph.state.Close()
		ph.state = nil
	}
	ph.stateHead = 0
}

// prepareStateLocked parses retained bytes on the server, never on attach's
// wire. New panes start this parser on their first output; attach sends state.
func (ph *PaneHub) prepareStateLocked() error {
	if ph.stateErr != nil {
		return ph.stateErr
	}
	if ph.state != nil && ph.stateHead == ph.total {
		return nil
	}
	if ph.recording == nil || ph.recording.isClosed() {
		if ph.total > 0 {
			return fmt.Errorf("pane recording unavailable")
		}
		if ph.state == nil {
			state, err := termstate.New(context.Background(), 80, 24)
			if err != nil {
				ph.stateErr = err
				return err
			}
			ph.state = state
		}
		ph.stateHead = 0
		return nil
	}
	afterOrdinal := uint64(0)
	if ph.state == nil {
		state, err := termstate.New(context.Background(), 80, 24)
		if err != nil {
			ph.stateErr = err
			return err
		}
		restored := false
		for _, idx := range ph.recording.baseCandidates(ph.total) {
			gz, err := ph.recording.readBase(idx)
			if err != nil || len(gz) == 0 {
				continue
			}
			snapshot, err := restoreAnchor(gz)
			if err != nil {
				continue
			}
			if err := state.Restore(snapshot); err != nil {
				// A failed restore may leave the parser dirty;
				// recreate it before trying an older base.
				_ = state.Close()
				state, err = termstate.New(context.Background(), 80, 24)
				if err != nil {
					ph.stateErr = err
					return err
				}
				continue
			}
			ph.state = state
			ph.stateHead = ph.recording.segs[idx].start
			afterOrdinal = ph.recording.segs[idx].startOrdinal - 1
			restored = true
			break
		}
		if !restored {
			if ph.recording.start == 0 {
				// Nothing was ever evicted: the fresh parser is exact.
				ph.state = state
				ph.stateHead = 0
			} else {
				_ = state.Close()
				return fmt.Errorf("no usable retained base checkpoint: %w", errStateBaseUnavailable)
			}
		}
	}
	replayed := false
	for ph.stateHead < ph.total {
		end := min(ph.total, ph.stateHead+(256<<10))
		data, ords, endOrdinal, err := ph.recording.readOrd(ph.stateHead, end, afterOrdinal, true)
		if err != nil {
			ph.discardStateLocked()
			return err
		}
		afterOrdinal = endOrdinal
		at := ph.stateHead
		for _, o := range ords {
			resize := o.ResizeMarker
			offset := max(at, resize.AtSeq)
			if offset > at {
				if err = ph.state.Feed(data[at-ph.stateHead : offset-ph.stateHead]); err != nil {
					ph.discardStateLocked()
					return err
				}
				at = offset
			}
			if err = ph.state.Resize(int(resize.Cols), int(resize.Rows)); err != nil {
				ph.discardStateLocked()
				return err
			}
		}
		if err = ph.state.Feed(data[at-ph.stateHead:]); err != nil {
			ph.discardStateLocked()
			return err
		}
		ph.stateHead = end
		replayed = true
	}
	if !replayed && ph.state != nil {
		// A base at the head with no following bytes still has a
		// marker-only span: apply resizes the base predates (for
		// example, the resize that forced a metadata rotation, or a
		// resize on a pane with no output yet).
		_, ords, _, err := ph.recording.readOrd(ph.total, ph.total, afterOrdinal, true)
		if err != nil {
			ph.discardStateLocked()
			return err
		}
		for _, o := range ords {
			if err := ph.state.Resize(int(o.Cols), int(o.Rows)); err != nil {
				ph.discardStateLocked()
				return err
			}
		}
	}
	return nil
}

// HistoricalState rebuilds only from the nearest persisted parser checkpoint.
// The append-only recording remains the source of every requested byte.
func (h *Hub) HistoricalState(paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.HistoricalStateContext(context.Background(), paneID, epoch, through)
}

// Historical reconstruction has its own parser. Hold the pane lock only for
// bounded journal reads, never for VT replay or snapshot formatting, so a
// history request cannot stall live ingestion. Request cancellation also
// cancels its WASM work; disposing the parser stays on this owner.
func (h *Hub) HistoricalStateContext(ctx context.Context, paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.historicalStateContext(ctx, paneID, epoch, through, false)
}

// HistoricalANSIStateContext exports the same exact parser position for xterm.
// It includes both screens and continuation, never the recording library.
func (h *Hub) HistoricalANSIStateContext(ctx context.Context, paneID string, epoch, through uint64) (PanePosition, []byte, int, int, error) {
	return h.historicalStateContext(ctx, paneID, epoch, through, true)
}

// ErrStateNotFound ends state lookups for groups that do not exist or
// cannot be opened. Callers map it to 404, never a transient retry.
var ErrStateNotFound = errors.New("pane recording unavailable")

func (h *Hub) historicalStateContext(ctx context.Context, paneID string, epoch, through uint64, ansi bool) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, ErrStateNotFound
	}
	if err := ctx.Err(); err != nil {
		return PanePosition{}, nil, 0, 0, err
	}
	// Capture one consistent view (base plus bounded span) under the pane
	// lock, then replay outside it so history cannot stall live ingestion.
	// A corrupt newer base re-captures with an older retained base, never
	// with sequence zero once the prefix is gone.
	var pos PanePosition
	var base *retainedBase
	var from uint64
	var data []byte
	var resizes []ResizeMarker
	var endOrdinal uint64
	notAfter := through
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return PanePosition{}, nil, 0, 0, err
		}
		ph.mu.Lock()
		if ph.recording == nil || ph.recording.isClosed() {
			ph.mu.Unlock()
			return PanePosition{}, nil, 0, 0, ErrStateNotFound
		}
		if attempt > len(ph.recording.segs)+1 {
			ph.mu.Unlock()
			return pos, nil, 0, 0, fmt.Errorf("historical state unavailable: %w", ErrStatePositionMismatch)
		}
		pos = ph.positionLocked()
		if epoch != pos.Epoch || through > pos.Head || through < pos.Oldest {
			ph.mu.Unlock()
			return pos, nil, 0, 0, ErrStatePositionMismatch
		}
		var err error
		base, err = ph.retainedBaseLocked(min(through, notAfter))
		if err != nil {
			ph.mu.Unlock()
			return pos, nil, 0, 0, fmt.Errorf("historical state unavailable: %w", ErrStatePositionMismatch)
		}
		from = 0
		if base != nil {
			from = base.through
		}
		var ords []ordResize
		ords, endOrdinal = nil, 0
		baseAfter := uint64(0)
		if base != nil {
			baseAfter = base.afterOrdinal
		}
		data, ords, endOrdinal, err = ph.recording.readOrd(from, through, baseAfter, true)
		if err == nil {
			resizes = make([]ResizeMarker, len(ords))
			for i, o := range ords {
				resizes[i] = o.ResizeMarker
			}
		}
		ph.mu.Unlock()
		if err != nil {
			return pos, nil, 0, 0, err
		}
		if base == nil {
			break
		}
		snapshot, err := restoreAnchor(base.compressed)
		if err == nil {
			probe, err := termstate.New(ctx, 80, 24)
			if err != nil {
				return pos, nil, 0, 0, err
			}
			if err := probe.Restore(snapshot); err == nil {
				_ = probe.Close()
				break
			}
			_ = probe.Close()
		}
		if base.through == 0 {
			return pos, nil, 0, 0, fmt.Errorf("historical state unavailable: %w", ErrStatePositionMismatch)
		}
		notAfter = base.through - 1
	}
	state, err := termstate.New(ctx, 80, 24)
	if err != nil {
		return pos, nil, 0, 0, err
	}
	defer func() {
		if state != nil {
			_ = state.Close()
		}
	}()
	if base != nil {
		snapshot, err := restoreAnchor(base.compressed)
		if err != nil {
			return pos, nil, 0, 0, fmt.Errorf("historical state unavailable: %w", ErrStatePositionMismatch)
		}
		if err := state.Restore(snapshot); err != nil {
			return pos, nil, 0, 0, fmt.Errorf("historical state unavailable: %w", ErrStatePositionMismatch)
		}
	}
	if err := ctx.Err(); err != nil {
		return pos, nil, 0, 0, err
	}
	at := from
	for _, r := range resizes {
		offset := max(at, r.AtSeq)
		if offset > at {
			if err = state.Feed(data[at-from : offset-from]); err != nil {
				return pos, nil, 0, 0, err
			}
			at = offset
		}
		cols, rows := state.Geometry()
		if cols != int(r.Cols) || rows != int(r.Rows) {
			if err = state.Resize(int(r.Cols), int(r.Rows)); err != nil {
				return pos, nil, 0, 0, err
			}
		}
	}
	if err = state.Feed(data[at-from:]); err != nil {
		return pos, nil, 0, 0, err
	}
	if err := ctx.Err(); err != nil {
		return pos, nil, 0, 0, err
	}
	var snapshot []byte
	if ansi {
		snapshot, err = state.FormatVTState()
	} else {
		snapshot, err = state.ReadyWindow(historyCheckpointRows)
	}
	cols, rows := state.Geometry()
	ph.mu.Lock()
	currentEpoch := ph.epoch
	ph.mu.Unlock()
	if currentEpoch != epoch {
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	pos.Head = through
	pos.EventCursor = EncodeEventCursor(pos.Epoch, through, endOrdinal)
	return pos, snapshot, cols, rows, err
}

// LiveANSIState returns an atomic current screen/continuation frontier for
// xterm returning from an archive. It does not replay the time spent browsing.
func (h *Hub) LiveANSIState(paneID string, epoch uint64) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, ErrStateNotFound
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	if pos.Epoch != epoch {
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	if err := ph.prepareStateLocked(); err != nil {
		return pos, nil, 0, 0, err
	}
	// The live ANSI checkpoint carries the pending input suffix exactly
	// like attach: a relay recovering mid-sequence replays the live
	// suffix against the right parser state. The state handler budgets
	// the combined length.
	screen, err := ph.state.FormatVTState()
	if err != nil {
		return pos, nil, 0, 0, err
	}
	continuation, err := ph.state.Continuation()
	if err != nil {
		return pos, nil, 0, 0, err
	}
	data := append(screen, continuation...)
	cols, rows := ph.state.Geometry()
	if ph.recording != nil && !ph.recording.isClosed() {
		if _, _, endOrdinal, rerr := ph.recording.readOrd(pos.Head, pos.Head, 0, false); rerr == nil {
			pos.EventCursor = EncodeEventCursor(pos.Epoch, pos.Head, endOrdinal)
		}
	}
	return pos, data, cols, rows, err
}

// LiveGhosttyState returns the current parser snapshot for a native client
// that lost its recorded prefix. It is the live Ready form, not replay.
func (h *Hub) LiveGhosttyState(paneID string, epoch uint64) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, ErrStateNotFound
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	pos := ph.positionLocked()
	if pos.Epoch != epoch {
		return pos, nil, 0, 0, ErrStatePositionMismatch
	}
	if err := ph.prepareStateLocked(); err != nil {
		return pos, nil, 0, 0, err
	}
	snapshot, err := ph.state.Ready()
	cols, rows := ph.state.Geometry()
	if err == nil && ph.recording != nil && !ph.recording.isClosed() {
		if _, _, endOrdinal, rerr := ph.recording.readOrd(pos.Head, pos.Head, 0, false); rerr == nil {
			pos.EventCursor = EncodeEventCursor(pos.Epoch, pos.Head, endOrdinal)
		}
	}
	return pos, snapshot, cols, rows, err
}

// State returns a bounded live snapshot, not recording bytes.
func (h *Hub) State(paneID string) (PanePosition, []byte, int, int, error) {
	ph := h.recordingForRead(paneID)
	if ph == nil {
		return PanePosition{}, nil, 0, 0, ErrStateNotFound
	}
	ph.mu.Lock()
	defer ph.mu.Unlock()
	if err := ph.prepareStateLocked(); err != nil {
		return PanePosition{}, nil, 0, 0, err
	}
	snapshot, err := ph.state.Ready()
	cols, rows := ph.state.Geometry()
	pos := ph.positionLocked()
	if err == nil && ph.recording != nil && !ph.recording.isClosed() {
		if _, _, endOrdinal, rerr := ph.recording.readOrd(pos.Head, pos.Head, 0, false); rerr == nil {
			pos.EventCursor = EncodeEventCursor(pos.Epoch, pos.Head, endOrdinal)
		}
	}
	return pos, snapshot, cols, rows, err
}
