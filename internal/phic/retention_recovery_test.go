package phic

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termstate"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

func writeFramed(t *testing.T, w http.ResponseWriter, header any, payload []byte) {
	t.Helper()
	h, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	var size [4]byte
	binary.BigEndian.PutUint32(size[:], uint32(len(h)))
	_, _ = w.Write(size[:])
	_, _ = w.Write(h)
	_, _ = w.Write(payload)
}

func TestRecordingStartAdvancedIsExpired(t *testing.T) {
	var queries atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries.Store(r.URL.Query().Get("after_event_cursor"))
		from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
		// The floor moved past the request: an advanced start is expiry.
		writeFramed(t, w, wireproto.RecordingHeader{Epoch: 7, Start: from + 5, End: from + 7}, []byte("xy"))
	}))
	defer srv.Close()
	api := mustAPI(t, srv.URL)
	if _, _, err := api.recording(t.Context(), "p", 7, 0, 7, "v1.7.0.0"); !errors.Is(err, errRecordingExpired) {
		t.Fatalf("advanced start err = %v, want errRecordingExpired", err)
	}
	if got := queries.Load().(string); got != "v1.7.0.0" {
		t.Fatalf("after_event_cursor = %q, want the chained cursor", got)
	}
}

func TestRecordingStartBehindIsInvalid(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeFramed(t, w, wireproto.RecordingHeader{Epoch: 7, Start: 3, End: 8}, bytes.Repeat([]byte("x"), 5))
	}))
	defer srv.Close()
	api := mustAPI(t, srv.URL)
	_, _, err := api.recording(t.Context(), "p", 7, 5, 8, "")
	if !errors.Is(err, errInvalidRecording) || errors.Is(err, errRecordingExpired) {
		t.Fatalf("rewound start err = %v, want errInvalidRecording only", err)
	}
}

func ansiStateServer(t *testing.T, screen []byte, head uint64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/state" && r.URL.Query().Get("through") != "latest" {
			http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
			return
		}
		writeFramed(t, w, wireproto.AttachHeadHeader{
			Epoch: 7, Oldest: 90, Head: head,
			Ckpt: &wireproto.CheckpointHeader{Kind: "ansi-v1", Through: head, Cols: 80, Rows: 24, Len: len(screen)},
		}, screen)
	}))
}

func TestRelayCheckpointJumpAcrossExpiredPrefix(t *testing.T) {
	for _, historical := range []bool{false, true} {
		screen := []byte("\x1b[2J\x1b[HLIVE SCREEN")
		srv := ansiStateServer(t, screen, 100)
		output := &shortTerminal{}
		relay := NewRelay(output, mustAPI(t, srv.URL))
		relay.epoch = 7
		if historical {
			relay.repaint = &repaintFilter{}
		}
		if err := relay.recoverOutput(t.Context(), "p", 90, historical); err != nil {
			srv.Close()
			t.Fatalf("historical=%t: recover across floor: %v", historical, err)
		}
		if relay.written != 100 {
			srv.Close()
			t.Fatalf("historical=%t: frontier = %d, want 100", historical, relay.written)
		}
		if !bytes.Contains(output.Bytes(), []byte("LIVE SCREEN")) {
			srv.Close()
			t.Fatalf("historical=%t: checkpoint screen not painted: %q", historical, output.Bytes())
		}
		srv.Close()
	}
}

func TestRelayCheckpointJumpFailsClosedWithoutState(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("through") == "latest" {
			http.Error(w, "gone", http.StatusNotFound)
			return
		}
		http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
	}))
	defer srv.Close()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	relay.epoch = 7
	err := relay.recoverOutput(t.Context(), "p", 90, false)
	var status *apiError
	if !errors.As(err, &status) || status.Code != http.StatusNotFound {
		t.Fatalf("jump without state err = %v, want 404", err)
	}
	if relay.written != 0 || output.Len() != 0 {
		t.Fatalf("failed jump advanced/painted: %d %q", relay.written, output.Bytes())
	}
}

