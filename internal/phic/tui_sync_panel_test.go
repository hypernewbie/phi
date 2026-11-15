package phic

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func syncPanelModel(t *testing.T, srv *httptest.Server) *tuiModel {
	t.Helper()
	m := newModelWithServer(t, srv)
	return m
}

// TestSyncPanelOpenListRead pins the read flow: open loads the sorted board,
// Enter reads a message, Esc walks back out.
func TestSyncPanelOpenListRead(t *testing.T) {
	board := newSyncBoardServer()
	srv := httptest.NewServer(board.handler())
	defer srv.Close()
	m := syncPanelModel(t, srv)

	// Prefix Y opens the panel and loads.
	m.Update(tea.KeyPressMsg{Code: ']', Mod: tea.ModCtrl})
	m.Update(tea.KeyPressMsg{Code: 'Y'})
	if m.modal.kind != modalSync || !m.sync.loading {
		t.Fatalf("panel did not open: %+v", m.sync)
	}
	m.Update(m.loadSyncCmd(m.sync.ticket)())
	if m.sync.loading || len(m.sync.rows) != 2 {
		t.Fatalf("board did not load: %+v", m.sync)
	}
	list := ansi.Strip(m.renderSyncModal())
	if !strings.Contains(list, "agent/aeQ") || !strings.Contains(list, "build-status") || !strings.Contains(list, "␤") {
		t.Fatalf("list rendering lost rows: %q", list)
	}

	// Enter reads the highlighted message; the multiline value shows.
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.sync.view != syncValueView {
		t.Fatal("Enter did not open the value view")
	}
	value := ansi.Strip(m.renderSyncModal())
	if !strings.Contains(value, "idle after test run") || !strings.Contains(value, "logs clean") {
		t.Fatalf("value view lost lines: %q", value)
	}

	// Esc returns to the list; Esc again closes the panel.
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.sync.view != syncListView {
		t.Fatal("Esc did not return to the list")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	if m.modal.kind != modalNone || m.focus != focusTerminal {
		t.Fatal("Esc did not close the panel")
	}
}

// TestSyncPanelEditAndUpsert pins the write flow: n opens the editor, Tab
// switches fields, Enter saves, and the list reloads with the new row.
func TestSyncPanelEditAndUpsert(t *testing.T) {
	board := newSyncBoardServer()
	srv := httptest.NewServer(board.handler())
	defer srv.Close()
	m := syncPanelModel(t, srv)
	m.Update(m.openSyncPanel())
	m.Update(m.loadSyncCmd(m.sync.ticket)())

	// A blank key refuses locally.
	m.Update(tea.KeyPressMsg{Code: 'n'})
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.sync.err == "" || m.sync.busy {
		t.Fatalf("blank key was not refused: err=%q", m.sync.err)
	}

	// Type a key, Tab to the value, type, save.
	for _, r := range "deploy/phase" {
		m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	for _, r := range "shipping" {
		m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	driveKey(m, tea.KeyPressMsg{Code: tea.KeyEnter})
	waitFor(t, "upsert reply", func() bool { return !m.sync.busy })
	waitFor(t, "list reload", func() bool { return !m.sync.loading })
	if m.sync.view != syncListView {
		t.Fatalf("upsert did not return to the list: %d", m.sync.view)
	}
	if len(m.sync.rows) != 3 {
		t.Fatalf("board did not reload with the new row: %d", len(m.sync.rows))
	}
	board.mu.Lock()
	saved := board.rows["deploy/phase"]
	board.mu.Unlock()
	if saved.Value != "shipping" {
		t.Fatalf("saved row = %+v", saved)
	}

	// Editing an existing row locks its key and preloads its value.
	m.Update(tea.KeyPressMsg{Code: tea.KeyDown}) // cursor 1: build-status
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m.Update(tea.KeyPressMsg{Code: 'e'})
	if m.sync.view != syncEditView || m.sync.editingKey != "build-status" || m.sync.keyField.value != "build-status" {
		t.Fatalf("edit view wrong: %+v", m.sync)
	}
	if m.sync.valueField.value != "green" {
		t.Fatalf("edit did not preload the value: %q", m.sync.valueField.value)
	}
	// Typing while the key is locked edits the value only.
	for _, r := range "!" {
		m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
	if m.sync.keyField.value != "build-status" || m.sync.valueField.value != "green!" {
		t.Fatalf("locked key changed or value not edited: %q / %q", m.sync.keyField.value, m.sync.valueField.value)
	}
}

// TestSyncPanelDeleteRequiresConfirmation pins the double-d guard.
func TestSyncPanelDeleteRequiresConfirmation(t *testing.T) {
	board := newSyncBoardServer()
	srv := httptest.NewServer(board.handler())
	defer srv.Close()
	m := syncPanelModel(t, srv)
	m.Update(m.openSyncPanel())
	m.Update(m.loadSyncCmd(m.sync.ticket)())

	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter}) // read the highlighted row
	m.Update(tea.KeyPressMsg{Code: 'd'})          // arm
	if m.sync.busy {
		t.Fatal("first d deleted immediately")
	}
	view := ansi.Strip(m.renderSyncModal())
	if !strings.Contains(view, "d again") {
		t.Fatalf("arming hint missing: %q", view)
	}
	driveKey(m, tea.KeyPressMsg{Code: 'd'}) // confirm
	waitFor(t, "delete reply", func() bool { return !m.sync.busy })
	waitFor(t, "list reload", func() bool { return !m.sync.loading })
	board.mu.Lock()
	_, exists := board.rows["agent/aeQ"]
	count := len(board.rows)
	board.mu.Unlock()
	if exists || count != 1 {
		t.Fatalf("delete did not land: exists=%v rows=%d", exists, count)
	}
	if len(m.sync.rows) != 1 {
		t.Fatalf("list did not shrink: %+v", m.sync.rows)
	}
}

// TestSyncPanelStaleRepliesDropped pins the ticket guard.
func TestSyncPanelStaleRepliesDropped(t *testing.T) {
	board := newSyncBoardServer()
	srv := httptest.NewServer(board.handler())
	defer srv.Close()
	m := syncPanelModel(t, srv)
	m.Update(m.openSyncPanel())

	stale := syncLoadedMsg{gen: m.gen, ticket: 0, rows: []SyncMessage{{Key: "ghost"}}}
	if cmd := m.handleSyncLoadedMsg(stale); cmd != nil || len(m.sync.rows) != 0 {
		t.Fatal("stale ticket overwrote the board")
	}
	stray := syncMutationMsg{gen: m.gen, verb: "saved", key: "ghost"}
	m.handleSyncMutationMsg(stray)
	if m.sync.busy || m.sync.notice != "" {
		t.Fatal("stray mutation leaked into the panel")
	}
}

// TestSyncPanelEmptyBoard pins the empty state.
func TestSyncPanelEmptyBoard(t *testing.T) {
	srv := httptest.NewServer(newSyncBoardServer2Empty().handler())
	defer srv.Close()
	m := syncPanelModel(t, srv)
	m.Update(m.openSyncPanel())
	m.Update(m.loadSyncCmd(m.sync.ticket)())
	view := ansi.Strip(m.renderSyncModal())
	if !strings.Contains(view, "no messages on the board") {
		t.Fatalf("empty board rendering: %q", view)
	}
	// Enter on an empty board is a no-op.
	m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if m.sync.view != syncListView {
		t.Fatal("Enter on an empty board opened a value view")
	}
}

func newSyncBoardServer2Empty() *syncBoardServer {
	return &syncBoardServer{rows: map[string]SyncMessage{}, mu: sync.Mutex{}}
}
