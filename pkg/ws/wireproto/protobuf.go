package wireproto

// Protobuf pane and events wire (phi.websocket.terminal.v1 and
// phi.websocket.events.v1).
//
// One WebSocket binary message carries one generated message: the pane
// client sends TerminalClientFrame and the server answers with
// TerminalServerFrame; the listen-only events client receives bare
// Notification messages. There is no application length header; byte
// limits apply after WebSocket decompression, before protobuf decoding.

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// TerminalSubprotocol is the WebSocket subprotocol every pane client must
// request. The handler rejects any other selection with HTTP 426 before
// accepting application data.
const TerminalSubprotocol = "phi.terminal.protobuf.v1"

// EventsSubprotocol is the WebSocket subprotocol every listen-only
// events client must request. Missing or wrong tokens are rejected
// with HTTP 426 before accepting application data.
const EventsSubprotocol = "phi.events.protobuf.v1"

// ControlSubprotocol is the WebSocket subprotocol every chat control
// client must request. Missing or wrong tokens are rejected with HTTP 426
// before accepting application data.
const ControlSubprotocol = "phi.control.protobuf.v1"

// MaxTerminalMessageBytes bounds one terminal application message after
// WebSocket decompression, including protobuf overhead.
const MaxTerminalMessageBytes = 4 << 20

// MaxEventsMessageBytes bounds one inbound events-channel message after
// decompression. The endpoint is listen-only; conforming clients send
// nothing, so anything past this bound closes the stream with code 1009.
const MaxEventsMessageBytes = 4 << 10

// MaxControlMessageBytes bounds one inbound control call after
// decompression, including attachment data. This is an explicit resource
// bound on a request that may legitimately carry a large paste.
const MaxControlMessageBytes = 16 << 20

// ProtobufRecursionLimit bounds nested-message depth when decoding
// terminal frames.
const ProtobufRecursionLimit = 100

// MaxInputChunkBytes caps one raw input span before encoding. Each chunk
// stays far inside the 4 MiB whole-message bound after protobuf overhead.
const MaxInputChunkBytes = 1 << 20

// ErrMessageTooLarge reports a decompressed application message past the
// caller's limit. The caller closes the stream with code 1009 and stops
// reading that connection; nothing was dispatched.
var ErrMessageTooLarge = errors.New("wireproto: message exceeds bound")

// ClientRequestedSubprotocol reports whether the upgrade request lists
// token in Sec-WebSocket-Protocol. The comparison mirrors gorilla's
// server-side selection: comma-separated, trimmed, exact match.
func ClientRequestedSubprotocol(r *http.Request, token string) bool {
	for _, part := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		if strings.TrimSpace(part) == token {
			return true
		}
	}
	return false
}

// ReadBoundedMessage returns the next data message after decompression,
// capped at limit bytes. SetReadLimit stays the compressed-wire bound;
// this call bounds the decompressed body ReadMessage would otherwise read
// without a limit. Fragmented messages are reassembled by the connection
// before the cap applies. Control frames are handled by the connection
// and never returned here.
func ReadBoundedMessage(c *websocket.Conn, limit int64) (int, []byte, error) {
	mt, r, err := c.NextReader()
	if err != nil {
		return 0, nil, err
	}
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return mt, nil, err
	}
	if int64(len(b)) > limit {
		return mt, nil, ErrMessageTooLarge
	}
	return mt, b, nil
}

var protoUnmarshal = proto.UnmarshalOptions{RecursionLimit: ProtobufRecursionLimit}

// DecodeClientFrame decodes one client application message. Unknown fields
// are accepted; an empty or unsupported payload is rejected.
func DecodeClientFrame(b []byte) (*wspb.TerminalClientFrame, error) {
	frame := &wspb.TerminalClientFrame{}
	if err := protoUnmarshal.Unmarshal(b, frame); err != nil {
		return nil, err
	}
	if frame.GetPayload() == nil {
		return nil, errors.New("wireproto: empty terminal client payload")
	}
	return frame, nil
}

// DecodeServerFrame decodes one server application message. Unknown fields
// are accepted; an empty or unsupported payload is rejected.
func DecodeServerFrame(b []byte) (*wspb.TerminalServerFrame, error) {
	frame := &wspb.TerminalServerFrame{}
	if err := protoUnmarshal.Unmarshal(b, frame); err != nil {
		return nil, err
	}
	if frame.GetPayload() == nil {
		return nil, errors.New("wireproto: empty terminal server payload")
	}
	return frame, nil
}

// DecodeNotification decodes one events-endpoint application message.
// Unknown fields are accepted; an empty or unsupported payload is rejected.
func DecodeNotification(b []byte) (*wspb.Notification, error) {
	notif := &wspb.Notification{}
	if err := protoUnmarshal.Unmarshal(b, notif); err != nil {
		return nil, err
	}
	if notif.GetKind() == nil {
		return nil, errors.New("wireproto: empty notification payload")
	}
	return notif, nil
}

