package phic

import (
	"errors"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

// closeWithCode writes one bounded close frame, then closes the socket.
// Native peers answer malformed streams with 1002 and size violations with
// 1009 instead of disappearing into an abnormal 1006 disconnect.
func closeWithCode(conn *websocket.Conn, code int, reason string) {
	if conn == nil {
		return
	}
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(time.Second),
	)
	_ = conn.Close()
}

// closeCodeForReadError maps one failed read or decode to the plan's close
// code: 1009 for a decompressed size violation, 1002 for everything else.
func closeCodeForReadError(err error) int {
	if errors.Is(err, wireproto.ErrMessageTooLarge) {
		return websocket.CloseMessageTooBig
	}
	return websocket.CloseProtocolError
}
