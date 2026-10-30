package phic

// M1 native codec: client-frame encoding (with paste chunking) and
// server-frame decoding, plus the shared fake-server frame builders the
// migrated tests use.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hypernewbie/phi/pkg/pty"
	"github.com/hypernewbie/phi/pkg/ws"
	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
	"google.golang.org/protobuf/proto"
)

// testAttach builds one encoded attach server frame with no checkpoint.
func testAttach(t *testing.T, epoch, head uint64) []byte {
	t.Helper()
	raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch:  proto.Uint64(epoch),
		Oldest: proto.Uint64(0),
		Head:   proto.Uint64(head),
	})
	if err != nil {
		t.Fatalf("encode attach: %v", err)
	}
	return raw
}

// testAttachOldest builds one encoded attach server frame with a nonzero oldest.
func testAttachOldest(t *testing.T, epoch, oldest, head uint64) []byte {
	t.Helper()
	raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch:  proto.Uint64(epoch),
		Oldest: proto.Uint64(oldest),
		Head:   proto.Uint64(head),
	})
	if err != nil {
		t.Fatalf("encode attach: %v", err)
	}
	return raw
}

// testAttachCkpt builds one encoded attach server frame carrying a checkpoint.
func testAttachCkpt(t *testing.T, epoch, head uint64, kind string, through uint64, cols, rows uint32, data []byte) []byte {
	t.Helper()
	raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
		Epoch: proto.Uint64(epoch),
		Head:  proto.Uint64(head),
		Checkpoint: &wspb.TerminalCheckpoint{
			Kind:    proto.String(kind),
			Through: proto.Uint64(through),
			Cols:    proto.Uint32(cols),
			Rows:    proto.Uint32(rows),
			Data:    data,
		},
	})
	if err != nil {
		t.Fatalf("encode attach: %v", err)
	}
	return raw
}

// testOutput builds one encoded output server frame.
func testOutput(t *testing.T, start uint64, data []byte) []byte {
	t.Helper()
	raw, err := wireproto.EncodeOutputFrame(start, data)
	if err != nil {
		t.Fatalf("encode output: %v", err)
	}
	return raw
}

// testExit builds one encoded exit server frame.
func testExit(t *testing.T, code int32) []byte {
	t.Helper()
	raw, err := wireproto.EncodeExitFrame(code)
	if err != nil {
		t.Fatalf("encode exit: %v", err)
	}
	return raw
}

// testResize builds one encoded resize client frame for byte comparison.
func testResize(t *testing.T, cols, rows uint32) []byte {
	t.Helper()
	raw, err := wireproto.EncodeResizeFrame(cols, rows)
	if err != nil {
		t.Fatalf("encode resize: %v", err)
	}
	return raw
}

// clientInput decodes one client frame and requires an input payload.
func clientInput(t *testing.T, raw []byte) []byte {
	t.Helper()
	frame, err := wireproto.DecodeClientFrame(raw)
	if err != nil {
		t.Fatalf("decode client frame: %v", err)
	}
	in, ok := frame.GetPayload().(*wspb.TerminalClientFrame_Input)
	if !ok {
		t.Fatalf("not an input frame: %v", frame.GetPayload())
	}
	return in.Input
}

// clientResize decodes one client frame and requires a resize payload.
func clientResize(t *testing.T, raw []byte) (uint32, uint32) {
	t.Helper()
	frame, err := wireproto.DecodeClientFrame(raw)
	if err != nil {
		t.Fatalf("decode client frame: %v", err)
	}
	rs, ok := frame.GetPayload().(*wspb.TerminalClientFrame_Resize)
	if !ok {
		t.Fatalf("not a resize frame: %v", frame.GetPayload())
	}
	if rs.Resize == nil {
		t.Fatalf("resize payload holds no message")
	}
	return rs.Resize.GetCols(), rs.Resize.GetRows()
}

