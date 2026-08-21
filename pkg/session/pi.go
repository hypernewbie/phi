package session

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func newPiScanner(file *os.File) *bufio.Scanner {
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	return scanner
}

type PiSessionHeader struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Cwd       string `json:"cwd"`
	Timestamp string `json:"timestamp"`
}

type PiSessionInfo struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type PiMessageContent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type PiMessageInner struct {
	Role       string             `json:"role"`
	Content    []PiMessageContent `json:"content"`
	ToolName   string             `json:"toolName"`
	ToolCallID string             `json:"toolCallId"`
}

type PiMessage struct {
	Type    string         `json:"type"`
	Message PiMessageInner `json:"message"`
}

// PiRPCMessage is one raw Pi/RPC envelope used only to seed RPC resume
// snapshots. It preserves the exact JSON field names Pi emits so the
// downstream rpc.Message mapping stays lossless.
//
// `Content` is the exact JSON value from the source session's `content`
// field; `Details` is optional raw JSON and stays absent when missing;
// `IsError` uses a pointer so both true and false survive round-trips.
type PiRPCMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Details    json.RawMessage `json:"details,omitempty"`
	ToolCallID string          `json:"toolCallId,omitempty"`
	ToolName   string          `json:"toolName,omitempty"`
	IsError    *bool           `json:"isError,omitempty"`
}

// isPiRoleValid identifies the role set the live message_end path can emit
// and that both the legacy and RPC resume formatters keep verbatim.
func isPiRoleValid(role string) bool {
	return role == "user" || role == "assistant" || role == "toolResult"
}

type piTranscriptEntry struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	ParentID *string         `json:"parentId"`
	Message  json.RawMessage `json:"message"`
}

func canonicalPiCWD(cwd string) (string, error) {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return "", fmt.Errorf("pi CWD must be a non-empty absolute path: %q", cwd)
	}
	canonical, err := filepath.Abs(filepath.Clean(cwd))
	if err != nil {
		return "", fmt.Errorf("canonicalize pi CWD %q: %w", cwd, err)
	}
	if !filepath.IsAbs(canonical) {
		return "", fmt.Errorf("canonical pi CWD is not absolute: %q", canonical)
	}
	return canonical, nil
}

func piCWDEqual(left, right string) (bool, error) {
	leftCanonical, err := canonicalPiCWD(left)
	if err != nil {
		return false, err
	}
	rightCanonical, err := canonicalPiCWD(right)
	if err != nil {
		return false, err
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(leftCanonical, rightCanonical), nil
	}
	return leftCanonical == rightCanonical, nil
}

// piSessionDirectory returns the canonical CWD and Pi's encoded session path.
func piSessionDirectory(cwd string) (string, string, error) {
	canonicalCwd, err := canonicalPiCWD(cwd)
	if err != nil {
		return "", "", err
	}
	normalizedCwd := filepath.ToSlash(canonicalCwd)
	normalized := strings.ReplaceAll(strings.Trim(normalizedCwd, "/"), ":", "-")
	projectDirName := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"

	sessionsDir := expandHome("~/.pi/agent/sessions")
	projectPath, err := filepath.Abs(filepath.Join(sessionsDir, projectDirName))
	if err != nil {
		return "", "", fmt.Errorf("canonicalize Pi session directory: %w", err)
	}
	return canonicalCwd, projectPath, nil
}

func readPiSessionHeader(filePath string) (PiSessionHeader, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return PiSessionHeader{}, err
	}
	defer file.Close()

	scanner := newPiScanner(file)
	line, ok, err := scannerLine(scanner)
	if err != nil {
		return PiSessionHeader{}, err
	}
	if !ok {
		return PiSessionHeader{}, fmt.Errorf("Pi session file is empty")
	}
	var header PiSessionHeader
	if err := json.Unmarshal(line, &header); err != nil {
		return PiSessionHeader{}, fmt.Errorf("decode Pi session header: %w", err)
	}
	if header.Type != "session" {
		return PiSessionHeader{}, fmt.Errorf("Pi session header has type %q", header.Type)
	}
	if strings.TrimSpace(header.ID) == "" {
		return PiSessionHeader{}, fmt.Errorf("Pi session header has empty id")
	}
	return header, nil
}

func scannerLine(scanner *bufio.Scanner) ([]byte, bool, error) {
	if scanner.Scan() {
		return append([]byte(nil), scanner.Bytes()...), true, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, false, err
	}
	return nil, false, nil
}

