package diagnostics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/google/pprof/profile"
	"github.com/hypernewbie/phi/pkg/obs"
)

const timingScope = "api_handlers_and_existing_spans"

// timingSummary is the machine-readable capture account stored as one
// phi_timing= JSON profile comment. No raw request details belong here.
type timingSummary struct {
	SchemaVersion      int               `json:"schema_version"`
	CaptureID          uint64            `json:"capture_id"`
	PID                int               `json:"pid"`
	BuildCommit        string            `json:"build_commit"`
	Scope              string            `json:"scope"`
	RootsSeen          uint32            `json:"roots_seen"`
	RootsAdmitted      uint32            `json:"roots_admitted"`
	RootsExported      uint32            `json:"roots_exported"`
	RootsDropped       uint32            `json:"roots_dropped"`
	DiscardedOpen      uint32            `json:"discarded_open"`
	DiscardedInvalid   uint32            `json:"discarded_invalid"`
	DiscardedCapacity  uint32            `json:"discarded_capacity"`
	NodesRecorded      uint64            `json:"nodes_recorded"`
	NodesDropped       uint64            `json:"nodes_dropped"`
	Complete           bool              `json:"complete"`
	RootDurationNS     int64             `json:"root_duration_ns"`
	ExportedSpanCounts map[string]uint64 `json:"exported_span_counts"`
}

func (s *Server) handleTimingStatus(w http.ResponseWriter, r *http.Request) {
	if err := parseEmptyProfileQuery(r.URL.RawQuery); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	active, captureID := obs.TimingStatus()
	w.Header().Set("Content-Type", "application/json")
	_ = jsonEncode(w, map[string]any{
		"schema_version": 1,
		"active":         active,
		"capture_id":     captureID,
	})
}

