package phic

import (
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// TestTeaKeyEventTranslation pins the UI-to-adapter key mapping for the keys
// the plan calls out: modified Enter, Ctrl-digit, arrows, and control bytes.
func TestTeaKeyEventTranslation(t *testing.T) {
	tests := []struct {
		name string
		key  tea.Key
		want termemu.KeyEvent
	}{
		{
			name: "plain rune",
			key:  tea.Key{Code: 'a', Text: "a", BaseCode: 'a'},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Text: "a", Unshifted: 'a'},
		},
		{
			name: "digit stays ordinary",
			key:  tea.Key{Code: '7', Text: "7", BaseCode: '7'},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Text: "7", Unshifted: '7'},
		},
		{
			name: "ctrl-c carries ctrl modifier",
			key:  tea.Key{Code: 'c', Mod: tea.ModCtrl, BaseCode: 'c'},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Mods: termemu.ModCtrl, Text: "c", Unshifted: 'c'},
		},
		{
			name: "ctrl-digit",
			key:  tea.Key{Code: '1', Mod: tea.ModCtrl, BaseCode: '1'},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Mods: termemu.ModCtrl, Text: "1", Unshifted: '1'},
		},
		{
			name: "shift-enter",
			key:  tea.Key{Code: tea.KeyEnter, Mod: tea.ModShift},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyEnter, Mods: termemu.ModShift},
		},
		{
			name: "arrow up",
			key:  tea.Key{Code: tea.KeyUp},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyArrowUp},
		},
		{
			name: "tab",
			key:  tea.Key{Code: tea.KeyTab},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyTab},
		},
		{
			name: "escape",
			key:  tea.Key{Code: tea.KeyEscape},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyEscape},
		},
		{
			name: "backspace",
			key:  tea.Key{Code: tea.KeyBackspace},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyBackspace},
		},
		{
			name: "control byte without enhanced disambiguation",
			key:  tea.Key{Code: 0x01},
			want: termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Mods: termemu.ModCtrl, Text: "a", Unshifted: 'a'},
		},
		{
			name: "release action",
			key:  tea.Key{Code: 'a', Text: "a", BaseCode: 'a'},
			// action is passed by the caller; checked separately below.
			want: termemu.KeyEvent{Action: termemu.KeyRelease, Key: termemu.KeyRune, Text: "a", Unshifted: 'a'},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			action := termemu.KeyPress
			if tc.want.Action == termemu.KeyRelease {
				action = termemu.KeyRelease
			}
			got, ok := teaKeyEvent(tc.key, action)
			if !ok {
				t.Fatal("key rejected")
			}
			if got != tc.want {
				t.Fatalf("event = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestTeaKeyEventRejectsUnidentified keeps junk out of the backend.
func TestTeaKeyEventRejectsUnidentified(t *testing.T) {
	if _, ok := teaKeyEvent(tea.Key{}, termemu.KeyPress); ok {
		t.Fatal("unidentified key accepted")
	}
}

// TestSplitLinesPreservesWhitespace guards the diff contract: trailing
// spaces, blank lines, and CRLF all survive the split.
func TestSplitLinesPreservesWhitespace(t *testing.T) {
	text := "a  \n\n\tb\r\nc"
	lines := splitLines(text)
	want := []string{"a  ", "", "\tb", "c"}
	if len(lines) != len(want) {
		t.Fatalf("lines = %q, want %q", lines, want)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}
