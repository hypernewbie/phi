package termstate

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestCanceledOperationsLeaveStateUnchanged(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	term, err := New(ctx, 12, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer term.Close()
	if err = term.Feed([]byte("retained state\r\npending \xe4\xbd")); err != nil {
		t.Fatal(err)
	}
	before, err := term.Ready()
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	operations := map[string]func() error{
		"feed":   func() error { return term.Feed([]byte("changed")) },
		"resize": func() error { return term.Resize(14, 5) },
		"limit":  func() error { return term.LimitScrollbackLines(0) },
		"ready": func() error {
			_, err := term.Ready()
			return err
		},
		"format": func() error {
			_, err := term.FormatVTState()
			return err
		},
		"continuation": func() error {
			_, err := term.Continuation()
			return err
		},
		"restore": func() error { return term.Restore(before) },
	}
	for name, operation := range operations {
		if err := operation(); !errors.Is(err, context.Canceled) {
			t.Errorf("%s: got %v, want context.Canceled", name, err)
		}
	}
	// Inspect with a live context only after all canceled operations returned.
	term.ctx = t.Context()
	after, err := term.Ready()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("canceled operations changed terminal state")
	}
}
