package phic

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// windowFixture serves one attach and records every replay request, so a
// test can assert which reads happened and in what order.
type windowFixture struct {
	srv     *httptest.Server
	frames  chan *wspb.TerminalClientFrame
	pages   chan url.Values
	ws      *websocket.Conn
	writeMu chan struct{}
	mu      sync.Mutex
	conns   int
	// Tests set this before starting the actor to certify a newer reconnect head.
	nextAttach *wspb.TerminalAttach
}

func (f *windowFixture) connections() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conns
}

func newWindowFixture(t *testing.T, attach *wspb.TerminalAttach, handle func(w http.ResponseWriter, q url.Values)) *windowFixture {
	t.Helper()
	f := &windowFixture{
		frames:  make(chan *wspb.TerminalClientFrame, 64),
		pages:   make(chan url.Values, 64),
		writeMu: make(chan struct{}, 1),
	}
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/replay") {
			q := r.URL.Query()
			select {
			case f.pages <- q:
			default:
			}
			handle(w, q)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		f.mu.Lock()
		f.conns++
		header := attach
		if f.conns > 1 && f.nextAttach != nil {
			header = f.nextAttach
		}
		f.mu.Unlock()
		raw, err := wireproto.EncodeAttachFrame(header)
		if err != nil {
			return
		}
		// Publish the connection only once the attach write finished, so a
		// test push can never interleave with the first server frame.
		f.writeMu <- struct{}{}
		f.ws = ws
		err = ws.WriteMessage(websocket.BinaryMessage, raw)
		<-f.writeMu
		if err != nil {
			return
		}
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			frame, derr := wireproto.DecodeClientFrame(data)
			if derr != nil {
				continue
			}
			select {
			case f.frames <- frame:
			default:
			}
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// push writes one server frame to the current connection.
func (f *windowFixture) push(t *testing.T, payload *wspb.TerminalServerFrame) {
	t.Helper()
	raw, err := proto.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	f.writeMu <- struct{}{}
	defer func() { <-f.writeMu }()
	if f.ws == nil {
		t.Fatal("no websocket connection")
	}
	// A late frame may race a closing connection; that is the caller's
	// assertion to make, not a fixture failure.
	_ = f.ws.WriteMessage(websocket.BinaryMessage, raw)
}

func (f *windowFixture) waitFrame(t *testing.T, pred func(*wspb.TerminalClientFrame) bool) *wspb.TerminalClientFrame {
	return f.waitFrameWithin(t, 5*time.Second, pred)
}

func (f *windowFixture) waitFrameWithin(t *testing.T, d time.Duration, pred func(*wspb.TerminalClientFrame) bool) *wspb.TerminalClientFrame {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case frame := <-f.frames:
			if pred(frame) {
				return frame
			}
		case <-deadline:
			t.Fatal("expected client frame did not arrive")
		}
	}
}

func (f *windowFixture) waitPage(t *testing.T) url.Values {
	t.Helper()
	select {
	case q := <-f.pages:
		return q
	case <-time.After(5 * time.Second):
		t.Fatal("expected replay page did not arrive")
		return nil
	}
}

func (f *windowFixture) noPage(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case q := <-f.pages:
		t.Fatalf("unexpected replay page: %v", q)
	case <-time.After(d):
	}
}

func startNativePane(t *testing.T, base string, cols, rows int) (*paneActor, chan paneEvent) {
	t.Helper()
	return startNativePaneWith(t, mustAPI(t, base), cols, rows)
}

func startNativePaneWith(t *testing.T, api *apiClient, cols, rows int) (*paneActor, chan paneEvent) {
	t.Helper()
	ev := make(chan paneEvent, 64)
	p, err := newPaneActor(t.Context(), api, paneSpec{Key: paneKey{Origin: api.base.String(), ID: "p"}, Cols: cols, Rows: rows}, ev, termemu.NewGhostty)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.close)
	return p, ev
}

func refreshAttach(head uint64) *wspb.TerminalAttach {
	return &wspb.TerminalAttach{
		Epoch: proto.Uint64(7), Oldest: proto.Uint64(5), Head: proto.Uint64(head),
		InitialCols: proto.Uint32(80), InitialRows: proto.Uint32(24),
		FloorCols: proto.Uint32(80), FloorRows: proto.Uint32(24),
		HeadCols: proto.Uint32(80), HeadRows: proto.Uint32(24),
		EventCursor:              proto.String((replayPosition{7, head, 0}).String()),
		FloorEventCursor:         proto.String("v1.7.5.0"),
		TerminalRefreshAvailable: proto.Bool(true),
	}
}

