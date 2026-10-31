package termstate

// Decoded-behavior compatibility between the wasm fixture and the native
// engine. Test-only consumer: production termstate never imports termemu.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/hypernewbie/phi/internal/termemu"
)

var decodedModes = []termemu.Mode{
	termemu.ModeApplicationCursor,
	termemu.ModeApplicationKeypad,
	termemu.ModeBracketedPaste,
	termemu.ModeMouseButton,
	termemu.ModeMouseMotion,
	termemu.ModeMouseAny,
	termemu.ModeMouseSgr,
	termemu.ModeMouseUrxvt,
	termemu.ModeSynchronizedOutput,
	termemu.ModeAlternateScreen,
}

func newDecodedConsumer(t *testing.T, cols, rows int) termemu.Terminal {
	t.Helper()
	consumer, err := termemu.NewGhostty(termemu.Options{
		Cols: cols, Rows: rows,
		ScrollbackBytes: 64 << 20, ScrollbackLines: 10000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return consumer
}

func compareDecodedFrame(t *testing.T, where string, a, b termemu.Frame) {
	t.Helper()
	if a.Cols != b.Cols || a.Rows != b.Rows {
		t.Fatalf("%s: geometry %dx%d, want %dx%d", where, b.Cols, b.Rows, a.Cols, a.Rows)
	}
	if !reflect.DeepEqual(a.Cursor, b.Cursor) {
		t.Fatalf("%s: cursor %+v, want %+v", where, b.Cursor, a.Cursor)
	}
	if a.Alt != b.Alt {
		t.Fatalf("%s: alternate %v, want %v", where, b.Alt, a.Alt)
	}
	if !reflect.DeepEqual(a.Cells, b.Cells) {
		t.Fatalf("%s: decoded cells differ", where)
	}
}

func compareDecodedModes(t *testing.T, where string, a, b termemu.Terminal) {
	t.Helper()
	for _, m := range decodedModes {
		am, err := a.Mode(m)
		if err != nil {
			t.Fatal(err)
		}
		bm, err := b.Mode(m)
		if err != nil {
			t.Fatal(err)
		}
		if am != bm {
			t.Fatalf("%s: mode %d active=%v, want %v", where, int(m), bm, am)
		}
	}
}

// snapshotBothScreens captures primary and alternate without clearing either.
// Both consumers receive identical suffixes after their ANSI reached ground.
func snapshotBothScreens(t *testing.T, consumer termemu.Terminal) (primary, alternate termemu.Frame) {
	t.Helper()
	if err := consumer.Feed([]byte("\x1b[?1047l"), termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	primary, err := consumer.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := consumer.Feed([]byte("\x1b[?1047h"), termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	alternate, err = consumer.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	return primary, alternate
}

func loadCompatFixture(t *testing.T) compatFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "wasm-compat-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture compatFixture
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func checkDecodedANSI(t *testing.T, where string, cols, rows int, refANSI, actANSI []byte) {
	t.Helper()
	ref := newDecodedConsumer(t, cols, rows)
	defer ref.Close()
	act := newDecodedConsumer(t, cols, rows)
	defer act.Close()
	if err := ref.Feed(refANSI, termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	if err := act.Feed(actANSI, termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	refPrimary, refAlt := snapshotBothScreens(t, ref)
	actPrimary, actAlt := snapshotBothScreens(t, act)
	compareDecodedFrame(t, where+"/primary", refPrimary, actPrimary)
	compareDecodedFrame(t, where+"/alternate", refAlt, actAlt)
	compareDecodedModes(t, where, ref, act)
}

func TestDecodedCompatMatchesWasmFixture(t *testing.T) {
	fixture := loadCompatFixture(t)
	for _, c := range fixture.Cases {
		term, err := New(t.Context(), c.Cols, c.Rows)
		if err != nil {
			t.Fatal(err)
		}
		if err = term.Feed(c.Prefix); err != nil {
			term.Close()
			t.Fatal(err)
		}
		ansi, err := term.FormatVTState()
		if err != nil {
			term.Close()
			t.Fatal(err)
		}
		checkDecodedANSI(t, c.Name+"/initial", c.Cols, c.Rows, c.Initial.FormatVTState, ansi)
		for i, op := range c.Ops {
			where := fmt.Sprintf("%s/op%d", c.Name, i)
			if op.Resize != nil {
				if err = term.Resize(op.Resize.Cols, op.Resize.Rows); err != nil {
					term.Close()
					t.Fatal(err)
				}
			} else if err = term.Feed(op.Feed); err != nil {
				term.Close()
				t.Fatal(err)
			}
			ansi, err := term.FormatVTState()
			if err != nil {
				term.Close()
				t.Fatal(err)
			}
			checkDecodedANSI(t, where, op.Observe.Cols, op.Observe.Rows, op.Observe.FormatVTState, ansi)
		}
		term.Close()
	}
}

func TestNativeReadyRestoresInClient(t *testing.T) {
	fixture := loadCompatFixture(t)
	for _, c := range fixture.Cases {
		term, err := New(t.Context(), c.Cols, c.Rows)
		if err != nil {
			t.Fatal(err)
		}
		if err = term.Feed(c.Prefix); err != nil {
			term.Close()
			t.Fatal(err)
		}
		nativeReady, err := term.Ready()
		term.Close()
		if err != nil {
			t.Fatal(err)
		}
		ref := newDecodedConsumer(t, c.Cols, c.Rows)
		defer ref.Close()
		act := newDecodedConsumer(t, c.Cols, c.Rows)
		defer act.Close()
		refRestorer, ok := ref.(interface{ RestoreReady([]byte) error })
		if !ok {
			t.Fatal("client consumer lacks RestoreReady")
		}
		actRestorer, ok := act.(interface{ RestoreReady([]byte) error })
		if !ok {
			t.Fatal("client consumer lacks RestoreReady")
		}
		if err = refRestorer.RestoreReady(c.Ready); err != nil {
			t.Fatal(err)
		}
		if err = actRestorer.RestoreReady(nativeReady); err != nil {
			t.Fatal(err)
		}
		refPrimary, refAlt := snapshotBothScreens(t, ref)
		actPrimary, actAlt := snapshotBothScreens(t, act)
		compareDecodedFrame(t, c.Name+"/ready-primary", refPrimary, actPrimary)
		compareDecodedFrame(t, c.Name+"/ready-alternate", refAlt, actAlt)
		compareDecodedModes(t, c.Name+"/ready", ref, act)
	}
}
