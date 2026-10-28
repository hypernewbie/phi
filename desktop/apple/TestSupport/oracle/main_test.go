package main

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func validHeader(spanLen int) wireproto.AttachHeadHeader {
	return wireproto.AttachHeadHeader{
		Epoch: 7, Oldest: 3, Head: 12,
		Ckpt: &wireproto.CheckpointHeader{
			Kind: "ansi-v1", Through: 12, Cols: 80, Rows: 24, Len: spanLen,
			EventCursor: "v1.7.12.1",
		},
	}
}

func envelope(t *testing.T, header wireproto.AttachHeadHeader, span []byte) []byte {
	t.Helper()
	encoded, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 4+len(encoded)+len(span))
	binary.BigEndian.PutUint32(body, uint32(len(encoded)))
	copy(body[4:], encoded)
	copy(body[4+len(encoded):], span)
	return body
}

func TestUnwrapAcceptsExactFrontier(t *testing.T) {
	span := []byte("hello")
	got, cols, rows, err := unwrap(envelope(t, validHeader(len(span)), span))
	if err != nil {
		t.Fatalf("unwrap: %v", err)
	}
	if string(got) != string(span) || cols != 80 || rows != 24 {
		t.Fatalf("unwrap = %q %dx%d, want %q 80x24", got, cols, rows, span)
	}
}

func TestUnwrapRejectsBrokenFrontiers(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*wireproto.AttachHeadHeader)
	}{
		{"through-not-head", func(h *wireproto.AttachHeadHeader) { h.Ckpt.Through = 11 }},
		{"oldest-past-head", func(h *wireproto.AttachHeadHeader) { h.Oldest = 13 }},
		{"cursor-missing", func(h *wireproto.AttachHeadHeader) { h.Ckpt.EventCursor = "" }},
		{"cursor-epoch", func(h *wireproto.AttachHeadHeader) { h.Ckpt.EventCursor = "v1.8.12.1" }},
		{"cursor-position", func(h *wireproto.AttachHeadHeader) { h.Ckpt.EventCursor = "v1.7.11.1" }},
		{"cursor-malformed", func(h *wireproto.AttachHeadHeader) { h.Ckpt.EventCursor = "v1.x.12.1" }},
		{"kind", func(h *wireproto.AttachHeadHeader) { h.Ckpt.Kind = "ghostty-ready-v1" }},
		{"length", func(h *wireproto.AttachHeadHeader) { h.Ckpt.Len = 4 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			header := validHeader(5)
			test.mutate(&header)
			if _, _, _, err := unwrap(envelope(t, header, []byte("hello"))); err == nil {
				t.Fatal("unwrap accepted a broken envelope")
			}
		})
	}
}

func TestParseEventCursor(t *testing.T) {
	epoch, pos, ordinal, err := parseEventCursor("v1.7.12.3")
	if err != nil || epoch != 7 || pos != 12 || ordinal != 3 {
		t.Fatalf("parseEventCursor = %d,%d,%d,%v", epoch, pos, ordinal, err)
	}
	for _, cursor := range []string{"", "v2.7.12.3", "v1.7.12", "v1.7.12.3.4", "v1.7.-1.3"} {
		if _, _, _, err := parseEventCursor(cursor); err == nil {
			t.Fatalf("parseEventCursor(%q) accepted an invalid cursor", cursor)
		}
	}
}
