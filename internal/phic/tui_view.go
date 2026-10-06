package phic

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// Phi terminal palette defaults. Backend content keeps its own colors; the
// client never tints cells with the server accent.
var (
	tuiFgDefault = "#d6d7dd"
	tuiBgDefault = "#171719"
	tuiMuted     = lg.Color("#888895")
	tuiBorder    = lg.Color("#393941")
	tuiError     = lg.Color("#f07178")
	tuiOK        = lg.Color("#c3e88d")
)

func (m *tuiModel) accentColor() color.Color {
	d := m.current()
	if d != nil {
		if hex := phiAccents[d.identity.Theme]; hex != "" {
			return lg.Color("#" + hex)
		}
	}
	return lg.Color("#82aaff")
}

func (m *tuiModel) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.ReportFocus = true
	v.KeyboardEnhancements.ReportEventTypes = true
	label := "phic"
	if s := m.currentServer(); s != nil {
		label = s.label() + " · phic"
	}
	v.WindowTitle = label
	return v
}

func (m *tuiModel) render() string {
	if m.width <= 0 || m.height <= 0 {
		return "phic"
	}
	if m.width < 40 || m.height < 10 {
		return fmt.Sprintf("phic: terminal too small (%d×%d). Need at least 40×10.\nEnlarge the window or press Ctrl-] q to quit.", m.width, m.height)
	}
	rail := m.renderRail()
	context := m.renderContext()
	tabs := m.renderTabs()
	body := m.renderBody()
	footer := m.renderFooter()
	base := strings.Join([]string{rail, context, tabs, body, footer}, "\n")
	if m.modal.kind != modalNone {
		return m.overlayModal(base)
	}
	return base
}

// ---- chrome ----

func (m *tuiModel) renderRail() string {
	accent := m.accentColor()
	var b strings.Builder
	b.WriteString(lg.NewStyle().Foreground(accent).Bold(true).Render(" Φ "))
	glyphs := serverGlyphs(m.servers)
	for i, s := range m.servers {
		label := s.label()
		if i == m.active {
			b.WriteString(lg.NewStyle().
				Foreground(accent).Bold(true).
				Background(lg.Color("#1d1f27")).
				Render(" " + glyphs[i] + " " + label + " "))
		} else {
			color := tuiMuted
			if s.health != "up" {
				color = lg.Color("#78768a")
			}
			b.WriteString(lg.NewStyle().Foreground(color).Render(" " + glyphs[i] + " " + label + " "))
		}
	}
	b.WriteString(lg.NewStyle().Foreground(accent).Render(" [+]"))
	left := b.String()
	right := m.connectionLabel()
	gap := m.width - lg.Width(left) - lg.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right + " "
}

func (m *tuiModel) connectionLabel() string {
	s := m.currentServer()
	if s == nil {
		return lg.NewStyle().Foreground(tuiMuted).Render("no server")
	}
	d := m.current()
	if d != nil && d.needAuth {
		return lg.NewStyle().Foreground(lg.Color("#fbbf24")).Render("sign in required")
	}
	if d != nil && d.err != "" {
		return lg.NewStyle().Foreground(tuiError).Render("error")
	}
	if d != nil && !d.loaded {
		return lg.NewStyle().Foreground(tuiMuted).Render("connecting…")
	}
	switch s.health {
	case "up":
		return lg.NewStyle().Foreground(tuiOK).Render("connected")
	default:
		return lg.NewStyle().Foreground(lg.Color("#fbbf24")).Render("unreachable")
	}
}

