package phic

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// queryGuard classifies reply-producing controls and counts keyboard-stack
// operations. It is an escape lexer, not a screen model. Repaint uses its
// classification; TTY cleanup uses its keyboard callback.
type queryGuard struct {
	state    byte
	text     []byte
	question bool
	escape   bool
	pending  [4]byte
	n        int
	keyboard func(int)
}

func (g *queryGuard) Feed(data []byte) bool {
	for _, b := range data {
		if g.n == 0 && b < utf8.RuneSelf {
			if g.control(b) && g.keyboard == nil {
				return true
			}
			continue
		}
		g.pending[g.n] = b
		g.n++
		for g.n > 0 && utf8.FullRune(g.pending[:g.n]) {
			r, size := utf8.DecodeRune(g.pending[:g.n])
			copy(g.pending[:], g.pending[size:g.n])
			g.n -= size
			if r <= 255 && g.control(byte(r)) && g.keyboard == nil {
				return true
			}
		}
	}
	return false
}

func (g *queryGuard) control(b byte) bool {
	if b == 0x18 || b == 0x1a {
		g.state = 0
		g.text = nil
		g.escape = false
		return false
	}
	switch g.state {
	case 0:
		if b == 0x1b {
			g.state = 'e'
		}
		if b == 0x9b {
			g.state = 'c'
			g.text = nil
		}
		if b == 0x9d {
			g.state = 'o'
			g.text = nil
			g.question = false
		}
		if b == 0x90 {
			g.state = 'd'
			g.text = nil
			g.question = false
		}
	case 'e':
		g.text = nil
		g.question = false
		switch b {
		case '[':
			g.state = 'c'
		case ']':
			g.state = 'o'
		case 'P':
			g.state = 'd'
		default:
			g.state = 0
		}
	case 'c':
		if b >= 0x40 && b <= 0x7e {
			s := string(g.text)
			g.state = 0
			if b == 'u' && g.keyboard != nil && len(s) > 0 {
				if s[0] == '>' {
					g.keyboard(1)
				}
				if s[0] == '<' {
					n, err := strconv.Atoi(s[1:])
					if s == "<" {
						n = 1
						err = nil
					}
					if err == nil && n > 0 {
						g.keyboard(-n)
					}
				}
			}
			if b == 'c' || b == 'n' || b == 't' || (b == 'p' && strings.Contains(s, "$")) || (b == 'u' && strings.HasPrefix(s, "?")) || (b == 'q' && strings.HasPrefix(s, ">")) {
				return true
			}
		} else if len(g.text) < 128 {
			g.text = append(g.text, b)
		}
	case 'o', 'd':
		if b == '?' {
			g.question = true
		}
		ended := b == 0x9c || (g.escape && b == '\\') || (g.state == 'o' && b == 7)
		if ended {
			s := string(g.text)
			query := g.state == 'd' && (strings.HasPrefix(s, "+q") || strings.HasPrefix(s, "$q"))
			if g.state == 'o' && g.question {
				for _, prefix := range []string{"4;", "10;", "11;", "12;", "52;"} {
					query = query || strings.HasPrefix(s, prefix)
				}
			}
			g.state = 0
			g.text = nil
			g.escape = false
			if query {
				return true
			}
			return false
		}
		g.escape = b == 0x1b
		if len(g.text) < 128 {
			g.text = append(g.text, b)
		}
	}
	return false
}
