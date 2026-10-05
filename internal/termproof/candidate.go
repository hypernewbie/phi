package termproof

// The four candidate mechanisms in the plan's section 5. Each function
// describes the bytes the mechanism would write to a real PTY. The
// test layer (candidate_test.go) runs them against the seven cases
// and records which bytes the child actually saw, which bytes the
// master saw, and which would be accepted by a real terminal.
//
// These functions are deliberately tiny: the proof is the comparison
// between what we *can* preserve (bytes) and what we *need* to preserve
// (a rendered screen). Without an emulator, that comparison is
// permanently underdetermined. The plan's stop condition is exactly
// this: "If no mechanism passes the proof cases, record the exact
// unsupported cases. Get approval for a smaller compatibility scope
// before continuing."

// CursorSave is the standard DEC private save sequence. It is a
// per-cursor primitive, not a screen primitive. The plan calls out
// that saving a cursor does not save the screen.
const CursorSave = "\x1b7"
const CursorRestore = "\x1b8"

// AltBufferEnter / AltBufferLeave are the xterm alt-screen toggles.
const (
	AltBufferEnter  = "\x1b[?1049h"
	AltBufferLeave  = "\x1b[?1049l"
	CursorHide      = "\x1b[?25l"
	CursorShow      = "\x1b[?25h"
	MouseEnableAll  = "\x1b[?1003h"
	MouseDisable    = "\x1b[?1006l"
	ReportFocusAll  = "\x1b[?1004h"
	KittyKbdEnable  = "\x1b[>1u"
	KittyKbdDisable = "\x1b[<u"
	DSRcursor       = "\x1b[6n"   // query cursor position; backend replies CSI row;col R
	DA1             = "\x1b[c"    // primary device attributes; replies CSI ?...c
	OSC0            = "\x1b]0;title\x07" // set window title; partial OSC used by case 5
)

// Mechanism1AltBuffer runs the menu inside the xterm alt buffer and
// drops the alt buffer on exit. The plan says this is a candidate but
// also that "Leaving the pager does not necessarily restore the
// backend view" if the backend never owned the alt buffer.
type Mechanism1AltBuffer struct{}

// Open / Close are the bytes the client would write around the menu.
func (Mechanism1AltBuffer) Open() []byte  { return []byte(AltBufferEnter + CursorHide + "\x1b[2J\x1b[H") }
func (Mechanism1AltBuffer) Close() []byte { return []byte(AltBufferLeave + CursorShow) }

// Mechanism2Checkpoint stores an opaque ANSI snapshot and replays it.
// The plan notes the snapshot bytes must be both geometry-compatible
// and proven native-compatible. The fixture here only records the
// bytes; the test layer in case_test.go measures whether replay
// reproduces the same byte stream the original produced.
type Mechanism2Checkpoint struct {
	// Geometry is the cols/rows the snapshot was captured under.
	Geometry [2]uint16
	// Bytes is the opaque ANSI payload. In a real client this would
	// be produced by an xterm.js SerializeAddon, which the plan
	// bans from the shipped binary. The fixture accepts a captured
	// buffer as a parameter to keep that boundary honest.
	Bytes []byte
}

// Open / Close: this mechanism does not bracket the menu with new
// bytes; the menu renders, the client captures, and on close the
// captured bytes are replayed.
func (m Mechanism2Checkpoint) Open() []byte  { return nil }
func (m Mechanism2Checkpoint) Close() []byte { return append([]byte(nil), m.Bytes...) }

// Mechanism3Redraw signals the backend to redraw itself. The plan
// forbids a SIGWINCH nudge (it can disturb other clients) and a
// Ctrl-L injection (it is not a general redraw contract). This
// mechanism remains only for backends that document a known redraw
// signal; the fixture records the byte sent and the bytes observed.
type Mechanism3Redraw struct {
	// RedrawBytes is the per-backend sequence: SIGWINCH is sent out
	// of band and is therefore not represented here.
	RedrawBytes []byte
}

func (Mechanism3Redraw) Open() []byte  { return nil }
func (m Mechanism3Redraw) Close() []byte { return m.RedrawBytes }

// Mechanism4Replay replays the entire recording from offset 0. The
// plan says this is only correct where geometry and terminal-query
// behavior make the replay correct. The fixture writes a synthetic
// recording and the test layer checks what happens to a live query
// issued while the replay is in flight.
type Mechanism4Replay struct {
	Recording []byte
}

func (Mechanism4Replay) Open() []byte  { return nil }
func (m Mechanism4Replay) Close() []byte { return append([]byte(nil), m.Recording...) }