func (m *tuiModel) renderContext() string {
	accent := m.accentColor()
	muted := lg.NewStyle().Foreground(tuiMuted)
	focus := func(s string) string {
		if m.focus == focusTerminal {
			return s
		}
		return lg.NewStyle().Foreground(accent).Render(s)
	}
	project := menuLabel(m.project)
	if project == "" {
		project = "(choose project)"
	}
	worktree := menuLabel(m.worktree)
	if worktree == "" {
		worktree = "default"
	}
	coder := "—"
	if c, ok := m.selectedCoder(); ok {
		coder = menuLabel(c.Name)
	}
	parts := []string{
		muted.Render("Project:") + " " + focus(project) + muted.Render(" [p]"),
		muted.Render("Worktree:") + " " + focus(worktree) + muted.Render(" [w]"),
		muted.Render("Coder:") + " " + focus(coder) + muted.Render(" [c]"),
		lg.NewStyle().Foreground(accent).Render("[n] New Session"),
	}
	line := " " + strings.Join(parts, "   ")
	diffLabel := "Diff [d]"
	if m.diff.open {
		diffLabel = "Diff ● [d]"
	}
	right := lg.NewStyle().Foreground(accent).Render(diffLabel)
	gap := m.width - lg.Width(line) - lg.Width(right) - 1
	if gap < 1 {
		gap = 1
	}
	return line + strings.Repeat(" ", gap) + right
}

func (m *tuiModel) renderTabs() string {
	accent := m.accentColor()
	muted := lg.NewStyle().Foreground(tuiMuted)
	tabs := m.tabs[m.active]
	prefix := muted.Render(" TERMINALS ")
	suffix := muted.Render(" [x] close  [u] undo")
	if len(tabs) == 0 {
		return prefix + muted.Render("no open panes — [n] New Session")
	}
	labels := make([]string, len(tabs))
	widths := make([]int, len(tabs))
	total := 0
	active := m.activeTab[m.active]
	for i, t := range tabs {
		mark := "◌"
		if t.attached {
			mark = "●"
		}
		if t.exited {
			mark = "!"
		}
		if t.closing {
			mark = "✕"
		}
		label := " " + mark + " " + t.label() + " "
		if t.unread && i != active {
			label = " " + mark + " " + t.label() + "• "
		}
		if t.view.Pinned {
			label = " " + mark + " " + t.label() + " ⌂ "
		}
		labels[i] = label
		widths[i] = lg.Width(label)
		total += widths[i]
	}
	avail := m.width - lg.Width(prefix) - lg.Width(suffix) - 6
	start, end := 0, len(tabs)
	if total > avail {
		// Window the strip around the active tab; overflow is reported as
		// +N markers instead of silently hiding panes.
		if active < 0 || active >= len(tabs) {
			active = 0
		}
		start, end = active, active+1
		used := widths[active]
		for end < len(tabs) && used+widths[end] <= avail-4 {
			used += widths[end]
			end++
		}
		for start > 0 && used+widths[start-1] <= avail-4 {
			start--
			used += widths[start]
		}
	}
	var b strings.Builder
	b.WriteString(prefix)
	if start > 0 {
		b.WriteString(muted.Render(fmt.Sprintf("+%d ", start)))
	}
	for i := start; i < end; i++ {
		label := labels[i]
		switch {
		case i == active:
			b.WriteString(lg.NewStyle().Foreground(accent).Bold(true).Background(lg.Color("#1d1f27")).Render(label))
		case tabs[i].exited:
			b.WriteString(lg.NewStyle().Foreground(tuiError).Render(label))
		default:
			b.WriteString(muted.Render(label))
		}
	}
	if end < len(tabs) {
		b.WriteString(muted.Render(fmt.Sprintf("+%d", len(tabs)-end)))
	}
	b.WriteString(suffix)
	return b.String()
}

func (m *tuiModel) renderBody() string {
	var panels []string
	if m.showSidebar() {
		panels = append(panels, m.renderSidebar())
	}
	panels = append(panels, m.renderTerminalPanel())
	if m.showDiffPanel() {
		panels = append(panels, m.renderDiffPanel())
	}
	return lg.JoinHorizontal(lg.Top, panels...)
}

func (m *tuiModel) panelStyle(w, h int, focused bool) lg.Style {
	border := tuiBorder
	if focused {
		border = m.accentColor()
	}
	return lg.NewStyle().
		Border(lg.NormalBorder()).
		BorderForeground(border).
		Width(w).
		Height(h)
}

// ---- sidebar ----

