package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/hypernewbie/phi/pkg/system"
)

// attachmentDir is the on-disk destination for dropped files and clipboard
// images. Resolved through a helper so tests can override HOME and not
// litter the developer's real ~/.phi/clipboard/ directory.
func attachmentDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		// Fall back to a relative path; never panic — write attempts will
		// fail with a clear error.
		return filepath.Join(".phi", "clipboard")
	}
	return filepath.Join(home, ".phi", "clipboard")
}

// attachmentMaxBytes is the per-file size cap. Enforced via http.MaxBytesReader
// in the handler so a misbehaving client cannot exhaust disk.
const attachmentMaxBytes = 25 << 20 // 25 MB

// attachmentSweepKeep is the number of files we keep in the clipboard dir.
// Older files (by mtime) are deleted on every successful upload so the dir
// doesn't grow unbounded across long-running sessions. 20 covers a
// generous session's worth of drag-drop + clipboard pastes; anything
// older than the last few minutes of activity is almost certainly stale.
const attachmentSweepKeep = 20

// attachmentMIMEToExt maps the allowlisted image MIME types to a safe
// extension. The handler rejects any MIME outside this map so we never
// write a `.exe` or `.html` to the clipboard dir.
var attachmentMIMEToExt = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// attachmentRandomSuffix returns 4 lowercase hex chars. Collisions are
// acceptable because the unixnano prefix is also unique in practice.
func attachmentRandomSuffix() string {
	b := make([]byte, 2)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is catastrophic — fall back to time-derived
		// suffix rather than blocking uploads.
		return fmt.Sprintf("%04x", time.Now().UnixNano()&0xFFFF)
	}
	return hex.EncodeToString(b)
}

// attachmentUniqueName builds a server-side filename. We never trust the
// client-supplied basename because paste events almost always send
// `image.png` and rapid pastes would otherwise overwrite each other.
func attachmentUniqueName(ext string) string {
	return fmt.Sprintf("clip-%d-%s%s",
		time.Now().UnixNano(),
		attachmentRandomSuffix(),
		ext,
	)
}

// attachmentSweep deletes the oldest files in dir beyond attachmentSweepKeep.
// Idempotent: double-sweeps under concurrent uploads are harmless.
func attachmentSweep(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type fi struct {
		path  string
		mtime time.Time
	}
	files := make([]fi, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fi{filepath.Join(dir, e.Name()), info.ModTime()})
	}
	if len(files) <= attachmentSweepKeep {
		return
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime.Before(files[j].mtime)
	})
	for _, f := range files[:len(files)-attachmentSweepKeep] {
		_ = os.Remove(f.path)
	}
}

// handleAttachments is the POST endpoint for both drag-dropped files and
// clipboard images. Both paths go through here because modern browsers do
// not expose real OS paths on File objects — even drag-drop is effectively
// a blob upload. Keeping one endpoint avoids dual storage and dual logic.
//
// Multipart contract:
//   - one `file` field, MIME type in image/png|jpeg|gif|webp allowlist
//   - 25 MB cap via http.MaxBytesReader
//   - server-generated unique filename; client basename is ignored
//
// Response: 200 {"path", "name", "sizeBytes", "mimeType"}
// Errors:
//   - 405 wrong method
//   - 400 missing file, disallowed MIME, or multipart parse failure
//   - 413 body exceeded attachmentMaxBytes
//   - 500 filesystem failure
func handleAttachments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Enforce size cap before parsing the multipart body. Without this a
	// malicious client could stream unlimited bytes into our memory.
	r.Body = http.MaxBytesReader(w, r.Body, attachmentMaxBytes+1024)

	if err := r.ParseMultipartForm(attachmentMaxBytes); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			http.Error(w, "Attachment too large (max 25 MB)", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "Invalid multipart body: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Missing 'file' field: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	mimeType := header.Header.Get("Content-Type")
	ext, ok := attachmentMIMEToExt[strings.ToLower(mimeType)]
	if !ok {
		http.Error(w, "Unsupported file type: "+mimeType, http.StatusBadRequest)
		return
	}

	dir := attachmentDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "Failed to create clipboard dir: "+err.Error(), http.StatusInternalServerError)
		return
	}

	name := attachmentUniqueName(ext)
	target := filepath.Join(dir, name)

	// Read with a hard cap so a hostile Content-Length header cannot
	// slip past MaxBytesReader via the multipart parser's slack.
	limited := io.LimitReader(file, attachmentMaxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		http.Error(w, "Failed to read upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	if int64(len(data)) > attachmentMaxBytes {
		http.Error(w, "Attachment too large (max 25 MB)", http.StatusRequestEntityTooLarge)
		return
	}

	if err := system.WriteFileAtomic(target, data, 0644); err != nil {
		http.Error(w, "Failed to write attachment: "+err.Error(), http.StatusInternalServerError)
		return
	}

	attachmentSweep(dir)

	abs, err := filepath.Abs(target)
	if err != nil {
		abs = target
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"path":      abs,
		"name":      name,
		"sizeBytes": len(data),
		"mimeType":  mimeType,
	})
}