func (s *Server) handleTiming(w http.ResponseWriter, r *http.Request) {
	seconds, err := parseCPUProfileQuery(r.URL.RawQuery)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.acquireProfile(w) {
		return
	}
	defer s.releaseProfile()

	file, err := s.newProfileFile()
	if err != nil {
		http.Error(w, "profile unavailable", http.StatusServiceUnavailable)
		return
	}
	defer removeProfileFile(file)

	if err := setWriteDeadline(w, time.Now().Add(time.Duration(seconds+5)*time.Second)); err != nil {
		http.Error(w, "profile transport unavailable", http.StatusServiceUnavailable)
		return
	}
	capture, ok := obs.BeginTimingCapture()
	if !ok {
		http.Error(w, "timing capture already active", http.StatusConflict)
		return
	}

	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	captureComplete := false
	select {
	case <-timer.C:
		captureComplete = true
	case <-r.Context().Done():
	case <-s.ctx.Done():
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	// Detach before encoding or delivery. Canceled captures must discard,
	// not validate and export trees while requests wait on the recorder.
	if !captureComplete || r.Context().Err() != nil || s.ctx.Err() != nil {
		capture.Cancel()
		if s.ctx.Err() != nil && r.Context().Err() == nil {
			http.Error(w, "profile capture canceled", http.StatusServiceUnavailable)
		}
		return
	}

	summary, prof, err := encodeTimingProfile(capture.Finish(), s.commit)
	if err != nil {
		slogProfileError(err)
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	limited := newLimitingWriter(file, s.maxProfileSize)
	if err := prof.Write(limited); err != nil || limited.Err() != nil {
		slogProfileError(limited.Err())
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	if err := file.Sync(); err != nil {
		http.Error(w, "profile capture failed", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("X-Phi-Timing-Capture-ID", fmt.Sprintf("%d", summary.CaptureID))
	w.Header().Set("X-Phi-Timing-Complete", fmt.Sprintf("%t", summary.Complete))
	w.Header().Set("X-Phi-Timing-Roots-Exported", fmt.Sprintf("%d", summary.RootsExported))
	if err := s.deliverProfile(w, file); err != nil {
		return
	}
}

// encodeTimingProfile converts exported interval trees into one
// duration-weighted profile: each positive exclusive duration becomes one
// sample on its complete root-to-node stack (leaf-first). The snapshot
// holds whole-root-validated trees; the encoder still verifies that the
// total encoded weight equals the original inclusive sum.
func encodeTimingProfile(snapshot obs.TimingSnapshot, commit string) (timingSummary, *profile.Profile, error) {
	summary := timingSummary{
		SchemaVersion:      1,
		CaptureID:          snapshot.CaptureID,
		PID:                os.Getpid(),
		BuildCommit:        commit,
		Scope:              timingScope,
		RootsSeen:          snapshot.RootsSeen,
		RootsAdmitted:      snapshot.RootsAdmitted,
		RootsExported:      snapshot.RootsExported,
		RootsDropped:       snapshot.RootsDropped,
		DiscardedOpen:      snapshot.DiscardedOpen,
		DiscardedInvalid:   snapshot.DiscardedInvalid,
		DiscardedCapacity:  snapshot.DiscardedCapacity,
		NodesRecorded:      snapshot.NodesRecorded,
		NodesDropped:       snapshot.NodesDropped,
		Complete:           !snapshot.Canceled && snapshot.RootsDropped == 0 && snapshot.DiscardedOpen == 0 && snapshot.DiscardedInvalid == 0 && snapshot.DiscardedCapacity == 0 && snapshot.NodesDropped == 0,
		ExportedSpanCounts: map[string]uint64{},
	}
	if snapshot.Canceled {
		return timingSummary{}, nil, fmt.Errorf("cannot encode canceled timing capture")
	}
	prof := &profile.Profile{
		SampleType:        []*profile.ValueType{{Type: "handler_wall", Unit: "nanoseconds"}},
		DefaultSampleType: "handler_wall",
	}
	encoder := &timingEncoder{profile: prof}
	var want int64
	for _, root := range snapshot.Roots {
		inclusive, err := encoder.emit(root, nil)
		if err != nil {
			return timingSummary{}, nil, err
		}
		want += inclusive
		countTimingSpans(summary.ExportedSpanCounts, root)
	}
	var got int64
	for _, sample := range prof.Sample {
		got += sample.Value[0]
	}
	if got != want {
		return timingSummary{}, nil, fmt.Errorf("timing weights do not sum to root durations: got %d, want %d", got, want)
	}
	summary.RootDurationNS = want
	comment, err := json.Marshal(summary)
	if err != nil {
		return timingSummary{}, nil, err
	}
	prof.Comments = []string{"phi_timing=" + string(comment)}
	if err := prof.CheckValid(); err != nil {
		return timingSummary{}, nil, err
	}
	return summary, prof, nil
}

// countTimingSpans records every exported non-root node by name, including
// zero-duration nodes that add no weight. Exported trees hold allowlisted
// names only, so the map keys stay within the ten fixed child names.
func countTimingSpans(counts map[string]uint64, node *obs.TimingNode) {
	for _, child := range node.Children {
		counts[child.Name]++
		countTimingSpans(counts, child)
	}
}

// timingEncoder assigns one function/location per recorded node. Unique ids
// keep the encoding simple; the viewer aggregates identical paths.
type timingEncoder struct {
	profile *profile.Profile
	nextID  uint64
}

func (e *timingEncoder) emit(node *obs.TimingNode, ancestors []*profile.Location) (int64, error) {
	inclusive := node.End.Sub(node.Start).Nanoseconds()
	if inclusive < 0 {
		return 0, fmt.Errorf("negative timing interval: %s", node.Name)
	}
	e.nextID++
	fn := &profile.Function{ID: e.nextID, Name: node.Name, SystemName: node.Name}
	loc := &profile.Location{ID: e.nextID, Line: []profile.Line{{Function: fn}}}
	e.profile.Function = append(e.profile.Function, fn)
	e.profile.Location = append(e.profile.Location, loc)
	stack := append([]*profile.Location{loc}, ancestors...)
	exclusive := inclusive
	for _, child := range node.Children {
		childInclusive, err := e.emit(child, stack)
		if err != nil {
			return 0, err
		}
		exclusive -= childInclusive
	}
	if exclusive < 0 {
		return 0, fmt.Errorf("negative exclusive timing weight: %s", node.Name)
	}
	if exclusive > 0 {
		e.profile.Sample = append(e.profile.Sample, &profile.Sample{Location: stack, Value: []int64{exclusive}})
	}
	return inclusive, nil
}