func TestWebSocketProtobufNativeCodec(t *testing.T) {
	attach := func(epoch, oldest, head, replayFrom uint64, ckpt *wspb.TerminalCheckpoint) []byte {
		raw, err := wireproto.EncodeAttachFrame(&wspb.TerminalAttach{
			Epoch:      proto.Uint64(epoch),
			Oldest:     proto.Uint64(oldest),
			Head:       proto.Uint64(head),
			Checkpoint: ckpt,
			ReplayFrom: proto.Uint64(replayFrom),
		})
		if err != nil {
			t.Fatalf("encode attach: %v", err)
		}
		return raw
	}

	t.Run("attach span bounds", func(t *testing.T) {
		got, err := ParseAttachHead(attach(7, 1, 5, 0, nil))
		if err != nil {
			t.Fatalf("valid attach rejected: %v", err)
		}
		if got.GetEpoch() != 7 || got.GetOldest() != 1 || got.GetHead() != 5 {
			t.Fatalf("attach = %+v", got)
		}
		if _, err := ParseAttachHead(attach(7, 1, 5, 3, nil)); err != nil {
			t.Fatalf("in-window replay_from rejected: %v", err)
		}
		for name, raw := range map[string][]byte{
			"zero epoch":        attach(0, 1, 5, 0, nil),
			"oldest above head": attach(7, 6, 5, 0, nil),
			"replay below old":  attach(7, 2, 5, 1, nil),
			"replay above head": attach(7, 1, 5, 6, nil),
		} {
			if _, err := ParseAttachHead(raw); err == nil {
				t.Fatalf("%s accepted", name)
			}
		}
	})

	t.Run("checkpoint bounds", func(t *testing.T) {
		valid := &wspb.TerminalCheckpoint{
			Through: proto.Uint64(3),
			Cols:    proto.Uint32(80),
			Rows:    proto.Uint32(24),
			Data:    []byte("snap"),
		}
		got, err := ParseAttachHead(attach(7, 1, 5, 0, valid))
		if err != nil {
			t.Fatalf("valid checkpoint rejected: %v", err)
		}
		if string(got.GetCheckpoint().GetData()) != "snap" {
			t.Fatalf("checkpoint data = %q", got.GetCheckpoint().GetData())
		}
		clone := func(mut func(*wspb.TerminalCheckpoint)) *wspb.TerminalCheckpoint {
			c := &wspb.TerminalCheckpoint{
				Through: proto.Uint64(3),
				Cols:    proto.Uint32(80),
				Rows:    proto.Uint32(24),
				Data:    []byte("snap"),
			}
			mut(c)
			return c
		}
		for name, ckpt := range map[string]*wspb.TerminalCheckpoint{
			"through below oldest": clone(func(c *wspb.TerminalCheckpoint) { c.Through = proto.Uint64(0) }),
			"through above head":   clone(func(c *wspb.TerminalCheckpoint) { c.Through = proto.Uint64(6) }),
			"zero cols":            clone(func(c *wspb.TerminalCheckpoint) { c.Cols = proto.Uint32(0) }),
			"zero rows":            clone(func(c *wspb.TerminalCheckpoint) { c.Rows = proto.Uint32(0) }),
			"oversize data":        clone(func(c *wspb.TerminalCheckpoint) { c.Data = make([]byte, MaxNativePayloadBytes+1) }),
		} {
			if _, err := ParseAttachHead(attach(7, 1, 5, 0, ckpt)); err == nil {
				t.Fatalf("%s accepted", name)
			}
		}
	})

	t.Run("output bytes and overflow", func(t *testing.T) {
		data := []byte{0xff, 0xfe, 'a', 0x80}
		raw, err := wireproto.EncodeOutputFrame(100, data)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		start, got, err := ParseLiveOutput(raw)
		if err != nil {
			t.Fatalf("valid output rejected: %v", err)
		}
		if start != 100 || !bytes.Equal(got, data) {
			t.Fatalf("output start=%d data=%q", start, got)
		}
		big, err := wireproto.EncodeOutputFrame(0, make([]byte, MaxNativePayloadBytes+1))
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, _, err := ParseLiveOutput(big); err == nil {
			t.Fatal("oversize output accepted")
		}
		wrap, err := wireproto.EncodeOutputFrame(^uint64(0), []byte("x"))
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, _, err := ParseLiveOutput(wrap); err == nil {
			t.Fatal("wrapping span accepted")
		}
	})

	t.Run("signed exit", func(t *testing.T) {
		for _, code := range []int32{-1, 0, 3} {
			raw, err := wireproto.EncodeExitFrame(code)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			frame, err := wireproto.DecodeServerFrame(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if frame.GetExit() == nil || frame.GetExit().GetCode() != code {
				t.Fatalf("exit = %+v, want code %d", frame.GetPayload(), code)
			}
			if got, err := terminalExitCode(frame.GetExit()); err != nil || got != int(code) {
				t.Fatalf("exit code = %d, %v; want %d", got, err, code)
			}
		}

		missing, err := proto.Marshal(&wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Exit{
			Exit: &wspb.TerminalExit{},
		}})
		if err != nil {
			t.Fatalf("marshal missing code: %v", err)
		}
		frame, err := wireproto.DecodeServerFrame(missing)
		if err != nil {
			t.Fatalf("decode missing code: %v", err)
		}
		if _, err := terminalExitCode(frame.GetExit()); !errors.Is(err, errProtocol) {
			t.Fatalf("absent exit code error = %v, want protocol error", err)
		}
	})

	t.Run("wrong payload and garbage rejected", func(t *testing.T) {
		out, err := wireproto.EncodeOutputFrame(0, []byte("x"))
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if _, err := ParseAttachHead(out); err == nil {
			t.Fatal("output accepted as attach")
		}
		if _, _, err := ParseLiveOutput(testAttach(t, 7, 5)); err == nil {
			t.Fatal("attach accepted as output")
		}
		for _, raw := range [][]byte{nil, {}, []byte("not-protobuf\xff\xfe")} {
			if _, err := ParseAttachHead(raw); err == nil {
				t.Fatalf("garbage attach %q accepted", raw)
			}
			if _, _, err := ParseLiveOutput(raw); err == nil {
				t.Fatalf("garbage output %q accepted", raw)
			}
		}
	})

	t.Run("required scalar presence", func(t *testing.T) {
		missingStart, err := proto.Marshal(&wspb.TerminalServerFrame{Payload: &wspb.TerminalServerFrame_Output{
			Output: &wspb.TerminalOutput{Data: []byte("x")},
		}})
		if err != nil {
			t.Fatalf("marshal missing start: %v", err)
		}
		if _, _, err := ParseLiveOutput(missingStart); !errors.Is(err, errProtocol) {
			t.Fatalf("absent output start error = %v, want protocol error", err)
		}

		zeroStart, err := wireproto.EncodeOutputFrame(0, []byte("x"))
		if err != nil {
			t.Fatalf("encode zero start: %v", err)
		}
		if start, _, err := ParseLiveOutput(zeroStart); err != nil || start != 0 {
			t.Fatalf("explicit zero start = %d, %v", start, err)
		}
	})
}

