package termproof

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

const maxReplayInput = 64 << 10

var errReplayInputLimit = errors.New("phic: input during replay exceeds 64 KiB")

// This is an experimental reply policy, not a production compatibility gate.
// Legacy Shift-F3 and a CPR reply are indistinguishable, and asynchronous OSC
// replies can outlive a parser barrier. Tests must expose both limitations.
// replayInput separates terminal reports from user keys while reconstructing a
// screen. It has no cell model. An unknown private-mode request is a parser
// barrier: DECRQM echoes its random mode number without changing any setting.
// A completed write alone is not a barrier.
type replayInput struct {
	sequence []byte
	state    byte
	escaped  bool
	paste    bool
}

func newParserBarrier() (request, response []byte, err error) {
	var nonce [4]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, nil, err
	}
	// Six-digit unassigned private-mode space. Large enough to avoid every
	// real mode, small enough for parsers (older tmux) that cap CSI
	// parameters and silently drop larger values instead of echoing them.
	mode := 400000 + (binary.BigEndian.Uint32(nonce[:]) % 100000)
	return []byte(fmt.Sprintf("\x1b[?%d$p", mode)), []byte(fmt.Sprintf("\x1b[?%d;0$y", mode)), nil
}

// Feed returns only application keys. Report recognition never applies inside
// bracketed paste; escaped user data in a paste is not a terminal response.
func (p *replayInput) Feed(data, barrier []byte) (keys []byte, reached bool, err error) {
	for _, b := range data {
		if p.state == 0 {
			if b == 0x1b {
				p.sequence = []byte{b}
				p.state = 'e'
			} else {
				keys = append(keys, b)
			}
			continue
		}
		p.sequence = append(p.sequence, b)
		if len(p.sequence) > maxReplayInput {
			return keys, false, errReplayInputLimit
		}
		done := false
		switch p.state {
		case 'e':
			switch b {
			case '[':
				p.state = 'c'
			case ']':
				p.state = 'o'
			case 'P':
				p.state = 'd'
			default:
				done = true
			}
		case 'c':
			done = b >= 0x40 && b <= 0x7e
		case 'o', 'd':
			done = (p.escaped && b == '\\') || (p.state == 'o' && b == 7)
			p.escaped = b == 0x1b
		}
		if !done {
			continue
		}
		seq := p.sequence
		p.sequence = nil
		p.state = 0
		p.escaped = false
		if !p.paste && len(barrier) > 0 && bytes.Equal(seq, barrier) {
			reached = true
			continue
		}
		if bytes.Equal(seq, []byte("\x1b[200~")) {
			p.paste = true
			keys = append(keys, seq...)
			continue
		}
		if p.paste {
			if bytes.Equal(seq, []byte("\x1b[201~")) {
				p.paste = false
			}
			keys = append(keys, seq...)
			continue
		}
		if !terminalReport(seq) {
			keys = append(keys, seq...)
		}
	}
	return keys, reached, nil
}
func terminalReport(seq []byte) bool {
	s := string(seq)
	if strings.HasPrefix(s, "\x1b[") && len(s) > 3 {
		body := s[2 : len(s)-1]
		final := s[len(s)-1]
		if strings.HasPrefix(body, "?") && (final == 'c' || final == 'R' || final == 'u' || final == 'n') {
			return true
		}
		if (strings.HasPrefix(body, ">") || strings.HasPrefix(body, "=")) && final == 'c' {
			return true
		}
		if final == 'y' && strings.HasSuffix(body, "$") {
			return true
		}
		if final == 'R' { // unmodified CPR; CSI 1;2R is also legacy Shift-F3.
			return true
		}
		if final == 'n' && (body == "0" || body == "3") {
			return true
		}
		if final == 't' && (strings.HasPrefix(body, "4;") || strings.HasPrefix(body, "6;") || strings.HasPrefix(body, "8;") || strings.HasPrefix(body, "9;")) {
			return true
		}
	}
	if strings.HasPrefix(s, "\x1bP") {
		for _, prefix := range []string{"\x1bP0$r", "\x1bP1$r", "\x1bP0+r", "\x1bP1+r", "\x1bP>|"} {
			if strings.HasPrefix(s, prefix) {
				return true
			}
		}
	}
	if strings.HasPrefix(s, "\x1b]") {
		for _, prefix := range []string{"\x1b]4;", "\x1b]10;", "\x1b]11;", "\x1b]12;", "\x1b]52;"} {
			if strings.HasPrefix(s, prefix) {
				return true
			}
		}
	}
	return false
}
