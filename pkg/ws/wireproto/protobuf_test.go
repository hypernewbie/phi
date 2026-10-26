package wireproto

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// boundedPair upgrades one loopback connection and hands both ends to the
// test. Compression runs only when requested, so plain-limit cases stay
// exact and the compressed cases exercise real deflate.
func boundedPair(t *testing.T, compression bool) (server, client *websocket.Conn) {
	t.Helper()
	upgrader := websocket.Upgrader{EnableCompression: compression}
	got := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		got <- c
	}))
	t.Cleanup(srv.Close)
	dialer := websocket.Dialer{EnableCompression: compression, HandshakeTimeout: 5 * time.Second}
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := dialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	select {
	case server = <-got:
		t.Cleanup(func() { _ = server.Close() })
		return server, client
	case <-time.After(5 * time.Second):
		t.Fatal("server never received the upgrade")
		return nil, nil
	}
}

// writeFragmentedBinary writes one client-masked binary message in two
// frames. Payloads stay under 126 bytes so each frame uses the short
// length form.
func writeFragmentedBinary(t *testing.T, c *websocket.Conn, first, second []byte) {
	t.Helper()
	for _, p := range [][]byte{first, second} {
		if len(p) > 125 {
			t.Fatalf("fragment %d bytes exceeds the short form", len(p))
		}
	}
	w := c.UnderlyingConn()
	key := []byte{0x11, 0x22, 0x33, 0x44}
	writeFrag := func(final bool, opcode byte, payload []byte) {
		t.Helper()
		b0 := opcode
		if final {
			b0 |= 0x80
		}
		frame := []byte{b0, 0x80 | byte(len(payload))}
		frame = append(frame, key...)
		for i, b := range payload {
			frame = append(frame, b^key[i%4])
		}
		if _, err := w.Write(frame); err != nil {
			t.Fatalf("write fragment: %v", err)
		}
	}
	writeFrag(false, websocket.BinaryMessage, first)
	writeFrag(true, 0x0, second) // continuation
}

func TestWebSocketProtobufBoundedReader(t *testing.T) {
	t.Run("exact limit passes", func(t *testing.T) {
		server, client := boundedPair(t, false)
		msg := bytes.Repeat([]byte("a"), 1024)
		if err := client.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
		mt, got, err := ReadBoundedMessage(server, 1024)
		if err != nil {
			t.Fatalf("exact-limit message rejected: %v", err)
		}
		if mt != websocket.BinaryMessage || !bytes.Equal(got, msg) {
			t.Fatal("exact-limit message mangled")
		}
	})

	t.Run("one byte over is rejected with no bytes", func(t *testing.T) {
		server, client := boundedPair(t, false)
		if err := client.WriteMessage(websocket.BinaryMessage, bytes.Repeat([]byte("b"), 1025)); err != nil {
			t.Fatalf("write: %v", err)
		}
		_, got, err := ReadBoundedMessage(server, 1024)
		if !errors.Is(err, ErrMessageTooLarge) {
			t.Fatalf("err = %v, want ErrMessageTooLarge", err)
		}
		if got != nil {
			t.Fatalf("oversize read yielded %d bytes; nothing may dispatch", len(got))
		}
	})

	t.Run("compressed expansion past the bound is rejected", func(t *testing.T) {
		server, client := boundedPair(t, true)
		// 4 KiB of zeros deflates to tens of wire bytes: SetReadLimit sees
		// the wire, so only the decompressed bound can catch this.
		if err := client.WriteMessage(websocket.BinaryMessage, bytes.Repeat([]byte{0}, 4096)); err != nil {
			t.Fatalf("write: %v", err)
		}
		server.SetReadLimit(1 << 20)
		_, got, err := ReadBoundedMessage(server, 1024)
		if !errors.Is(err, ErrMessageTooLarge) {
			t.Fatalf("err = %v, want ErrMessageTooLarge", err)
		}
		if got != nil {
			t.Fatalf("oversize read yielded %d bytes; nothing may dispatch", len(got))
		}
	})

	t.Run("compressed message within the bound passes", func(t *testing.T) {
		server, client := boundedPair(t, true)
		msg := bytes.Repeat([]byte{0}, 4096)
		if err := client.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
		server.SetReadLimit(1 << 20)
		_, got, err := ReadBoundedMessage(server, 1<<20)
		if err != nil {
			t.Fatalf("in-bound compressed message rejected: %v", err)
		}
		if !bytes.Equal(got, msg) {
			t.Fatal("compressed round trip mangled")
		}
	})

	t.Run("fragmented expansion past the bound is rejected", func(t *testing.T) {
		server, client := boundedPair(t, false)
		writeFragmentedBinary(t, client, bytes.Repeat([]byte("c"), 64), bytes.Repeat([]byte("d"), 64))
		_, got, err := ReadBoundedMessage(server, 100)
		if !errors.Is(err, ErrMessageTooLarge) {
			t.Fatalf("err = %v, want ErrMessageTooLarge", err)
		}
		if got != nil {
			t.Fatalf("oversize read yielded %d bytes; nothing may dispatch", len(got))
		}
	})

	t.Run("fragmented message within the bound reassembles", func(t *testing.T) {
		server, client := boundedPair(t, false)
		writeFragmentedBinary(t, client, []byte("0123456789"), []byte("abcdef"))
		mt, got, err := ReadBoundedMessage(server, 100)
		if err != nil {
			t.Fatalf("in-bound fragmented message rejected: %v", err)
		}
		if mt != websocket.BinaryMessage || string(got) != "0123456789abcdef" {
			t.Fatalf("reassembly = %q", got)
		}
	})
}

