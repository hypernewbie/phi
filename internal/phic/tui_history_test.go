package phic

import (
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termstate"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"testing"
)

func TestRequestedHistoryReplacesOnlyTheViewAndCanReturnToLive(t *testing.T) {
	state, err := termstate.New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err = state.Feed([]byte("older library page\r\nCURRENT LIVE SCREEN")); err != nil {
		t.Fatal(err)
	}
	snapshot, err := state.Ready()
	if err != nil {
		t.Fatal(err)
	}
	live, err := termemu.NewGhostty(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Skip(err)
	}
	defer live.Close()
	if err = live.Feed([]byte("LIVE PROCESS"), termemu.SourceLive); err != nil {
		t.Fatal(err)
	}
	before, err := live.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	p := &paneActor{emu: live, epoch: 17, epochSet: true, historyGen: 4, cols: 80, rows: 24}
	result := historyResult{epoch: 17, through: 4096, gen: 4, header: wireproto.AttachHeadHeader{Epoch: 17, Head: 4096, Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: 4096, Cols: 80, Rows: 24, Len: len(snapshot)}}, data: snapshot, record: wireproto.RecordingHeader{Epoch: 17, Start: 4096, End: 4096}}
	if err = p.applyHistory(result); err != nil {
		t.Fatal(err)
	}
	if p.history == nil || p.historyThrough != 4096 {
		t.Fatal("requested book was not installed")
	}
	historical, err := p.history.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if p.historyOffset != -historical.History {
		t.Fatal("history view did not open at the older boundary")
	}
	p.frame = historical
	p.historyPending = true
	p.returnLive()
	if p.history != nil || p.historyPending || p.historyOffset != 0 {
		t.Fatal("return-to-live did not release historical parser")
	}
	after, err := live.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if before.Cols != after.Cols || before.Rows != after.Rows || before.Cells[0][0] != after.Cells[0][0] {
		t.Fatal("historical read mutated the live parser")
	}
}