func (m *tuiModel) renderSidebar() string {
	r := m.sidebarRect()
	innerW, innerH := r.W-2, r.H-2
	accent := m.accentColor()
	var lines []string
	title := "SESSIONS"
	if m.searchActive {
		title += " /" + m.sessionSearch.value
	} else if m.sessionSearch.value != "" {
		title += " /" + m.sessionSearch.value
	}
	lines = append(lines, lg.NewStyle().Foreground(accent).Bold(true).Render(title))
	lines = append(lines, "")
	rows := m.sidebarRows()
	for i, row := range rows {
		if i >= innerH-3 {
			lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("…"))
			break
		}
		var text string
		switch row.kind {
		case rowNewSession:
			text = "+ New Session"
		case rowSession:
			when := row.session.TimeUpdated.Format("01-02")
			text = "↩ " + row.label + "  " + when
		case rowLivePane:
			attached := ""
			if row.pane.ActiveWSCount > 0 {
				attached = fmt.Sprintf(" (attached x%d)", row.pane.ActiveWSCount)
			}
			text = "● " + row.label + attached
		}
		if i == m.sessionCursor && m.focus == focusSessions {
			lines = append(lines, lg.NewStyle().Foreground(accent).Background(lg.Color("#1d1f27")).Render("› "+text))
		} else if row.kind == rowNewSession {
			lines = append(lines, lg.NewStyle().Foreground(accent).Render("  "+text))
		} else {
			lines = append(lines, lg.NewStyle().Foreground(tuiFgColor()).Render("  "+text))
		}
	}
	for len(lines) < innerH {
		lines = append(lines, "")
	}
	if len(lines) > innerH {
		lines = lines[:innerH]
	}
	content := strings.Join(lines, "\n")
	return m.panelStyle(innerW, innerH, m.focus == focusSessions).Render(content)
}

func tuiFgColor() color.Color { return lg.Color(tuiFgDefault) }

// ---- terminal ----

func (m *tuiModel) renderTerminalPanel() string {
	r := m.terminalRect()
	if r.empty() {
		return ""
	}
	innerW, innerH := r.W-2, r.H-2
	tab := m.activeTabModel()
	var lines []string
	if tab == nil {
		lines = m.placeholderLines(innerW, innerH, "No pane open. [n] New Session, [s] Sessions.")
	} else if tab.exited {
		lines = m.placeholderLines(innerW, innerH, fmt.Sprintf("%s exited (%d). The tab keeps its history; [x] closes it.", tab.label(), tab.exitCode))
		if frame, ok := tab.actorSnapshot(); ok {
			lines = m.renderFrameLines(tab, frame, innerW, innerH)
		}
	} else if tab.actor == nil {
		lines = m.placeholderLines(innerW, innerH, "Attaching "+tab.label()+"…")
	} else if frame, ok := tab.actorSnapshot(); ok {
		lines = m.renderFrameLines(tab, frame, innerW, innerH)
	} else {
		lines = m.placeholderLines(innerW, innerH, "Waiting for "+tab.label()+"…")
	}
	content := strings.Join(lines, "\n")
	return m.panelStyle(innerW, innerH, m.focus == focusTerminal).Render(content)
}

func (t *paneTab) actorSnapshot() (termemu.Frame, bool) {
	if t.actor == nil {
		return termemu.Frame{}, false
	}
	return t.actor.snapshotCopy()
}

func (m *tuiModel) placeholderLines(w, h int, text string) []string {
	lines := make([]string, 0, h)
	lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(text))
	for len(lines) < h {
		lines = append(lines, "")
	}
	return lines
}

type cellStyleKey struct {
	fg, bg    uint32
	fgKind    termemu.ColorKind
	bgKind    termemu.ColorKind
	bold      bool
	faint     bool
	italic    bool
	underline bool
	strike    bool
	inverse   bool
	selected  bool
}

func resolveColor(c termemu.Color, fallback string) string {
	switch c.Kind {
	case termemu.ColorPalette:
		return strconv.Itoa(int(c.Value))
	case termemu.ColorRGB:
		return fmt.Sprintf("#%06x", c.Value)
	default:
		return fallback
	}
}

