// Package phic is the minimal native terminal client for Phi.
package phic

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// ErrShortFrame is returned when a frame is truncated mid-header.
var ErrShortFrame = errors.New("phic: short frame")

// ParseAttachHead decodes a 0x08 ATTACH_HEAD frame.
func ParseAttachHead(frame []byte) (wireproto.AttachHeadHeader, []byte, error) {
	if len(frame) == 0 {
		return wireproto.AttachHeadHeader{}, nil, ErrShortFrame
	}
	if frame[0] != wireproto.FrameAttachHead {
		return wireproto.AttachHeadHeader{}, nil, fmt.Errorf("phic: bad attach type 0x%x", frame[0])
	}
	if len(frame) < 5 {
		return wireproto.AttachHeadHeader{}, nil, ErrShortFrame
	}
	n := binary.BigEndian.Uint32(frame[1:5])
	if n > 2<<20 || uint64(n)+5 > uint64(len(frame)) {
		return wireproto.AttachHeadHeader{}, nil, ErrShortFrame
	}
	var h wireproto.AttachHeadHeader
	if err := json.Unmarshal(frame[5:5+n], &h); err != nil {
		return wireproto.AttachHeadHeader{}, nil, fmt.Errorf("phic: bad attach head: %w", err)
	}
	extra := frame[5+n:]
	if h.Epoch == 0 || h.Oldest > h.Head || (h.ReplayFrom != 0 && (h.ReplayFrom < h.Oldest || h.ReplayFrom > h.Head)) {
		return h, nil, fmt.Errorf("phic: invalid attach span")
	}
	if h.Ckpt != nil {
		if h.Ckpt.Through < h.Oldest || h.Ckpt.Through > h.Head || h.Ckpt.Cols == 0 || h.Ckpt.Rows == 0 || h.Ckpt.Len <= 0 || h.Ckpt.Len > 2<<20 || h.Ckpt.Len != len(extra) {
			return h, nil, fmt.Errorf("phic: invalid checkpoint")
		}
	} else if len(extra) != 0 {
		return h, nil, fmt.Errorf("phic: unannounced checkpoint bytes")
	}
	return h, extra, nil
}

// ParseLiveOutput decodes a 0x09 LIVE_OUTPUT frame.
func ParseLiveOutput(frame []byte) (start uint64, payload []byte, err error) {
	if len(frame) == 0 {
		return 0, nil, ErrShortFrame
	}
	if frame[0] != wireproto.FrameLiveOutput {
		return 0, nil, fmt.Errorf("phic: bad live type 0x%x", frame[0])
	}
	if len(frame) < 9 {
		return 0, nil, ErrShortFrame
	}
	start = binary.BigEndian.Uint64(frame[1:9])
	if len(frame)-9 > 2<<20 || start > ^uint64(0)-uint64(len(frame)-9) {
		return 0, nil, fmt.Errorf("phic: invalid live span")
	}
	return start, frame[9:], nil
}

// FrameType reports the leading byte of a WebSocket binary
// message. Reserved types are ignored by the client.
func FrameType(frame []byte) byte {
	if len(frame) == 0 {
		return 0
	}
	return frame[0]
}

// EncodeInputFrame prefixes the raw PTY input with the input
// frame type.
func EncodeInputFrame(p []byte) []byte {
	out := make([]byte, 1+len(p))
	out[0] = wireproto.FrameInput
	copy(out[1:], p)
	return out
}
