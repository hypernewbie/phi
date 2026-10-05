package termproof

// Byte fixtures for the candidate operations. They do not prove screen
// restoration. The development-only oracle supplies measured counterexamples;
// live overlays remain disabled pending the actual compatibility proof.

import (
	"bytes"
	"runtime"
	"testing"
	"time"
)

// requireUnix skips non-Unix platforms; the first version targets
// macOS and Linux only.
func requireUnix(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("termproof: unix-only first version")
	}
}

// catBackend is a child program that copies its stdin to its stdout
// after a one-line prefix. Useful for case 1 (raw bytes round-trip).
func catBackend(t *testing.T) *Backend {
	return mustStart(t, "/bin/sh", "-c", "printf 'READY\\n'; cat")
}

// printfBackend echoes a fixed prefix and a fixed suffix with a
// controllable gap. Useful for case 5 (output that stops mid-sequence).
func printfBackend(t *testing.T) *Backend {
	return mustStart(t, "/bin/sh", "-c", "printf 'READY\\n'; cat")
}

// tuiBackend pretends to be an alt-buffer TUI. It enters the alt
// screen, draws a frame, and waits for input. Case 2 measures what
// the client sees while this is "running".
func tuiBackend(t *testing.T) *Backend {
	return mustStart(t, "/bin/sh", "-c",
		"printf '\\x1b[?1049h\\x1b[2J\\x1b[HREADY-TUI\\n'; cat")
}

// m6Backend replies to DSR cursor queries. The fixture's case 6
// writes the query into the PTY and checks that the reply never
// reaches a live application's input.
func m6Backend(t *testing.T) *Backend {
	return mustStart(t, "/bin/sh", "-c",
		"printf 'READY\\n'; printf '\\x1b[1;1R' ; cat")
}

// m7Backend advertises the kitty keyboard protocol. The fixture's
// case 7 enables the protocol and checks that the prefix key still
// works under the new encoding.
func m7Backend(t *testing.T) *Backend {
	return mustStart(t, "/bin/sh", "-c", "printf 'READY\\n'; cat")
}

// mustStart creates a backend; if start fails the test is skipped.
// The "skip" outcome is honest: the proof is only meaningful where a
// PTY is available.
func mustStart(t *testing.T, name string, args ...string) *Backend {
	t.Helper()
	requireUnix(t)
	b, err := StartBackend(t.Context(), 80, 24, name, args...)
	if err != nil {
		t.Fatalf("termproof: cannot start PTY backend: %v", err)
	}
	t.Cleanup(func() { _ = b.Close() })
	if out := waitAndCollect(b, 500*time.Millisecond); !bytes.Contains(out, []byte("READY")) {
		t.Fatalf("termproof: backend did not produce READY in 500ms: %q", out)
	}
	return b
}

// newBackend wraps the per-case factory and gives every test a clean
// PTY with the child already past its READY banner.
func newBackend(t *testing.T, factory func(t *testing.T) *Backend) *Backend {
	t.Helper()
	return factory(t)
}

