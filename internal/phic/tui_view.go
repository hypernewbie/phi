package phic

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	lg "charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
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
	return lg.Color("#" + m.accentHex())
}

func (m *tuiModel) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.ReportFocus = true
	v.KeyboardEnhancements.ReportEventTypes = true
	label := "phic"
	if s := m.currentServer(); s != nil {
		label = m.railLabel(s) + " · phic"
	}
	v.WindowTitle = sanitizeMetadata(label)
	if m.focus == focusTerminal && m.modal.kind == modalNone {
		if tab := m.activeTabModel(); tab != nil && !tab.exited {
			if frame, ok := tab.actorSnapshot(); ok && !frame.Cursor.Hidden {
				r := m.terminalInner()
				if frame.Cursor.X >= 0 && frame.Cursor.X < r.W && frame.Cursor.Y >= 0 && frame.Cursor.Y < r.H {
					v.Cursor = tea.NewCursor(r.X+frame.Cursor.X, r.Y+frame.Cursor.Y)
				}
			}
		}
	}
	return v
}

func (m *tuiModel) render() string {
	if m.modal.kind == modalMarkdown {
		return fitScreen(m.renderMarkdownModal(), m.width, m.height)
	}
	if m.modal.kind == modalDiff {
		return m.renderDiffModal()
	}
	rail := m.renderRail()
	context := m.renderContext()
	tabs := m.renderTabs()
	body := m.renderBody()
	footer := m.renderFooter()
	base := strings.Join([]string{rail, context, tabs, body, footer}, "\n")
	if m.modal.kind == modalNone {
		if !m.showSidebar() && m.focus == focusSessions {
			base = lg.NewCompositor(lg.NewLayer(base), lg.NewLayer(m.renderSidebar()).X(0).Y(3).Z(1)).Render()
		} else if m.width < 120 && m.diff.open && m.focus == focusDiff {
			r := m.diffRect()
			base = lg.NewCompositor(lg.NewLayer(base), lg.NewLayer(m.renderDiffPanel()).X(r.X).Y(r.Y).Z(1)).Render()
		}
	}
	if m.modal.kind != modalNone {
		base = m.overlayModal(base)
	} else if box, bx, by := m.composeBox(); box != "" {
		base = overlayLines(base, box, bx, by, m.width, m.height)
	}
	return fitScreen(base, m.width, m.height)
}

// ---- chrome ----

func (m *tuiModel) renderRail() string {
	logo, name := m.brandStyles(m.cpuTiers[m.currentOrigin()])
	var b strings.Builder
	b.WriteString(logo.Render(" Φ"))
	b.WriteString(name.Render(" Phi "))
	accent := m.accentColor()
	glyphs := serverGlyphs(m.servers)
	for i, s := range m.servers {
		label := m.railLabel(s)
		glyph := glyphs[i]
		if m.prefix && i < 9 {
			// Prefix mode: show the 1-9 digit that jumps to this server
			// so the choice needs no counting. Colors stay exactly as
			// cached; servers past 9 keep their Greek glyph.
			glyph = string(rune('1' + i))
		}
		if i == m.active {
			b.WriteString(lg.NewStyle().
				Foreground(accent).Bold(true).
				Background(lg.Color("#1d1f27")).
				Render(" " + glyph + " " + label + " "))
		} else {
			color := tuiMuted
			if s.health != "up" {
				color = lg.Color("#78768a")
			}
			b.WriteString(lg.NewStyle().Foreground(color).Render(" " + glyph + " " + label + " "))
		}
	}
	b.WriteString(lg.NewStyle().Foreground(accent).Render(" [+]"))
	left := b.String()
	right := lg.NewStyle().Foreground(accent).Render("[▥] [↻]") + " " + m.connectionLabel() + m.batteryLabel()
	gap := m.width - lg.Width(left) - lg.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right + " "
}

