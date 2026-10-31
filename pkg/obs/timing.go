//go:build profiling

// Local operation-timing capture for the private diagnostics listener.
//
// timing.go records explicit API-handler start/end intervals while a capture
// is active. It is profiling-only and standard-library-only: both obs backends
// share it, and the default binary gains no new dependency. The diagnostics
// package owns capture lifetime over HTTP; this file owns bounded in-memory
// records and immutable snapshots. See the fixed contract in the canonical
// plan (revision 5) for budgets, privacy, and discard rules.
package obs

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// Capture-wide budgets, not reusable slots. No user configuration.
	timingMaxRoots = 256
	timingMaxNodes = 4096
	timingMaxDepth = 32
	// Stored root names are fixed method + mux pattern strings, capped.
	timingMaxNameBytes = 160
)

// timingNow is a package-private clock seam for exact-arithmetic fixtures.
// Production always uses time.Now. Capture-owning tests are serial.
var timingNow = time.Now

// timingScope is the only timing value stored in request contexts: a
// capture generation plus a node identifier. It never retains the
// recorder, requests, attributes, or errors.
type timingScope struct {
	generation uint64
	node       uint32
}

type timingCtxKey struct{}

// timingNode is one recorded interval. Roots have parent -1 and depth 1.
// F1 records roots only; nested spans (F2) attach as children.
type timingNode struct {
	name     string
	method   string
	parent   int32
	depth    uint8
	start    time.Time
	end      time.Time
	ended    bool
	fault    bool // node/depth budget failure in this subtree
	children []int32
}

// TimingNode is an exported immutable interval tree.
type TimingNode struct {
	Name     string
	Start    time.Time
	End      time.Time
	Children []*TimingNode
}

// TimingSnapshot is an immutable finished capture. Roots holds exported
// valid trees only. Callers must not mutate it.
type TimingSnapshot struct {
	CaptureID         uint64
	Canceled          bool
	RootsSeen         uint32
	RootsAdmitted     uint32
	RootsExported     uint32
	RootsDropped      uint32
	DiscardedOpen     uint32
	DiscardedInvalid  uint32
	DiscardedCapacity uint32
	NodesRecorded     uint64
	NodesDropped      uint64
	Roots             []*TimingNode
}

// TimingCapture owns one capture's terminal transition. Finish and Cancel
// are idempotent; the first terminal transition wins. A handle can never
// detach another capture.
type TimingCapture struct {
	id       uint64
	done     bool
	snapshot TimingSnapshot
}

// ID returns the capture generation, used as the diagnostics capture_id.
func (c *TimingCapture) ID() uint64 { return c.id }

// timingCaptureState is the mutable capture owned by the recorder while
// active. It is frozen and dropped at detach; only the snapshot survives.
type timingCaptureState struct {
	id           uint64
	nodes        []timingNode
	roots        []int32
	seen         uint32
	admitted     uint32
	dropped      uint32
	nodesDropped uint64
}

var (
	timingMu     sync.Mutex
	timingActive atomic.Bool
	timingGen    uint64
	timingCur    *timingCaptureState
)

// BeginTimingCapture starts one process-local capture. It reports false
// when another capture is active, so a second diagnostics instance gets a
// 409 instead of queueing.
func BeginTimingCapture() (*TimingCapture, bool) {
	timingMu.Lock()
	defer timingMu.Unlock()
	if timingCur != nil {
		return nil, false
	}
	timingGen++
	timingCur = &timingCaptureState{id: timingGen}
	timingActive.Store(true)
	return &TimingCapture{id: timingGen}, true
}

// TimingStatus reports whether a capture is active and the latest capture
// id. Inactive status retains the last id but no intervals.
func TimingStatus() (active bool, captureID uint64) {
	timingMu.Lock()
	defer timingMu.Unlock()
	return timingCur != nil, timingGen
}

// Finish detaches the capture and freezes its snapshot. Repeated calls
// return the same immutable snapshot. Finish after cancel reports
// cancellation.
func (c *TimingCapture) Finish() TimingSnapshot {
	timingMu.Lock()
	defer timingMu.Unlock()
	if c.done {
		return c.snapshot
	}
	c.done = true
	if timingCur == nil || timingCur.id != c.id {
		c.snapshot = TimingSnapshot{CaptureID: c.id, Canceled: true}
		return c.snapshot
	}
	state := timingCur
	timingCur = nil
	timingActive.Store(false)
	c.snapshot = freezeTiming(state)
	return c.snapshot
}

