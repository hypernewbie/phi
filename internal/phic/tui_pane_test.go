package phic

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/internal/termemu/stub"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

func stubBuild(o termemu.Options) (termemu.Terminal, error) { return stub.New(o) }

// frameText flattens a copied frame into trimmed row text for assertions.
func frameText(frame termemu.Frame) string {
	var rows []string
	for _, row := range frame.Cells {
		var b strings.Builder
		for _, c := range row {
			if c.Width == 0 {
				continue
			}
			if c.Text == "" {
				b.WriteByte(' ')
			} else {
				b.WriteString(c.Text)
			}
		}
		rows = append(rows, strings.TrimRight(b.String(), " "))
	}
	return strings.TrimRight(strings.Join(rows, "\n"), "\n")
}

// waitFor polls a condition with a deadline so tests never hang on a slow
// actor without reporting why.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitPaneEvent(t *testing.T, events <-chan paneEvent, kind paneEventKind) paneEvent {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Kind == kind {
				return ev
			}
		case <-deadline:
			t.Fatalf("no pane event kind %d", kind)
		}
	}
}

// TestPaneActorAttachLiveInputExit drives one actor through the complete
// lifecycle: attach head, live output, encoded input, and exit drain.
func TestPaneActorAttachLiveInputExit(t *testing.T) {
	source := []byte("hello pane\n")
	up := websocket.Upgrader{}
	inputs := make(chan string, 16)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, source))
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) == 0 || msg[0] != wireproto.FrameInput {
				continue
			}
			payload := string(msg[1:])
			inputs <- payload
			if payload == "a" {
				_ = ws.WriteMessage(websocket.BinaryMessage, []byte{wireproto.FrameExit, 0})
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	events := make(chan paneEvent, 256)
	actor, err := newPaneActor(ctx, mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 40, Rows: 8}, events, stubBuild)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()

	waitPaneEvent(t, events, paneOutput)
	waitFor(t, "live output in the copied frame", func() bool {
		frame, ok := actor.snapshotCopy()
		return ok && strings.Contains(frameText(frame), "hello pane")
	})

	actor.sendKey(termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Text: "a", Unshifted: 'a'})
	select {
	case got := <-inputs:
		if got != "a" {
			t.Fatalf("input bytes = %q, want %q", got, "a")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no input frame arrived")
	}

	ev := waitPaneEvent(t, events, paneExited)
	if ev.Code != 0 {
		t.Fatalf("exit code = %d, want 0", ev.Code)
	}
	// The exit drain keeps the final frame visible.
	if frame, ok := actor.snapshotCopy(); !ok || !strings.Contains(frameText(frame), "hello pane") {
		t.Fatal("frame lost after exit drain")
	}
}

// TestPaneActorEncodesInputOnOwnerGoroutine scripts the stub encoder so the
// exact bytes prove encoding happens inside the actor, not the UI.
func TestPaneActorEncodesInputOnOwnerGoroutine(t *testing.T) {
	up := websocket.Upgrader{}
	var mu sync.Mutex
	var frames [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			mu.Lock()
			frames = append(frames, append([]byte{}, msg...))
			mu.Unlock()
		}
	}))
	defer srv.Close()

	built := make(chan *stub.Terminal, 1)
	build := func(o termemu.Options) (termemu.Terminal, error) {
		st, err := stub.New(o)
		if err != nil {
			return nil, err
		}
		st.KeyFn = func(ev termemu.KeyEvent) []byte { return []byte("K" + ev.Text) }
		st.MouseFn = func(a termemu.MouseAction, b termemu.MouseButton, m termemu.Modifier, x, y int) []byte {
			return []byte{byte(a), byte(b), byte(x), byte(y)}
		}
		st.Modes[termemu.ModeMouseButton] = true
		select {
		case built <- st:
		default:
		}
		return st, nil
	}

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	events := make(chan paneEvent, 256)
	actor, err := newPaneActor(ctx, mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 40, Rows: 8}, events, build)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()
	<-built
	waitPaneEvent(t, events, paneStatus)

	actor.sendKey(termemu.KeyEvent{Action: termemu.KeyPress, Key: termemu.KeyRune, Text: "q", Unshifted: 'q'})
	actor.sendPaste([]byte("past"))
	actor.sendMouse(termemu.MousePress, termemu.MouseLeft, 0, 3, 2)
	actor.resize(60, 20)

	waitFor(t, "encoded key, paste, mouse, and resize frames", func() bool {
		mu.Lock()
		defer mu.Unlock()
		var key, paste, mouse, resize bool
		for _, f := range frames {
			if len(f) == 0 {
				continue
			}
			payload := string(f[1:])
			switch f[0] {
			case wireproto.FrameInput:
				switch {
				case payload == "Kq":
					key = true
				case payload == "\x1b[200~past\x1b[201~":
					paste = true
				case len(payload) == 4 && payload[0] == byte(termemu.MousePress) && payload[1] == byte(termemu.MouseLeft) && payload[2] == 3 && payload[3] == 2:
					mouse = true
				}
			case wireproto.FrameResize:
				resize = len(f) >= 5
			}
		}
		return key && paste && mouse && resize
	})
}

// TestPaneActorMouseOwnershipCache proves the UI-visible mouse flag comes from
// a cached owner snapshot and never queries the emulator off-owner.
func TestPaneActorMouseOwnershipCache(t *testing.T) {
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/pane/p" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeAttachHeadFrame(wireproto.AttachHeadHeader{Epoch: 7, Head: 0}, nil))
		_ = ws.WriteMessage(websocket.BinaryMessage, wireproto.EncodeLiveOutputFrame(0, []byte("m")))
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	build := func(o termemu.Options) (termemu.Terminal, error) {
		st, err := stub.New(o)
		if err != nil {
			return nil, err
		}
		st.Modes[termemu.ModeMouseMotion] = true
		return st, nil
	}
	events := make(chan paneEvent, 64)
	actor, err := newPaneActor(ctx, mustAPI(t, srv.URL), paneSpec{Key: paneKey{Origin: srv.URL, ID: "p"}, Cols: 40, Rows: 8}, events, build)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.close()
	waitPaneEvent(t, events, paneOutput)
	waitFor(t, "mouse ownership cache", actor.mouseOwned)
}
