package phic

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// TestPaneRAMRecovery holds a replay response behind a barrier and proves
// that the actor keeps working: input and resize reach the child, the
// last good frame stays on screen, one worker fetches pages, a stale
// generation cannot mutate the replacement parser, and an exit cancels
// refresh work without admitting new PTY traffic.
func TestPaneRAMRecovery(t *testing.T) {
	t.Run("bootstrap keeps input and resize live behind a held page", func(t *testing.T) {
		var mu sync.Mutex
		inflight, maxInflight := 0, 0
		held, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		f := newWindowFixture(t, floorAttach(), func(w http.ResponseWriter, q url.Values) {
			mu.Lock()
			inflight++
			maxInflight = max(maxInflight, inflight)
			mu.Unlock()
			once.Do(func() { close(held) })
			<-release
			mu.Lock()
			inflight--
			mu.Unlock()
			writeReplayFixture(w, floorPage(5, 11), []byte("abcdef"))
		})
		p, ev := startNativePane(t, f.srv.URL, 80, 24)
		select {
		case <-held:
		case <-time.After(5 * time.Second):
			t.Fatal("replay page never started")
		}
		// Both must reach the child while the page response is still held.
		p.sendRaw([]byte("typed"))
		f.waitFrameWithin(t, 2*time.Second, func(fr *wspb.TerminalClientFrame) bool {
			return string(fr.GetInput()) == "typed"
		})
		p.resize(100, 30)
		f.waitFrameWithin(t, 2*time.Second, func(fr *wspb.TerminalClientFrame) bool {
			r := fr.GetResize()
			return r != nil && r.GetCols() == 100 && r.GetRows() == 30
		})
		close(release)
		waitPaneEvent(t, ev, paneStatus)
		frame, ok := p.snapshotCopy()
		if !ok || !strings.Contains(frameText(frame), "abcdef") {
			t.Fatalf("floor replay missing: %q", frameText(frame))
		}
		if frontier, _, _, _, _, _ := p.state(); frontier != 11 {
			t.Fatalf("frontier=%d, want 11", frontier)
		}
		mu.Lock()
		defer mu.Unlock()
		if maxInflight != 1 {
			t.Fatalf("concurrent replay pages=%d, want one fetch worker", maxInflight)
		}
	})

	t.Run("live gap repair keeps the last frame and admits input", func(t *testing.T) {
		held, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		f := newWindowFixture(t, floorAttach(), func(w http.ResponseWriter, q url.Values) {
			if q.Get("through") == "latest" {
				once.Do(func() { close(held) })
				<-release
				writeReplayFixture(w, wireproto.ReplayHeader{
					Epoch: 7, Start: 11, End: 25, Through: 25,
					ThroughCursor: "v1.7.25.0", EventCursor: "v1.7.25.0", InitCols: 80, InitRows: 24,
				}, []byte("REPAIRED-DATA!"))
				return
			}
			writeReplayFixture(w, floorPage(5, 11), []byte("abcdef"))
		})
		p, ev := startNativePane(t, f.srv.URL, 80, 24)
		waitPaneEvent(t, ev, paneStatus)
		f.push(t, outputFrame(t, 25, "TAIL"))
		select {
		case <-held:
		case <-time.After(5 * time.Second):
			t.Fatal("gap repair never started")
		}
		p.sendRaw([]byte("during-gap"))
		f.waitFrameWithin(t, 2*time.Second, func(fr *wspb.TerminalClientFrame) bool {
			return string(fr.GetInput()) == "during-gap"
		})
		// The last good frame stays visible while the missing range loads.
		if frame, ok := p.snapshotCopy(); !ok || !strings.Contains(frameText(frame), "abcdef") {
			t.Fatalf("last good frame lost during repair: %q", frameText(frame))
		}
		close(release)
		deadline := time.After(3 * time.Second)
		for {
			frame, ok := p.snapshotCopy()
			if ok && strings.Contains(frameText(frame), "REPAIRED-DATA!") && strings.Contains(frameText(frame), "TAIL") {
				break
			}
			select {
			case <-deadline:
				t.Fatalf("repair did not render: %q", frameText(frame))
			case <-time.After(5 * time.Millisecond):
			}
		}
		if frontier, _, _, _, _, _ := p.state(); frontier != 29 {
			t.Fatalf("frontier=%d, want 29", frontier)
		}
	})

	t.Run("exit cancels refresh and admits no new PTY traffic", func(t *testing.T) {
		f := newWindowFixture(t, refreshAttach(11), func(w http.ResponseWriter, q url.Values) {
			if q.Get("through") != "latest" {
				http.Error(w, "history must not restart after exit", http.StatusConflict)
				return
			}
			writeReplayFixture(w, wireproto.ReplayHeader{
				Epoch: 7, Start: 11, End: 11, Through: 11,
				ThroughCursor: "v1.7.11.0", EventCursor: "v1.7.11.0", InitCols: 80, InitRows: 24,
			}, nil)
		})
		p, ev := startNativePane(t, f.srv.URL, 80, 24)
		resize := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
			return fr.GetResize() != nil && fr.GetResize().GetRefreshRequestId() != ""
		})
		id := resize.GetResize().GetRefreshRequestId()
		f.push(t, outputFrame(t, 11, "KEEP-ME"))
		deadline := time.After(3 * time.Second)
		for {
			if frame, ok := p.snapshotCopy(); ok && strings.Contains(frameText(frame), "KEEP-ME") {
				break
			}
			select {
			case <-deadline:
				t.Fatal("pre-exit frame never painted")
			case <-time.After(5 * time.Millisecond):
			}
		}
		f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Exit{Exit: &wspb.TerminalExit{Code: proto.Int32(7)}}})
		if exit := waitPaneEvent(t, ev, paneExited); exit.Code != 7 {
			t.Fatalf("exit code=%d, want 7", exit.Code)
		}
		<-p.done
		f.drainPages() // the finite exit drain already ran
		p.sendRaw([]byte("after-exit"))
		p.resize(120, 40)
		f.drainFrames()
		f.noFrameWithin(t, 150*time.Millisecond)
		if f.connections() != 1 {
			t.Fatalf("connections=%d, a dead pane must not reconnect", f.connections())
		}
		// A late receipt cannot reopen the pane or start a fallback read.
		f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
			RefreshResult: &wspb.TerminalRefreshResult{RequestId: proto.String(id), Outcome: wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum()},
		}})
		f.noPage(t, 150*time.Millisecond)
		if frame, ok := p.snapshotCopy(); !ok || !strings.Contains(frameText(frame), "KEEP-ME") {
			t.Fatalf("last frame lost on exit: %q", frameText(frame))
		}
	})

	t.Run("a cancelled generation page cannot mutate the replacement parser", func(t *testing.T) {
		held, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		var requests atomic.Int32
		f := newWindowFixture(t, floorAttach(), func(w http.ResponseWriter, q url.Values) {
			if requests.Add(1) == 1 {
				once.Do(func() { close(held) })
				<-release
				writeReplayFixture(w, floorPage(5, 11), []byte("STALE!"))
				return
			}
			writeReplayFixture(w, floorPage(5, 11), []byte("FRESH!"))
		})
		api := mustAPI(t, f.srv.URL)
		api.http.Timeout = 200 * time.Millisecond
		p, ev := startNativePaneWith(t, api, 80, 24)
		select {
		case <-held:
		case <-time.After(5 * time.Second):
			t.Fatal("first page never started")
		}
		waitPaneEvent(t, ev, paneStatus)
		close(release)
		// The stale body arrives after its generation was replaced.
		deadline := time.After(3 * time.Second)
		for requests.Load() < 2 {
			select {
			case <-deadline:
				t.Fatal("replacement generation never fetched")
			case <-time.After(5 * time.Millisecond):
			}
		}
		time.Sleep(150 * time.Millisecond)
		frame, ok := p.snapshotCopy()
		if !ok || strings.Contains(frameText(frame), "STALE") || !strings.Contains(frameText(frame), "FRESH") {
			t.Fatalf("stale generation reached the parser: %q", frameText(frame))
		}
		if f.connections() != 2 {
			t.Fatalf("connections=%d, want exactly one reconnect", f.connections())
		}
	})

	t.Run("hold overflow discards the whole uncertain tail", func(t *testing.T) {
		for _, payload := range []string{"x", strings.Repeat("x", 64<<10)} {
			p := &paneActor{}
			for i := 0; ; i++ {
				raw, err := wireproto.EncodeOutputFrame(uint64(i*len(payload)), []byte(payload))
				if err != nil {
					t.Fatal(err)
				}
				err = p.holdFrame(raw)
				if err != nil {
					if err != errHeldOverflow {
						t.Fatal(err)
					}
					break
				}
			}
			if len(p.held) > paneHeldSpans || p.heldBytes > paneHeldBytes {
				t.Fatal("hold exceeded its budget")
			}
			if p.flushHeld() != errHeldOverflow || len(p.held) != 0 || p.heldBytes != 0 {
				t.Fatal("uncertain tail was not discarded")
			}
		}
	})
}

