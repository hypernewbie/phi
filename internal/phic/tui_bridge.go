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

// Pi controls panel: the native mirror of the web's Pi header buttons. It
// drives the live Pi session of the active pane through the bridge API —
// model switch, thinking level, skill invoke, native compaction, and the
// fixed /reload command. Every action reports the server's safe outcome
// vocabulary; nothing here trusts raw provider errors.

type bridgeSection int

const (
	sectionModels bridgeSection = iota
	sectionThinking
	sectionSkills
	sectionCount
)

func (s bridgeSection) label() string {
	switch s {
	case sectionModels:
		return "Models"
	case sectionThinking:
		return "Thinking"
	case sectionSkills:
		return "Skills"
	}
	return "?"
}

// bridgePanelState is the modal's working set. Loads are ticketed so a
// stale reply cannot overwrite a newer panel; actions set busy until their
// reply lands.
type bridgePanelState struct {
	pane    string
	section bridgeSection
	cursor  int
	ticket  int

	models       bridgeCatalog
	thinkingList bridgeThinking
	skillsList   bridgeSkills

	// Per-section load errors so switching sections after a mixed load
	// shows the error of the section being viewed.
	modelsErr, thinkingErr, skillsErr string

	loading bool
	busy    bool
	err     string
	notice  string
}

// sectionErr reports the stored load error of one section.
func (b *bridgePanelState) sectionErr(section bridgeSection) string {
	switch section {
	case sectionModels:
		return b.modelsErr
	case sectionThinking:
		return b.thinkingErr
	case sectionSkills:
		return b.skillsErr
	}
	return ""
}

// bridgePanelMsg carries one ticketed load of all three lists.
type bridgePanelMsg struct {
	gen, ticket  int
	pane         string
	models       bridgeCatalog
	thinkingList bridgeThinking
	skillsList   bridgeSkills
	err          string
	modelsErr    string
	thinkingErr  string
	skillsErr    string
}

// bridgeActionMsg carries one apply/invoke/compact/reload reply.
type bridgeActionMsg struct {
	gen     int
	pane    string
	kind    string // "model", "thinking", "skill", "compact", "reload"
	detail  string
	outcome string // safe outcome word for compact/reload
	reason  string
	err     string
}

// bridgeCtx bounds one bridge call. Compact can wait behind native provider
// work for minutes; everything else is short local IPC.
const (
	bridgeCallTimeout  = 35 * time.Second
	bridgeCompactLimit = 125 * time.Second
)

// openBridgePanel opens the Pi controls for the active pane. It needs a
// live tab; a pane without bridge state still opens and shows the server's
// unavailable answer rather than guessing.
func (m *tuiModel) openBridgePanel() tea.Cmd {
	tab := m.activeTabModel()
	if tab == nil || tab.actor == nil {
		m.setStatus("no live terminal for Pi controls", true)
		return nil
	}
	m.modal.open(modalBridge, "Pi controls")
	m.modal.origin = m.currentOrigin()
	m.bridge = bridgePanelState{pane: tab.key.ID, loading: true}
	m.bridge.ticket++
	return m.loadBridgePanel(m.bridge.ticket)
}

// loadBridgePanel fetches all three lists in one bounded call each. The
// per-list errors are kept apart so one unavailable surface does not hide
// the others.
func (m *tuiModel) loadBridgePanel(ticket int) tea.Cmd {
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.bridge.loading = false
		m.bridge.err = "server unavailable"
		return nil
	}
	api := s.api
	pane := m.bridge.pane
	gen := m.gen
	return func() tea.Msg {
		out := bridgePanelMsg{gen: gen, ticket: ticket, pane: pane}
		ctx, cancel := context.WithTimeout(context.Background(), bridgeCallTimeout)
		defer cancel()
		if v, err := api.BridgeModels(ctx, pane); err != nil {
			out.modelsErr = err.Error()
		} else {
			out.models = v
		}
		if v, err := api.BridgeThinking(ctx, pane); err != nil {
			out.thinkingErr = err.Error()
		} else {
			out.thinkingList = v
		}
		if v, err := api.BridgeSkills(ctx, pane); err != nil {
			out.skillsErr = err.Error()
		} else {
			out.skillsList = v
		}
		return out
	}
}