func TestWebSocketProtobufPasteReassembly(t *testing.T) {
	// A paste larger than 4 MiB with non-UTF-8 straddling every chunk
	// boundary must round-trip byte-exact.
	const size = 4<<20 + 7
	payload := bytes.Repeat([]byte("A"), size)
	for _, at := range []int{(1 << 20) - 1, 1 << 20, (2 << 20) - 1, 2 << 20, (3 << 20) - 1, 3 << 20, (4 << 20) - 1, 4 << 20} {
		payload[at] = byte(0x80 + at%0x40)
	}
	chunks := wireproto.ChunkInput(payload)
	if len(chunks) != 5 {
		t.Fatalf("chunks = %d, want 5", len(chunks))
	}
	var got []byte
	for i, chunk := range chunks {
		raw, err := wireproto.EncodeInputFrame(chunk)
		if err != nil {
			t.Fatalf("encode chunk %d: %v", i, err)
		}
		frame, err := wireproto.DecodeClientFrame(raw)
		if err != nil {
			t.Fatalf("decode chunk %d: %v", i, err)
		}
		in, ok := frame.GetPayload().(*wspb.TerminalClientFrame_Input)
		if !ok {
			t.Fatalf("chunk %d is not input: %v", i, frame.GetPayload())
		}
		got = append(got, in.Input...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("reassembly differs at %d of %d bytes", firstDiff(got, payload), len(payload))
	}
	if wireproto.ChunkInput(nil) != nil || wireproto.ChunkInput([]byte{}) != nil {
		t.Fatal("empty input must yield no chunks")
	}
}

func TestWebSocketProtobufPasteReassemblyE2E(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX PTY echo")
	}
	// Ordered multi-frame delivery through the real server and PTY echo.
	// ChunkInput's 1 MiB split points and >4 MiB exactness are pinned by
	// TestWebSocketProtobufPasteReassembly. This test sends small pieces
	// as separate input frames with echo flow control: PTY echo drops
	// bytes when a burst overruns the output queue (kernel-side,
	// pre-existing), so volume exactness cannot ride on echo.
	hub := ws.NewHub(1 << 20)
	manager := pty.NewManager()
	t.Cleanup(func() { manager.Shutdown(100 * time.Millisecond) })
	inst, err := manager.Spawn(context.Background(), t.TempDir(), "/bin/sh", []string{"-c", "read -r _ && stty -icanon && echo READY && cat > /dev/null"}, "drain", "")
	if err != nil {
		t.Fatalf("spawn: %v", err)
	}
	ws.StartPTYReadLoop(inst, hub)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws.HandleWS(w, r, inst, manager, hub)
	}))
	t.Cleanup(server.Close)

	dialer := websocket.Dialer{
		Subprotocols:     []string{wireproto.TerminalSubprotocol},
		HandshakeTimeout: 5 * time.Second,
	}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read attach: %v", err)
	}
	attach, err := wireproto.DecodeServerFrame(raw)
	if err != nil || attach.GetAttach() == nil {
		t.Fatalf("first frame is not an attach: %v", err)
	}

	if head := attach.GetAttach().GetHead(); head != 0 {
		t.Fatalf("output before startup input: head = %d, want 0", head)
	}
	// Live-only attach cannot replay an earlier READY. Release the shell
	// after attach, then consume the full readiness line before pasting.
	start, err := wireproto.EncodeInputFrame([]byte("\n"))
	if err != nil {
		t.Fatalf("encode startup input: %v", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, start); err != nil {
		t.Fatalf("write startup input: %v", err)
	}
	var ready []byte
	readyMarker := []byte("READY\r\n")
	readyDeadline := time.Now().Add(10 * time.Second)
	for !bytes.Contains(ready, readyMarker) && time.Now().Before(readyDeadline) {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("wait for slave ready: %v", err)
		}
		frame, err := wireproto.DecodeServerFrame(raw)
		if err != nil {
			t.Fatalf("decode ready: %v", err)
		}
		out := frame.GetOutput()
		if out == nil {
			t.Fatalf("expected output, got %v", frame.GetPayload())
		}
		ready = append(ready, out.GetData()...)
	}
	if !bytes.Contains(ready, readyMarker) {
		t.Fatal("slave never signaled ready")
	}

	const pieces, pieceSize = 3, 1024
	payload := bytes.Repeat([]byte("A"), pieces*pieceSize)
	for _, at := range []int{pieceSize - 1, pieceSize, 2*pieceSize - 1, 2 * pieceSize} {
		payload[at] = byte(0x80 + at%0x40)
	}
	sendFrame := func(data []byte, i int) {
		frame, err := wireproto.EncodeInputFrame(data)
		if err != nil {
			t.Fatalf("encode chunk %d: %v", i, err)
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			t.Fatalf("write chunk %d: %v", i, err)
		}
	}
	readExact := func(n int, what string) []byte {
		var got []byte
		deadline := time.Now().Add(30 * time.Second)
		for len(got) < n && time.Now().Before(deadline) {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			mt, raw, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("read %s after %d of %d bytes: %v", what, len(got), n, err)
			}
			if mt != websocket.BinaryMessage {
				t.Fatalf("message type %d, want binary", mt)
			}
			frame, err := wireproto.DecodeServerFrame(raw)
			if err != nil {
				t.Fatalf("decode %s: %v", what, err)
			}
			out := frame.GetOutput()
			if out == nil {
				t.Fatalf("expected output, got %v", frame.GetPayload())
			}
			got = append(got, out.GetData()...)
		}
		if len(got) != n {
			t.Fatalf("%s: got %d bytes, want %d", what, len(got), n)
		}
		return got
	}
	// Flow control: each piece goes out only after the previous piece's
	// echo proves the PTY accepted it.
	var got []byte
	for i := range pieces {
		sendFrame(payload[i*pieceSize:(i+1)*pieceSize], i)
		got = append(got, readExact(pieceSize, "piece")...)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("echo differs at %d of %d bytes", firstDiff(got, payload), len(payload))
	}
}

