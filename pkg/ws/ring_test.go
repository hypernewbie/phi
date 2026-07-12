package ws

import (
	"bytes"
	"testing"
)

func TestRingBuffer_Basic(t *testing.T) {
	r := NewRingBuffer(5)

	r.Write([]byte("abc"))
	snap := r.Snapshot()
	if !bytes.Equal(snap, []byte("abc")) {
		t.Errorf("Expected snapshot abc, got %q", snap)
	}

	r.Write([]byte("de"))
	snap = r.Snapshot()
	if !bytes.Equal(snap, []byte("abcde")) {
		t.Errorf("Expected snapshot abcde, got %q", snap)
	}

	// Overwrite: oldest data should wrap
	r.Write([]byte("fg"))
	snap = r.Snapshot()
	if !bytes.Equal(snap, []byte("cdefg")) {
		t.Errorf("Expected snapshot cdefg, got %q", snap)
	}

	// Large write exceeding buffer size
	r.Write([]byte("hijklmnop"))
	snap = r.Snapshot()
	if !bytes.Equal(snap, []byte("lmnop")) {
		t.Errorf("Expected snapshot lmnop, got %q", snap)
	}
}
