package ws

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestRecordingCorruptMiddleAndTornTailPreservesCommittedSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recording")
	r, err := openRecording(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.file.Close()
	if err := r.append(1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	middle := r.offset
	if err := r.append(1, []byte("second committed")); err != nil {
		t.Fatal(err)
	}
	if err := r.append(1, []byte("third committed")); err != nil {
		t.Fatal(err)
	}
	var invalid [4]byte
	binary.BigEndian.PutUint32(invalid[:], 65*1024*1024)
	if _, err := r.file.WriteAt(invalid[:], middle+1); err != nil {
		t.Fatal(err)
	}
	if _, err := r.file.WriteAt([]byte{1, 0}, r.offset); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reopened, openErr := openRecording(path)
	if reopened != nil {
		defer reopened.file.Close()
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if openErr == nil {
		t.Error("corrupt middle and torn tail must fail closed")
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("cold recovery deleted %d bytes including the committed suffix", len(before)-len(after))
	}
}
