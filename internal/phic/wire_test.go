package phic

import (
	"bytes"
	"testing"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// TestParseAttachHead pins protobuf attach decoding: epoch, span, and
// checkpoint bytes must survive the round trip.
func TestParseAttachHead(t *testing.T) {
	raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch:  proto.Uint64(7),
		Oldest: proto.Uint64(1),
		Head:   proto.Uint64(5),
		Checkpoint: &wspb.TerminalCheckpoint{
			Through: proto.Uint64(3),
			Cols:    proto.Uint32(80),
			Rows:    proto.Uint32(24),
			Data:    []byte("snap"),
		},
	})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := ParseAttachHead(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.GetEpoch() != 7 || got.GetHead() != 5 || got.GetCheckpoint() == nil {
		t.Fatalf("header: %+v", got)
	}
	if !bytes.Equal(got.GetCheckpoint().GetData(), []byte("snap")) {
		t.Fatalf("checkpoint = %q", got.GetCheckpoint().GetData())
	}
}

// TestParseAttachHeadTruncated ensures a truncated frame errors rather
// than decoding a partial span: a partial frame is the default case on a
// stream, not an exception.
func TestParseAttachHeadTruncated(t *testing.T) {
	raw := testAttach(t, 7, 5)
	if _, err := ParseAttachHead(raw[:len(raw)-1]); err == nil {
		t.Fatal("expected error on truncated frame")
	}
}

// TestParseLiveOutput asserts the output start sequence and payload
// survive the round trip verbatim.
func TestParseLiveOutput(t *testing.T) {
	raw := testOutput(t, 100, []byte("xy"))
	start, payload, err := ParseLiveOutput(raw)
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

func FuzzWireParsersNeverPanic(f *testing.F) {
	attach, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{Epoch: proto.Uint64(7), Head: proto.Uint64(5)})
	if err != nil {
		f.Fatal(err)
	}
	out, err := wireproto.EncodeOutputFrame(100, []byte("xy"))
	if err != nil {
		f.Fatal(err)
	}
	f.Add([]byte{})
	f.Add(attach)
	f.Add(out)
	f.Add([]byte{0xff, 0xfe, 0x00})
	f.Fuzz(func(t *testing.T, frame []byte) {
		_, _ = ParseAttachHead(frame)
		_, _, _ = ParseLiveOutput(frame)
	})
}

// TestParseAttachHeadCheckpointGeometry pins the checkpoint geometry range:
// the protobuf field is uint32, but the native console still renders uint16
// dimensions and must reject anything a uint16 could not express.
func TestParseAttachHeadCheckpointGeometry(t *testing.T) {
	build := func(cols, rows uint32) []byte {
		t.Helper()
		raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
			Epoch:  proto.Uint64(7),
			Oldest: proto.Uint64(1),
			Head:   proto.Uint64(5),
			Checkpoint: &wspb.TerminalCheckpoint{
				Through: proto.Uint64(3),
				Cols:    proto.Uint32(cols),
				Rows:    proto.Uint32(rows),
				Data:    []byte("snap"),
			},
		})
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		return raw
	}
	accepted := []struct{ cols, rows uint32 }{
		{1, 1},
		{65535, 65535},
		{80, 24},
	}
	for _, dims := range accepted {
		if _, err := ParseAttachHead(build(dims.cols, dims.rows)); err != nil {
			t.Fatalf("%dx%d rejected: %v", dims.cols, dims.rows, err)
		}
	}
	rejected := []struct{ cols, rows uint32 }{
		{0, 24},
		{80, 0},
		{65536, 24},
		{80, 65536},
	}
	for _, dims := range rejected {
		if _, err := ParseAttachHead(build(dims.cols, dims.rows)); err == nil {
			t.Fatalf("%dx%d accepted", dims.cols, dims.rows)
		}
	}
}
