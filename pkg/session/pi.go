package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

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
	Type string `json:"type"`
	Text string `json:"text"`
}

type PiMessageInner struct {
	Role    string             `json:"role"`
	Content []PiMessageContent `json:"content"`
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
	// so Windows paths like "C:/code/phi" → "--C--code-phi--" match what Pi stores.
	normalized := strings.ReplaceAll(strings.Trim(cwd, "/"), ":", "-")
	projectDirName := "--" + strings.ReplaceAll(normalized, "/", "-") + "--"
	
	sessionsDir := expandHome("~/.pi/agent/sessions")
	projectPath := filepath.Join(sessionsDir, projectDirName)
	
	if _, err := os.Stat(projectPath); os.IsNotExist(err) {
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

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		
		// 1. Check custom named session_info
		if strings.Contains(line, `"type":"session_info"`) {
			var psi PiSessionInfo
			if err := json.Unmarshal([]byte(line), &psi); err == nil && psi.Name != "" {
				customName = psi.Name
				break // Found custom name, best possible title
			}
		}

		// 2. Extract first user prompt as fallback
		if firstUserMsg == "" && strings.Contains(line, `"role":"user"`) {
			var pm PiMessage
			if err := json.Unmarshal([]byte(line), &pm); err == nil && len(pm.Message.Content) > 0 {
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
	}

	if customName != "" {
		return customName
	}
	return firstUserMsg
}