// DecodeControlClientFrame decodes one control-endpoint client message.
// Unknown fields are accepted; an empty or unsupported payload is rejected.
func DecodeControlClientFrame(b []byte, frame *wspb.ControlClientFrame) error {
	if err := protoUnmarshal.Unmarshal(b, frame); err != nil {
		return err
	}
	if frame.GetPayload() == nil {
		return errors.New("wireproto: empty control client payload")
	}
	return nil
}

// EncodeAttachFrame wraps attach in a TerminalServerFrame and marshals it.
func EncodeAttachFrame(attach *wspb.TerminalAttach) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Attach{Attach: attach},
	})
}

// EncodeOutputFrame wraps one sequenced output span and marshals it.
func EncodeOutputFrame(start uint64, data []byte) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Output{Output: &wspb.TerminalOutput{
			Start: proto.Uint64(start),
			Data:  data,
		}},
	})
}

// EncodePongFrame marshals the application pong reply.
func EncodePongFrame() ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Pong{Pong: &wspb.TerminalPong{}},
	})
}

// EncodeExitFrame marshals the signed process-exit notice, including the
// -1 unknown/dead value.
func EncodeExitFrame(code int32) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Exit{Exit: &wspb.TerminalExit{
			Code: proto.Int32(code),
		}},
	})
}

// EncodeInputFrame marshals one raw input span. Callers split spans past
// MaxInputChunkBytes with ChunkInput and send each frame in order.
func EncodeInputFrame(p []byte) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalClientFrame{
		Payload: &wspb.TerminalClientFrame_Input{Input: p},
	})
}

// EncodeResizeFrame marshals one resize request. Geometry range checks
// stay server-side; the client forwards what the terminal reports.
func EncodeResizeFrame(cols, rows uint32) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalClientFrame{
		Payload: &wspb.TerminalClientFrame_Resize{Resize: &wspb.TerminalResize{
			Cols: proto.Uint32(cols),
			Rows: proto.Uint32(rows),
		}},
	})
}

// EncodePingFrame marshals the application ping; the server answers pong.
func EncodePingFrame() ([]byte, error) {
	return proto.Marshal(&wspb.TerminalClientFrame{
		Payload: &wspb.TerminalClientFrame_Ping{Ping: &wspb.TerminalPing{}},
	})
}

// EncodeDropNoticeFrame marshals the slow-client drop notice. It renders
// beside the byte stream, so sequence accounting is untouched.
func EncodeDropNoticeFrame() ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_DropNotice{DropNotice: &wspb.TerminalDropNotice{}},
	})
}

// EncodeTitleFrame marshals one Pi session-title push.
func EncodeTitleFrame(paneID, sessionID, title string, revision uint64) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Title{Title: &wspb.TerminalTitle{
			PaneId:    proto.String(paneID),
			SessionId: proto.String(sessionID),
			Title:     proto.String(title),
			Revision:  proto.Uint64(revision),
		}},
	})
}

// EncodeBridgeStateFrame marshals one Pi-bridge view push.
func EncodeBridgeStateFrame(state *wspb.TerminalBridgeState) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_BridgeState{BridgeState: state},
	})
}

// EncodeSettlementFrame marshals one Pi-run settlement notice.
func EncodeSettlementFrame(paneID string, generation, run uint64, outcome string) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Settlement{Settlement: &wspb.TerminalSettlement{
			Generation: proto.Uint64(generation),
			Run:        proto.Uint64(run),
			Outcome:    proto.String(outcome),
			PaneId:     proto.String(paneID),
		}},
	})
}

// EncodeNotification marshals one bare notification for the listen-only
// events endpoint.
func EncodeNotification(n *wspb.Notification) ([]byte, error) {
	return proto.Marshal(n)
}

// EncodeNotificationFrame wraps one shared notification in a
// TerminalServerFrame for pane clients.
func EncodeNotificationFrame(n *wspb.Notification) ([]byte, error) {
	return proto.Marshal(&wspb.TerminalServerFrame{
		Payload: &wspb.TerminalServerFrame_Notification{Notification: n},
	})
}

// ChunkInput splits raw input into spans of at most MaxInputChunkBytes.
// Splitting is byte-exact, so multi-byte sequences straddling a boundary
// reassemble verbatim. Empty input yields no chunks.
func ChunkInput(p []byte) [][]byte {
	var out [][]byte
	for len(p) > 0 {
		n := min(len(p), MaxInputChunkBytes)
		out = append(out, p[:n])
		p = p[n:]
	}
	return out
}
