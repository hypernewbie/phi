// Package termemu is the Phi-owned adapter around a headless terminal emulator.
//
// The native engine behind this interface is pinned libghostty-vt
// (https://github.com/ghostty-org/ghostty @ c3203ea4b169a18eb2ccfe92847e426d8afea858).
// The C API is unstable; the adapter narrows it to the operations the Phi
// client requires so the upstream pin can change without touching application
// code.
//
// Application code must import only this package and must not import C types or
// upstream enum numbers. All calls return useful errors; production paths do
// not rely on prototype assertions.
package termemu

// Source policy for admitted bytes. The adapter receives backend bytes from
// the application and forwards them to the emulator with the matching policy.
type Source int

const (
	// SourceLive is bytes arriving on the current WebSocket after the parsed
	// frontier. Reply and metadata callbacks are active.
	SourceLive Source = iota
	// SourceReplay is bytes coming from a recording fetch (cold attach, gap
	// recovery). Replies are suppressed so a cold attach does not
	// double-respond to queries the previous owner already satisfied.
	SourceReplay
	// SourceBoundary is the historical/live frontier inside a logical stream.
	// Replies are suppressed for the span; if the parser is still inside a
	// sequence at the end of the span, suppression continues until the
	// parser reaches ground again.
	SourceBoundary
)

// Cell is the snapshot of a single terminal cell as the application renderer
// needs it. Grapheme text is UTF-8 with explicit display width; colors carry
// their source kind so the renderer can resolve indexed/RGB/default through
// the Phi terminal palette without re-deriving them.
type Cell struct {
	Text          string
	Width         int
	Bold          bool
	Faint         bool
	Italic        bool
	Underline     Underline
	Strikethrough bool
	Inverse       bool
	Blink         bool
	Fg            Color
	Bg            Color
}

// Color captures a cell color from the emulator. Kind is what the C API
// reports; Value carries the palette index or packed RGB triple.
type Color struct {
	Kind  ColorKind
	Value uint32
}

// ColorKind matches the adapter's normalized color source tags.
type ColorKind int

const (
	ColorDefault ColorKind = iota
	ColorPalette
	ColorRGB
)

// Underline carries the terminal's underline style.
type Underline int

const (
	UnderlineNone Underline = iota
	UnderlineStraight
	UnderlineDouble
	UnderlineCurly
	UnderlineDotted
	UnderlineDashed
)

// Cursor reports the visible cursor position and pending-wrap state at
// snapshot time.
type Cursor struct {
	X           int
	Y           int
	PendingWrap bool
	Hidden      bool
}

// Mode describes an emulator mode the application may need to inspect or
// advertise.
type Mode int

const (
	ModeApplicationCursor Mode = iota
	ModeApplicationKeypad
	ModeBracketedPaste
	ModeMouseButton
	ModeMouseMotion
	ModeMouseAny
	ModeMouseSgr
	ModeMouseUrxvt
	ModeSynchronizedOutput
	ModeAlternateScreen
)

// Frame is a copied, immutable screen frame plus the metadata the renderer
// needs to draw it. Cells is row-major [row][col]; Rows and Cols describe the
// visible widget geometry; History is the number of rows held in scrollback;
// Alt is true when the alternate screen buffer is active. PageID is a
// history-revision counter the renderer can compare across snapshots.
type Frame struct {
	Cols    int
	Rows    int
	Cursor  Cursor
	Alt     bool
	History int
	Cells   [][]Cell
	PageID  uint64
}

// KeyAction is the lifecycle state of a key event.
type KeyAction int

const (
	KeyPress KeyAction = iota
	KeyRepeat
	KeyRelease
)

// Key is the platform-agnostic logical key identity. Printable input is
// carried by KeyEvent.Text; Key is the physical/logical key used for
// protocol-aware encoding.
type Key int

const (
	KeyUnidentified Key = iota
	KeyEnter
	KeyEscape
	KeyBackspace
	KeyTab
	KeyDelete
	KeyInsert
	KeyHome
	KeyEnd
	KeyPageUp
	KeyPageDown
	KeyArrowUp
	KeyArrowDown
	KeyArrowLeft
	KeyArrowRight
	KeyF1
	KeyF2
	KeyF3
	KeyF4
	KeyF5
	KeyF6
	KeyF7
	KeyF8
	KeyF9
	KeyF10
	KeyF11
	KeyF12
	KeyF13
	KeyF14
	KeyF15
	KeyF16
	KeyF17
	KeyF18
	KeyF19
	KeyF20
	KeyF21
	KeyF22
	KeyF23
	KeyF24
	KeySpace
	// KeyRune is a layout-dependent character with no stable physical key.
	// KeyEvent.Text and KeyEvent.Unshifted carry the character.
	KeyRune
)

