package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

const recordingPageBytes = 2 << 20

var errInvalidRecording = errors.New("invalid recording")

// replayPage reads one bounded page of retained output. The server never
// renders a screen for this client: it sends exactly the bytes the client
// asked for, and the client paints them into its own terminal.
//
// A page below the retained floor comes back as an expired window that
// certifies the floor it can still serve. The relay adopts that floor and
// resumes there: the lost prefix is gone, and the retained tail is the
// honest picture of the pane.
func (r *Relay) replayPage(ctx context.Context, pane string, from, through uint64, fence string, latest bool) (wireproto.ReplayHeader, []byte, error) {
	for {
		h, data, err := r.api.replay(ctx, pane, r.epoch, from, through, r.cursorString(), fence, latest)
		if err == nil || permanent(err) || errors.Is(err, errInvalidRecording) {
			return h, data, err
		}
		var expired *expiredWindowError
		if errors.As(err, &expired) {
			if !r.adoptFloor(expired.info) {
				return h, nil, err
			}
			from = r.written
			if !latest && r.written > through {
				// The retained floor moved past the requested end. The
				// span is gone, so the caller resumes from the floor
				// instead of asking for bytes that no longer exist.
				return h, nil, err
			}
			continue
		}
		var n net.Error
		var status *apiError
		if !errors.As(err, &n) && !errors.As(err, &status) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return h, nil, err
		}
		select {
		case <-ctx.Done():
			return h, nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// adoptFloor moves the written frontier to the oldest byte the server can
// still serve and certifies it with the window's floor cursor. The
// repaint filter restarts because the byte stream jumped.
func (r *Relay) adoptFloor(info replayWindow) bool {
	if info.Epoch != r.epoch || info.Oldest > info.Head {
		return false
	}
	floor, err := parseReplayPosition(info.FloorEventCursor)
	if err != nil || floor.epoch != r.epoch || floor.seq != info.Oldest {
		return false
	}
	r.written = info.Oldest
	r.ordinal = floor.ordinal
	r.repaint = &repaintFilter{}
	return true
}

// cursorString renders the event cursor that certifies the written
// frontier. The ordinal counts the geometry changes that took effect at or
// before that position.
func (r *Relay) cursorString() string {
	return (replayPosition{epoch: r.epoch, seq: r.written, ordinal: r.ordinal}).String()
}

// recover paints a gap the live stream announced. The gap ends past the
// attach head, so no cursor certifies it yet: the server captures its own
// head as the fence and caps the page.
func (r *Relay) recover(ctx context.Context, pane string, head uint64) error {
	for r.written < head {
		h, data, err := r.replayPage(ctx, pane, r.written, head, "", true)
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return fmt.Errorf("%w: empty page", errInvalidRecording)
		}
		if err := r.output(ctx, data, false); err != nil {
			return err
		}
		if pos, perr := parseReplayPosition(h.EventCursor); perr == nil {
			r.ordinal = pos.ordinal
		}
	}
	return nil
}

// recoverOutput paints retained bytes up to target. Every request is
// bounded: the client asks for one window, the server caps the response at
// its own page limit, and the client follows the returned end.
func (r *Relay) recoverOutput(ctx context.Context, pane string, target uint64, fence string, historical bool) error {
	for r.written < target {
		h, data, err := r.replayPage(ctx, pane, r.written, target, fence, false)
		if err != nil {
			var expired *expiredWindowError
			if errors.As(err, &expired) {
				// The floor passed the requested end. The lost span is
				// gone for good; the retained tail is the honest picture.
				return nil
			}
			return err
		}
		if len(data) == 0 {
			return fmt.Errorf("%w: empty page", errInvalidRecording)
		}
		if err := r.output(ctx, data, historical); err != nil {
			return err
		}
		if pos, perr := parseReplayPosition(h.EventCursor); perr == nil {
			r.ordinal = pos.ordinal
		}
	}
	return nil
}

// output advances a SOURCE frontier. Repaint-only controls may be omitted or
// held in the bounded lexer, but the source recording is never changed. A new
// live control is written verbatim. Failed writes stop attachment; they cannot
// authorize skipping a later source span.
func (r *Relay) output(ctx context.Context, data []byte, historical bool) error {
	if r.repaint == nil {
		return r.write(ctx, data)
	}
	paint, err := r.repaint.Feed(data, historical)
	if err != nil {
		return err
	}
	before := r.written
	err = r.write(ctx, paint)
	// Display bytes have no one-to-one source offset after query suppression.
	// Only a completed batch can certify its source interval.
	r.written = before
	if err == nil {
		r.written += uint64(len(data))
	}
	return err
}

// drainExit reads the remaining retained bytes after the backend exited.
// The live head is the fence here: the exit frame means no more output
// follows, so the server certifies the head it holds.
func (r *Relay) drainExit(ctx context.Context, pane string) error {
	for {
		if r.written > ^uint64(0)-recordingPageBytes {
			return errInvalidRecording
		}
		h, data, err := r.replayPage(ctx, pane, r.written, r.written+recordingPageBytes, "", true)
		if err != nil {
			return err
		}
		if err := r.output(ctx, data, false); err != nil {
			return err
		}
		if pos, perr := parseReplayPosition(h.EventCursor); perr == nil {
			r.ordinal = pos.ordinal
		}
		if len(data) < recordingPageBytes {
			return nil
		}
	}
}
