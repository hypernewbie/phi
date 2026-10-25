// Package wireproto defines the terminal shapes shared between the server
// and the phic client.
//
// The WebSocket wire is generated protobuf (see protobuf.go): one binary
// message carries one TerminalClientFrame or TerminalServerFrame. The
// structs below remain because the HTTP recording/state responses reuse
// them, not because any socket still speaks leading-byte frames.
package wireproto

// AttachHeadHeader is the JSON half of the HTTP state responses that
// bootstrap a screen (terminal state, live state, ANSI state). Checkpoint
// bytes ride beside it per each endpoint's contract.
type AttachHeadHeader struct {
	Epoch      uint64            `json:"epoch"`
	Oldest     uint64            `json:"oldest"`
	Head       uint64            `json:"head"`
	Ckpt       *CheckpointHeader `json:"ckpt,omitempty"`
	ReplayFrom uint64            `json:"replay_from,omitempty"`
}

// CheckpointHeader describes the snapshot bytes beside the JSON in the
// HTTP state responses.
type CheckpointHeader struct {
	Kind    string `json:"kind,omitempty"`
	Through uint64 `json:"through"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	Len     int    `json:"len"`
	// EventCursor is the resize boundary this checkpoint consumed.
	// Absent on old servers and client-uploaded snapshots.
	EventCursor string `json:"event_cursor,omitempty"`
}

// RecordingHeader is the JSON half of the /recording HTTP
// response body. The raw bytes follow the JSON in the same body.
// A client that fetches /recording uses this to validate the
// span before it writes the bytes to its terminal.
type RecordingHeader struct {
	Epoch   uint64      `json:"epoch"`
	Start   uint64      `json:"start"`
	End     uint64      `json:"end"`
	Resizes [][3]uint64 `json:"resizes"` // [atSeq, cols, rows]
	// EventCursor continues marker filtering on the next page.
	// Absent on old servers.
	EventCursor string `json:"event_cursor,omitempty"`
}