// Cancel detaches and discards the capture before transport cleanup.
// Cancel after finish does nothing.
func (c *TimingCapture) Cancel() {
	timingMu.Lock()
	defer timingMu.Unlock()
	if c.done {
		return
	}
	c.done = true
	if timingCur != nil && timingCur.id == c.id {
		timingCur = nil
		timingActive.Store(false)
	}
	c.snapshot = TimingSnapshot{CaptureID: c.id, Canceled: true}
}

// freezeTiming classifies every admitted root exactly once, in priority
// order: capacity, open, invalid. Only closed, valid, fully recorded roots
// are exported. Never derive a duration from an absent end timestamp.
func freezeTiming(state *timingCaptureState) TimingSnapshot {
	snap := TimingSnapshot{
		CaptureID:     state.id,
		RootsSeen:     state.seen,
		RootsAdmitted: state.admitted,
		RootsDropped:  state.dropped,
		NodesRecorded: uint64(len(state.nodes)),
		NodesDropped:  state.nodesDropped,
	}
	for _, idx := range state.roots {
		node := &state.nodes[idx]
		switch {
		case node.fault:
			snap.DiscardedCapacity++
		case !node.ended:
			snap.DiscardedOpen++
		case !validTimingTree(state.nodes, idx):
			snap.DiscardedInvalid++
		default:
			snap.Roots = append(snap.Roots, exportTimingTree(state.nodes, idx))
			snap.RootsExported++
		}
	}
	return snap
}

// validTimingTree inspects the whole tree before anything is exported.
// Intervals are half-open [start,end): adjacent siblings are valid and
// zero-duration children consume no time, so they are excluded from the
// overlap sweep but must still lie within the parent.
func validTimingTree(nodes []timingNode, idx int32) bool {
	node := &nodes[idx]
	if node.end.Before(node.start) {
		return false
	}
	ordered := append([]int32(nil), node.children...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := &nodes[ordered[i]], &nodes[ordered[j]]
		if !a.start.Equal(b.start) {
			return a.start.Before(b.start)
		}
		return a.end.Before(b.end)
	})
	last := node.start
	for _, childIdx := range ordered {
		child := &nodes[childIdx]
		if !child.ended {
			return false
		}
		if child.end.Before(child.start) {
			return false
		}
		if child.start.Before(node.start) || child.end.After(node.end) {
			return false
		}
		if !child.end.Equal(child.start) {
			if child.start.Before(last) {
				return false
			}
			last = child.end
		}
		if !validTimingTree(nodes, childIdx) {
			return false
		}
	}
	return true
}

func exportTimingTree(nodes []timingNode, idx int32) *TimingNode {
	node := &nodes[idx]
	out := &TimingNode{Name: node.name, Start: node.start, End: node.end}
	for _, childIdx := range node.children {
		out.Children = append(out.Children, exportTimingTree(nodes, childIdx))
	}
	return out
}

// WrapTimingHTTP records one root interval per admitted /api/ request while
// a capture is active. Inactive requests pass through untouched: no store,
// no context copy, original ResponseWriter. Authentication rejections never
// reach this wrapper because it composes inside the auth middleware.
func WrapTimingHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !timingActive.Load() {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL == nil || !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		gen, id, ok := admitTimingRoot(r.Method)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		req := r.WithContext(context.WithValue(r.Context(), timingCtxKey{}, timingScope{generation: gen, node: id}))
		// End on unwind so panics still close the interval. Never recover.
		defer endTimingRoot(gen, id, req)
		next.ServeHTTP(w, req)
	})
}

// admitTimingRoot records a request against the active capture. A root that
// cannot be admitted due to either the root or node budget increments
// roots_dropped. Requests arriving after detach pass through uncounted.
func admitTimingRoot(method string) (uint64, uint32, bool) {
	timingMu.Lock()
	defer timingMu.Unlock()
	if timingCur == nil {
		return 0, 0, false
	}
	state := timingCur
	state.seen++
	if len(state.roots) >= timingMaxRoots || len(state.nodes) >= timingMaxNodes {
		state.dropped++
		return 0, 0, false
	}
	id := uint32(len(state.nodes))
	state.nodes = append(state.nodes, timingNode{
		method: normalizeTimingMethod(method),
		parent: -1,
		depth:  1,
		start:  timingNow(),
	})
	state.roots = append(state.roots, int32(id))
	state.admitted++
	return state.id, id, true
}

