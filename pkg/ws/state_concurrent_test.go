package ws

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"
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

// historyBarrierContext pauses the fifth Err check: after capture and New,
// before replay in the base-free request below. All errors come from the real
// cancellable parent; this adds no hook to the live server.
type historyBarrierContext struct {
	context.Context
	checks  int
	entered chan struct{}
	release chan struct{}
}

func (c *historyBarrierContext) Err() error {
	c.checks++
	if c.checks == 5 {
		close(c.entered)
		<-c.release
	}
	return c.Context.Err()
}

func TestHistoryRequestPausedAfterCaptureDoesNotHoldPaneLock(t *testing.T) {
	h := NewHub(4096)
	if err := h.SetRecordingDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	source := bytes.Repeat([]byte("archive line\r\n"), 1000)
	if err := h.Ingest("paused", source); err != nil {
		t.Fatal(err)
	}
	ph, _ := h.LookupPane("paused")
	ph.mu.Lock()
	epoch := ph.epoch
	ph.mu.Unlock()
	ctx, cancel := context.WithCancel(t.Context())
	barrier := &historyBarrierContext{Context: ctx, entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	dismiss := func() { release.Do(func() { close(barrier.release) }) }
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	finished := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		dismiss()
		select {
		case <-finished:
		case <-time.After(30 * time.Second):
			t.Error("history request did not exit during cleanup")
		}
	})
	go func() {
		defer close(finished)
		_, data, _, _, err := h.HistoricalStateContext(barrier, "paused", epoch, uint64(len(source)))
		done <- result{data: data, err: err}
	}()
	select {
	case <-barrier.entered:
	case <-time.After(30 * time.Second):
		t.Fatal("history request did not reach the post-capture check")
	}
	ingested := make(chan error, 1)
	go func() { ingested <- h.Ingest("paused", []byte("live while paused\r\n")) }()
	select {
	case err := <-ingested:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("live Ingest blocked behind a paused history request")
	}
	cancel()
	dismiss()
	select {
	case r := <-done:
		if !errors.Is(r.err, context.Canceled) {
			t.Fatalf("paused history request error %v, want context.Canceled", r.err)
		}
		if r.data != nil {
			t.Fatal("canceled history request published a partial checkpoint")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("history request did not return after cancel")
	}
}
