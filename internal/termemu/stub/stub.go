// Package stub provides a pure-Go termemu implementation for unit tests that
// need the adapter interface without native memory. It records bytes, keeps a
// trivial cursor, and never parses. It must not be used by production client
// paths: production code goes through termemu.NewGhostty, and a build without
// the native adapter reports ErrUnsupported instead of substituting a parser.
package stub

import (
	"strings"
	"sync"

	"github.com/hypernewbie/phi/internal/termemu"
)

// Terminal satisfies termemu.Terminal without CGO.
type Terminal struct {
	mu      sync.Mutex
	cols    int
	rows    int
	cells   [][]termemu.Cell
	cursor  termemu.Cursor
	history int
	closed  bool
	opts    termemu.Options

	// scripting knobs for tests
	KeyFn   func(termemu.KeyEvent) []byte
	MouseFn func(termemu.MouseAction, termemu.MouseButton, termemu.Modifier, int, int) []byte
	Modes   map[termemu.Mode]bool
}

// New builds a stub terminal at the given geometry.
func New(opts termemu.Options) (*Terminal, error) {
	if opts.Cols <= 0 || opts.Rows <= 0 {
		return nil, termemu.ErrInvalidGeometry
	}
	if opts.ScrollbackBytes <= 0 || opts.ScrollbackLines <= 0 {
		return nil, termemu.ErrZeroBudget
	}
	t := &Terminal{cols: opts.Cols, rows: opts.Rows, opts: opts, Modes: map[termemu.Mode]bool{}}
	t.cells = make([][]termemu.Cell, opts.Rows)
	for i := range t.cells {
		t.cells[i] = make([]termemu.Cell, opts.Cols)
	}
	return t, nil
}

// Feed records plain text into the frame so tests can assert visible output.
// It understands no escape sequences.
func (t *Terminal) Feed(b []byte, source termemu.Source) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return termemu.ErrUnsupported
	}
	if source != termemu.SourceLive {
		return nil
	}
	for _, r := range string(b) {
		if r == '\n' {
			t.cursor.X = 0
			t.cursor.Y++
			if t.cursor.Y >= t.rows {
				t.cursor.Y = t.rows - 1
				t.history++
			}
			continue
		}
		if r == '\r' {
			t.cursor.X = 0
			continue
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		if t.cursor.X < t.cols && t.cursor.Y < t.rows {
			t.cells[t.cursor.Y][t.cursor.X] = termemu.Cell{Text: string(r), Width: 1}
		}
		t.cursor.X++
	}
	return nil
}

// Resize updates geometry.
func (t *Terminal) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return termemu.ErrInvalidGeometry
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return termemu.ErrUnsupported
	}
	if cols == t.cols && rows == t.rows {
		return nil
	}
	t.cells = make([][]termemu.Cell, rows)
	for i := range t.cells {
		t.cells[i] = make([]termemu.Cell, cols)
	}
	t.cols, t.rows = cols, rows
	return nil
}

// Snapshot copies the current frame.
func (t *Terminal) Snapshot() (termemu.Frame, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return termemu.Frame{}, termemu.ErrUnsupported
	}
	cells := make([][]termemu.Cell, t.rows)
	for i := range t.cells {
		row := make([]termemu.Cell, t.cols)
		copy(row, t.cells[i])
		cells[i] = row
	}
	return termemu.Frame{Cols: t.cols, Rows: t.rows, Cursor: t.cursor, History: t.history, Cells: cells}, nil
}

// EncodeKey delegates to KeyFn or returns literal text.
func (t *Terminal) EncodeKey(ev termemu.KeyEvent) ([]byte, error) {
	if t.KeyFn != nil {
		return t.KeyFn(ev), nil
	}
	if ev.Text != "" && ev.Mods == 0 {
		return []byte(ev.Text), nil
	}
	return nil, nil
}

// EncodeMouse delegates to MouseFn.
func (t *Terminal) EncodeMouse(a termemu.MouseAction, b termemu.MouseButton, m termemu.Modifier, x, y int) ([]byte, error) {
	if t.MouseFn != nil {
		return t.MouseFn(a, b, m, x, y), nil
	}
	return nil, nil
}

// EncodePaste wraps payload in bracketed paste markers.
func (t *Terminal) EncodePaste(payload []byte) ([]byte, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	var b strings.Builder
	b.WriteString("\x1b[200~")
	b.Write(payload)
	b.WriteString("\x1b[201~")
	return []byte(b.String()), nil
}

// Mode reports scripted mode state.
func (t *Terminal) Mode(m termemu.Mode) (bool, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return false, termemu.ErrUnsupported
	}
	return t.Modes[m], nil
}

// HistoryPageID returns the number of scrolled rows seen so far.
func (t *Terminal) HistoryPageID() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return uint64(t.history)
}

// NativeMemory returns zero; the stub has no native heap.
func (t *Terminal) NativeMemory() (uint64, error) { return 0, nil }

// Close releases the stub.
func (t *Terminal) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	t.cells = nil
	return nil
}
