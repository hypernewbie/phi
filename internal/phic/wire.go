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
func ParseAttachHead(frame []byte) (*wspb.TerminalAttach, error) {
	server, err := wireproto.DecodeServerFrame(frame)
	if err != nil {
		return nil, err
	}
	h := server.GetAttach()
	if h == nil {
		return nil, fmt.Errorf("phic: not an attach frame")
	}
	if h.GetEpoch() == 0 || h.GetOldest() > h.GetHead() {
		return nil, fmt.Errorf("phic: invalid attach span")
	}
	if rf := h.GetReplayFrom(); rf != 0 && (rf < h.GetOldest() || rf > h.GetHead()) {
		return nil, fmt.Errorf("phic: invalid attach span")
	}
	if ckpt := h.GetCheckpoint(); ckpt != nil {
		// The protobuf field is uint32; keep the uint16 geometry the native
		// console can actually render and still reject zero.
		if ckpt.GetThrough() < h.GetOldest() || ckpt.GetThrough() > h.GetHead() ||
			ckpt.GetCols() == 0 || ckpt.GetCols() > math.MaxUint16 ||
			ckpt.GetRows() == 0 || ckpt.GetRows() > math.MaxUint16 ||
			len(ckpt.GetData()) > MaxNativePayloadBytes {
			return nil, fmt.Errorf("phic: invalid checkpoint")
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
	if out == nil {
		return 0, nil, fmt.Errorf("phic: not an output frame")
	}
	start, payload := out.GetStart(), out.GetData()
	if len(payload) > MaxNativePayloadBytes || start > ^uint64(0)-uint64(len(payload)) {
		return 0, nil, fmt.Errorf("phic: invalid live span")
	}
	return start, payload, nil
}