// handleBridgePanelMsg applies one load reply when it is still current.
func (m *tuiModel) handleBridgePanelMsg(msg bridgePanelMsg) tea.Cmd {
	if msg.gen != m.gen || m.modal.kind != modalBridge || msg.pane != m.bridge.pane || msg.ticket != m.bridge.ticket {
		return nil
	}
	m.bridge.loading = false
	m.bridge.models = msg.models
	m.bridge.thinkingList = msg.thinkingList
	m.bridge.skillsList = msg.skillsList
	m.bridge.modelsErr = msg.modelsErr
	m.bridge.thinkingErr = msg.thinkingErr
	m.bridge.skillsErr = msg.skillsErr
	m.bridge.err = m.bridge.sectionErr(m.bridge.section)
	m.bridge.cursor = 0
	return nil
}

// handleBridgeActionMsg applies one action reply.
func (m *tuiModel) handleBridgeActionMsg(msg bridgeActionMsg) tea.Cmd {
	if msg.gen != m.gen {
		// A reset console cannot present this result; drop it entirely.
		return nil
	}
	if m.modal.kind != modalBridge || msg.pane != m.bridge.pane {
		// The panel moved on, but the action still happened: surface it
		// on the status line only.
		m.setStatus(bridgeActionNotice(msg), msg.err != "")
		return nil
	}
	m.bridge.busy = false
	m.setStatus(bridgeActionNotice(msg), msg.err != "")
	if msg.err != "" || msg.kind == "" {
		return nil
	}
	// A successful set or invoke ends with the list re-read, exactly like
	// the web refreshes its header after a control.
	m.bridge.notice = bridgeActionNotice(msg)
	if msg.kind == "model" || msg.kind == "thinking" || msg.kind == "skill" {
		m.bridge.ticket++
		m.bridge.loading = true
		return m.loadBridgePanel(m.bridge.ticket)
	}
	return nil
}

// bridgeActionNotice renders one reply in the safe vocabulary.
func bridgeActionNotice(msg bridgeActionMsg) string {
	if msg.err != "" {
		return msg.kind + ": " + msg.err
	}
	switch msg.kind {
	case "compact", "reload":
		note := msg.kind + ": " + msg.outcome
		if msg.reason != "" {
			note += " (" + msg.reason + ")"
		}
		return note
	default:
		if msg.reason != "" {
			return msg.kind + " refused: " + msg.reason
		}
		return msg.kind + " " + msg.detail + " sent"
	}
}

// bridgeItemCount is the row count of the active section.
func (b *bridgePanelState) itemCount() int {
	switch b.section {
	case sectionModels:
		return len(b.models.Models)
	case sectionThinking:
		return len(b.thinkingList.Levels)
	case sectionSkills:
		return len(b.skillsList.Skills)
	}
	return 0
}

// handleBridgeModalKey drives the panel: 1/2/3 switch sections, arrows
// move, Enter applies, c compacts, r reloads, Esc closes.
func (m *tuiModel) handleBridgeModalKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := msg.Key()
	k.Code = chromeKeyCode(k)
	if k.Code == tea.KeyEscape {
		m.closeModal()
		m.focus = focusTerminal
		return m, nil
	}
	if m.bridge.busy {
		return m, nil
	}
	switch k.Code {
	case '1', '2', '3':
		m.bridge.section = bridgeSection(int(k.Code - '1'))
		m.bridge.cursor = 0
		m.bridge.err = m.bridge.sectionErr(m.bridge.section)
		m.bridge.notice = ""
		return m, nil
	case tea.KeyUp:
		if m.bridge.cursor > 0 {
			m.bridge.cursor--
		}
		return m, nil
	case tea.KeyDown:
		if m.bridge.cursor < m.bridge.itemCount()-1 {
			m.bridge.cursor++
		}
		return m, nil
	case tea.KeyEnter:
		return m, m.applyBridgeSelection()
	case 'c':
		return m, m.bridgeCompactCmd()
	case 'r':
		return m, m.bridgeReloadCmd()
	}
	return m, nil
}

