package phic

import (
	"context"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// diffState is the optional diff/status panel. It never replaces the terminal
// emulator and a failed request leaves the terminal usable.
type diffState struct {
	open         bool
	text         string
	lines        []string
	loading      bool
	err          string
	scroll       int
	origin       string
	project      string
	search       textField
	searchActive bool
	matches      []int
	matchCursor  int
}

func (d *diffState) recomputeMatches() {
	d.lines = splitLines(d.text)
	d.matches = nil
	query := strings.ToLower(d.search.value)
	if query == "" {
		if d.scroll >= len(d.lines) {
			d.scroll = max(0, len(d.lines)-1)
		}
		return
	}
	for i, line := range d.lines {
		if strings.Contains(strings.ToLower(line), query) {
			d.matches = append(d.matches, i)
		}
	}
	if len(d.matches) > 0 {
		d.matchCursor = 0
		d.scroll = d.matches[0]
	}
}

func (d *diffState) nextMatch(delta int) {
	if len(d.matches) == 0 {
		return
	}
	d.matchCursor = (d.matchCursor + delta + len(d.matches)) % len(d.matches)
	d.scroll = d.matches[d.matchCursor]
}

// refreshDiff requests the raw diff for the captured origin and project. A
// late result for another origin or project cannot overwrite this one.
func (m *tuiModel) refreshDiff() tea.Cmd {
	if !m.diff.open {
		return nil
	}
	origin := m.currentOrigin()
	if origin == "" || m.project == "" {
		return nil
	}
	m.diff.loading = true
	m.diff.err = ""
	return m.diffCmd(origin, m.project)
}

// historyState is a bounded recording browser. It uses its own emulator so
// opening history cannot reset a live alternate-screen application.
type historyState struct {
	open    bool
	loading bool
	err     string
	text    string
	lines   []string
	scroll  int
	key     paneKey
}

type historyLoadedMsg struct {
	gen  int
	key  paneKey
	text string
	err  string
}

func (m *tuiModel) applyHistoryLoaded(msg historyLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	m.history.loading = false
	m.history.key = msg.key
	if msg.err != "" {
		m.history.err = msg.err
		return m, nil
	}
	m.history.err = ""
	m.history.text = msg.text
	m.history.lines = splitLines(msg.text)
	m.history.scroll = max(0, len(m.history.lines)-1)
	return m, nil
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

// historyWindowBytes bounds a history fetch so browsing cannot parse an
// unbounded recording or fill an unbounded client cache.
const historyWindowBytes = 4 << 20

// fetchHistoryText replays a bounded tail of the recording into a separate
// browsing emulator and returns its visible text.
func fetchHistoryText(ctx context.Context, api *apiClient, paneID string, epoch, head uint64, build func(termemu.Options) (termemu.Terminal, error)) (string, error) {
	if head == 0 {
		return "", nil
	}
	start := uint64(0)
	if head > historyWindowBytes {
		start = head - historyWindowBytes
	}
	if build == nil {
		build = termemu.NewGhostty
	}
	emu, err := build(termemu.Options{
		Cols:            120,
		Rows:            40,
		ScrollbackBytes: 8 << 20,
		ScrollbackLines: 2000,
	})
	if err != nil {
		return "", err
	}
	defer emu.Close()
	from := start
	for from < head {
		end := pageEnd(from, head)
		h, data, err := api.recording(ctx, paneID, epoch, from, end)
		if err != nil {
			return "", err
		}
		if h.End != end || uint64(len(data)) != end-from {
			return "", errInvalidRecording
		}
		// Historical bytes never emit replies or host effects.
		if err := emu.Feed(data, termemu.SourceReplay); err != nil {
			return "", err
		}
		from = end
	}
	frame, err := emu.Snapshot()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, row := range frame.Cells {
		for _, c := range row {
			if c.Width == 0 {
				continue
			}
			if c.Text == "" {
				b.WriteByte(' ')
			} else {
				b.WriteString(c.Text)
			}
		}
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n"), nil
}