func (m *tuiModel) connectionLabel() string {
	s := m.currentServer()
	if s == nil {
		return lg.NewStyle().Foreground(tuiMuted).Render("○")
	}
	d := m.current()
	if d != nil && d.needAuth {
		return lg.NewStyle().Foreground(lg.Color("#fbbf24")).Render("◇")
	}
	if d != nil && d.err != "" {
		return lg.NewStyle().Foreground(tuiError).Render("!")
	}
	if d != nil && !d.loaded {
		return lg.NewStyle().Foreground(tuiMuted).Render("◌")
	}
	switch s.health {
	case "up":
		return lg.NewStyle().Foreground(m.accentColor()).Render("●")
	default:
		return lg.NewStyle().Foreground(lg.Color("#fbbf24")).Render("○")
	}
}

func (m *tuiModel) renderContext() string { return m.contextLayout().text }

func (m *tuiModel) contextLayout() chromeLine {
	accent := m.accentColor()
	muted := lg.NewStyle().Foreground(tuiMuted)
	focus := func(s string) string {
		if m.focus == focusTerminal {
			return s
		}
		return lg.NewStyle().Foreground(accent).Render(s)
	}
	project := compactContextPath(m.project, 14)
	if project == "" {
		project = "(choose project)"
	}
	worktree := compactContextPath(m.worktree, 10)
	if worktree == "" {
		worktree = "default"
	}
	coder := "—"
	if c, ok := m.selectedCoder(); ok {
		coder = truncateCells(menuLabel(c.Name), 12)
	}
	parts := []string{
		muted.Render("Project:") + " " + focus(project) + muted.Render(" [p]"),
		muted.Render("Worktree:") + " " + focus(worktree) + muted.Render(" [w]"),
		muted.Render("Coder:") + " " + focus(coder) + muted.Render(" [c]"),
		lg.NewStyle().Foreground(accent).Render("[n] New Session"),
	}
	if m.width < 100 {
		parts = []string{"P: " + project + " [p]", "W: " + worktree + " [w]", "C: " + coder + " [c]", "[n] New"}
	}
	if m.width < 70 {
		parts = []string{"P: " + truncateCells(project, 8) + " [p]", "C: " + truncateCells(coder, 8) + " [c]", "[n] New"}
	}
	actions := []string{"project", "worktree", "coder", "new"}
	if m.width < 70 {
		actions = []string{"project", "coder", "new"}
	}
	var line chromeLine
	line.append(" ", "")
	for i, part := range parts {
		if i > 0 {
			line.append("  ", "")
		}
		line.append(part, actions[i])
	}
	diffLabel := "Diff [d]"
	if m.diff.open {
		diffLabel = "Diff ● [d]"
	}
	right := lg.NewStyle().Foreground(accent).Render(diffLabel)
	gap := m.width - lg.Width(line.text) - lg.Width(right) - 1
	if gap < 1 {
		gap = 1
	}
	line.append(strings.Repeat(" ", gap), "")
	line.append(right, "diff")
	return line
}

const tabControls = " [x] close  [u] undo"
const tabTitleMaxCells = 20

// Rendering and mouse hits share the same cell-bounded title, including ellipsis.
func (m *tuiModel) tabTitle(t *paneTab) string {
	limit := min(tabTitleMaxCells, max(3, m.width-48))
	return ansi.Truncate(t.label(), limit, "…")
}

// tabStripLayout computes the visible tab window shared by rendering and
// mouse hit-testing so clicks land on the painted tab.
func (m *tuiModel) tabStripLayout() (labels []string, widths []int, start, end, offset int) {
	origin := m.currentOrigin()
	tabs := m.tabs[origin]
	labels = make([]string, len(tabs))
	widths = make([]int, len(tabs))
	total := 0
	active := m.activeTab[origin]
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
		title := m.tabTitle(t)
		label := " " + mark + " " + title + " "
		if t.unread && i != active {
			label = " " + mark + " " + title + "• "
		}
		if t.view.Pinned {
			label = " " + mark + " " + title + " ⌂ "
		}
		labels[i] = label
		widths[i] = ansi.StringWidth(label)
		total += widths[i]
	}
	avail := m.width - ansi.StringWidth(" ▣ ") - ansi.StringWidth(tabControls) - 6
	start, end = 0, len(tabs)
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
	offset = ansi.StringWidth(" ▣ ")
	if start > 0 {
		offset += ansi.StringWidth(fmt.Sprintf("+%d ", start))
	}
	return labels, widths, start, end, offset
}

