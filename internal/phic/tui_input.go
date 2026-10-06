package phic

import (
	"strings"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// teaMods converts Bubble Tea modifiers to the adapter bit-set.
func teaMods(mod tea.KeyMod) termemu.Modifier {
	var out termemu.Modifier
	if mod.Contains(tea.ModShift) {
		out |= termemu.ModShift
	}
	if mod.Contains(tea.ModCtrl) {
		out |= termemu.ModCtrl
	}
	if mod.Contains(tea.ModAlt) {
		out |= termemu.ModAlt
	}
	if mod.Contains(tea.ModSuper) {
		out |= termemu.ModSuper
	}
	return out
}

func firstRune(values ...rune) rune {
	for _, r := range values {
		if r != 0 {
			return r
		}
	}
	return 0
}

func firstTextRune(s string) rune {
	for _, r := range s {
		return r
	}
	return 0
}

// teaKeyEvent translates a Bubble Tea key into an adapter key event. The
// returned bool is false for keys the backend should not receive (for
// example an unidentified key with no text).
func teaKeyEvent(k tea.Key, action termemu.KeyAction) (termemu.KeyEvent, bool) {
	ev := termemu.KeyEvent{Action: action, Mods: teaMods(k.Mod)}
	printable := false
	switch k.Code {
	case tea.KeyEnter:
		ev.Key = termemu.KeyEnter
	case tea.KeyEscape:
		ev.Key = termemu.KeyEscape
	case tea.KeyBackspace:
		ev.Key = termemu.KeyBackspace
	case tea.KeyTab:
		ev.Key = termemu.KeyTab
	case tea.KeyDelete:
		ev.Key = termemu.KeyDelete
	case tea.KeyInsert:
		ev.Key = termemu.KeyInsert
	case tea.KeyHome:
		ev.Key = termemu.KeyHome
	case tea.KeyEnd:
		ev.Key = termemu.KeyEnd
	case tea.KeyPgUp:
		ev.Key = termemu.KeyPageUp
	case tea.KeyPgDown:
		ev.Key = termemu.KeyPageDown
	case tea.KeyUp:
		ev.Key = termemu.KeyArrowUp
	case tea.KeyDown:
		ev.Key = termemu.KeyArrowDown
	case tea.KeyLeft:
		ev.Key = termemu.KeyArrowLeft
	case tea.KeyRight:
		ev.Key = termemu.KeyArrowRight
	case tea.KeyF1:
		ev.Key = termemu.KeyF1
	case tea.KeyF2:
		ev.Key = termemu.KeyF2
	case tea.KeyF3:
		ev.Key = termemu.KeyF3
	case tea.KeyF4:
		ev.Key = termemu.KeyF4
	case tea.KeyF5:
		ev.Key = termemu.KeyF5
	case tea.KeyF6:
		ev.Key = termemu.KeyF6
	case tea.KeyF7:
		ev.Key = termemu.KeyF7
	case tea.KeyF8:
		ev.Key = termemu.KeyF8
	case tea.KeyF9:
		ev.Key = termemu.KeyF9
	case tea.KeyF10:
		ev.Key = termemu.KeyF10
	case tea.KeyF11:
		ev.Key = termemu.KeyF11
	case tea.KeyF12:
		ev.Key = termemu.KeyF12
	case tea.KeySpace:
		ev.Key = termemu.KeySpace
		printable = true
		if k.Text == "" {
			ev.Text = " "
		} else {
			ev.Text = k.Text
		}
	default:
		ev.Key = termemu.KeyRune
		switch {
		case k.Text != "":
			ev.Text = k.Text
			printable = true
		case k.Code >= 0x20 && unicode.IsPrint(k.Code):
			ev.Text = string(k.Code)
			printable = true
		case k.Code > 0 && k.Code < 0x20:
			// A control byte means Ctrl-<letter> in terminals without
			// enhanced disambiguation. Reconstruct the logical key so the
			// emulator can encode it for the backend's current protocol.
			if ev.Mods&termemu.ModCtrl == 0 {
				ev.Mods |= termemu.ModCtrl
			}
			ev.Text = string(rune('a' + k.Code - 1))
			ev.Unshifted = firstTextRune(ev.Text)
			return ev, true
		default:
			return ev, false
		}
	}
	if !printable {
		// Special keys have no unshifted codepoint for alternate-key
		// reporting; leaving it zero keeps the adapter from inventing one.
		return ev, true
	}
	if ev.Unshifted == 0 {
		ev.Unshifted = firstRune(k.ShiftedCode, k.BaseCode)
		if ev.Unshifted == 0 && ev.Text != "" {
			ev.Unshifted = firstTextRune(ev.Text)
		}
		if ev.Unshifted == 0 {
			ev.Unshifted = firstRune(k.Code)
		}
	}
	return ev, true
}

// splitLines keeps blank lines and trailing whitespace so diff text stays
// faithful to the server's output.
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}
