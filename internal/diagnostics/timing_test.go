package diagnostics

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/pprof/profile"
	"github.com/hypernewbie/phi/pkg/obs"
)

func timingStatus(t *testing.T, client *http.Client, s *Server) (bool, uint64) {
	t.Helper()
	resp := authorizedProfileRequest(t, client, s, "/debug/phi/timing/status")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}
	var decoded struct {
		SchemaVersion int    `json:"schema_version"`
		Active        bool   `json:"active"`
		CaptureID     uint64 `json:"capture_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if decoded.SchemaVersion != 1 {
		t.Fatalf("schema_version = %d", decoded.SchemaVersion)
	}
	return decoded.Active, decoded.CaptureID
}

func waitTimingStatus(t *testing.T, client *http.Client, s *Server, wantActive bool) (bool, uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		active, id := timingStatus(t, client, s)
		if active == wantActive {
			return active, id
		}
		if time.Now().After(deadline) {
			t.Fatalf("status did not become active=%t", wantActive)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func parseTimingProfile(t *testing.T, data []byte) (*profile.Profile, timingSummary) {
	t.Helper()
	prof, err := profile.Parse(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse profile: %v", err)
	}
	if err := prof.CheckValid(); err != nil {
		t.Fatalf("profile invalid: %v", err)
	}
	var summary timingSummary
	found := false
	for _, comment := range prof.Comments {
		value, ok := strings.CutPrefix(comment, "phi_timing=")
		if !ok {
			continue
		}
		if found {
			t.Fatal("multiple timing comments")
		}
		found = true
		if err := json.Unmarshal([]byte(value), &summary); err != nil {
			t.Fatalf("decode timing comment: %v", err)
		}
	}
	if !found {
		t.Fatal("timing comment missing")
	}
	return prof, summary
}

func startTimingCapture(t *testing.T, client *http.Client, s *Server, path string) (context.CancelFunc, <-chan *http.Response) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan *http.Response, 1)
	go func() {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL()+path, nil)
		if err != nil {
			t.Error(err)
			done <- nil
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		resp, err := client.Do(req)
		if err != nil {
			done <- nil
			return
		}
		done <- resp
	}()
	return cancel, done
}

func TestTimingCaptureRoundTripWithWorkload(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)
	_, beforeID := timingStatus(t, client, s)

	cancel, done := startTimingCapture(t, client, s, "/debug/phi/timing?seconds=1")
	defer cancel()
	_, captureID := waitTimingStatus(t, client, s, true)
	if captureID <= beforeID {
		t.Fatalf("capture id did not advance: %d after %d", captureID, beforeID)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		_, end := obs.Span(r.Context(), "git.status")
		end(nil)
	})
	wrapped := obs.WrapTimingHTTP(mux)
	for i := 0; i < 3; i++ {
		wrapped.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/version", nil))
	}
	resp2 := <-done
	if resp2 == nil {
		t.Fatal("complete capture request failed")
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp2.Body)
		t.Fatalf("status = %d, body = %s", resp2.StatusCode, body)
	}
	data, err := io.ReadAll(io.LimitReader(resp2.Body, (64<<20)+1))
	if err != nil {
		t.Fatal(err)
	}
	assertGzipProfile(t, data)
	prof, summary := parseTimingProfile(t, data)
	if summary.Scope != "api_handlers_and_existing_spans" || summary.SchemaVersion != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.RootsSeen != 3 || summary.RootsAdmitted != 3 || summary.RootsExported != 3 || summary.RootsDropped != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ExportedSpanCounts["git.status"] != 3 {
		t.Fatalf("span counts = %v", summary.ExportedSpanCounts)
	}
	if !summary.Complete || summary.ExportedSpanCounts == nil {
		t.Fatalf("summary = %+v", summary)
	}
	var total int64
	names := map[string]bool{}
	for _, sample := range prof.Sample {
		total += sample.Value[0]
		for _, loc := range sample.Location {
			for _, line := range loc.Line {
				names[line.Function.Name] = true
			}
		}
	}
	if total != summary.RootDurationNS || total <= 0 {
		t.Fatalf("total = %d, root_duration_ns = %d", total, summary.RootDurationNS)
	}
	if !names["http GET /api/version"] {
		t.Fatalf("names = %v", names)
	}
	if got := resp2.Header.Get("X-Phi-Timing-Roots-Exported"); got != "3" {
		t.Fatalf("roots-exported header = %q", got)
	}
	if got := resp2.Header.Get("X-Phi-Timing-Complete"); got != "true" {
		t.Fatalf("complete header = %q", got)
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestTimingEndpointsRejectInvalidRequests(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)
	for _, tc := range []struct {
		method string
		path   string
		code   int
	}{
		{method: http.MethodGet, path: "/debug/phi/timing?seconds=0", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/phi/timing?seconds=121", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/phi/timing?unknown=1", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/phi/timing?seconds=1&seconds=2", code: http.StatusBadRequest},
		{method: http.MethodGet, path: "/debug/phi/timing/status?debug=1", code: http.StatusBadRequest},
		{method: http.MethodPost, path: "/debug/phi/timing?seconds=1", code: http.StatusMethodNotAllowed},
	} {
		resp := authorizedProfileMethod(t, client, s, tc.method, tc.path)
		resp.Body.Close()
		if resp.StatusCode != tc.code {
			t.Errorf("%s %s status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.code)
		}
	}
	resp := profileRequest(t, client, s.URL()+"/debug/phi/timing/status")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthorized timing status = %d", resp.StatusCode)
	}
	active, _ := timingStatus(t, client, s)
	if active {
		t.Fatal("rejected requests started a capture")
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestTimingConflictAndCancellationAllowRetry(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)
	_, beforeID := timingStatus(t, client, s)
	cancel, done := startTimingCapture(t, client, s, "/debug/phi/timing?seconds=30")
	defer cancel()
	_, captureID := waitTimingStatus(t, client, s, true)
	if captureID <= beforeID {
		t.Fatalf("capture id did not advance: %d after %d", captureID, beforeID)
	}

	busy := authorizedProfileRequest(t, client, s, "/debug/pprof/heap")
	busy.Body.Close()
	if busy.StatusCode != http.StatusConflict {
		t.Fatalf("overlapping heap status = %d, want 409", busy.StatusCode)
	}
	second := authorizedProfileRequest(t, client, s, "/debug/phi/timing?seconds=1")
	second.Body.Close()
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("second timing status = %d, want 409", second.StatusCode)
	}
	if active, _ := timingStatus(t, client, s); !active {
		t.Fatal("conflicting requests stopped the capture")
	}
	cancel()
	if resp := <-done; resp != nil {
		resp.Body.Close()
		t.Fatal("canceled capture returned an HTTP response")
	}
	// Inactive status only means detached. Wait for the handler's file
	// cleanup and final slot release before asserting cleanup or retrying.
	waitTimingIdle(t, s)
	active, lastID := timingStatus(t, client, s)
	if active || lastID != captureID {
		t.Fatalf("status after cancel: active=%t id=%d, want inactive id=%d", active, lastID, captureID)
	}
	assertNoTemporaryProfiles(t, s.Dir())

	retry := authorizedProfileRequest(t, client, s, "/debug/phi/timing?seconds=1")
	defer retry.Body.Close()
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("retry status = %d", retry.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(retry.Body, (64<<20)+1))
	if err != nil {
		t.Fatal(err)
	}
	_, summary := parseTimingProfile(t, data)
	if summary.RootsExported != 0 || !summary.Complete {
		t.Fatalf("empty retry summary = %+v", summary)
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestServerCloseCancelsTimingCapture(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	client := profileClient(t)
	_, done := startTimingCapture(t, client, s, "/debug/phi/timing?seconds=30")
	waitTimingStatus(t, client, s, true)
	dir := s.Dir()
	if err := s.Close(); err != nil {
		t.Fatalf("close diagnostics server: %v", err)
	}
	select {
	case resp := <-done:
		if resp != nil {
			resp.Body.Close()
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timing request did not finish after server close")
	}
	if active, _ := obs.TimingStatus(); active {
		t.Fatal("recorder still active after server close")
	}
	if _, err := os.Stat(dir); err == nil {
		t.Fatalf("owned directory still exists: %s", dir)
	}

	fresh := startTestServer(t, currentProcessReaders())
	retry := authorizedProfileRequest(t, profileClient(t), fresh, "/debug/phi/timing?seconds=1")
	defer retry.Body.Close()
	if retry.StatusCode != http.StatusOK {
		t.Fatalf("fresh capture status = %d", retry.StatusCode)
	}
	assertNoTemporaryProfiles(t, fresh.Dir())
}

// waitTimingIdle waits for detachment AND transport cleanup on this server.
func waitTimingIdle(t *testing.T, s *Server) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if active, _ := obs.TimingStatus(); !active && len(s.profileSlot) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("timing handler did not release its recorder and profile slot")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTimingSizeLimitPreventsSuccess(t *testing.T) {
	s := startTestServer(t, currentProcessReaders())
	s.maxProfileSize = 1
	resp := authorizedProfileRequest(t, profileClient(t), s, "/debug/phi/timing?seconds=1")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	assertNoTemporaryProfiles(t, s.Dir())
}

func TestEncodeTimingProfileNestedWeights(t *testing.T) {
	epoch := time.Now()
	zero := epoch.Add(300 * time.Nanosecond)
	snapshot := obs.TimingSnapshot{
		CaptureID:     3,
		RootsSeen:     1,
		RootsAdmitted: 1,
		RootsExported: 1,
		NodesRecorded: 4,
		Roots: []*obs.TimingNode{{
			Name:  "http GET /api/git/raw-status",
			Start: epoch,
			End:   epoch.Add(900 * time.Nanosecond),
			Children: []*obs.TimingNode{
				{
					Name:  "git.status",
					Start: epoch.Add(100 * time.Nanosecond),
					End:   epoch.Add(300 * time.Nanosecond),
					Children: []*obs.TimingNode{{
						Name:  "git.diff",
						Start: epoch.Add(150 * time.Nanosecond),
						End:   epoch.Add(200 * time.Nanosecond),
					}},
				},
				{Name: "git.log", Start: zero, End: zero},
			},
		}},
	}
	summary, prof, err := encodeTimingProfile(snapshot, "abc123")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if summary.BuildCommit != "abc123" || summary.PID != os.Getpid() || summary.CaptureID != 3 {
		t.Fatalf("identity = %+v", summary)
	}
	if summary.RootDurationNS != 900 || !summary.Complete {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ExportedSpanCounts["git.status"] != 1 || summary.ExportedSpanCounts["git.diff"] != 1 || summary.ExportedSpanCounts["git.log"] != 1 {
		t.Fatalf("span counts = %v", summary.ExportedSpanCounts)
	}
	weights := map[string]int64{}
	var total int64
	for _, sample := range prof.Sample {
		total += sample.Value[0]
		var stack []string
		for _, location := range sample.Location {
			stack = append(stack, location.Line[0].Function.Name)
		}
		weights[strings.Join(stack, " -> ")] = sample.Value[0]
	}
	if total != 900 {
		t.Fatalf("total = %d, want 900", total)
	}
	if len(weights) != 3 || weights["http GET /api/git/raw-status"] != 700 ||
		weights["git.status -> http GET /api/git/raw-status"] != 150 ||
		weights["git.diff -> git.status -> http GET /api/git/raw-status"] != 50 {
		t.Fatalf("weights = %v", weights)
	}
}

func TestEncodeTimingProfileZeroAndEmpty(t *testing.T) {
	epoch := time.Now()
	snapshot := obs.TimingSnapshot{
		RootsSeen:     1,
		RootsAdmitted: 1,
		RootsExported: 1,
		NodesRecorded: 1,
		Roots:         []*obs.TimingNode{{Name: "http GET /api/a", Start: epoch, End: epoch}},
	}
	summary, prof, err := encodeTimingProfile(snapshot, "")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(prof.Sample) != 0 || summary.RootDurationNS != 0 || !summary.Complete {
		t.Fatalf("zero summary = %+v samples = %d", summary, len(prof.Sample))
	}
	empty, emptyProf, err := encodeTimingProfile(obs.TimingSnapshot{}, "")
	if err != nil {
		t.Fatalf("encode empty: %v", err)
	}
	if len(emptyProf.Sample) != 0 || empty.RootDurationNS != 0 || !empty.Complete {
		t.Fatalf("empty summary = %+v", empty)
	}
}

func TestEncodeTimingProfileRejectsBadSnapshots(t *testing.T) {
	if _, _, err := encodeTimingProfile(obs.TimingSnapshot{Canceled: true}, ""); err == nil {
		t.Fatal("canceled snapshot was encoded")
	}
	epoch := time.Now()
	negative := obs.TimingSnapshot{Roots: []*obs.TimingNode{{
		Name: "http GET /api/a", Start: epoch, End: epoch.Add(-time.Second),
	}}}
	if _, _, err := encodeTimingProfile(negative, ""); err == nil {
		t.Fatal("negative interval was encoded")
	}
}
