// Package phic is the minimal native terminal client for Phi.
package phic

import (
	"fmt"
	"math"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// MaxNativePayloadBytes caps one decoded attach checkpoint or live-output
// span, matching the server's 2 MiB checkpoint bound.
const MaxNativePayloadBytes = 2 << 20

// ParseAttachHead decodes an attach server frame and validates its span.
// Unknown fields are accepted; a missing/wrong payload or an
// out-of-window span or checkpoint is rejected.
//
// A bounded window is valid. Oldest is then the certified floor, the
// floor pair certifies the resize ordinal in effect there, and head_cols
// / head_rows name the grid the head screen was drawn at.
func ParseAttachHead(frame []byte) (*wspb.TerminalAttach, error) {
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		return nil, err
	}
	h := server.GetAttach()
	if h == nil {
		return nil, fmt.Errorf("phic: not an attach frame")
	}
	position, err := parseReplayPosition(h.GetEventCursor())
	if err != nil || h.Epoch == nil || h.Head == nil || h.Oldest == nil ||
		h.GetOldest() > h.GetHead() || h.GetReplayFrom() != 0 || h.GetCheckpoint() != nil ||
		h.GetFloorCols() > math.MaxUint16 || h.GetFloorRows() > math.MaxUint16 ||
		h.GetHeadCols() > math.MaxUint16 || h.GetHeadRows() > math.MaxUint16 ||
		h.GetInitialCols() == 0 || h.GetInitialCols() > math.MaxUint16 ||
		h.GetInitialRows() == 0 || h.GetInitialRows() > math.MaxUint16 ||
		position.epoch != h.GetEpoch() || position.seq != h.GetHead() {
		return nil, fmt.Errorf("%w: attach requires certified raw history", errProtocol)
	}
	if h.GetOldest() > 0 || h.FloorEventCursor != nil {
		floor, err := parseReplayPosition(h.GetFloorEventCursor())
		if err != nil || floor.epoch != h.GetEpoch() || floor.seq != h.GetOldest() ||
			floor.ordinal > position.ordinal ||
			h.GetFloorCols() == 0 || h.GetFloorCols() > math.MaxUint16 ||
			h.GetFloorRows() == 0 || h.GetFloorRows() > math.MaxUint16 ||
			h.GetHeadCols() == 0 || h.GetHeadCols() > math.MaxUint16 ||
			h.GetHeadRows() == 0 || h.GetHeadRows() > math.MaxUint16 {
			return nil, fmt.Errorf("%w: attach floor does not certify its window", errProtocol)
		}
	}
	return h, nil
}

// ParseLiveOutput decodes an output server frame and validates its span.
func ParseLiveOutput(frame []byte) (start uint64, payload []byte, err error) {
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		return 0, nil, err
	}
	return outputSpan(server.GetOutput())
}

// outputSpan validates one decoded output payload. Live loops decode once
// for dispatch and share these checks instead of parsing twice.
func outputSpan(out *wspb.TerminalOutput) (uint64, []byte, error) {
	if out == nil || out.Start == nil {
		return 0, nil, fmt.Errorf("%w: output start is missing", errProtocol)
	}
	start, payload := out.GetStart(), out.GetData()
	if len(payload) > MaxNativePayloadBytes {
		return 0, nil, fmt.Errorf("%w: native output exceeds bound", wireproto.ErrMessageTooLarge)
	}
	if start > ^uint64(0)-uint64(len(payload)) {
		return 0, nil, fmt.Errorf("%w: invalid live span", errProtocol)
	}
	return start, payload, nil
}

func terminalExitCode(exit *wspb.TerminalExit) (int, error) {
	if exit == nil || exit.Code == nil {
		return 0, fmt.Errorf("%w: exit code is missing", errProtocol)
	}
	return int(exit.GetCode()), nil
}
