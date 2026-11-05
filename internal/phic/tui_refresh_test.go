package phic

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/hypernewbie/phi/internal/termemu"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"google.golang.org/protobuf/proto"
)

func TestNativeRefreshFallbackPreservesConsumedTail(t *testing.T) {
	for _, failure := range []string{"not sent", "unknown", "missing receipt", "socket loss"} {
		t.Run(failure, func(t *testing.T) {
			f := newWindowFixture(t, refreshAttach(11), func(w http.ResponseWriter, q url.Values) {
				h := floorPage(5, 11)
				data := "abcdef"
				if q.Get("through") == "15" {
					h = floorPage(5, 15)
					h.EventCursor, h.ThroughCursor = "v1.7.15.1", "v1.7.15.1"
					h.Resizes = [][3]uint64{{15, 100, 30}}
					data += "LIVE"
				}
				writeReplayFixture(w, h, []byte(data))
			})
			f.nextAttach = refreshAttach(15)
			f.nextAttach.EventCursor = proto.String("v1.7.15.1")
			f.nextAttach.HeadCols, f.nextAttach.HeadRows = proto.Uint32(100), proto.Uint32(30)
			p, _ := startNativePane(t, f.srv.URL, 80, 24)
			request := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				return fr.GetResize().GetRefreshRequestId() != ""
			})
			f.push(t, outputFrame(t, 11, "LIVE"))
			f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Geometry{
				Geometry: &wspb.TerminalGeometry{
					AtSeq: proto.Uint64(15), EventCursor: proto.String("v1.7.15.1"),
					Cols: proto.Uint32(100), Rows: proto.Uint32(30),
				},
			}})
			waitFor(t, "live tail and geometry before fallback", func() bool {
				frame, ok := p.snapshotCopy()
				return ok && strings.Contains(frameText(frame), "LIVE") && frame.Cols == 100 && frame.Rows == 30
			})
			switch failure {
			case "not sent", "unknown":
				outcome := wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT
				if failure == "unknown" {
					outcome = wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_UNKNOWN
				}
				f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
					RefreshResult: &wspb.TerminalRefreshResult{
						RequestId: request.GetResize().RefreshRequestId, Outcome: outcome.Enum(),
					},
				}})
			case "socket loss":
				f.writeMu <- struct{}{}
				_ = f.ws.Close()
				<-f.writeMu
			}
			// An ordinary resize follows completed fallback. The input barrier
			// also proves that the actor finished painting and remains usable.
			f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				return fr.GetResize() != nil && fr.GetResize().GetRefreshRequestId() == ""
			})
			p.sendRaw([]byte("after-fallback"))
			f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				return string(fr.GetInput()) == "after-fallback"
			})
			frame, _ := p.snapshotCopy()
			frontier, _, _, _, _, _ := p.state()
			if frontier != 15 || frame.Cols != 100 || frame.Rows != 30 || strings.Count(frameText(frame), "abcdefLIVE") != 1 {
				t.Fatalf("fallback lost consumed output/geometry: frontier=%d grid=%dx%d screen=%q", frontier, frame.Cols, frame.Rows, frameText(frame))
			}
			if f.connections() != 2 {
				t.Fatalf("connections=%d, want one fresh fallback attach", f.connections())
			}
		})
	}
}

func TestNativeRefreshGapRepairCompletesRequest(t *testing.T) {
	f := newWindowFixture(t, refreshAttach(11), func(w http.ResponseWriter, q url.Values) {
		writeReplayFixture(w, floorPage(11, 19), []byte("LOSTTAIL"))
	})
	p, _ := startNativePane(t, f.srv.URL, 80, 24)
	request := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
		return fr.GetResize().GetRefreshRequestId() != ""
	})
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{
			RequestId: request.GetResize().RefreshRequestId,
			Outcome:   wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum(),
		},
	}})
	// Replay repairs both the missing prefix and this live frame. The
	// duplicate tail must not bypass completion of the repaint episode.
	f.push(t, outputFrame(t, 15, "TAIL"))
	waitFor(t, "repaired repaint bytes", func() bool {
		frame, _ := p.snapshotCopy()
		return frameText(frame) == "LOSTTAIL"
	})
	p.close() // join the actor before reading its private recovery state
	if !p.recoveryUntil.IsZero() || p.recoveryAttempts != 0 || p.fallbackNeeded {
		t.Fatalf("usable repaint retained its timeout/fallback: deadline=%v attempts=%d fallback=%v", p.recoveryUntil, p.recoveryAttempts, p.fallbackNeeded)
	}
}

