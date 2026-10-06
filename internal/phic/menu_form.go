package phic

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

func (c *client) textPrompt(ctx context.Context, title, label, initial string, limit int, validate func(string) error) (string, error) {
	if err := writeAll(c.tty, []byte("\x1b[?2004h")); err != nil {
		return "", err
	}
	defer func() { _ = writeAll(c.tty, []byte("\x1b[?2004l")) }()
	return c.textPromptView(ctx, c.tty, c.tty.Size, title, label, initial, limit, validate)
}

func (c *client) textPromptView(ctx context.Context, t lineTerminal, size func() (int, int, error), title, label, initial string, limit int, validate func(string) error) (string, error) {
	reader := menuReader{allowPaste: true, claimed: c.menuClaims()}
	value, message, drawn := initial, "", false
	dirty, lastCols, lastRows := true, 0, 0
	for {
		cols, rows, err := size()
		if err != nil {
			return "", err
		}
		if cols < 8 || rows < 4 {
			return "", errors.New("phic: terminal too small for input")
		}
		var out strings.Builder
		if drawn {
			out.WriteString("\x1b[3F")
		} else {
			out.WriteString("\r\n")
		}
		out.WriteString("\r\x1b[J")
		out.WriteString(c.color(menuRule("╭─", "Φ  "+title, "╮", cols-1)) + "\r\n")
		field := menuLabel(value) + "▏"
		available := max(1, cols-6-menuCells(label))
		for menuCells(field) > available && field != "" {
			_, n := utf8.DecodeRuneInString(field)
			field = field[n:]
		}
		out.WriteString("│" + menuPad("  "+label+" › "+field, cols-3) + "│\r\n")
		hint := "Enter Save · Esc Cancel · Ctrl-U Clear"
		if message != "" {
			hint = message
		}
		out.WriteString(c.color(menuRule("╰─", hint, "╯", cols-1)) + "\r\n")
		if dirty || cols != lastCols || rows != lastRows {
			if err := writeAll(t, []byte(out.String())); err != nil {
				return "", err
			}
			drawn, lastCols, lastRows = true, cols, rows
		}
		keyCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		key, err := reader.read(keyCtx, t, len(c.servers))
		cancel()
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			dirty = false
			continue
		}
		if err != nil {
			return "", err
		}
		dirty = true
		switch key {
		case "back":
			return "", errDetach
		case "clear":
			value = ""
			message = ""
		case "erase":
			if value != "" {
				_, n := utf8.DecodeLastRuneInString(value)
				value = value[:len(value)-n]
			}
			message = ""
		case "enter":
			if validate != nil {
				if err := validate(value); err != nil {
					message = menuLabel(err.Error())
					continue
				}
			}
			return value, nil
		case "up", "down", "left", "right", "home", "end", "pageup", "pagedown":
		default:
			if utf8.RuneCountInString(value)+utf8.RuneCountInString(key) <= limit {
				value += key
				message = ""
			}
		}
	}
}