func validatePiSessionFile(canonicalCwd, filePath string) (PiSessionHeader, os.FileInfo, error) {
	absolutePath, err := filepath.Abs(filePath)
	if err != nil {
		return PiSessionHeader{}, nil, err
	}
	info, err := os.Lstat(absolutePath)
	if err != nil {
		return PiSessionHeader{}, nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return PiSessionHeader{}, nil, fmt.Errorf("Pi session path is a symlink: %s", absolutePath)
	}
	if !info.Mode().IsRegular() {
		return PiSessionHeader{}, nil, fmt.Errorf("Pi session path is not a regular file: %s", absolutePath)
	}
	header, err := readPiSessionHeader(absolutePath)
	if err != nil {
		return PiSessionHeader{}, nil, err
	}
	matches, err := piCWDEqual(canonicalCwd, header.Cwd)
	if err != nil {
		return PiSessionHeader{}, nil, err
	}
	if !matches {
		return PiSessionHeader{}, nil, fmt.Errorf("Pi session CWD %q does not match %q", header.Cwd, canonicalCwd)
	}
	return header, info, nil
}

// ListPiSessions scans ~/.pi/agent/sessions/--cwd-- project directory and returns sessions.
func ListPiSessions(cwd string) ([]Session, error) {
	canonicalCwd, projectPath, err := piSessionDirectory(cwd)
	if err != nil {
		return nil, err
	}

	fi, err := os.Stat(projectPath)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Session{}, nil
	}
	if err != nil {
		return nil, err
	}

	files, err := os.ReadDir(projectPath)
	if err != nil {
		return nil, err
	}

	var sessions []Session
	for _, f := range files {
		if f.IsDir() || filepath.Ext(f.Name()) != ".jsonl" {
			continue
		}

		filePath := filepath.Join(projectPath, f.Name())
		header, info, err := validatePiSessionFile(canonicalCwd, filePath)
		if err != nil {
			continue
		}

		title := extractPiSessionTitle(filePath)
		if title == "" {
			shortID := header.ID
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			title = "Pi session " + shortID + " " + info.ModTime().Format("02 Jan 2006")
		}

		absolutePath, err := filepath.Abs(filePath)
		if err != nil {
			continue
		}
		sessions = append(sessions, Session{
			ID:          header.ID,
			Title:       title,
			Cwd:         canonicalCwd,
			Coder:       "pi",
			TimeUpdated: info.ModTime(),
			SessionPath: absolutePath,
		})
	}

	return sessions, nil
}

func extractPiSessionTitle(filePath string) string {
	file, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer file.Close()

	customName := ""
	firstUserMsg := ""

	scanner := newPiScanner(file)
	for scanner.Scan() {
		line := scanner.Bytes()

		var psi PiSessionInfo
		if err := json.Unmarshal(line, &psi); err == nil && psi.Type == "session_info" && psi.Name != "" {
			customName = psi.Name
			break // Found custom name, best possible title
		}

		if firstUserMsg != "" {
			continue
		}

		var pm PiMessage
		if err := json.Unmarshal(line, &pm); err == nil && (pm.Type == "message" || pm.Type == "msg") && len(pm.Message.Content) > 0 && pm.Message.Role == "user" {
			for _, c := range pm.Message.Content {
				if c.Type == "text" && c.Text != "" {
					firstUserMsg = c.Text
					if len(firstUserMsg) > 36 {
						firstUserMsg = firstUserMsg[:36] + "..."
					}
					break
				}
			}
		}
	}

	if customName != "" {
		return customName
	}
	return firstUserMsg
}

// ResolvePiSessionPath returns the exact validated session path for cwd.
func ResolvePiSessionPath(cwd, sessionPath string) (Session, error) {
	if sessionPath == "" {
		return Session{}, fmt.Errorf("Pi session path is empty")
	}
	if !filepath.IsAbs(sessionPath) {
		return Session{}, fmt.Errorf("Pi session path must be absolute: %q", sessionPath)
	}
	sessions, err := ListPiSessions(cwd)
	if err != nil {
		return Session{}, err
	}
	var match Session
	matches := 0
	for _, candidate := range sessions {
		if candidate.SessionPath == sessionPath {
			match = candidate
			matches++
		}
	}
	if matches == 0 {
		return Session{}, fmt.Errorf("Pi session path is not listed for CWD %q: %s", cwd, sessionPath)
	}
	if matches > 1 {
		return Session{}, fmt.Errorf("Pi session path matched multiple sessions: %s", sessionPath)
	}
	return match, nil
}

