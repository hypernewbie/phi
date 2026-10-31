//go:build profiling

package obs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// setTimingClock scripts timingNow for exact-arithmetic fixtures. Late calls
// repeat the final instant. Capture-owning tests in this file are serial.
func setTimingClock(t *testing.T, instants ...time.Time) {
	t.Helper()
	if len(instants) == 0 {
		t.Fatal("clock fixture needs at least one instant")
	}
	previous := timingNow
	index := 0
	timingNow = func() time.Time {
		if index >= len(instants) {
			return instants[len(instants)-1]
		}
		instant := instants[index]
		index++
		return instant
	}
	t.Cleanup(func() { timingNow = previous })
}

func timingMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/api/a", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/api/b", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/api/terminals/", func(w http.ResponseWriter, r *http.Request) {})
	return mux
}

func TestTimingExactRootExports900ns(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t, epoch, epoch.Add(900*time.Nanosecond))
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	wrapped := WrapTimingHTTP(timingMux())
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/version", nil))
	snapshot := capture.Finish()
	if snapshot.Canceled {
		t.Fatal("capture was canceled")
	}
	if snapshot.RootsSeen != 1 || snapshot.RootsAdmitted != 1 || snapshot.RootsExported != 1 || snapshot.RootsDropped != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if len(snapshot.Roots) != 1 {
		t.Fatalf("roots = %d", len(snapshot.Roots))
	}
	root := snapshot.Roots[0]
	if root.Name != "http GET /api/version" {
		t.Fatalf("name = %q", root.Name)
	}
	if got := root.End.Sub(root.Start).Nanoseconds(); got != 900 {
		t.Fatalf("duration = %d ns, want 900", got)
	}
}

func TestTimingPanicClosesRootWithoutRecovery(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	defer capture.Cancel()
	panicValue := "handler panic"
	func() {
		defer func() {
			if got := recover(); got != panicValue {
				t.Fatalf("panic = %v, want %q", got, panicValue)
			}
		}()
		mux := http.NewServeMux()
		mux.HandleFunc("/api/panic", func(http.ResponseWriter, *http.Request) { panic(panicValue) })
		WrapTimingHTTP(mux).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/panic", nil))
	}()
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || snapshot.DiscardedOpen != 0 || snapshot.Roots[0].Name != "http GET /api/panic" {
		t.Fatalf("panic left an open or unnamed root: %+v", snapshot)
	}
}

func TestTimingZeroIntervalStaysZero(t *testing.T) {
	epoch := time.Now()
	setTimingClock(t, epoch, epoch)
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	WrapTimingHTTP(timingMux()).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/a", nil))
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 || len(snapshot.Roots) != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	if got := snapshot.Roots[0].End.Sub(snapshot.Roots[0].Start).Nanoseconds(); got != 0 {
		t.Fatalf("duration = %d ns, want 0", got)
	}
}

func TestTimingConcurrentRootsKeepIdentity(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	const roots = 32
	wrapped := WrapTimingHTTP(timingMux())
	var wg sync.WaitGroup
	for i := 0; i < roots; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			path := "/api/a"
			if i%2 == 1 {
				path = "/api/b"
			}
			wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		}(i)
	}
	wg.Wait()
	snapshot := capture.Finish()
	if snapshot.RootsSeen != roots || snapshot.RootsAdmitted != roots || snapshot.RootsExported != roots || snapshot.RootsDropped != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	counts := map[string]int{}
	for _, root := range snapshot.Roots {
		counts[root.Name]++
		if root.End.Before(root.Start) {
			t.Fatalf("negative duration for %s", root.Name)
		}
	}
	if counts["http GET /api/a"] != roots/2 || counts["http GET /api/b"] != roots/2 {
		t.Fatalf("name counts = %v", counts)
	}
}

func TestTimingInactivePassThroughUsesOriginalRequest(t *testing.T) {
	var gotReq *http.Request
	var gotWriter http.ResponseWriter
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotWriter = w
		gotReq = r
	})
	orig := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	recorder := httptest.NewRecorder()
	WrapTimingHTTP(next).ServeHTTP(recorder, orig)
	if gotReq != orig {
		t.Fatal("inactive wrapper cloned the request")
	}
	if gotWriter != recorder {
		t.Fatal("inactive wrapper replaced the ResponseWriter")
	}
	if active, _ := TimingStatus(); active {
		t.Fatal("capture unexpectedly active")
	}
}

