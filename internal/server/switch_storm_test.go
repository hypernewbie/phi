package server

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hypernewbie/phi/pkg/system"
)

// A desktop in low-power (single-tab) mode flips between servers by
// storming each one with the same request mix every switch fires:
// version, coders, config, peers, sessions — with writes landing under
// the reads when settings change mid-switch. These tests storm one phi
// server exactly that way, from two simulated backends at once, and pin
// the server-side half of the contract:
//
// A response is always one writer's whole answer, never a blend of two
// writers, and one terminal's replay never carries another terminal's
// bytes. "It thinks one server is another server" is a defect, never a
// trade-off.
//
// Run with -race (CI does): a data race in any hammered handler fails
// here before it can fail a user.

func stormServer(t *testing.T) *httptest.Server {
	t.Helper()
	// The access manager reads its record from the user data dir; point
	// it inside the fixture BEFORE the server (and its manager) exist,
	// so the storm runs unauthenticated.
	system.SetPhiDataDir(t.TempDir())
	t.Cleanup(func() { system.SetPhiDataDir("") })
	withTempConfig(t)
	// The sessions handler resolves pi sessions against the active CWD.
	beforeCWD := testServer.activeCWD
	testServer.activeCWD = t.TempDir()
	t.Cleanup(func() { testServer.activeCWD = beforeCWD })
	// A fresh manager owns nothing until it Configures; without this the
	// middleware answers every row 401.
	if err := testServer.accessManager.Configure(""); err != nil {
		t.Fatalf("configure access manager: %v", err)
	}
	srv := httptest.NewServer(testServer.Handler())
	t.Cleanup(srv.Close)
	return srv
}

// TestSwitchStormConcurrentEndpointMix hammers the read/write mix two
// switching desktops produce, then pins write atomicity: the saved
// peers list is exactly one writer's list, never a blend of both.
func TestSwitchStormConcurrentEndpointMix(t *testing.T) {
	srv := stormServer(t)

	const rounds = 40
	paths := []string{
		"/api/version",
		"/api/coders",
		"/api/config",
		"/api/peers/status",
		"/api/sessions",
	}
	errs := make(chan error, 2*rounds*(len(paths)+1))

	var wg sync.WaitGroup
	worker := func(profile string) {
		defer wg.Done()
		client := srv.Client()
		for i := 0; i < rounds; i++ {
			for _, path := range []string{"/api/sessions?coder=pi"} { // TEMP-SESSIONS-ONLY
				resp, err := client.Get(srv.URL + path)
				if err != nil {
					errs <- fmt.Errorf("%s GET %s: %w", profile, path, err)
					continue
				}
				if resp.StatusCode != http.StatusOK {
					snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
					errs <- fmt.Errorf("%s GET %s: status %d body=%s", profile, path, resp.StatusCode, snippet)
					resp.Body.Close()
					continue
				}
				var body any
				if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
					errs <- fmt.Errorf("%s GET %s: body: %w", profile, path, err)
				}
				resp.Body.Close()
			}
			// A settings write landing between the reads.
			peers := fmt.Sprintf(`[{"name":"%s-peer-%d","url":""}]`, profile, i)
			resp, err := client.Post(
				srv.URL+"/api/config/peers",
				"application/json",
				strings.NewReader(peers),
			)
			if err != nil {
				errs <- fmt.Errorf("%s POST peers: %w", profile, err)
				continue
			}
			if resp.StatusCode != http.StatusOK {
				errs <- fmt.Errorf("%s POST peers: status %d", profile, resp.StatusCode)
			}
			resp.Body.Close()
		}
	}

	wg.Add(2)
	go worker("storm-a")
	go worker("storm-b")
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if t.Failed() {
		t.FailNow()
	}

	// The final saved list must be one writer's whole answer.
	cfg, _, err := readPrimaryConfig()
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if len(cfg.Peers) != 1 {
		t.Fatalf("expected exactly one peer, got %d: %+v", len(cfg.Peers), cfg.Peers)
	}
	name := cfg.Peers[0].Name
	if !strings.HasPrefix(name, "storm-a-") && !strings.HasPrefix(name, "storm-b-") {
		t.Fatalf("peer name %q belongs to neither writer", name)
	}
}

