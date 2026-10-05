// The four candidate mechanisms from PHIC_PLAN.md section 5.
// The proof in candidate_test.go runs each mechanism against
// the seven cases and records which ones pass.
package termproof

// CursorSave / CursorRestore: per-cursor primitive, not a
// screen primitive.
const (
	CursorSave      = "\x1b7"
	CursorRestore   = "\x1b8"
	AltBufferEnter  = "\x1b[?1049h"
	AltBufferLeave  = "\x1b[?1049l"
	CursorHide      = "\x1b[?25l"
	CursorShow      = "\x1b[?25h"
	MouseEnableAll  = "\x1b[?1003h"
	MouseDisable    = "\x1b[?1006l"
	ReportFocusAll  = "\x1b[?1004h"
	KittyKbdEnable  = "\x1b[>1u"
	KittyKbdDisable = "\x1b[<u"
	DSRcursor       = "\x1b[6n"
	DA1             = "\x1b[c"
	OSC0            = "\x1b]0;title\x07"
)

// Mechanism1AltBuffer: menu in the xterm alt screen.
type Mechanism1AltBuffer struct{}

func (Mechanism1AltBuffer) Open() []byte {
	return []byte(AltBufferEnter + CursorHide + "\x1b[2J\x1b[H")
}

func (Mechanism1AltBuffer) Close() []byte {
	return []byte(AltBufferLeave + CursorShow)
}

// Mechanism2Checkpoint: opaque ANSI snapshot. Production
// cannot generate this without a real terminal oracle.
type Mechanism2Checkpoint struct {
	Geometry [2]uint16
	Bytes    []byte
}

func (m Mechanism2Checkpoint) Open() []byte  { return nil }
func (m Mechanism2Checkpoint) Close() []byte { return append([]byte(nil), m.Bytes...) }

// Mechanism3Redraw: per-backend redraw signal. No general
// contract; SIGWINCH and Ctrl-L are forbidden by the plan.
type Mechanism3Redraw struct {
	RedrawBytes []byte
}

func (Mechanism3Redraw) Open() []byte      { return nil }
func (m Mechanism3Redraw) Close() []byte   { return m.RedrawBytes }

// Mechanism4Replay: replay the entire recording. Only
// correct where geometry and terminal-query behavior match.
type Mechanism4Replay struct {
	Recording []byte
}

func (Mechanism4Replay) Open() []byte    { return nil }
func (m Mechanism4Replay) Close() []byte { return append([]byte(nil), m.Recording...) }
