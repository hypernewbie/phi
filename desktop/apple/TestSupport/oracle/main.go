// Command oracle decodes a Phi ANSI checkpoint into a frame an independent
// adapter can be compared against (§9.2).
//
// It validates the wire framing, then replays the raw span into a fresh Go
// Ghostty terminal at the envelope geometry under boundary policy: parser
// replies are suppressed for the whole span and, if the checkpoint ends inside
// a sequence, until the parser reaches ground. This deliberately shares the
// pinned terminal engine with the Swift client; it is an independent adapter
// and restore path, not an independent engine.
//
// Usage:
//
//	oracle --ansi-state <envelope.bin> --frame-json <out.json>
//	oracle --ansi-raw <ansi.bin> --cols 80 --rows 24 --frame-json <out.json>
package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/hypernewbie/phi/internal/termemu"
	"github.com/hypernewbie/phi/pkg/ws/wireproto"
)

const (
	maxHeaderBytes     = 4096
	scrollbackBytes    = 64 << 20
	scrollbackLines    = 10000
	ansiCheckpointKind = "ansi-v1"
)

type color struct {
	Kind  string `json:"kind"`
	Value uint32 `json:"value"`
}

type cell struct {
	Text          string `json:"text"`
	Width         int    `json:"width"`
	Bold          bool   `json:"bold"`
	Faint         bool   `json:"faint"`
	Italic        bool   `json:"italic"`
	Strikethrough bool   `json:"strikethrough"`
	Inverse       bool   `json:"inverse"`
	Blink         bool   `json:"blink"`
	Underline     int    `json:"underline"`
	Fg            color  `json:"fg"`
	Bg            color  `json:"bg"`
}

type frame struct {
	Cols         int      `json:"cols"`
	Rows         int      `json:"rows"`
	CursorX      int      `json:"cursorX"`
	CursorY      int      `json:"cursorY"`
	PendingWrap  bool     `json:"pendingWrap"`
	CursorHidden bool     `json:"cursorHidden"`
	Alt          bool     `json:"alt"`
	History      int      `json:"history"`
	Text         string   `json:"text"`
	Cells        [][]cell `json:"cells"`
}

func main() {
	envelope := flag.String("ansi-state", "", "checkpoint reply body: [u32 length][JSON header][raw span]")
	raw := flag.String("ansi-raw", "", "raw ANSI span instead of an envelope")
	cols := flag.Int("cols", 0, "geometry for --ansi-raw")
	rows := flag.Int("rows", 0, "geometry for --ansi-raw")
	out := flag.String("frame-json", "", "where to write the decoded frame")
	flag.Parse()

	if err := run(*envelope, *raw, *cols, *rows, *out); err != nil {
		fmt.Fprintf(os.Stderr, "oracle: %v\n", err)
		os.Exit(1)
	}
}

func run(envelopePath, rawPath string, cols, rows int, outPath string) error {
	if outPath == "" {
		return errors.New("--frame-json is required")
	}
	if (envelopePath == "") == (rawPath == "") {
		return errors.New("exactly one of --ansi-state or --ansi-raw is required")
	}

	var span []byte
	geometryKnown := false
	if envelopePath != "" {
		body, err := os.ReadFile(envelopePath)
		if err != nil {
			return err
		}
		var err2 error
		span, cols, rows, err2 = unwrap(body)
		if err2 != nil {
			return err2
		}
		geometryKnown = true
	} else {
		body, err := os.ReadFile(rawPath)
		if err != nil {
			return err
		}
		span = body
		geometryKnown = cols > 0 && rows > 0
	}
	if !geometryKnown {
		return errors.New("raw ANSI needs explicit --cols and --rows")
	}

	decoded, err := decode(span, cols, rows)
	if err != nil {
		return err
	}
	data, err := json.Marshal(decoded)
	if err != nil {
		return err
	}
	if err := os.WriteFile(outPath, data, 0o644); err != nil {
		return err
	}
	fmt.Printf("oracle: geometry %dx%d cells %d text %d bytes\n",
		decoded.Cols, decoded.Rows, countCells(decoded.Cells), len(decoded.Text))
	return nil
}