func styleForKey(k cellStyleKey) lg.Style {
	fg := resolveColor(termemu.Color{Kind: k.fgKind, Value: k.fg}, tuiFgDefault)
	bg := resolveColor(termemu.Color{Kind: k.bgKind, Value: k.bg}, "")
	if k.inverse {
		fg, bg = bg, fg
		if fg == "" {
			fg = tuiBgDefault
		}
		if bg == "" {
			bg = tuiFgDefault
		}
	}
	if k.selected {
		fg, bg = tuiBgDefault, "#82aaff"
	}
	st := lg.NewStyle()
	if fg != "" {
		st = st.Foreground(lg.Color(fg))
	}
	if bg != "" {
		st = st.Background(lg.Color(bg))
	}
	if k.bold {
		st = st.Bold(true)
	}
	if k.faint {
		st = st.Faint(true)
	}
	if k.italic {
		st = st.Italic(true)
	}
	if k.underline {
		st = st.Underline(true)
	}
	if k.strike {
		st = st.Strikethrough(true)
	}
	return st
}

func (m *tuiModel) renderFrameLines(tab *paneTab, frame termemu.Frame, w, h int) []string {
	lines := make([]string, 0, h)
	styles := map[cellStyleKey]lg.Style{}
	sel := m.selection
	selectionOn := sel.active && tab.key == m.activeTabKeyOrZero()
	for y := 0; y < h; y++ {
		if y >= len(frame.Cells) {
			lines = append(lines, "")
			continue
		}
		row := frame.Cells[y]
		var b strings.Builder
		width := 0
		runStart := 0
		var runKey cellStyleKey
		flush := func(end int) {
			if end <= runStart {
				return
			}
			var text strings.Builder
			for x := runStart; x < end && x < len(row); x++ {
				c := row[x]
				if c.Width == 0 {
					continue
				}
				if c.Text == "" {
					text.WriteByte(' ')
				} else {
					text.WriteString(c.Text)
				}
			}
			st, ok := styles[runKey]
			if !ok {
				st = styleForKey(runKey)
				styles[runKey] = st
			}
			b.WriteString(st.Render(text.String()))
		}
		for x := 0; x < len(row); x++ {
			c := row[x]
			if c.Width == 0 {
				continue
			}
			selected := false
			if selectionOn {
				selected = inSelection(sel, x, y)
			}
			key := cellStyleKey{
				fg: c.Fg.Value, bg: c.Bg.Value,
				fgKind: c.Fg.Kind, bgKind: c.Bg.Kind,
				bold: c.Bold, faint: c.Faint, italic: c.Italic,
				underline: c.Underline != termemu.UnderlineNone,
				strike:    c.Strikethrough, inverse: c.Inverse,
				selected: selected,
			}
			if key != runKey {
				flush(x)
				runStart = x
				runKey = key
				if _, ok := styles[key]; !ok {
					styles[key] = styleForKey(key)
				}
			}
			width += max(1, c.Width)
			if width >= w {
				break
			}
		}
		flush(len(row))
		rendered := b.String()
		lineWidth := lg.Width(rendered)
		if lineWidth < w {
			rendered += strings.Repeat(" ", w-lineWidth)
		}
		lines = append(lines, rendered)
	}
	return lines
}

func (m *tuiModel) activeTabKeyOrZero() paneKey {
	key, _ := m.activeTabKey()
	return key
}

func inSelection(sel selectionState, x, y int) bool {
	s, e := sel.start, sel.end
	if s.Y > e.Y || (s.Y == e.Y && s.X > e.X) {
		s, e = e, s
	}
	if y < s.Y || y > e.Y {
		return false
	}
	if s.Y == e.Y {
		return x >= s.X && x <= e.X
	}
	if y == s.Y {
		return x >= s.X
	}
	if y == e.Y {
		return x <= e.X
	}
	return true
}

// ---- diff ----

