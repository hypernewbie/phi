package session

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

var (
	agyBackslashRun = regexp.MustCompile(`\\+`)
	agyCwdPathRe    = regexp.MustCompile(`(?:[A-Za-z]:)?/[^"]*`)
)

// extractAgyCwdFromBrain recovers the workspace directory for a conversation
// from agy's own transcript log, which records a "Cwd" field per step. This is
// the authoritative source — history.jsonl / last_conversations.json only cover
// a handful of conversations. The path is double-escaped in the log
// (e.g. "Cwd":"\"C:\\\\code\\\\github\\\\vrhi\""), so collapse backslash runs to
// a single forward slash and pull out the path. Returns "" if the
// transcript is absent or has no Cwd.
func extractAgyCwdFromBrain(uuid string) string {
	p := expandHome("~/.gemini/antigravity-cli/brain/" + uuid + "/.system_generated/logs/transcript.jsonl")
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		idx := strings.Index(line, `"Cwd":`)
		if idx < 0 {
			continue
		}
		seg := agyBackslashRun.ReplaceAllString(line[idx:], "/")
		if m := agyCwdPathRe.FindString(seg); m != "" {
			return strings.TrimRight(filepath.ToSlash(m), "/")
		}
	}
	return ""
}

type SessionMeta struct {
	Name   string `json:"name"`
	SeenAt string `json:"seen_at"`
	Cwd    string `json:"cwd"`
}

type AgyMeta = SessionMeta

var agyMu sync.Mutex

func getMetaFilePath() string {
	return expandHome("~/.phi/sessions.json")
}

func LoadSessionMetaMap() (map[string]SessionMeta, error) {
	metaPath := getMetaFilePath()
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		return nil, err
	}

	file, err := os.Open(metaPath)
	if os.IsNotExist(err) {
		return make(map[string]SessionMeta), nil
	} else if err != nil {
		return nil, err
	}
	defer file.Close()

	var m map[string]SessionMeta
	b, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	if len(b) == 0 {
		return make(map[string]SessionMeta), nil
	}

	if err := json.Unmarshal(b, &m); err != nil {
		// Return both the error AND an empty map: callers see the
		// corruption (so they can surface a "your sessions file is
		// unreadable" toast) but the loader still produces something
		// safe for the rest of the server to consume.
		return make(map[string]SessionMeta), err
	}

	return m, nil
}

func LoadAgyMetaMap() (map[string]AgyMeta, error) {
	return LoadSessionMetaMap()
}

func SaveSessionMetaMap(m map[string]SessionMeta) error {
	metaPath := getMetaFilePath()
	if err := os.MkdirAll(filepath.Dir(metaPath), 0755); err != nil {
		return err
	}

	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}

	return system.WriteFileAtomic(metaPath, b, 0644)
}

func SaveAgyMetaMap(m map[string]AgyMeta) error {
	return SaveSessionMetaMap(m)
}

func SaveSessionName(id string, name string) error {
	agyMu.Lock()
	defer agyMu.Unlock()

	m, err := LoadSessionMetaMap()
	if err != nil {
		return err
	}

	meta := m[id]
	meta.Name = name
	meta.SeenAt = time.Now().Format(time.RFC3339)
	m[id] = meta

	return SaveSessionMetaMap(m)
}

func SaveAgySessionName(id string, name string) error {
	return SaveSessionName(id, name)
}

func SaveSessionCwd(id string, cwd string) error {
	agyMu.Lock()
	defer agyMu.Unlock()

	m, err := LoadSessionMetaMap()
	if err != nil {
		return err
	}

	meta := m[id]
	meta.Cwd = cwd
	meta.SeenAt = time.Now().Format(time.RFC3339)
	m[id] = meta

	return SaveSessionMetaMap(m)
}

func SaveAgySessionCwd(id string, cwd string) error {
	return SaveSessionCwd(id, cwd)
}