// unwrap validates the reply framing and returns the raw span plus the
// geometry the checkpoint was taken at.
func unwrap(body []byte) ([]byte, int, int, error) {
	if len(body) < 4 {
		return nil, 0, 0, errors.New("reply shorter than its length prefix")
	}
	headerLen := binary.BigEndian.Uint32(body[:4])
	if headerLen == 0 || headerLen > maxHeaderBytes || uint32(len(body)-4) < headerLen {
		return nil, 0, 0, fmt.Errorf("header length %d out of range", headerLen)
	}
	var header wireproto.AttachHeadHeader
	if err := json.Unmarshal(body[4:4+headerLen], &header); err != nil {
		return nil, 0, 0, fmt.Errorf("header decode: %w", err)
	}
	span := body[4+headerLen:]
	ckpt := header.Ckpt
	if ckpt == nil {
		return nil, 0, 0, errors.New("header carried no checkpoint")
	}
	if ckpt.Kind != ansiCheckpointKind {
		return nil, 0, 0, fmt.Errorf("checkpoint kind %q is not %q", ckpt.Kind, ansiCheckpointKind)
	}
	if ckpt.Len != len(span) {
		return nil, 0, 0, fmt.Errorf("checkpoint length %d but span is %d bytes", ckpt.Len, len(span))
	}
	if ckpt.Through != header.Head {
		return nil, 0, 0, fmt.Errorf("checkpoint through %d but head %d", ckpt.Through, header.Head)
	}
	if ckpt.Cols == 0 || ckpt.Rows == 0 {
		return nil, 0, 0, errors.New("checkpoint geometry is empty")
	}
	return span, int(ckpt.Cols), int(ckpt.Rows), nil
}

func decode(span []byte, cols, rows int) (frame, error) {
	terminal, err := termemu.NewGhostty(termemu.Options{
		Cols: cols, Rows: rows,
		ScrollbackBytes: scrollbackBytes, ScrollbackLines: scrollbackLines,
	})
	if err != nil {
		return frame{}, err
	}
	defer func() { _ = terminal.Close() }()

	if err := terminal.Feed(span, termemu.SourceBoundary); err != nil {
		return frame{}, fmt.Errorf("replay: %w", err)
	}
	snapshot, err := terminal.Snapshot()
	if err != nil {
		return frame{}, fmt.Errorf("snapshot: %w", err)
	}

	decoded := frame{
		Cols:         snapshot.Cols,
		Rows:         snapshot.Rows,
		CursorX:      snapshot.Cursor.X,
		CursorY:      snapshot.Cursor.Y,
		PendingWrap:  snapshot.Cursor.PendingWrap,
		CursorHidden: snapshot.Cursor.Hidden,
		Alt:          snapshot.Alt,
		History:      snapshot.History,
	}
	decoded.Cells = make([][]cell, len(snapshot.Cells))
	for row, source := range snapshot.Cells {
		cells := make([]cell, len(source))
		for column, source := range source {
			cells[column] = cell{
				Text:          source.Text,
				Width:         source.Width,
				Bold:          source.Bold,
				Faint:         source.Faint,
				Italic:        source.Italic,
				Strikethrough: source.Strikethrough,
				Inverse:       source.Inverse,
				Blink:         source.Blink,
				Underline:     int(source.Underline),
				Fg:            color{Kind: colorKind(source.Fg), Value: source.Fg.Value},
				Bg:            color{Kind: colorKind(source.Bg), Value: source.Bg.Value},
			}
		}
		decoded.Cells[row] = cells
	}
	decoded.Text = canonicalText(decoded.Cells, decoded.Cols)
	return decoded, nil
}

func colorKind(c termemu.Color) string {
	switch c.Kind {
	case termemu.ColorPalette:
		return "palette"
	case termemu.ColorRGB:
		return "rgb"
	default:
		return "default"
	}
}

// canonicalText matches the Swift side byte for byte: every visible cell,
// U+0020 for an empty narrow cell, nothing extra for a wide continuation, and a
// LF after every row including the last.
func canonicalText(cells [][]cell, cols int) string {
	out := make([]byte, 0, (cols+1)*len(cells))
	for _, row := range cells {
		for index := 0; index < cols; index++ {
			var current cell
			if index < len(row) {
				current = row[index]
			} else {
				current = cell{Width: 1}
			}
			if current.Width == 0 {
				continue
			}
			if current.Text == "" {
				out = append(out, ' ')
				continue
			}
			out = append(out, current.Text...)
		}
		out = append(out, '\n')
	}
	return string(out)
}

func countCells(cells [][]cell) int {
	total := 0
	for _, row := range cells {
		total += len(row)
	}
	return total
}
