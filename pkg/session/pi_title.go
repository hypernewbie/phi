package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

const maxPiTitleRecordBytes = 4 * 1024 * 1024

var (
	errPiTitleRecordTooLarge = errors.New("Pi title record exceeds 4 MiB")
	piSkillHeader            = regexp.MustCompile(`^<skill[ \t]+name="([^"]+)"[ \t]+location="([^"]+)"[ \t]*>$`)
)

// PiTitleState is the minimal reduced title state shared by static extraction
// and incremental Pi session readers.
type PiTitleState struct {
	Name   string
	Prompt string
}

// Title resolves the native name before the first useful request fallback.
func (s PiTitleState) Title() string {
	if s.Name != "" {
		return s.Name
	}
	return s.Prompt
}

// applyRecord reduces one complete JSONL record. A malformed record is
// reported to the caller and leaves both title fields unchanged.
func (s *PiTitleState) applyRecord(record []byte) error {
	var entry struct {
		Type    string          `json:"type"`
		Name    json.RawMessage `json:"name"`
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(record, &entry); err != nil {
		return fmt.Errorf("decode Pi title record: %w", err)
	}

	switch entry.Type {
	case "session_info":
		name := bytes.TrimSpace(entry.Name)
		if len(name) == 0 || bytes.Equal(name, []byte("null")) {
			s.Name = ""
			return nil
		}
		var value string
		if err := json.Unmarshal(name, &value); err != nil {
			// A non-string name is malformed metadata, not a clear.
			return nil
		}
		s.Name = strings.TrimSpace(value)
	case "message", "msg":
		if s.Prompt != "" || len(entry.Message) == 0 {
			return nil
		}
		var message struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(entry.Message, &message); err != nil {
			return fmt.Errorf("decode Pi title message: %w", err)
		}
		if message.Role == "user" {
			s.Prompt = PiPromptTitle(message.Content)
		}
	}
	return nil
}

// PiPromptTitle extracts a compact title from Pi's raw user-content value.
// Content may be a string or an ordered array of text blocks.
func PiPromptTitle(content json.RawMessage) string {
	value := bytes.TrimSpace(content)
	if len(value) == 0 {
		return ""
	}

	var request string
	switch value[0] {
	case '"':
		if err := json.Unmarshal(value, &request); err != nil {
			return ""
		}
	case '[':
		var blocks []json.RawMessage
		if err := json.Unmarshal(value, &blocks); err != nil {
			return ""
		}
		var joined strings.Builder
		foundText := false
		for _, rawBlock := range blocks {
			var block struct {
				Type string          `json:"type"`
				Text json.RawMessage `json:"text"`
			}
			if err := json.Unmarshal(rawBlock, &block); err != nil || block.Type != "text" {
				continue
			}
			var text string
			if len(block.Text) == 0 || json.Unmarshal(block.Text, &text) != nil {
				continue
			}
			if foundText {
				joined.WriteByte('\n')
			}
			joined.WriteString(text)
			foundText = true
		}
		request = joined.String()
	default:
		return ""
	}

	return cleanPiRequest(request)
}

func cleanPiRequest(request string) string {
	request = strings.ReplaceAll(request, "\r\n", "\n")
	request = strings.ReplaceAll(request, "\r", "\n")

	for {
		request = strings.TrimLeftFunc(request, unicode.IsSpace)
		remaining, matched, incomplete := stripLeadingPiSkillWrapper(request)
		if matched {
			if incomplete {
				return ""
			}
			request = remaining
			continue
		}
		remaining, matched = stripLeadingRawPiSkill(request)
		if matched {
			request = remaining
			continue
		}
		break
	}

	return truncatePiPrompt(strings.Join(strings.Fields(request), " "))
}

func stripLeadingPiSkillWrapper(request string) (remaining string, matched, incomplete bool) {
	header, body, hasBody := strings.Cut(request, "\n")
	attributes := piSkillHeader.FindStringSubmatch(header)
	if attributes == nil || strings.TrimSpace(attributes[1]) == "" || strings.TrimSpace(attributes[2]) == "" {
		return request, false, false
	}
	if !hasBody {
		return "", true, true
	}

	for {
		line, rest, hasMore := strings.Cut(body, "\n")
		if strings.TrimSpace(line) == "</skill>" {
			return rest, true, false
		}
		if !hasMore {
			break
		}
		body = rest
	}
	return "", true, true
}

func stripLeadingRawPiSkill(request string) (remaining string, matched bool) {
	const prefix = "/skill:"
	if !strings.HasPrefix(request, prefix) {
		return request, false
	}
	nameAndRest := request[len(prefix):]
	if nameAndRest == "" {
		return request, false
	}
	boundary := strings.IndexFunc(nameAndRest, unicode.IsSpace)
	if boundary == 0 {
		return request, false
	}
	if boundary < 0 {
		return "", true
	}
	return strings.TrimLeftFunc(nameAndRest[boundary:], unicode.IsSpace), true
}

func truncatePiPrompt(request string) string {
	codePoints := 0
	for index := range request {
		if codePoints == 36 {
			return request[:index] + "..."
		}
		codePoints++
	}
	return request
}

// piRecordDecoder frames complete JSONL records without allowing an
// unfinished record to grow beyond maxPiTitleRecordBytes. Oversized records
// are discarded through their newline so subsequent records remain usable.
type piRecordDecoder struct {
	pending    []byte
	discarding bool
}

// Feed adds bytes to the decoder. final permits one unterminated final record;
// live readers pass false so they commit only newline-terminated records.
// consume must process the record synchronously and must not retain its slice.
func (d *piRecordDecoder) Feed(data []byte, final bool, consume func([]byte) error) error {
	var warning error
	for len(data) > 0 {
		newline := bytes.IndexByte(data, '\n')
		segment := data
		terminated := newline >= 0
		if terminated {
			segment = data[:newline]
		}

		if !d.discarding && !d.append(segment) {
			d.pending = nil
			d.discarding = true
		}
		if !terminated {
			break
		}
		if d.discarding {
			if warning == nil {
				warning = errPiTitleRecordTooLarge
			}
			d.discarding = false
			d.pending = nil
		} else if err := d.consumePending(consume); err != nil && warning == nil {
			warning = err
		}
		data = data[newline+1:]
	}

	if final {
		if d.discarding {
			if warning == nil {
				warning = errPiTitleRecordTooLarge
			}
			d.discarding = false
			d.pending = nil
		} else if err := d.consumePending(consume); err != nil && warning == nil {
			warning = err
		}
	}
	return warning
}

func (d *piRecordDecoder) append(data []byte) bool {
	if len(data) > maxPiTitleRecordBytes-len(d.pending) {
		return false
	}
	needed := len(d.pending) + len(data)
	if needed > cap(d.pending) {
		capacity := min(max(cap(d.pending)*2, 64*1024, needed), maxPiTitleRecordBytes)
		grown := make([]byte, len(d.pending), capacity)
		copy(grown, d.pending)
		d.pending = grown
	}
	d.pending = append(d.pending, data...)
	return true
}

func (d *piRecordDecoder) consumePending(consume func([]byte) error) error {
	if len(bytes.TrimSpace(d.pending)) == 0 {
		d.pending = d.pending[:0]
		return nil
	}
	var err error
	if consume != nil {
		err = consume(d.pending)
	}
	d.pending = d.pending[:0]
	return err
}
