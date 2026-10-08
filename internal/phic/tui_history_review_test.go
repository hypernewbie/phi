package phic

import (
	"errors"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type reviewHistoryTerminal struct {
	termemu.Terminal
	closed      int
	scrolls     []int
	snapshotErr error
}

func (t *reviewHistoryTerminal) RestoreReady([]byte) error { return nil }
func (t *reviewHistoryTerminal) Close() error              { t.closed++; return t.Terminal.Close() }
func (t *reviewHistoryTerminal) ScrollViewport(n int) error {
	t.scrolls = append(t.scrolls, n)
	return nil
}
func (t *reviewHistoryTerminal) Snapshot() (termemu.Frame, error) {
	if t.snapshotErr != nil {
		return termemu.Frame{}, t.snapshotErr
	}
	return t.Terminal.Snapshot()
}
func historyReviewTerminal(t *testing.T) *reviewHistoryTerminal {
	t.Helper()
	terminal, err := stubBuild(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 1 << 20, ScrollbackLines: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return &reviewHistoryTerminal{Terminal: terminal}
}

func TestHistoryFailureKeepsPreviousWorkingPage(t *testing.T) {
	old := historyReviewTerminal(t)
	defer old.Close()
	broken := historyReviewTerminal(t)
	failure := errors.New("snapshot failure")
	broken.snapshotErr = failure
	p := &paneActor{epoch: 7, historyGen: 1, history: old, build: func(termemu.Options) (termemu.Terminal, error) { return broken, nil }}
	result := historyResult{epoch: 7, gen: 1, header: wireproto.AttachHeadHeader{Ckpt: &wireproto.CheckpointHeader{Cols: 80, Rows: 24}}}
	if err := p.applyHistory(result); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if p.history != old || old.closed != 0 || broken.closed != 1 {
		t.Fatal("failed page disposed the existing working history")
	}
}

func TestReturnLiveResetsLocalScrollWithoutArchivedPage(t *testing.T) {
	live := historyReviewTerminal(t)
	defer live.Close()
	canceled := 0
	p := &paneActor{emu: live, historyOffset: -10, historyPending: true, historyCancel: func() { canceled++ }}
	p.returnLive()
	if canceled != 1 || p.historyCancel != nil {
		t.Fatal("returning the book did not cancel its request")
	}
	if p.historyOffset != 0 || p.historyPending || !p.dirty || len(live.scrolls) != 1 || live.scrolls[0] <= 0 {
		t.Fatal("return to live left the local parser scrolled away")
	}
}

func TestNewEpochDisposesOldHistoricalPage(t *testing.T) {
	old := historyReviewTerminal(t)
	live := historyReviewTerminal(t)
	p := &paneActor{ctx: t.Context(), emu: live, history: old, historyPending: true, historyGen: 5, epoch: 7, epochSet: true, cols: 80, rows: 24, emuCols: 80, emuRows: 24, build: stubBuild, conn: &websocket.Conn{}, outbox: make(chan paneWrite, 1)}
	defer func() { _ = p.emu.Close() }()
	if err := p.bootstrap(wireAttach{Header: wireproto.AttachHeadHeader{Epoch: 8}}); err != nil {
		t.Fatal(err)
	}
	if p.history != nil || p.historyPending || p.historyGen <= 5 || old.closed != 1 {
		t.Fatal("new pane lifetime kept the old archive view")
	}
}
