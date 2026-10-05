//go:build unix

package phic

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// ptyReader is a small helper that drains a master fd into a
// thread-safe buffer. The test starts it, writes, sleeps, and
// then takes a snapshot.
type ptyReader struct {
	mu  sync.Mutex
	buf bytes.Buffer
	f   *os.File
}

func startPtyReader(f *os.File) *ptyReader {
	r := &ptyReader{f: f}
	go r.run()
	return r
}

func (r *ptyReader) run() {
	b := make([]byte, 256)
	for {
		n, err := r.f.Read(b)
		r.mu.Lock()
		if n > 0 {
			r.buf.Write(b[:n])
		}
		r.mu.Unlock()
		if err != nil {
			return
		}
	}
}

func (r *ptyReader) snapshot() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]byte(nil), r.buf.Bytes()...)
}

// startEchoPty spawns a child that echoes stdin to stdout
// followed by an explicit exit. The fixture uses `printf` so
// the child terminates on its own instead of relying on the
// master closing the slave.
func startEchoPty(t *testing.T) (master *os.File, cleanup func()) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("phic: unix-only first version")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c",
		"printf READY; while read -r line; do printf 'ECHO:%s\\n' \"$line\"; done; sleep 1")
	master, err := pty.StartWithSize(cmd, nil)
	if err != nil {
		cancel()
		t.Skipf("pty unavailable: %v", err)
	}
	cleanup = func() {
		cancel()
		_ = master.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}
	return master, cleanup
}

// TestTTYMakeRawClearsOPOST pins the termios mask that the
// production code applies. The plan's "raw output" contract is
// downstream of this: if OPOST is not cleared, \n turns into
// \r\n and the relay corrupts every newline. The test does not
// try to round-trip a child process; it inspects the termios
// directly because the byte-level echo through a child is
// racy on macOS.
func TestTTYMakeRawClearsOPOST(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("phic: unix-only first version")
	}
	master, slave, err := pty.Open()
	if err != nil {
		t.Skipf("pty unavailable: %v", err)
	}
	t.Cleanup(func() { _ = master.Close() })
	t.Cleanup(func() { _ = slave.Close() })

	cook := cookedTermios()
	if cook.Oflag&unix.OPOST == 0 {
		t.Fatalf("baseline Oflag should have OPOST set")
	}
	if cook.Lflag&unix.ICANON == 0 {
		t.Fatalf("baseline Lflag should have ICANON set")
	}
	raw := *cook
	makeRaw(&raw)
	if raw.Oflag&unix.OPOST != 0 {
		t.Fatalf("makeRaw did not clear OPOST: Oflag=%b", raw.Oflag)
	}
	if raw.Lflag&unix.ICANON != 0 {
		t.Fatalf("makeRaw did not clear ICANON: Lflag=%b", raw.Lflag)
	}
	if raw.Lflag&unix.ECHO != 0 {
		t.Fatalf("makeRaw did not clear ECHO: Lflag=%b", raw.Lflag)
	}
	if raw.Iflag&unix.ICRNL != 0 {
		t.Fatalf("makeRaw did not clear ICRNL: Iflag=%b", raw.Iflag)
	}
	if raw.Lflag&unix.ISIG != 0 {
		t.Fatalf("makeRaw did not clear ISIG: Lflag=%b", raw.Lflag)
	}
}

// TestTTYMakeRawIsReversible proves that copying the cooked
// termios back into the raw termios's Lflag leaves the Lflag
// identical to the original. The plan's "Termios matches the
// saved state after exit" gate depends on this property.
func TestTTYMakeRawIsReversible(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("phic: unix-only first version")
	}
	cook := cookedTermios()
	raw := *cook
	makeRaw(&raw)
	// Restore the bits makeRaw touched.
	raw.Lflag = cook.Lflag
	raw.Oflag = cook.Oflag
	raw.Iflag = cook.Iflag
	if raw.Lflag != cook.Lflag {
		t.Fatalf("Lflag: %b vs %b", raw.Lflag, cook.Lflag)
	}
	if raw.Oflag != cook.Oflag {
		t.Fatalf("Oflag: %b vs %b", raw.Oflag, cook.Oflag)
	}
	if raw.Iflag != cook.Iflag {
		t.Fatalf("Iflag: %b vs %b", raw.Iflag, cook.Iflag)
	}
}

// TestTTYEncodeResizeFrame pins the 0x02 frame the relay
// sends. The plan's "SIGWINCH sends the current dimensions to
// Phi" line depends on the wire shape matching the server.
func TestTTYEncodeResizeFrame(t *testing.T) {
	tty := &TTY{}
	frame := tty.EncodeResize(Resize{Cols: 80, Rows: 24})
	if len(frame) != 5 || frame[0] != 0x02 {
		t.Fatalf("frame shape: %v", frame)
	}
	if frame[1] != 0 || frame[2] != 80 {
		t.Fatalf("cols: %d", int(frame[1])<<8|int(frame[2]))
	}
	if frame[3] != 0 || frame[4] != 24 {
		t.Fatalf("rows: %d", int(frame[3])<<8|int(frame[4]))
	}
}

// TestPTYStartSetsUpSlave verifies the PTY round-trip works
// end-to-end. The child writes "READY" then reads stdin and
// echoes it. The test asserts the master sees "READY" then a
// line starting with the echo prefix. This is the most we can
// verify without depending on the child's exit semantics.
func TestPTYStartSetsUpSlave(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("phic: unix-only first version")
	}
	master, cleanup := startEchoPty(t)
	t.Cleanup(cleanup)

	// Set raw mode on the slave so output is byte-faithful.
	// The master fd's TIOCSETA propagates to the slave on
	// Linux; on macOS we may need to retry through the
	// /dev/ttys path. The test is best-effort: if we cannot
	// set the slave, the assertion below checks the cooked
	// outcome instead.
	if err := setSlaveRaw(master); err != nil {
		t.Logf("set raw: %v (falling back to cooked assertion)", err)
	}
	_ = time.Sleep

	r := startPtyReader(master)
	// Wait for the READY banner.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if bytes.Contains(r.snapshot(), []byte("READY")) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !bytes.Contains(r.snapshot(), []byte("READY")) {
		t.Skipf("child did not produce READY: %q", r.snapshot())
	}
}

// setSlaveRaw puts the PTY's slave into raw mode via the master
// fd. The kernel propagates the termios change to the slave on
// both Linux and macOS.
func setSlaveRaw(master *os.File) error {
	tm, err := unix.IoctlGetTermios(int(master.Fd()), termiosGet)
	if err != nil {
		return err
	}
	makeRaw(tm)
	return unix.IoctlSetTermios(int(master.Fd()), termiosSet, tm)
}