func TestExitDuringReplaySurvivesSocketCloseAndMissingTail(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "finite tail", true: "archive unavailable"}[missing], func(t *testing.T) {
			held, release := make(chan struct{}), make(chan struct{})
			f := newWindowFixture(t, floorAttach(), func(w http.ResponseWriter, q url.Values) {
				if q.Get("through") == "latest" {
					if missing {
						http.NotFound(w, nil)
						return
					}
					h := floorPage(11, 15)
					writeReplayFixture(w, h, []byte("TAIL"))
					return
				}
				close(held)
				<-release
				writeReplayFixture(w, floorPage(5, 11), []byte("abcdef"))
			})
			p, ev := startNativePane(t, f.srv.URL, 80, 24)
			<-held
			f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Exit{Exit: &wspb.TerminalExit{Code: proto.Int32(23)}}})
			deadline := time.After(3 * time.Second)
			for {
				if _, _, _, exited, _, _ := p.state(); exited {
					break
				}
				select {
				case <-deadline:
					t.Fatal("exit was not admitted during the held read")
				case <-time.After(time.Millisecond):
				}
			}
			f.writeMu <- struct{}{}
			_ = f.ws.Close()
			<-f.writeMu
			p.sendRaw([]byte("must-not-send"))
			p.resize(120, 40)
			close(release)
			if exit := waitPaneEvent(t, ev, paneExited); exit.Code != 23 {
				t.Fatalf("lost original exit: %+v", exit)
			}
			<-p.done
			if f.connections() != 1 {
				t.Fatal("dead pane reconnected")
			}
			frame, ok := p.snapshotCopy()
			if !ok || !strings.Contains(frameText(frame), "abcdef") || (!missing && !strings.Contains(frameText(frame), "TAIL")) {
				t.Fatalf("final frame=%q", frameText(frame))
			}
			for len(f.frames) > 0 {
				if frame := <-f.frames; frame.GetInput() != nil || frame.GetResize() != nil {
					t.Fatalf("traffic after exit: %v", frame)
				}
			}
			for len(ev) > 0 {
				if e := <-ev; e.Kind == paneExited {
					t.Fatal("duplicate exit")
				}
			}
		})
	}
}

