package phic

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

type shortTerminal struct {
	bytes.Buffer
	fail bool
}

func (s *shortTerminal) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	n, _ := s.Buffer.Write(p)
	if s.fail {
		return n, io.ErrClosedPipe
	}
	return n, nil
}
func (s *shortTerminal) ReadContext(ctx context.Context, _ []byte) (int, error) {
	<-ctx.Done()
	return 0, ctx.Err()
}
func (s *shortTerminal) Size() (int, int, error) { return 80, 24, nil }
func (s *shortTerminal) Resizes() <-chan Resize  { return nil }

func TestWrittenFrontierTracksShortWritesAndAcceptedErrorPrefix(t *testing.T) {
	out := &shortTerminal{}
	r := NewRelay(out, nil)
	source := []byte("\xff\x00💡\r\n\x1b[31mtext")
	if err := r.write(context.Background(), source); err != nil {
		t.Fatal(err)
	}
	if r.written != uint64(len(source)) || !bytes.Equal(out.Bytes(), source) {
		t.Fatalf("short-write loss: frontier=%d output=%q", r.written, out.Bytes())
	}
	out.Reset()
	out.fail = true
	r.written = 0
	if err := r.write(context.Background(), source); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write error hidden: %v", err)
	}
	if r.written != 3 || !bytes.Equal(out.Bytes(), source[:3]) {
		t.Fatalf("accepted error prefix not accounted: %d %q", r.written, out.Bytes())
	}
}
func TestConnectCancellationClosesSocketBeforeAttachTimeout(t *testing.T) {
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		_, _, _ = ws.ReadMessage() // Deliberately never sends an attach head.
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	r := NewRelay(&shortTerminal{}, mustAPI(t, server.URL))
	at := time.Now()
	if _, err := r.Connect(ctx, "p"); err == nil {
		t.Fatal("missing head accepted")
	}
	if elapsed := time.Since(at); elapsed > time.Second {
		t.Fatalf("cancel waited for five-second attach timeout: %s", elapsed)
	}
}
func TestLoginRejectsUnboundedKDFWork(t *testing.T) {
	if _, err := deriveVerifier("secret", []byte("salt"), "pbkdf2-sha256", 1<<30); err == nil {
		t.Fatal("unbounded advertised KDF accepted")
	}
}
func TestServerURLIsAnOrigin(t *testing.T) {
	for _, url := range []string{"file:///tmp/server", "http://user:secret@localhost", "http://localhost/api", "http://localhost?next=foreign", "http://localhost/#fragment"} {
		if _, err := newAPIClient(url); err == nil {
			t.Fatalf("invalid server origin accepted: %q", url)
		}
	}
	if api, err := newAPIClient("http://localhost:7070/"); err != nil || api.base.String() != "http://localhost:7070" {
		t.Fatalf("trailing slash: %v %v", api, err)
	}
}

// TestRelayClosesMalformedStreamWith1002 pins the native contract: a peer
// that sends a non-binary application frame receives a bounded protocol close
// instead of an abnormal TCP reset the server cannot interpret.
func TestRelayClosesMalformedStreamWith1002(t *testing.T) {
	attach, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch: proto.Uint64(1), Oldest: proto.Uint64(0), Head: proto.Uint64(0),
	})
	if err != nil {
		t.Fatal(err)
	}
	closeCodes := make(chan int, 1)
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, upgradeErr := up.Upgrade(w, r, nil)
		if upgradeErr != nil {
			return
		}
		defer ws.Close()
		if writeErr := ws.WriteMessage(websocket.BinaryMessage, attach); writeErr != nil {
			return
		}
		if writeErr := ws.WriteMessage(websocket.TextMessage, []byte("not protobuf")); writeErr != nil {
			return
		}
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			if _, _, readErr := ws.ReadMessage(); readErr != nil {
				code := websocket.CloseAbnormalClosure
				var closeErr *websocket.CloseError
				if errors.As(readErr, &closeErr) {
					code = closeErr.Code
				}
				closeCodes <- code
				return
			}
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	relay := NewRelay(&shortTerminal{}, mustAPI(t, server.URL))
	if _, err := relay.Connect(ctx, "p"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer relay.Close()
	runDone := make(chan struct{})
	go func() { defer close(runDone); _ = relay.Run(ctx) }()

	select {
	case code := <-closeCodes:
		if code != websocket.CloseProtocolError {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseProtocolError)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("peer never observed a close frame")
	}
	cancel()
	<-runDone
}
