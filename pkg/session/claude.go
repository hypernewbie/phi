package session

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// claudeConfigDir returns Claude Code's config directory, honoring
// $CLAUDE_CONFIG_DIR (which Claude Code itself supports) and falling back to
// ~/.claude. An empty/whitespace env value is treated as unset.
func claudeConfigDir() string {
	if d := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); d != "" {
		return d
	}
	return expandHome("~/.claude")
}

// encodeClaudeProjectDir reproduces Claude Code's project-directory naming: the
// cleaned absolute cwd with every non-alphanumeric ASCII character replaced by
// '-'. This is Claude's documented, total forward mapping. We match on it rather
// than trying to reverse the (lossy) directory name back into a path.
//
// Known limitation (do NOT try to handle): non-ASCII path characters — Claude's
// JS replaces per UTF-16 code unit; we replace per rune with a single '-'. ASCII
// paths (the overwhelming majority) match exactly.
func encodeClaudeProjectDir(cwd string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		default:
			return '-'
		}
	}, filepath.Clean(cwd))
}

type claudeRegistryEntry struct {
	SessionID  string `json:"sessionId"`
	Name       string `json:"name"`
	NameSource string `json:"nameSource"`
}

// loadClaudeRegistry reads Claude Code's live-session registry
// (<config>/sessions/*.json) into a map keyed by sessionId. Used only to name
// transcript-backed sessions (see resolveClaudeTitle); NOT used to introduce
// sessions into the list.
func loadClaudeRegistry() map[string]claudeRegistryEntry {
	out := make(map[string]claudeRegistryEntry)
	dir := filepath.Join(claudeConfigDir(), "sessions")
	files, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, d := range files {
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, d.Name()))
		if err != nil {
			continue
		}
		var e claudeRegistryEntry
		if err := json.Unmarshal(b, &e); err == nil && e.SessionID != "" {
			out[e.SessionID] = e
		}
	}
	return out
}

type claudeFileMeta struct {
	aiTitle string
	slug    string
	summary string
	cwd     string // NEW
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
	Cwd     string `json:"cwd"` // NEW
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
		hasCwd := strings.Contains(line, `"cwd":`)

		if hasSlug || hasAiTitle || hasSummary || hasCwd {
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
				if cl.Cwd != "" && meta.cwd == "" {
					meta.cwd = cl.Cwd
				}
			}
		}

		// cwd (line ~4) precedes aiTitle (line ~8) in practice; require both so we never
		// stop before capturing the authoritative cwd.
		if meta.aiTitle != "" && meta.cwd != "" {
			break
		}
	}
	return meta
}

// resolveClaudeTitle applies title priority for a Claude session:
//  1. Phi custom rename (~/.phi/sessions.json)
//  2. User-set live-session name (registry name whose nameSource != "derived")
//  3. AI title, then slug, then summary (from the transcript)
//  4. Derived live-session name (e.g. "phi-a4")
//
// Returns "" if none apply; the caller then uses the short-id + date fallback.
func resolveClaudeTitle(sessionID string, renames map[string]AgyMeta, reg claudeRegistryEntry, hasReg bool, meta claudeFileMeta) string {
	if pm, ok := renames[sessionID]; ok && pm.Name != "" {
		return pm.Name
	}
	if hasReg && reg.Name != "" && reg.NameSource != "derived" {
		return reg.Name
	}
	if t := meta.bestTitle(); t != "" {
		return t
	}
	if hasReg && reg.Name != "" {
		return reg.Name
	}
	return ""
}

func ListClaudeSessions(cwd string) ([]Session, error) {
	projectsPath := filepath.Join(claudeConfigDir(), "projects")
	fi, err := os.Stat(projectsPath)
	if os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
		return []Session{}, nil
	}
	if err != nil {
		return nil, err
	}

	dirs, err := os.ReadDir(projectsPath)
	if err != nil {
		return nil, err
	}

	renames, err := LoadAgyMetaMap()
	if err != nil {
		renames = make(map[string]AgyMeta)
	}
	registry := loadClaudeRegistry()

	var sessions []Session

	wantDir := ""
	if cwd != "" {
		wantDir = encodeClaudeProjectDir(cwd)
	}

	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		// Bug #1 fix: match by forward-encoding the requested cwd; never by
		// reversing the (lossy) directory name. EqualFold preserves the old
		// filter's case-insensitivity (it compared lowercased paths).
		if wantDir != "" && !strings.EqualFold(d.Name(), wantDir) {
			continue
		}

		projDir := filepath.Join(projectsPath, d.Name())
		files, ferr := os.ReadDir(projDir)
		if ferr != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			info, ierr := f.Info()
			if ierr != nil {
				continue
			}
			filePath := filepath.Join(projDir, f.Name())
			sessionID := strings.TrimSuffix(f.Name(), ".jsonl")

			meta := extractClaudeMeta(filePath)
			reg, hasReg := registry[sessionID]

			title := resolveClaudeTitle(sessionID, renames, reg, hasReg, meta)
			if title == "" {
				short := sessionID
				if len(short) > 8 {
					short = short[:8]
				}
				title = "Claude session " + short + " " + info.ModTime().Format("02 Jan 2006")
			}

			// Authoritative displayed cwd: when filtered we already know it equals
			// cwd; otherwise take the transcript's own cwd, then the (imperfect)
			// decoded dir name as a last resort.
			sessCwd := cwd
			if sessCwd == "" {
				sessCwd = meta.cwd
				if sessCwd == "" {
					sessCwd = decodeClaudePath(d.Name())
				}
			}

			sessions = append(sessions, Session{
				ID:          sessionID,
				Title:       title,
				Cwd:         sessCwd,
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
