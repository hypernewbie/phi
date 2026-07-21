package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type claudeActiveSession struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
}

func loadActiveClaudeSessionNames() map[string]string {
	active := make(map[string]string)
	sessionsPath := expandHome("~/.claude/sessions")
	dirs, err := os.ReadDir(sessionsPath)
	if err != nil {
		return active
	}

	for _, d := range dirs {
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(sessionsPath, d.Name()))
		if err != nil {
			continue
		}
		var data claudeActiveSession
		if err := json.Unmarshal(b, &data); err == nil && data.SessionID != "" && data.Name != "" {
			active[data.SessionID] = data.Name
		}
	}
	return active
}

type claudeFileMeta struct {
	aiTitle string
	slug    string
	summary string
}

func (m claudeFileMeta) bestTitle() string {
	if m.aiTitle != "" {
		return m.aiTitle
	}
	if m.slug != "" {
		return m.slug
	}
	if m.summary != "" {
		return m.summary
	}
	return ""
}

type claudeLogLine struct {
	Type    string `json:"type"`
	Slug    string `json:"slug"`
	AiTitle string `json:"aiTitle"`
	Summary string `json:"summary"`
}

func extractClaudeMeta(filePath string) claudeFileMeta {
	var meta claudeFileMeta
	file, err := os.Open(filePath)
	if err != nil {
		return meta
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()

		hasSlug := strings.Contains(line, `"slug":`)
		hasAiTitle := strings.Contains(line, `"aiTitle":`)
		hasSummary := strings.Contains(line, `"summary":`)

		if hasSlug || hasAiTitle || hasSummary {
			var cl claudeLogLine
			if err := json.Unmarshal([]byte(line), &cl); err == nil {
				if cl.Slug != "" && meta.slug == "" {
					meta.slug = cl.Slug
				}
				if cl.AiTitle != "" && meta.aiTitle == "" {
					meta.aiTitle = cl.AiTitle
				}
				if cl.Summary != "" && meta.summary == "" {
					meta.summary = cl.Summary
				}
			}
		}

		if meta.aiTitle != "" {
			break
		}
	}
	return meta
}

func ListClaudeSessions(cwd string) ([]Session, error) {
	projectsPath := expandHome("~/.claude/projects")
	fi, err := os.Stat(projectsPath)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Session{}, nil
	}

	dirs, err := os.ReadDir(projectsPath)
	if err != nil {
		return nil, err
	}

	m, err := LoadAgyMetaMap()
	if err != nil {
		m = make(map[string]AgyMeta)
	}

	activeNames := loadActiveClaudeSessionNames()

	var sessions []Session

	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}

		decodedPath := decodeClaudePath(d.Name())
		// Filter by requested CWD
		if cwd != "" && NormalisePath(decodedPath) != NormalisePath(cwd) {
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
			title := ""

			// Priority 1: Phi custom rename
			if meta, exists := m[sessionID]; exists && meta.Name != "" {
				title = meta.Name
			}
			// Priority 2: Active session label (ae-e5 style)
			if title == "" {
				if activeName, exists := activeNames[sessionID]; exists && activeName != "" {
					title = activeName
				}
			}
			// Priority 3-5: extractClaudeMeta (aiTitle > slug > summary)
			if title == "" {
				meta := extractClaudeMeta(filePath)
				title = meta.bestTitle()
			}
			// Priority 6: Fallback
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
	// Windows path: single drive letter + "--" (e.g. "C--code-github-phi" → "C:/code/github/phi")
	if len(dirName) >= 3 && dirName[1] == '-' && dirName[2] == '-' &&
		((dirName[0] >= 'A' && dirName[0] <= 'Z') || (dirName[0] >= 'a' && dirName[0] <= 'z')) {
		rest := strings.ReplaceAll(dirName[3:], "-", "/")
		return string(dirName[0]) + ":/" + rest
	}
	// Unix path: leading "/" encoded as leading "-"
	if dirName[0] == '-' {
		return "/" + strings.ReplaceAll(dirName[1:], "-", "/")
	}
	return strings.ReplaceAll(dirName, "-", "/")
}