func TestWebSocketProtobufCodecRoundTrip(t *testing.T) {
	// The signed exit keeps -1 (unknown/dead) distinct from real codes.
	raw, err := EncodeExitFrame(-1)
	if err != nil {
		t.Fatalf("encode exit: %v", err)
	}
	frame, err := DecodeServerFrame(raw)
	if err != nil {
		t.Fatalf("decode exit: %v", err)
	}
	if frame.GetExit() == nil || frame.GetExit().GetCode() != -1 {
		t.Fatalf("exit = %+v, want code -1", frame.GetPayload())
	}

	// Output bytes travel verbatim, including non-UTF-8 a string field
	// could never carry.
	data := []byte{0xff, 0xfe, 'a', 0x80}
	raw, err = EncodeOutputFrame(42, data)
	if err != nil {
		t.Fatalf("encode output: %v", err)
	}
	frame, err = DecodeServerFrame(raw)
	if err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if frame.GetOutput() == nil || frame.GetOutput().GetStart() != 42 || !bytes.Equal(frame.GetOutput().GetData(), data) {
		t.Fatalf("output = %+v", frame.GetPayload())
	}

	// Unknown fields are tolerated; the known payload still decodes.
	rawWithUnknown := append(raw, 0x98, 0x06, 0x01) // field 99, varint 1
	frame, err = DecodeServerFrame(rawWithUnknown)
	if err != nil {
		t.Fatalf("decode with unknown field: %v", err)
	}
	if frame.GetOutput() == nil || !bytes.Equal(frame.GetOutput().GetData(), data) {
		t.Fatalf("output with unknown field = %+v", frame.GetPayload())
	}

	// Empty payloads are rejected in both directions.
	if _, err := DecodeServerFrame([]byte{}); err == nil {
		t.Fatal("empty server frame accepted")
	}
	if _, err := DecodeClientFrame([]byte{}); err == nil {
		t.Fatal("empty client frame accepted")
	}
	if _, err := DecodeClientFrame([]byte("not-protobuf\xff\xfe")); err == nil {
		t.Fatal("garbage client frame accepted")
	}

	// The application pong round-trips as its own payload.
	raw, err = EncodePongFrame()
	if err != nil {
		t.Fatalf("encode pong: %v", err)
	}
	frame, err = DecodeServerFrame(raw)
	if err != nil {
		t.Fatalf("decode pong: %v", err)
	}
	if frame.GetPong() == nil {
		t.Fatalf("pong = %+v", frame.GetPayload())
	}
}
