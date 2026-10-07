package phic

import "testing"

func TestContextSelectionKeepsChromeFocus(t *testing.T) {
	for _, kind := range []modalKind{modalProject, modalCoder, modalWorktree} {
		for _, focus := range []focusRegion{focusTerminal, focusSessions, focusRail, focusTabs, focusDiff} {
			m := coderStateModel(t, nil)
			m.focus = focus
			m.modal.open(kind, "context")
			switch kind {
			case modalProject:
				m.modal.cursor = -1
				m.modal.field.set("/projects/next")
			case modalCoder:
				m.modal.items = []modalItem{{label: "OpenCode", value: "opencode"}, {label: "Pi", value: "pi"}}
				m.modal.cursor = 1
			case modalWorktree:
				m.modal.items = []modalItem{{label: "branch", value: "/projects/next/branch"}}
				m.modal.cursor = 0
			}
			m.submitModal()
			want := focus
			if want == focusTerminal {
				want = focusSessions
			}
			if m.focus != want {
				t.Fatalf("picker %v from %v focused %v, want %v", kind, focus, m.focus, want)
			}
			if m.modal.kind != modalNone {
				t.Fatal("picker did not close")
			}
			if kind == modalCoder && m.selectedCoderID() != "pi" {
				t.Fatal("coder was not selected")
			}
			if kind == modalProject && m.project != "/projects/next" {
				t.Fatal("project was not selected")
			}
			if kind == modalWorktree && m.worktree != "/projects/next/branch" {
				t.Fatal("worktree was not selected")
			}
		}
	}
}

func TestInvalidProjectKeepsPickerAndFocus(t *testing.T) {
	m := deltaTestModel()
	m.focus = focusRail
	m.modal.open(modalProject, "project")
	m.modal.cursor = -1
	m.modal.field.set("relative/path")
	m.submitModal()
	if m.focus != focusRail || m.modal.kind != modalProject || m.modal.err == "" {
		t.Fatal("invalid selection changed focus or dismissed picker")
	}
}

func TestCancellingContextPickerPreservesFocus(t *testing.T) {
	for _, focus := range []focusRegion{focusTerminal, focusSessions, focusRail} {
		m := deltaTestModel()
		m.focus = focus
		m.modal.open(modalCoder, "coder")
		m.closeModal()
		if m.focus != focus {
			t.Fatal("cancel changed focus")
		}
	}
}
