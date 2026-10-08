package phic

import (
	"errors"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func geometryModel(t *testing.T) (*tuiModel, *paneActor, *paneTab) {
	t.Helper()
	m := coderStateModel(t, nil)
	m.width, m.height = 160, 40
	cols, rows := m.terminalSize()
	emu, err := stub.New(termemu.Options{Cols: cols, Rows: rows, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = emu.Close() })
	p := &paneActor{ctx: t.Context(), emu: emu, cols: cols, rows: rows, emuCols: cols, emuRows: rows, resizes: make(chan paneInput, 1), inbox: make(chan paneInput, 128), outbox: make(chan paneWrite, 16), conn: &websocket.Conn{}}
	tab := &paneTab{key: paneKey{Origin: m.currentOrigin(), ID: "first"}, actor: p, attached: true}
	m.tabs[m.currentOrigin()] = []*paneTab{tab}
	m.activeTab[m.currentOrigin()] = 0
	return m, p, tab
}

func TestPanelLayoutChangesSendFinalWidgetGeometry(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(*tuiModel)
		msg   tea.Msg
	}{
		{"hide sessions", func(m *tuiModel) { m.prefix = true }, tea.KeyPressMsg{Code: 'B'}},
		{"open reader", func(m *tuiModel) { m.prefix = true }, tea.KeyPressMsg{Code: 'd'}},
		{"sessions drag", func(m *tuiModel) { m.panelDrag = 1 }, tea.MouseMotionMsg{X: 47, Y: 5}},
		{"reader drag", func(m *tuiModel) { m.diff.open = true; m.readerWidth = 60; m.panelDrag = 2 }, tea.MouseMotionMsg{X: 110, Y: 5}},
		{"host resize", func(*tuiModel) {}, tea.WindowSizeMsg{Width: 130, Height: 33}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, p, _ := geometryModel(t)
			tc.setup(m)
			m.Update(tc.msg)
			select {
			case in := <-p.resizes:
				cols, rows := m.terminalSize()
				if in.Kind != paneInputResize || in.Cols != cols || in.Rows != rows {
					t.Fatalf("queued %+v, widget %dx%d", in, cols, rows)
				}
				if err := p.handleInput(in); err != nil {
					t.Fatal(err)
				}
				select {
				case sent := <-p.outbox:
					want := wireproto.EncodeResizeFrame(uint16(cols), uint16(rows))
					if string(sent.bytes) != string(want) {
						t.Fatalf("wire size %v, want %v", sent.bytes, want)
					}
				default:
					t.Fatal("local geometry changed without a backend resize")
				}
			default:
				t.Fatal("layout did not submit geometry")
			}
		})
	}
}

func TestTabRefreshAndFocusReassertSameWidgetGeometry(t *testing.T) {
	for _, action := range []string{"tab activation", "server round-trip", "refresh", "focus", "equal host geometry"} {
		t.Run(action, func(t *testing.T) {
			m, p, tab := geometryModel(t)
			switch action {
			case "tab activation":
				m.activateTab(m.currentOrigin(), tab)
			case "server round-trip":
				m.switchServer(1)
				m.switchServer(0)
			case "refresh":
				m.refreshConsole()
			case "focus":
				m.Update(tea.FocusMsg{})
			case "equal host geometry":
				m.Update(tea.WindowSizeMsg{Width: m.width, Height: m.height})
			}
			select {
			case in := <-p.resizes:
				if !in.ForceResize {
					t.Fatal("same-size activation was suppressed")
				}
				if err := p.handleInput(in); err != nil {
					t.Fatal(err)
				}
				select {
				case <-p.outbox:
				default:
					t.Fatal("same grid did not reach backend")
				}
				if p.dirty {
					t.Fatal("same-size synchronization needlessly reflowed emulator")
				}
			default:
				t.Fatal("lifecycle action did not submit resize")
			}
		})
	}
}

func TestReplayGeometryCannotSuppressPanelResize(t *testing.T) {
	m, p, _ := geometryModel(t)
	cols, rows := m.terminalSize()
	if err := p.feedRecording(wireproto.RecordingHeader{Epoch: 7, Resizes: [][3]uint64{{0, 140, 35}}}, nil, termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	if p.cols != cols || p.rows != rows || p.emuCols != 140 || p.emuRows != 35 {
		t.Fatal("desired and replay geometry were mixed")
	}
	p.dirty = false
	if err := p.handleInput(paneInput{Kind: paneInputResize, Cols: cols, Rows: rows, ForceResize: true}); err != nil {
		t.Fatal(err)
	}
	frame, err := p.emu.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if frame.Cols != cols || frame.Rows != rows || !p.dirty {
		t.Fatal("same desired dimensions suppressed the actual emulator resize")
	}
	if string((<-p.outbox).bytes) != string(wireproto.EncodeResizeFrame(uint16(cols), uint16(rows))) {
		t.Fatal("backend grid differs from panel")
	}
}

func TestRefusedResizeRequiresRecoveryInsteadOfClaimingSuccessfulSizing(t *testing.T) {
	_, p, _ := geometryModel(t)
	for i := 0; i < cap(p.outbox); i++ {
		p.outbox <- paneWrite{bytes: []byte("accepted input")}
	}
	if err := p.handleInput(paneInput{Kind: paneInputResize, Cols: 95, Rows: 24}); !errors.Is(err, errPaneResize) {
		t.Fatal("full writer queue silently lost the panel resize")
	}
	if p.cols != 95 || p.rows != 24 {
		t.Fatal("desired geometry lost before reconnect")
	}
	for i := 0; i < cap(p.outbox); i++ {
		if string((<-p.outbox).bytes) != "accepted input" {
			t.Fatal("resize displaced admitted input")
		}
	}
	if err := p.handleInput(paneInput{Kind: paneInputResize, Cols: 95, Rows: 24, ForceResize: true}); err != nil {
		t.Fatal(err)
	}
	if string((<-p.outbox).bytes) != string(wireproto.EncodeResizeFrame(95, 24)) {
		t.Fatal("retry did not synchronize desired geometry")
	}
}

func TestLatestResizeSurvivesInputBacklogAndRetainsForce(t *testing.T) {
	_, p, _ := geometryModel(t)
	for i := 0; i < cap(p.inbox); i++ {
		p.inbox <- paneInput{Kind: paneInputRaw, Raw: []byte("key")}
	}
	p.forceResize(80, 24)
	for _, cols := range []int{81, 90, 110, 120} {
		p.resize(cols, 30)
	}
	if len(p.resizes) != 1 {
		t.Fatal("geometry backlog is not bounded")
	}
	in := <-p.resizes
	if in.Cols != 120 || in.Rows != 30 || !in.ForceResize {
		t.Fatalf("lost final size/force: %+v", in)
	}
	if len(p.inbox) != cap(p.inbox) {
		t.Fatal("resize displaced input bytes")
	}
	if err := p.handleInput(in); err != nil {
		t.Fatal(err)
	}
	if p.cols != 120 || p.rows != 30 {
		t.Fatal("latest dimensions did not reach emulator")
	}
	select {
	case sent := <-p.outbox:
		if string(sent.bytes) != string(wireproto.EncodeResizeFrame(120, 30)) {
			t.Fatal("wire size differs from widget")
		}
	default:
		t.Fatal("latest dimensions did not reach backend")
	}
}