func TestRelayReconnectAcrossFloorJumpsToLiveState(t *testing.T) {
	prefix := []byte("PREFIX\r\n")
	screen := []byte("\x1b[2J\x1b[HLIVE SCREEN")
	var connections atomic.Int64
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws/pane/p" {
			ws, err := up.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			n := connections.Add(1)
			if n == 1 {
				_ = ws.WriteMessage(websocket.BinaryMessage, testAttach(t, 7, uint64(len(prefix))))
				_ = ws.WriteMessage(websocket.BinaryMessage, testOutput(t, uint64(len(prefix)), []byte("FIRST\r\n")))
				_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1001, "offline"), time.Now().Add(time.Second))
			} else {
				// The first connection's frontier is evicted on reattach.
				_ = ws.WriteMessage(websocket.BinaryMessage, testAttachOldest(t, 7, 50, 100))
				_ = ws.WriteMessage(websocket.BinaryMessage, testExit(t, 0))
			}
			for {
				if _, _, err := ws.ReadMessage(); err != nil {
					return
				}
			}
		} else if r.URL.Query().Get("through") == "latest" {
			writeFramed(t, w, wireproto.AttachHeadHeader{
				Epoch: 7, Oldest: 50, Head: 100,
				Ckpt: &wireproto.CheckpointHeader{Kind: "ansi-v1", Through: 100, Cols: 80, Rows: 24, Len: len(screen)},
			}, screen)
		} else {
			from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
			through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
			if from < 50 {
				http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
				return
			}
			if through > 100 {
				through = 100
			}
			writeFramed(t, w, wireproto.RecordingHeader{Epoch: 7, Start: from, End: through}, make([]byte, through-from))
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	output := &shortTerminal{}
	relay := NewRelay(output, mustAPI(t, srv.URL))
	if _, err := relay.Connect(ctx, "p"); err != nil {
		t.Fatal(err)
	}
	if err := relay.Run(ctx); err != nil {
		t.Fatalf("reconnect across floor: %v", err)
	}
	if relay.written != 100 {
		t.Fatalf("frontier = %d, want 100", relay.written)
	}
	if !bytes.Contains(output.Bytes(), []byte("LIVE SCREEN")) {
		t.Fatalf("checkpoint screen not painted: %q", output.Bytes())
	}
	if connections.Load() != 2 {
		t.Fatalf("connections = %d, want 2", connections.Load())
	}
}

func ghosttySnapshot(t *testing.T, ctx context.Context) []byte {
	t.Helper()
	state, err := termstate.New(ctx, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	if err = state.Feed([]byte("HEALED SCREEN")); err != nil {
		t.Fatal(err)
	}
	snapshot, err := state.Ready()
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestTUIBootstrapAcrossFloorUsesAttachEpochAndLatestState(t *testing.T) {
	for _, tc := range []struct {
		name     string
		epoch    uint64
		attached bool
	}{
		{"cold", 0, false},
		{"reconnect", 7, true},
		{"changed-epoch", 6, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			live, err := termemu.NewGhostty(termemu.Options{Cols: 120, Rows: 30, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
			if err != nil {
				t.Skip(err)
			}
			snapshot := ghosttySnapshot(t, t.Context())
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("epoch") != "7" {
					http.Error(w, "epoch mismatch", http.StatusConflict)
					return
				}
				writeFramed(t, w, wireproto.AttachHeadHeader{
					Epoch: 7, Oldest: 50, Head: 110,
					Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: 110, Cols: 80, Rows: 24, Len: len(snapshot)},
				}, snapshot)
			}))
			defer srv.Close()
			p := &paneActor{
				emu: live, api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, ctx: t.Context(),
				epoch: tc.epoch, epochSet: tc.attached, cols: 120, rows: 30, emuCols: 120, emuRows: 30,
				conn: &websocket.Conn{}, outbox: make(chan paneWrite, 4),
			}
			defer func() { _ = p.emu.Close() }()
			if err := p.bootstrap(wireAttach{Header: &wspb.TerminalAttach{Epoch: proto.Uint64(7), Oldest: proto.Uint64(50), Head: proto.Uint64(100)}}); err != nil {
				t.Fatalf("bootstrap across floor: %v", err)
			}
			if p.frontier != 110 || p.head != 110 || p.epoch != 7 {
				t.Fatalf("frontier/head/epoch = %d/%d/%d, want 110/110/7", p.frontier, p.head, p.epoch)
			}
			if p.frame.Cols != 120 || p.frame.Rows != 30 {
				t.Fatalf("restored frame = %dx%d, want current pane geometry 120x30", p.frame.Cols, p.frame.Rows)
			}
		})
	}
}

func TestTUIBootstrapRejectsUnexplainedFrontierRegression(t *testing.T) {
	p := &paneActor{epoch: 7, epochSet: true, frontier: 110}
	if err := p.bootstrap(wireAttach{Header: &wspb.TerminalAttach{Epoch: proto.Uint64(7), Oldest: proto.Uint64(50), Head: proto.Uint64(100)}}); !errors.Is(err, errProtocol) {
		t.Fatalf("bootstrap with regressed head = %v, want errProtocol", err)
	}
}

