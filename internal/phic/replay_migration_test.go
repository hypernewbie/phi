package phic

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// replayPage answers one bounded page for the request and echoes the fence
// the client sent, the way the server certifies the requested end.
func replayPage(w http.ResponseWriter, r *http.Request, source []byte, page uint64) {
	q := r.URL.Query()
	from, _ := strconv.ParseUint(q.Get("from"), 10, 64)
	through, _ := strconv.ParseUint(q.Get("through"), 10, 64)
	if through > uint64(len(source)) {
		through = uint64(len(source))
	}
	end := from + page
	if end > through {
		end = through
	}
	h := wireproto.ReplayHeader{
		Epoch:         7,
		Start:         from,
		End:           end,
		Through:       through,
		ThroughCursor: q.Get("through_event_cursor"),
		EventCursor:   fmt.Sprintf("v1.7.%d.0", end),
		InitCols:      80,
		InitRows:      24,
	}
	writeReplayFixture(w, h, source[from:end])
}

// TestRelayReadsRetainedOutputOnlyFromReplayEndpoint proves the migrated
// relay never asks the server for rendered terminal state. The retired
// endpoints answer 426, so a request to them would break the client.
func TestRelayReadsRetainedOutputOnlyFromReplayEndpoint(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		switch r.URL.Path {
		case "/api/terminals/p/replay":
			serveNativeReplay(w, r, []byte("hello"), nil)
		default:
			http.Error(w, "server-rendered terminal state is retired; use /replay with <terminal subprotocol>", http.StatusUpgradeRequired)
		}
	}))
	defer srv.Close()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	relay.epoch = 7
	relay.head = 5
	relay.headCursor = "v1.7.5.0"
	if err := relay.recoverOutput(t.Context(), "p", 5, relay.headCursor, false); err != nil {
		t.Fatal(err)
	}
	if string(output.Bytes()) != "hello" {
		t.Fatalf("retained output not painted: %q", output.Bytes())
	}
	mu.Lock()
	defer mu.Unlock()
	for _, path := range paths {
		if path != "/api/terminals/p/replay" {
			t.Fatalf("retired endpoint used: %s", path)
		}
	}
}

// TestRelayFollowsServerPageCap proves the client follows the server's
// bounded pages instead of assuming one page holds the whole window.
func TestRelayFollowsServerPageCap(t *testing.T) {
	source := []byte(strings.Repeat("abcdefgh", 512))
	const page = 512
	var mu sync.Mutex
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		replayPage(w, r, source, page)
	}))
	defer srv.Close()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	relay.epoch = 7
	relay.head = uint64(len(source))
	relay.headCursor = fmt.Sprintf("v1.7.%d.0", len(source))
	if err := relay.recoverOutput(t.Context(), "p", uint64(len(source)), relay.headCursor, false); err != nil {
		t.Fatal(err)
	}
	if string(output.Bytes()) != string(source) {
		t.Fatalf("paged replay lost bytes: got %d want %d", output.Len(), len(source))
	}
	mu.Lock()
	defer mu.Unlock()
	if requests < 2 {
		t.Fatalf("client ignored the page cap: %d requests", requests)
	}
}

// TestRelayResumeFencesThePageWithTheRememberedCursor proves a resumed
// attach asks the server for exactly the span the frontier certifies.
func TestRelayResumeFencesThePageWithTheRememberedCursor(t *testing.T) {
	var mu sync.Mutex
	var fence, after string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		fence = r.URL.Query().Get("through_event_cursor")
		after = r.URL.Query().Get("after_event_cursor")
		mu.Unlock()
		serveNativeReplay(w, r, []byte("tail"), nil)
	}))
	defer srv.Close()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	relay.epoch = 7
	relay.head = 9
	relay.headCursor = "v1.7.9.0"
	relay.previous = &recordingCursor{epoch: 7, through: 4, cursor: "v1.7.4.0"}
	if err := relay.recoverOutput(t.Context(), "p", 4, relay.previous.cursor, true); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if fence != "v1.7.4.0" {
		t.Fatalf("page was not fenced by the remembered cursor: %q", fence)
	}
	if after != "v1.7.0.0" {
		t.Fatalf("paging cursor does not certify the start: %q", after)
	}
}

// TestRelayAdoptsExpiredFloorAndResumes proves a client that lost its
// prefix continues from the certified floor instead of failing or
// painting bytes that no longer exist.
func TestRelayAdoptsExpiredFloorAndResumes(t *testing.T) {
	source := make([]byte, 10)
	copy(source[6:], "tail")
	var mu sync.Mutex
	expired := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
		mu.Lock()
		first := expired
		expired = false
		mu.Unlock()
		if first || from < 6 {
			w.Header().Set("X-Phi-Replay-Window", `{"epoch":7,"oldest":6,"head":10,"floor_cols":80,"floor_rows":24,"head_cols":80,"head_rows":24,"floor_event_cursor":"v1.7.6.0","event_cursor":"v1.7.10.0"}`)
			http.Error(w, "replay position expired", http.StatusConflict)
			return
		}
		replayPage(w, r, source, 1024)
	}))
	defer srv.Close()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	relay.epoch = 7
	relay.head = 10
	relay.headCursor = "v1.7.10.0"
	if err := relay.recoverOutput(t.Context(), "p", 10, relay.headCursor, true); err != nil {
		t.Fatal(err)
	}
	if relay.written != 10 {
		t.Fatalf("expired floor not adopted: frontier=%d", relay.written)
	}
	if string(output.Bytes()) != "tail" {
		t.Fatalf("retained tail not painted: %q", output.Bytes())
	}
}

// TestSessionsFlagFocusesSessionsPanel proves phic -s opens the console on
// the sessions panel, the same view the Ctrl-] s shortcut selects.
func TestSessionsFlagFocusesSessionsPanel(t *testing.T) {
	for _, args := range [][]string{{"-s"}, {"--sessions"}, {"-s", "."}} {
		cfg, err := parseFlags(args)
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if !cfg.Sessions {
			t.Fatalf("%v did not request the sessions panel", args)
		}
	}
	cfg, err := parseFlags([]string{"."})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Sessions {
		t.Fatal("sessions panel requested without the flag")
	}
	m := newTUIModel("test", config{Sessions: true}, nil, nil, -1, stubBuild)
	if m.focus != focusSessions {
		t.Fatalf("sessions panel not focused: %v", m.focus)
	}
	plain := newTUIModel("test", config{}, nil, nil, -1, stubBuild)
	if plain.focus != focusTerminal {
		t.Fatalf("terminal focus changed without the flag: %v", plain.focus)
	}
}

// TestPhicSessionsFlagKeepsOtherFlags proves the short flag does not
// shadow the server URL or the pane selection.
func TestPhicSessionsFlagKeepsOtherFlags(t *testing.T) {
	cfg, err := parseFlags([]string{"-s", "--server", "http://example:7070"})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Sessions || cfg.Server != "http://example:7070" {
		t.Fatalf("flags did not bind: %+v", cfg)
	}
}