func TestNativeBoundedWindowStartsAtTheCertifiedFloor(t *testing.T) {
	attach := refreshAttach(11)
	attach.TerminalRefreshAvailable = proto.Bool(false)
	f := newWindowFixture(t, attach, func(w http.ResponseWriter, q url.Values) {
		if q.Get("from") != "5" {
			http.Error(w, "below the floor", http.StatusConflict)
			return
		}
		writeReplayFixture(w, wireproto.ReplayHeader{
			Epoch: 7, Start: 5, End: 11, Through: 11,
			ThroughCursor: "v1.7.11.0", EventCursor: "v1.7.11.0", InitCols: 80, InitRows: 24,
		}, []byte("abcdef"))
	})
	p, ev := startNativePane(t, f.srv.URL, 80, 24)
	waitPaneEvent(t, ev, paneStatus)
	if q := f.waitPage(t); q.Get("from") != "5" || q.Get("after_event_cursor") != "v1.7.5.0" {
		t.Fatalf("first page below the floor: %v", q)
	}
	frame, ok := p.snapshotCopy()
	if !ok || !strings.Contains(frameText(frame), "abcdef") {
		t.Fatalf("floor replay missing: %q", frameText(frame))
	}
	f.noPage(t, 150*time.Millisecond)
}

func TestNativeRefreshDispatchedSkipsHistoryReplay(t *testing.T) {
	attach := refreshAttach(11)
	f := newWindowFixture(t, attach, func(w http.ResponseWriter, q url.Values) {
		http.Error(w, "history must not be read", http.StatusInternalServerError)
	})
	p, ev := startNativePane(t, f.srv.URL, 80, 24)
	resize := f.waitFrame(t, func(frame *wspb.TerminalClientFrame) bool {
		return frame.GetResize() != nil && frame.GetResize().GetRefreshRequestId() != ""
	})
	id := resize.GetResize().GetRefreshRequestId()
	if strings.HasPrefix(id, "0") || id == "" {
		t.Fatalf("request id is not canonical: %q", id)
	}
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{RequestId: proto.String(id), Outcome: wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum()},
	}})
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Output{
		Output: &wspb.TerminalOutput{Start: proto.Uint64(11), Data: []byte("repainted")},
	}})
	waitPaneEvent(t, ev, paneStatus)
	deadline := time.After(3 * time.Second)
	for {
		if frame, ok := p.snapshotCopy(); ok && strings.Contains(frameText(frame), "repainted") {
			break
		}
		select {
		case <-deadline:
			frame, _ := p.snapshotCopy()
			t.Fatalf("repaint not painted: %q", frameText(frame))
		case <-time.After(10 * time.Millisecond):
		}
	}
	f.noPage(t, 150*time.Millisecond)
}