func findPiSessionByID(cwd, sessionID string) (Session, error) {
	if sessionID == "" {
		return Session{}, fmt.Errorf("Pi session id is empty")
	}
	sessions, err := ListPiSessions(cwd)
	if err != nil {
		return Session{}, err
	}
	var match Session
	matches := 0
	for _, candidate := range sessions {
		if candidate.ID == sessionID {
			match = candidate
			matches++
		}
	}
	if matches == 0 {
		return Session{}, fmt.Errorf("%w for CWD %q: %s", errPiSessionIDNotFound, cwd, sessionID)
	}
	if matches > 1 {
		return Session{}, fmt.Errorf("Pi session id matched multiple sessions: %s", sessionID)
	}
	return match, nil
}

var errPiSessionIDNotFound = errors.New("Pi session id not found")

// GetPiSessionTranscript returns the transcript for one exact validated ID.
func GetPiSessionTranscript(cwd string, sessionID string) ([]Message, error) {
	session, err := findPiSessionByID(cwd, sessionID)
	if err != nil {
		if errors.Is(err, errPiSessionIDNotFound) {
			return []Message{}, nil
		}
		return nil, err
	}
	return GetPiSessionTranscriptForPath(cwd, session.SessionPath)
}

// GetPiSessionTranscriptForPath returns the active branch of an exact session path
// formatted for the legacy HTTP transcript consumer.
func GetPiSessionTranscriptForPath(cwd, sessionPath string) ([]Message, error) {
	resolved, err := ResolvePiSessionPath(cwd, sessionPath)
	if err != nil {
		return nil, err
	}
	payloads, err := readPiSessionRawMessages(resolved.Cwd, resolved.SessionPath)
	if err != nil {
		return nil, err
	}
	return formatPiLegacyMessages(payloads)
}

// GetPiSessionRPCTranscriptForPath returns the active branch of an exact session
// path as raw Pi/RPC envelopes for the resume snapshot. Both legacy and RPC
// callers share the validation/traversal through readPiSessionRawMessages.
func GetPiSessionRPCTranscriptForPath(cwd, sessionPath string) ([]PiRPCMessage, error) {
	resolved, err := ResolvePiSessionPath(cwd, sessionPath)
	if err != nil {
		return nil, err
	}
	payloads, err := readPiSessionRawMessages(resolved.Cwd, resolved.SessionPath)
	if err != nil {
		return nil, err
	}
	return formatPiRPCMessages(payloads)
}

// RevalidatePiSessionPath repeats exact path, regular-file, header, and CWD validation.
func RevalidatePiSessionPath(cwd, sessionPath string) error {
	resolved, err := ResolvePiSessionPath(cwd, sessionPath)
	if err != nil {
		return err
	}
	if resolved.SessionPath != sessionPath {
		return fmt.Errorf("Pi session path changed during validation: %s", sessionPath)
	}
	return nil
}

// rawPiMessagePayload pairs a raw selected `message` JSON payload with the
// ID of its enclosing transcript entry. The shared reader carries EntryID
// into both formatters so an active-branch payload that fails an inner
// unmarshal surfaces `decode Pi message entry <id>: ...` to consumers. The
// no-ID legacy path fills EntryID with the empty string so its tolerant
// skip-on-error policy keeps working unchanged.
type rawPiMessagePayload struct {
	EntryID string
	Payload []byte
}