func (m *tuiModel) renderTabs() string {
	accent := m.accentColor()
	muted := lg.NewStyle().Foreground(tuiMuted)
	origin := m.currentOrigin()
	tabs := m.tabs[origin]
	prefix := muted.Render(" ▣ ")
	suffix := muted.Render(tabControls)
	if len(tabs) == 0 {
		return prefix + muted.Render("no open panes — [n] New Session")
	}
	labels, _, start, end, _ := m.tabStripLayout()
	active := m.activeTab[origin]
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
		Width(w + 2).
		Height(h + 2)
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
	start := m.sidebarStart()
	for i := start; i < len(rows); i++ {
		row := rows[i]
		if i-start >= innerH-3 {
			lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("…"))
			break
		}
		var text string
		switch row.kind {
		case rowNewSession:
			text = "+ New Session"
		case rowSession:
			when := row.session.TimeUpdated.Format("01-02")
			text = "↩ " + menuLabel(row.label) + "  " + when
		case rowLivePane:
			attached := ""
			if row.pane.ActiveWSCount > 0 {
				attached = fmt.Sprintf(" (attached x%d)", row.pane.ActiveWSCount)
			}
			text = "● " + menuLabel(row.label) + attached
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
	return m.panelStyle(innerW, innerH, m.focus == focusSessions).Render(fitScreen(content, innerW, innerH))
}

func tuiFgColor() color.Color { return lg.Color(tuiFgDefault) }

func compactContextPath(path string, width int) string {
	path = strings.TrimRight(menuLabel(path), "/\\")
	if i := strings.LastIndexAny(path, "/\\"); i >= 0 {
		path = path[i+1:]
	}
	return truncateCells(path, width)
}

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
		lines = m.renderEmptyTerminal(innerW, innerH)
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
	lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render(truncateCells(text, w)))
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
	underline termemu.Underline
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

// agyAnsiColor mirrors web/terminal.js getTerminalTheme for Agy's ANSI slots.
// The native client always applies this mapping to Agy tabs; other coders keep
// the user's terminal palette untouched.
func agyAnsiColor(c termemu.Color, theme string) termemu.Color {
	if c.Kind != termemu.ColorPalette {
		return c
	}
	if _, ok := phiAccents[theme]; !ok {
		theme = "purple"
	}
	hex := ""
	switch c.Value {
	case 4:
		hex = phiAgyAnsiTones[theme].Dim
	case 5, 6:
		hex = phiAccents[theme]
	case 12, 13, 14:
		hex = phiAgyAnsiTones[theme].Bright
	default:
		return c
	}
	value, err := strconv.ParseUint(hex, 16, 32)
	if err != nil {
		return c
	}
	return termemu.Color{Kind: termemu.ColorRGB, Value: uint32(value)}
}

func styleForKey(k cellStyleKey, agyTheme string) lg.Style {
	fgColor := termemu.Color{Kind: k.fgKind, Value: k.fg}
	bgColor := termemu.Color{Kind: k.bgKind, Value: k.bg}
	if agyTheme != "" {
		fgColor = agyAnsiColor(fgColor, agyTheme)
		bgColor = agyAnsiColor(bgColor, agyTheme)
	}
	fg := resolveColor(fgColor, tuiFgDefault)
	bg := resolveColor(bgColor, "")
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
		selectionBg := "#82aaff"
		if agyTheme != "" {
			selectionBg = "#" + phiAccents[agyTheme]
		}
		fg, bg = tuiBgDefault, selectionBg
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
	if k.underline != termemu.UnderlineNone {
		st = st.UnderlineStyle(lg.Underline(k.underline))
	}
	if k.strike {
		st = st.Strikethrough(true)
	}
	return st
}

