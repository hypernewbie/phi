package phic

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
)

var errDetach = errors.New("detach")

// viewCommand transfers ownership to the client controller after relay workers
// have stopped. It is never an instruction to paint from the input goroutine.
type viewCommand byte

func (v viewCommand) Error() string { return "phic: client view " + string(byte(v)) }

// inputParser recognizes only client keys and paste boundaries. Application
// sequences stay opaque. A lone Escape is flushed by the caller's short timer.
type inputParser struct {
	sequence      []byte
	prefix        []byte
	prefixRelease []byte
	paste         bool
	mouse         int
	rest          []byte
	servers       int
	claimed       map[[2]int]bool
}

func (p *inputParser) Feed(data []byte) ([]byte, error) {
	var out []byte
	for i, b := range data {
		if p.mouse > 0 {
			out = append(out, b)
			p.mouse--
			continue
		}
		if len(p.sequence) > 0 {
			p.sequence = append(p.sequence, b)
			if len(p.sequence) == 2 && b != '[' {
				out = append(out, p.forwardPrefix()...)
				out = append(out, p.sequence...)
				p.sequence = nil
				continue
			}
			if len(p.sequence) == 2 {
				continue
			}
			if (b >= 0x40 && b <= 0x7e) || len(p.sequence) >= 128 {
				seq := p.sequence
				p.sequence = nil
				send, err := p.key(seq)
				out = append(out, send...)
				if err != nil {
					p.rest = append([]byte{}, data[i+1:]...)
					return out, err
				}
			}
			continue
		}
		if b == 0x1b {
			p.sequence = []byte{b}
			continue
		}
		send, err := p.key([]byte{b})
		out = append(out, send...)
		if err != nil {
			p.rest = append([]byte{}, data[i+1:]...)
			return out, err
		}
	}
	return out, nil
}
func (p *inputParser) FlushEscape() []byte {
	if len(p.prefix) > 0 && bytes.Equal(p.sequence, []byte{0x1b}) {
		p.prefix = nil
		p.prefixRelease = nil
		p.sequence = nil
		return nil
	}
	out := append(p.forwardPrefix(), p.sequence...)
	p.sequence = nil
	return out
}
func (p *inputParser) forwardPrefix() []byte {
	out := append(append([]byte{}, p.prefix...), p.prefixRelease...)
	if len(p.prefix) > 0 {
		delete(p.claimed, [2]int{93, 5})
	}
	p.prefix = nil
	p.prefixRelease = nil
	return out
}

