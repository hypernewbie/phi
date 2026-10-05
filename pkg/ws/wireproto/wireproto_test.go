package wireproto

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"reflect"
	"testing"
)

// TestEncodeResizeFrame pins the byte-level contract for the
// 0x02 frame: the 4-byte payload is cols BE, rows BE. This is the
// shape the plan calls out in section 3.
func TestEncodeResizeFrame(t *testing.T) {
	got := EncodeResizeFrame(120, 40)
	if got[0] != FrameResize {
		t.Fatalf("type = 0x%x, want 0x%x", got[0], FrameResize)
	}
	if c := binary.BigEndian.Uint16(got[1:3]); c != 120 {
		t.Fatalf("cols = %d, want 120", c)
	}
	if r := binary.BigEndian.Uint16(got[3:5]); r != 40 {
		t.Fatalf("rows = %d, want 40", r)
	}
}

// TestEncodeAttachHeadFrameRoundTrip verifies the JSON header
// travels in the first len(j) bytes after the u32 length prefix,
// and the checkpoint payload follows it verbatim. The framing is
// the inverse of the server's frameFramedJSON; both sides must
// agree or attach fails.
func TestEncodeAttachHeadFrameRoundTrip(t *testing.T) {
	ckpt := []byte("snap-bytes")
	h := AttachHeadHeader{
		Epoch:  7,
		Oldest: 1,
		Head:   5,
		Ckpt:   &CheckpointHeader{Through: 3, Cols: 80, Rows: 24, Len: len(ckpt)},
	}
	frame := EncodeAttachHeadFrame(h, ckpt)
	if frame[0] != FrameAttachHead {
		t.Fatalf("type = 0x%x, want 0x%x", frame[0], FrameAttachHead)
	}
	n := binary.BigEndian.Uint32(frame[1:5])
	var got AttachHeadHeader
	if err := json.Unmarshal(frame[5:5+n], &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got != h {
		if !reflect.DeepEqual(got, h) {
			t.Fatalf("header round-trip: got %+v want %+v", got, h)
		}
	}
	if !bytes.Equal(frame[5+n:], ckpt) {
		t.Fatalf("checkpoint payload: got %q want %q", frame[5+n:], ckpt)
	}
}

// TestEncodeLiveOutputFrame is the wire shape for 0x09: a u64 BE
// start followed by raw output bytes. The client's written
// frontier advances by len(payload) starting at start.
func TestEncodeLiveOutputFrame(t *testing.T) {
	got := EncodeLiveOutputFrame(42, []byte("hello"))
	if got[0] != FrameLiveOutput {
		t.Fatalf("type = 0x%x, want 0x%x", got[0], FrameLiveOutput)
	}
	if s := binary.BigEndian.Uint64(got[1:9]); s != 42 {
		t.Fatalf("start = %d, want 42", s)
	}
	if !bytes.Equal(got[9:], []byte("hello")) {
		t.Fatalf("payload = %q", got[9:])
	}
}
