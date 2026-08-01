package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hypernewbie/phi/pkg/gitutil"
)

// FSEntry is one immediate child of a listed directory.
type FSEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

// FSListResponse is the JSON shape of /api/fs/list.
type FSListResponse struct {
	Truncated bool      `json:"truncated"`
	Entries   []FSEntry `json:"entries"`
}

// fsListMaxEntries caps a single directory listing.
const fsListMaxEntries = 1000

// handleFSList lists the immediate children of one directory for the Files
// tree panel. The requested path is relative to cwd and confined to it —
// including through symlinks (both sides are EvalSymlinks-resolved before
// the prefix check, so an in-tree symlink cannot escape the workspace).
// Inside a git repo, gitignored entries are filtered via gitutil.IgnoredNames;
// outside one, dotfiles are hidden (the /api/fs/autocomplete precedent).
// `.git` is always hidden. Symlink entries are listed as leaves, never dirs.
func handleFSList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	rel := filepath.Clean(strings.TrimSpace(r.URL.Query().Get("path")))
	if rel == "." {
		rel = ""
	}
	if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}

	base, err := filepath.EvalSymlinks(filepath.Clean(cwd))
	if err != nil {
		http.Error(w, "invalid cwd", http.StatusBadRequest)
		return
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(base, rel))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if resolved != base && !strings.HasPrefix(resolved, base+string(filepath.Separator)) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	dirEntries, err := os.ReadDir(resolved)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	isRepo := gitutil.IsGitRepo(r.Context(), resolved)

	// Candidate entries plus the key used for the batched ignore check;
	// dirs get a trailing slash so directory-only patterns (`build/`) match.
	type cand struct {
		entry FSEntry
		key   string
	}
	var cands []cand
	var checkNames []string
	for _, e := range dirEntries {
		name := e.Name()
		if name == ".git" {
			continue
		}
		if !isRepo && strings.HasPrefix(name, ".") {
			continue
		}
		// DirEntry type bits are lstat-based: a symlink-to-dir reports
		// IsDir() == false, so symlinks are naturally leaves — listed,
		// never expandable, never followed.
		isDir := e.IsDir()
		key := name
		if isDir {
			key = name + "/"
		}
		cands = append(cands, cand{FSEntry{Name: name, Dir: isDir}, key})
		checkNames = append(checkNames, key)
	}

	var ignored map[string]bool
	if isRepo {
		ignored, err = gitutil.IgnoredNames(r.Context(), resolved, checkNames)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	resp := FSListResponse{Entries: []FSEntry{}}
	for _, c := range cands {
		if ignored != nil && ignored[c.key] {
			continue
		}
		resp.Entries = append(resp.Entries, c.entry)
	}
	sort.SliceStable(resp.Entries, func(i, j int) bool {
		a, b := resp.Entries[i], resp.Entries[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	if len(resp.Entries) > fsListMaxEntries {
		resp.Entries = resp.Entries[:fsListMaxEntries]
		resp.Truncated = true
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
