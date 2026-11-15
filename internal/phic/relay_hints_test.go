package phic

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// TestRelayIgnoresBrowserHintFrames pins the live loop's ignore set: title,
// bridge state, settlement, notification, and a refresh receipt (which this
// relay never requests) must neither fault the stream nor emit output.
func TestRelayIgnoresBrowserHintFrames(t *testing.T) {
	attach, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch: proto.Uint64(1), Oldest: proto.Uint64(0), Head: proto.Uint64(0),
		InitialCols: proto.Uint32(80), InitialRows: proto.Uint32(24), EventCursor: proto.String("v1.1.0.0"),
	})
	if err != nil {
		t.Fatal(err)
	}
	hints := [][]byte{}
	if f, err := wireproto.EncodeTitleFrame("p", "s", "title", 1); err == nil {
		hints = append(hints, f)
	}
	if f, err := wireproto.EncodeBridgeStateFrame(&wspb.TerminalBridgeState{
		PaneId: proto.String("p"), State: proto.String("ready"), Model: proto.String("m"),
	}); err == nil {
		hints = append(hints, f)
	}
	if f, err := wireproto.EncodeSettlementFrame("p", 1, 1, "completed"); err == nil {
		hints = append(hints, f)
	}
	if f, err := wireproto.EncodeNotificationFrame(&wspb.Notification{}); err == nil {
		hints = append(hints, f)
	}
	if f, err := wireproto.EncodeRefreshResultFrame("7", wspb.TerminalRefreshOutcome_TERMINAL_REFRESH_OUTCOME_DISPATCHED, ""); err == nil {
		hints = append(hints, f)
	}
	if len(hints) != 5 {
		t.Fatalf("could not encode hint frames: %d", len(hints))
	}

	sawExit := make(chan struct{}, 1)
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/terminals/p/replay" {
			serveNativeReplayEpoch(w, r, 1, nil, nil)
			return
		}
		ws, upgradeErr := up.Upgrade(w, r, nil)
		if upgradeErr != nil {
			return
		}
		defer ws.Close()
		if writeErr := ws.WriteMessage(websocket.BinaryMessage, attach); writeErr != nil {
			return
		}
		for _, hint := range hints {
			if writeErr := ws.WriteMessage(websocket.BinaryMessage, hint); writeErr != nil {
				return
			}
		}
		// The stream stays healthy after the hints: a normal exit closes it.
		exit, err := wireproto.EncodeExitFrame(0)
		if err != nil {
			return
		}
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		deadline := time.After(5 * time.Second)
		for {
			select {
			case <-deadline:
				return
			default:
			}
			if _, _, readErr := ws.ReadMessage(); readErr != nil {
				var closeErr *websocket.CloseError
				if errors.As(readErr, &closeErr) && closeErr.Code == websocket.CloseNormalClosure {
					sawExit <- struct{}{}
				}
				return
			}
			_ = ws.WriteMessage(websocket.BinaryMessage, exit)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := &shortTerminal{}
	relay := NewRelay(out, mustAPI(t, server.URL))
	if _, err := relay.Connect(ctx, "p"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer relay.Close()
	if err := relay.Run(ctx); err != nil {
		t.Fatalf("hints faulted the live loop: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("hint frames produced terminal output: %q", out.String())
	}
	select {
	case <-sawExit:
	default:
		// The exit path itself is covered elsewhere; only the hint path matters.
	}
}
