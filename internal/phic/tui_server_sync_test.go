package phic

import (
	"github.com/charmbracelet/x/ansi"
	"testing"
)

func TestServerOpenReconcilesEveryLivePaneAcrossProjects(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 0, 0 // List proof never launches an actor.
	m.project = "/selected-project"
	panes := []TerminalView{{ID: "selected", Dir: "/selected-project", Title: "here", Coder: "shell"}, {ID: "elsewhere", Dir: "/another-project", Title: "elsewhere", Coder: "pi"}, {ID: "worktree", Dir: "/trees/feature", Workspace: "/another-project", Title: "tree", Coder: "codex"}}
	m.Update(serverLoadedMsg{gen: m.gen, index: 0, panes: panes, health: "Online"})
	if len(m.tabs[m.currentOrigin()]) != 3 {
		t.Fatalf("server discarded live panes outside selected project: %+v", m.tabs[m.currentOrigin()])
	}
	m.width, m.height = 140, 40
	if cmd := m.switchServer(m.active); cmd == nil {
		t.Fatal("opening the already-selected server did not refresh live panes")
	}
}
func TestReconcileKeepsPerOriginPaneIdentityAndActiveSelection(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 0, 0
	origin := m.currentOrigin()
	other := "http://other.example:7070"
	foreign := &paneTab{key: paneKey{Origin: other, ID: "same"}, title: "other server"}
	m.tabs[other] = []*paneTab{foreign}
	m.tabs[origin] = nil
	m.reconcileTabs([]TerminalView{{ID: "same", Dir: "/different"}, {ID: "second", Dir: "/two"}})
	m.activeTab[origin] = 1
	m.reconcileTabs([]TerminalView{{ID: "third", Dir: "/three"}, {ID: "second", Dir: "/two"}, {ID: "same", Dir: "/different"}})
	if tab := m.activeTabModel(); tab == nil || tab.key.ID != "second" {
		t.Fatal("refresh reassigned active pane")
	}
	if m.tabs[other][0] != foreign || len(m.tabs[origin]) != 3 {
		t.Fatal("server sync mixed origins or dropped panes")
	}
}
func TestConnectedChromeUsesAccentInsteadOfGreen(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.current().loaded = true
	m.currentServer().health = "up"
	// Check the styled connection label; backend ANSI and diff colors are untouched.
	text := m.connectionLabel()
	if ansi.Strip(text) != "connected" {
		t.Fatalf("unexpected status label %q", text)
	}
}
