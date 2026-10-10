package phic

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
)

func TestMarkdownUsesExistingRemoteEndpointsAndOnlyReads(t *testing.T) {
	var writes atomic.Int32
	const dir = "/remote/feature tree"
	const path = dir + "/temp/notes #1.md"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writes.Add(1)
			http.Error(w, "read only", 405)
			return
		}
		if (r.URL.Path == "/api/markdown/files" || r.URL.Path == "/api/markdown/file") && r.URL.Query().Get("cwd") != dir {
			t.Errorf("Markdown cwd is not active remote pane: path=%s cwd=%q want=%q", r.URL.Path, r.URL.Query().Get("cwd"), dir)
		}
		switch r.URL.Path {
		case "/api/markdown/files":
			json.NewEncoder(w).Encode([]markdownFile{{Path: path, Name: "notes #1.md", Dir: "./temp"}})
		case "/api/markdown/file":
			if r.URL.Query().Get("path") != path {
				t.Error("file path lost encoding")
			}
			fmt.Fprint(w, "# Native Markdown\n\nHello **Phi**.\n\n- one\n- two\n\n```go\nfmt.Println(\"hi\")\n```\n\x1b]52;c;ZXZpbA==\x07")
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	m := newModelWithServer(t, srv)
	defer m.closeAll()
	m.project = "/wrong-local-project"
	tab := m.ensureTab(m.currentOrigin(), "p", spawnCapture{title: "remote", project: dir, coder: "shell"})
	m.syncTabContext(tab)
	m.diff.open = true
	m.diff.markdown = true
	m.focus = focusDiff
	m.Update(m.refreshMarkdownList()())
	if len(m.markdown.files) != 1 {
		t.Fatalf("failed remote list: %+v", m.markdown)
	}
	m.Update(m.openMarkdownFile(0)())
	rendered := m.renderMarkdownModal()
	plain := ansi.Strip(rendered)
	if !strings.Contains(plain, "Native Markdown") || !strings.Contains(plain, "Hello Phi") || m.markdown.err != "" {
		t.Fatalf("Markdown was not rendered: %q, %s", plain, m.markdown.err)
	}
	if strings.Contains(rendered, "\x1b]52;") || strings.Contains(m.markdown.raw, "\x1b") {
		t.Fatal("source control sequence escaped into client chrome")
	}
	if _, cmd := m.handleModalKey(tea.KeyPressMsg{Code: 'y', Text: "y"}); cmd == nil || fmt.Sprintf("%s", cmd()) != m.markdown.source {
		t.Fatal("explicit Markdown copy did not use the exact source")
	}
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	if _, cmd := m.handleModalKey(tea.KeyPressMsg{Code: 'f', Text: "f"}); cmd != nil {
		t.Fatal("filename insert returned a clipboard command")
	}
	if m.modal.kind != modalNone || m.focus != focusTerminal {
		t.Fatal("filename insert did not return to the terminal")
	}
	select {
	case in := <-tab.actor.inbox:
		if in.Kind != paneInputPaste || string(in.Paste) != "notes #1.md" {
			t.Fatalf("filename insert typed %+v, want paste notes #1.md", in)
		}
	default:
		t.Fatal("filename insert sent no terminal input")
	}
	// Hand-rolled actor has no run loop; detach before closeAll cleanup.
	tab.actor = nil
	// Reopen the viewer for the remaining modal-state checks.
	m.modal.open(modalMarkdown, "Markdown")
	m.markdown.reading = true
	m.focus = focusDiff
	m.handlePaste(tea.PasteMsg{Content: "do not edit or paste"})
	if strings.Contains(m.markdown.raw, "do not edit") {
		t.Fatal("Markdown paste mutated content")
	}
	if writes.Load() != 0 {
		t.Fatal("Markdown viewer wrote server state")
	}
	m.handleModalKey(tea.KeyPressMsg{Code: tea.KeyLeft})
	if m.markdown.reading {
		t.Fatal("back did not restore file list")
	}
}
func TestMarkdownResultsAreBoundToOriginCwdAndRequest(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.markdown = markdownState{ticket: 2, origin: m.currentOrigin(), dir: m.markdownDir(), loading: true}
	m.diff.markdown = true
	valid := markdownLoadedMsg{gen: m.gen, ticket: 2, origin: m.currentOrigin(), dir: m.markdownDir(), files: []markdownFile{{Name: "correct.md"}}}
	wrong := valid
	wrong.ticket = 1
	m.Update(wrong)
	if !m.markdown.loading {
		t.Fatal("stale request painted")
	}
	wrong = valid
	wrong.origin = "http://another:7070"
	m.Update(wrong)
	if !m.markdown.loading {
		t.Fatal("other origin painted")
	}
	wrong = valid
	wrong.dir = "/other-project"
	m.Update(wrong)
	if !m.markdown.loading {
		t.Fatal("other cwd painted")
	}
	m.Update(valid)
	if m.markdown.loading || len(m.markdown.files) != 1 {
		t.Fatal("current list was not applied")
	}
}
func TestMarkdownShiftedPrefixAndTabSwitch(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.Update(tea.KeyPressMsg{Code: 0x1d})
	m.Update(tea.KeyPressMsg{Code: 'm', Text: "M", Mod: tea.ModShift})
	if m.modal.kind != modalNone || !m.diff.markdown || m.focus != focusDiff {
		t.Fatal("normalized Shift+M opened Rename instead of Markdown")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if m.diff.markdown || m.focus != focusDiff {
		t.Fatal("Tab did not switch to Diff")
	}
	m.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	if !m.diff.markdown || m.focus != focusDiff {
		t.Fatal("Tab did not switch back to Markdown")
	}
}

func TestMarkdownResizeCannotPaintPreviousFileUnderNewName(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.diff.open = true
	m.diff.markdown = true
	m.focus = focusDiff
	m.markdown = markdownState{origin: m.currentOrigin(), dir: m.markdownDir(), raw: "old document", reading: true, path: "/work/temp/old.md", files: []markdownFile{{Path: "/work/temp/new.md"}}}
	m.openMarkdownFile(0)
	ticket := m.markdown.ticket
	m.Update(tea.WindowSizeMsg{Width: 160, Height: 30})
	if m.markdown.raw != "" || len(m.markdown.lines) != 0 || m.markdown.ticket != ticket {
		t.Fatal("resize admitted a reflow of the previous file")
	}
}

func TestMarkdownHeaderAndRowsAreClickable(t *testing.T) {
	m, _, _ := closeControlsModel(t)
	m.diff.open = true
	m.focus = focusDiff
	r := m.diffRect()
	m.handleReaderClick(r.X+12, r.Y+1)
	if !m.diff.markdown {
		t.Fatal("Markdown header click did nothing")
	}
	m.markdown.loading = false
	m.markdown.files = []markdownFile{{Name: "one.md", Path: "/work/temp/one.md"}, {Name: "two.md", Path: "/work/temp/two.md"}}
	_, cmd := m.handleReaderClick(r.X+3, r.Y+4)
	if cmd == nil || m.markdown.path != "/work/temp/two.md" {
		t.Fatal("click did not open selected Markdown row")
	}
	m.handleReaderClick(r.X+2, r.Y+1)
	if m.diff.markdown {
		t.Fatal("Diff header click did nothing")
	}
}

func TestMarkdownFilenameKeyTypesIntoTerminal(t *testing.T) {
	m, tab, _ := closeControlsModel(t)
	m.width = 140
	m.height = 40
	m.diff.open = true
	m.diff.markdown = true
	m.markdown = markdownState{origin: m.currentOrigin(), dir: m.markdownDir(), path: "/work/temp/proposal.md", files: []markdownFile{{Path: "/work/temp/proposal.md", Name: "proposal.md"}}, reading: true}
	m.modal.open(modalMarkdown, "Markdown")
	tab.actor = &paneActor{ctx: t.Context(), conn: &websocket.Conn{}, inbox: make(chan paneInput, 4)}
	m.Update(tea.KeyPressMsg{Code: 'f'})
	if m.modal.kind != modalNone || m.focus != focusTerminal {
		t.Fatal("f did not close the viewer and return to the terminal")
	}
	select {
	case in := <-tab.actor.inbox:
		if in.Kind != paneInputPaste || string(in.Paste) != "proposal.md" {
			t.Fatalf("f typed %+v, want paste proposal.md", in)
		}
	default:
		t.Fatal("f sent no terminal input")
	}
	// Hand-rolled actor has no run loop; detach before closeAll cleanup.
	tab.actor = nil
}
