package phic

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

func validCommitHash(hash string) bool {
	if len(hash) < 4 || len(hash) > 64 {
		return false
	}
	for _, r := range hash {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

func (m *tuiModel) openDiffCommit(index int) tea.Cmd {
	if index < 0 || index >= len(m.diff.commits) {
		return nil
	}
	commit := m.diff.commits[index]
	if !validCommitHash(commit.Hash) {
		m.setStatus("server returned an invalid commit hash", true)
		return nil
	}
	m.diff.cursor = index
	m.diff.selectedCommit = commit.Hash
	m.diff.modalRaw = ""
	m.diff.modalLines = nil
	m.diff.modalScroll = 0
	m.diff.modalErr = ""
	m.diff.modalLoading = true
	m.diff.modalTicket++
	ticket := m.diff.modalTicket
	m.modal.open(modalDiff, "Diff")
	return m.diffContentCmd(commit.Hash, ticket)
}

func (m *tuiModel) diffContentCmd(commit string, ticket int) tea.Cmd {
	gen, origin, project, width := m.gen, m.currentOrigin(), m.diff.project, max(1, m.width-6)
	s := m.serverForOrigin(origin)
	accent := m.markdownAccent()
	return func() tea.Msg {
		out := diffContentLoadedMsg{gen: gen, ticket: ticket, origin: origin, project: project, commit: commit}
		if s == nil || s.api == nil {
			out.err = "server unavailable"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		raw, err := s.api.RawDiffCommit(ctx, project, commit, false)
		if err != nil {
			out.err = err.Error()
			return out
		}
		if raw == "NOT_GIT_REPO" {
			out.err = "not a Git repository"
			return out
		}
		out.raw = raw
		out.lines, err = renderPrettyDiffText(raw, width, accent)
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}

func renderPrettyDiffText(raw string, width int, accent string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	// Render the patch as a fenced diff code block so Glamour/Chroma handles
	// the syntax coloring; choose a fence longer than any in the patch.
	fence := "```"
	for strings.Contains(raw, fence) {
		fence += "`"
	}
	source := fence + "diff\n" + recordingText([]byte(raw)) + "\n" + fence
	return renderMarkdownText(source, width, accent)
}

func (m *tuiModel) applyDiffContentLoaded(msg diffContentLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || msg.ticket != m.diff.modalTicket || msg.origin != m.currentOrigin() || msg.project != m.contextDir() || msg.commit != m.diff.selectedCommit {
		return m, nil
	}
	m.diff.modalLoading = false
	m.diff.modalErr = msg.err
	if msg.err != "" {
		m.diff.modalRaw = ""
		m.diff.modalLines = nil
		return m, nil
	}
	m.diff.modalRaw = msg.raw
	m.diff.modalLines = msg.lines
	m.diff.modalScroll = 0
	return m, nil
}

func (m *tuiModel) closeDiffModal() {
	m.diff.modalTicket++
	m.diff.modalLoading = false
	m.closeModal()
	m.focus = focusDiff
}

func (m *tuiModel) openDiffCommitPicker() {
	if len(m.diff.commits) == 0 {
		return
	}
	m.modal.open(modalDiffSelect, "Select commit")
	for i, commit := range m.diff.commits {
		m.modal.items = append(m.modal.items, modalItem{label: menuLabel(diffCommitOptionLabel(commit)), value: commit.Hash})
		if commit.Hash == m.diff.selectedCommit {
			m.modal.cursor = i
		}
	}
	m.modal.help = "Choose a commit to load its diff"
}

func (m *tuiModel) handlePrettyDiffKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := chromeKeyCode(msg.Key())
	visible := max(1, m.height-6)
	switch k {
	case tea.KeyEscape, 'q':
		m.closeDiffModal()
	case 'c', tea.KeyEnter:
		m.openDiffCommitPicker()
	case tea.KeyUp, 'k':
		m.diff.modalScroll = max(0, m.diff.modalScroll-1)
	case tea.KeyDown, 'j':
		m.diff.modalScroll = min(max(0, len(m.diff.modalLines)-1), m.diff.modalScroll+1)
	case tea.KeyPgUp:
		m.diff.modalScroll = max(0, m.diff.modalScroll-visible)
	case tea.KeyPgDown:
		m.diff.modalScroll = min(max(0, len(m.diff.modalLines)-1), m.diff.modalScroll+visible)
	case tea.KeyHome:
		m.diff.modalScroll = 0
	case tea.KeyEnd:
		m.diff.modalScroll = max(0, len(m.diff.modalLines)-1)
	case 'y':
		if m.diff.modalRaw != "" {
			return m, tea.SetClipboard(m.diff.modalRaw)
		}
	}
	return m, nil
}

func (m *tuiModel) handleDiffModalMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	mouse := msg.Mouse()
	if mouse.Button == tea.MouseWheelUp {
		m.diff.modalScroll = max(0, m.diff.modalScroll-3)
		return m, nil
	}
	if mouse.Button == tea.MouseWheelDown {
		m.diff.modalScroll = min(max(0, len(m.diff.modalLines)-1), m.diff.modalScroll+3)
		return m, nil
	}
	if _, ok := msg.(tea.MouseClickMsg); !ok || mouse.Button != tea.MouseLeft {
		return m, nil
	}
	if mouse.X < 0 || mouse.X >= m.width || mouse.Y < 0 || mouse.Y >= m.height {
		return m, nil
	}
	if mouse.Y == 1 && mouse.X >= m.width-6 && mouse.X < m.width-3 {
		m.closeDiffModal()
		return m, nil
	}
	if mouse.Y == 2 && mouse.X >= 2 {
		m.openDiffCommitPicker()
	}
	return m, nil
}

func (m *tuiModel) renderDiffModal() string {
	w, h := max(1, m.width-2), max(1, m.height-2)
	innerW, innerH := max(1, w-2), max(1, h-2)
	accent := lg.NewStyle().Foreground(m.accentColor()).Bold(true)
	commitLabel := "Choose commit"
	for _, commit := range m.diff.commits {
		if commit.Hash == m.diff.selectedCommit {
			commitLabel = commit.Hash + " — " + commit.Subject
			if strings.TrimSpace(commit.Subject) == "" {
				commitLabel = commit.Hash + " — (no subject)"
			}
			break
		}
	}
	title := accent.Render(" Diff")
	close := accent.Render("[×]")
	header := title + strings.Repeat(" ", max(1, innerW-lg.Width(title)-lg.Width(close))) + close
	lines := []string{
		header,
		accent.Render(" Commit: " + ansi.Truncate(menuLabel(commitLabel)+"  [c] ▼", innerW-1, "…")),
	}
	visible := max(1, innerH-4)
	switch {
	case m.diff.modalLoading:
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(" Loading diff…"))
	case m.diff.modalErr != "":
		lines = append(lines, lg.NewStyle().Foreground(tuiError).Render(" "+menuLabel(m.diff.modalErr)))
	case len(m.diff.modalLines) == 0:
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(" No changes in this commit."))
	default:
		start := min(m.diff.modalScroll, max(0, len(m.diff.modalLines)-1))
		for i := start; i < len(m.diff.modalLines) && i < start+visible; i++ {
			lines = append(lines, " "+ansi.Truncate(m.diff.modalLines[i], innerW-1, ""))
		}
	}
	for len(lines) < innerH-1 {
		lines = append(lines, "")
	}
	if len(lines) > innerH-1 {
		lines = lines[:innerH-1]
	}
	lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(ansi.Truncate(" c/Enter commits · ↑↓/wheel scroll · y copy · Esc close", innerW, "")))
	return fitScreen(m.panelStyle(w, h, true).Render(strings.Join(lines, "\n")), m.width, m.height)
}

func diffCommitOptionLabel(commit GitCommit) string {
	if strings.TrimSpace(commit.Subject) == "" {
		return commit.Hash + "  (no subject)"
	}
	return fmt.Sprintf("%s  %s", commit.Hash, commit.Subject)
}

func (m *tuiModel) selectDiffCommit(index int) tea.Cmd {
	if index < 0 || index >= len(m.diff.commits) {
		m.modal.open(modalDiff, "Diff")
		return nil
	}
	return m.openDiffCommit(index)
}
