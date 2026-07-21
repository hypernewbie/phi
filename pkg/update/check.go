package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

const (
	// releaseURL is the no-redirect target. The Location header carries
	// the latest tag. No GitHub API needed (no rate limits, no JSON).
	releaseURL = "https://github.com/hypernewbie/phi/releases/latest"

	// checkInterval is how often the cached status is refreshed.
	checkInterval = 24 * time.Hour

	// minRealCheckInterval is the floor between two real (uncached) checks,
	// persisted to disk so restarts respect it. Plan §3.5 specifies 6h.
	minRealCheckInterval = 6 * time.Hour

	// stateFileName is the on-disk cache file. Lives next to other phi state.
	stateFileName = "phi_update.json"
)

// Status is the response shape of GET /api/update/status. Add fields
// additively; old frontends ignore unknowns.
type Status struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"update_available"`
	InstallMethod   string `json:"install_method"`
	Instructions    string `json:"instructions"`
	LastChecked     string `json:"last_checked,omitempty"` // ISO-8601
	Error           string `json:"error,omitempty"`
}

// CheckResult is what CheckLatest returns internally.
type CheckResult struct {
	Latest    string
	CheckedAt time.Time
	Err       error
}

// Checker polls GitHub for the latest release tag and caches results.
type Checker struct {
	mu                 sync.RWMutex
	current            string
	install            string
	latest             string
	checkedAt          time.Time
	lastReal           time.Time
	cachePath          string
	httpClient         *http.Client
	releaseURLOverride string // test-only
}

// NewChecker constructs a Checker with sensible defaults. Pass empty
// cachePath to use the default ~/.phi/phi_update.json.
func NewChecker(currentVersion, installMethod string) *Checker {
	cachePath := ""
	home, err := os.UserHomeDir()
	if err == nil {
		cachePath = filepath.Join(home, ".phi", stateFileName)
	}
	return &Checker{
		current:    currentVersion,
		install:    installMethod,
		cachePath:  cachePath,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// SetReleaseURLForTesting injects a fake release URL (e.g. httptest.Server) for cross-package tests.
func (c *Checker) SetReleaseURLForTesting(url string) {
	c.releaseURLOverride = url
}

// LoadCache reads the persisted last-known-good check state. Failure to
// read (no file, corrupt JSON, permission denied) is not fatal — we just
// start with an empty cache and let the next check populate it.
func (c *Checker) LoadCache() {
	if c.cachePath == "" {
		return
	}
	b, err := os.ReadFile(c.cachePath)
	if err != nil {
		return
	}
	var cached struct {
		Latest    string    `json:"latest"`
		CheckedAt time.Time `json:"checked_at"`
		LastReal  time.Time `json:"last_real"`
	}
	if err := json.Unmarshal(b, &cached); err != nil {
		return
	}
	c.mu.Lock()
	c.latest = cached.Latest
	c.checkedAt = cached.CheckedAt
	c.lastReal = cached.LastReal
	c.mu.Unlock()
}

// SaveCache persists the latest check state atomically.
func (c *Checker) SaveCache() error {
	if c.cachePath == "" {
		return nil
	}
	c.mu.RLock()
	payload := struct {
		Latest    string    `json:"latest"`
		CheckedAt time.Time `json:"checked_at"`
		LastReal  time.Time `json:"last_real"`
	}{
		Latest:    c.latest,
		CheckedAt: c.checkedAt,
		LastReal:  c.lastReal,
	}
	c.mu.RUnlock()

	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return system.WriteFileAtomic(c.cachePath, b, 0644)
}

// CheckLatest performs one fresh HTTP check against GitHub. Returns the
// latest tag and the time of the check. Errors are non-fatal — callers
// should soft-fail (plan R8).
func (c *Checker) CheckLatest() (string, time.Time, error) {
	// No-redirect client per plan §3.5. The Location header carries the
	// latest tag, e.g. /hypernewbie/phi/releases/tag/v0.8.2.
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	url := releaseURL
	if c.releaseURLOverride != "" {
		url = c.releaseURLOverride
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", time.Time{}, err
	}
	// Identify ourselves modestly; gh accepts UA-less, but some infra filters.
	req.Header.Set("User-Agent", "phi-update-check/1.0")

	resp, err := client.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	// Drain body so the connection can be reused. Body is small (302 page).
	_, _ = io.Copy(io.Discard, resp.Body)

	loc := resp.Header.Get("Location")
	if loc == "" {
		return "", time.Time{}, errors.New("no Location header in GitHub redirect")
	}

	tag := parseTagFromLocation(loc)
	if tag == "" {
		return "", time.Time{}, fmt.Errorf("could not parse tag from Location: %q", loc)
	}

	return tag, time.Now(), nil
}

// CheckIfStale returns true if the cached check is older than
// checkInterval OR we've never checked. The caller should then call
// CheckLatest to refresh.
func (c *Checker) CheckIfStale() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.checkedAt.IsZero() {
		return true
	}
	return time.Since(c.checkedAt) > checkInterval
}

// ShouldRunRealCheck returns true if at least minRealCheckInterval has
// elapsed since the last real network check (or we've never checked).
// Plan R8 / §3.5: 6h floor so a startup loop of force-checks cannot
// hammer GitHub. Renamed from CheckRespectsMinInterval (was ambiguous).
func (c *Checker) ShouldRunRealCheck() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.lastReal.IsZero() {
		return true
	}
	return time.Since(c.lastReal) >= minRealCheckInterval
}

// RunCheck runs one check (subject to minRealCheckInterval) and updates
// the in-memory cache + persistent cache. Returns the new CheckResult.
// If minRealCheckInterval is not satisfied, returns the cached state
// without making a network call.
func (c *Checker) RunCheck(force bool) CheckResult {
	c.mu.Lock()
	currentLatest := c.latest
	currentCheckedAt := c.checkedAt
	c.mu.Unlock()

	if !force && !c.ShouldRunRealCheck() {
		// Inside the min interval — return cached state.
		return CheckResult{
			Latest:    currentLatest,
			CheckedAt: currentCheckedAt,
		}
	}

	latest, checkedAt, err := c.CheckLatest()
	now := time.Now()
	c.mu.Lock()
	if err == nil {
		c.latest = latest
		c.lastReal = now
	}
	c.checkedAt = now
	c.mu.Unlock()

	if err == nil {
		_ = c.SaveCache()
	}

	return CheckResult{
		Latest:    latest,
		CheckedAt: checkedAt,
		Err:       err,
	}
}

// Status builds the public Status payload for the API.
func (c *Checker) Status() Status {
	c.mu.RLock()
	current := c.current
	latest := c.latest
	checkedAt := c.checkedAt
	install := c.install
	c.mu.RUnlock()

	s := Status{
		Current:       current,
		Latest:        latest,
		InstallMethod: install,
		Instructions:  instructionsFor(install),
	}
	if !checkedAt.IsZero() {
		s.LastChecked = checkedAt.UTC().Format(time.RFC3339)
	}
	if current != "" && current != "dev" && latest != "" {
		s.UpdateAvailable = isNewer(latest, current)
	}
	return s
}

// parseTagFromLocation extracts the trailing tag from a GitHub redirect
// Location header. Examples:
//
//	https://github.com/hypernewbie/phi/releases/tag/v0.8.2 -> v0.8.2
//	/releases/tag/v0.8.2-rc1                               -> v0.8.2-rc1
//	/anything                                               -> ""
func parseTagFromLocation(loc string) string {
	const marker = "/releases/tag/"
	idx := strings.LastIndex(loc, marker)
	if idx < 0 {
		return ""
	}
	return strings.TrimSpace(loc[idx+len(marker):])
}

// isNewer returns true if `latest` is semver-newer than `current`.
// Pre-release suffixes (-rc1, -beta.2) on latest are treated as "not
// yet released" and never trigger update_available — the user is on
// stable, the next stable may or may not be 0.8.3 yet. Pre-release
// suffixes on current are ignored (a beta user sees stable releases).
func isNewer(latest, current string) bool {
	lMaj, lMin, lPat, lPre, lOk := parseSemver(latest)
	cMaj, cMin, cPat, _, cOk := parseSemver(current)
	if !lOk || !cOk {
		return false
	}
	if lMaj != cMaj {
		return lMaj > cMaj
	}
	if lMin != cMin {
		return lMin > cMin
	}
	if lPat != cPat {
		// Pre-release of the same X.Y.Z is NOT newer than current.
		// User is on 0.8.2, latest is 0.8.3-rc1 — they shouldn't be
		// told to upgrade to a pre-release.
		if lPre != "" {
			return false
		}
		return lPat > cPat
	}
	// Same X.Y.Z — same release. Pre-release suffix ignored: not "newer".
	return false
}

func parseSemver(v string) (major, minor, patch int, pre string, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return
	}
	// Split off pre-release suffix
	if i := strings.Index(v, "-"); i >= 0 {
		pre = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return
	}
	major, _ = strconv.Atoi(parts[0])
	minor, _ = strconv.Atoi(parts[1])
	patch, _ = strconv.Atoi(parts[2])
	if major == 0 && minor == 0 && patch == 0 && parts[0] != "0" {
		return
	}
	ok = true
	return
}

// instructionsFor returns the user-facing upgrade command for the
// detected install method. The full truth table lives in plan §3.5.
func instructionsFor(method string) string {
	switch method {
	case "npm":
		return "npm update -g @hypernewbie/phi-code"
	case "standalone":
		return "Download the latest release from https://github.com/hypernewbie/phi/releases and replace the running binary."
	case "go-install":
		return "Run: go install github.com/hypernewbie/phi@latest"
	default:
		return "Self-update is unavailable for development builds. Pull and rebuild."
	}
}
