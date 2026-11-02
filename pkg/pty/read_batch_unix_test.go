//go:build unix

package pty

import (
	"bytes"
	"os"
	"testing"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
)

// ReadBatch returns promptly with whatever is already buffered: it must
// not wait for a slow second chunk, and it must not close the PTY when
// the drain times out.
func TestReadBatchDrainsAvailableWithoutWaiting(t *testing.T) {
	pt, err := gopty.New()
	if err != nil {
		t.Fatal(err)
	}
	defer pt.Close()
	slaver, ok := pt.(interface{ Slave() *os.File })
	if !ok {
		t.Skip("pty implementation has no slave handle")
	}
	slave := slaver.Slave()
	defer slave.Close()
	if _, err := slave.Write([]byte("aaa\nbbb\n")); err != nil {
		t.Fatal(err)
	}
	p := &Pty{pt: pt}
	buf := make([]byte, 64*1024)
	start := time.Now()
	n, rerr := p.ReadBatch(buf)
	elapsed := time.Since(start)
	if rerr != nil {
		t.Fatalf("ReadBatch: %v", rerr)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("ReadBatch waited for more data: %s", elapsed)
	}
	if !bytes.Contains(buf[:n], []byte("aaa")) || !bytes.Contains(buf[:n], []byte("bbb")) {
		t.Fatalf("ReadBatch returned %q, want both chunks", buf[:n])
	}
	// The drain timeout must leave the PTY usable.
	if _, err := slave.Write([]byte("ccc\n")); err != nil {
		t.Fatal(err)
	}
	n2, rerr := p.ReadBatch(buf)
	if rerr != nil {
		t.Fatalf("second ReadBatch: %v", rerr)
	}
	if !bytes.Contains(buf[:n2], []byte("ccc")) {
		t.Fatalf("second ReadBatch returned %q", buf[:n2])
	}
}

func TestReadBatchConcurrentClose(t *testing.T) {
	for i := 0; i < 256; i++ {
		pt, err := gopty.New()
		if err != nil {
			t.Fatal(err)
		}
		p := &Pty{pt: pt}
		if _, err := pt.(gopty.UnixPty).Slave().Write([]byte("pending output\n")); err != nil {
			p.closePTY()
			t.Fatal(err)
		}
		started, done := make(chan struct{}), make(chan struct{})
		go func() {
			close(started)
			_, _ = p.ReadBatch(make([]byte, 32*1024))
			close(done)
		}()
		<-started
		p.closePTY()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("ReadBatch did not finish after PTY close")
		}
	}
}