func (p *inputParser) key(seq []byte) ([]byte, error) {
	if !p.paste && bytes.Equal(seq, []byte("\x1b[M")) {
		p.mouse = 3 // X10: button and two coordinates are opaque bytes.
		return append(p.forwardPrefix(), seq...), nil
	}
	if bytes.Equal(seq, []byte("\x1b[200~")) {
		out := append(p.forwardPrefix(), seq...)
		p.paste = true
		return out, nil
	}
	if p.paste {
		if bytes.Equal(seq, []byte("\x1b[201~")) {
			p.paste = false
		}
		return seq, nil
	}
	code, mods, event, ok := encodedKey(seq)
	identity := [2]int{code, mods}
	if ok && p.claimed[identity] {
		if event == 3 {
			if code == 93 && mods == 5 && len(p.prefix) > 0 {
				p.prefixRelease = append(p.prefixRelease, seq...)
			}
			delete(p.claimed, identity)
			return nil, nil
		}
		if event == 2 {
			return nil, nil
		}
	}
	claim := func() {
		if ok {
			if p.claimed == nil {
				p.claimed = make(map[[2]int]bool)
			}
			p.claimed[identity] = true
		}
	}
	// Ctrl-digits are distinguishable only under an enhanced keyboard
	// encoding. Never infer a server shortcut from legacy/plain digits.
	if ok && event == 1 && mods == 5 && code >= '1' && code <= '9' && code-'0' <= p.servers {
		claim()
		p.prefix = nil
		p.prefixRelease = nil
		return nil, viewCommand(byte(code))
	}
	prefix := bytes.Equal(seq, []byte{0x1d}) || (ok && code == 93 && mods == 5 && event != 3)
	if prefix {
		if len(p.prefix) != 0 {
			hadRelease := len(p.prefixRelease) > 0
			out := p.forwardPrefix()
			if hadRelease {
				claim()
			} // the second key belongs to the client
			return out, nil
		}
		claim()
		p.prefix = append([]byte{}, seq...)
		return nil, nil
	}
	// Do not release a prefix key whose press was consumed by the client.
	if len(p.prefix) != 0 && ok && code == 93 && mods == 5 && event == 3 {
		return nil, nil
	}
	if len(p.prefix) == 0 {
		return seq, nil
	}
	command := byte(0)
	if len(seq) == 1 {
		command = seq[0]
	}
	if ok && mods == 1 && event != 3 && code < 128 {
		command = byte(code)
	}
	switch command {
	case 'q':
		claim()
		p.prefix = nil
		p.prefixRelease = nil
		return nil, errDetach
	case 's', 'd', 'w', '?', 'b', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		claim()
		p.prefix = nil
		p.prefixRelease = nil
		return nil, viewCommand(command)
	}
	if bytes.Equal(seq, []byte{0x1b}) {
		p.prefix = nil
		p.prefixRelease = nil
		return nil, nil
	}
	out := append(p.forwardPrefix(), seq...)
	return out, nil
}

func encodedKey(seq []byte) (code, mods, event int, ok bool) {
	s := string(seq)
	if !strings.HasPrefix(s, "\x1b[") || len(s) < 4 {
		return
	}
	if strings.HasSuffix(s, "~") {
		fields := strings.Split(s[2:len(s)-1], ";")
		if len(fields) != 3 || fields[0] != "27" {
			return
		}
		code, _ = strconv.Atoi(fields[2])
		mods, _ = strconv.Atoi(fields[1])
		event = 1
		ok = code > 0 && mods > 0
		return
	}
	if !strings.HasSuffix(s, "u") {
		return
	}
	fields := strings.Split(s[2:len(s)-1], ";")
	if len(fields) > 3 {
		return
	}
	// Kitty flag 4 appends shifted/base-layout identities to the primary
	// codepoint. They are not separate keys. Associated text (flag 32) is
	// likewise not a command; the primary key remains authoritative.
	identities := strings.Split(fields[0], ":")
	if len(identities) > 3 || !validCodepoints(identities, true) {
		return 0, 0, 0, false
	}
	if len(fields) == 3 && !validCodepoints(strings.Split(fields[2], ":"), false) {
		return 0, 0, 0, false
	}
	code, err := strconv.Atoi(identities[0])
	if err != nil {
		return 0, 0, 0, false
	}
	mods, event = 1, 1
	if len(fields) >= 2 && fields[1] != "" {
		part := strings.Split(fields[1], ":")
		if len(part) > 2 {
			return 0, 0, 0, false
		}
		mods, err = strconv.Atoi(part[0])
		if err != nil {
			return 0, 0, 0, false
		}
		if len(part) == 2 {
			event, err = strconv.Atoi(part[1])
			if err != nil {
				return 0, 0, 0, false
			}
		}
	}
	if mods < 1 || mods > 256 {
		return 0, 0, 0, false
	}
	// Caps/Num Lock are state bits, not extra shortcut modifiers.
	mods = ((mods - 1) &^ (64 | 128)) + 1
	return code, mods, event, code > 0 && event >= 1 && event <= 3
}

func validCodepoints(parts []string, optionalAlternates bool) bool {
	for i, part := range parts {
		if optionalAlternates && i > 0 && part == "" {
			continue
		}
		n, err := strconv.ParseUint(part, 10, 32)
		if err != nil || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) {
			return false
		}
	}
	return len(parts) > 0
}
