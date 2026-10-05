package phic

import (
	"bytes"
	"errors"
	"testing"
)

func TestInputAllPacketSplits(t *testing.T) {
	for _, tc := range []struct {
		name, in, want string
		err            error
	}{
		{"ordinary binary/Unicode", "\x00\xff\r\n界\x1b[A", "\x00\xff\r\n界\x1b[A", nil},
		{"legacy detach", "\x1dq", "", errDetach},
		{"kitty detach", "\x1b[93;5:1u\x1b[93;5:3u\x1b[113;1:1u", "", errDetach},
		{"kitty alternate keys", "\x1b[93:125:93;5u\x1b[113:81:113;1u", "", errDetach},
		{"kitty omitted shifted key", "\x1b[93::93;5u\x1b[113::113;1u", "", errDetach},
		{"kitty associated text", "\x1b[93;5u\x1b[113;1;113u", "", errDetach},
		{"kitty lock modifiers", "\x1b[93;197u\x1b[113;193u", "", errDetach},
		{"kitty ordinary alternate keys untouched", "\x1b[97:65:97;2;65u", "\x1b[97:65:97;2;65u", nil},
		{"modifyOtherKeys detach", "\x1b[27;5;93~q", "", errDetach},
		{"literal legacy prefix", "\x1d\x1d", "\x1d", nil},
		{"literal enhanced prefix", "\x1b[93;5u\x1b[93;5u", "\x1b[93;5u", nil},
		{"literal enhanced prefix preserves one press/release pair", "\x1b[93;5:1u\x1b[93;5:3u\x1b[93;5:1u\x1b[93;5:3u", "\x1b[93;5:1u\x1b[93;5:3u", nil},
		{"unknown command", "\x1dz", "\x1dz", nil},
		{"unknown enhanced command preserves prefix release", "\x1b[93;5:1u\x1b[93;5:3u\x1b[122;1u", "\x1b[93;5:1u\x1b[93;5:3u\x1b[122;1u", nil},
		{"unknown enhanced command with late release", "\x1b[93;5:1u\x1b[122;1u\x1b[93;5:3u", "\x1b[93;5:1u\x1b[122;1u\x1b[93;5:3u", nil},
		{"paste is never a command", "\x1b[200~hello \x1dq\x1b[201~", "\x1b[200~hello \x1dq\x1b[201~", nil},
		{"session view handoff", "\x1ds", "", viewCommand('s')},
		{"diff view handoff", "\x1dd", "", viewCommand('d')},
		{"worktree view handoff", "\x1dw", "", viewCommand('w')},
		{"help view handoff", "\x1d?", "", viewCommand('?')},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for cut := 0; cut <= len(tc.in); cut++ {
				p := inputParser{}
				first, e1 := p.Feed([]byte(tc.in[:cut]))
				var second []byte
				err := e1
				if e1 == nil {
					second, err = p.Feed([]byte(tc.in[cut:]))
				}
				out := append(first, second...)
				if !bytes.Equal(out, []byte(tc.want)) || !errors.Is(err, tc.err) {
					t.Fatalf("split %d: output %q error %v", cut, out, err)
				}
			}
		})
	}
}
func TestServerShortcutsAcrossHandoffsAndEveryPacketSplit(t *testing.T) {
	for _, tc := range []struct {
		source, want string
		request      viewCommand
	}{
		{"a\x1b[49;5u\x1b[49;5:2u\x1b[49;5:3uZ", "aZ", viewCommand('1')},
		{"a\x1b[27;5;50~Z", "aZ", viewCommand('2')},
		{"a\x1d3Z", "aZ", viewCommand('3')},
		{"123\x11\x00", "123\x11\x00", 0},
		{"\x1b[200~\x1b[49;5u\x1d1\x1b[201~", "\x1b[200~\x1b[49;5u\x1d1\x1b[201~", 0},
	} {
		for split := 0; split <= len(tc.source); split++ {
			p := inputParser{servers: 3}
			var output []byte
			var commands []viewCommand
			for _, chunk := range [][]byte{[]byte(tc.source[:split]), []byte(tc.source[split:])} {
				for len(chunk) > 0 {
					out, err := p.Feed(chunk)
					output = append(output, out...)
					chunk = nil
					if err != nil {
						var command viewCommand
						if !errors.As(err, &command) {
							t.Fatal(err)
						}
						commands = append(commands, command)
						chunk = p.rest
						p.rest = nil
					}
				}
			}
			if string(output) != tc.want {
				t.Fatalf("split %d: %q want %q", split, output, tc.want)
			}
			if tc.request == 0 && len(commands) != 0 || tc.request != 0 && (len(commands) != 1 || commands[0] != tc.request) {
				t.Fatalf("split %d commands %v", split, commands)
			}
		}
	}
}

func TestEscapeTimeoutDoesNotLoseApplicationEscape(t *testing.T) {
	p := inputParser{}
	_, _ = p.Feed([]byte{0x1b})
	if got := p.FlushEscape(); !bytes.Equal(got, []byte{0x1b}) {
		t.Fatalf("lost escape: %q", got)
	}
	_, _ = p.Feed([]byte{0x1d, 0x1b})
	if got := p.FlushEscape(); len(got) != 0 {
		t.Fatalf("prefix cancel leaked: %q", got)
	}
}
func TestHistoricalQueryGuardAcrossEverySplit(t *testing.T) {
	for _, source := range []string{"\x1b[6n", "\x1b[c", "\x1b[?2004$p", "\x1b]11;?\a", "\x1bP+q544e\x1b\\", "\x1bP$qm\x1b\\", "\x1b[?u"} {
		for cut := 0; cut <= len(source); cut++ {
			g := queryGuard{}
			found := g.Feed([]byte(source[:cut]))
			if !found {
				found = g.Feed([]byte(source[cut:]))
			}
			if !found {
				t.Fatalf("query not caught at split %d: %q", cut, source)
			}
		}
	}
	for _, source := range []string{"plain Ûcoder 🐙 界", "\x1b[31mred\x1b[0m", "\x1b]0;title?\a"} {
		g := queryGuard{}
		for _, b := range []byte(source) {
			if g.Feed([]byte{b}) {
				t.Fatalf("ordinary output rejected: %q", source)
			}
		}
	}
}
