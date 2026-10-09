package phic

import (
	"testing"
)

func TestTabSwitchSyncsProjectCoderWorktree(t *testing.T) {
	m := coderStateModel(t, nil)
	origin := m.currentOrigin()
	m.project = "/work/a"
	m.worktree = ""
	m.coderIdx = 0 // opencode
	// Tab B lives in another workspace, worktree, and coder.
	tabB := &paneTab{
		key:   paneKey{Origin: origin, ID: "b"},
		coder: "pi",
		dir:   "/work/b/feature",
		view:  TerminalView{ID: "b", Coder: "pi", Dir: "/work/b/feature", Workspace: "/work/b"},
	}
	m.tabs[origin] = append(m.tabs[origin], tabB)
	if !m.activateTab(origin, tabB) {
		t.Fatal("tab switch did not report a context change")
	}
	if m.project != "/work/b" || m.worktree != "/work/b/feature" || m.selectedCoderID() != "pi" {
		t.Fatalf("context not synced: project=%q worktree=%q coder=%q", m.project, m.worktree, m.selectedCoderID())
	}
	if m.contextDir() != "/work/b/feature" {
		t.Fatalf("effective dir = %q, want worktree", m.contextDir())
	}
	// Switching to a tab with the same context reports no change.
	if m.activateTab(origin, tabB) {
		t.Fatal("same-context switch reported a change")
	}
	// Back to a workspace-root tab clears the worktree.
	tabA := &paneTab{
		key:   paneKey{Origin: origin, ID: "a"},
		coder: "opencode",
		dir:   "/work/a",
		view:  TerminalView{ID: "a", Coder: "opencode", Dir: "/work/a", Workspace: "/work/a"},
	}
	m.tabs[origin] = append(m.tabs[origin], tabA)
	if !m.activateTab(origin, tabA) {
		t.Fatal("return switch did not report a change")
	}
	if m.project != "/work/a" || m.worktree != "" || m.selectedCoderID() != "opencode" {
		t.Fatalf("return context wrong: project=%q worktree=%q coder=%q", m.project, m.worktree, m.selectedCoderID())
	}
}

func TestWorktreeSelectionDrivesSessionsDiffMarkdown(t *testing.T) {
	m := coderStateModel(t, nil)
	m.project = "/work"
	m.worktree = ""
	m.coderIdx = 0
	if got := m.contextDir(); got != "/work" {
		t.Fatalf("default dir = %q", got)
	}
	m.worktree = "/work/feature"
	if got := m.contextDir(); got != "/work/feature" {
		t.Fatalf("worktree dir = %q", got)
	}
	if got := m.markdownDir(); got != "/work/feature" {
		t.Fatalf("markdown dir = %q", got)
	}
	// Sessions and diff follow the worktree, not the workspace root.
	d := m.current()
	d.sessionsCoder, d.sessionsDir = "opencode", "/work"
	if cmd := m.refreshSessions(); cmd == nil {
		t.Fatal("worktree change did not trigger a sessions refresh")
	} else {
		msg := cmd().(sessionsLoadedMsg)
		if msg.dir != "/work/feature" {
			t.Fatalf("sessions requested %q", msg.dir)
		}
	}
	m.diff.open = true
	if cmd := m.refreshDiff(); cmd == nil {
		t.Fatal("worktree change did not trigger a diff refresh")
	} else {
		msg := cmd().(diffLoadedMsg)
		if msg.project != "/work/feature" {
			t.Fatalf("diff requested %q", msg.project)
		}
	}
}

func TestSidebarLivePanesFilterByWorkspace(t *testing.T) {
	m := coderStateModel(t, nil)
	m.project = "/work/a"
	d := m.current()
	d.panes = []TerminalView{
		{ID: "a1", Coder: "shell", Dir: "/work/a/feature", Workspace: "/work/a"},
		{ID: "b1", Coder: "shell", Dir: "/work/b", Workspace: "/work/b"},
		{ID: "legacy", Coder: "shell", Dir: "/work/a"},
	}
	rows := m.sidebarRows()
	seen := map[string]bool{}
	for _, r := range rows {
		if r.kind == rowLivePane {
			seen[r.pane.ID] = true
		}
	}
	if !seen["a1"] || !seen["legacy"] || seen["b1"] {
		t.Fatalf("workspace filter wrong: %v", seen)
	}
}
