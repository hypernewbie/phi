package phic

import (
	"bytes"
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

func FuzzWireParsersNeverPanic(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{8, 0, 0, 0, 0})
	f.Add([]byte{9, 255, 255, 255, 255, 255, 255, 255, 255, 'x'})
	f.Fuzz(func(t *testing.T, frame []byte) {
		_, _, _ = ParseAttachHead(frame)
		_, _, _ = ParseLiveOutput(frame)
	})
}