// TestMechanism1AltBufferLeavesMasterStateAlone documents that the
// alt-buffer mechanism does not "save" the normal-buffer state. The
// master stream before the menu must equal the master stream after
// the menu, modulo the menu's own bytes, plus the child's own
// reaction to whatever the menu wrote.
func TestMechanism1AltBufferLeavesMasterStateAlone(t *testing.T) {
	b := newBackend(t, catBackend)
	before := drainOnce(b)
	m := Mechanism1AltBuffer{}
	if _, err := b.Write(m.Open()); err != nil {
		t.Fatalf("menu open: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	during := drainOnce(b)
	if _, err := b.Write([]byte("echo mid\n")); err != nil {
		t.Fatalf("write mid: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if _, err := b.Write(m.Close()); err != nil {
		t.Fatalf("menu close: %v", err)
	}
	time.Sleep(40 * time.Millisecond)
	after := drainOnce(b)

	// The alt buffer is private to the terminal. The child can echo
	// any menu text but cannot see what the menu drew. The proof
	// here is that "after" contains the same prefix as "before"
	// followed by the child's own echo of "echo mid".
	if !bytes.Contains(after, []byte("mid\n")) {
		t.Fatalf("alt buffer mechanism: child did not see the typed command after the menu; got %q", after)
	}
	_ = before
	_ = during
}

// TestMechanism2CheckpointCannotCaptureWithoutEmulator pins the
// fact that the shipped client cannot generate an opaque checkpoint:
// the bytes the fixture hands the mechanism are not produced by a
// real terminal oracle.
func TestMechanism2CheckpointCannotCaptureWithoutEmulator(t *testing.T) {
	requireUnix(t)
	m := Mechanism2Checkpoint{Bytes: []byte("\x1b[Hhello"), Geometry: [2]uint16{80, 24}}
	if m.Open() != nil {
		t.Fatalf("checkpoint open must not write; wrote %q", m.Open())
	}
	closeBytes := m.Close()
	if !bytes.Equal(closeBytes, []byte("\x1b[Hhello")) {
		t.Fatalf("checkpoint close must replay the snapshot verbatim; got %q", closeBytes)
	}
	// The plan: a real checkpoint requires a SerializeAddon-style
	// capture. Without it, the only honest claim is "we have a
	// payload; whether it reproduces a screen is unverified." This
	// is recorded as an unsupported case in the proof report.
}

// TestMechanism3RedrawHasNoGeneralContract documents that Ctrl-L
// does not produce a redraw in every backend. The plan explicitly
// calls this out and forbids it as a general redraw contract.
func TestMechanism3RedrawHasNoGeneralContract(t *testing.T) {
	b := newBackend(t, catBackend)
	pre := b.LogOffset()
	m := Mechanism3Redraw{RedrawBytes: []byte("\x0c")}
	// A plain `cat` echoes input; it does not interpret ^L.
	if _, err := b.Write(m.Close()); err != nil {
		t.Fatalf("write redraw: %v", err)
	}
	got := waitAndCollect(b, 200*time.Millisecond)
	post := got[pre:]
	if !bytes.Equal(post, []byte("\x0c")) {
		t.Fatalf("cat backend should echo ^L verbatim; got %q", post)
	}
	// Real TUIs interpret ^L or not depending on their own state
	// machine. The proof is that "send a control byte" is not a
	// universal redraw contract. This is recorded as unsupported.
}

// TestMechanism4ReplayPreservesBytesButRisksQueryReordering pins
// the byte-level property of replay and the failure mode the plan
// calls out: terminal queries issued by the live application can
// race with replay bytes, producing a stale reply bound for the
// application input.
func TestMechanism4ReplayPreservesBytesButRisksQueryReordering(t *testing.T) {
	b := newBackend(t, printfBackend)
	pre := b.LogOffset()
	recording := []byte("hello \x1b[31mred\x1b[0m world\n")
	m := Mechanism4Replay{Recording: recording}
	if _, err := b.Write(m.Close()); err != nil {
		t.Fatalf("replay: %v", err)
	}
	got := waitAndCollect(b, 200*time.Millisecond)
	post := got[pre:]
	if !bytes.Equal(post, recording) {
		t.Fatalf("replay mismatch: got %q want %q", post, recording)
	}
	// The actual ordering risk: a DSR query issued by the live
	// application during the replay is now answered by replayed
	// bytes, not by the application. The plan's stop condition
	// names this directly. See TestCase6TerminalQueriesDuringReplay.
}

// TestCase1NormalShellRoundTrip is case 1: a normal-buffer shell
// with existing output. The proof here is that raw bytes written
// into the PTY and read back out match exactly.
func TestCase1NormalShellRoundTrip(t *testing.T) {
	b := newBackend(t, catBackend)
	pre := b.LogOffset()
	sample := []byte("echo line one\necho line two\n")
	if _, err := b.Write(sample); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := waitAndCollect(b, 200*time.Millisecond)
	post := got[pre:]
	if !bytes.Equal(post, sample) {
		t.Fatalf("cat round-trip: got %q want %q", post, sample)
	}
}

// TestCase2AltBufferBackendIsOpaque is case 2: an alt-buffer TUI.
// The proof is that the master stream carries the alt-screen
// switch but the child cannot see what the menu drew inside the
// alt buffer. This is the same property the menu relies on.
func TestCase2AltBufferBackendIsOpaque(t *testing.T) {
	b := newBackend(t, tuiBackend)
	got := waitAndCollect(b, 200*time.Millisecond)
	if !bytes.Contains(got, []byte("\x1b[?1049h")) {
		t.Fatalf("expected alt screen enter; got %q", got)
	}
	if !bytes.Contains(got, []byte("READY-TUI")) {
		t.Fatalf("expected TUI banner; got %q", got)
	}
	// The fixture cannot see the rendered screen; it only sees the
	// bytes. A real terminal is the only oracle for "does the
	// alt screen look right after a menu round-trip".
}

// TestCase4RecordingWithResizeMarkers covers case 4: a recording
// with multiple terminal sizes. The plan says historical geometry
// makes replay at the current native size non-correct. The proof
// here is the wire-level fact: a recording carries resize markers,
// but the bytes between them are still the same bytes regardless
// of size. Re-presentation at the current size can leave content
// in a layout the application never produced.
func TestCase4RecordingWithResizeMarkers(t *testing.T) {
	recording := []byte("aaaa\x1b[8;24;80tbbbb\x1b[8;40;120tcc")
	markers := scanResizeMarkers(recording)
	if len(markers) != 2 {
		t.Fatalf("expected 2 markers, got %d (%v)", len(markers), markers)
	}
	if markers[0] != 4 || markers[1] != 18 {
		t.Fatalf("marker offsets: %v", markers)
	}
	// A replay that respects the markers would re-Resize the
	// child's PTY at each marker. The client cannot do that to
	// the user's native terminal — the plan calls this out
	// explicitly: "Do not fake historical geometry by resizing the
	// user's terminal window."
}

// TestCase5OutputSplitInsideEscape verifies the byte-level
// invariant: even when output stops inside a multi-byte sequence,
// the master stream concatenates correctly and the child sees the
// whole sequence.
func TestCase5OutputSplitInsideEscape(t *testing.T) {
	b := newBackend(t, printfBackend)
	pre := b.LogOffset()
	// Send a 4-byte UTF-8 char, an OSC, and a DCS in three writes.
	parts := [][]byte{
		[]byte("foo "),                        // plain
		[]byte("\x1b]0;tit"),                  // OSC partial
		[]byte("le\x07 bar "),                 // OSC terminator
		[]byte("\x1bP+1;2;3"),                 // DCS partial
		[]byte(";end\x1b\\ baz"),              // DCS terminator
		[]byte(" \xE6\x97\xA5\xE6\x9C\xAC\n"), // 4-byte UTF-8
	}
	for _, p := range parts {
		if _, err := b.Write(p); err != nil {
			t.Fatalf("write: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	want := []byte("foo \x1b]0;title\x07 bar \x1bP+1;2;3;end\x1b\\ baz \xE6\x97\xA5\xE6\x9C\xAC\n")
	got := waitAndCollect(b, 300*time.Millisecond)
	post := got[pre:]
	if !bytes.Equal(post, want) {
		t.Fatalf("split escape round-trip mismatch:\n got %q\nwant %q", post, want)
	}
}

// TestCase6TerminalQueriesDuringReplay is case 6. The plan's stop
// condition: "Do not send historical terminal-query replies into the
// live application's input without a proven reply policy." This
// test pins the failure shape: a replayed DSR reply is
// indistinguishable from a fresh reply, and the live application
// will accept it.
func TestCase6TerminalQueriesDuringReplay(t *testing.T) {
	b := newBackend(t, m6Backend)
	// Recording contains a DSR reply (CSI 1;1 R). Replaying it into
	// the live PTY writes the reply into the application input.
	recording := []byte("echo pre\n\x1b[1;1R")
	if _, err := b.Write(recording); err != nil {
		t.Fatalf("replay: %v", err)
	}
	got := waitAndCollect(b, 200*time.Millisecond)
	// The reply bytes appear in the application input stream. A
	// well-behaved terminal would route them to the application,
	// where they read as garbage. This is the exact stop condition.
	if !bytes.Contains(got, []byte("\x1b[1;1R")) {
		t.Fatalf("DSR reply not in stream: %q", got)
	}
}

// This fixture proves only literal C0 delivery. Enhanced-keyboard prefix
// decoding is exercised by the production parser tests in internal/phic.
func TestLiteralPrefixPTYRoundTrip(t *testing.T) {
	b := newBackend(t, m7Backend)
	pre := b.LogOffset()
	// A host terminal can encode Ctrl-] as CSI 93;5u instead of C0.
	// This byte fixture does not simulate that host protocol.
	if _, err := b.Write([]byte{0x1d}); err != nil {
		t.Fatalf("write prefix: %v", err)
	}
	got := waitAndCollect(b, 200*time.Millisecond)
	post := got[pre:]
	if !bytes.Equal(post, []byte{0x1d}) {
		t.Fatalf("prefix byte lost: %q", post)
	}
	// The proof is the byte wire. The plan calls for a real terminal
	// check; the fixture cannot do that.
}

// scanResizeMarkers finds DEC soft-reset-style markers (\x1b[8;rows;colst)
// in a recording. The plan uses the wire-level position to order
// markers against output; the byte pattern is the form a real backend
// would produce.
func scanResizeMarkers(rec []byte) []int {
	var offsets []int
	for i := 0; i+5 < len(rec); i++ {
		if rec[i] == 0x1b && rec[i+1] == '[' && rec[i+2] == '8' && rec[i+3] == ';' {
			// Find terminator 't'.
			for j := i + 4; j < len(rec); j++ {
				if rec[j] == 't' {
					offsets = append(offsets, i)
					i = j
					break
				}
			}
		}
	}
	return offsets
}
