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
	go func() { results <- p.ResizeRecorded(80, 24, func() { appendTrace(1); close(entered); <-release }) }()
	<-entered
	go func() { close(second); results <- p.ResizeRecorded(100, 30, func() { appendTrace(2) }) }()
	<-second
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(trace, []int{1, 80, 2, 100}) {
		t.Fatalf("recorded and applied geometry diverged: %v", trace)
	}
}
