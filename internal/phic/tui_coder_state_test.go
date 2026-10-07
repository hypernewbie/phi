package phic

import "testing"

func coderStateModel(t *testing.T, store *desktopStore) *tuiModel {
	t.Helper()
	servers := []*serverState{
		{profile: desktopProfile{ID: "one", Origin: "http://one:7070"}, api: mustAPI(t, "http://one:7070")},
		{profile: desktopProfile{ID: "two", Origin: "http://two:7070"}, api: mustAPI(t, "http://two:7070")},
	}
	m := newTUIModel("test", config{}, store, servers, 0, stubBuild)
	m.width, m.height = 100, 30
	m.cliApplied = true
	for i := range servers {
		m.data[m.originFor(i)] = &serverData{loaded: true, coders: []CoderDescriptor{{ID: "opencode", Name: "OpenCode"}, {ID: "pi", Name: "Pi"}, {ID: "shell", Name: "Shell"}}}
	}
	return m
}

func TestCoderSurvivesServerRoundTripAndCatalogReorder(t *testing.T) {
	m := coderStateModel(t, nil)
	m.coderIdx = 1 // Pi on first server.
	m.switchServer(1)
	if m.selectedCoderID() != "opencode" {
		t.Fatal("fresh server did not use its own default")
	}
	m.coderIdx = 2 // Shell on second server.
	m.switchServer(0)
	if m.selectedCoderID() != "pi" {
		t.Fatal("switch back reset first server's coder")
	}
	d := m.current()
	reordered := []CoderDescriptor{d.coders[2], d.coders[0], d.coders[1]}
	m.applyServerLoaded(serverLoadedMsg{gen: m.gen, index: m.active, coders: reordered})
	if m.selectedCoderID() != "pi" || m.coderIdx != 2 {
		t.Fatal("refresh restored a list index instead of coder ID")
	}
	m.switchServer(1)
	if m.selectedCoderID() != "shell" {
		t.Fatal("second server lost its independent coder")
	}
}

func TestCoderPickerPersistsAndRelaunchRestores(t *testing.T) {
	store := &desktopStore{path: t.TempDir() + "/profiles.json"}
	m := coderStateModel(t, store)
	m.focus = focusSessions
	m.openCoderModal()
	m.modal.cursor = 1
	_, cmd := m.submitModal()
	if m.current().coderID != "pi" || m.focus != focusSessions {
		t.Fatal("picker did not remember coder or kept focus incorrectly")
	}
	// No project selected, so this command is only the UI-state save.
	if cmd == nil {
		t.Fatal("selection was not persisted")
	}
	if result := cmd(); result != nil {
		t.Fatalf("save failed: %#v", result)
	}
	ui, err := store.readUI()
	if err != nil || ui.Servers["one"].Coder != "pi" {
		t.Fatalf("saved coder missing: %+v %v", ui, err)
	}
	relaunched := coderStateModel(t, store)
	d := relaunched.current()
	relaunched.applyServerLoaded(serverLoadedMsg{gen: relaunched.gen, index: 0, coders: []CoderDescriptor{d.coders[2], d.coders[0], d.coders[1]}})
	if relaunched.selectedCoderID() != "pi" {
		t.Fatal("relaunch lost saved coder")
	}
}

func TestCoderRestoreFallbackAndOriginIsolation(t *testing.T) {
	for _, tc := range []struct{ remembered, stored, origin, want string }{
		{"pi", "shell", "http://one:7070", "pi"},
		{"removed", "shell", "http://one:7070", "opencode"},
		{"", "shell", "http://one:7070", "shell"},
		{"", "shell", "http://different:7070", "opencode"},
		{"", "", "http://one:7070", "opencode"},
	} {
		m := coderStateModel(t, nil)
		m.uiIntent = &uiIntent{Version: 1, Servers: map[string]uiServerIntent{"one": {Origin: tc.origin, Coder: tc.stored}}}
		m.current().coderID = tc.remembered
		m.restoreCoderSelection()
		if m.selectedCoderID() != tc.want {
			t.Fatalf("%+v: selected %q", tc, m.selectedCoderID())
		}
	}
}
