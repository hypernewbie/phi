package phic

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
)

var errDetach = errors.New("detach")
var errLiveView = errors.New("live views are disabled: screen restoration has not been proved; detach and use startup selection or --diff")

// inputParser recognizes only client keys and paste boundaries. Application
// sequences stay opaque. A lone Escape is flushed by the caller's short timer.
type inputParser struct {
	sequence []byte
	prefix   []byte
	paste    bool
}

func (p *inputParser) Feed(data []byte) ([]byte, error) {
	var out []byte
	for _, b := range data {
		if len(p.sequence) > 0 {
			p.sequence = append(p.sequence, b)
			if len(p.sequence) == 2 && b != '[' {
				out = append(out, p.prefix...)
				p.prefix = nil
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
			return out, err
		}
	}
	return out, nil
}
func (p *inputParser) FlushEscape() []byte {
	if len(p.prefix) > 0 && bytes.Equal(p.sequence, []byte{0x1b}) {
		p.prefix = nil
		p.sequence = nil
		return nil
	}
	out := append(append([]byte{}, p.prefix...), p.sequence...)
	p.prefix = nil
	p.sequence = nil
	return out
}
func (p *inputParser) key(seq []byte) ([]byte, error) {
	if bytes.Equal(seq, []byte("\x1b[200~")) {
		out := append(append([]byte{}, p.prefix...), seq...)
		p.prefix = nil
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
	prefix := bytes.Equal(seq, []byte{0x1d}) || (ok && code == 93 && mods == 5 && event != 3)
	if prefix {
		if len(p.prefix) != 0 {
			out := p.prefix
			p.prefix = nil
			return out, nil
		}
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
		p.prefix = nil
		return nil, errDetach
	case 's', 'd', 'w', '?':
		p.prefix = nil
		return nil, errLiveView
	}
	if bytes.Equal(seq, []byte{0x1b}) {
		p.prefix = nil
		return nil, nil
	}
	out := append(append([]byte{}, p.prefix...), seq...)
	p.prefix = nil
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
	if len(fields) > 2 {
		return
	}
	code, err := strconv.Atoi(fields[0])
	if err != nil {
		return 0, 0, 0, false
	}
	mods, event = 1, 1
	if len(fields) == 2 {
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
	return code, mods, event, code > 0 && mods > 0 && event >= 1 && event <= 3
}
