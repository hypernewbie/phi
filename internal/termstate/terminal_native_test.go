package termstate

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRestoreFailureIsAtomic(t *testing.T) {
	term, err := New(t.Context(), 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	if err = term.Feed([]byte("state-before-restore")); err != nil {
		t.Fatal(err)
	}
	wantANSI, err := term.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	wantContinuation, err := term.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	valid, err := term.Ready()
	if err != nil {
		t.Fatal(err)
	}
	corrupted := append([]byte(nil), valid...)
	corrupted[25] ^= 0xff
	truncated := append([]byte(nil), valid[:len(valid)-5]...)
	for name, data := range map[string][]byte{"corrupted-payload": corrupted, "truncated-record": truncated} {
		if err = term.Restore(data); err == nil {
			t.Fatalf("%s: Restore succeeded, want error", name)
		}
		if cols, rows := term.Geometry(); cols != 12 || rows != 4 {
			t.Fatalf("%s: geometry %dx%d after failed restore", name, cols, rows)
		}
		ansi, err := term.FormatVTState()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(ansi, wantANSI) {
			t.Fatalf("%s: state changed after failed restore", name)
		}
		continuation, err := term.Continuation()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(continuation, wantContinuation) {
			t.Fatalf("%s: continuation changed after failed restore", name)
		}
	}
	if err = term.Feed([]byte("OK")); err != nil {
		t.Fatalf("Feed after failed restore: %v", err)
	}
}

func TestNativeGeometryBounds(t *testing.T) {
	for _, geometry := range [][2]int{{0, 24}, {80, 0}, {-1, 24}, {80, -1}, {65536, 24}, {80, 65536}} {
		if _, err := New(t.Context(), geometry[0], geometry[1]); err == nil {
			t.Fatalf("New(%d,%d) succeeded, want error", geometry[0], geometry[1])
		}
	}
	term, err := New(t.Context(), 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	for _, geometry := range [][2]int{{0, 24}, {80, 0}, {-1, 24}, {80, -1}, {65536, 24}, {80, 65536}} {
		if err = term.Resize(geometry[0], geometry[1]); err == nil {
			t.Fatalf("Resize(%d,%d) succeeded, want error", geometry[0], geometry[1])
		}
		if cols, rows := term.Geometry(); cols != 12 || rows != 4 {
			t.Fatalf("geometry %dx%d after rejected resize", cols, rows)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	resized, err := New(ctx, 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer resized.Close()
	if err = resized.Resize(14, 5); err != nil {
		t.Fatal(err)
	}
	cancel()
	if cols, rows := resized.Geometry(); cols != 14 || rows != 5 {
		t.Fatalf("geometry %dx%d after resize plus cancel", cols, rows)
	}
}

func TestNativeLifetime(t *testing.T) {
	term, err := New(t.Context(), 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err = term.Feed(nil); err != nil {
		t.Fatalf("Feed(nil): %v", err)
	}
	if err = term.Feed([]byte{}); err != nil {
		t.Fatalf("Feed(empty): %v", err)
	}
	if err = term.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err = term.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if err = term.Feed([]byte("x")); err == nil {
		t.Fatal("Feed after Close succeeded")
	}
	if err = term.Resize(14, 5); err == nil {
		t.Fatal("Resize after Close succeeded")
	}
	if _, err = term.Ready(); err == nil {
		t.Fatal("Ready after Close succeeded")
	}
	if _, err = term.ReadyWindow(10); err == nil {
		t.Fatal("ReadyWindow after Close succeeded")
	}
	if _, err = term.Continuation(); err == nil {
		t.Fatal("Continuation after Close succeeded")
	}
	if _, err = term.FormatVTState(); err == nil {
		t.Fatal("FormatVTState after Close succeeded")
	}
	if _, err = term.FormatVT(); err == nil {
		t.Fatal("FormatVT after Close succeeded")
	}
	if _, err = term.FormatViewportVT(); err == nil {
		t.Fatal("FormatViewportVT after Close succeeded")
	}
	if err = term.Restore([]byte("GHOSTSNP")); err == nil {
		t.Fatal("Restore after Close succeeded")
	}
	if _, err = term.HistoryRows(); err == nil {
		t.Fatal("HistoryRows after Close succeeded")
	}
	if _, err = term.IsAlternate(); err == nil {
		t.Fatal("IsAlternate after Close succeeded")
	}
	if err = term.LimitScrollbackLines(10); err == nil {
		t.Fatal("LimitScrollbackLines after Close succeeded")
	}
	if cols, rows := term.Geometry(); cols != 12 || rows != 4 {
		t.Fatalf("cached geometry %dx%d after Close", cols, rows)
	}
	ctx, cancel := context.WithCancel(context.Background())
	canceled, err := New(ctx, 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err = canceled.Close(); err != nil {
		t.Fatalf("Close after cancel: %v", err)
	}
	if err = canceled.Close(); err != nil {
		t.Fatalf("second Close after cancel: %v", err)
	}
}

// barrierContext delegates to a real cancellable context but pauses inside
// Err() at the post-first-chunk check so the test can cancel mid-replay.
type barrierContext struct {
	context.Context
	mu      sync.Mutex
	armed   bool
	calls   int
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *barrierContext) arm() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.armed = true
}

func (b *barrierContext) Err() error {
	b.mu.Lock()
	pause := false
	if b.armed {
		b.calls++
		pause = b.calls == 2
	}
	b.mu.Unlock()
	if pause {
		close(b.entered)
		<-b.release
	}
	return b.Context.Err()
}

func (b *barrierContext) dismiss() {
	b.once.Do(func() { close(b.release) })
}

func TestFeedCancellationMidReplay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	barrier := &barrierContext{Context: ctx, entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(barrier.dismiss)
	term, err := New(barrier, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	barrier.arm()
	data := bytes.Repeat([]byte("."), (64<<10)+512)
	copy(data[(64<<10)-18:], "\r\nFIRST-MARKER-ABC")
	copy(data[64<<10:], "SECOND-MARKER-XYZ")
	feedErr := make(chan error, 1)
	go func() { feedErr <- term.Feed(data) }()
	select {
	case <-barrier.entered:
	case <-time.After(30 * time.Second):
		t.Fatal("Feed did not reach the post-first-chunk check")
	}
	paused, err := term.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(paused, []byte("FIRST-MARKER-ABC")) {
		t.Fatal("first-chunk marker missing at pause")
	}
	if bytes.Contains(paused, []byte("SECOND-MARKER-XYZ")) {
		t.Fatal("second-chunk marker present before its chunk ran")
	}
	cancel()
	barrier.dismiss()
	select {
	case err = <-feedErr:
	case <-time.After(30 * time.Second):
		t.Fatal("Feed did not return after cancel")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Feed error %v, want context.Canceled", err)
	}
	// Inspect state without concurrent access: Feed already returned.
	term.ctx = context.Background()
	final, err := term.FormatVTState()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(final, []byte("SECOND-MARKER-XYZ")) {
		t.Fatal("canceled Feed processed a later chunk")
	}
	term.ctx = barrier
	if err = term.Close(); err != nil {
		t.Fatalf("Close after cancel: %v", err)
	}
}

func TestRestoreRetainsContinuationAndBudgets(t *testing.T) {
	term, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	var history bytes.Buffer
	for i := 0; i < 12000; i++ {
		history.WriteString("history line with enough text to fill rows\r\n")
	}
	history.WriteString("tail \xe4\xbd")
	if err = term.Feed(history.Bytes()); err != nil {
		t.Fatal(err)
	}
	wantContinuation, err := term.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	if len(wantContinuation) == 0 {
		t.Fatal("expected a continuation before restore")
	}
	wantHistory, err := term.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := term.Ready()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := New(t.Context(), 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if err = restored.Restore(snapshot); err != nil {
		t.Fatal(err)
	}
	continuation, err := restored.Continuation()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(continuation, wantContinuation) {
		t.Fatalf("continuation %q after restore, want %q", continuation, wantContinuation)
	}
	gotHistory, err := restored.HistoryRows()
	if err != nil {
		t.Fatal(err)
	}
	// Ready carries a bounded prefix, never old HISTORY pages: restore keeps
	// budgets but not the full pre-checkpoint depth.
	if gotHistory > wantHistory || gotHistory > 10000 {
		t.Fatalf("history rows %d after restore, want at most %d within budget", gotHistory, wantHistory)
	}
	if err = restored.Feed([]byte("\xa0done")); err != nil {
		t.Fatalf("Feed after restore: %v", err)
	}
	if continuation, err = restored.Continuation(); err != nil {
		t.Fatal(err)
	} else if len(continuation) != 0 {
		t.Fatalf("continuation %q after completing input", continuation)
	}
}
