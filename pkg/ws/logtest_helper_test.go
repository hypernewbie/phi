package ws

import (
	"context"
	"log/slog"
	"sync"
	"testing"
)

// recordingStore is the shared backing store behind a recordingHandler and
// every handler derived from it via WithAttrs/WithGroup — so records
// logged through a `.With("conn", id, ...)`-derived logger (exactly how
// HandleWS attaches conn+pane fields) still land in the same slice the
// test inspects.
type recordingStore struct {
	mu   sync.Mutex
	recs []slog.Record
}

func (s *recordingStore) add(r slog.Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recs = append(s.recs, r)
}

func (s *recordingStore) records() []slog.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]slog.Record, len(s.recs))
	copy(out, s.recs)
	return out
}

// recordingHandler is a slog.Handler test double. Tests assert on captured
// attrs (conn, pane, dur_ms, ...) rather than log strings. WithAttrs
// returns a new handler that bakes the given attrs into every record it
// handles (mirroring what a real handler does for logger.With(...)) while
// sharing the parent's recordingStore, so calling records() on the
// originally-installed handler sees everything logged through any
// derived logger too.
type recordingHandler struct {
	store *recordingStore
	attrs []slog.Attr
}

func newRecordingHandler() *recordingHandler {
	return &recordingHandler{store: &recordingStore{}}
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	if len(h.attrs) > 0 {
		r = r.Clone()
		r.AddAttrs(h.attrs...)
	}
	h.store.add(r)
	return nil
}

func (h *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	merged := make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	merged = append(merged, h.attrs...)
	merged = append(merged, attrs...)
	return &recordingHandler{store: h.store, attrs: merged}
}

func (h *recordingHandler) WithGroup(string) slog.Handler { return h }

// records returns a snapshot of every record captured so far, across this
// handler and any handler derived from it.
func (h *recordingHandler) records() []slog.Record {
	return h.store.records()
}

// installRecordingHandler swaps slog's default logger for one backed by a
// recordingHandler, restoring the previous default on test cleanup.
func installRecordingHandler(t *testing.T) *recordingHandler {
	t.Helper()
	h := newRecordingHandler()
	old := slog.Default()
	slog.SetDefault(slog.New(h))
	t.Cleanup(func() { slog.SetDefault(old) })
	return h
}

// attrMap flattens a slog.Record's attrs into a map keyed by attr name.
func attrMap(r slog.Record) map[string]any {
	m := make(map[string]any)
	r.Attrs(func(a slog.Attr) bool {
		m[a.Key] = a.Value.Any()
		return true
	})
	return m
}
