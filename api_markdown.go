package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/pkg/session"
	"github.com/hypernewbie/phi/pkg/system"
)

func handleMarkdownDirs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req map[string]string
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	dir := req["dir"]
	if dir == "" {
		http.Error(w, "Missing dir", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	if r.Method == http.MethodPost {
		for _, d := range cfg.MarkdownDirs {
			if d == dir {
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		cfg.MarkdownDirs = append(cfg.MarkdownDirs, dir)
	} else {
		newDirs := []string{}
		for _, d := range cfg.MarkdownDirs {
			if d != dir {
				newDirs = append(newDirs, d)
			}
		}
		cfg.MarkdownDirs = newDirs
	}
	saveConfig(cfg)
	w.WriteHeader(http.StatusOK)
}

type MDFileEntry struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Dir  string `json:"dir"`
}

type MarkdownPasteRequest struct {
	Cwd       string `json:"cwd"`
	Dir       string `json:"dir"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	Overwrite bool   `json:"overwrite"`
}

type MarkdownDeleteRequest struct {
	Cwd  string `json:"cwd"`
	Path string `json:"path"`
}

type MarkdownCopyAllWorktreesRequest struct {
	Cwd  string `json:"cwd"`
	Dir  string `json:"dir"`
	Path string `json:"path"`
}

func markdownAllowedDirs(cwd string, cfg Config) ([]string, error) {
	var allowed []string
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(cwd, dir)
		}
		absDir, err := filepath.Abs(absDir)
		if err != nil {
			continue
		}
		allowed = append(allowed, absDir)
	}
	return allowed, nil
}

func markdownPathAllowed(absPath string, allowedDirs []string) bool {
	for _, absDir := range allowedDirs {
		if strings.HasPrefix(absPath, absDir+string(filepath.Separator)) || absPath == absDir {
			return true
		}
	}
	return false
}

func resolveMarkdownTargetDir(cwd string, dir string) (string, error) {
	absDir := dir
	if !filepath.IsAbs(dir) {
		absDir = filepath.Join(cwd, dir)
	}
	return filepath.Abs(absDir)
}

func normalizeMarkdownFilename(name string) string {
	name = strings.TrimSpace(name)
	name = filepath.Base(name)
	if !strings.HasSuffix(strings.ToLower(name), ".md") {
		name += ".md"
	}
	return name
}

func handleMarkdownFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	files := []MDFileEntry{}
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(cwd, dir)
		}
		entries, err := os.ReadDir(absDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
				continue
			}
			files = append(files, MDFileEntry{
				Path: filepath.Join(absDir, entry.Name()),
				Name: entry.Name(),
				Dir:  dir,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(files)
}

func handleMarkdownFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}
	if strings.ToLower(filepath.Ext(path)) != ".md" {
		http.Error(w, "Only .md files allowed", http.StatusForbidden)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	absPath, err := filepath.Abs(path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(absPath, allowedDirs) {
		http.Error(w, "Path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	content, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
}

func handleMarkdownPaste(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownPasteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	name := normalizeMarkdownFilename(req.Name)
	if name == "" || name == ".md" {
		http.Error(w, "Invalid filename", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	targetDir, err := resolveMarkdownTargetDir(cwd, req.Dir)
	if err != nil {
		http.Error(w, "Invalid target directory", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(targetDir, allowedDirs) && !markdownPathAllowed(targetDir+string(filepath.Separator), allowedDirs) {
		http.Error(w, "Target directory not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		http.Error(w, "Failed to create target directory: "+err.Error(), http.StatusInternalServerError)
		return
	}
	targetPath := filepath.Join(targetDir, name)
	if _, err := os.Stat(targetPath); err == nil && !req.Overwrite {
		http.Error(w, "File already exists", http.StatusConflict)
		return
	}
	if err := system.WriteFileAtomic(targetPath, []byte(req.Content), 0644); err != nil {
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"path": targetPath, "name": name})
}

func handleMarkdownDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	absPath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}
	if strings.ToLower(filepath.Ext(absPath)) != ".md" {
		http.Error(w, "Only .md files allowed", http.StatusForbidden)
		return
	}
	if !markdownPathAllowed(absPath, allowedDirs) {
		http.Error(w, "Path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	if err := os.Remove(absPath); err != nil {
		http.Error(w, "Failed to delete file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func handleMarkdownCopyAllWorktrees(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MarkdownCopyAllWorktreesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = activeCWD
	}
	if req.Dir == "" {
		http.Error(w, "Missing markdown dir", http.StatusBadRequest)
		return
	}
	cfg := loadConfig()
	allowedDirs, _ := markdownAllowedDirs(cwd, cfg)
	sourcePath, err := filepath.Abs(req.Path)
	if err != nil {
		http.Error(w, "Invalid source path", http.StatusBadRequest)
		return
	}
	if !markdownPathAllowed(sourcePath, allowedDirs) {
		http.Error(w, "Source path not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		http.Error(w, "Failed to read source file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if filepath.IsAbs(req.Dir) {
		http.Error(w, "Copy to all worktrees requires a workspace-relative markdown dir", http.StatusBadRequest)
		return
	}
	wts, err := session.ListGitWorktrees(r.Context(), cwd)
	if err != nil {
		http.Error(w, "Failed to list worktrees: "+err.Error(), http.StatusInternalServerError)
		return
	}
	name := filepath.Base(sourcePath)
	copied := 0
	for _, wt := range wts {
		targetDir := filepath.Join(wt.Path, req.Dir)
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			continue
		}
		targetPath := filepath.Join(targetDir, name)
		if err := system.WriteFileAtomic(targetPath, content, 0644); err != nil {
			continue
		}
		copied++
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"copied": copied})
}

// ---------------------------------------------------------------------------
// Markdown bundle export/import: round-trip a workspace's markdown files
// through the user's clipboard.
//
// Format: PHIMD:<sha256(b64+salt)>:<base64(gzip(json(files)))>.
//
// Mirrors the existing PHICONFIG/PHIMODELS family for tamper-detection
// (sha256 over the base64 payload, salted) but adds gzip because markdown
// compresses dramatically and round-trips can be large. The un-gzipped
// payload is a JSON array of {name, content} entries.
//
// Path safety on import:
//   - Names are run through normalizeMarkdownFilename (basename, .md suffix)
//   - Targets must resolve inside the FIRST configured markdownDir
//     (extra defensive: markdownPathAllowed)
//   - Existing files are skipped unless the request sets overwrite=true
// ---------------------------------------------------------------------------

type MDExportEntry struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type MDExportResponse struct {
	Blob  string `json:"blob"`
	Count int    `json:"count"`
}

type MDImportRequest struct {
	Cwd       string `json:"cwd"`
	Blob      string `json:"blob"`
	Overwrite bool   `json:"overwrite"`
	TargetDir string `json:"target_dir"`
}

type MDImportResponse struct {
	Written []string `json:"written"`
	Skipped []string `json:"skipped"`
}

const (
	mdBundlePrefix = "PHIMD"
	mdBundleSalt   = "phi_md_bundle_salt_2026"
)

func encodeMarkdownBundle(files []MDExportEntry) (string, error) {
	jsonData, err := json.Marshal(files)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}
	var gzBuf bytes.Buffer
	gzw := gzip.NewWriter(&gzBuf)
	if _, err := gzw.Write(jsonData); err != nil {
		return "", fmt.Errorf("gzip write: %w", err)
	}
	if err := gzw.Close(); err != nil {
		return "", fmt.Errorf("gzip close: %w", err)
	}
	b64 := base64.StdEncoding.EncodeToString(gzBuf.Bytes())
	hasher := sha256.New()
	hasher.Write([]byte(b64 + mdBundleSalt))
	return fmt.Sprintf("%s:%s:%s", mdBundlePrefix, hex.EncodeToString(hasher.Sum(nil)), b64), nil
}

func decodeMarkdownBundle(raw string) ([]MDExportEntry, error) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, mdBundlePrefix+":") {
		return nil, fmt.Errorf("invalid bundle format (expected %s:...)", mdBundlePrefix)
	}
	// Three colon-separated parts: prefix, hex hash, base64 payload.
	parts := strings.SplitN(raw, ":", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("malformed bundle string")
	}
	hashHex, b64 := parts[1], parts[2]
	hasher := sha256.New()
	hasher.Write([]byte(b64 + mdBundleSalt))
	if !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), hashHex) {
		return nil, fmt.Errorf("bundle signature verification failed (corrupted or altered data)")
	}
	gzBytes, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("base64 decode: %w", err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(gzBytes))
	if err != nil {
		return nil, fmt.Errorf("gzip header: %w", err)
	}
	defer gz.Close()
	jsonBytes, err := io.ReadAll(gz)
	if err != nil {
		return nil, fmt.Errorf("gunzip: %w", err)
	}
	var files []MDExportEntry
	if err := json.Unmarshal(jsonBytes, &files); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}
	return files, nil
}

// handleMarkdownExportBundle enumerates markdown files in the configured
// markdownDirs (relative to cwd), reads their contents, and returns a
// single tamper-detected base64+gzip blob the user can copy to clipboard.
func handleMarkdownExportBundle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Cwd string `json:"cwd"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // body optional
	if req.Cwd == "" {
		req.Cwd = activeCWD
	}
	cfg := loadConfig()

	files := []MDExportEntry{}
	for _, dir := range cfg.MarkdownDirs {
		absDir := dir
		if !filepath.IsAbs(dir) {
			absDir = filepath.Join(req.Cwd, dir)
		}
		entries, err := os.ReadDir(absDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".md" {
				continue
			}
			// Skip dot-prefixed names. The clipboard-share path is meant
			// for the files the user is actively working with — hidden
			// tool dirs (.obsidian/, .vscode/, etc) and scratch files
			// shouldn't ride along.
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			content, err := os.ReadFile(filepath.Join(absDir, entry.Name()))
			if err != nil {
				continue
			}
			files = append(files, MDExportEntry{
				Name:    entry.Name(),
				Content: string(content),
			})
		}
	}

	blob, err := encodeMarkdownBundle(files)
	if err != nil {
		http.Error(w, fmt.Sprintf("encode: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(MDExportResponse{Blob: blob, Count: len(files)})
}

// handleMarkdownImportBundle accepts a clipboard blob string, decodes it,
// and writes each entry to the FIRST configured markdownDir. Existing
// files are skipped unless the request sets overwrite=true. Path
// traversal via filename is rejected by normalizeMarkdownFilename +
// markdownPathAllowed.
func handleMarkdownImportBundle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req MDImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("bad request: %v", err), http.StatusBadRequest)
		return
	}
	if req.Cwd == "" {
		req.Cwd = activeCWD
	}
	cfg := loadConfig()
	if len(cfg.MarkdownDirs) == 0 {
		http.Error(w, "No markdown directories configured — set one in Settings first.", http.StatusBadRequest)
		return
	}

	// Resolve target directory. If the request specifies target_dir, use
	// that (still validated against allowed dirs); otherwise default to
	// the first configured markdownDir.
	targetDir := req.TargetDir
	if targetDir == "" {
		targetDir = cfg.MarkdownDirs[0]
	}
	absTarget, err := resolveMarkdownTargetDir(req.Cwd, targetDir)
	if err != nil {
		http.Error(w, "Invalid target directory", http.StatusBadRequest)
		return
	}

	allowed := []string{absTarget}
	if !markdownPathAllowed(absTarget, allowed) && absTarget != allowed[0] {
		http.Error(w, "Target directory not in allowed markdown dirs", http.StatusForbidden)
		return
	}
	if err := os.MkdirAll(absTarget, 0755); err != nil {
		http.Error(w, fmt.Sprintf("mkdir: %v", err), http.StatusInternalServerError)
		return
	}

	entries, err := decodeMarkdownBundle(req.Blob)
	if err != nil {
		http.Error(w, fmt.Sprintf("decode: %v", err), http.StatusBadRequest)
		return
	}

	resp := MDImportResponse{}
	for _, entry := range entries {
		safeName := normalizeMarkdownFilename(entry.Name)
		if safeName == "" || safeName == ".md" {
			resp.Skipped = append(resp.Skipped, entry.Name+": invalid name")
			continue
		}
		target := filepath.Join(absTarget, safeName)
		if strings.Contains(safeName, "..") {
			resp.Skipped = append(resp.Skipped, entry.Name+": path traversal")
			continue
		}
		// Extra defensive: target must resolve under the allowed dir.
		if !markdownPathAllowed(target, allowed) {
			resp.Skipped = append(resp.Skipped, entry.Name+": path not allowed")
			continue
		}
		if _, err := os.Stat(target); err == nil && !req.Overwrite {
			resp.Skipped = append(resp.Skipped, entry.Name+": already exists")
			continue
		}
		if err := system.WriteFileAtomic(target, []byte(entry.Content), 0644); err != nil {
			resp.Skipped = append(resp.Skipped, entry.Name+": "+err.Error())
			continue
		}
		resp.Written = append(resp.Written, safeName)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
