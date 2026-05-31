package session

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type AgyMeta struct {
	Name   string `json:"name"`
	SeenAt string `json:"seen_at"`
}

var agyMu sync.Mutex

func getMetaFilePath() string {
	return expandHome("~/.phi/sessions.json")
}

func LoadAgyMetaMap() (map[string]AgyMeta, error) {
	metaPath := getMetaFilePath()
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		return nil, err
	}

	file, err := os.Open(metaPath)
	if os.IsNotExist(err) {
		return make(map[string]AgyMeta), nil
	} else if err != nil {
		return nil, err
	}
	defer file.Close()

	var m map[string]AgyMeta
	b, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	if len(b) == 0 {
		return make(map[string]AgyMeta), nil
	}

	if err := json.Unmarshal(b, &m); err != nil {
		return make(map[string]AgyMeta), nil
	}

	return m, nil
}

func SaveAgyMetaMap(m map[string]AgyMeta) error {
	metaPath := getMetaFilePath()
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		return err
	}

	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(metaPath, b, 0644)
}

func SaveAgySessionName(id string, name string) error {
	agyMu.Lock()
	defer agyMu.Unlock()

	m, err := LoadAgyMetaMap()
	if err != nil {
		return err
	}

	meta := m[id]
	meta.Name = name
	meta.SeenAt = time.Now().Format(time.RFC3339)
	m[id] = meta

	return SaveAgyMetaMap(m)
}

func ListAgySessions(cwd string) ([]Session, error) {
	agyMu.Lock()
	defer agyMu.Unlock()

	convsDir := expandHome("~/.gemini/antigravity-cli/conversations")
	if _, err := os.Stat(convsDir); os.IsNotExist(err) {
		return []Session{}, nil
	}

	files, err := os.ReadDir(convsDir)
	if err != nil {
		return nil, err
	}

	m, err := LoadAgyMetaMap()
	if err != nil {
		m = make(map[string]AgyMeta)
	}

	var sessions []Session
	activeUUIDs := make(map[string]bool)

	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".pb") {
			continue
		}

		uuid := strings.TrimSuffix(f.Name(), ".pb")
		activeUUIDs[uuid] = true

		info, err := f.Info()
		if err != nil {
			continue
		}

		// Look up in sidecar metadata
		meta, exists := m[uuid]
		title := meta.Name
		if !exists || title == "" {
			shortUUID := uuid
			if len(shortUUID) > 8 {
				shortUUID = shortUUID[:8]
			}
			title = "Gemini session " + shortUUID + " " + info.ModTime().Format("02 Jan 2006")
			meta.Name = title
			meta.SeenAt = info.ModTime().Format(time.RFC3339)
			m[uuid] = meta
		}

		sessions = append(sessions, Session{
			ID:          uuid,
			Title:       title,
			Cwd:         cwd, // agy scopes by CWD natively or default to current cwd
			Coder:       "agy",
			TimeUpdated: info.ModTime(),
		})
	}

	// Prune orphans from map if it exceeds 50,000 entries
	if len(m) > 50000 {
		pruned := make(map[string]AgyMeta)
		for k, v := range m {
			if activeUUIDs[k] {
				pruned[k] = v
			}
		}
		_ = SaveAgyMetaMap(pruned)
	} else if len(files) > 0 {
		// Just save any new default names we generated
		_ = SaveAgyMetaMap(m)
	}

	return sessions, nil
}
