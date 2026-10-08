package ws

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
)

func TestHistoryRequestsAreCancelableAndCannotChangeConcurrentLiveState(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := bytes.Repeat([]byte("archive 你🙂\r\n"), 30000)
	if err := h.Ingest("concurrent", source); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("concurrent")
	ph.mu.Lock()
	epoch := ph.epoch
	ph.mu.Unlock()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, _, _, err := h.HistoricalStateContext(ctx, "concurrent", epoch, uint64(len(source))); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled history request: %v", err)
	}
	start := make(chan struct{})
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _, _, _, err := h.HistoricalStateContext(t.Context(), "concurrent", epoch, uint64(len(source)/2))
			results <- err
		}()
	}
	close(start)
	for i := 0; i < 32; i++ {
		if err := h.Ingest("concurrent", []byte("live input\r\n")); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	pos, _, _, _, err := h.State("concurrent")
	if err != nil {
		t.Fatal(err)
	}
	if pos.Head != uint64(len(source)+32*len("live input\r\n")) {
		t.Fatal("history rewound the live frontier")
	}
	recording, ok := h.Recording("concurrent", 0, uint64(len(source)))
	if !ok || !bytes.Equal(recording.Data, source) {
		t.Fatal("concurrent history changed source bytes")
	}
}
