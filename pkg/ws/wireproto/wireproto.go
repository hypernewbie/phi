// Package wireproto defines the on-the-wire types for the hot-v1
// terminal protocol shared between the server and the phic client.
//
// The package exists so the client can speak the protocol without
// importing the server's pty/manager; a future phic-release change
// can therefore rebuild the client binary in isolation. The shapes
// here are a strict subset of what the server emits, kept stable
// across the server wire.
package wireproto

import (
	"encoding/binary"
	"encoding/json"
)

// Frame types carried as the leading byte of a WebSocket binary
// message. Anything not in this set is reserved and must be
// rejected by clients that opt into hot-v1.
const (
	// FrameInput is client → server: raw PTY bytes that came from
	// the user's keyboard. The payload is the unprocessed bytes.
	FrameInput byte = 0x01

	// FrameResize is client → server: a window-size change. The
	// payload is two big-endian uint16: cols, rows.
	FrameResize byte = 0x02

	// FramePing is client → server: a keepalive. The server
	// answers with FramePong.
	FramePing byte = 0x03

	// FramePong is server → client: a keepalive reply.
	FramePong byte = 0x03

	// FrameExit is server → client: the backend process has ended.
	// The payload is one raw exit-status byte.
	FrameExit byte = 0x04

	// FrameAttachHead is server → client at attach: a u32 BE
	// length-prefixed JSON header followed by optional opaque
	// checkpoint bytes. The JSON is Head; the bytes are the
	// snapshot the client can use to bootstrap its screen.
	FrameAttachHead byte = 0x08

	// FrameLiveOutput is server → client during the live phase:
	// a u64 BE start sequence followed by raw output bytes. The
	// range is [start, start+len) on the pane's output stream.
	FrameLiveOutput byte = 0x09
)

// EncodeResizeFrame produces a 0x02 frame with the standard 4-byte
// big-endian payload.
func EncodeResizeFrame(cols, rows uint16) []byte {
	out := make([]byte, 5)
	out[0] = FrameResize
	binary.BigEndian.PutUint16(out[1:3], cols)
	binary.BigEndian.PutUint16(out[3:5], rows)
	return out
}

// AttachHeadHeader is the JSON half of the 0x08 ATTACH_HEAD frame.
// The optional Ckpt field is non-nil when a usable client
// checkpoint exists; ReplayFrom is set when the pane is in
// certified-replay mode and the bytes below it are guaranteed to
// start on a line boundary.
type AttachHeadHeader struct {
	Epoch      uint64            `json:"epoch"`
	Oldest     uint64            `json:"oldest"`
	Head       uint64            `json:"head"`
	Ckpt       *CheckpointHeader `json:"ckpt,omitempty"`
	ReplayFrom uint64            `json:"replay_from,omitempty"`
}

// CheckpointHeader describes the bytes that follow the JSON in the
// ATTACH_HEAD frame. The actual bytes are not part of the JSON;
// they ride in the same frame.
type CheckpointHeader struct {
	Through uint64 `json:"through"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Len     int    `json:"len"`
}

// RecordingHeader is the JSON half of the /recording HTTP
// response body. The raw bytes follow the JSON in the same body.
// A client that fetches /recording uses this to validate the
// span before it writes the bytes to its terminal.
type RecordingHeader struct {
	Epoch   uint64      `json:"epoch"`
	Start   uint64      `json:"start"`
	End     uint64      `json:"end"`
	Resizes [][3]uint64 `json:"resizes"` // [atSeq, cols, rows]
}

// EncodeAttachHeadFrame is the server-side helper that produces a
// 0x08 ATTACH_HEAD frame from a header and an optional checkpoint
// payload. It is exported so the server can keep its framing
// aligned with the client's reader.
func EncodeAttachHeadFrame(h AttachHeadHeader, extra []byte) []byte {
	j, err := json.Marshal(h)
	if err != nil {
		return nil
	}
	frame := make([]byte, 1+4+len(j)+len(extra))
	frame[0] = FrameAttachHead
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(j)))
	copy(frame[5:], j)
	copy(frame[5+len(j):], extra)
	return frame
}

// EncodeLiveOutputFrame is the server-side helper for a single
// 0x09 LIVE_OUTPUT frame. The client uses start to advance its
// written frontier; the payload is the unprocessed bytes the
// terminal must see.
func EncodeLiveOutputFrame(start uint64, payload []byte) []byte {
	out := make([]byte, 9+len(payload))
	out[0] = FrameLiveOutput
	binary.BigEndian.PutUint64(out[1:9], start)
	copy(out[9:], payload)
	return out
}
