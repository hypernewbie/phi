package phic

import tea "charm.land/bubbletea/v2"

type consoleResetMsg struct {
	token int
	keys  []paneKey
}

// Explicit Refresh is a client-side cold rebuild. Backend processes, pane IDs,
// recordings, tab order, drafts and selected server/coder remain untouched.
func (m *tuiModel) refreshConsole() tea.Cmd {
	if m.refreshing {
		return tea.ClearScreen
	}
	m.refreshing = true
	m.refreshToken++
	m.gen++ // Discard outstanding sidebar/auth/metadata results from before reset.
	token := m.refreshToken
	m.closeCompose()
	m.closeModal()
	m.mouseCapture = false
	m.selection = selectionState{}
	m.panelDrag = 0
	var keys []paneKey
	var actors []*paneActor
	for _, tabs := range m.tabs {
		for _, tab := range tabs {
			if tab.actor == nil || tab.exited {
				continue
			}
			keys = append(keys, tab.key)
			actors = append(actors, tab.actor)
			delete(m.actors, tab.key)
			tab.actor = nil
			tab.rows.Reset()
			tab.attached = false
			tab.fresh = false
			tab.status = "reconnecting"
		}
	}
	m.retiringActors = actors // Shutdown must join these even if Refresh is in flight.
	m.setStatus("reconnecting and rebuilding terminal state", false)
	stop := func() tea.Msg {
		// Cancel every owner before joining any one of them. Socket close wakes
		// blocked readers/writers; parser/history disposal stays with its actor.
		for _, actor := range actors {
			actor.cancel()
			if conn := actor.getConn(); conn != nil {
				_ = conn.Close()
			}
		}
		for _, actor := range actors {
			actor.close()
		}
		return consoleResetMsg{token: token, keys: keys}
	}
	return tea.Sequence(tea.ClearScreen, tea.RequestWindowSize, stop, m.reloadServersCmd())
}

func (m *tuiModel) applyConsoleReset(msg consoleResetMsg) (tea.Model, tea.Cmd) {
	if msg.token != m.refreshToken {
		return m, nil
	}
	m.refreshing = false
	m.retiringActors = nil
	for _, key := range msg.keys {
		tab := m.findTab(key)
		if tab == nil || tab.actor != nil || tab.exited || tab.closing || tab.finalizing {
			continue
		}
		m.attachTab(tab)
	}
	m.resizeActivePane()
	// Clear again after reconstruction begins so the host renderer does not
	// retain stale rows or a geometry cache from the previous connection.
	return m, tea.ClearScreen
}
