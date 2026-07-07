package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/hypernewbie/phi/pkg/session"
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
	if err := os.WriteFile(targetPath, []byte(req.Content), 0644); err != nil {
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
	wts, err := session.ListGitWorktrees(cwd)
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
		if err := os.WriteFile(targetPath, content, 0644); err != nil {
			continue
		}
		copied++
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"copied": copied})
}
