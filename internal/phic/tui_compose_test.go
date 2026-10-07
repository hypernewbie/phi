package phic

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestComposePayload(t *testing.T) {
	// Mirrors web sendStagedInput: plain short payloads go raw + CR.
	if got := composePayload("shell", "hi"); got != "hi\r" {
		t.Fatalf("short payload = %q", got)
	}
	if got := composePayload("shell", "1234567890123456"); got != "1234567890123456\r" {
		t.Fatalf("16 chars = %q", got)
	}
	// Long, multiline, and codex payloads travel bracketed.
	for name, tc := range map[string]struct {
		coder, text string
	}{
		"long":      {"shell", "12345678901234567"},
		"multiline": {"shell", "a\nb"},
		"codex":     {"codex", "hi"},
	} {
		got := composePayload(tc.coder, tc.text)
		if !strings.HasPrefix(got, "\x1b[200~") || !strings.HasSuffix(got, "\x1b[201~\r") {
			t.Fatalf("%s payload = %q", name, got)
		}
		if !strings.Contains(got, tc.text) {
			t.Fatalf("%s payload lost text: %q", name, got)
		}
	}
}

func composeKey(code rune, text string) tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: code, Text: text}
}

func TestComposeSendFlow(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	tab, _ := fx.attachTab(t, m, "compose-pane", "shell", "")
	if cmd := m.openCompose(); cmd == nil {
		t.Fatal("open produced no focus command")
	}
	if !m.compose.open || m.compose.area == nil {
		t.Fatal("compose box did not open")
	}
	for _, r := range "hello" {
		m.handleComposeKey(composeKey(r, string(r)))
	}
	if got := m.compose.area.Value(); got != "hello" {
		t.Fatalf("staged value = %q", got)
	}
	m.handleComposeKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	select {
	case got := <-fx.inputs:
		if got.input != "hello\r" {
			t.Fatalf("sent %+q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("compose send delivered nothing")
	}
	if m.compose.open {
		t.Fatal("compose box stayed open after send")
	}
	if tab.composeDraft != "" {
		t.Fatalf("draft not cleared after send: %q", tab.composeDraft)
	}
}

func TestComposeMultilineAndDraft(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	tab, _ := fx.attachTab(t, m, "compose-pane", "shell", "")
	m.openCompose()
	for _, r := range "one" {
		m.handleComposeKey(composeKey(r, string(r)))
	}
	// Alt+Enter stages a newline instead of sending.
	m.handleComposeKey(tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt})
	for _, r := range "two" {
		m.handleComposeKey(composeKey(r, string(r)))
	}
	if got := m.compose.area.Value(); got != "one\ntwo" {
		t.Fatalf("staged value = %q", got)
	}
	// Esc keeps the draft; reopening restores it.
	m.handleComposeKey(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.compose.open {
		t.Fatal("esc did not close the box")
	}
	if tab.composeDraft != "one\ntwo" {
		t.Fatalf("draft = %q", tab.composeDraft)
	}
	select {
	case got := <-fx.inputs:
		t.Fatalf("esc leaked bytes: %+q", got)
	case <-time.After(300 * time.Millisecond):
	}
	m.openCompose()
	if got := m.compose.area.Value(); got != "one\ntwo" {
		t.Fatalf("restored draft = %q", got)
	}
	// Multiline sends bracketed, like the web.
	m.handleComposeKey(tea.KeyPressMsg{Code: tea.KeyEnter})
	select {
	case got := <-fx.inputs:
		if got.input != "\x1b[200~one\ntwo\x1b[201~\r" {
			t.Fatalf("multiline sent %+q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("multiline send delivered nothing")
	}
}

func TestComposeBoxRendersAtBottom(t *testing.T) {
	fx := newScrollFixture(t)
	m := newModelWithServer(t, fx.srv)
	defer m.closeAll()
	m.project = "/work"
	m.width, m.height = 100, 30
	fx.attachTab(t, m, "compose-pane", "shell", "")
	m.openCompose()
	for _, r := range "staged hello" {
		m.handleComposeKey(composeKey(r, string(r)))
	}
	box, bx, by := m.composeBox()
	if box == "" {
		t.Fatal("no compose box rendered")
	}
	plain := ansi.Strip(box)
	if !strings.Contains(plain, "staged hello") || !strings.Contains(plain, "Enter send") {
		t.Fatalf("box missing content: %q", plain)
	}
	r := m.terminalRect()
	if by+len(strings.Split(box, "\n")) > r.Y+r.H+1 {
		t.Fatal("box overflows the terminal panel")
	}
	if bx < r.X {
		t.Fatal("box starts left of the terminal panel")
	}
	full := ansi.Strip(m.render())
	if !strings.Contains(full, "staged hello") {
		t.Fatal("composed text missing from full render")
	}
}
