package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type ClaudeSummary struct {
	Type    string `json:"type"`
	Summary string `json:"summary"`
}

func ListClaudeSessions(cwd string) ([]Session, error) {
	projectsPath := expandHome("~/.claude/projects")
	if _, err := os.Stat(projectsPath); os.IsNotExist(err) {
		return []Session{}, nil
	}

	dirs, err := os.ReadDir(projectsPath)
	if err != nil {
		return nil, err
	}

	var sessions []Session

	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}

		decodedPath := decodeClaudePath(d.Name())
		// Filter by requested CWD
		if cwd != "" && decodedPath != cwd {
			continue
		}

		projDir := filepath.Join(projectsPath, d.Name())
		files, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}

		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}

			filePath := filepath.Join(projDir, f.Name())
			info, err := f.Info()
			if err != nil {
				continue
			}

			sessionID := strings.TrimSuffix(f.Name(), ".jsonl")
			title := extractClaudeSummary(filePath)
			if title == "" {
				shortID := sessionID
				if len(shortID) > 8 {
					shortID = shortID[:8]
				}
				title = "Claude session " + shortID + " " + info.ModTime().Format("02 Jan 2006")
			}

			sessions = append(sessions, Session{
				ID:          sessionID,
				Title:       title,
				Cwd:         decodedPath,
				Coder:       "claude",
				TimeUpdated: info.ModTime(),
			})
		}
	}
	return sessions, nil
}

func decodeClaudePath(dirName string) string {
	if len(dirName) == 0 {
		return ""
	}
	if dirName[0] == '-' {
		return "/" + strings.ReplaceAll(dirName[1:], "-", "/")
	}
	return strings.ReplaceAll(dirName, "-", "/")
}

func extractClaudeSummary(filePath string) string {
	file, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, `"type":"summary"`) {
			var cs ClaudeSummary
			if err := json.Unmarshal([]byte(line), &cs); err == nil && cs.Summary != "" {
				return cs.Summary
			}
		}
	}
	return ""
}
