package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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

// ListPiSessions scans ~/.pi/agent/sessions/--cwd-- project directory and returns sessions
func ListPiSessions(cwd string) ([]Session, error) {
	if cwd == "" {
		return []Session{}, nil
	}

	// 1. Encode CWD to double-dash project name.
	// Normalize to forward slashes first, then replace both ":" and "/" with "-"
	// so Windows paths like "C:\code\phi" → "--C--code-phi--" match what Pi stores.
	normalizedCwd := filepath.ToSlash(cwd)
	normalized := strings.ReplaceAll(strings.Trim(normalizedCwd, "/"), ":", "-")
	projectDirName := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"
	
	sessionsDir := expandHome("~/.pi/agent/sessions")
	projectPath := filepath.Join(sessionsDir, projectDirName)
	
	fi, err := os.Stat(projectPath)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Session{}, nil
	}

	files, err := os.ReadDir(projectPath)
	if err != nil {
		return nil, err
	}

	var sessions []Session

	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}

		filePath := filepath.Join(projectPath, f.Name())
		info, err := f.Info()
		if err != nil {
			continue
		}

		sessionID := strings.TrimSuffix(f.Name(), ".jsonl")
		// Extract UUID suffix if filename starts with timestamp
		if idx := strings.Index(sessionID, "_"); idx != -1 {
			sessionID = sessionID[idx+1:]
		}

		title := extractPiSessionTitle(filePath)
		if title == "" {
			shortID := sessionID
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			title = "Pi session " + shortID + " " + info.ModTime().Format("02 Jan 2006")
		}

		sessions = append(sessions, Session{
			ID:          sessionID,
			Title:       title,
			Cwd:         cwd,
			Coder:       "pi",
			TimeUpdated: info.ModTime(),
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
		line := scanner.Text()

		var psi PiSessionInfo
		if err := json.Unmarshal([]byte(line), &psi); err == nil && psi.Type == "session_info" && psi.Name != "" {
			customName = psi.Name
			break // Found custom name, best possible title
		}

		if firstUserMsg != "" {
			continue
		}

		var pm PiMessage
		if err := json.Unmarshal([]byte(line), &pm); err == nil && (pm.Type == "message" || pm.Type == "msg") && len(pm.Message.Content) > 0 && pm.Message.Role == "user" {
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

func GetPiSessionTranscript(cwd string, sessionID string) ([]Message, error) {
	normalizedCwd := filepath.ToSlash(cwd)
	normalized := strings.ReplaceAll(strings.Trim(normalizedCwd, "/"), ":", "-")
	projectDirName := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"
	
	sessionsDir := expandHome("~/.pi/agent/sessions")
	projectPath := filepath.Join(sessionsDir, projectDirName)

	fi, err := os.Stat(projectPath)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Message{}, nil
	}

	files, err := os.ReadDir(projectPath)
	if err != nil {
		return nil, err
	}

	var matchedFile string
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
			continue
		}
		nameNoExt := strings.TrimSuffix(f.Name(), ".jsonl")
		if nameNoExt == sessionID || strings.HasSuffix(nameNoExt, "_"+sessionID) {
			matchedFile = filepath.Join(projectPath, f.Name())
			break
		}
	}

	if matchedFile == "" {
		return []Message{}, nil
	}

	file, err := os.Open(matchedFile)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var messages []Message
	scanner := newPiScanner(file)
	for scanner.Scan() {
		line := scanner.Text()

		var pm PiMessage
		if err := json.Unmarshal([]byte(line), &pm); err != nil {
			continue
		}
		if pm.Type != "message" && pm.Type != "msg" {
			continue
		}

		role := pm.Message.Role
		if role != "user" && role != "assistant" && role != "toolResult" {
			continue
		}
		var sb strings.Builder
		hasHeader := false
		if role == "toolResult" {
			toolName := pm.Message.ToolName
			if toolName == "" {
				toolName = "tool"
			}
			sb.WriteString(fmt.Sprintf("> **Tool Output (%s):**\n\n", toolName))
			hasHeader = true
		}
		for _, content := range pm.Message.Content {
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
				for _, l := range lines {
					sb.WriteString("> " + l + "\n")
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
						} else {
							if pretty, err := json.MarshalIndent(argsMap, "", "  "); err == nil {
								sb.WriteString(fmt.Sprintf("\n```json\n%s\n```", string(pretty)))
							}
						}
					} else {
						sb.WriteString(fmt.Sprintf("\n```json\n%s\n```", string(content.Arguments)))
					}
				}
			}
		}
		txt := strings.TrimSpace(sb.String())
		if txt == "" {
			continue
		}
		messages = append(messages, Message{
			Role: pm.Message.Role,
			Text: txt,
		})
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return messages, nil
}
