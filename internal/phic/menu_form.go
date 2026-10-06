package phic

import (
	"context"
	"errors"
	"strings"
	"time"
)

type formOptions struct {
	placeholder string
	selectAll   bool
	pasteSpaces bool
	submit      func(string) string
	chrome      func(string) string
}

func (c *client) textPrompt(ctx context.Context, title, label, initial string, limit int, validate func(string) error) (string, error) {
	return c.textPromptWith(ctx, title, label, initial, limit, validate, formOptions{})
}
func (c *client) textPromptWith(ctx context.Context, title, label, initial string, limit int, validate func(string) error, options formOptions) (string, error) {
	if err := writeAll(c.tty, []byte("\x1b[?2004h")); err != nil {
		return "", err
	}
	defer func() { _ = writeAll(c.tty, []byte("\x1b[?2004l")) }()
	return c.textFormView(ctx, c.tty, c.tty.Size, title, label, initial, limit, validate, options)
}
func (c *client) textPromptView(ctx context.Context, t lineTerminal, size func() (int, int, error), title, label, initial string, limit int, validate func(string) error) (string, error) {
	return c.textFormView(ctx, t, size, title, label, initial, limit, validate, formOptions{})
}
func (c *client) textFormView(ctx context.Context, t lineTerminal, size func() (int, int, error), title, label, initial string, limit int, validate func(string) error, options formOptions) (string, error) {
	reader := menuReader{allowPaste: true, pasteSpaces: options.pasteSpaces, claimed: c.menuClaims()}
	value := []rune(initial)
	cursor := len(value)
	selected := options.selectAll
	message, drawn, dirty := "", false, true
	lastCols, lastRows := 0, 0
	for {
		cols, rows, err := size()
		if err != nil {
			return "", err
		}
		if cols < 8 || rows < 4 {
			return "", errors.New("phic: terminal too small for input")
		}
		if dirty || cols != lastCols || rows != lastRows {
			var out strings.Builder
			if drawn {
				out.WriteString("\x1b[3F")
			} else {
				out.WriteString("\r\n")
			}
			out.WriteString("\r\x1b[J")
			paint := c.color
			if options.chrome != nil {
				paint = options.chrome
			}
			if title == "Add Phi server" {
				paint = pickerText
			}
			out.WriteString(paint(menuRule("╭─", title, "╮", cols-1)) + "\r\n")
			field := menuLabel(string(value[:cursor])) + "▏" + menuLabel(string(value[cursor:]))
			if len(value) == 0 && options.placeholder != "" {
				field = "▏" + options.placeholder
			}
			prefix := clipMenu("  "+label+" › ", max(0, cols-4))
			available := max(1, cols-3-menuCells(prefix))
			start := 0
			for menuCells(menuLabel(string(value[start:cursor]))) >= available && start < cursor {
				start++
			}
			if start > 0 {
				field = menuLabel(string(value[start:cursor])) + "▏" + menuLabel(string(value[cursor:]))
			}
			field = clipMenu(field, available)
			padding := strings.Repeat(" ", max(0, cols-3-menuCells(prefix+field)))
			if selected && osColorEnabled() {
				field = "\x1b[7m" + field + "\x1b[0m"
			}
			line := prefix + field + padding
			out.WriteString("│" + line + "│\r\n")
			submit := "Save"
			if options.submit != nil {
				submit = options.submit(string(value))
			}
			hint := "Cancel · Enter " + submit + " · Ctrl-A Select all · Ctrl-U Clear"
			if message != "" {
				hint = message
			}
			out.WriteString(paint(menuRule("╰─", hint, "╯", cols-1)) + "\r\n")
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
		eraseSelection := func() {
			if selected {
				value = nil
				cursor = 0
				selected = false
			}
		}
		switch key {
		case "back":
			return "", errDetach
		case "select-all":
			selected = true
		case "clear":
			value = nil
			cursor = 0
			selected = false
			message = ""
		case "erase":
			if selected {
				eraseSelection()
			} else if cursor > 0 {
				value = append(value[:cursor-1], value[cursor:]...)
				cursor--
			}
			message = ""
		case "delete":
			if selected {
				eraseSelection()
			} else if cursor < len(value) {
				value = append(value[:cursor], value[cursor+1:]...)
			}
			message = ""
		case "left":
			if selected {
				cursor = 0
			} else {
				cursor = max(0, cursor-1)
			}
			selected = false
		case "right":
			if selected {
				cursor = len(value)
			} else {
				cursor = min(len(value), cursor+1)
			}
			selected = false
		case "home":
			cursor = 0
			selected = false
		case "end":
			cursor = len(value)
			selected = false
		case "enter":
			if validate != nil {
				if err := validate(string(value)); err != nil {
					message = menuLabel(err.Error())
					continue
				}
			}
			return string(value), nil
		case "up", "down", "pageup", "pagedown":
		default:
			incoming := []rune(key)
			n := len(value)
			if selected {
				n = 0
			}
			if n+len(incoming) <= limit {
				eraseSelection()
				tail := append([]rune{}, value[cursor:]...)
				value = append(value[:cursor], incoming...)
				value = append(value, tail...)
				cursor += len(incoming)
				message = ""
			}
		}
	}
}
