package phic

import (
	"fmt"
	"io"
	"strings"
)

// Native display ownership only: no cells, cursor model, or client history.
// Menus select the normal buffer and print inline. Relay reconstruction starts
// both native buffers at a known baseline before replaying Phi's recording.
const neutralDisplay = "\x18\x1b\\\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b[>4;0m\x1b[=0u\x1b[0m\x1b]8;;\x1b\\\x1b(B\x1b)B\x0f\x1b[r\x1b[?25h"
const clearRelayDisplay = "\x1b[?47h\x1b[2J\x1b[H\x1b[?47l\x1b[2J\x1b[H"

func writeAll(t io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := t.Write(data)
		if n < 0 || n > len(data) {
			return fmt.Errorf("phic: invalid view write count")
		}
		data = data[n:]
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	return nil
}

func defaultTabStops(cols int) string {
	var out strings.Builder
	out.WriteString("\x1b[3g")
	for x := 9; x <= cols; x += 8 {
		fmt.Fprintf(&out, "\x1b[1;%dH\x1bH", x)
	}
	out.WriteString("\x1b[H")
	return out.String()
}
