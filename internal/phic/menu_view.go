package phic

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/width"
)

// Client views own a small inline region, not the backend's screen. Selection
// and search repaint that region in place; no alternate screen or VT model.
func menuLabel(text string) string {
	var out strings.Builder
	for _, r := range text {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			quoted := strconv.QuoteRuneToASCII(r)
			out.WriteString(quoted[1 : len(quoted)-1])
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func cellWidth(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) {
		return 0
	}
	switch width.LookupRune(r).Kind() {
	case width.EastAsianWide, width.EastAsianFullwidth:
		return 2
	}
	return 1
}

func clipMenu(text string, columns int) string {
	if columns <= 0 {
		return ""
	}
	used := 0
	for at, r := range text {
		used += cellWidth(r)
		if used > columns {
			return text[:at]
		}
	}
	return text
}

// A complete key is decoded before it can act on a view. Terminal replies,
// releases, and bracketed-paste contents are never navigation commands.
type menuReader struct {
	seq         []byte
	paste       bool
	allowPaste  bool
	pasteSpaces bool
	prefix      bool
	claimed     map[[2]int]bool
	mouse       int
	control     byte
	controlEsc  bool
}

func (reader *menuReader) read(ctx context.Context, t lineTerminal, servers int) (string, error) {
	seq, paste := reader.seq, reader.paste
	defer func() { reader.seq, reader.paste = seq, paste }()
	var b [1]byte
	for {
		readCtx := ctx
		cancel := func() {}
		if len(seq) > 0 {
			readCtx, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
		}
		n, err := t.ReadContext(readCtx, b[:])
		cancel()
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			back := len(seq) == 1 && seq[0] == 0x1b
			seq = nil
			if back {
				return "back", nil
			}
			continue
		}
		if err != nil {
			return "", err
		}
		if n == 0 {
			return "", io.EOF
		}
		key := b[0]
		if reader.mouse > 0 {
			reader.mouse--
			continue
		}
		if reader.control != 0 {
			if key == 0x18 || key == 0x1a || (reader.control == ']' && key == 7) || (reader.controlEsc && key == '\\') {
				reader.control = 0
			}
			reader.controlEsc = key == 0x1b
			continue
		}
		if len(seq) > 0 {
			seq = append(seq, key)
			if seq[0] != 0x1b {
				if utf8.FullRune(seq) {
					r, _ := utf8.DecodeRune(seq)
					if r != utf8.RuneError && (!paste || reader.allowPaste) {
						seq = nil
						return string(r), nil
					}
					seq = nil
				}
				continue
			}
			if len(seq) == 2 {
				if key == ']' || key == 'P' || key == '_' || key == '^' {
					reader.control, reader.controlEsc = key, false
				}
				if key != '[' && key != 'O' {
					seq = nil
				}
				continue
			}
			if key < 0x40 || key > 0x7e {
				if len(seq) > 128 {
					seq = nil
				}
				continue
			}
			s := string(seq)
			seq = nil
			if s == "\x1b[200~" {
				paste = true
				continue
			}
			if s == "\x1b[201~" {
				paste = false
				continue
			}
			if paste {
				continue
			}
			if s == "\x1b[M" {
				reader.mouse = 3
				continue
			}
			switch s {
			case "\x1b[A", "\x1bOA":
				return "up", nil
			case "\x1b[B", "\x1bOB":
				return "down", nil
			case "\x1b[C", "\x1bOC":
				return "right", nil
			case "\x1b[D", "\x1bOD":
				return "left", nil
			case "\x1b[3~":
				return "delete", nil
			case "\x1b[5~":
				return "pageup", nil
			case "\x1b[6~":
				return "pagedown", nil
			case "\x1b[H", "\x1bOH", "\x1b[1~":
				return "home", nil
			case "\x1b[F", "\x1bOF", "\x1b[4~":
				return "end", nil
			}
			code, mods, event, ok := encodedKey([]byte(s))
			if !ok {
				continue
			}
			identity := [2]int{code, mods}
			if event == 3 {
				delete(reader.claimed, identity)
				continue
			}
			if reader.claimed != nil {
				reader.claimed[identity] = true
			}
			if mods == 5 && event == 1 && code >= '1' && code <= '9' && code-'0' <= servers {
				return "", viewCommand(byte(code))
			}
			if mods == 5 && code == 93 {
				reader.prefix = true
				continue
			}
			if mods == 5 && code == 'a' {
				return "select-all", nil
			}
			if mods == 5 && code == 'u' {
				return "clear", nil
			}
			if mods != 1 {
				continue
			}
			switch code {
			case 57349:
				return "delete", nil
			case 57350:
				return "left", nil
			case 57351:
				return "right", nil
			case 57352:
				return "up", nil
			case 57353:
				return "down", nil
			case 57354:
				return "pageup", nil
			case 57355:
				return "pagedown", nil
			case 57356:
				return "home", nil
			case 57357:
				return "end", nil
			}
			if code > 0 && code < utf8.MaxRune {
				key = 0
				if code >= 32 && code != 127 {
					if reader.prefix {
						reader.prefix = false
						if code == 'b' || (code >= '1' && code <= '9' && code-'0' <= servers) {
							return "", viewCommand(byte(code))
						}
					}
					return string(rune(code)), nil
				}
				key = byte(code)
			} else {
				continue
			}
		}
		if key == 0x1b {
			seq = []byte{key}
			continue
		}
		if !paste && key == 0x1d {
			reader.prefix = true
			continue
		}
		if !paste && reader.prefix {
			reader.prefix = false
			if key == 'b' || (key >= '1' && key <= '9' && int(key-'0') <= servers) {
				return "", viewCommand(key)
			}
		}
		if paste {
			if reader.allowPaste && reader.pasteSpaces && (key == '\r' || key == '\n' || key == '\t') {
				return " ", nil
			}
			if reader.allowPaste && key >= 32 && key < utf8.RuneSelf {
				return string(key), nil
			}
			if reader.allowPaste && key >= utf8.RuneSelf {
				seq = []byte{key}
			}
			continue
		}
		switch key {
		case 1:
			return "select-all", nil
		case 3, 4, 27:
			return "back", nil
		case '\r', '\n':
			return "enter", nil
		case 21:
			return "clear", nil
		case 8, 127:
			return "erase", nil
		case '\t':
			return "down", nil
		}
		if key >= utf8.RuneSelf {
			seq = []byte{key}
			continue
		}
		if key >= 32 {
			return string(key), nil
		}
	}
}