// readPiSessionRawMessages validates a Pi session file and returns the
// ordered raw `message` JSON payloads of its active branch. Legacy no-ID
// transcripts fall through to a line-by-line scan that yields the same raw
// payloads the legacy formatter previously consumed. The branch traversal,
// duplicate-ID detection, missing-parent detection, and cycle detection all
// live here so legacy and RPC formatters share one source of truth. The
// reader itself does not enforce any inner-shape validation; each
// formatter decides whether a payload is acceptable for its envelope.
func readPiSessionRawMessages(cwd, filePath string) ([]rawPiMessagePayload, error) {
	canonicalCwd, err := canonicalPiCWD(cwd)
	if err != nil {
		return nil, err
	}
	if _, _, err := validatePiSessionFile(canonicalCwd, filePath); err != nil {
		return nil, err
	}

	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	scanner := newPiScanner(file)
	line, ok, err := scannerLine(scanner)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("Pi session file is empty")
	}
	var header PiSessionHeader
	if err := json.Unmarshal(line, &header); err != nil {
		return nil, fmt.Errorf("decode Pi session header: %w", err)
	}
	if header.Type != "session" || strings.TrimSpace(header.ID) == "" {
		return nil, fmt.Errorf("invalid Pi session header")
	}
	matches, err := piCWDEqual(canonicalCwd, header.Cwd)
	if err != nil {
		return nil, err
	}
	if !matches {
		return nil, fmt.Errorf("Pi session CWD %q does not match %q", header.Cwd, canonicalCwd)
	}

	var lines [][]byte
	entries := make([]piTranscriptEntry, 0)
	byID := make(map[string]int)
	var decodeErr error
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		lines = append(lines, raw)

		var entry piTranscriptEntry
		if err := json.Unmarshal(raw, &entry); err != nil {
			if decodeErr == nil {
				decodeErr = fmt.Errorf("decode Pi transcript entry: %w", err)
			}
			continue
		}
		if strings.TrimSpace(entry.ID) == "" {
			continue
		}
		if _, exists := byID[entry.ID]; exists {
			return nil, fmt.Errorf("duplicate Pi transcript entry id: %s", entry.ID)
		}
		byID[entry.ID] = len(entries)
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return rawPiLegacyMessagePayloads(lines), nil
	}
	if decodeErr != nil {
		return nil, decodeErr
	}

	leaf := len(entries) - 1
	path := make([]int, 0, len(entries))
	visited := make(map[int]bool)
	for {
		if visited[leaf] {
			return nil, fmt.Errorf("cycle in Pi transcript parent chain at %s", entries[leaf].ID)
		}
		visited[leaf] = true
		path = append(path, leaf)
		parentID := entries[leaf].ParentID
		if parentID == nil {
			break
		}
		parent, exists := byID[*parentID]
		if !exists {
			return nil, fmt.Errorf("missing Pi transcript parent: %s", *parentID)
		}
		leaf = parent
	}
	for left, right := 0, len(path)-1; left < right; left, right = left+1, right-1 {
		path[left], path[right] = path[right], path[left]
	}

	payloads := make([]rawPiMessagePayload, 0, len(path))
	for _, index := range path {
		entry := entries[index]
		if entry.Type != "message" && entry.Type != "msg" {
			continue
		}
		if len(entry.Message) == 0 {
			return nil, fmt.Errorf("Pi message entry %s has no message payload", entry.ID)
		}
		// The reader returns the raw selected `message` JSON verbatim and
		// carries the enclosing entry's ID so each formatter can surface
		// `decode Pi message entry <id>: ...` when its own envelope shape
		// rejects the payload. Forcing PiMessageInner array-shape
		// validation here would drop a valid resumed RPC tool result whose
		// content is a singleton object `{type:"text",text:"..."}`, so the
		// shape check is delegated to formatPiLegacyMessages instead.
		payloads = append(payloads, rawPiMessagePayload{
			EntryID: entry.ID,
			Payload: append([]byte(nil), entry.Message...),
		})
	}
	return payloads, nil
}

// rawPiLegacyMessagePayloads extracts the raw `message` JSON payload from
// each legacy line in file order. Malformed lines and non-message entries
// are tolerated exactly as the previous parsePiLegacyLines did. Each
// returned payload carries an empty EntryID so the legacy formatter keeps
// its tolerant skip-on-error policy for no-ID rows unchanged.
func rawPiLegacyMessagePayloads(lines [][]byte) []rawPiMessagePayload {
	payloads := make([]rawPiMessagePayload, 0)
	for _, line := range lines {
		var envelope struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if err := json.Unmarshal(line, &envelope); err != nil {
			continue
		}
		if envelope.Type != "message" && envelope.Type != "msg" {
			continue
		}
		if len(envelope.Message) == 0 {
			continue
		}
		payloads = append(payloads, rawPiMessagePayload{Payload: envelope.Message})
	}
	return payloads
}

