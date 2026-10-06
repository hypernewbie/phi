package phic

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/hypernewbie/phi/internal/termemu"
)

// focusRegion is the application focus target.
type focusRegion int

const (
	focusTerminal focusRegion = iota
	focusRail
	focusSessions
	focusTabs
	focusDiff
)

// modalKind enumerates the modal surfaces. A modal captures input until it is
// submitted or cancelled and never pauses the active pane's parser.
type modalKind int

const (
	modalNone modalKind = iota
	modalAddServer
	modalRenameServer
	modalRenamePane
	modalPassword
	modalProject
	modalWorktree
	modalCoder
	modalHelp
	modalHistory
)

type modalItem struct {
	label string
	value string
}

type textField struct {
	value  string
	cursor int // rune index
}

func (f *textField) set(s string) {
	f.value = s
	f.cursor = len([]rune(s))
}

func (f *textField) insert(s string) {
	runes := []rune(f.value)
	if f.cursor > len(runes) {
		f.cursor = len(runes)
	}
	ins := []rune(s)
	out := append([]rune{}, runes[:f.cursor]...)
	out = append(out, ins...)
	out = append(out, runes[f.cursor:]...)
	f.value = string(out)
	f.cursor += len(ins)
}

func (f *textField) backspace() {
	runes := []rune(f.value)
	if f.cursor <= 0 || len(runes) == 0 {
		return
	}
	if f.cursor > len(runes) {
		f.cursor = len(runes)
	}
	f.value = string(append(runes[:f.cursor-1], runes[f.cursor:]...))
	f.cursor--
}

func (f *textField) deleteForward() {
	runes := []rune(f.value)
	if f.cursor >= len(runes) {
		return
	}
	f.value = string(append(runes[:f.cursor], runes[f.cursor+1:]...))
}

func (f *textField) left() {
	if f.cursor > 0 {
		f.cursor--
	}
}

func (f *textField) right() {
	if f.cursor < len([]rune(f.value)) {
		f.cursor++
	}
}

func (f *textField) home() { f.cursor = 0 }
func (f *textField) end()  { f.cursor = len([]rune(f.value)) }

type modalState struct {
	kind   modalKind
	title  string
	field  textField
	field2 textField // secondary field (e.g. add server bulk)
	items  []modalItem
	cursor int
	scroll int
	err    string
	busy   bool
	origin string
	index  int // captured server index for dialogs
	masked bool
	help   string
	extra  string
	auth   authStatus
}

func (m *modalState) open(kind modalKind, title string) {
	m.kind = kind
	m.title = title
	m.field = textField{}
	m.field2 = textField{}
	m.items = nil
	m.cursor = 0
	m.scroll = 0
	m.err = ""
	m.busy = false
	m.masked = false
	m.help = ""
	m.extra = ""
}

// paneTab is one terminal tab. It may exist before its actor attaches: live
// panes listed by the server stay metadata-only until the user selects them.
type paneTab struct {
	key      paneKey
	view     TerminalView
	actor    *paneActor
	attached bool
	exited   bool
	exitCode int
	unread   bool
	status   string
	title    string
	coder    string
	dir      string
	closeAt  time.Time
	closing  bool
	token    int
}

func (t *paneTab) label() string {
	title := t.title
	if title == "" {
		title = t.view.Title
	}
	if title == "" {
		title = t.dir
	}
	if title == "" {
		title = t.key.ID
	}
	return title
}

// serverData is the asynchronously loaded view of one saved server.
type serverData struct {
	identity      serverIdentity
	coders        []CoderDescriptor
	panes         []TerminalView
	sessions      []Session
	health        string
	err           string
	loaded        bool
	needAuth      bool
	auth          authStatus
	sessionsCoder string
	sessionsDir   string
}

// tuiModel is the Bubble Tea application model. It owns focus, selection,
// dialogs, layout, and action state; network work runs in commands.
type tuiModel struct {
	version string
	cfg     config
	store   *desktopStore

	servers []*serverState
	active  int
	data    map[string]*serverData

	width, height int
	ready         bool

	focus  focusRegion
	prefix bool // Ctrl-] was pressed; the next key is an application command

	modal modalState

	status    string
	statusErr bool

	project  string
	worktree string
	coderIdx int

	tabs         map[string][]*paneTab
	activeTab    map[string]int
	actors       map[paneKey]*paneActor
	pendingSpawn map[string]bool

	diff    diffState
	history historyState

	sessionCursor int
	sessionSearch textField
	searchActive  bool

	events chan paneEvent
	gen    int

	lastPaint time.Time
	tickArmed bool

	selection selectionState

	uiIntent *uiIntent

	directPane string
	directExit bool
	quitOnce   bool

	build func(termemu.Options) (termemu.Terminal, error)
}

