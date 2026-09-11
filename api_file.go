package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleFileAsset serves a single workspace file by cwd-relative path.
// Used by the file-tree viewer's dispatcher to inline-preview any file
// the file tree can list. The path is confined to cwd via the same
// EvalSymlinks+prefix check handleFSList uses (an in-tree symlink
// resolves and serves normally; an out-of-tree symlink is rejected).
// http.ServeFile provides range/streaming support, so scrubbing a
// multi-gigabyte video or fetching metadata only is browser-driven.
//
// The Content-Type is taken from the file's extension via
// http.ServeFile's MIME table; X-Content-Type-Options: nosniff prevents
// the browser from re-interpreting the response. Active-content
// extensions (HTML/JS/CSS/XML/XSLT/WASM/MHT) are forced to text/plain
// with an attachment Content-Disposition so the browser can never
// render them as same-origin active documents — the user gets a
// download prompt instead. Cross-extension SVG remains inline because
// http.ServeFile returns image/svg+xml for .svg, and the browser
// renders SVG documents neutered when loaded from <img>; direct
// navigation is mitigated by nosniff + the existing markdown-asset
// CSP precedent (extended to any image here).
func handleFileAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = activeCWD
	}
	rel := filepath.Clean(strings.TrimSpace(r.URL.Query().Get("path")))
	// Reject rooted/absolute/traversal paths before touching the FS.
	// Same wording as handleFSList's gate so the two endpoints agree.
	rooted := strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`)
	if rel == "" || filepath.IsAbs(rel) || rooted || rel == ".." ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
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
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "not a regular file", http.StatusBadRequest)
		return
	}
	if fileIsActiveContent(resolved) {
		// Active content is forced to text/plain + attachment so the
		// browser downloads instead of executing/rendering it as HTML.
		// The dispatcher treats text/plain as "no preview, offer
		// download" (it doesn't dispatch a viewer for text/plain).
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition",
			`attachment; filename="`+filepath.Base(resolved)+`"`)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeFile(w, r, resolved)
}

// fileIsActiveContent reports whether the file's extension is one the
// browser would render as same-origin active content (HTML/JS/CSS/XML/
// XSLT/WASM/MHT). Used by handleFileAsset to neuter inline rendering
// for those types. SVG is intentionally NOT in this list — it stays
// inline as image/svg+xml and renders safely under nosniff + CSP.
func fileIsActiveContent(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm", ".xhtml",
		".xml", ".xsl", ".xslt",
		".mht", ".mhtml",
		".js", ".mjs", ".cjs",
		".css", ".wasm":
		return true
	}
	return false
}
