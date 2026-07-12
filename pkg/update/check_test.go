package update

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseTagFromLocation(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://github.com/hypernewbie/phi/releases/tag/v0.8.2", "v0.8.2"},
		{"/releases/tag/v0.8.2-rc1", "v0.8.2-rc1"},
		{"https://github.com/hypernewbie/phi/releases/tag/0.8.0", "0.8.0"},
		{"", ""},
		{"https://github.com/hypernewbie/phi/releases", ""},
	}
	for _, c := range cases {
		if got := parseTagFromLocation(c.in); got != c.want {
			t.Errorf("parseTagFromLocation(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v0.8.2", "v0.8.1", true},
		{"v1.0.0", "v0.99.99", true},
		{"v0.8.1", "v0.8.2", false},
		{"v0.8.2", "v0.8.2", false},
		{"v0.8.3-rc1", "v0.8.2", false},   // rc < stable
		{"v0.9.0", "v0.8.0-beta.1", true}, // pre on current ignored
		{"dev", "v0.7.15", false},         // invalid current
		{"v0.7.16", "dev", false},         // invalid current
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.current); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestInstructionsFor(t *testing.T) {
	cases := map[string]string{
		"npm":         "npm update -g @hypernewbie/phi-code",
		"standalone":  "Download the latest release",
		"go-install":  "go install github.com/hypernewbie/phi@latest",
		"dev":         "Self-update is unavailable for development builds",
		"unexpected":  "Self-update is unavailable for development builds",
	}
	for method, want := range cases {
		got := instructionsFor(method)
		if !strings.Contains(got, want) {
			t.Errorf("instructionsFor(%q) = %q, want substring %q", method, got, want)
		}
	}
}

func TestChecker_LatestFromRedirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "https://github.com/hypernewbie/phi/releases/tag/v9.9.9")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	// Swap the releaseURL to point at our local server.
	orig := releaseURL
	defer func() {
		// releaseURL is a const string in source; in tests we override
		// via a swappable variable on the Checker. Make sure CheckLatest
		// uses the override.
	}()
	_ = orig

	c := NewChecker("v0.8.0", "npm")
	// Override the httpClient's URL by calling CheckLatest with a custom client.
	c.httpClient = &http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	// Patch the release URL via NewCheckerWithURL
	c2 := NewCheckerWithURL("v0.8.0", "npm", srv.URL)
	tag, ts, err := c2.CheckLatest()
	if err != nil {
		t.Fatalf("CheckLatest: %v", err)
	}
	if tag != "v9.9.9" {
		t.Errorf("expected tag v9.9.9, got %q", tag)
	}
	if ts.IsZero() {
		t.Error("expected non-zero timestamp")
	}
}

func TestChecker_NetworkFailureSoftFails(t *testing.T) {
	c := NewCheckerWithURL("v0.8.0", "npm", "http://127.0.0.1:1") // unreachable
	tag, _, err := c.CheckLatest()
	if err == nil {
		t.Error("expected error from unreachable host")
	}
	if tag != "" {
		t.Errorf("expected empty tag on error, got %q", tag)
	}
}

func TestChecker_NoLocationHeader(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := NewCheckerWithURL("v0.8.0", "npm", srv.URL)
	_, _, err := c.CheckLatest()
	if err == nil || !strings.Contains(err.Error(), "Location") {
		t.Errorf("expected Location error, got %v", err)
	}
}

func TestChecker_GarbageLocation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "/something/else")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()
	c := NewCheckerWithURL("v0.8.0", "npm", srv.URL)
	_, _, err := c.CheckLatest()
	if err == nil {
		t.Error("expected parse error on garbage Location")
	}
}

func TestChecker_CacheRoundTrip(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "phi_update.json")
	c := NewChecker("v0.8.0", "npm")
	c.cachePath = tmp
	c.mu.Lock()
	c.latest = "v0.8.5"
	c.checkedAt = time.Now()
	c.lastReal = time.Now()
	c.mu.Unlock()
	if err := c.SaveCache(); err != nil {
		t.Fatalf("SaveCache: %v", err)
	}

	c2 := NewChecker("v0.8.0", "npm")
	c2.cachePath = tmp
	c2.LoadCache()

	st := c2.Status()
	if st.Latest != "v0.8.5" {
		t.Errorf("expected cached latest v0.8.5, got %q", st.Latest)
	}
	if st.InstallMethod != "npm" {
		t.Errorf("expected install_method npm, got %q", st.InstallMethod)
	}
}

