package obs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// spanMux runs handler with the request context inside an admitted root.
func spanMux(handler func(w http.ResponseWriter, r *http.Request)) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/thing", handler)
	return mux
}

func TestTimingNestedExactIntervals(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t,
		epoch,                          // root start
		epoch.Add(100*time.Nanosecond), // child start
		epoch.Add(150*time.Nanosecond), // leaf start
		epoch.Add(200*time.Nanosecond), // leaf end
		epoch.Add(300*time.Nanosecond), // child end
		epoch.Add(900*time.Nanosecond), // root end
	)
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		childCtx, endChild := Span(r.Context(), "git.status", "cwd", "/repo")
		_, endLeaf := Span(childCtx, "git.diff", "cwd", "/repo")
		endLeaf(nil)
		endChild(nil)
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || len(snapshot.Roots) != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	root := snapshot.Roots[0]
	if len(root.Children) != 1 {
		t.Fatalf("root children = %d", len(root.Children))
	}
	child := root.Children[0]
	if child.Name != "git.status" {
		t.Fatalf("child name = %q", child.Name)
	}
	if got := child.End.Sub(child.Start).Nanoseconds(); got != 200 {
		t.Fatalf("child duration = %d, want 200", got)
	}
	if len(child.Children) != 1 {
		t.Fatalf("child children = %d", len(child.Children))
	}
	leaf := child.Children[0]
	if leaf.Name != "git.diff" {
		t.Fatalf("leaf name = %q", leaf.Name)
	}
	if got := leaf.End.Sub(leaf.Start).Nanoseconds(); got != 50 {
		t.Fatalf("leaf duration = %d, want 50", got)
	}
	if got := root.End.Sub(root.Start).Nanoseconds(); got != 900 {
		t.Fatalf("root duration = %d, want 900", got)
	}
}

func TestTimingAdjacentSiblingsAndZeroChild(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t,
		epoch,                          // root start
		epoch.Add(100*time.Nanosecond), // sib1 start
		epoch.Add(300*time.Nanosecond), // sib1 end
		epoch.Add(300*time.Nanosecond), // sib2 start (adjacent)
		epoch.Add(300*time.Nanosecond), // zero start (shares sib2 start)
		epoch.Add(300*time.Nanosecond), // zero end
		epoch.Add(500*time.Nanosecond), // sib2 end
		epoch.Add(900*time.Nanosecond), // root end
	)
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		_, endSib1 := Span(r.Context(), "git.repo_check")
		endSib1(nil)
		sib2Ctx, endSib2 := Span(r.Context(), "git.status")
		_, endZero := Span(sib2Ctx, "git.diff")
		endZero(nil)
		endSib2(nil)
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || snapshot.DiscardedInvalid != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if len(snapshot.Roots[0].Children) != 2 {
		t.Fatalf("children = %+v", snapshot.Roots[0].Children)
	}
}

func TestTimingRepeatedNamesConcurrentRoots(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		childCtx, endChild := Span(r.Context(), "git.status")
		_, endLeaf := Span(childCtx, "git.status")
		endLeaf(nil)
		endChild(nil)
	}
	wrapped := WrapTimingHTTP(spanMux(handler))
	const roots = 16
	var wg sync.WaitGroup
	for i := 0; i < roots; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
		}()
	}
	wg.Wait()
	snapshot := capture.Finish()
	if snapshot.RootsExported != roots || snapshot.DiscardedInvalid != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	for _, root := range snapshot.Roots {
		if len(root.Children) != 1 || len(root.Children[0].Children) != 1 {
			t.Fatalf("tree = %+v", root)
		}
	}
}

