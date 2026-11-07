// Package wireproto defines the terminal shapes shared between the server
// and the phic client.
//
// The WebSocket wire is generated protobuf (see protobuf.go): one binary
// message carries one TerminalClientFrame or TerminalServerFrame. The
// structs below describe the HTTP replay page, not the retired
// server-rendered state responses.
package wireproto

// ReplayHeader is the header of the /replay HTTP response; raw bytes
// follow it in the body. The 256-marker page cap bounds the header far
// below the 64 KiB client parse bound. HistoryIncomplete and Ephemeral
// repeat the attach durability warnings on every page.
type ReplayHeader struct {
	Through           uint64      `json:"through"`
	ThroughCursor     string      `json:"through_event_cursor"`
	Epoch             uint64      `json:"epoch"`
	Start             uint64      `json:"start"`
	End               uint64      `json:"end"`
	Resizes           [][3]uint64 `json:"resizes"` // [atSeq, cols, rows]
	EventCursor       string      `json:"event_cursor"`
	InitCols          uint32      `json:"initial_cols"`
	InitRows          uint32      `json:"initial_rows"`
	HistoryIncomplete bool        `json:"history_incomplete,omitempty"`
	Ephemeral         bool        `json:"ephemeral,omitempty"`
	// Certified RAM-window floor and the head geometry of the attached
	// pane. Byte positions below the floor are gone.
	FloorEventCursor string `json:"floor_event_cursor,omitempty"`
	FloorCols        uint32 `json:"floor_cols,omitempty"`
	FloorRows        uint32 `json:"floor_rows,omitempty"`
	HeadCols         uint32 `json:"head_cols,omitempty"`
	HeadRows         uint32 `json:"head_rows,omitempty"`
}
