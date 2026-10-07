package phic

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type countedSnapshots struct {
	termemu.Terminal
	snapshots   atomic.Int64
	snapshotErr error
}

func (c *countedSnapshots) Snapshot() (termemu.Frame, error) {
	c.snapshots.Add(1)
	if c.snapshotErr != nil {
		return termemu.Frame{}, c.snapshotErr
	}
	return c.Terminal.Snapshot()
}

func TestPaneSnapshotFailureDoesNotSpin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		failure := errors.New("snapshot failed")
		counted := &countedSnapshots{snapshotErr: failure}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &paneActor{ctx: ctx, emu: counted, dirty: true, lastPaint: time.Now(), lastInteraction: time.Now()}
		done := make(chan error, 1)
		go func() { done <- p.consume(make(chan paneRead)) }()
		synctest.Wait()
		time.Sleep(paneInteractiveInterval)
		if err := <-done; err != failure {
			t.Fatal(err)
		}
		if counted.snapshots.Load() != 1 {
			t.Fatal("snapshot failure was retried in a hot loop")
		}
	})
}

func TestPaneAutomaticInputDoesNotKeepHighRate(t *testing.T) {
	now := time.Now()
	old := now.Add(-paneWatchingAfter)
	p := &paneActor{cols: 40, rows: 10, lastInteraction: old, uncertainInput: true}
	if err := p.handleInput(paneInput{Kind: paneInputResize, Cols: 40, Rows: 10}); err != nil {
		t.Fatal(err)
	}
	if err := p.handleInput(paneInput{Kind: paneInputFocus}); err != nil {
		t.Fatal(err)
	}
	if p.lastInteraction != old {
		t.Fatal("automatic input renewed interaction")
	}
	if err := p.handleInput(paneInput{Kind: paneInputKey}); err != nil {
		t.Fatal(err)
	}
	if panePaintInterval(time.Now(), p.lastInteraction) != paneInteractiveInterval {
		t.Fatal("real input did not renew interaction")
	}
}

func TestPanePaintIntervals(t *testing.T) {
	now := time.Unix(1234, 0)
	if got := panePaintInterval(now, now); got != paneInteractiveInterval {
		t.Fatal(got)
	}
	if got := panePaintInterval(now, now.Add(-paneWatchingAfter)); got != paneWatchingInterval {
		t.Fatal(got)
	}
	if got := panePaintInterval(now, now.Add(-paneWatchingAfter+time.Nanosecond)); got != paneInteractiveInterval {
		t.Fatal(got)
	}
}

// Fake time tests assert the scheduling policy, never a machine's speed.
func TestPanePaintSleepsAndPreservesEveryByte(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		term, err := stub.New(termemu.Options{Cols: 40, Rows: 10, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
		if err != nil {
			t.Fatal(err)
		}
		defer term.Close()
		counted := &countedSnapshots{Terminal: term}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &paneActor{ctx: ctx, emu: counted, inbox: make(chan paneInput, 128), events: make(chan paneEvent, 128), lastPaint: time.Now(), lastInteraction: time.Now()}
		reads := make(chan paneRead)
		done := make(chan error, 1)
		go func() { done <- p.consume(reads) }()
		synctest.Wait()
		time.Sleep(time.Second)
		synctest.Wait()
		if counted.snapshots.Load() != 0 {
			t.Fatal("clean pane woke for a snapshot")
		}
		// Set the last paint to now so the entire burst precedes one paint.
		p.mu.Lock()
		p.lastPaint = time.Now()
		p.mu.Unlock()
		var frontier uint64
		for i := 0; i < 100; i++ {
			data := []byte("line\r\n")
			reads <- paneRead{bytes: wireproto.EncodeLiveOutputFrame(frontier, data)}
			frontier += uint64(len(data))
		}
		synctest.Wait()
		got, _, _, _, _, _ := p.state()
		if got != frontier {
			t.Fatalf("lost bytes: %d != %d", got, frontier)
		}
		if counted.snapshots.Load() != 0 {
			t.Fatal("snapshotted every incoming span")
		}
		time.Sleep(paneInteractiveInterval)
		synctest.Wait()
		if counted.snapshots.Load() != 1 {
			t.Fatalf("burst snapshots = %d", counted.snapshots.Load())
		}
		f, ok := p.snapshotCopy()
		if !ok || frameText(f) == "" {
			t.Fatal("no final visible frame")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if counted.snapshots.Load() != 1 {
			t.Fatal("clean screen kept repainting")
		}
		close(reads)
		if err := <-done; err != io.EOF {
			t.Fatal(err)
		}
	})
}

func TestWatchingInputAdvancesPendingPaint(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		term, err := stub.New(termemu.Options{Cols: 40, Rows: 10, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
		if err != nil {
			t.Fatal(err)
		}
		defer term.Close()
		counted := &countedSnapshots{Terminal: term}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		p := &paneActor{ctx: ctx, emu: counted, inbox: make(chan paneInput, 128), events: make(chan paneEvent, 128), lastPaint: time.Now(), lastInteraction: time.Now().Add(-paneWatchingAfter)}
		reads := make(chan paneRead)
		done := make(chan error, 1)
		go func() { done <- p.consume(reads) }()
		reads <- paneRead{bytes: wireproto.EncodeLiveOutputFrame(0, []byte("hello"))}
		synctest.Wait()
		time.Sleep(paneInteractiveInterval)
		synctest.Wait()
		if counted.snapshots.Load() != 0 {
			t.Fatal("watching mode painted at interactive rate")
		}
		// Scroll is actual interaction, including when disconnected. The inbox
		// wakes the actor and brings its pending passive paint forward.
		p.scroll(-1)
		synctest.Wait()
		if counted.snapshots.Load() != 1 {
			t.Fatal("interaction did not advance pending paint")
		}
		if panePaintInterval(time.Now(), p.lastInteraction) != paneInteractiveInterval {
			t.Fatal("interaction did not wake normal rate")
		}
		close(reads)
		<-done
	})
}