// endTimingRoot closes one admitted root. Late callbacks from a finished
// capture cannot mutate a later one: the generation is rechecked under the
// recorder lock. Duplicate ends cannot duplicate completion.
func endTimingRoot(gen uint64, id uint32, req *http.Request) {
	timingMu.Lock()
	defer timingMu.Unlock()
	if timingCur == nil || timingCur.id != gen {
		return
	}
	if uint64(id) >= uint64(len(timingCur.nodes)) {
		return
	}
	node := &timingCur.nodes[id]
	if node.ended {
		return
	}
	node.name = timingRootName(node.method, req.Pattern)
	node.end = timingNow()
	node.ended = true
}

func normalizeTimingMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions:
		return method
	default:
		return "OTHER"
	}
}

// timingAllowedSpans is the fixed allowlist of existing nested operation
// names. Unknown names never enter timing records and leave the local
// timing parent ID unchanged.
var timingAllowedSpans = map[string]bool{
	"git.repo_check":    true,
	"git.check_ignore":  true,
	"git.status":        true,
	"git.diff":          true,
	"git.show":          true,
	"git.log":           true,
	"git.worktree.list": true,
	"pty.spawn":         true,
	"clipboard.read":    true,
	"ws.connection":     true,
}

// timingSpanStart attaches one nested interval to the current admitted
// root. It passes ctx through unchanged when no capture is active, when
// ctx carries no admitted root scope, or when name is not allowlisted.
// Budget exhaustion marks the affected root for capacity discard and
// leaves the scope unchanged. Attributes are never retained.
func timingSpanStart(ctx context.Context, name string) (context.Context, uint64, uint32, bool) {
	if !timingActive.Load() {
		return ctx, 0, 0, false
	}
	if !timingAllowedSpans[name] {
		return ctx, 0, 0, false
	}
	scope, ok := ctx.Value(timingCtxKey{}).(timingScope)
	if !ok {
		return ctx, 0, 0, false
	}
	timingMu.Lock()
	defer timingMu.Unlock()
	if timingCur == nil || timingCur.id != scope.generation {
		return ctx, 0, 0, false
	}
	if uint64(scope.node) >= uint64(len(timingCur.nodes)) {
		return ctx, 0, 0, false
	}
	parent := &timingCur.nodes[scope.node]
	if parent.ended {
		return ctx, 0, 0, false
	}
	if parent.depth+1 > timingMaxDepth || len(timingCur.nodes) >= timingMaxNodes {
		timingCur.nodesDropped++
		faultTimingRoot(timingCur.nodes, scope.node)
		return ctx, 0, 0, false
	}
	id := uint32(len(timingCur.nodes))
	timingCur.nodes = append(timingCur.nodes, timingNode{
		name:   name,
		parent: int32(scope.node),
		depth:  parent.depth + 1,
		start:  timingNow(),
	})
	timingCur.nodes[scope.node].children = append(timingCur.nodes[scope.node].children, int32(id))
	return context.WithValue(ctx, timingCtxKey{}, timingScope{generation: scope.generation, node: id}), scope.generation, id, true
}

// timingSpanEnd closes one nested interval. Late, duplicate, or
// foreign-generation callbacks are ignored.
func timingSpanEnd(gen uint64, id uint32) {
	timingMu.Lock()
	defer timingMu.Unlock()
	if timingCur == nil || timingCur.id != gen {
		return
	}
	if uint64(id) >= uint64(len(timingCur.nodes)) {
		return
	}
	node := &timingCur.nodes[id]
	if node.ended {
		return
	}
	node.end = timingNow()
	node.ended = true
}

// faultTimingRoot walks to the admitted root and marks it for capacity
// discard. Depth is bounded, so the walk always terminates.
func faultTimingRoot(nodes []timingNode, id uint32) {
	for {
		if uint64(id) >= uint64(len(nodes)) {
			return
		}
		parent := nodes[id].parent
		if parent < 0 {
			nodes[id].fault = true
			return
		}
		id = uint32(parent)
	}
}

// timingRootName uses the fixed method plus the registered mux pattern, for
// example "http GET /api/version". Raw paths, queries, headers, and path
// values never become names.
func timingRootName(method, pattern string) string {
	if pattern == "" || pattern == "/" || len(pattern) > timingMaxNameBytes {
		pattern = "api.other"
	}
	name := "http " + method + " " + pattern
	if len(name) > timingMaxNameBytes {
		name = name[:timingMaxNameBytes]
	}
	return name
}