func firstDiff(a, b []byte) int {
	for i := range a {
		if i >= len(b) || a[i] != b[i] {
			return i
		}
	}
	return len(a)
}

// TestNativePaneClosesOversizedCompressedStreamWith1009 pins the size close
// on the pane-actor reader: a compressed frame whose wire size fits but whose
// decompressed body exceeds the application bound ends with 1009, not an
// abnormal 1006 disconnect the server cannot interpret.
func TestNativePaneClosesOversizedCompressedStreamWith1009(t *testing.T) {
	closeCodes := make(chan int, 1)
	up := websocket.Upgrader{
		EnableCompression: true,
		Subprotocols:      []string{wireproto.TerminalSubprotocol},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if err := conn.WriteMessage(websocket.BinaryMessage, testAttach(t, 1, 0)); err != nil {
			return
		}
		// Highly compressible: tiny on the wire, past the decompressed bound.
		body := testOutput(t, 0, bytes.Repeat([]byte("a"), wireproto.MaxTerminalMessageBytes))
		if err := conn.WriteMessage(websocket.BinaryMessage, body); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		for {
			if _, _, readErr := conn.ReadMessage(); readErr != nil {
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
	defer srv.Close()

	p := &paneActor{api: mustAPI(t, srv.URL), spec: paneSpec{Key: paneKey{ID: "p"}}}
	conn, _, err := p.dial(t.Context())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	reads := make(chan paneRead, 4)
	done := make(chan struct{})
	go p.readLoop(t.Context(), conn, reads, done)

	// dial consumed the attach frame; the next application message is the
	// oversized one.
	if over := <-reads; !errors.Is(over.err, wireproto.ErrMessageTooLarge) {
		t.Fatalf("oversized read error = %v, want the size bound", over.err)
	}
	select {
	case code := <-closeCodes:
		if code != websocket.CloseMessageTooBig {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseMessageTooBig)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("peer never observed a close frame")
	}
	<-done
}

func TestNativePaneClosesMalformedProtobufStreamWith1002(t *testing.T) {
	closeCodes := make(chan int, 1)
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if err := conn.WriteMessage(websocket.BinaryMessage, testAttach(t, 1, 0)); err != nil {
			return
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0xff}); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			if _, _, readErr := conn.ReadMessage(); readErr != nil {
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
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	p := &paneActor{
		api:  mustAPI(t, srv.URL),
		spec: paneSpec{Key: paneKey{ID: "p"}},
		ctx:  ctx,
	}
	conn, _, err := p.dial(ctx)
	if err != nil {
		cancel()
		t.Fatalf("dial: %v", err)
	}
	p.setConn(conn)
	reads := make(chan paneRead, 4)
	done := make(chan struct{})
	go p.readLoop(ctx, conn, reads, done)
	consumeErr := p.consume(reads)
	cancel()
	_ = conn.Close()
	<-done

	select {
	case code := <-closeCodes:
		if code != websocket.CloseProtocolError {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseProtocolError)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("peer never observed a close frame")
	}
	if !errors.Is(consumeErr, errProtocol) {
		t.Fatalf("consume error = %v, want protocol error", consumeErr)
	}
}

func TestNativePaneDoesNotRetryMalformedInitialAttach(t *testing.T) {
	upgrades := make(chan struct{}, 32)
	closeCodes := make(chan int, 32)
	up := websocket.Upgrader{Subprotocols: []string{wireproto.TerminalSubprotocol}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		upgrades <- struct{}{}
		if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0xff}); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := conn.ReadMessage(); err != nil {
			code := websocket.CloseAbnormalClosure
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				code = closeErr.Code
			}
			closeCodes <- code
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	p := &paneActor{
		api:  mustAPI(t, srv.URL),
		spec: paneSpec{Key: paneKey{ID: "p"}},
		ctx:  ctx,
	}
	if err := p.attachAndRun(); !errors.Is(err, errProtocol) {
		t.Fatalf("attach error = %v, want permanent protocol error", err)
	}
	if got := len(upgrades); got != 1 {
		t.Fatalf("server received %d attach attempts, want 1", got)
	}
	select {
	case code := <-closeCodes:
		if code != websocket.CloseProtocolError {
			t.Fatalf("close code = %d, want %d", code, websocket.CloseProtocolError)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("peer never observed a close frame")
	}
}
