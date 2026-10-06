package phic

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"charm.land/glamour/v2/styles"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Website-lite Markdown. Discovery and confinement remain server-owned.
type markdownFile struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Dir  string `json:"dir"`
}
type markdownState struct {
	origin, dir               string
	files                     []markdownFile
	cursor, listStart, scroll int
	path, raw, source, err    string
	lines                     []string
	reading, loading          bool
	ticket                    int
}
type markdownLoadedMsg struct {
	gen, ticket, width                  int
	origin, dir, path, raw, source, err string
	files                               []markdownFile
	lines                               []string
}

func (m *tuiModel) markdownDir() string {
	if tab := m.activeTabModel(); tab != nil && tab.dir != "" {
		return tab.dir
	}
	if m.worktree != "" {
		return m.worktree
	}
	return m.project
}
func (m *tuiModel) markdownWidth() int { return max(1, m.width-4) }
func (m *tuiModel) showMarkdown() tea.Cmd {
	m.diff.open = true
	m.diff.markdown = true
	m.focus = focusDiff
	return tea.Batch(m.refreshMarkdownList(), m.persistIntent())
}
func (m *tuiModel) refreshMarkdownList() tea.Cmd {
	origin, dir := m.currentOrigin(), m.markdownDir()
	s := m.serverForOrigin(origin)
	if m.markdown.origin != origin || m.markdown.dir != dir {
		ticket := m.markdown.ticket
		m.markdown = markdownState{ticket: ticket, origin: origin, dir: dir}
	}
	if s == nil || s.api == nil || dir == "" {
		m.markdown.err = "Choose a connected server and project"
		return nil
	}
	m.markdown.ticket++
	ticket, gen := m.markdown.ticket, m.gen
	m.markdown.loading = true
	m.markdown.err = ""
	return func() tea.Msg {
		out := markdownLoadedMsg{gen: gen, ticket: ticket, origin: origin, dir: dir}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err := s.api.getJSON(ctx, "/api/markdown/files?"+url.Values{"cwd": {dir}}.Encode(), &out.files)
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}

const maxMarkdownBytes = 1 << 20

func (m *tuiModel) openMarkdownFile(index int) tea.Cmd {
	if index < 0 || index >= len(m.markdown.files) {
		return nil
	}
	m.markdown.cursor = index
	file := m.markdown.files[index]
	m.markdown.path = file.Path
	m.markdown.reading = true
	m.modal.open(modalMarkdown, "Markdown")
	m.markdown.scroll = 0
	m.markdown.lines = nil
	m.markdown.raw = ""
	m.markdown.source = ""
	m.markdown.err = ""
	m.markdown.loading = true
	m.markdown.ticket++
	ticket, gen := m.markdown.ticket, m.gen
	origin, dir, width := m.markdown.origin, m.markdown.dir, m.markdownWidth()
	accent := m.markdownAccent()
	s := m.serverForOrigin(origin)
	return func() tea.Msg {
		out := markdownLoadedMsg{gen: gen, ticket: ticket, origin: origin, dir: dir, path: file.Path, width: width}
		if s == nil || s.api == nil {
			out.err = "server unavailable"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		query := url.Values{"cwd": {dir}, "path": {file.Path}}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api.base.String()+"/api/markdown/file?"+query.Encode(), nil)
		if err != nil {
			out.err = err.Error()
			return out
		}
		resp, err := s.api.http.Do(req)
		if err != nil {
			out.err = err.Error()
			return out
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			out.err = "read Markdown: " + resp.Status
			return out
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxMarkdownBytes+1))
		if err != nil {
			out.err = err.Error()
			return out
		}
		if len(data) > maxMarkdownBytes {
			out.err = "Markdown file exceeds the 1 MiB console viewer limit"
			return out
		}
		out.source = string(data)     // Explicit clipboard actions copy the file, not rendered text.
		out.raw = recordingText(data) // Strip control sequences before invoking the renderer.
		out.lines, err = renderMarkdownText(out.raw, width, accent)
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}
func (m *tuiModel) markdownAccent() string {
	r, g, b, _ := m.accentColor().RGBA()
	return fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
}
func renderMarkdownText(raw string, width int, accent string) ([]string, error) {
	// Explicit built-in style: no terminal queries, environment-driven style file,
	// executable, external viewer, image fetch, or clipboard operation.
	style := styles.DarkStyleConfig
	zero := uint(0)
	style.Document.Margin = &zero
	style.Heading.Color = &accent
	style.H1.Color = &accent
	style.H1.BackgroundColor = nil
	style.Code.Color = &accent
	style.Link.Color = &accent
	style.LinkText.Color = &accent
	renderer, err := glamour.NewTermRenderer(glamour.WithStyles(style), glamour.WithWordWrap(max(1, width)), glamour.WithTableWrap(false))
	if err != nil {
		return nil, err
	}
	text, err := renderer.Render(raw)
	if err != nil {
		return nil, err
	}
	if !osColorEnabled() {
		text = ansi.Strip(text)
	}
	return splitLines(strings.Trim(text, "\n")), nil
}
func (m *tuiModel) reflowMarkdown() tea.Cmd {
	if !m.markdown.reading || m.markdown.loading || m.markdown.raw == "" {
		return nil
	}
	m.markdown.ticket++
	gen, ticket, width := m.gen, m.markdown.ticket, m.markdownWidth()
	origin, dir, path, raw := m.markdown.origin, m.markdown.dir, m.markdown.path, m.markdown.raw
	accent := m.markdownAccent()
	source := m.markdown.source
	return func() tea.Msg {
		lines, err := renderMarkdownText(raw, width, accent)
		out := markdownLoadedMsg{gen: gen, ticket: ticket, width: width, origin: origin, dir: dir, path: path, raw: raw, source: source, lines: lines}
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}
func (m *tuiModel) applyMarkdownLoaded(msg markdownLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || msg.ticket != m.markdown.ticket || msg.origin != m.currentOrigin() || msg.dir != m.markdownDir() {
		return m, nil
	}
	m.markdown.loading = false
	m.markdown.err = msg.err
	if msg.err != "" {
		return m, nil
	}
	if msg.path == "" {
		m.markdown.files = msg.files
		m.markdown.cursor = min(m.markdown.cursor, max(0, len(msg.files)-1))
		m.markdown.reading = false
		m.markdown.listStart = 0
		return m, nil
	}
	if msg.path != m.markdown.path {
		return m, nil
	}
	m.markdown.raw = msg.raw
	m.markdown.source = msg.source
	m.markdown.lines = msg.lines
	if m.diff.open && m.diff.markdown && msg.width != m.markdownWidth() {
		return m, m.reflowMarkdown()
	}
	m.markdown.scroll = min(m.markdown.scroll, max(0, len(msg.lines)-1))
	return m, nil
}
func (m *tuiModel) handleMarkdownKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	if k.Code == '[' {
		return m, m.resizePanel(false, -4)
	}
	if k.Code == ']' {
		return m, m.resizePanel(false, 4)
	}
	d := &m.markdown
	switch k.Code {
	case 'm', 'd':
		if k.Code == 'd' {
			m.diff.markdown = false
			return m, m.refreshDiff()
		}
	case tea.KeyEscape:
		m.focus = focusTerminal
	case tea.KeyTab:
		m.diff.markdown = false
		return m, m.refreshDiff()
	case tea.KeyBackspace, tea.KeyLeft, 'b':
		d.reading = false
		d.ticket++
		d.loading = false
		d.err = ""
	case 'r':
		if d.reading {
			return m, m.openMarkdownFile(d.cursor)
		}
		return m, m.refreshMarkdownList()
	case tea.KeyEnter, tea.KeyRight:
		if !d.reading {
			return m, m.openMarkdownFile(d.cursor)
		}
	case tea.KeyUp, 'k':
		if d.reading {
			d.scroll = max(0, d.scroll-1)
		} else {
			d.cursor = max(0, d.cursor-1)
		}
	case tea.KeyDown, 'j':
		if d.reading {
			d.scroll = min(max(0, len(d.lines)-1), d.scroll+1)
		} else {
			d.cursor = min(max(0, len(d.files)-1), d.cursor+1)
		}
	case tea.KeyPgUp:
		if d.reading {
			d.scroll = max(0, d.scroll-10)
		} else {
			d.cursor = max(0, d.cursor-10)
		}
	case tea.KeyPgDown:
		if d.reading {
			d.scroll = min(max(0, len(d.lines)-1), d.scroll+10)
		} else {
			d.cursor = min(max(0, len(d.files)-1), d.cursor+10)
		}
	case tea.KeyHome:
		d.scroll = 0
		d.cursor = 0
	case tea.KeyEnd:
		if d.reading {
			d.scroll = max(0, len(d.lines)-1)
		} else {
			d.cursor = max(0, len(d.files)-1)
		}
	}
	return m, nil
}
func (m *tuiModel) markdownListStart(visible int) int {
	d := &m.markdown
	start := d.listStart
	if d.cursor < start {
		start = d.cursor
	}
	if d.cursor >= start+visible {
		start = d.cursor - visible + 1
	}
	return max(0, start)
}
func (m *tuiModel) renderMarkdownPanel() string {
	r := m.diffRect()
	w, h := max(1, r.W-2), max(1, r.H-2)
	d := &m.markdown
	lines := []string{m.renderReaderTabs()}
	if d.reading {
		lines = append(lines, lg.NewStyle().Foreground(m.accentColor()).Render(ansi.Truncate(menuLabel(d.path), w, "…")))
	} else {
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(ansi.Truncate(menuLabel(d.dir), w, "…")))
	}
	visible := max(1, h-3)
	switch {
	case d.loading:
		lines = append(lines, "loading…")
	case d.err != "":
		lines = append(lines, "Markdown: "+menuLabel(d.err))
	case d.reading:
		for i := d.scroll; i < len(d.lines) && i < d.scroll+visible; i++ {
			lines = append(lines, ansi.Truncate(d.lines[i], w, ""))
		}
	case len(d.files) == 0:
		lines = append(lines, "No Markdown files in configured dirs.")
	default:
		start := m.markdownListStart(visible)
		for i := start; i < len(d.files) && i < start+visible; i++ {
			file := d.files[i]
			name := menuLabel(file.Dir) + "/" + menuLabel(file.Name)
			style := lg.NewStyle().Foreground(tuiMuted)
			if i == d.cursor {
				style = style.Foreground(m.accentColor()).Bold(true).Background(lg.Color("#1d1f27"))
			}
			lines = append(lines, style.Render(ansi.Truncate(name, w, "…")))
		}
	}
	for len(lines) < h-1 {
		lines = append(lines, "")
	}
	if len(lines) > h-1 {
		lines = lines[:h-1]
	}
	hint := "Enter view · r refresh · Tab Diff"
	if d.reading {
		hint = "← list · ↑↓ scroll · r refresh"
	}
	lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(ansi.Truncate(hint, w, "")))
	return m.panelStyle(w, h, m.focus == focusDiff).Render(strings.Join(lines, "\n"))
}
func (m *tuiModel) renderReaderTabs() string {
	diff, md := lg.NewStyle().Foreground(tuiMuted), lg.NewStyle().Foreground(tuiMuted)
	if m.diff.markdown {
		md = md.Foreground(m.accentColor()).Bold(true)
	} else {
		diff = diff.Foreground(m.accentColor()).Bold(true)
	}
	return diff.Render("[d] Diff") + "  " + md.Render("[m] Markdown")
}
func (m *tuiModel) handleReaderClick(x, y int) (tea.Model, tea.Cmd) {
	r := m.diffRect()
	if y == r.Y+1 {
		if x >= r.X+1 && x < r.X+1+len("[d] Diff") {
			m.diff.markdown = false
			return m, m.refreshDiff()
		}
		if x >= r.X+11 && x < r.X+11+len("[m] Markdown") {
			return m, m.showMarkdown()
		}
	}
	if m.diff.markdown && !m.markdown.reading && !m.markdown.loading && y >= r.Y+3 && y < r.Y+r.H-2 {
		index := m.markdownListStart(max(1, r.H-5)) + y - (r.Y + 3)
		if index < len(m.markdown.files) {
			return m, m.openMarkdownFile(index)
		}
	}
	return m, nil
}
