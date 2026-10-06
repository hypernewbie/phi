package phic

import (
	tea "charm.land/bubbletea/v2"
	"context"
	"encoding/hex"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"github.com/hypernewbie/phi/internal/termemu"
	"strings"
	"time"
)

type diffState struct {
	open            bool
	text            string
	lines           []string
	loading         bool
	err             string
	scroll          int
	origin, project string
	search          textField
	searchActive    bool
	matches         []int
	matchCursor     int
}

func (d *diffState) recomputeMatches() {
	d.lines = splitLines(d.text)
	d.matches = nil
	query := strings.ToLower(d.search.value)
	if query == "" {
		d.scroll = min(d.scroll, max(0, len(d.lines)-1))
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

// The retained live core supplies normal scrollback. The archive drawer is a
// bounded source-byte browser, not a fake VT screen initialized mid-sequence.
// Hex view and contiguous earlier/later pages keep every source byte inspectable.
type historyState struct {
	open, loading    bool
	err, text        string
	lines            []string
	scroll           int
	key              paneKey
	start, end, head uint64
	ticket           int
	raw              []byte
	hex              bool
}
type historyLoadedMsg struct {
	gen        int
	key        paneKey
	text, err  string
	start, end uint64
	ticket     int
	raw        []byte
}

func (m *tuiModel) applyHistoryLoaded(msg historyLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || m.modal.kind != modalHistory || m.history.key != msg.key || m.history.ticket != msg.ticket {
		return m, nil
	}
	m.history.loading = false
	m.history.start, m.history.end, m.history.raw = msg.start, msg.end, msg.raw
	if msg.err != "" {
		m.history.err = msg.err
		return m, nil
	}
	m.history.err = ""
	m.history.text = msg.text
	m.history.lines = splitLines(msg.text)
	m.history.scroll = 0
	if m.history.hex {
		m.history.hex = false
		m.toggleHistoryHex()
	}
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

// At most 8192 newline bytes => at most 8193 text rows. No archive copy on disk.
const historyWindowBytes = 8 << 10

func fetchHistoryText(ctx context.Context, api *apiClient, paneID string, epoch, head uint64, _ func(termemu.Options) (termemu.Terminal, error)) (string, error) {
	if head == 0 {
		return "", nil
	}
	start := uint64(0)
	if head > historyWindowBytes {
		start = head - historyWindowBytes
	}
	h, b, err := api.recording(ctx, paneID, epoch, start, head)
	if err != nil {
		return "", err
	}
	if h.End != head {
		return "", errInvalidRecording
	}
	return recordingText(b), nil
}
func recordingText(b []byte) string {
	// Text is an explicitly lossy presentation. Hex view retains exact source
	// bytes, including partial UTF-8, escape commands, and control characters.
	text := ansi.Strip(string(b))
	var out strings.Builder
	for _, r := range text {
		if r == '\n' || r == '\t' || r >= 0x20 && r != 0x7f && !(r >= 0x80 && r <= 0x9f) {
			out.WriteRune(r)
		}
	}
	return out.String()
}
func (m *tuiModel) historyPage(end uint64) tea.Cmd {
	key := m.history.key
	s := m.serverForOrigin(key.Origin)
	if s == nil || s.api == nil {
		return nil
	}
	tab := m.findTab(key)
	if tab == nil || tab.actor == nil {
		return nil
	}
	_, _, epoch, _, _, _ := tab.actor.state()
	start := uint64(0)
	if end > historyWindowBytes {
		start = end - historyWindowBytes
	}
	m.history.ticket++
	ticket, gen := m.history.ticket, m.gen
	m.history.loading = true
	api := s.api
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		h, b, err := api.recording(ctx, key.ID, epoch, start, end)
		out := historyLoadedMsg{gen: gen, key: key, start: start, end: end, ticket: ticket, raw: b}
		if err != nil {
			out.err = err.Error()
		} else if h.End != end {
			out.err = errInvalidRecording.Error()
		} else {
			out.text = recordingText(b)
		}
		return out
	}
}
func (m *tuiModel) toggleHistoryHex() {
	m.history.hex = !m.history.hex
	if m.history.hex {
		m.history.text = fmt.Sprintf("Source offset %d\n", m.history.start) + hex.Dump(m.history.raw)
	} else {
		m.history.text = recordingText(m.history.raw)
	}
	m.history.lines = splitLines(m.history.text)
	m.history.scroll = 0
}