func syncSessionCwdMappings(m map[string]SessionMeta) {
	// 1. Sync from last_conversations.json
	cachePath := expandHome("~/.gemini/antigravity-cli/cache/last_conversations.json")
	if b, err := os.ReadFile(cachePath); err == nil {
		var cacheMap map[string]string
		if err := json.Unmarshal(b, &cacheMap); err == nil {
			for dir, uuid := range cacheMap {
				if uuid == "" || dir == "" {
					continue
				}
				dir = filepath.ToSlash(dir)
				if meta, exists := m[uuid]; exists {
					if meta.Cwd == "" {
						meta.Cwd = dir
						m[uuid] = meta
					}
				} else {
					m[uuid] = SessionMeta{
						Cwd:    dir,
						SeenAt: time.Now().Format(time.RFC3339),
					}
				}
			}
		}
	}

	// 2. Sync from history.jsonl
	historyPath := expandHome("~/.gemini/antigravity-cli/history.jsonl")
	if file, err := os.Open(historyPath); err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			var entry struct {
				Workspace      string `json:"workspace"`
				ConversationId string `json:"conversationId"`
			}
			if err := json.Unmarshal(scanner.Bytes(), &entry); err == nil {
				if entry.ConversationId != "" && entry.Workspace != "" {
					ws := filepath.ToSlash(entry.Workspace)
					if meta, exists := m[entry.ConversationId]; exists {
						if meta.Cwd == "" {
							meta.Cwd = ws
							m[entry.ConversationId] = meta
						}
					} else {
						m[entry.ConversationId] = SessionMeta{
							Cwd:    ws,
							SeenAt: time.Now().Format(time.RFC3339),
						}
					}
				}
			}
		}
	}
}

func ListAgySessions(cwd string) ([]Session, error) {
	agyMu.Lock()
	defer agyMu.Unlock()

	convsDir := expandHome("~/.gemini/antigravity-cli/conversations")
	fi, err := os.Stat(convsDir)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Session{}, nil
	}

	files, err := os.ReadDir(convsDir)
	if err != nil {
		return nil, err
	}

	m, err := LoadSessionMetaMap()
	if err != nil {
		m = make(map[string]SessionMeta)
	}

	// Sync latest workspace directory mappings
	syncSessionCwdMappings(m)

	sessions := []Session{}
	activeUUIDs := make(map[string]bool)

	for _, f := range files {
		if f.IsDir() {
			continue
		}
		var uuid string
		if strings.HasSuffix(f.Name(), ".pb") {
			uuid = strings.TrimSuffix(f.Name(), ".pb")
		} else if strings.HasSuffix(f.Name(), ".db") {
			uuid = strings.TrimSuffix(f.Name(), ".db")
		} else {
			continue
		}

		activeUUIDs[uuid] = true

		info, err := f.Info()
		if err != nil {
			continue
		}

		// Look up in sidecar metadata
		meta, exists := m[uuid]

		// Recover the real workspace from agy's transcript log if we don't
		// already have one cached. This covers the bulk of conversations that
		// history.jsonl / last_conversations.json never recorded.
		if meta.Cwd == "" {
			if bc := extractAgyCwdFromBrain(uuid); bc != "" {
				meta.Cwd = bc
				m[uuid] = meta
				exists = true
			}
		}

		// Fallback for newly spawned sessions (created in the last 60 seconds)
		if meta.Cwd == "" && time.Since(info.ModTime()) < 60*time.Second {
			meta.Cwd = cwd
			m[uuid] = meta
			exists = true
		}

		// Filter by workspace. Normalize separators — git returns forward slashes
		// on Windows but agy may record backslashes.
		// Special sentinel "--no-workspace--": return only sessions with no cwd.
		// Otherwise: return sessions matching the given cwd (strict — no global
		// fallback for empty-cwd sessions so they don't pollute every worktree).
		if cwd == "--no-workspace--" {
			if meta.Cwd != "" {
				continue
			}
		} else if cwd != "" {
			if meta.Cwd == "" || NormalisePath(meta.Cwd) != NormalisePath(cwd) {
				continue
			}
		}

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
			Cwd:         meta.Cwd,
			Coder:       "agy",
			TimeUpdated: info.ModTime(),
		})
	}

	// Prune orphans from map if it exceeds 50,000 entries
	if len(m) > 50000 {
		pruned := make(map[string]SessionMeta)
		for k, v := range m {
			if activeUUIDs[k] {
				pruned[k] = v
			}
		}
		_ = SaveSessionMetaMap(pruned)
	} else if len(files) > 0 {
		// Just save any new default names or CWD assignments we generated/mapped
		_ = SaveSessionMetaMap(m)
	}

	return sessions, nil
}
