package phic

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestSidebarActionsDoNotFireInsideSearchOrPaste(t *testing.T) {
	for _, keys := range []string{"/rename\r", "\x1b[200~xr[]m\r\x1b[201~\r"} {
		v := &viewTerminal{input: bytes.NewReader([]byte(keys))}
		c := &client{}
		got, err := c.selectionViewWith(t.Context(), v, func() (int, int, error) { return 80, 20, nil }, "Servers", []string{"rename"}, nil, menuOptions{actions: []string{"r", "x", "[", "]", "m"}})
		if err != nil || got != 0 {
			t.Fatalf("search/paste became a management command: %d %v", got, err)
		}
	}
	v := &viewTerminal{input: bytes.NewReader([]byte("\x1b[Bx"))}
	_, err := (&client{}).selectionViewWith(t.Context(), v, func() (int, int, error) { return 40, 10, nil }, "Servers", []string{"a", "b"}, nil, menuOptions{actions: []string{"x"}})
	var action menuAction
	if !errors.As(err, &action) || action.key != "x" {
		t.Fatal("remove action unavailable")
	}
}

func TestTextFormsEditUnicodeValidateAndCannotSubmitPaste(t *testing.T) {
	v := &viewTerminal{input: bytes.NewReader([]byte("\x15\x1b[200~東京\r\x1b[201~\x7f京\r"))}
	value, err := (&client{}).textPromptView(t.Context(), v, func() (int, int, error) { return 40, 10, nil }, "Rename", "Name", "Old", 64, validateServerName)
	if err != nil || value != "東京" {
		t.Fatalf("wrong Unicode form edit: %q %v", value, err)
	}
	if !strings.Contains(v.output.String(), "╭─") || strings.Contains(v.output.String(), "\x1b[?1049h") {
		t.Fatal("form is not an inline card")
	}
}

func TestSharedRailEditsKeepActivePaneAndOriginJars(t *testing.T) {
	store := &desktopStore{path: filepath.Join(t.TempDir(), "profiles.json")}
	a, _ := store.add("http://same.example:7070/")
	b, _ := store.add("http://same.example:7071/")
	apiA, _ := newAPIClient(a.Origin)
	apiB, _ := newAPIClient(b.Origin)
	stateA := &serverState{profile: a, api: apiA}
	stateB := &serverState{profile: b, api: apiB}
	stateB.remember(SelectResult{PaneID: "same", Existing: &TerminalView{ID: "same", Dir: "/b"}})
	c := &client{store: store, servers: []*serverState{stateA, stateB}, serverIndex: 1, currentServer: stateB, api: apiB}
	if err := store.rename(b.ID, "Beta renamed"); err != nil {
		t.Fatal(err)
	}
	if err := store.reorder(b.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := c.reloadServerProfiles(); err != nil {
		t.Fatal(err)
	}
	if c.serverIndex != 0 || c.activeServer() != stateB || stateB.selection.PaneID != "same" || c.servers[1].api != apiA || stateB.profile.Name != "Beta renamed" {
		t.Fatal("edit changed authentication/pane ownership")
	}
	if err := store.remove(b.ID); err != nil {
		t.Fatal(err)
	}
	if err := c.reloadServerProfiles(); err != nil {
		t.Fatal(err)
	}
	if c.serverIndex != -1 || len(c.servers) != 1 || c.activeServer() != stateB || c.api != apiB {
		t.Fatal("removing active rail entry disposed its live pane")
	}
	if err := c.persistActiveProfile(); err != nil {
		t.Fatal(err)
	}
	saved, _ := readDesktopProfiles(store.path)
	if len(saved) != 1 || saved[0].ID != a.ID {
		t.Fatal("removed active profile resurrected")
	}
	if err := store.remove(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := c.reloadServerProfiles(); err != nil {
		t.Fatal(err)
	}
	if len(c.servers) != 0 || c.activeServer() != stateB {
		t.Fatal("empty shared rail lost the running attachment")
	}
}

func TestPrettyMenuRowsDoNotWrapNarrowUnicodeViews(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	for cols := 8; cols <= 80; cols++ {
		v := &viewTerminal{input: bytes.NewReader([]byte("\r"))}
		_, err := (&client{}).selectionView(t.Context(), v, func() (int, int, error) { return cols, 10, nil }, "東京 menu", []string{"server 東京 long metadata"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(v.output.String(), "\r\n") {
			if strings.Contains(line, "\x1b") {
				continue
			}
			if menuCells(line) >= cols {
				t.Fatalf("inline row wraps at %d columns: %q", cols, line)
			}
		}
	}
}
