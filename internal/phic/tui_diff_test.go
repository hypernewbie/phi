package phic

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestDiffPanelShowsOnlySelectableCommitList(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 150, 30
	m.project = "/work"
	m.diff.open = true
	m.diff.commits = []GitCommit{
		{Hash: "a1b2c3d", Subject: "first change"},
		{Hash: "b2c3d4e", Subject: "second change"},
	}
	panel := ansi.Strip(m.renderDiffPanel())
	if !strings.Contains(panel, "first change") || !strings.Contains(panel, "second change") {
		t.Fatalf("commit list missing from panel: %q", panel)
	}
	if strings.Contains(panel, "diff --git") || strings.Contains(panel, "@@") {
		t.Fatalf("patch content leaked into the commit list: %q", panel)
	}
}

func TestCommitListWindowTracksSelection(t *testing.T) {
	d := diffState{commits: make([]GitCommit, 8), cursor: 7}
	if got := d.commitListStart(3); got != 5 {
		t.Fatalf("visible commit window starts at %d, want 5", got)
	}
	d.cursor = 0
	if got := d.commitListStart(3); got != 0 {
		t.Fatalf("top commit window starts at %d, want 0", got)
	}
}

func TestClickingCommitOpensPrettyDiffAndSelector(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 150, 30
	m.project = "/work"
	m.diff.open = true
	m.diff.commits = []GitCommit{
		{Hash: "a1b2c3d", Subject: "first change"},
		{Hash: "b2c3d4e", Subject: "second change"},
	}
	r := m.diffRect()
	_, cmd := m.handleReaderClick(r.X+2, r.Y+4) // second row
	if cmd == nil || m.modal.kind != modalDiff || m.diff.selectedCommit != "b2c3d4e" {
		t.Fatalf("commit click did not open its diff: modal=%v commit=%q", m.modal.kind, m.diff.selectedCommit)
	}
	m.Update(tea.MouseClickMsg{X: 4, Y: 2, Button: tea.MouseLeft})
	if m.modal.kind != modalDiffSelect {
		t.Fatalf("commit selector click opened modal %v", m.modal.kind)
	}
	m.modal.cursor = 0
	_, cmd = m.submitModal()
	if cmd == nil || m.modal.kind != modalDiff || m.diff.selectedCommit != "a1b2c3d" {
		t.Fatalf("selecting a different commit failed: modal=%v commit=%q", m.modal.kind, m.diff.selectedCommit)
	}
}

func TestPrettyDiffRejectsLateCommitContent(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.project = "/work"
	m.diff.modalTicket = 9
	m.diff.selectedCommit = "a1b2c3d"
	m.diff.modalLoading = true
	stale := diffContentLoadedMsg{gen: m.gen, ticket: 8, origin: m.currentOrigin(), project: "/work", commit: "a1b2c3d", raw: "stale"}
	m.applyDiffContentLoaded(stale)
	if !m.diff.modalLoading || m.diff.modalRaw != "" {
		t.Fatal("late pretty diff replaced the current commit")
	}
	fresh := stale
	fresh.ticket = 9
	fresh.raw = "current"
	fresh.lines = []string{"current rendered"}
	m.applyDiffContentLoaded(fresh)
	if m.diff.modalLoading || m.diff.modalRaw != "current" || len(m.diff.modalLines) != 1 {
		t.Fatalf("current pretty diff was not applied: %+v", m.diff)
	}
}

func TestPrettyDiffCloseButtonIsClickable(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.width, m.height = 150, 30
	m.modal.open(modalDiff, "Pretty Diff")
	m.focus = focusTerminal
	m.Update(tea.MouseClickMsg{X: m.width - 5, Y: 1, Button: tea.MouseLeft})
	if m.modal.kind != modalNone || m.focus != focusDiff {
		t.Fatalf("close click left modal=%v focus=%v", m.modal.kind, m.focus)
	}
}

func TestPrettyDiffRendererHighlightsAndSanitizesPatch(t *testing.T) {
	patch := "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old value\n+new value\n"
	lines, err := renderPrettyDiffText(patch, 80, "#7c6af7")
	if err != nil {
		t.Fatal(err)
	}
	rendered := strings.Join(lines, "\n")
	if osColorEnabled() && !strings.Contains(rendered, "\x1b[") {
		t.Fatal("pretty diff omitted syntax-color ANSI styles")
	}
	plain := ansi.Strip(rendered)
	for _, want := range []string{"diff --git", "old value", "new value"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("pretty diff omitted %q: %q", want, plain)
		}
	}
}

func TestInvalidCommitHashDoesNotOpenDiff(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.diff.commits = []GitCommit{{Hash: "--help", Subject: "bad"}}
	if cmd := m.openDiffCommit(0); cmd != nil || m.modal.kind == modalDiff {
		t.Fatal("invalid commit hash reached git show")
	}
}