func TestTimingSiblingOverlapDiscardsAffectedRootOnly(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t,
		epoch,                           // root1 start
		epoch.Add(100*time.Nanosecond),  // sib1 start
		epoch.Add(400*time.Nanosecond),  // sib1 end
		epoch.Add(300*time.Nanosecond),  // sib2 start (overlaps sib1)
		epoch.Add(500*time.Nanosecond),  // sib2 end
		epoch.Add(900*time.Nanosecond),  // root1 end
		epoch.Add(1000*time.Nanosecond), // root2 start
		epoch.Add(1100*time.Nanosecond), // root2 end
	)
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	overlap := func(w http.ResponseWriter, r *http.Request) {
		_, endSib1 := Span(r.Context(), "git.repo_check")
		endSib1(nil)
		_, endSib2 := Span(r.Context(), "git.status")
		endSib2(nil)
	}
	clean := func(w http.ResponseWriter, r *http.Request) {}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/overlap", overlap)
	mux.HandleFunc("/api/clean", clean)
	wrapped := WrapTimingHTTP(mux)
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/overlap", nil))
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/clean", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || snapshot.DiscardedInvalid != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if snapshot.Roots[0].Name != "http GET /api/clean" {
		t.Fatalf("exported = %q", snapshot.Roots[0].Name)
	}
}

func TestTimingChildOutlivingParentIsInvalid(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t,
		epoch,
		epoch.Add(100*time.Nanosecond),
		epoch.Add(150*time.Nanosecond),
		epoch.Add(200*time.Nanosecond), // parent ends first
		epoch.Add(300*time.Nanosecond), // child ends after parent
		epoch.Add(900*time.Nanosecond),
	)
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		childCtx, endParent := Span(r.Context(), "git.status")
		_, endChild := Span(childCtx, "git.diff")
		endParent(nil)
		endChild(nil)
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 0 || snapshot.DiscardedInvalid != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingOpenChildInvalidatesRoot(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		_, _ = Span(r.Context(), "git.status")
		// Never ended: the closed root holds an unended child.
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 0 || snapshot.DiscardedInvalid != 1 || snapshot.DiscardedOpen != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingCapacityBeatsOpenBeatsInvalid(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	// Root 1: capacity fault plus left open -> capacity.
	gen1, id1, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit root 1")
	}
	ctx1 := context.WithValue(context.Background(), timingCtxKey{}, timingScope{generation: gen1, node: id1})
	for i := 0; i < timingMaxNodes-1; i++ {
		_, end := Span(ctx1, "git.status")
		end(nil)
	}
	_, _ = Span(ctx1, "git.status") // 4,097th node: budget exhausted
	// Root 1 stays open: capacity must win over open at finish.

	// Root 2 cannot be admitted: node budget is full -> roots_dropped.
	if _, _, ok := admitTimingRoot(http.MethodGet); ok {
		t.Fatal("root 2 admitted past node budget")
	}
	snapshot := capture.Finish()
	if snapshot.DiscardedCapacity != 1 || snapshot.DiscardedOpen != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if snapshot.RootsDropped != 1 || snapshot.NodesDropped != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}

	// Root 3: open plus overlapping children -> open wins over invalid.
	epoch := time.Now()
	setTimingClock(t,
		epoch,
		epoch.Add(100*time.Nanosecond),
		epoch.Add(400*time.Nanosecond),
		epoch.Add(300*time.Nanosecond),
		epoch.Add(500*time.Nanosecond),
	)
	next, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin next capture")
	}
	gen3, id3, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit root 3")
	}
	ctx3 := context.WithValue(context.Background(), timingCtxKey{}, timingScope{generation: gen3, node: id3})
	_, endSib1 := Span(ctx3, "git.repo_check")
	endSib1(nil)
	_, endSib2 := Span(ctx3, "git.status")
	endSib2(nil)
	// Root 3 stays open.
	third := next.Finish()
	if third.DiscardedOpen != 1 || third.DiscardedInvalid != 0 {
		t.Fatalf("counts = %+v", third)
	}
}

func TestTimingDepthLimitDiscardsAffectedRootOnly(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	deep := func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var ends []func(error)
		for i := 0; i < timingMaxDepth-1; i++ {
			var end func(error)
			ctx, end = Span(ctx, "git.status")
			ends = append(ends, end)
		}
		_, _ = Span(ctx, "git.status") // depth 33: exhausted
		for i := len(ends) - 1; i >= 0; i-- {
			ends[i](nil)
		}
	}
	clean := func(w http.ResponseWriter, r *http.Request) {}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/deep", deep)
	mux.HandleFunc("/api/clean", clean)
	wrapped := WrapTimingHTTP(mux)
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/deep", nil))
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/clean", nil))
	snapshot := capture.Finish()
	if snapshot.DiscardedCapacity != 1 || snapshot.RootsExported != 1 || snapshot.NodesDropped != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if snapshot.Roots[0].Name != "http GET /api/clean" {
		t.Fatalf("exported = %q", snapshot.Roots[0].Name)
	}
}