func newTUIModel(version string, cfg config, store *desktopStore, servers []*serverState, active int, build func(termemu.Options) (termemu.Terminal, error)) *tuiModel {
	m := &tuiModel{
		version:      version,
		cfg:          cfg,
		store:        store,
		servers:      servers,
		active:       active,
		data:         map[string]*serverData{},
		focus:        focusTerminal,
		tabs:         map[string][]*paneTab{},
		activeTab:    map[string]int{},
		actors:       map[paneKey]*paneActor{},
		pendingSpawn: map[string]bool{},
		events:       make(chan paneEvent, 1024),
		build:        build,
	}
	if active < 0 && len(servers) > 0 {
		m.active = 0
	}
	if active >= 0 && active < len(servers) {
		m.data[m.originFor(active)] = &serverData{}
	}
	if cfg.Pane != "" {
		m.directPane = cfg.Pane
		m.directExit = true
	}
	if cfg.NewPane || cfg.Coder != "" {
		m.directExit = true
	}
	// An explicit CLI directory is the captured launch target and outranks
	// remembered UI intent for this run.
	if cfg.Dir != "" && cfg.Dir != "." {
		m.project = cfg.Dir
	}
	return m
}

// originFor maps a server index to its origin key. Tabs, caches, and pending
// actions key on the origin so reordering or reloading the rail never moves
// state between servers.
func (m *tuiModel) originFor(index int) string {
	if index < 0 || index >= len(m.servers) {
		return ""
	}
	s := m.servers[index]
	if s == nil || s.api == nil {
		return ""
	}
	return s.api.base.String()
}

func (m *tuiModel) current() *serverData {
	if m.active < 0 || m.active >= len(m.servers) {
		return nil
	}
	origin := m.currentOrigin()
	if origin == "" {
		return nil
	}
	d := m.data[origin]
	if d == nil {
		d = &serverData{}
		m.data[origin] = d
	}
	return d
}

func (m *tuiModel) currentServer() *serverState {
	if m.active < 0 || m.active >= len(m.servers) {
		return nil
	}
	return m.servers[m.active]
}

func (m *tuiModel) currentOrigin() string {
	return m.originFor(m.active)
}

// ---- messages ----

type msgPaneEvent struct{ ev paneEvent }
type msgPaint struct{}
type msgCloseExpired struct {
	key   paneKey
	token int
}

type serverLoadedMsg struct {
	gen      int
	index    int
	identity serverIdentity
	coders   []CoderDescriptor
	panes    []TerminalView
	health   string
	needAuth bool
	auth     authStatus
	err      string
}

type loginDoneMsg struct {
	gen   int
	index int
	err   string
}

type spawnDoneMsg struct {
	gen     int
	capture spawnCapture
	resp    SpawnResponse
	err     string
}

type deleteDoneMsg struct {
	key paneKey
	err string
}

type sessionsLoadedMsg struct {
	gen   int
	index int
	coder string
	dir   string
	items []Session
	err   string
}

type diffLoadedMsg struct {
	gen     int
	origin  string
	project string
	text    string
	err     string
}

type storeDoneMsg struct {
	gen    int
	status string
	err    string
	reload bool
}

type paneActionDoneMsg struct {
	gen    int
	status string
	err    string
}

type spawnCapture struct {
	origin    string
	index     int
	project   string
	worktree  string
	coder     string
	mini      bool
	sessionID string
	title     string
	cols      int
	rows      int
}

// ---- Init ----

func (m *tuiModel) Init() tea.Cmd {
	cmds := []tea.Cmd{m.waitEvent()}
	if len(m.servers) == 0 {
		m.openAddServer()
		return tea.Batch(cmds...)
	}
	if m.active >= 0 {
		cmds = append(cmds, m.loadServerCmd(m.active))
	}
	return tea.Batch(cmds...)
}

func (m *tuiModel) waitEvent() tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-m.events
		if !ok {
			return nil
		}
		return msgPaneEvent{ev: ev}
	}
}

// ---- async commands ----

