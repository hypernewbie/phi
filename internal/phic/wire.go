// Package phic is the minimal native terminal client for Phi.
package phic

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// ErrShortFrame is returned when a frame is truncated mid-header.
var ErrShortFrame = errors.New("phic: short frame")

// ParseAttachHead decodes a 0x08 ATTACH_HEAD frame.
func ParseAttachHead(frame []byte) (wireproto.AttachHeadHeader, []byte, error) {
	if len(frame) < 1 || frame[0] != wireproto.FrameAttachHead {
		return wireproto.AttachHeadHeader{}, nil, fmt.Errorf("phic: bad attach type 0x%x", frame[0])
	}
	if len(frame) < 5 {
		return wireproto.AttachHeadHeader{}, nil, ErrShortFrame
	}
	n := binary.BigEndian.Uint32(frame[1:5])
	if int(n)+5 > len(frame) {
		return wireproto.AttachHeadHeader{}, nil, ErrShortFrame
	}
	var h wireproto.AttachHeadHeader
	if err := json.Unmarshal(frame[5:5+n], &h); err != nil {
		return wireproto.AttachHeadHeader{}, nil, fmt.Errorf("phic: bad attach head: %w", err)
	}
	return h, append([]byte(nil), frame[5+n:]...), nil
}

// ParseLiveOutput decodes a 0x09 LIVE_OUTPUT frame.
func ParseLiveOutput(frame []byte) (start uint64, payload []byte, err error) {
	if len(frame) < 1 || frame[0] != wireproto.FrameLiveOutput {
		return 0, nil, fmt.Errorf("phic: bad live type 0x%x", frame[0])
	}
	if len(frame) < 9 {
		return 0, nil, ErrShortFrame
	}
	return binary.BigEndian.Uint64(frame[1:9]), frame[9:], nil
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

// DrainStream reads frames from a WebSocket binary stream.
type DrainStream struct {
	r io.Reader
}

func NewDrainStream(r io.Reader) *DrainStream { return &DrainStream{r: r} }

// ReadFrame reads the next WebSocket binary message.
func (d *DrainStream) ReadFrame() ([]byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(d.r, hdr[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(hdr[:]))
	if n > 1<<20 {
		return nil, fmt.Errorf("phic: frame too large: %d", n)
	}
	if n == 0 {
		return nil, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(d.r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
