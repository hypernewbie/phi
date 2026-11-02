package phic

import (
	"github.com/hypernewbie/phi/internal/termemu"
	"testing"
)

type reviewHistoryTerminal struct {
	termemu.Terminal
	scrolls []int
}

func (t *reviewHistoryTerminal) ScrollViewport(n int) error {
	t.scrolls = append(t.scrolls, n)
	return nil
}
func historyReviewTerminal(t *testing.T) *reviewHistoryTerminal {
	t.Helper()
	terminal, err := stubBuild(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 1 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Fatal(err)
	}
	return &reviewHistoryTerminal{Terminal: terminal}
}

func TestLocalHistoryWorksOfflineAndReturnsToLive(t *testing.T) {
	live := historyReviewTerminal(t)
	defer live.Close()
	p := &paneActor{emu: live, frame: termemu.Frame{History: 100}, frontier: 500, epoch: 7}
	p.requestHistory() // No API or connection exists.
	if p.historyOffset != -100 || len(live.scrolls) != 1 || live.scrolls[0] != -100 {
		t.Fatal("history did not scroll to the local top")
	}
	p.returnLive()
	if p.historyOffset != 0 || len(live.scrolls) != 2 || live.scrolls[1] <= 0 || p.frontier != 500 || p.epoch != 7 {
		t.Fatal("local scrolling changed the source position or failed to return live")
	}
}