type menuOptions struct {
	cursor      *int
	actions     []string
	help        string
	description []string
	section     func(int) string
	chrome      func(string) string
}
type menuAction struct{ key string }

func (a menuAction) Error() string { return "phic: menu action " + a.key }

func menuCells(text string) int {
	n := 0
	for _, r := range text {
		n += cellWidth(r)
	}
	return n
}
func menuPad(text string, columns int) string {
	text = clipMenu(text, columns)
	return text + strings.Repeat(" ", max(0, columns-menuCells(text)))
}
func menuRule(left, text, right string, columns int) string {
	text = clipMenu(menuLabel(text), max(0, columns-menuCells(left+right)-2))
	line := left + " " + text + " "
	return clipMenu(line+strings.Repeat("─", max(0, columns-menuCells(line+right)))+right, columns)
}

func (c *client) selectionView(ctx context.Context, t lineTerminal, size func() (int, int, error), title string, items []string, paint func(int, string, bool) string) (int, error) {
	return c.selectionViewWith(ctx, t, size, title, items, paint, menuOptions{})
}
func (c *client) selectionViewWith(ctx context.Context, t lineTerminal, size func() (int, int, error), title string, items []string, paint func(int, string, bool) string, options menuOptions) (int, error) {
	cursor, top, drawn := 0, 0, 0
	if title == "Servers" {
		cursor = max(0, c.serverIndex)
	}
	if options.cursor != nil {
		cursor = max(0, *options.cursor)
	}
	reader := menuReader{claimed: c.menuClaims()}
	dirty, lastCols, lastRows := true, 0, 0
	query, number := "", ""
	search := false
	for {
		cols, rows, err := size()
		if err != nil {
			return 0, err
		}
		if cols < 8 || rows < 5 {
			return 0, fmt.Errorf("phic: terminal too small for selection")
		}
		var visible []int
		for i, item := range items {
			if strings.Contains(strings.ToLower(item), strings.ToLower(query)) {
				visible = append(visible, i)
			}
		}
		if cursor >= len(visible) {
			cursor = max(0, len(visible)-1)
		}
		bar, selectedRow := c.serverBarRows(cols - 1)
		// A mini bar must not consume the menu, or hide the active server
		// when its box lies beyond the visible rows. The picker still lists
		// every saved server in desktop order.
		barRows := max(0, min(2, rows-5))
		if len(bar) > barRows {
			visibleBar := append([]string{}, bar[:barRows]...)
			if barRows > 0 && selectedRow >= barRows {
				visibleBar[barRows-1] = bar[selectedRow]
			}
			bar = visibleBar
		}
		descriptions := options.description[:min(len(options.description), max(0, rows-len(bar)-5))]
		perPage := max(1, rows-len(bar)-4-len(descriptions))
		if cursor < top {
			top = cursor
		}
		if cursor >= top+perPage {
			top = cursor - perPage + 1
		}
		var out strings.Builder
		if drawn > 0 {
			fmt.Fprintf(&out, "\x1b[%dF", drawn)
		} else {
			out.WriteString("\r\n")
		}
		out.WriteString("\r\x1b[J")
		for _, line := range bar {
			out.WriteString(line + "\r\n")
		}
		chrome := c.color
		if options.chrome != nil {
			chrome = options.chrome
		}
		out.WriteString(chrome(menuRule("╭─", title, "╮", cols-1)) + "\r\n")
		for _, description := range descriptions {
			out.WriteString("│" + menuPad("  "+menuLabel(description), cols-3) + "│\r\n")
		}
		filter := "  ↑↓ Select · Enter Open · / Search · Ctrl-] b Servers"
		if search || query != "" {
			filter = "  Search: " + query
		}
		if number != "" {
			filter = "  Choose: " + number
		}
		out.WriteString("│" + menuPad(filter, cols-3) + "│\r\n")
		end := min(len(visible), top+perPage)
		for pos := top; pos < end; pos++ {
			i := visible[pos]
			marker := "  "
			if pos == cursor {
				marker = "› "
			}
			label := menuLabel(items[i])
			if options.section != nil {
				label = options.section(i) + " · " + label
			}
			line := "│" + menuPad(fmt.Sprintf(" %s%d  %s", marker, i+1, label), cols-3) + "│"
			if paint != nil {
				line = paint(i, line, pos == cursor)
			} else if s := c.activeServer(); s != nil {
				line = themeText(s.identity.Theme, line, pos == cursor)
			}
			out.WriteString(line + "\r\n")
		}
		if len(visible) == 0 {
			out.WriteString("│" + menuPad("  No matches", cols-3) + "│\r\n")
		}
		help := "↑↓ Select · Enter Open · / Search · Esc Back"
		if options.help != "" {
			help = options.help
		}
		out.WriteString(chrome(menuRule("╰─", help, "╯", cols-1)) + "\r\n")
		drawn = len(bar) + 3 + len(descriptions) + max(1, end-top)
		if dirty || cols != lastCols || rows != lastRows {
			if err := writeAll(t, []byte(out.String())); err != nil {
				return 0, err
			}
			lastCols, lastRows = cols, rows
		}
		// A resize refreshes the inline region without waiting for another key.
		keyCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		key, err := reader.read(keyCtx, t, len(c.servers))
		cancel()
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			dirty = false
			continue
		}
		if err != nil {
			return 0, err
		}
		dirty = true
		if !search {
			for _, action := range options.actions {
				if key == action {
					index := -1
					if len(visible) > 0 {
						index = visible[cursor]
					}
					return index, menuAction{key: key}
				}
			}
		}
		switch key {
		case "back":
			if search || query != "" {
				search = false
				query = ""
				cursor = 0
				number = ""
				continue
			}
			return 0, errDetach
		case "left":
			return 0, errDetach
		case "clear":
			query, number = "", ""
			cursor = 0
		case "up":
			cursor = max(0, cursor-1)
			number = ""
		case "down":
			cursor = min(max(0, len(visible)-1), cursor+1)
			number = ""
		case "pageup":
			cursor = max(0, cursor-perPage)
			number = ""
		case "pagedown":
			cursor = min(max(0, len(visible)-1), cursor+perPage)
			number = ""
		case "home":
			cursor = 0
			number = ""
		case "end":
			cursor = max(0, len(visible)-1)
			number = ""
		case "enter":
			if number != "" {
				n, _ := strconv.Atoi(number)
				for _, i := range visible {
					if i == n-1 {
						return i, nil
					}
				}
				number = ""
			} else if len(visible) > 0 {
				return visible[cursor], nil
			}
		case "erase":
			if number != "" {
				number = number[:len(number)-1]
			} else if query != "" {
				_, n := utf8.DecodeLastRuneInString(query)
				query = query[:len(query)-n]
				cursor = 0
			}
		default:
			if !search && key == "q" {
				return 0, errDetach
			}
			if !search && key == "n" {
				cursor = min(max(0, len(visible)-1), cursor+perPage)
				continue
			}
			if !search && key == "p" {
				cursor = max(0, cursor-perPage)
				continue
			}
			if !search && key == "/" {
				search = true
				number = ""
				continue
			}
			if !search && key >= "0" && key <= "9" {
				if len(number) < 9 {
					number += key
				}
				continue
			}
			if utf8.RuneCountInString(query) < 128 {
				query += key
				search = true
				cursor = 0
				number = ""
			}
		}
	}
}
