package ws

import (
	"context"
	"testing"
	"time"

	"github.com/hypernewbie/phi/pkg/pty"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// recvRefreshResult pulls frames until a refresh receipt for requestID
// arrives, failing on unrelated frames or timeout.
func recvRefreshResult(t *testing.T, ch chan []byte, requestID string) *wspb.TerminalRefreshResult {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case frame := <-ch:
			server, err := wireproto.DecodeServerFrame(frame)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			result := server.GetRefreshResult()
			if result == nil {
				continue
			}
			if result.GetRequestId() != requestID {
				t.Fatalf("receipt for %q, want %q", result.GetRequestId(), requestID)
			}
			return result
		case <-deadline:
			t.Fatalf("no receipt for %q", requestID)
			return nil
		}
	}
}

func expectNoRefreshResult(t *testing.T, ch chan []byte) {
	t.Helper()
	select {
	case frame := <-ch:
		server, err := wireproto.DecodeServerFrame(frame)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if result := server.GetRefreshResult(); result != nil {
			t.Fatalf("unexpected receipt: %+v", result)
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAttachAdvertisesTerminalRefreshHint(t *testing.T) {
	hub := NewHub(0)
	hub.SetTerminalRefresh(nil, func(paneID string) bool { return paneID == "capable" })

	capable := &Client{Send: make(chan []byte, 8)}
	if !hub.AttachHot("capable", capable) {
		t.Fatal("attach refused")
	}
	frame, err := wireproto.DecodeServerFrame(<-capable.Send)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if attach := frame.GetAttach(); attach == nil || !attach.GetTerminalRefreshAvailable() {
		t.Fatalf("capable attach = %+v, want the repaint hint", frame)
	}

	plain := &Client{Send: make(chan []byte, 8)}
	if !hub.AttachHot("plain", plain) {
		t.Fatal("attach refused")
	}
	frame, err = wireproto.DecodeServerFrame(<-plain.Send)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if attach := frame.GetAttach(); attach == nil || attach.GetTerminalRefreshAvailable() {
		t.Fatalf("plain attach = %+v, want no repaint hint", frame)
	}

	// A nil hint advertises nothing, and a nil dispatcher still answers.
	nilHub := NewHub(0)
	none := &Client{Send: make(chan []byte, 8)}
	nilHub.AttachHot("pane", none)
	frame, err = wireproto.DecodeServerFrame(<-none.Send)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if frame.GetAttach().GetTerminalRefreshAvailable() {
		t.Fatalf("nil hint advertised repaint")
	}
}

func TestTerminalRefreshReceiptTargetsRequesterOnly(t *testing.T) {
	hub := NewHub(0)
	hub.SetTerminalRefresh(func(context.Context, string, *pty.PTYInstance) (wspb.TerminalRefreshOutcome, string) {
		return wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED, ""
	}, nil)
	requester := &Client{Send: make(chan []byte, 8)}
	other := &Client{Send: make(chan []byte, 8)}
	if !hub.AttachHot("pane-1", requester) || !hub.AttachHot("pane-1", other) {
		t.Fatal("attach refused")
	}
	<-requester.Send
	<-other.Send
	hub.dispatchTerminalRefresh("pane-1", &pty.PTYInstance{ID: "pane-1"}, requester, "9")

	result := recvRefreshResult(t, requester.Send, "9")
	if result.GetOutcome() != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED {
		t.Fatalf("outcome %v, want DISPATCHED", result.GetOutcome())
	}
	if result.GetReason() != "" {
		t.Fatalf("reason %q, want empty", result.GetReason())
	}
	// The repaint receipt is targeted; the repainting PTY's bytes are not.
	expectNoRefreshResult(t, other.Send)
}

func TestTerminalRefreshIsOneFlightPerSocket(t *testing.T) {
	hub := NewHub(0)
	release := make(chan struct{})
	started := make(chan struct{})
	hub.SetTerminalRefresh(func(context.Context, string, *pty.PTYInstance) (wspb.TerminalRefreshOutcome, string) {
		close(started)
		<-release
		return wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED, ""
	}, nil)
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send

	// dispatchTerminalRefresh returns before the repaint finishes, so the
	// connection read loop keeps handling input and pongs.
	hub.dispatchTerminalRefresh("pane-1", &pty.PTYInstance{ID: "pane-1"}, client, "1")
	<-started

	hub.dispatchTerminalRefresh("pane-1", &pty.PTYInstance{ID: "pane-1"}, client, "2")
	result := recvRefreshResult(t, client.Send, "2")
	if result.GetOutcome() != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT ||
		result.GetReason() != "pending" {
		t.Fatalf("concurrent receipt = %+v, want NOT_SENT/pending", result)
	}

	close(release)
	result = recvRefreshResult(t, client.Send, "1")
	if result.GetOutcome() != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED {
		t.Fatalf("first receipt = %+v, want DISPATCHED", result)
	}
}

func TestTerminalRefreshWithoutBridgeAnswersNotSent(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 8)}
	hub.AttachHot("pane-1", client)
	<-client.Send

	hub.dispatchTerminalRefresh("pane-1", &pty.PTYInstance{ID: "pane-1"}, client, "3")
	result := recvRefreshResult(t, client.Send, "3")
	if result.GetOutcome() != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT ||
		result.GetReason() != "unavailable" {
		t.Fatalf("bridge-free receipt = %+v, want NOT_SENT/unavailable", result)
	}

	// A failed resize is answered before the connection unwinds.
	hub.dispatchTerminalRefreshFailure("pane-1", client, "4")
	result = recvRefreshResult(t, client.Send, "4")
	if result.GetOutcome() != wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_NOT_SENT ||
		result.GetReason() != "resize-failed" {
		t.Fatalf("resize-failed receipt = %+v", result)
	}
}

func TestTerminalRefreshAfterPaneCloseDropsLateReceipt(t *testing.T) {
	hub := NewHub(0)
	client := &Client{Send: make(chan []byte, 1)}
	if !hub.AttachHot("closed", client) {
		t.Fatal("attach refused")
	}
	<-client.Send           // consume ATTACH_HEAD
	hub.ClosePane("closed") // removes the live owner and closes Send

	// A missing live pane has no registration lock that can certify Send as
	// open. Both late receipt paths must drop it rather than panic the server.
	hub.dispatchTerminalRefresh("closed", &pty.PTYInstance{ID: "closed"}, client, "late")
	hub.dispatchTerminalRefreshFailure("closed", client, "late-resize")
}

func TestTerminalRefreshReasonStaysFixed(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"", ""},
		{"unavailable", "unavailable"},
		{"pending", "pending"},
		{"stale", "stale"},
		{"queue-full", "queue-full"},
		{"resize-failed", "resize-failed"},
		{"error", "error"},
		{"host says whatever", "error"},
	} {
		if got := terminalRefreshReason(tc.in); got != tc.want {
			t.Fatalf("terminalRefreshReason(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

}