// renderFrameLines returns one final string per visible row. Rows whose
// emulator cells are exactly unchanged reuse the cached string from the
// last render through the shared termemu row delta: a single changed
// character re-renders one row, not the screen. Reuse is gated on
// cell-for-cell equality (plus viewport width and selection generation),
// so cached output is byte-identical to a full render. The pane actor is
// deliberately untouched: it keeps full snapshots every paint, and the
// selection generation derives from m.selection here, so no mutation site
// can forget to invalidate the cache.
func (m *tuiModel) renderFrameLines(tab *paneTab, frame termemu.Frame, w, h int) []string {
	sel := m.selection
	if sel != tab.lastSel {
		tab.selGen++
		tab.lastSel = sel
	}
	agyTheme := ""
	if tab.coder == "agy" {
		agyTheme = "purple"
		if data := m.data[tab.key.Origin]; data != nil {
			if _, ok := phiAccents[data.identity.Theme]; ok {
				agyTheme = data.identity.Theme
			}
		}
		if tab.lastAgyTheme != agyTheme {
			tab.rows.Reset()
			tab.lastAgyTheme = agyTheme
		}
	}
	selectionOn := sel.active && tab.key == m.activeTabKeyOrZero()
	styles := map[cellStyleKey]lg.Style{}
	return tab.rows.Update(frame, h, w, tab.selGen, func(y int, row []termemu.Cell) string {
		return m.renderOneFrameRow(row, y, w, styles, selectionOn, sel, agyTheme)
	})
}

func (m *tuiModel) renderOneFrameRow(row []termemu.Cell, y, w int, styles map[cellStyleKey]lg.Style, selectionOn bool, sel selectionState, agyTheme string) string {
	if row == nil {
		return ""
	}
	var b strings.Builder
	width := 0
	endCol := 0
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
			st = styleForKey(runKey, agyTheme)
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
			underline: c.Underline,
			strike:    c.Strikethrough, inverse: c.Inverse,
			selected: selected,
		}
		if key != runKey {
			flush(x)
			runStart = x
			runKey = key
			if _, ok := styles[key]; !ok {
				styles[key] = styleForKey(key, agyTheme)
			}
		}
		if width+c.Width > w {
			break
		}
		width += max(1, c.Width)
		endCol = x + 1
		if width >= w {
			break
		}
	}
	flush(endCol)
	rendered := b.String()
	lineWidth := lg.Width(rendered)
	if lineWidth < w {
		rendered += strings.Repeat(" ", w-lineWidth)
	}
	return truncateCells(rendered, w)
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
	if m.diff.markdown {
		return m.renderMarkdownPanel()
	}
	r := m.diffRect()
	if r.empty() {
		return ""
	}
	innerW, innerH := r.W-2, r.H-2
	accent := lg.NewStyle().Foreground(m.accentColor()).Bold(true)
	header := m.renderReaderTabs()
	if m.diff.project != "" {
		header += " · " + menuLabel(m.diff.project)
	}
	lines := []string{accent.Render(header), ""}
	visible := max(1, innerH-2)
	switch {
	case m.diff.loading:
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("loading commits…"))
	case m.diff.err != "":
		lines = append(lines, lg.NewStyle().Foreground(tuiError).Render(menuLabel(m.diff.err)))
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("[r] retry"))
	case len(m.diff.commits) == 0:
		lines = append(lines, lg.NewStyle().Foreground(tuiMuted).Render("No commits"))
	default:
		start := m.diff.commitListStart(visible)
		for i := start; i < len(m.diff.commits) && i < start+visible; i++ {
			commit := m.diff.commits[i]
			label := diffCommitOptionLabel(commit)
			if lg.Width(label) > innerW-3 {
				label = truncateCells(label, innerW-3)
			}
			style := lg.NewStyle().Foreground(tuiFgColor())
			prefix := "  "
			if i == m.diff.cursor {
				prefix = "› "
				style = style.Foreground(m.accentColor()).Bold(true).Background(lg.Color("#1d1f27"))
			}
			lines = append(lines, style.Render(prefix+label))
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
	return ansi.Truncate(s, max(0, w), "")
}