func TestTUIRecoverAcrossFloorHealsFromLiveState(t *testing.T) {
	ctx := t.Context()
	live, err := termemu.NewGhostty(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Skip(err)
	}
	defer live.Close()
	snapshot := ghosttySnapshot(t, ctx)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("through") == "latest" {
			writeFramed(t, w, wireproto.AttachHeadHeader{
				Epoch: 7, Oldest: 50, Head: 100,
				Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: 100, Cols: 80, Rows: 24, Len: len(snapshot)},
			}, snapshot)
			return
		}
		http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
	}))
	defer srv.Close()
	p := &paneActor{emu: live, api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, ctx: ctx, epoch: 7, epochSet: true, frontier: 5}
	if err := p.recover(ctx, 5, 90, false, ""); err != nil {
		t.Fatalf("recover across floor: %v", err)
	}
	p.mu.Lock()
	frontier := p.frontier
	p.mu.Unlock()
	if frontier != 100 {
		t.Fatalf("frontier = %d, want 100", frontier)
	}
	frame, err := live.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range frame.Cells {
		for _, cell := range row {
			if cell.Text == "H" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("healed screen not installed in the live emulator")
	}
}

func TestTUIFrameHealDoesNotRefeedAdoptedCheckpoint(t *testing.T) {
	ctx := t.Context()
	live, err := termemu.NewGhostty(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Skip(err)
	}
	defer live.Close()
	snapshot := ghosttySnapshot(t, ctx)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("through") == "latest" {
			writeFramed(t, w, wireproto.AttachHeadHeader{
				Epoch: 7, Oldest: 50, Head: 100,
				Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: 100, Cols: 80, Rows: 24, Len: len(snapshot)},
			}, snapshot)
			return
		}
		http.Error(w, "from is beyond the pane head", http.StatusBadRequest)
	}))
	defer srv.Close()
	p := &paneActor{emu: live, api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, ctx: ctx, epoch: 7, epochSet: true, frontier: 5}
	// The gap heals to head 100, ahead of this queued frame: the frame
	// must drop without re-feeding or moving the frontier backward.
	if err := p.handleFrame(testOutput(t, 90, []byte("QQQQQ"))); err != nil {
		t.Fatalf("handleFrame across heal: %v", err)
	}
	p.mu.Lock()
	frontier := p.frontier
	p.mu.Unlock()
	if frontier != 100 {
		t.Fatalf("frontier = %d, want 100 (adopted checkpoint)", frontier)
	}
	frame, err := live.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range frame.Cells {
		for _, cell := range row {
			if cell.Text == "Q" {
				t.Fatal("queued frame re-fed bytes already in the adopted checkpoint")
			}
		}
	}
}

func TestTUIHistoryClampsToFloorAndQuietsExpiredBooks(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	live, err := termemu.NewGhostty(termemu.Options{Cols: 80, Rows: 24, ScrollbackBytes: 64 << 20, ScrollbackLines: 10000})
	if err != nil {
		t.Skip(err)
	}
	defer live.Close()
	snapshot := ghosttySnapshot(t, t.Context())
	var stateThrough atomic.Uint64
	var afterCursor atomic.Value
	afterCursor.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "" && len(r.URL.Path) > 0 && r.URL.Query().Get("through") != "latest" && r.URL.Path[len(r.URL.Path)-6:] == "/state" {
			through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
			stateThrough.Store(through)
			writeFramed(t, w, wireproto.AttachHeadHeader{
				Epoch: 7, Oldest: 990, Head: through,
				Ckpt: &wireproto.CheckpointHeader{Kind: "ghostty-ready-v1", Through: through, Cols: 80, Rows: 24, Len: len(snapshot), EventCursor: "v1.7.990.2"},
			}, snapshot)
			return
		}
		afterCursor.Store(r.URL.Query().Get("after_event_cursor"))
		from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
		through, _ := strconv.ParseUint(r.URL.Query().Get("through"), 10, 64)
		writeFramed(t, w, wireproto.RecordingHeader{Epoch: 7, Start: from, End: through}, make([]byte, through-from))
	}))
	defer srv.Close()

	// A book at or below the floor requests nothing and raises no error.
	quiet := &paneActor{emu: live, api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, ctx: ctx, epoch: 7, epochSet: true, frontier: 90, oldest: 100, histories: make(chan historyResult, 1)}
	quiet.requestHistory()
	if quiet.historyPending {
		t.Fatal("expired book started a request")
	}

	// A clamped book starts at the floor and carries the state cursor.
	p := &paneActor{emu: live, api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}, ctx: ctx, epoch: 7, epochSet: true, frontier: 1000, oldest: 990, histories: make(chan historyResult, 4)}
	p.requestHistory()
	if !p.historyPending {
		t.Fatal("clamped book started no request")
	}
	select {
	case result := <-p.histories:
		if result.err != nil {
			t.Fatalf("clamped book failed: %v", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("clamped book never answered")
	}
	if got := stateThrough.Load(); got != 990 {
		t.Fatalf("state through = %d, want clamped 990", got)
	}
	if got := afterCursor.Load().(string); got != "v1.7.990.2" {
		t.Fatalf("after_event_cursor = %q, want the state cursor", got)
	}
}
