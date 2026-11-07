package phic

import (
	"fmt"
	"testing"

	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// geometryRecorder remembers the order in which the client terminal saw
// bytes and resizes.
type geometryRecorder struct {
	*stub.Terminal
	calls []string
}

func (g *geometryRecorder) Feed(b []byte, source termemu.Source) error {
	g.calls = append(g.calls, fmt.Sprintf("feed:%d", len(b)))
	return g.Terminal.Feed(b, source)
}

func (g *geometryRecorder) Resize(cols, rows int) error {
	g.calls = append(g.calls, fmt.Sprintf("resize:%dx%d", cols, rows))
	return g.Terminal.Resize(cols, rows)
}

// TestReplayResizeMarkersApplyInOrder proves a replay page with several
// geometry markers resizes the client terminal in the order the server
// recorded them, and paints each span under the grid that was in effect
// at that byte.
func TestReplayResizeMarkersApplyInOrder(t *testing.T) {
	_, p, _ := geometryModel(t)
	recorder := &geometryRecorder{Terminal: p.emu.(*stub.Terminal)}
	p.emu = recorder
	// "first" is painted on the 100 column grid. The pane shrinks to 60
	// columns at byte five, so the rest is painted on the narrow grid.
	body := []byte("first" + "second")
	header := wireproto.ReplayHeader{
		Epoch:   7,
		Start:   0,
		End:     uint64(len(body)),
		Resizes: [][3]uint64{{0, 100, 20}, {5, 60, 10}},
	}
	if err := p.feedRecording(header, body, termemu.SourceReplay); err != nil {
		t.Fatal(err)
	}
	want := []string{"resize:100x20", "feed:5", "resize:60x10", "feed:6"}
	if len(recorder.calls) != len(want) {
		t.Fatalf("unexpected client terminal calls: %v", recorder.calls)
	}
	for i, call := range want {
		if recorder.calls[i] != call {
			t.Fatalf("client terminal call %d: got %q want %q (%v)", i, recorder.calls[i], call, recorder.calls)
		}
	}
	if p.emuCols != 60 || p.emuRows != 10 {
		t.Fatalf("last marker did not win: %dx%d", p.emuCols, p.emuRows)
	}
}