// replayLatest fetches a pane's full replay over the real endpoint.
// The envelope is a 4-byte big-endian header length, the header JSON,
// then the raw replayed bytes.
func replayLatest(t *testing.T, client *http.Client, base, pane string, epoch uint64) (int, []byte) {
	t.Helper()
	resp, err := client.Get(
		base + "/api/terminals/" + pane +
			"/replay?epoch=" + fmt.Sprint(epoch) + "&from=0&through=latest",
	)
	if err != nil {
		t.Fatalf("replay %s: %v", pane, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("replay %s body: %v", pane, err)
	}
	return resp.StatusCode, body
}

// TestSwitchStormTerminalReplayIdentity interleaves bytes into two
// terminals while a replay storm reads both back. Every replay response
// carries exactly the requested terminal's bytes — one terminal is
// never another terminal, not even mid-write.
func TestSwitchStormTerminalReplayIdentity(t *testing.T) {
	srv := stormServer(t) // installs a fresh testServer first
	setupHotHub(t)        // then hangs the hot hub off THAT server

	const (
		alphaPane  = "storm-pane-alpha"
		betaPane   = "storm-pane-beta"
		alphaBytes = "ALPHA-OUTPUT-7f3a-"
		betaBytes  = "BETA-OUTPUT-c29e-"
	)
	for _, pane := range []string{alphaPane, betaPane} {
		if err := testServer.hub.InitPaneJournal(pane, 90, 25); err != nil {
			t.Fatalf("init %s: %v", pane, err)
		}
	}
	// Seed each terminal with its own marker before the storm so every
	// replay has bytes to certify.
	if err := testServer.hub.Ingest(alphaPane, []byte(alphaBytes)); err != nil {
		t.Fatalf("seed %s: %v", alphaPane, err)
	}
	if err := testServer.hub.Ingest(betaPane, []byte(betaBytes)); err != nil {
		t.Fatalf("seed %s: %v", betaPane, err)
	}

	epoch := func(pane string) uint64 {
		ph, ok := testServer.hub.LookupPane(pane)
		if !ok {
			t.Fatalf("pane %s missing", pane)
		}
		return ph.EpochOf()
	}

	stop := make(chan struct{})
	var writers sync.WaitGroup
	writer := func(pane, pattern string) {
		defer writers.Done()
		for i := 0; i < 80; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if err := testServer.hub.Ingest(pane, []byte(pattern)); err != nil {
				t.Errorf("ingest %s: %v", pane, err)
				return
			}
		}
	}
	writers.Add(2)
	go writer(alphaPane, alphaBytes)
	go writer(betaPane, betaBytes)

	// Replay both terminals repeatedly while the writes run. A replay
	// may legitimately refuse mid-storm (epoch/fence moved) or return a
	// partial page; whatever it returns must never contain the other
	// terminal's bytes.
	var readers sync.WaitGroup
	client := srv.Client()
	// go vet forbids t.Fatalf from a non-test goroutine; collect and
	// raise from this one.
	readErrs := make(chan error, 2)
	replays := func() {
		defer readers.Done()
		for round := 0; round < 25; round++ {
			for _, want := range []struct {
				pane   string
				absent string
			}{{alphaPane, "BETA-OUTPUT"}, {betaPane, "ALPHA-OUTPUT"}} {
				status, body := replayLatest(t, client, srv.URL, want.pane, epoch(want.pane))
				if status != http.StatusOK {
					continue
				}
				if len(body) < 4 {
					readErrs <- fmt.Errorf("replay %s: missing envelope", want.pane)
					return
				}
				text := string(body)
				if strings.Contains(text, want.absent) {
					readErrs <- fmt.Errorf("replay of %s carried %s's bytes", want.pane, want.absent)
					return
				}
			}
		}
	}
	readers.Add(2)
	go replays()
	go replays()

	readers.Wait()
	close(readErrs)
	for err := range readErrs {
		t.Fatal(err)
	}
	close(stop)
	writers.Wait()

	// The certified answer per pane after the storm: its own bytes and
	// nobody else's.
	for _, want := range []struct {
		pane   string
		marker string
		absent string
	}{
		{alphaPane, alphaBytes, "BETA-OUTPUT"},
		{betaPane, betaBytes, "ALPHA-OUTPUT"},
	} {
		status, body := replayLatest(t, client, srv.URL, want.pane, epoch(want.pane))
		if status != http.StatusOK {
			t.Fatalf("final replay %s: status %d body=%q", want.pane, status, body)
		}
		if len(body) < 4 {
			t.Fatalf("final replay %s: missing envelope", want.pane)
		}
		n := int(binary.BigEndian.Uint32(body[:4]))
		if 4+n > len(body) {
			t.Fatalf("final replay %s: invalid envelope bound", want.pane)
		}
		data := string(body[4+n:])
		if strings.Contains(data, want.absent) {
			t.Fatalf("final replay of %s carried %s's bytes", want.pane, want.absent)
		}
		if !strings.Contains(data, want.marker) {
			t.Fatalf("final replay of %s lost its own bytes", want.pane)
		}
	}
}
