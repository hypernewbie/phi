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
	up := websocket.Upgrader{}
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