// KeyEvent is one adapter-level key event. Text is the unmodified layout text
// for the key (empty for non-printing keys and control combinations).
// Unshifted is the unshifted codepoint for alternate-key reporting.
type KeyEvent struct {
	Action    KeyAction
	Key       Key
	Mods      Modifier
	Text      string
	Unshifted rune
}

// Modifier is the bit-set of active key modifiers.
type Modifier int

const (
	ModShift Modifier = 1 << iota
	ModCtrl
	ModAlt
	ModSuper
)

// MouseAction describes the lifecycle state of a mouse event.
type MouseAction int

const (
	MousePress MouseAction = iota
	MouseRelease
	MouseMotion
	MouseWheelUp
	MouseWheelDown
)

// MouseButton identifies the button that produced the event.
type MouseButton int

const (
	MouseLeft MouseButton = iota
	MouseMiddle
	MouseRight
	MouseNone
)

// EventOptions let the caller observe emulator side effects. The application
// can disable a channel by leaving its field nil. Feed drives these callbacks
// synchronously; they must not block or re-enter the terminal. An OnReply
// call with a nil slice reports that the adapter's reply buffer overflowed;
// the application should report the pane as degraded rather than send
// invented bytes.
//
// Host effects that the lite client denies (clipboard writes, desktop
// notifications, file-backed graphics) are never reported here at all.
type EventOptions struct {
	OnReply func([]byte)
	OnTitle func(string)
	OnPWD   func(string)
	OnBell  func()
}

// Options describes how to build a Terminal. Cols, Rows, ScrollbackBytes, and
// ScrollbackLines must be positive. The adapter rejects zero geometry or zero
// budgets instead of silently using upstream defaults.
type Options struct {
	Cols            int
	Rows            int
	ScrollbackBytes int
	ScrollbackLines int
	Events          EventOptions
}

// Terminal is the application-side handle. One Terminal owns exactly one
// emulator instance plus the adapter buffers around it. The application
// serializes calls: one owner actor per pane.
type Terminal interface {
	// Feed admits a span of backend bytes. The source controls reply
	// policy. Bytes must be ordered: the adapter does not reorder, dedupe,
	// or hold a span pending confirmation.
	Feed(b []byte, source Source) error
	// Resize changes the visible geometry without implicitly resizing a
	// remote PTY.
	Resize(cols, rows int) error
	// Snapshot copies the current frame. The returned Frame is owned by
	// the caller; subsequent emulator calls do not mutate it.
	Snapshot() (Frame, error)
	// EncodeKey returns the protocol-aware input encoding for a key event.
	// The returned slice is owned by the caller.
	EncodeKey(ev KeyEvent) ([]byte, error)
	// EncodeMouse returns the input encoding for a mouse event at
	// widget-relative cell coordinates.
	EncodeMouse(action MouseAction, button MouseButton, mods Modifier, x, y int) ([]byte, error)
	// EncodePaste returns paste bytes for the terminal's current bracketed
	// paste mode. Unsafe control bytes are replaced, never forwarded raw.
	EncodePaste(payload []byte) ([]byte, error)
	// Mode returns whether the given emulator mode is currently active.
	Mode(m Mode) (bool, error)
	// HistoryPageID returns a counter that changes when the emulator's
	// history page set changes.
	HistoryPageID() uint64
	// NativeMemory returns the emulator's reported resident bytes. Go
	// heap metrics are separate.
	NativeMemory() (uint64, error)
	// Close disposes of the emulator. No other method may be called after
	// Close.
	Close() error
}

// Error carries the failing adapter operation and the underlying message.
type Error struct {
	Op  string
	Err string
}

func (e *Error) Error() string { return e.Op + ": " + e.Err }

var (
	ErrInvalidGeometry = &Error{Op: "termemu", Err: "geometry must be positive"}
	ErrZeroBudget      = &Error{Op: "termemu", Err: "scrollback bytes and lines must be positive"}
	ErrUnsupported     = &Error{Op: "termemu", Err: "native emulator not built in this binary"}
)