// applyBridgeSelection sends the highlighted row of the active section.
func (m *tuiModel) applyBridgeSelection() tea.Cmd {
	if m.bridge.loading {
		return nil
	}
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.bridge.err = "server unavailable"
		return nil
	}
	api, pane := s.api, m.bridge.pane
	gen := m.gen
	switch m.bridge.section {
	case sectionModels:
		if m.bridge.cursor >= len(m.bridge.models.Models) {
			return nil
		}
		entry := m.bridge.models.Models[m.bridge.cursor]
		m.bridge.busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), bridgeCallTimeout)
			defer cancel()
			ack, err := api.BridgeSetModel(ctx, pane, entry.Provider, entry.ID)
			out := bridgeActionMsg{gen: gen, pane: pane, kind: "model", detail: entry.label()}
			if err != nil {
				out.err = err.Error()
			} else if !ack.OK {
				out.reason = ack.Reason
			}
			return out
		}
	case sectionThinking:
		if m.bridge.cursor >= len(m.bridge.thinkingList.Levels) {
			return nil
		}
		level := m.bridge.thinkingList.Levels[m.bridge.cursor]
		origin := m.bridge.thinkingList
		m.bridge.busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), bridgeCallTimeout)
			defer cancel()
			ack, err := api.BridgeSetThinking(ctx, pane, level, origin.Provider, origin.Model, origin.ProcessID, origin.Generation)
			out := bridgeActionMsg{gen: gen, pane: pane, kind: "thinking", detail: level}
			if err != nil {
				out.err = err.Error()
			} else if !ack.OK {
				out.reason = ack.Reason
			}
			return out
		}
	case sectionSkills:
		if m.bridge.cursor >= len(m.bridge.skillsList.Skills) {
			return nil
		}
		skill := m.bridge.skillsList.Skills[m.bridge.cursor]
		origin := m.bridge.skillsList
		m.bridge.busy = true
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), bridgeCallTimeout)
			defer cancel()
			ack, err := api.BridgeInvokeSkill(ctx, pane, skill.Name, origin.ProcessID, origin.Generation)
			out := bridgeActionMsg{gen: gen, pane: pane, kind: "skill", detail: skill.Name}
			if err != nil {
				out.err = err.Error()
			} else if !ack.OK {
				out.reason = ack.Reason
			}
			return out
		}
	}
	return nil
}

// bridgeCompactCmd runs one native compaction with the pane's published
// stamps. Without a snapshot the request is refused locally instead of
// sending an origin the server must reject.
func (m *tuiModel) bridgeCompactCmd() tea.Cmd {
	tab := m.activeTabModel()
	if tab == nil || tab.bridge == nil || !tab.bridge.hasOrigin() {
		m.bridge.err = "waiting for Pi state; no compaction origin yet"
		return nil
	}
	snap := *tab.bridge
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.bridge.err = "server unavailable"
		return nil
	}
	api, pane, gen := s.api, m.bridge.pane, m.gen
	m.bridge.busy = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), bridgeCompactLimit)
		defer cancel()
		outcome, reason, err := api.BridgeCompact(ctx, pane, stampString(snap.generation), stampString(snap.telemetryRevision))
		return bridgeActionMsg{gen: gen, pane: pane, kind: "compact", outcome: outcome, reason: reason, err: errString(err)}
	}
}

