package phic

import (
	"bytes"
	"errors"
)

const maxRepaintControl = 1 << 20

// repaintFilter holds only an unfinished escape, never a screen or recording.
// Historical queries and clipboard writes have no place in a display rebuild.
// Live controls remain untouched. A control begun in replay keeps that policy
// even when its terminator arrives in a later live frame.
type repaintFilter struct {
	pending  []byte
	kind     byte
	escaped  bool
	utf8Left int
}

func (f *repaintFilter) Feed(data []byte, historical bool) ([]byte, error) {
	if !historical && len(f.pending) == 0 {
		return data, nil
	}
	out := make([]byte, 0, len(data))
	for _, b := range data {
		if len(f.pending) == 0 {
			if !historical {
				out = append(out, b)
				continue
			}
			if f.utf8Left > 0 {
				if b&0xc0 == 0x80 {
					f.utf8Left--
					out = append(out, b)
					continue
				}
				f.utf8Left = 0
			}
			switch b {
			case 5:
				continue // ENQ
			case 0x1b:
				f.pending = []byte{b}
				f.kind = 'e'
				continue
			case 0xc2:
				f.pending = []byte{b}
				f.kind = 'u'
				continue
			case 0x9b:
				f.pending = []byte{b}
				f.kind = 'c'
				continue
			case 0x9d:
				f.pending = []byte{b}
				f.kind = 'o'
				continue
			case 0x90:
				f.pending = []byte{b}
				f.kind = 'd'
				continue
			}
			if b >= 0xc3 && b <= 0xdf {
				f.utf8Left = 1
			}
			if b >= 0xe0 && b <= 0xef {
				f.utf8Left = 2
			}
			if b >= 0xf0 && b <= 0xf4 {
				f.utf8Left = 3
			}
			out = append(out, b)
			continue
		}
		if b == 0x1b && (f.kind == 'e' || f.kind == 'c') {
			// ESC aborts an unfinished escape/CSI and starts a new command.
			// Preserve any embedded C0 effects, then cancel the aborted prefix
			// so suppressing the successor query cannot leave native CSI state.
			out = append(out, f.pending...)
			out = append(out, 0x18)
			f.pending = []byte{b}
			f.kind = 'e'
			continue
		}
		f.pending = append(f.pending, b)
		if len(f.pending) > maxRepaintControl {
			return nil, errors.New("phic: repaint escape exceeds 1 MiB; recording remains in Phi")
		}
		done := false
		switch f.kind {
		case 'u':
			switch b {
			case 0x9b:
				f.kind = 'c'
			case 0x9d:
				f.kind = 'o'
			case 0x90:
				f.kind = 'd'
			default:
				done = true
			}
		case 'e':
			switch b {
			case '[':
				f.kind = 'c'
			case ']':
				f.kind = 'o'
			case 'P':
				f.kind = 'd'
			default:
				done = true
			}
		case 'c':
			done = b >= 0x40 && b <= 0x7e
		case 'o', 'd':
			done = (f.escaped && b == '\\') || (f.kind == 'o' && b == 7) || b == 0x9c
			f.escaped = b == 0x1b
		}
		if b == 0x18 || b == 0x1a {
			done = true
		}
		if done {
			if !repaintQuery(f.pending) {
				out = append(out, f.pending...)
			}
			f.pending = nil
			f.kind = 0
			f.escaped = false
		}
	}
	return out, nil
}

// ResumeLive releases an unfinished control at the observed frontier. It
// could not have produced a reply before its terminator existed, so its first
// completion is live, even when the prefix was emitted before the menu.
func (f *repaintFilter) ResumeLive() []byte {
	pending := f.pending
	f.pending = nil
	f.kind = 0
	f.escaped = false
	f.utf8Left = 0
	return pending
}

func repaintQuery(seq []byte) bool {
	if bytes.Equal(seq, []byte("\x1bZ")) {
		return true
	}
	// The lexer accepts both UTF-8 C1 controls and legacy 8-bit introducers.
	normalized := seq
	if len(seq) > 0 && (seq[0] == 0x9b || seq[0] == 0x9d || seq[0] == 0x90) {
		intro := byte('[')
		if seq[0] == 0x9d {
			intro = ']'
		}
		if seq[0] == 0x90 {
			intro = 'P'
		}
		normalized = append([]byte{0x1b, intro}, seq[1:]...)
	}
	if bytes.HasPrefix(normalized, []byte("\x1b]52;")) || bytes.HasPrefix(normalized, []byte("\xc2\x9d52;")) {
		return true
	}
	if len(normalized) > 0 && normalized[len(normalized)-1] == 0x9c {
		normalized = append(append([]byte{}, normalized[:len(normalized)-1]...), 0x1b, '\\')
	}
	guard := queryGuard{}
	return guard.Feed(normalized)
}
