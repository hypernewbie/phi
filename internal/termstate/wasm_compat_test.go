package termstate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

type compatObservation struct {
	FormatVTState []byte `json:"format_vt_state"`
	Continuation  []byte `json:"continuation"`
	Cols          int    `json:"cols"`
	Rows          int    `json:"rows"`
	Alternate     bool   `json:"alternate"`
}

type compatResize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type compatOperation struct {
	Feed    []byte            `json:"feed,omitempty"`
	Resize  *compatResize     `json:"resize,omitempty"`
	Observe compatObservation `json:"observation"`
}

type compatCase struct {
	Name    string            `json:"name"`
	Cols    int               `json:"cols"`
	Rows    int               `json:"rows"`
	Prefix  []byte            `json:"prefix"`
	Ready   []byte            `json:"ready"`
	Initial compatObservation `json:"initial"`
	Ops     []compatOperation `json:"ops"`
}

type compatFixture struct {
	Cases []compatCase `json:"cases"`
}

func checkCompatObservation(t *testing.T, term *Terminal, want compatObservation, where string) {
	t.Helper()
	ansi, err := term.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ansi, want.FormatVTState) {
		t.Fatalf("%s: FormatVTState differs: got %d bytes, want %d bytes", where, len(ansi), len(want.FormatVTState))
	}
	continuation, err := term.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(continuation, want.Continuation) {
		t.Fatalf("%s: Continuation differs: got %q, want %q", where, continuation, want.Continuation)
	}
	cols, rows := term.Geometry()
	if cols != want.Cols || rows != want.Rows {
		t.Fatalf("%s: geometry %dx%d, want %dx%d", where, cols, rows, want.Cols, want.Rows)
	}
	alternate, err := term.IsAlternate()
	if err != nil {
		t.Fatal(err)
	}
	if alternate != want.Alternate {
		t.Fatalf("%s: alternate %v, want %v", where, alternate, want.Alternate)
	}
}

func TestWasmCompat(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "wasm-compat-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture compatFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) != 4 {
		t.Fatalf("expected 4 cases, got %d", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		term, err := New(t.Context(), c.Cols, c.Rows)
		if err != nil {
			t.Fatal(err)
		}
		if err = term.Feed(c.Prefix); err != nil {
			term.Close()
			t.Fatal(err)
		}
		checkCompatObservation(t, term, c.Initial, c.Name+"/initial")
		for i, op := range c.Ops {
			where := fmt.Sprintf("%s/op%d", c.Name, i)
			if op.Resize != nil {
				if err = term.Resize(op.Resize.Cols, op.Resize.Rows); err != nil {
					term.Close()
					t.Fatal(err)
				}
			} else {
				if err = term.Feed(op.Feed); err != nil {
					term.Close()
					t.Fatal(err)
				}
			}
			checkCompatObservation(t, term, op.Observe, where)
		}
		term.Close()
	}
}

func TestWasmReadyRestoresNatively(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "wasm-compat-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture compatFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		term, err := New(t.Context(), c.Cols, c.Rows)
		if err != nil {
			t.Fatal(err)
		}
		if err = term.Restore(c.Ready); err != nil {
			term.Close()
			t.Fatal(err)
		}
		checkCompatObservation(t, term, c.Initial, c.Name+"/wasm-ready-restore")
		term.Close()
	}
}