// bridgeReloadCmd dispatches the fixed /reload command with the pane's
// published stamps.
func (m *tuiModel) bridgeReloadCmd() tea.Cmd {
	tab := m.activeTabModel()
	if tab == nil || tab.bridge == nil || !tab.bridge.hasOrigin() || tab.bridge.runID == 0 || tab.bridge.contextRevision == 0 {
		m.bridge.err = "waiting for Pi state; no reload origin yet"
		return nil
	}
	snap := *tab.bridge
	s := m.serverForOrigin(m.currentOrigin())
	if s == nil || s.api == nil {
		m.bridge.err = "server unavailable"
		return nil
	}
	api, pane, gen := s.api, m.bridge.pane, m.gen
	m.bridge.busy = true
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), bridgeCallTimeout)
		defer cancel()
		outcome, reason, err := api.BridgeReload(ctx, pane, snap.processID, stampString(snap.generation),
			stampString(snap.telemetryRevision), stampString(snap.runID), stampString(snap.contextRevision))
		return bridgeActionMsg{gen: gen, pane: pane, kind: "reload", outcome: outcome, reason: reason, err: errString(err)}
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// renderBridgeModal draws the panel: section tabs, the live Pi segment,
// the list of the active section, and the action hints.
func (m *tuiModel) renderBridgeModal() string {
	accent := m.accentColor()
	var b strings.Builder
	b.WriteString(lg.NewStyle().Foreground(accent).Bold(true).Render("Pi controls"))
	if tab := m.activeTabModel(); tab != nil {
		if label := tab.bridgeLabel(); label != "" {
			b.WriteString("  " + lg.NewStyle().Foreground(tuiMuted).Render(label))
		}
	}
	b.WriteString("\n")

	var tabs []string
	for i := bridgeSection(0); i < sectionCount; i++ {
		style := lg.NewStyle().Foreground(tuiMuted)
		if i == m.bridge.section {
			style = lg.NewStyle().Foreground(accent).Bold(true)
		}
		tabs = append(tabs, style.Render(fmt.Sprintf("[%d] %s", int(i)+1, i.label())))
	}
	b.WriteString(strings.Join(tabs, "  "))
	b.WriteString("\n\n")

	switch {
	case m.bridge.loading:
		b.WriteString(lg.NewStyle().Foreground(tuiMuted).Render("loading…"))
	case m.bridge.err != "":
		b.WriteString(lg.NewStyle().Foreground(tuiError).Render(m.bridge.err))
	default:
		b.WriteString(m.renderBridgeSection())
	}
	if m.bridge.notice != "" {
		b.WriteString("\n")
		b.WriteString(lg.NewStyle().Foreground(tuiMuted).Render(m.bridge.notice))
	}
	if m.bridge.busy {
		b.WriteString("\n")
		b.WriteString(lg.NewStyle().Foreground(tuiMuted).Render("working…"))
	}
	footer := "\n\n" + lg.NewStyle().Foreground(tuiMuted).Render("1-3 sections   Enter apply   c compact   r reload   Esc close")
	content := b.String() + footer
	return lg.NewStyle().
		Border(lg.RoundedBorder()).
		BorderForeground(accent).
		Padding(0, 1).
		MaxWidth(max(40, min(90, m.width-8))).
		Render(content)
}

// renderBridgeSection renders the rows of the active section with a marker
// for the live choice where the pane snapshot provides one. Rows keep the
// wire order: the cursor indexes the same slice the apply path uses.
func (m *tuiModel) renderBridgeSection() string {
	var rows []string
	live := ""
	if tab := m.activeTabModel(); tab != nil && tab.bridge != nil {
		if m.bridge.section == sectionModels {
			live = tab.bridge.model
		} else if m.bridge.section == sectionThinking {
			live = tab.bridge.thinkingLevel
		}
	}
	switch m.bridge.section {
	case sectionModels:
		for _, entry := range m.bridge.models.Models {
			rows = append(rows, entry.label())
		}
		if m.bridge.models.Truncated {
			rows = append(rows, "… list truncated by the server")
		}
	case sectionThinking:
		for _, level := range m.bridge.thinkingList.Levels {
			rows = append(rows, level)
		}
	case sectionSkills:
		for _, skill := range m.bridge.skillsList.Skills {
			if skill.Description != "" {
				rows = append(rows, skill.Name+" — "+skill.Description)
			} else {
				rows = append(rows, skill.Name)
			}
		}
		if m.bridge.skillsList.Truncated {
			rows = append(rows, "… list truncated by the server")
		}
	}
	if len(rows) == 0 {
		return lg.NewStyle().Foreground(tuiMuted).Render("nothing published for this pane")
	}
	var b strings.Builder
	for i, row := range rows {
		row = ansi.Truncate(row, 64, "…")
		marker := "  "
		if live != "" && strings.HasPrefix(row, live) {
			marker = "● "
		}
		if i == m.bridge.cursor {
			b.WriteString(lg.NewStyle().Foreground(m.accentColor()).Background(lg.Color("#1d1f27")).Render("› " + marker + row))
		} else {
			b.WriteString(lg.NewStyle().Foreground(tuiFgColor()).Render("  " + marker + row))
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