func TestTimingSkipsNonAPITraffic(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	defer capture.Cancel()
	seen := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen++ })
	wrapped := WrapTimingHTTP(next)
	for _, path := range []string{"/healthz", "/ws/pane/x", "/app.js"} {
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	if seen != 3 {
		t.Fatalf("handled = %d, want 3", seen)
	}
	wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/", nil))
	snapshot := capture.Finish()
	if snapshot.RootsSeen != 1 || snapshot.RootsAdmitted != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingActivePreservesContextAndResponse(t *testing.T) {
	type ctxKey struct{}
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	defer capture.Cancel()
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Value(ctxKey{}) != "kept" {
			t.Error("context value lost")
		}
		select {
		case <-r.Context().Done():
			t.Error("context unexpectedly canceled")
		default:
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("body-bytes"))
	})
	ctx := context.WithValue(context.Background(), ctxKey{}, "kept")
	req := httptest.NewRequest(http.MethodPost, "/api/a", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	WrapTimingHTTP(next).ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated || recorder.Body.String() != "body-bytes" {
		t.Fatalf("response = %d %q", recorder.Code, recorder.Body.String())
	}
	snapshot := capture.Finish()
	if snapshot.RootsExported != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingRootBudgetDrops257thRoot(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	wrapped := WrapTimingHTTP(timingMux())
	for i := 0; i < 257; i++ {
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/a", nil))
	}
	snapshot := capture.Finish()
	if snapshot.RootsSeen != 257 || snapshot.RootsAdmitted != 256 || snapshot.RootsExported != 256 || snapshot.RootsDropped != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
}

func TestTimingFinishAndCancelAreIdempotent(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	WrapTimingHTTP(timingMux()).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/a", nil))
	first := capture.Finish()
	second := capture.Finish()
	if first.Canceled || second.Canceled {
		t.Fatal("finished capture reports canceled")
	}
	if first.RootsExported != 1 || second.RootsExported != 1 || len(first.Roots) != 1 || len(second.Roots) != 1 {
		t.Fatalf("finish snapshots differ: %+v %+v", first, second)
	}
	capture.Cancel()
	if third := capture.Finish(); third.Canceled || third.RootsExported != 1 {
		t.Fatalf("cancel-after-finish changed the snapshot: %+v", third)
	}

	canceled, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin second capture")
	}
	canceled.Cancel()
	canceled.Cancel()
	if snapshot := canceled.Finish(); !snapshot.Canceled {
		t.Fatalf("finish-after-cancel misses cancellation: %+v", snapshot)
	}
	if active, _ := TimingStatus(); active {
		t.Fatal("capture still active after cancel")
	}
}

func TestTimingOpenRootsAndLateCallbacks(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	gen, id, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit root")
	}
	snapshot := capture.Finish()
	if snapshot.DiscardedOpen != 1 || snapshot.RootsExported != 0 {
		t.Fatalf("counts = %+v", snapshot)
	}
	// A late end from the finished generation cannot corrupt later data.
	late := httptest.NewRequest(http.MethodGet, "/api/a", nil)
	late.Pattern = "/api/a"
	endTimingRoot(gen, id, late)

	next, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin next capture")
	}
	second := next.Finish()
	if second.RootsSeen != 0 || second.RootsAdmitted != 0 || second.RootsExported != 0 {
		t.Fatalf("late callback leaked: %+v", second)
	}

	// Duplicate ends cannot duplicate completion.
	third, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin third capture")
	}
	gen3, id3, ok := admitTimingRoot(http.MethodGet)
	if !ok {
		t.Fatal("admit root")
	}
	endTimingRoot(gen3, id3, late)
	endTimingRoot(gen3, id3, late)
	final := third.Finish()
	if final.RootsExported != 1 || final.DiscardedOpen != 0 {
		t.Fatalf("counts = %+v", final)
	}
}

func TestTimingSecondCaptureIsRejected(t *testing.T) {
	first, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	defer first.Cancel()
	if _, ok := BeginTimingCapture(); ok {
		t.Fatal("second concurrent capture was admitted")
	}
	if active, id := TimingStatus(); !active || id != first.ID() {
		t.Fatalf("status = active=%t id=%d", active, id)
	}
}

func TestTimingRootNamePrivacy(t *testing.T) {
	for _, tc := range []struct {
		method  string
		pattern string
		want    string
	}{
		{http.MethodGet, "/api/version", "http GET /api/version"},
		{"PURGE", "/api/version", "http OTHER /api/version"},
		{http.MethodPost, "", "http POST api.other"},
		{http.MethodGet, "/", "http GET api.other"},
		{http.MethodGet, "/api/" + strings.Repeat("x", 200), "http GET api.other"},
	} {
		capture, ok := BeginTimingCapture()
		if !ok {
			t.Fatal("begin capture")
		}
		gen, id, ok := admitTimingRoot(tc.method)
		if !ok {
			t.Fatal("admit root")
		}
		req := httptest.NewRequest(tc.method, "/api/version", nil)
		req.Pattern = tc.pattern
		endTimingRoot(gen, id, req)
		snapshot := capture.Finish()
		if len(snapshot.Roots) != 1 || snapshot.Roots[0].Name != tc.want {
			t.Fatalf("method=%s pattern=%q name=%v", tc.method, tc.pattern, snapshot.Roots)
		}
		if len(snapshot.Roots[0].Name) > timingMaxNameBytes {
			t.Fatalf("name exceeds cap: %q", snapshot.Roots[0].Name)
		}
	}
}

func TestTimingDynamicURLNeverBecomesName(t *testing.T) {
	capture, ok := BeginTimingCapture()
	if !ok {
		t.Fatal("begin capture")
	}
	WrapTimingHTTP(timingMux()).ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/api/terminals/dbb921ed9adfc3eb?secret=1", nil),
	)
	snapshot := capture.Finish()
	if len(snapshot.Roots) != 1 {
		t.Fatalf("counts = %+v", snapshot)
	}
	name := snapshot.Roots[0].Name
	if name != "http GET /api/terminals/" {
		t.Fatalf("name = %q", name)
	}
	for _, leaked := range []string{"dbb921ed", "secret"} {
		if strings.Contains(name, leaked) {
			t.Fatalf("name leaks request detail: %q", name)
		}
	}
}
