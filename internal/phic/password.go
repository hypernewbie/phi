package phic

import (
	"context"
	"io"
	"unicode/utf8"
)

// Password entry can follow an enhanced client shortcut. Its late key-release
// or terminal-report bytes must not become part of the password. Keyboard
// reporting is reset to legacy before a live server login; echo stays off.
func readPasswordLine(ctx context.Context, t lineTerminal) (string, error) {
	var line, seq []byte
	var buf [1]byte
	for len(line) < 4096 {
		n, err := t.ReadContext(ctx, buf[:])
		if err != nil {
			return "", err
		}
		if n == 0 {
			return "", io.EOF
		}
		b := buf[0]
		if len(seq) > 0 {
			seq = append(seq, b)
			if len(seq) == 2 && b != '[' && b != 'O' {
				seq = nil
				continue
			}
			if len(seq) == 2 {
				continue
			}
			if len(seq) > 128 {
				seq = nil
				continue
			}
			if b < 0x40 || b > 0x7e {
				continue
			}
			code, mods, event, ok := encodedKey(seq)
			seq = nil
			if !ok || mods != 1 || event == 3 {
				continue
			}
			if code > 127 {
				line = utf8.AppendRune(line, rune(code))
				continue
			}
			b = byte(code)
		}
		if b == 0x1b {
			seq = []byte{b}
			continue
		}
		if b == 3 || b == 4 {
			return "", errDetach
		}
		if b == '\r' || b == '\n' {
			return string(line), nil
		}
		if b == 8 || b == 127 {
			if len(line) > 0 {
				_, size := utf8.DecodeLastRune(line)
				line = line[:len(line)-size]
			}
			continue
		}
		line = append(line, b)
	}
	return "", io.ErrShortBuffer
}
