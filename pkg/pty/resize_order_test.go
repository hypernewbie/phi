package pty

import (
	"reflect"
	"sync"
	"testing"

	gopty "github.com/aymanbagabas/go-pty"
)

type orderedResizePTY struct {
	gopty.Pty
	apply func(int, int)
}

func (p *orderedResizePTY) Resize(cols, rows int) error { p.apply(cols, rows); return nil }
func TestConcurrentResizeRecordsAndAppliesInTheSameOrder(t *testing.T) {
	var mu sync.Mutex
	var trace []int
	appendTrace := func(n int) { mu.Lock(); trace = append(trace, n); mu.Unlock() }
	p := &Pty{pt: &orderedResizePTY{apply: func(cols, rows int) { appendTrace(cols) }}}
	entered := make(chan struct{})
	release := make(chan struct{})
	second := make(chan struct{})
	results := make(chan error, 2)
	stage := func(n, cols int) func() (func() error, func(), error) {
		return func() (func() error, func(), error) {
			appendTrace(n)
			if n == 1 {
				close(entered)
				<-release
			}
			return func() error { appendTrace(1000 + cols); return nil }, func() { appendTrace(-n) }, nil
		}
	}
	go func() { results <- p.ResizeRecorded(80, 24, stage(1, 80)) }()
	<-entered
	go func() { close(second); results <- p.ResizeRecorded(100, 30, stage(2, 100)) }()
	<-second
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(trace, []int{1, 80, 1080, 2, 100, 1100}) {
		t.Fatalf("staged, applied, and committed geometry diverged: %v", trace)
	}
}