func (m *tuiModel) renderDiffPanel() string {
	r := m.diffRect()
	if r.empty() {
		return ""
	}
	innerW, innerH := r.W-2, r.H-2
	accent := m.accentColor()
	var lines []string
	header := "DIFF"
	if m.diff.project != "" {
		header += " · " + menuLabel(m.diff.project)
	}
	if m.diff.searchActive {
		header += " /" + m.diff.search.value
	} else if m.diff.search.value != "" {
		header += fmt.Sprintf(" /%s (%d)", m.diff.search.value, len(m.diff.matches))
	}
	lines = append(lines, lg.NewStyle().Foreground(accent).Bold(true).Render(header))
	if m.diff.loading {
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("loading…"))
	} else if m.diff.err != "" {
		lines = append(lines, lg.NewStyle().Foreground(tuiError).Render("diff failed: "+m.diff.err))
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("[r] retry  [d] close"))
	} else if len(m.diff.lines) == 0 {
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("no changes"))
	} else {
		visible := innerH - 1
		if visible < 1 {
			visible = 1
		}
		start := m.diff.scroll
		if start > len(m.diff.lines)-1 {
			start = max(0, len(m.diff.lines)-1)
		}
		for i := 0; i < visible && start+i < len(m.diff.lines); i++ {
			line := m.diff.lines[start+i]
			style := lg.NewStyle().Foreground(tuiFgColor())
			switch {
			case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
				style = lg.NewStyle().Foreground(tuiMuted)
			case strings.HasPrefix(line, "+"):
				style = lg.NewStyle().Foreground(tuiOK)
			case strings.HasPrefix(line, "-"):
				style = lg.NewStyle().Foreground(tuiError)
			case strings.HasPrefix(line, "@@"):
				style = lg.NewStyle().Foreground(accent)
			}
			if m.diff.search.value != "" && strings.Contains(strings.ToLower(line), strings.ToLower(m.diff.search.value)) {
				style = style.Background(lg.Color("#3a3f52"))
			}
			if lg.Width(line) > innerW {
				line = truncateCells(line, innerW)
			}
			lines = append(lines, style.Render(line))
		}
	}
	for len(lines) < innerH {
		lines = append(lines, "")
	}
	if len(lines) > innerH {
		lines = lines[:innerH]
	}
	return m.panelStyle(innerW, innerH, m.focus == focusDiff).Render(strings.Join(lines, "\n"))
}

func truncateCells(s string, w int) string {
	var b strings.Builder
	width := 0
	for _, r := range s {
		rw := 1
		if r > 0x1100 {
			rw = 2
		}
		if width+rw > w {
			break
		}
		b.WriteRune(r)
		width += rw
	}
	return b.String()
}

// ---- footer ----

