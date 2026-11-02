package phic

import (
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"strings"
)

// recordingText is also the display sanitizer used by Git and Markdown.
func recordingText(b []byte) string {
	text := ansi.Strip(string(b))
	var out strings.Builder
	for _, r := range text {
		if r == '\n' || r == '\t' || r >= 0x20 && r != 0x7f && !(r >= 0x80 && r <= 0x9f) {
			out.WriteRune(r)
		}
	}
	return out.String()
}

type diffState struct {
	markdown        bool
	open            bool
	commits         []GitCommit
	loading         bool
	err             string
	cursor          int
	origin, project string
	selectedCommit  string
	modalRaw        string
	modalLines      []string
	modalLoading    bool
	modalErr        string
	modalScroll     int
	modalTicket     int
}

func (d *diffState) commitListStart(visible int) int {
	if visible <= 0 || len(d.commits) <= visible {
		return 0
	}
	return min(max(0, d.cursor-visible+1), len(d.commits)-visible)
}

func (m *tuiModel) refreshDiff() tea.Cmd {
	if !m.diff.open {
		return nil
	}
	if m.diff.markdown {
		return m.refreshMarkdownList()
	}
	origin, project := m.currentOrigin(), m.contextDir()
	if origin == "" || project == "" {
		m.diff.commits = nil
		m.diff.loading = false
		m.diff.err = "Choose a project to view commits"
		return nil
	}
	if m.diff.origin != origin || m.diff.project != project {
		m.diff.commits = nil
		m.diff.cursor = 0
	}
	m.diff.origin, m.diff.project = origin, project
	m.diff.loading = true
	m.diff.err = ""
	return m.diffCmd(origin, project)
}

func (m *tuiModel) applyWorktrees(msg worktreesMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || msg.origin != m.currentOrigin() || msg.project != m.project {
		return m, nil
	}
	m.modal.open(modalWorktree, "Worktree")
	for _, w := range msg.items {
		label := menuLabel(w.Path)
		if w.Active {
			label = "● " + label
		}
		m.modal.items = append(m.modal.items, modalItem{label: label, value: w.Path})
	}
	if len(m.modal.items) == 0 {
		m.closeModal()
		m.setStatus("no worktrees for this project", true)
	}
	return m, nil
}