func TestTimingUnknownNamesIgnoredParentUnchanged(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		unknownCtx, endUnknown := Span(r.Context(), "user.custom", "secret", "drop-me")
		endUnknown(assertTestError{})
		_, endKnown := Span(unknownCtx, "git.status")
		endKnown(nil)
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	children := snapshot.Roots[0].Children
	if len(children) != 1 || children[0].Name != "git.status" {
		t.Fatalf("children = %+v", children)
	}
	if len(children[0].Children) != 0 {
		t.Fatalf("unexpected grandchildren = %+v", children[0].Children)
	}
}

type assertTestError struct{}

func (assertTestError) Error() string { return "test error" }

func TestTimingSpanPreservesContext(t *testing.T) {
	type ctxKey struct{}
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	defer capture.Cancel()
	handler := func(w http.ResponseWriter, r *http.Request) {
		childCtx, end := Span(r.Context(), "git.status")
		defer end(nil)
		if childCtx.Value(ctxKey{}) != "kept" {
			t.Error("context value lost through Span")
		}
		select {
		case <-childCtx.Done():
			t.Error("context unexpectedly canceled")
		default:
		}
	}
	base := context.WithValue(context.Background(), ctxKey{}, "kept")
	req := httptest.NewRequest(http.MethodGet, "/api/thing", nil).WithContext(base)
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), req)
}

func TestTimingUnscopedBackgroundSpanIgnored(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	ctx, end := Span(context.Background(), "git.status")
	end(nil)
	_ = ctx
	snapshot := capture.Finish()
	if snapshot.RootsSeen != 0 || snapshot.NodesRecorded != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingPreviousGenerationSpanCallbacksIgnored(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	gen1, id1, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit root")
	}
	ctx1 := context.WithValue(context.Background(), timingCtxKey{}, timingScope{generation: gen1, node: id1})
	_, endSpan := Span(ctx1, "git.status")
	first := capture.Finish()
	if first.DiscardedOpen != 1 {
		t.Fatalf("counts = %+v", first)
	}
	next, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin next capture")
	}
	defer next.Cancel()
	// Reuse the same node IDs in a live generation. Calling stale hooks
	// before this point would not test the generation guard at all.
	gen2, id2, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit next root")
	}
	ctx2 := context.WithValue(context.Background(), timingCtxKey{}, timingScope{generation: gen2, node: id2})
	_, endCurrent := Span(ctx2, "git.status")
	endSpan(nil)
	_, endStale := Span(ctx1, "git.diff")
	endStale(nil)
	late := httptest.NewRequest(http.MethodGet, "/api/thing", nil)
	late.Pattern = "/api/thing"
	endTimingRoot(gen1, id1, late)
	timingSpanEnd(gen1, id1+1)
	timingMu.Lock()
	rootEnded, childEnded := timingCur.nodes[0].ended, timingCur.nodes[1].ended
	timingMu.Unlock()
	if rootEnded || childEnded {
		t.Fatal("stale callback closed a current node")
	}
	endCurrent(nil)
	endTimingRoot(gen2, id2, late)
	second := next.Finish()
	if second.RootsSeen != 1 || second.RootsExported != 1 || second.NodesRecorded != 2 || second.NodesDropped != 0 {
		t.Fatalf("stale callbacks changed the next capture: %+v", second)
	}
}

func TestTimingDuplicateSpanEndIgnored(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	handler := func(w http.ResponseWriter, r *http.Request) {
		_, end := Span(r.Context(), "git.status")
		end(nil)
		end(assertTestError{})
	}
	WrapTimingHTTP(spanMux(handler)).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/thing", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || snapshot.NodesRecorded != 2 {
		t.Fatalf("counts = %+v", snapshot)
	}
}