func (m *tuiModel) renderFooter() string {
	accent := m.accentColor()
	status := m.status
	style := lg.NewStyle().Foreground(tuiMuted)
	if m.statusErr {
		style = lg.NewStyle().Foreground(tuiError)
	}
	left := style.Render(" " + status)
	hints := "Ctrl-] commands  Tab focus  [n] new  [d] diff  [?] help"
	if m.prefix {
		hints = "prefix: 1-9 servers  b rail  s sessions  t tabs  d diff  h history  n new  q quit  ? help"
	}
	right := lg.NewStyle().Foreground(accent).Render(hints + " ")
	gap := m.width - lg.Width(left) - lg.Width(right)
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

// ---- modal overlay ----

func (m *tuiModel) overlayModal(base string) string {
	content := m.renderModal()
	if content == "" {
		return base
	}
	w := lg.Width(content)
	h := lg.Height(content)
	x := max(0, (m.width-w)/2)
	y := max(0, (m.height-h)/2)
	comp := lg.NewCompositor(
		lg.NewLayer(base).Z(0),
		lg.NewLayer(content).X(x).Y(y).Z(1),
	)
	return comp.Render()
}

func (m *tuiModel) renderModal() string {
	accent := m.accentColor()
	title := lg.NewStyle().Foreground(accent).Bold(true).Render(m.modal.title)
	var body strings.Builder
	body.WriteString(title)
	body.WriteString("\n\n")
	switch m.modal.kind {
	case modalAddServer, modalRenameServer, modalRenamePane:
		body.WriteString(m.renderField(false))
		if m.modal.help != "" {
			body.WriteString("\n\n")
			body.WriteString(lg.NewStyle().Foreground(tuiMuted).Render(m.modal.help))
		}
	case modalPassword:
		body.WriteString(m.renderField(true))
	case modalProject:
		body.WriteString(m.renderField(false))
		body.WriteString("\n")
		body.WriteString(m.renderItems(10))
		if m.modal.help != "" {
			body.WriteString("\n")
			body.WriteString(lg.NewStyle().Foreground(tuiMuted).Render(m.modal.help))
		}
	case modalWorktree, modalCoder:
		body.WriteString(m.renderItems(14))
	case modalHistory:
		body.WriteString(m.renderHistory())
	case modalHelp:
		body.WriteString(lg.NewStyle().Foreground(tuiFgColor()).Render(m.modal.help))
	}
	if m.modal.err != "" {
		body.WriteString("\n\n")
		body.WriteString(lg.NewStyle().Foreground(tuiError).Render(m.modal.err))
	}
	if m.modal.busy {
		body.WriteString("\n\n")
		body.WriteString(lg.NewStyle().Foreground(tuiMuted).Render("working…"))
	}
	footer := "\n\n" + lg.NewStyle().Foreground(tuiMuted).Render("Enter confirm   Esc cancel")
	if m.modal.kind == modalHistory {
		footer = "\n\n" + lg.NewStyle().Foreground(tuiMuted).Render("↑↓ scroll   [y] copy   Esc close")
	}
	content := body.String() + footer
	return lg.NewStyle().
		Border(lg.RoundedBorder()).
		BorderForeground(accent).
		Padding(0, 1).
		MaxWidth(max(30, min(100, m.width-8))).
		Render(content)
}

func (m *tuiModel) renderField(masked bool) string {
	value := m.modal.field.value
	if masked {
		value = strings.Repeat("•", len([]rune(value)))
	}
	runes := []rune(value)
	cursor := m.modal.field.cursor
	if cursor > len(runes) {
		cursor = len(runes)
	}
	before := string(runes[:cursor])
	after := string(runes[cursor:])
	return lg.NewStyle().Foreground(tuiFgColor()).Render("  "+before) +
		lg.NewStyle().Reverse(true).Render(" ") +
		lg.NewStyle().Foreground(tuiFgColor()).Render(after)
}

func (m *tuiModel) renderItems(maxItems int) string {
	var b strings.Builder
	start := 0
	if m.modal.cursor >= maxItems {
		start = m.modal.cursor - maxItems + 1
	}
	for i := start; i < len(m.modal.items) && i < start+maxItems; i++ {
		item := m.modal.items[i]
		label := item.label
		if lg.Width(label) > 70 {
			label = truncateCells(label, 70)
		}
		if i == m.modal.cursor {
			b.WriteString(lg.NewStyle().Foreground(m.accentColor()).Background(lg.Color("#1d1f27")).Render("› " + label))
		} else {
			b.WriteString(lg.NewStyle().Foreground(tuiFgColor()).Render("  " + label))
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *tuiModel) renderHistory() string {
	if m.history.loading {
		return lg.NewStyle().Foreground(tuiMuted).Render("loading bounded recording window…")
	}
	if m.history.err != "" {
		return lg.NewStyle().Foreground(tuiError).Render("history failed: " + m.history.err)
	}
	if len(m.history.lines) == 0 {
		return lg.NewStyle().Foreground(tuiMuted).Render("no retained output")
	}
	height := max(6, min(24, m.height-12))
	width := max(40, min(110, m.width-12))
	start := m.history.scroll
	if start > len(m.history.lines)-1 {
		start = max(0, len(m.history.lines)-1)
	}
	var b strings.Builder
	for i := 0; i < height && start+i < len(m.history.lines); i++ {
		line := m.history.lines[start+i]
		if lg.Width(line) > width {
			line = truncateCells(line, width)
		}
		b.WriteString(lg.NewStyle().Foreground(tuiFgColor()).Render(line))
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
