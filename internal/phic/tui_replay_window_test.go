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
		f.mu.Unlock()
		raw, err := wireproto.EncodeAttachFrame(attach)
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

func windowAttach(head uint64) *wspb.TerminalAttach {
	return &wspb.TerminalAttach{
		Epoch: proto.Uint64(7), Oldest: proto.Uint64(5), Head: proto.Uint64(head),
		InitialCols: proto.Uint32(80), InitialRows: proto.Uint32(24),
		FloorCols: proto.Uint32(80), FloorRows: proto.Uint32(24),
		HeadCols: proto.Uint32(80), HeadRows: proto.Uint32(24),
		EventCursor:      proto.String("v1.7.11.0"),
		FloorEventCursor: proto.String("v1.7.5.0"),
	}
}

func TestNativeBoundedWindowStartsAtTheCertifiedFloor(t *testing.T) {
	attach := windowAttach(11)
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

func TestNativeInputStaysLiveDuringReplay(t *testing.T) {
	attach := windowAttach(11)
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