func (m *tuiModel) loadServerCmd(index int) tea.Cmd {
	gen := m.gen
	var s *serverState
	if index >= 0 && index < len(m.servers) {
		s = m.servers[index]
	}
	return func() tea.Msg {
		out := serverLoadedMsg{gen: gen, index: index}
		if s == nil || s.api == nil {
			out.err = "server profile has an invalid origin"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out.health = probeHealth(ctx, s)
		st, err := s.api.AuthStatus(ctx)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.auth = st
		if st.Enabled && !st.Authenticated {
			out.needAuth = true
			return out
		}
		var identity serverIdentity
		if err := s.api.getJSON(ctx, "/api/config", &identity); err != nil {
			out.err = err.Error()
			return out
		}
		out.identity = identity
		coders, err := s.api.ListCoders(ctx)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.coders = coders
		panes, err := s.api.ListTerminals(ctx, "")
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.panes = panes
		return out
	}
}

func probeHealth(ctx context.Context, s *serverState) string {
	if s.api == nil {
		return "down"
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	probe := *s.api.http
	probe.Jar = nil
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.api.base.String()+"/healthz", nil)
	if err != nil {
		return "down"
	}
	resp, err := probe.Do(req)
	if err != nil {
		return "down"
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return "up"
	}
	return "down"
}

func (m *tuiModel) loginCmd(index int, status authStatus, password string) tea.Cmd {
	gen := m.gen
	var s *serverState
	if index >= 0 && index < len(m.servers) {
		s = m.servers[index]
	}
	return func() tea.Msg {
		out := loginDoneMsg{gen: gen, index: index}
		if s == nil || s.api == nil {
			out.err = "server profile has an invalid origin"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.api.Login(ctx, status, password); err != nil {
			out.err = err.Error()
		}
		return out
	}
}

func (m *tuiModel) spawnCmd(cap spawnCapture) tea.Cmd {
	gen := m.gen
	return func() tea.Msg {
		out := spawnDoneMsg{gen: gen, capture: cap}
		var s *serverState
		for _, candidate := range m.servers {
			if candidate.api != nil && candidate.api.base.String() == cap.origin {
				s = candidate
				break
			}
		}
		if s == nil {
			out.err = "the captured server is no longer available"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		req := SpawnRequest{
			Coder:        cap.coder,
			Dir:          cap.project,
			Workspace:    cap.worktree,
			SessionID:    cap.sessionID,
			Title:        cap.title,
			OpenCodeMini: cap.mini,
			Cols:         uint16(cap.cols),
			Rows:         uint16(cap.rows),
		}
		resp, err := s.api.Spawn(ctx, req)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.resp = resp
		return out
	}
}

func (m *tuiModel) deletePaneCmd(key paneKey) tea.Cmd {
	return func() tea.Msg {
		out := deleteDoneMsg{key: key}
		var s *serverState
		for _, candidate := range m.servers {
			if candidate.api != nil && candidate.api.base.String() == key.Origin {
				s = candidate
				break
			}
		}
		if s == nil {
			out.err = "the pane origin is no longer available"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.api.DeleteTerminal(ctx, key.ID); err != nil {
			out.err = err.Error()
		}
		return out
	}
}

func (m *tuiModel) sessionsCmd(index int, coder, dir string) tea.Cmd {
	gen := m.gen
	var s *serverState
	if index >= 0 && index < len(m.servers) {
		s = m.servers[index]
	}
	return func() tea.Msg {
		out := sessionsLoadedMsg{gen: gen, index: index, coder: coder, dir: dir}
		if s == nil || s.api == nil {
			out.err = "server profile has an invalid origin"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		items, err := s.api.ListSessions(ctx, coder, dir)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.items = items
		return out
	}
}

func (m *tuiModel) diffCmd(origin, project string) tea.Cmd {
	gen := m.gen
	return func() tea.Msg {
		out := diffLoadedMsg{gen: gen, origin: origin, project: project}
		var s *serverState
		for _, candidate := range m.servers {
			if candidate.api != nil && candidate.api.base.String() == origin {
				s = candidate
				break
			}
		}
		if s == nil {
			out.err = "the diff origin is no longer available"
			return out
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		text, err := s.api.RawDiff(ctx, project, false)
		if err != nil {
			out.err = err.Error()
			return out
		}
		out.text = text
		return out
	}
}

// ---- Update ----

func (m *tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.ready = true
		m.relayout()
		return m, nil
	case msgPaint:
		m.tickArmed = false
		m.lastPaint = time.Now()
		return m, nil
	case msgPaneEvent:
		cmd := m.handlePaneEvent(msg.ev)
		return m, tea.Batch(m.waitEvent(), cmd)
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	case tea.KeyReleaseMsg:
		return m.handleKeyRelease(msg)
	case tea.PasteMsg:
		return m.handlePaste(msg)
	case tea.MouseMsg:
		return m.handleMouse(msg)
	case serverLoadedMsg:
		return m.applyServerLoaded(msg)
	case loginDoneMsg:
		return m.applyLoginDone(msg)
	case spawnDoneMsg:
		return m.applySpawnDone(msg)
	case deleteDoneMsg:
		return m.applyDeleteDone(msg)
	case sessionsLoadedMsg:
		return m.applySessionsLoaded(msg)
	case diffLoadedMsg:
		return m.applyDiffLoaded(msg)
	case storeDoneMsg:
		return m.applyStoreDone(msg)
	case paneActionDoneMsg:
		return m.applyPaneActionDone(msg)
	case reloadedProfilesMsg:
		return m.applyReloadedProfiles(msg)
	case worktreesMsg:
		return m.applyWorktrees(msg)
	case historyLoadedMsg:
		return m.applyHistoryLoaded(msg)
	case msgCloseExpired:
		return m.applyCloseExpired(msg)
	}
	return m, nil
}

func (m *tuiModel) applyServerLoaded(msg serverLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	origin := m.originFor(msg.index)
	if origin == "" {
		return m, nil
	}
	d := m.data[origin]
	if d == nil {
		d = &serverData{}
		m.data[origin] = d
	}
	d.health = msg.health
	d.loaded = true
	d.err = msg.err
	d.needAuth = msg.needAuth
	d.auth = msg.auth
	if msg.err != "" {
		m.setStatus(msg.err, true)
		return m, nil
	}
	if msg.needAuth {
		d.needAuth = true
		m.openPassword(msg.index, msg.auth)
		return m, nil
	}
	d.identity = msg.identity
	d.coders = msg.coders
	d.panes = msg.panes
	// The active server selection is only meaningful for the server the
	// result belongs to; stale results cannot change another server's view.
	if msg.index != m.active {
		return m, nil
	}
	m.reconcileTabs(msg.panes)
	m.restoreIntent()
	m.chooseStartupProject()
	var cmds []tea.Cmd
	cmds = append(cmds, m.refreshSessions())
	if m.cfg.Diff {
		m.diff.open = true
		cmds = append(cmds, m.refreshDiff())
	}
	if m.cfg.Worktrees {
		cmds = append(cmds, m.openWorktreeModal())
	}
	if m.cfg.Pane != "" {
		if cmd := m.openPaneDirect(m.cfg.Pane); cmd != nil {
			cmds = append(cmds, cmd)
		}
	} else if m.cfg.NewPane && m.cfg.Coder != "" {
		cmds = append(cmds, m.spawnForCoder(m.cfg.Coder, false, ""))
	}
	return m, tea.Batch(cmds...)
}

func (m *tuiModel) applyLoginDone(msg loginDoneMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	if msg.err != "" {
		if m.modal.kind == modalPassword {
			m.modal.err = msg.err
			m.modal.busy = false
			return m, nil
		}
		m.setStatus(msg.err, true)
		return m, nil
	}
	m.closeModal()
	m.setStatus("signed in", false)
	return m, m.loadServerCmd(msg.index)
}

func (m *tuiModel) applySpawnDone(msg spawnDoneMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	index := -1
	for i, s := range m.servers {
		if s.api != nil && s.api.base.String() == msg.capture.origin {
			index = i
			break
		}
	}
	if index >= 0 {
		m.pendingSpawn[msg.capture.origin] = false
	}
	if msg.err != "" {
		m.setStatus("spawn failed: "+msg.err, true)
		return m, nil
	}
	if msg.resp.PaneID == "" {
		m.setStatus("spawn returned no pane ID", true)
		return m, nil
	}
	if index < 0 {
		m.setStatus("pane spawned on a server that is no longer listed", false)
		return m, nil
	}
	tab := m.ensureTab(msg.capture.origin, msg.resp.PaneID, msg.capture)
	// Focus only when the capture still belongs to the active server.
	if index == m.active {
		m.activateTab(msg.capture.origin, tab)
		m.focus = focusTerminal
	}
	m.setStatus("opened "+tab.label(), false)
	// Refresh the sidebar without changing the captured launch target.
	return m, tea.Batch(m.loadServerCmd(index), m.refreshDiff())
}

func (m *tuiModel) applyDeleteDone(msg deleteDoneMsg) (tea.Model, tea.Cmd) {
	if msg.err != "" {
		m.setStatus("final close failed; the server process may still be alive: "+msg.err, true)
		return m, nil
	}
	m.removeTabEverywhere(msg.key)
	m.setStatus("closed", false)
	return m, m.loadServerCmd(m.active)
}

func (m *tuiModel) applySessionsLoaded(msg sessionsLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || msg.index != m.active {
		return m, nil
	}
	d := m.data[m.originFor(msg.index)]
	if d == nil {
		return m, nil
	}
	if msg.coder != m.selectedCoderID() || msg.dir != m.project {
		// A late list result cannot overwrite another context.
		return m, nil
	}
	if msg.err != "" {
		d.sessions = nil
		m.setStatus("sessions: "+msg.err, true)
		return m, nil
	}
	d.sessions = msg.items
	d.sessionsCoder = msg.coder
	d.sessionsDir = msg.dir
	if m.sessionCursor >= len(msg.items) {
		m.sessionCursor = max(0, len(msg.items)-1)
	}
	return m, nil
}

func (m *tuiModel) applyDiffLoaded(msg diffLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen || msg.origin != m.currentOrigin() || msg.project != m.project {
		return m, nil
	}
	m.diff.loading = false
	m.diff.origin = msg.origin
	m.diff.project = msg.project
	if msg.err != "" {
		m.diff.err = msg.err
		m.diff.text = ""
		return m, nil
	}
	m.diff.err = ""
	m.diff.text = msg.text
	m.diff.scroll = 0
	m.diff.recomputeMatches()
	return m, nil
}

func (m *tuiModel) applyPaneActionDone(msg paneActionDoneMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	if msg.err != "" {
		if m.modal.kind == modalRenamePane {
			m.modal.busy = false
			m.modal.err = msg.err
			return m, nil
		}
		m.setStatus(msg.err, true)
		return m, nil
	}
	if m.modal.kind == modalRenamePane {
		m.closeModal()
	}
	if msg.status != "" {
		m.setStatus(msg.status, false)
	}
	// Refresh pane metadata without disturbing attachments.
	return m, m.loadServerCmd(m.active)
}

func (m *tuiModel) applyStoreDone(msg storeDoneMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	if msg.err != "" {
		if m.modal.kind == modalAddServer || m.modal.kind == modalRenameServer {
			m.modal.busy = false
			m.modal.err = msg.err
			return m, nil
		}
		m.setStatus(msg.err, true)
		return m, nil
	}
	if m.modal.kind == modalAddServer || m.modal.kind == modalRenameServer {
		m.closeModal()
	}
	if msg.status != "" {
		m.setStatus(msg.status, false)
	}
	if msg.reload {
		return m, m.reloadServersCmd()
	}
	return m, nil
}

func (m *tuiModel) applyCloseExpired(msg msgCloseExpired) (tea.Model, tea.Cmd) {
	tab := m.findTab(msg.key)
	if tab == nil || !tab.closing || tab.token != msg.token {
		return m, nil
	}
	tab.closing = false
	return m, m.deletePaneCmd(msg.key)
}

func (m *tuiModel) handlePaneEvent(ev paneEvent) tea.Cmd {
	tab := m.findTab(ev.Key)
	if tab == nil {
		return nil
	}
	switch ev.Kind {
	case paneOutput:
		tab.unread = tab.key != m.activeTabKeyOrZero()
		if time.Since(m.lastPaint) < 33*time.Millisecond {
			if !m.tickArmed {
				m.tickArmed = true
				return tea.Tick(33*time.Millisecond, func(time.Time) tea.Msg { return msgPaint{} })
			}
			return nil
		}
		m.lastPaint = time.Now()
	case paneStatus:
		tab.status = ev.Status
		if ev.Status == "connected" {
			tab.status = ""
		}
	case paneError:
		m.setStatus(ev.Status, true)
	case paneExited:
		tab.exited = true
		tab.exitCode = ev.Code
		tab.unread = true
		m.setStatus(fmt.Sprintf("%s exited (%d)", tab.label(), ev.Code), ev.Code != 0)
		if m.directExit && m.directPane != "" && tab.key.ID == m.directPane {
			return tea.Quit
		}
	case paneMetadata:
		if ev.Title != "" {
			tab.title = sanitizeMetadata(ev.Title)
		}
	}
	return nil
}

func (m *tuiModel) setStatus(s string, isErr bool) {
	m.status = s
	m.statusErr = isErr
}

func (m *tuiModel) reloadServersCmd() tea.Cmd {
	gen := m.gen
	store := m.store
	cfg := m.cfg
	return func() tea.Msg {
		profiles, selected, err := loadServerProfiles(cfg)
		if err != nil {
			return storeDoneMsg{gen: gen, err: err.Error()}
		}
		return reloadedProfilesMsg{gen: gen, profiles: profiles, selected: selected, store: store}
	}
}

type reloadedProfilesMsg struct {
	gen      int
	profiles []desktopProfile
	selected int
	store    *desktopStore
}

func (m *tuiModel) applyReloadedProfiles(msg reloadedProfilesMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.gen {
		return m, nil
	}
	currentOrigin := m.currentOrigin()
	old := m.servers
	var next []*serverState
	selected := -1
	for _, p := range msg.profiles {
		api, _ := newAPIClient(p.Origin)
		var state *serverState
		for _, prev := range old {
			if prev.profile.ID == p.ID && prev.profile.Origin == p.Origin {
				state = prev
				break
			}
		}
		if state == nil {
			state = &serverState{api: api}
		}
		state.profile = p
		if currentOrigin != "" && api != nil && api.base.String() == currentOrigin {
			selected = len(next)
		}
		next = append(next, state)
	}
	if selected >= 0 {
		m.active = selected
	}
	m.servers = next
	return m, nil
}

// resizeActivePane pushes the current widget geometry to the active pane.
func (m *tuiModel) resizeActivePane() {
	key, ok := m.activeTabKey()
	if !ok {
		return
	}
	tab := m.findTab(key)
	if tab == nil || tab.actor == nil {
		return
	}
	cols, rows := m.terminalSize()
	if cols <= 0 || rows <= 0 {
		return
	}
	tab.actor.resize(cols, rows)
}

// ---- tabs ----

func (m *tuiModel) ensureTab(origin, paneID string, cap spawnCapture) *paneTab {
	for _, t := range m.tabs[origin] {
		if t.key.ID == paneID && t.key.Origin == origin {
			return t
		}
	}
	tab := &paneTab{
		key:   paneKey{Origin: origin, ID: paneID},
		title: cap.title,
		coder: cap.coder,
		dir:   cap.project,
		view: TerminalView{
			ID: paneID, Dir: cap.project, Coder: cap.coder, Title: cap.title,
			Workspace: cap.worktree, OpenCodeMode: modeForMini(cap.mini),
		},
	}
	m.tabs[origin] = append(m.tabs[origin], tab)
	return tab
}

func modeForMini(mini bool) string {
	if mini {
		return "mini"
	}
	return ""
}

func (m *tuiModel) findTab(key paneKey) *paneTab {
	for _, tabs := range m.tabs {
		for _, t := range tabs {
			if t.key == key {
				return t
			}
		}
	}
	return nil
}

func (m *tuiModel) activeTabKey() (paneKey, bool) {
	origin := m.currentOrigin()
	tabs := m.tabs[origin]
	i := m.activeTab[origin]
	if i < 0 || i >= len(tabs) {
		return paneKey{}, false
	}
	return tabs[i].key, true
}

// reconcileTabs merges the server's live pane list into the tab order. Tabs
// already known keep their position and actor; new live panes append. Panes
// that vanished from the server are marked exited, never silently dropped.
func (m *tuiModel) reconcileTabs(panes []TerminalView) {
	origin := m.currentOrigin()
	if origin == "" {
		return
	}
	existing := m.tabs[origin]
	seen := map[string]bool{}
	var next []*paneTab
	for _, t := range existing {
		if t.key.Origin != origin {
			next = append(next, t)
			continue
		}
		found := false
		for _, p := range panes {
			if p.ID == t.key.ID {
				found = true
				t.view = p
				if t.title == "" {
					t.title = p.Title
				}
				if t.coder == "" {
					t.coder = p.Coder
				}
				if t.dir == "" {
					t.dir = p.Dir
				}
				break
			}
		}
		if !found && !t.attached {
			// It was only a listed pane; it no longer exists.
			continue
		}
		if !found && t.attached && !t.exited {
			t.exited = true
		}
		next = append(next, t)
		seen[t.key.ID] = true
	}
	for _, p := range panes {
		if seen[p.ID] {
			continue
		}
		if !MatchDir(p.Dir, m.project) {
			continue
		}
		next = append(next, &paneTab{
			key:   paneKey{Origin: origin, ID: p.ID},
			view:  p,
			title: p.Title,
			coder: p.Coder,
			dir:   p.Dir,
		})
	}
	m.tabs[origin] = next
	// Keep the active index pointing at the same pane where possible.
	if key, ok := m.activeTabKey(); ok {
		for i, t := range next {
			if t.key == key {
				m.activeTab[origin] = i
				return
			}
		}
	}
	if m.activeTab[origin] >= len(next) {
		m.activeTab[origin] = len(next) - 1
	}
	if m.activeTab[origin] < 0 && len(next) > 0 {
		m.activeTab[origin] = 0
	}
}

func (m *tuiModel) activateTab(origin string, tab *paneTab) {
	for i, t := range m.tabs[origin] {
		if t == tab {
			m.activeTab[origin] = i
			break
		}
	}
	if tab.actor == nil {
		m.attachTab(tab)
	} else {
		m.resizeActivePane()
	}
}

// attachTab creates the pane actor for a listed live pane. Attaching replays
// the recording at the widget geometry; it never spawns or resumes a process.
func (m *tuiModel) attachTab(tab *paneTab) {
	s := m.currentServer()
	if s == nil || s.api == nil {
		return
	}
	cols, rows := m.terminalSize()
	if cols <= 0 || rows <= 0 {
		return
	}
	spec := paneSpec{
		Key:          tab.key,
		Title:        tab.label(),
		Coder:        tab.coder,
		Dir:          tab.dir,
		Workspace:    tab.view.Workspace,
		OpenCodeMode: tab.view.OpenCodeMode,
		Cols:         cols,
		Rows:         rows,
	}
	actor, err := newPaneActor(context.Background(), s.api, spec, m.events, m.build)
	if err != nil {
		m.setStatus("attach: "+err.Error(), true)
		return
	}
	tab.actor = actor
	tab.attached = true
	m.actors[tab.key] = actor
	tab.status = "attaching"
}

func (m *tuiModel) closeTab(tab *paneTab, final bool) tea.Cmd {
	if tab.closing && !final {
		// A second explicit close terminates the process immediately.
		final = true
	}
	if !final {
		tab.closing = true
		tab.token++
		tab.closeAt = time.Now().Add(3 * time.Second)
		token := tab.token
		key := tab.key
		return tea.Tick(3*time.Second, func(time.Time) tea.Msg {
			return msgCloseExpired{key: key, token: token}
		})
	}
	tab.closing = false
	tab.exited = true
	if tab.actor != nil {
		// Detach from the UI immediately; DELETE is the final process action.
		delete(m.actors, tab.key)
	}
	return m.deletePaneCmd(tab.key)
}

func (m *tuiModel) undoClose(tab *paneTab) {
	tab.closing = false
	tab.token++
	m.setStatus("restored "+tab.label(), false)
}

func (m *tuiModel) removeTabEverywhere(key paneKey) {
	origin := key.Origin
	tabs := m.tabs[origin]
	for i, t := range tabs {
		if t.key != key {
			continue
		}
		if t.actor != nil {
			t.actor.close()
		}
		delete(m.actors, key)
		m.tabs[origin] = append(tabs[:i], tabs[i+1:]...)
		if m.activeTab[origin] >= len(m.tabs[origin]) {
			m.activeTab[origin] = len(m.tabs[origin]) - 1
		}
		break
	}
}

// ---- project / coder context ----

func (m *tuiModel) selectedCoderID() string {
	d := m.current()
	if d == nil || len(d.coders) == 0 {
		return ""
	}
	if m.coderIdx < 0 || m.coderIdx >= len(d.coders) {
		m.coderIdx = 0
	}
	return d.coders[m.coderIdx].ID
}

func (m *tuiModel) selectedCoder() (CoderDescriptor, bool) {
	d := m.current()
	if d == nil || len(d.coders) == 0 {
		return CoderDescriptor{}, false
	}
	if m.coderIdx < 0 || m.coderIdx >= len(d.coders) {
		m.coderIdx = 0
	}
	return d.coders[m.coderIdx], true
}

// chooseStartupProject follows the website fallback order without a blocking
// project picker: remembered project, advertised active_cwd, first workspace.
func (m *tuiModel) chooseStartupProject() {
	d := m.current()
	if d == nil {
		return
	}
	if m.project != "" && m.projectValid() {
		return
	}
	if intent := m.intentFor(m.active); intent != nil && intent.Project != "" {
		if m.projectExists(intent.Project) {
			m.project = intent.Project
			m.worktree = intent.Worktree
			return
		}
	}
	if len(d.identity.Workspaces) > 0 {
		m.project = d.identity.Workspaces[0]
		return
	}
	m.project = ""
}

func (m *tuiModel) projectExists(dir string) bool {
	d := m.current()
	if d == nil {
		return false
	}
	for _, w := range d.identity.Workspaces {
		if strings.TrimRight(w, "/") == strings.TrimRight(dir, "/") {
			return true
		}
	}
	for _, p := range d.panes {
		if MatchDir(p.Dir, dir) {
			return true
		}
	}
	// An absolute server path is validated by the server, not by a local
	// existence check. Accept it as a remembered context.
	return serverAbsolutePath(dir)
}

func (m *tuiModel) projectValid() bool { return m.project != "" }

func (m *tuiModel) refreshSessions() tea.Cmd {
	coder := m.selectedCoderID()
	if coder == "" || m.project == "" {
		return nil
	}
	d := m.current()
	if d != nil && d.sessionsCoder == coder && d.sessionsDir == m.project {
		return nil
	}
	m.sessionCursor = 0
	return m.sessionsCmd(m.active, coder, m.project)
}

// ---- modal helpers ----

func (m *tuiModel) closeModal() { m.modal = modalState{} }

func (m *tuiModel) openAddServer() {
	m.modal.open(modalAddServer, "Add Phi server")
	m.modal.help = "URL or several URLs; desktop normalization applies"
}

func (m *tuiModel) openRenameServer() {
	s := m.currentServer()
	if s == nil {
		return
	}
	m.modal.open(modalRenameServer, "Rename server")
	m.modal.index = m.active
	m.modal.field.set(s.profile.Name)
}

// openRenamePane renames one tab through the server's title endpoint.
func (m *tuiModel) openRenamePane() {
	tab := m.activeTabModel()
	if tab == nil {
		return
	}
	m.modal.open(modalRenamePane, "Rename tab")
	m.modal.field.set(tab.label())
}

func (m *tuiModel) openPassword(index int, status authStatus) {
	m.modal.open(modalPassword, "Phi server password")
	m.modal.index = index
	m.modal.masked = true
	m.modal.origin = ""
	m.modal.auth = status
}

func (m *tuiModel) openProjectModal() {
	d := m.current()
	if d == nil {
		return
	}
	m.modal.open(modalProject, "Project")
	m.modal.items = nil
	for _, w := range d.identity.Workspaces {
		m.modal.items = append(m.modal.items, modalItem{label: menuLabel(w), value: w})
	}
	for _, p := range d.panes {
		if !serverAbsolutePath(p.Dir) {
			continue
		}
		dup := false
		for _, it := range m.modal.items {
			if it.value == p.Dir {
				dup = true
			}
		}
		if !dup {
			m.modal.items = append(m.modal.items, modalItem{label: menuLabel(p.Dir), value: p.Dir})
		}
	}
	m.modal.field.set(m.project)
	m.modal.help = "choose a workspace or type an absolute server path"
}

func (m *tuiModel) openCoderModal() {
	d := m.current()
	if d == nil {
		return
	}
	m.modal.open(modalCoder, "Coder")
	for i, c := range d.coders {
		mark := ""
		if i == m.coderIdx {
			mark = "● "
		}
		m.modal.items = append(m.modal.items, modalItem{label: mark + menuLabel(c.Name), value: c.ID})
	}
	m.modal.cursor = m.coderIdx
}

func (m *tuiModel) openWorktreeModal() tea.Cmd {
	s := m.currentServer()
	if s == nil || s.api == nil {
		return nil
	}
	origin := s.api.base.String()
	project := m.project
	gen := m.gen
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		items, err := s.api.Worktrees(ctx, project)
		if err != nil {
			return storeDoneMsg{gen: gen, err: "worktrees: " + err.Error()}
		}
		return worktreesMsg{gen: gen, origin: origin, project: project, items: items}
	}
}

type worktreesMsg struct {
	gen     int
	origin  string
	project string
	items   []Worktree
}

func (m *tuiModel) openHelp() {
	m.modal.open(modalHelp, "phic help")
	m.modal.help = `Prefix: Ctrl-]   (Ctrl-] Ctrl-] sends a literal prefix)

  Ctrl-] 1..9     switch server
  Ctrl-] b        focus server rail
  Ctrl-] s        focus sessions
  Ctrl-] t        focus tabs
  Ctrl-] d        toggle diff
  Ctrl-] h        history browser
  Ctrl-] p        project context
  Ctrl-] w        worktree context
  Ctrl-] c        coder selector
  Ctrl-] n        new session
  Ctrl-] o        new OpenCode Mini session
  Ctrl-] S        new Shell session
  Ctrl-] m        rename server
  Ctrl-] a        add server
  Ctrl-] r        reload servers
  Ctrl-] y        copy diff
  Ctrl-] ?        this help
  Ctrl-] q        quit phic

Tab strip: [x] soft close with 3s [u] undo, [X] final close,
[r] rename, [p] pin, [m] mark.

In terminal focus: Tab, arrows, digits, Escape, and Ctrl-C go to the
backend. Application chrome: Tab cycles regions, Enter activates,
Esc returns to the terminal.`

	m.modal.help = strings.TrimRight(m.modal.help, "\n")
}

func (m *tuiModel) openHistory() tea.Cmd {
	key, ok := m.activeTabKey()
	if !ok {
		return nil
	}
	tab := m.findTab(key)
	if tab == nil || tab.actor == nil {
		m.setStatus("attach the pane before opening history", true)
		return nil
	}
	s := m.currentServer()
	if s == nil || s.api == nil {
		return nil
	}
	_, head, epoch, _, _, _ := tab.actor.state()
	m.history.open = true
	m.history.loading = true
	m.history.err = ""
	m.history.text = ""
	m.history.lines = nil
	m.history.scroll = 0
	m.modal.open(modalHistory, "History · "+tab.label())
	api := s.api
	paneID := key.ID
	build := m.build
	gen := m.gen
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		text, err := fetchHistoryText(ctx, api, paneID, epoch, head, build)
		out := historyLoadedMsg{gen: gen, key: key, text: text}
		if err != nil {
			out.err = err.Error()
		}
		return out
	}
}

// ---- layout ----

type rect struct{ X, Y, W, H int }

func (r rect) empty() bool { return r.W <= 0 || r.H <= 0 }

func (m *tuiModel) showSidebar() bool {
	if m.width >= 80 {
		return true
	}
	return m.focus == focusSessions && m.modal.kind == modalNone
}

func (m *tuiModel) showDiffPanel() bool {
	if !m.diff.open {
		return false
	}
	if m.width >= 120 {
		return true
	}
	return m.focus == focusDiff && m.modal.kind == modalNone
}

func (m *tuiModel) relayout() {
	cols, rows := m.terminalSize()
	if cols <= 0 || rows <= 0 {
		return
	}
	key, ok := m.activeTabKey()
	if !ok {
		return
	}
	tab := m.findTab(key)
	if tab == nil || tab.actor == nil {
		return
	}
	tab.actor.resize(cols, rows)
}

// terminalSize computes the inner widget geometry for the terminal panel.
func (m *tuiModel) terminalSize() (int, int) {
	if m.width < 40 || m.height < 10 {
		return 0, 0
	}
	sidebar := 0
	if m.showSidebar() {
		sidebar = 27
	}
	diff := 0
	if m.showDiffPanel() {
		diff = min(44, m.width/3)
	}
	w := m.width - sidebar - diff - 2 // terminal border
	h := m.height - 5                 // rail, context, tabs, footer + border
	if w < 1 || h < 1 {
		return 0, 0
	}
	return w, h
}

func (m *tuiModel) bodyRect() rect {
	return rect{X: 0, Y: 3, W: m.width, H: m.height - 4}
}

func (m *tuiModel) sidebarRect() rect {
	if !m.showSidebar() {
		return rect{}
	}
	return rect{X: 0, Y: 3, W: 27, H: m.height - 4}
}

func (m *tuiModel) terminalRect() rect {
	b := m.bodyRect()
	x := 0
	w := m.width
	if m.showSidebar() {
		x += 27
		w -= 27
	}
	if m.showDiffPanel() {
		dw := min(44, m.width/3)
		w -= dw
	}
	return rect{X: x, Y: b.Y, W: w, H: b.H}
}

func (m *tuiModel) diffRect() rect {
	if !m.showDiffPanel() {
		return rect{}
	}
	dw := min(44, m.width/3)
	return rect{X: m.width - dw, Y: m.bodyRect().Y, W: dw, H: m.bodyRect().H}
}

func (m *tuiModel) terminalInner() rect {
	r := m.terminalRect()
	if r.empty() {
		return rect{}
	}
	inner := rect{X: r.X + 1, Y: r.Y + 1, W: r.W - 2, H: r.H - 2}
	if inner.W < 1 || inner.H < 1 {
		return rect{}
	}
	return inner
}

// sortSessions orders saved sessions by recency, matching the website.
func sortSessions(items []Session) {
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].TimeUpdated.After(items[j].TimeUpdated)
	})
}

func sanitizeMetadata(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	if b.Len() > 120 {
		return b.String()[:120]
	}
	return b.String()
}