func TestNativeRecoveryBudgetDoesNotRenewAfterExpiry(t *testing.T) {
	p := &paneActor{recoveryUntil: time.Now().Add(-time.Second), recoveryAttempts: 1}
	deadline := p.recoveryUntil
	p.beginRecovery()
	if p.recoveryUntil != deadline || !p.recoveryExhausted() || p.canFastPath(refreshAttach(11)) {
		t.Fatal("expired episode was renewed")
	}
	p.refreshID, p.attachHead = "1", 11
	if err := p.handleRefreshResult(&wspb.TerminalRefreshResult{RequestId: proto.String("1"), Outcome: wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum()}); err != nil {
		t.Fatal(err)
	}
	if p.refreshID == "" || p.recoveryUntil != deadline {
		t.Fatal("DISPATCHED completed an unpainted refresh")
	}
	p.frontier = 12
	p.completeRefresh()
	if p.refreshID != "" || !p.recoveryUntil.IsZero() {
		t.Fatal("usable output did not finish the episode")
	}
}

func floorAttach() *wspb.TerminalAttach {
	a := refreshAttach(11)
	a.TerminalRefreshAvailable = proto.Bool(false)
	return a
}

func floorPage(start, end uint64) wireproto.ReplayHeader {
	cursor := (replayPosition{7, end, 0}).String()
	return wireproto.ReplayHeader{
		Epoch: 7, Start: start, End: end, Through: end,
		ThroughCursor: cursor, EventCursor: cursor, InitCols: 80, InitRows: 24,
	}
}

func outputFrame(t *testing.T, start uint64, data string) *wspb.TerminalServerFrame {
	t.Helper()
	return &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Output{
		Output: &wspb.TerminalOutput{Start: proto.Uint64(start), Data: []byte(data)},
	}}
}

// drainPages removes pages that belong to work already observed.
func (f *windowFixture) drainPages() {
	for {
		select {
		case <-f.pages:
		default:
			return
		}
	}
}

// drainFrames removes frames that arrived before a negative assertion.
func (f *windowFixture) drainFrames() {
	for {
		select {
		case <-f.frames:
		default:
			return
		}
	}
}

func (f *windowFixture) noFrameWithin(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case frame := <-f.frames:
		t.Fatalf("unexpected client frame after exit: %v", frame)
	case <-time.After(d):
	}
}
