package phic

import (
	"bytes"
	"testing"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

func TestParseAttachRequiresCompleteV2Baseline(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*wspb.TerminalAttach)
		valid  bool
	}{
		{"v2", func(*wspb.TerminalAttach) {}, true},
		{"zero epoch", func(h *wspb.TerminalAttach) { h.Epoch = proto.Uint64(0); h.EventCursor = proto.String("v1.0.5.0") }, true},
		{"missing baseline", func(h *wspb.TerminalAttach) { h.InitialCols = nil }, false},
		{"oversized grid", func(h *wspb.TerminalAttach) { h.InitialRows = proto.Uint32(65536) }, false},
		{"missing fence", func(h *wspb.TerminalAttach) { h.EventCursor = nil }, false},
		{"wrong cursor epoch", func(h *wspb.TerminalAttach) { h.EventCursor = proto.String("v1.8.5.0") }, false},
		{"wrong cursor position", func(h *wspb.TerminalAttach) { h.EventCursor = proto.String("v1.7.4.0") }, false},
		{"truncated history", func(h *wspb.TerminalAttach) { h.Oldest = proto.Uint64(1) }, false},
		{"replay skip", func(h *wspb.TerminalAttach) { h.ReplayFrom = proto.Uint64(1) }, false},
		{"checkpoint", func(h *wspb.TerminalAttach) { h.Checkpoint = &wspb.TerminalCheckpoint{Data: []byte("snap")} }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &wspb.TerminalAttach{Epoch: proto.Uint64(7), Oldest: proto.Uint64(0), Head: proto.Uint64(5), InitialCols: proto.Uint32(80), InitialRows: proto.Uint32(24), EventCursor: proto.String("v1.7.5.0")}
			tc.mutate(h)
			raw, err := wireproto.EncodeAttachFrame(h)
			if err != nil {
				t.Fatal(err)
			}
			_, err = ParseAttachHead(raw)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}

func TestParseAttachHeadTruncated(t *testing.T) {
	raw := testAttach(t, 7, 5)
	if _, err := ParseAttachHead(raw[:len(raw)-1]); err == nil {
		t.Fatal("truncated frame accepted")
	}
}
func TestParseLiveOutput(t *testing.T) {
	start, payload, err := ParseLiveOutput(testOutput(t, 100, []byte("xy")))
	if err != nil || start != 100 || !bytes.Equal(payload, []byte("xy")) {
		t.Fatalf("changed output: start=%d data=%q err=%v", start, payload, err)
	}
}
func FuzzWireParsersNeverPanic(f *testing.F) {
	attach, _ := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{Epoch: proto.Uint64(7), Oldest: proto.Uint64(0), Head: proto.Uint64(0), InitialCols: proto.Uint32(80), InitialRows: proto.Uint32(24), EventCursor: proto.String("v1.7.0.0")})
	f.Add(attach)
	f.Add([]byte{})
	f.Add([]byte{0xff, 0xfe, 0x00})
	f.Fuzz(func(t *testing.T, frame []byte) { _, _ = ParseAttachHead(frame); _, _, _ = ParseLiveOutput(frame) })
}
