package ws

import (
	"errors"
	"testing"
)

func TestReplayFenceExcludesLaterResizeAtSamePosition(t *testing.T) {
	h := NewHub(1024)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	epoch := ph.EpochOf()
	resize := func(cols uint16) {
		t.Helper()
		commit, _, err := h.StagePaneResize("p", cols, 30)
		if err != nil {
			t.Fatal(err)
		}
		if err := commit(); err != nil {
			t.Fatal(err)
		}
	}
	resize(100)
	fence := EncodeEventCursor(epoch, 0, 1)
	resize(120)
	page, err := h.Replay("p", ReplayRequest{Epoch: epoch, ThroughCursor: fence})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) != 0 || len(page.Resizes) != 1 || page.Resizes[0].Cols != 100 || page.EndCursor != fence {
		t.Fatalf("replay crossed attach fence: %+v", page)
	}
	page, err = h.Replay("p", ReplayRequest{Epoch: epoch, ThroughCursor: EncodeEventCursor(epoch, 0, 2), AfterCursor: fence})
	if err != nil || len(page.Resizes) != 1 || page.Resizes[0].Cols != 120 {
		t.Fatalf("resize-only continuation lost geometry: %+v, %v", page, err)
	}
}

func TestReplayRejectsInconsistentCursorPositions(t *testing.T) {
	h := NewHub(1024)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	if err := h.InitPaneJournal("p", 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("a")); err != nil {
		t.Fatal(err)
	}
	commit, _, err := h.StagePaneResize("p", 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	if err := h.Ingest("p", []byte("b")); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("p")
	epoch := ph.EpochOf()
	cases := []struct {
		name                                          string
		from, through, throughOrd, afterPos, afterOrd uint64
	}{
		{"end excludes earlier resize", 0, 2, 0, 0, 0},
		{"end includes future resize", 0, 0, 1, 0, 0},
		{"start position differs", 1, 2, 1, 0, 0},
		{"start skips earlier resize", 2, 2, 1, 2, 0},
		{"start includes future resize", 0, 2, 1, 0, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := h.Replay("p", ReplayRequest{Epoch: epoch, From: tc.from, Through: tc.through,
				ThroughCursor: EncodeEventCursor(epoch, tc.through, tc.throughOrd),
				AfterCursor:   EncodeEventCursor(epoch, tc.afterPos, tc.afterOrd)})
			if !errors.Is(err, ErrReplayBadRequest) {
				t.Fatalf("inconsistent cursor admitted: %v", err)
			}
		})
	}
}