func TestChecker_StaleCheckInterval(t *testing.T) {
	c := NewChecker("v0.8.0", "npm")
	c.mu.Lock()
	c.checkedAt = time.Now().Add(-25 * time.Hour) // older than checkInterval
	c.mu.Unlock()
	if !c.CheckIfStale() {
		t.Error("expected stale after 25h")
	}

	c.mu.Lock()
	c.checkedAt = time.Now().Add(-1 * time.Hour)
	c.mu.Unlock()
	if c.CheckIfStale() {
		t.Error("expected fresh after 1h")
	}

	c.mu.Lock()
	c.checkedAt = time.Time{}
	c.mu.Unlock()
	if !c.CheckIfStale() {
		t.Error("expected stale when never checked")
	}
}

func TestChecker_MinIntervalGate(t *testing.T) {
	c := NewChecker("v0.8.0", "npm")
	c.mu.Lock()
	c.lastReal = time.Now().Add(-1 * time.Hour) // recent
	c.mu.Unlock()
	if c.ShouldRunRealCheck() {
		t.Error("expected NOT to allow real check within min interval")
	}

	c.mu.Lock()
	c.lastReal = time.Now().Add(-7 * time.Hour) // past 6h floor
	c.mu.Unlock()
	if !c.ShouldRunRealCheck() {
		t.Error("expected to allow real check past min interval")
	}
}

func TestChecker_RunCheckReturnsCachedWhenMinIntervalHits(t *testing.T) {
	c := NewChecker("v0.8.0", "npm")
	c.mu.Lock()
	c.latest = "v0.8.3"
	c.lastReal = time.Now().Add(-1 * time.Hour) // recent
	c.mu.Unlock()

	res := c.RunCheck(false)
	if res.Err != nil {
		t.Errorf("expected no error from cached path, got %v", res.Err)
	}
	if res.Latest != "v0.8.3" {
		t.Errorf("expected cached latest v0.8.3, got %q", res.Latest)
	}
}

func TestChecker_StatusUpdateAvailable(t *testing.T) {
	c := NewChecker("v0.8.0", "npm")
	c.mu.Lock()
	c.latest = "v0.8.5"
	c.checkedAt = time.Now().Add(-1 * time.Hour)
	c.mu.Unlock()

	st := c.Status()
	if !st.UpdateAvailable {
		t.Error("expected update_available=true when latest > current")
	}
	if st.Current != "v0.8.0" || st.Latest != "v0.8.5" {
		t.Errorf("current/latest wrong: %+v", st)
	}
}

func TestChecker_DevBuildHidesUpdate(t *testing.T) {
	c := NewChecker("dev", "dev")
	c.mu.Lock()
	c.latest = "v9.9.9"
	c.checkedAt = time.Now()
	c.mu.Unlock()

	st := c.Status()
	if st.UpdateAvailable {
		t.Error("dev current should never show update_available")
	}
}

func TestChecker_LoadCacheCorruptJSON(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "phi_update.json")
	if err := os.WriteFile(tmp, []byte("{not json"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	c := NewChecker("v0.8.0", "npm")
	c.cachePath = tmp
	// Should not panic; just leave cache empty.
	c.LoadCache()
	st := c.Status()
	if st.Latest != "" {
		t.Errorf("expected empty latest after corrupt cache load, got %q", st.Latest)
	}
}

func TestChecker_LoadCacheNoFile(t *testing.T) {
	c := NewChecker("v0.8.0", "npm")
	c.cachePath = filepath.Join(t.TempDir(), "does-not-exist.json")
	// Should not panic.
	c.LoadCache()
	st := c.Status()
	if st.Latest != "" {
		t.Errorf("expected empty latest, got %q", st.Latest)
	}
}

func TestChecker_ParallelChecksSerialized(t *testing.T) {
	// Stress: 50 goroutines hammer RunCheck concurrently. With a working
	// mu this should not race or panic.
	c := NewChecker("v0.8.0", "npm")
	c.cachePath = filepath.Join(t.TempDir(), "phi_update.json")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = c.RunCheck(false)
			_ = c.Status()
		}()
	}
	wg.Wait()
}

// NewCheckerWithURL is a test-only constructor that overrides the release
// URL the checker hits. Keeps tests hermetic — no internet required.
func NewCheckerWithURL(current, install, overrideURL string) *Checker {
	c := NewChecker(current, install)
	c.releaseURLOverride = overrideURL
	return c
}