func TestNativeRefreshNotSentFallsBackExactlyOnce(t *testing.T) {
	attach := refreshAttach(11)
	var pages int
	var mu chan struct{} = make(chan struct{}, 1)
	mu <- struct{}{}
	f := newWindowFixture(t, attach, func(w http.ResponseWriter, q url.Values) {
		<-mu
		pages++
		mu <- struct{}{}
		writeReplayFixture(w, wireproto.ReplayHeader{
			Epoch: 7, Start: 5, End: 11, Through: 11,
			ThroughCursor: "v1.7.11.0", EventCursor: "v1.7.11.0", InitCols: 80, InitRows: 24,
		}, []byte("abcdef"))
	})
	p, ev := startNativePane(t, f.srv.URL, 80, 24)
	resize := f.waitFrame(t, func(frame *wspb.TerminalClientFrame) bool {
		return frame.GetResize() != nil && frame.GetResize().GetRefreshRequestId() != ""
	})
	id := resize.GetResize().GetRefreshRequestId()
	receipt := &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{RequestId: proto.String(id), Outcome: wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT.Enum(), Reason: proto.String("pending")},
	}}
	f.push(t, receipt)
	waitPaneEvent(t, ev, paneStatus)
	if q := f.waitPage(t); q.Get("from") != "5" {
		t.Fatalf("fallback did not start at the floor: %v", q)
	}
	deadline := time.After(3 * time.Second)
	for {
		if frame, ok := p.snapshotCopy(); ok && strings.Contains(frameText(frame), "abcdef") {
			break
		}
		select {
		case <-deadline:
			t.Fatal("fallback replay did not reach the screen")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// A duplicate receipt changes nothing and never starts a second read.
	f.push(t, receipt)
	f.noPage(t, 200*time.Millisecond)
	<-mu
	if pages != 1 {
		t.Fatalf("history pages=%d, want 1", pages)
	}
}

func TestNativeRefreshFallbackReplaysMarkerOnlyHead(t *testing.T) {
	attach := refreshAttach(0)
	attach.Oldest = proto.Uint64(0)
	attach.FloorEventCursor = proto.String("v1.7.0.0")
	attach.EventCursor = proto.String("v1.7.0.1")
	attach.HeadCols, attach.HeadRows = proto.Uint32(100), proto.Uint32(30)
	started := make(chan url.Values, 1)
	release := make(chan struct{})
	f := newWindowFixture(t, attach, func(w http.ResponseWriter, q url.Values) {
		started <- q
		<-release
		writeReplayFixture(w, wireproto.ReplayHeader{
			Epoch: 7, Start: 0, End: 0, Through: 0,
			ThroughCursor: "v1.7.0.1", EventCursor: "v1.7.0.1",
			InitCols: 80, InitRows: 24,
			Resizes: [][3]uint64{{0, 100, 30}},
		}, nil)
	})
	p, ev := startNativePane(t, f.srv.URL, 80, 24)
	resize := f.waitFrame(t, func(frame *wspb.TerminalClientFrame) bool {
		return frame.GetResize() != nil && frame.GetResize().GetRefreshRequestId() != ""
	})
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{
			RequestId: resize.GetResize().RefreshRequestId,
			Outcome:   wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT.Enum(),
			Reason:    proto.String("unavailable"),
		},
	}})
	select {
	case q := <-started:
		if q.Get("from") != "0" || q.Get("through") != "0" || q.Get("after_event_cursor") != "v1.7.0.0" {
			t.Fatalf("marker-only fallback request: %v", q)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("zero-byte attach skipped its resize timeline")
	}
	close(release)
	waitPaneEvent(t, ev, paneOutput)
	frame, ok := p.snapshotCopy()
	if !ok || frame.Cols != 100 || frame.Rows != 30 {
		t.Fatalf("fallback geometry = %dx%d, want 100x30", frame.Cols, frame.Rows)
	}
}

func TestNativeInputStaysLiveDuringReplay(t *testing.T) {
	attach := refreshAttach(11)
	attach.TerminalRefreshAvailable = proto.Bool(false)
	release := make(chan struct{})
	f := newWindowFixture(t, attach, func(w http.ResponseWriter, q url.Values) {
		<-release
		writeReplayFixture(w, wireproto.ReplayHeader{
			Epoch: 7, Start: 5, End: 11, Through: 11,
			ThroughCursor: "v1.7.11.0", EventCursor: "v1.7.11.0", InitCols: 80, InitRows: 24,
		}, []byte("abcdef"))
	})
	p, _ := startNativePane(t, f.srv.URL, 80, 24)
	f.waitPage(t)
	p.sendRaw([]byte("typed"))
	f.waitFrame(t, func(frame *wspb.TerminalClientFrame) bool {
		return string(frame.GetInput()) == "typed"
	})
	close(release)
}

func TestParseReplayWindowRejectsUncertifiedMetadata(t *testing.T) {
	valid := `{"epoch":7,"oldest":5,"head":11,"floor_cols":80,"floor_rows":24,"head_cols":80,"head_rows":24,"floor_event_cursor":"v1.7.5.0","event_cursor":"v1.7.11.0"}`
	if _, ok := parseReplayWindow(valid, 7); !ok {
		t.Fatal("valid window rejected")
	}
	for name, raw := range map[string]string{
		"wrong epoch":     strings.Replace(valid, `"epoch":7`, `"epoch":9`, 1),
		"bad cursor":      strings.Replace(valid, "v1.7.11.0", "v1.9.11.0", 1),
		"floor past head": strings.Replace(valid, `"oldest":5`, `"oldest":12`, 1),
		"empty grid":      strings.Replace(valid, `"head_cols":80`, `"head_cols":0`, 1),
		"garbage":         "not json",
	} {
		if _, ok := parseReplayWindow(raw, 7); ok {
			t.Fatalf("%s accepted", name)
		}
	}
}