func TestNativeRefreshKeepsLastFrameUntilOutput(t *testing.T) {
	f := newWindowFixture(t, refreshAttach(11), func(w http.ResponseWriter, q url.Values) {
		http.Error(w, "managed repaint must not read history", http.StatusInternalServerError)
	})
	f.nextAttach = refreshAttach(27)
	f.nextAttach.Oldest = proto.Uint64(21)
	f.nextAttach.FloorEventCursor = proto.String("v1.7.21.0")
	p, _ := startNativePane(t, f.srv.URL, 80, 24)
	first := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
		return fr.GetResize().GetRefreshRequestId() != ""
	})
	// Output before DISPATCHED must also complete a successful refresh.
	f.push(t, outputFrame(t, 11, "LAST-VIEW"))
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{
			RequestId: first.GetResize().RefreshRequestId,
			Outcome:   wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum(),
		},
	}})
	waitFor(t, "initial live frame", func() bool {
		frame, ok := p.snapshotCopy()
		return ok && strings.Contains(frameText(frame), "LAST-VIEW")
	})
	f.writeMu <- struct{}{}
	_ = f.ws.Close()
	<-f.writeMu
	second := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
		return fr.GetResize().GetRefreshRequestId() != ""
	})
	if second.GetResize().GetRefreshRequestId() == first.GetResize().GetRefreshRequestId() {
		t.Fatal("reconnect resent an uncertain request")
	}
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
		RefreshResult: &wspb.TerminalRefreshResult{
			RequestId: second.GetResize().RefreshRequestId,
			Outcome:   wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED.Enum(),
		},
	}})
	// Geometry and a receipt are not usable screen output. The ordinary
	// resize plus input barrier leave the actor free to paint either one.
	f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Geometry{
		Geometry: &wspb.TerminalGeometry{
			AtSeq: proto.Uint64(27), EventCursor: proto.String("v1.7.27.1"),
			Cols: proto.Uint32(100), Rows: proto.Uint32(30),
		},
	}})
	p.resize(100, 30)
	f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
		return fr.GetResize() != nil && fr.GetResize().GetRefreshRequestId() == ""
	})
	p.sendRaw([]byte("during-repaint"))
	f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
		return string(fr.GetInput()) == "during-repaint"
	})
	frame, _ := p.snapshotCopy()
	if !strings.Contains(frameText(frame), "LAST-VIEW") {
		t.Fatalf("pending repaint erased the last frame: %q", frameText(frame))
	}
	f.push(t, outputFrame(t, 27, "NEW-VIEW"))
	waitFor(t, "replacement repaint", func() bool {
		frame, ok := p.snapshotCopy()
		return ok && frame.Cols == 100 && frame.Rows == 30 && frameText(frame) == "NEW-VIEW"
	})
}

func TestNativeRefreshFallbackSuppressesHistoricalQueries(t *testing.T) {
	for _, fresh := range []bool{false, true} {
		name := "existing pane"
		if fresh {
			name = "new pane"
		}
		t.Run(name, func(t *testing.T) {
			data := []byte("abcdef\x1b[6n")
			head := uint64(5 + len(data))
			f := newWindowFixture(t, refreshAttach(head), func(w http.ResponseWriter, q url.Values) {
				writeReplayFixture(w, floorPage(5, head), data)
			})
			p, err := newPaneActor(t.Context(), mustAPI(t, f.srv.URL), paneSpec{
				Key: paneKey{Origin: f.srv.URL, ID: "p"}, Cols: 80, Rows: 24, Fresh: fresh,
			}, make(chan paneEvent, 64), termemu.NewGhostty)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(p.close)
			request := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				return fr.GetResize().GetRefreshRequestId() != ""
			})
			f.push(t, &wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_RefreshResult{
				RefreshResult: &wspb.TerminalRefreshResult{
					RequestId: request.GetResize().RefreshRequestId,
					Outcome:   wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT.Enum(),
				},
			}})
			// The ordered writer places any historical reply before this resize.
			f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				if len(fr.GetInput()) > 0 {
					t.Fatalf("historical query produced a live reply: %q", fr.GetInput())
				}
				return fr.GetResize() != nil && fr.GetResize().GetRefreshRequestId() == ""
			})
			f.push(t, outputFrame(t, head, "\x1b[6n"))
			reply := f.waitFrame(t, func(fr *wspb.TerminalClientFrame) bool {
				return len(fr.GetInput()) > 0
			})
			if string(reply.GetInput()) != "\x1b[1;7R" {
				t.Fatalf("live query reply=%q, want cursor after replayed text", reply.GetInput())
			}
		})
	}
}