func fitScreen(s string, w, h int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > h {
		lines = lines[:h]
	}
	for len(lines) < h {
		lines = append(lines, "")
	}
	for i := range lines {
		lines[i] = truncateCells(lines[i], w)
	}
	return strings.Join(lines, "\n")
}

// ---- footer ----

func (m *tuiModel) renderFooter() string {
	accent := m.accentColor()
	status := menuLabel(m.status)
	if d := m.current(); d != nil && d.loginWarning != "" {
		status += " · login not saved: " + menuLabel(d.loginWarning)
	}
	style := lg.NewStyle().Foreground(tuiMuted)
	if m.statusErr {
		style = lg.NewStyle().Foreground(tuiError)
	}
	left := style.Render(" " + status)
	hints := "Ctrl-] commands  Tab focus  [n] new  [d] diff  [?] help"
	if m.focus == focusTerminal {
		if tab := m.activeTabModel(); tab != nil && tab.actor != nil {
			history := tab.actor.historyViewCopy()
			switch {
			case history.Loading:
				hints = "Loading older history…  Ctrl-] End live"
			case history.Older && history.NearTop:
				hints = "Ctrl-] PgUp older history  Ctrl-] End live  Ctrl-] ? help"
			case history.Browsing:
				hints = "Ctrl-] End live  Ctrl-] ? help"
			}
		}
	}
	if m.focus == focusDiff {
		hints = "Enter pretty diff  ↑↓ commits  Tab Markdown  [ ] width  Esc terminal"
	}
	if !m.chromeEscAt.IsZero() {
		hints = "Esc again: Quit dialog · any other key cancels"
	}
	if m.prefix {
		hints = "prefix: 1-9 servers  b rail  s sessions  t tabs  x close  u undo  d reader  M Markdown  q quit  ? help"
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
	case modalQuit:
		body.WriteString("Close this console? Server panes are not deleted.\n\n[q] Quit client    [Esc] Cancel\n\nEnter cancels. Nothing closes without confirmation.")
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
	case modalWorktree, modalCoder, modalOpenCode:
		body.WriteString(m.renderItems(14))
	case modalHistory:
		body.WriteString(m.renderHistory())
	case modalDiffSelect:
		body.WriteString(m.renderItems(14))
		if m.modal.help != "" {
			body.WriteString("\n\n")
			body.WriteString(lg.NewStyle().Foreground(tuiMuted).Render(m.modal.help))
		}
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
		footer = "\n\n" + lg.NewStyle().Foreground(tuiMuted).Render("↑↓ scroll  [/] earlier/later  x hex  y copy  Esc close")
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
	before := menuLabel(string(runes[:cursor]))
	after := menuLabel(string(runes[cursor:]))
	return lg.NewStyle().Foreground(tuiFgColor()).Render("  "+before) +
		lg.NewStyle().Reverse(true).Render(" ") +
		lg.NewStyle().Foreground(tuiFgColor()).Render(after)
}

func (m *tuiModel) renderItems(maxItems int) string {
	var b strings.Builder
	start, end := m.visibleModalItems(maxItems)
	for i := start; i < end; i++ {
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
	b.WriteString(fmt.Sprintf("Source bytes [%d,%d) of %d · text/hex\n", m.history.start, m.history.end, m.history.head))
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