// formatPiLegacyMessages unmarshals each raw payload into PiMessageInner and
// runs it through the unchanged formatPiMessage. Its omission rule (a
// role-valid payload whose formatted Text is empty is dropped) is preserved
// here so the legacy HTTP transcript consumer sees byte-for-byte equivalent
// output. An active-branch payload that cannot unmarshal into PiMessageInner
// is surfaced as `decode Pi message entry <id>: ...` exactly as the
// pre-refactor parser did; no-ID legacy rows stay tolerated and are skipped
// silently when their inner shape does not match.
func formatPiLegacyMessages(payloads []rawPiMessagePayload) ([]Message, error) {
	messages := make([]Message, 0, len(payloads))
	for _, payload := range payloads {
		var inner PiMessageInner
		if err := json.Unmarshal(payload.Payload, &inner); err != nil {
			if payload.EntryID == "" {
				continue
			}
			return nil, fmt.Errorf("decode Pi message entry %s: %w", payload.EntryID, err)
		}
		if message, ok := formatPiMessage(inner); ok {
			messages = append(messages, message)
		}
	}
	return messages, nil
}

// formatPiRPCMessages unmarshals each raw payload into PiRPCMessage, deep
// copies every raw-JSON field, and keeps every role-valid message verbatim
// (including empty content) so live message_end semantics carry over into
// the resumed snapshot. Content is preserved exactly as raw JSON so a
// singleton toolResult object `{type:"text",text:"singleton output"}` flows
// through untouched. An active-branch payload that cannot unmarshal into
// PiRPCMessage is surfaced as `decode Pi message entry <id>: ...` so RPC
// consumers can locate the offending entry; no-ID legacy rows stay
// tolerated and are skipped silently when their outer envelope is malformed.
func formatPiRPCMessages(payloads []rawPiMessagePayload) ([]PiRPCMessage, error) {
	messages := make([]PiRPCMessage, 0, len(payloads))
	for _, payload := range payloads {
		var msg PiRPCMessage
		if err := json.Unmarshal(payload.Payload, &msg); err != nil {
			if payload.EntryID == "" {
				continue
			}
			return nil, fmt.Errorf("decode Pi message entry %s: %w", payload.EntryID, err)
		}
		if !isPiRoleValid(msg.Role) {
			continue
		}
		if msg.Content != nil {
			msg.Content = append(json.RawMessage(nil), msg.Content...)
		}
		if msg.Details != nil {
			msg.Details = append(json.RawMessage(nil), msg.Details...)
		}
		if msg.IsError != nil {
			value := *msg.IsError
			msg.IsError = &value
		}
		messages = append(messages, msg)
	}
	return messages, nil
}

func formatPiMessage(inner PiMessageInner) (Message, bool) {
	if inner.Role != "user" && inner.Role != "assistant" && inner.Role != "toolResult" {
		return Message{}, false
	}
	var sb strings.Builder
	hasHeader := false
	if inner.Role == "toolResult" {
		toolName := inner.ToolName
		if toolName == "" {
			toolName = "tool"
		}
		sb.WriteString(fmt.Sprintf("> **Tool Output (%s):**\n\n", toolName))
		hasHeader = true
	}
	for _, content := range inner.Content {
		if content.Type == "text" {
			if sb.Len() > 0 && !hasHeader {
				sb.WriteString("\n\n")
			}
			sb.WriteString(content.Text)
			hasHeader = false
		} else if content.Type == "thinking" && content.Thinking != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n\n")
			}
			lines := strings.Split(content.Thinking, "\n")
			sb.WriteString("> **Thinking:**\n")
			for _, line := range lines {
				sb.WriteString("> " + line + "\n")
			}
		} else if content.Type == "toolCall" || content.Type == "tool_use" {
			if sb.Len() > 0 {
				sb.WriteString("\n\n")
			}
			toolName := content.Name
			if toolName == "" {
				toolName = "tool"
			}
			sb.WriteString(fmt.Sprintf("*(Used tool: %s)*", toolName))
			if len(content.Arguments) > 0 {
				var argsMap map[string]interface{}
				if err := json.Unmarshal(content.Arguments, &argsMap); err == nil {
					if cmd, ok := argsMap["command"].(string); ok {
						sb.WriteString(fmt.Sprintf("\n```bash\n%s\n```", cmd))
					} else if code, ok := argsMap["content"].(string); ok {
						sb.WriteString(fmt.Sprintf("\n```\n%s\n```", code))
					} else if pretty, err := json.MarshalIndent(argsMap, "", "  "); err == nil {
						sb.WriteString(fmt.Sprintf("\n```json\n%s\n```", string(pretty)))
					}
				} else {
					sb.WriteString(fmt.Sprintf("\n```json\n%s\n```", string(content.Arguments)))
				}
			}
		}
	}
	txt := strings.TrimSpace(sb.String())
	if txt == "" {
		return Message{}, false
	}
	return Message{Role: inner.Role, Text: txt}, true
}
