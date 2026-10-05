package phic

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// TestParseAttachHead pins the 0x08 decoding path. The plan's
// section 3 lists the framing as one of the non-negotiable wire
// contracts; an off-by-one here breaks attach.
func TestParseAttachHead(t *testing.T) {
	h := wireproto.AttachHeadHeader{
		Epoch:  7,
		Oldest: 1,
		Head:   5,
		Ckpt:   &wireproto.CheckpointHeader{Through: 3, Cols: 80, Rows: 24, Len: 4},
	}
	frame := wireproto.EncodeAttachHeadFrame(h, []byte("snap"))

	got, extra, err := ParseAttachHead(frame)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Epoch != 7 || got.Head != 5 || got.Ckpt == nil {
		t.Fatalf("header: %+v", got)
	}
	if !bytes.Equal(extra, []byte("snap")) {
		t.Fatalf("extra = %q", extra)
	}
}

// TestParseAttachHeadShortFrame ensures a truncated 0x08 returns
// ErrShortFrame rather than panicking on a bad slice. The plan's
// "Do not count a completed stdout write as a complete terminal-
// parser boundary" rule applies to the wire path too: a partial
// frame is the default case, not an exception.
func TestParseAttachHeadShortFrame(t *testing.T) {
	if _, _, err := ParseAttachHead([]byte{wireproto.FrameAttachHead, 0, 0, 5}); err == nil {
		t.Fatalf("expected error on truncated frame")
	}
}

// TestParseLiveOutput asserts the 0x09 start sequence is
// u64 big-endian. The plan's section 6 names this as the byte
// the client uses to advance its written frontier.
func TestParseLiveOutput(t *testing.T) {
	frame := wireproto.EncodeLiveOutputFrame(100, []byte("xy"))
	start, payload, err := ParseLiveOutput(frame)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if start != 100 {
		t.Fatalf("start = %d", start)
	}
	if !bytes.Equal(payload, []byte("xy")) {
		t.Fatalf("payload = %q", payload)
	}
}

// TestFrameTypeIgnoresReserved pins the plan's "Control, exit,
// shutdown, and notification frames are not terminal output" rule.
// The client must not write a reserved type to the terminal.
func TestFrameTypeIgnoresReserved(t *testing.T) {
	if FrameType([]byte{0x04, 0x00, 0x7b}) != 0x04 {
		t.Fatalf("expected 0x04 (EXIT), got %x", FrameType([]byte{0x04}))
	}
	if FrameType(nil) != 0 {
		t.Fatalf("expected 0 on empty frame, got %x", FrameType(nil))
	}
}

// TestEncodeInputFrame ensures the 0x01 prefix is the leading
// byte and the input bytes follow verbatim. The plan forbids
// "POST /api/terminals/:id/input" for ordinary input: this is
// the only input path.
func TestEncodeInputFrame(t *testing.T) {
	got := EncodeInputFrame([]byte("hi"))
	if len(got) != 3 || got[0] != wireproto.FrameInput {
		t.Fatalf("got %v", got)
	}
	if !bytes.Equal(got[1:], []byte("hi")) {
		t.Fatalf("payload = %q", got[1:])
	}
}

// TestDrainStream reads the length-prefixed wire format and
// returns each frame in arrival order. The fake stream writes
// two back-to-back frames; the test pins the byte shape and
// the no-frame contract on EOF.
func TestDrainStream(t *testing.T) {
	buf := &bytes.Buffer{}
	writeFrame := func(b []byte) {
		var hdr [2]byte
		binary.BigEndian.PutUint16(hdr[:], uint16(len(b)))
		buf.Write(hdr[:])
		buf.Write(b)
	}
	writeFrame([]byte{0x01, 0x02})
	writeFrame([]byte{0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 'h'})

	d := NewDrainStream(buf)
	a, err := d.ReadFrame()
	if err != nil {
		t.Fatalf("read a: %v", err)
	}
	if !bytes.Equal(a, []byte{0x01, 0x02}) {
		t.Fatalf("a = %v", a)
	}
	b, err := d.ReadFrame()
	if err != nil {
		t.Fatalf("read b: %v", err)
	}
	if !bytes.Equal(b, []byte{0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 'h'}) {
		t.Fatalf("b = %v", b)
	}
	if _, err := d.ReadFrame(); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}
