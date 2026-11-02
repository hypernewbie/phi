package attachments

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const attachmentServerPathMaxBytes = 4096

type attachmentBrowseEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

type attachmentBrowseResponse struct {
	Path      string                  `json:"path"`
	Parent    string                  `json:"parent"`
	Truncated bool                    `json:"truncated"`
	Entries   []attachmentBrowseEntry `json:"entries"`
}

type attachmentServerItemRequest struct {
	ID                  string `json:"id"`
	Pane                string `json:"pane"`
	Path                string `json:"path"`
	ExpectedFingerprint string `json:"expected_fingerprint"`
}

func HandleV2Browse(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !SameOrigin(r) {
		WriteJSONError(w, http.StatusForbidden, "unavailable")
		return
	}
	pane := r.URL.Query().Get("pane")
	inst, err := LivePiPane(pane)
	if err != nil {
		WriteJSONError(w, http.StatusNotFound, "unavailable")
		return
	}
	requested := r.URL.Query().Get("path")
	if requested == "" {
		requested = inst.Cwd
	}
	if len(requested) > attachmentServerPathMaxBytes || !utf8.ValidString(requested) || !filepath.IsAbs(requested) {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	current := filepath.Clean(requested)
	info, err := os.Lstat(current)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		WriteJSONError(w, http.StatusNotFound, "missing-item")
		return
	}
	entries, err := os.ReadDir(current)
	if err != nil {
		WriteJSONError(w, http.StatusNotFound, "unavailable")
		return
	}
	result := attachmentBrowseResponse{Path: current, Parent: filepath.Dir(current), Entries: []attachmentBrowseEntry{}}
	if result.Parent == current {
		result.Parent = ""
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." || strings.HasPrefix(name, ".") || !utf8.ValidString(name) {
			continue
		}
		path := filepath.Join(current, name)
		childInfo, statErr := os.Lstat(path)
		if statErr != nil || childInfo.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if childInfo.IsDir() {
			result.Entries = append(result.Entries, attachmentBrowseEntry{Name: name, Path: path, Kind: "directory"})
		} else if childInfo.Mode().IsRegular() {
			result.Entries = append(result.Entries, attachmentBrowseEntry{
				Name: name, Path: path, Kind: "file", SizeBytes: childInfo.Size(),
				Fingerprint: attachmentSourceFingerprint(childInfo),
			})
		}
	}
	sort.SliceStable(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Kind != b.Kind {
			return a.Kind == "directory"
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	if len(result.Entries) > attachmentListMaxEntries {
		result.Entries = result.Entries[:attachmentListMaxEntries]
		result.Truncated = true
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func HandleV2ServerItem(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !SameOrigin(r) {
		WriteJSONError(w, http.StatusForbidden, "unavailable")
		return
	}
	clearDeadline, ok := SetReadDeadline(w, r, 15*time.Second)
	if !ok {
		WriteJSONError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	defer clearDeadline()
	if Default == nil {
		WriteJSONError(w, http.StatusServiceUnavailable, "storage")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var body attachmentServerItemRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		WriteJSONBodyError(w, err)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if !CanonicalUUID(body.ID) || body.Pane == "" || len(body.Pane) > PaneMaxBytes || len(body.Path) > attachmentServerPathMaxBytes || !utf8.ValidString(body.Path) || !filepath.IsAbs(body.Path) {
		WriteJSONError(w, http.StatusBadRequest, "invalid-item")
		return
	}
	if _, err := LivePiPane(body.Pane); err != nil {
		WriteJSONError(w, http.StatusNotFound, "unavailable")
		return
	}
	item, err := Default.SnapshotFile(r.Context(), body.ID, body.Pane, body.Path, body.ExpectedFingerprint)
	if err != nil {
		WriteStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(item)
}
