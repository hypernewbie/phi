package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempConfig + makeFixturesDir set up an isolated temp workspace as
// the active CWD, plus a tmpdir containing two .md files and a non-md file
// (which the bundle must skip) and a subdir (which must be ignored).
func makeFixturesDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"alpha.md", "beta.md", "readme.txt", ".hidden.md"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("# "+name+"\nbody\n"), 0644); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, "subdir"), 0755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "subdir", "nested.md"), []byte("nested"), 0644); err != nil {
		t.Fatalf("write nested: %v", err)
	}
	return dir
}

func writeConfigWithMarkdownDirs(t *testing.T, dirs ...string) {
	t.Helper()
	cfg := loadConfig()
	cfg.MarkdownDirs = dirs
	saveConfig(cfg)
}

func readExportResponse(t *testing.T, body []byte) MDExportResponse {
	t.Helper()
	var resp MDExportResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, string(body))
	}
	return resp
}

func TestEncodeMarkdownBundle_RoundTrip(t *testing.T) {
	in := []MDExportEntry{
		{Name: "a.md", Content: "# A\n\nmarkdown body\n"},
		{Name: "b.md", Content: "## B\n\n- item 1\n- item 2\n"},
		{Name: "with unicode.md", Content: "héllo 漢字 𓂀 hieroglyph\n"},
		{Name: "EMPTY.md", Content: ""},
	}
	blob, err := encodeMarkdownBundle(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !strings.HasPrefix(blob, "PHIMD:") {
		t.Fatalf("missing prefix: %q", blob)
	}
	out, err := decodeMarkdownBundle(blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != len(in) {
		t.Fatalf("len mismatch: got %d want %d", len(out), len(in))
	}
	for i, e := range in {
		if out[i].Name != e.Name || out[i].Content != e.Content {
			t.Fatalf("entry %d differs: got %+v want %+v", i, out[i], e)
		}
	}
}

func TestEncodeMarkdownBundle_GzipsPayload(t *testing.T) {
	// We don't assert a particular compression ratio (small payloads
	// actually grow under gzip due to header overhead). What we DO need:
	// the blob must contain an actual gzip stream, not just base64'd JSON.
	// The gzip magic bytes (0x1f 0x8b) are the load-bearing assertion.
	in := make([]MDExportEntry, 0, 50)
	for i := 0; i < 50; i++ {
		in = append(in, MDExportEntry{
			Name:    "same.md",
			Content: strings.Repeat("lorem ipsum dolor sit amet, ", 200),
		})
	}
	blob, err := encodeMarkdownBundle(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	parts := strings.SplitN(blob, ":", 3)
	if len(parts) != 3 {
		t.Fatalf("bad format: %q", blob)
	}
	rawGzip, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if len(rawGzip) < 2 || rawGzip[0] != 0x1f || rawGzip[1] != 0x8b {
		t.Fatalf("payload is not gzip (magic bytes=%x)", rawGzip[:2])
	}
	// And the decompressed JSON re-parses cleanly to the original input.
	gz, _ := gzip.NewReader(bytes.NewReader(rawGzip))
	decoded, _ := io.ReadAll(gz)
	gz.Close()
	var roundtripped []MDExportEntry
	if err := json.Unmarshal(decoded, &roundtripped); err != nil {
		t.Fatalf("unmarshal after gunzip: %v", err)
	}
	if len(roundtripped) != len(in) {
		t.Fatalf("entry count mismatch after round-trip: got %d want %d", len(roundtripped), len(in))
	}
}

func TestDecodeMarkdownBundle_RejectsTampering(t *testing.T) {
	in := []MDExportEntry{{Name: "a.md", Content: "hello"}}
	blob, err := encodeMarkdownBundle(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// Flip a character in the base64 payload: any change must break the
	// signature, returning an error from decode.
	parts := strings.SplitN(blob, ":", 3)
	tampered := parts[0] + ":" + parts[1] + ":" + flipFirstChar(parts[2])
	_, err = decodeMarkdownBundle(tampered)
	if err == nil {
		t.Fatalf("expected tamper error, got nil (blob=%q)", tampered)
	}
	if !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature error, got: %v", err)
	}
}

func TestDecodeMarkdownBundle_RejectsWrongPrefix(t *testing.T) {
	_, err := decodeMarkdownBundle("WRONGPREFIX:abc:def")
	if err == nil {
		t.Fatalf("expected prefix error")
	}
	if !strings.Contains(err.Error(), "invalid bundle format") {
		t.Fatalf("expected format error, got: %v", err)
	}
}

func TestDecodeMarkdownBundle_RejectsMalformed(t *testing.T) {
	cases := []string{
		"PHIMD:",          // only one part
		"PHIMD:a:b:c:d",   // too many parts
		"PHIMD:notvalidhex:Zm9v", // undecodable hash check
	}
	for _, c := range cases {
		_, err := decodeMarkdownBundle(c)
		if err == nil {
			t.Fatalf("expected error for %q", c)
		}
	}
}

func TestHandleMarkdownExportBundle_HappyPath(t *testing.T) {
	withTempConfig(t)
	fixtures := makeFixturesDir(t)
	writeConfigWithMarkdownDirs(t, fixtures)

	req := httptest.NewRequest(http.MethodPost, "/api/markdown/export-bundle", strings.NewReader(`{"cwd":""}`))
	w := httptest.NewRecorder()
	handleMarkdownExportBundle(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body=%s", w.Code, w.Body.String())
	}
	resp := readExportResponse(t, w.Body.Bytes())
	if !strings.HasPrefix(resp.Blob, "PHIMD:") {
		t.Fatalf("missing prefix: %q", resp.Blob)
	}
	// .hidden.md, readme.txt, and subdir/* are skipped; alpha.md and beta.md make the cut.
	if resp.Count != 2 {
		t.Fatalf("count: got %d want 2 (alpha.md + beta.md), body=%s", resp.Count, w.Body.String())
	}
	// Round-trip the blob and confirm the file contents match the
	// fixtures on disk byte-for-byte.
	out, err := decodeMarkdownBundle(resp.Blob)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	got := map[string]string{}
	for _, e := range out {
		got[e.Name] = e.Content
	}
	if got["alpha.md"] != "# alpha.md\nbody\n" {
		t.Fatalf("alpha.md content mismatch: %q", got["alpha.md"])
	}
	if got["beta.md"] != "# beta.md\nbody\n" {
		t.Fatalf("beta.md content mismatch: %q", got["beta.md"])
	}
}

func TestHandleMarkdownExportBundle_RequiresPost(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/markdown/export-bundle", nil)
	w := httptest.NewRecorder()
	handleMarkdownExportBundle(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestHandleMarkdownExportBundle_NoFiles(t *testing.T) {
	withTempConfig(t)
	empty := t.TempDir()
	writeConfigWithMarkdownDirs(t, empty)

	req := httptest.NewRequest(http.MethodPost, "/api/markdown/export-bundle", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	handleMarkdownExportBundle(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	resp := readExportResponse(t, w.Body.Bytes())
	if resp.Count != 0 {
		t.Fatalf("expected 0 files, got %d", resp.Count)
	}
	// Empty bundle still produces a valid PHIMD: blob.
	if _, err := decodeMarkdownBundle(resp.Blob); err != nil {
		t.Fatalf("decode empty bundle: %v", err)
	}
}

func TestHandleMarkdownImportBundle_HappyPath(t *testing.T) {
	withTempConfig(t)
	fixtures := makeFixturesDir(t)
	writeConfigWithMarkdownDirs(t, fixtures)

	// Round-trip: export, then import into a different (fresh) target
	// dir, and confirm the files appeared. Build the import body via
	// json.Marshal so paths / base64 with slashes are encoded correctly.
	expReq := httptest.NewRequest(http.MethodPost, "/api/markdown/export-bundle", strings.NewReader(`{"cwd":""}`))
	expW := httptest.NewRecorder()
	handleMarkdownExportBundle(expW, expReq)
	if expW.Code != http.StatusOK {
		t.Fatalf("export %d", expW.Code)
	}
	expResp := readExportResponse(t, expW.Body.Bytes())

	importDir := t.TempDir()
	impBody, _ := json.Marshal(MDImportRequest{
		Cwd:       "/does/not/matter",
		TargetDir: importDir,
		Overwrite: true,
		Blob:      expResp.Blob,
	})
	impReq := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle", bytes.NewReader(impBody))
	impW := httptest.NewRecorder()
	handleMarkdownImportBundle(impW, impReq)
	if impW.Code != http.StatusOK {
		t.Fatalf("import status %d body=%s", impW.Code, impW.Body.String())
	}
	var imp MDImportResponse
	if err := json.Unmarshal(impW.Body.Bytes(), &imp); err != nil {
		t.Fatalf("decode import response: %v", err)
	}
	if len(imp.Written) != 2 || len(imp.Skipped) != 0 {
		t.Fatalf("written=%v skipped=%v", imp.Written, imp.Skipped)
	}
	// Files actually exist on disk with the expected content.
	for _, name := range []string{"alpha.md", "beta.md"} {
		body, err := os.ReadFile(filepath.Join(importDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if string(body) != "# "+name+"\nbody\n" {
			t.Fatalf("%s content mismatch: %q", name, string(body))
		}
	}
}

func TestHandleMarkdownImportBundle_SkipsExistingWithoutOverwrite(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	// Pre-place a file with different content.
	if err := os.WriteFile(filepath.Join(dir, "exists.md"), []byte("OLD"), 0644); err != nil {
		t.Fatalf("pre-write: %v", err)
	}
	writeConfigWithMarkdownDirs(t, dir)

	// Bundle contains exists.md with new content.
	in := []MDExportEntry{{Name: "exists.md", Content: "NEW"}}
	blob, err := encodeMarkdownBundle(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	body, _ := json.Marshal(MDImportRequest{TargetDir: dir, Blob: blob})
	req := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMarkdownImportBundle(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var imp MDImportResponse
	_ = json.Unmarshal(w.Body.Bytes(), &imp)
	if len(imp.Written) != 0 || len(imp.Skipped) != 1 {
		t.Fatalf("expected skipped, got written=%v skipped=%v", imp.Written, imp.Skipped)
	}
	// Existing file untouched.
	contents, _ := os.ReadFile(filepath.Join(dir, "exists.md"))
	if string(contents) != "OLD" {
		t.Fatalf("existing file was overwritten without overwrite flag: %q", string(contents))
	}
}

func TestHandleMarkdownImportBundle_OverwriteReplacesFile(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.md"), []byte("OLD"), 0644); err != nil {
		t.Fatalf("pre-write: %v", err)
	}
	writeConfigWithMarkdownDirs(t, dir)
	in := []MDExportEntry{{Name: "f.md", Content: "NEW"}}
	blob, _ := encodeMarkdownBundle(in)
	body, _ := json.Marshal(MDImportRequest{TargetDir: dir, Blob: blob, Overwrite: true})
	req := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMarkdownImportBundle(w, req)
	var imp MDImportResponse
	_ = json.Unmarshal(w.Body.Bytes(), &imp)
	if len(imp.Written) != 1 || len(imp.Skipped) != 0 {
		t.Fatalf("expected written, got %+v", imp)
	}
	contents, _ := os.ReadFile(filepath.Join(dir, "f.md"))
	if string(contents) != "NEW" {
		t.Fatalf("not overwritten: %q", string(contents))
	}
}

func TestHandleMarkdownImportBundle_RejectsPathTraversal(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	writeConfigWithMarkdownDirs(t, dir)
	// Build a bundle whose Name has a literal '..' substring that the
	// handler's defensive substring check catches after normalizeMarkdownFilename
	// has run. (filepath.Base strips leading '..' traversal segments.)
	in := []MDExportEntry{{Name: "..x..md", Content: "evil"}}
	blob, _ := encodeMarkdownBundle(in)
	body, _ := json.Marshal(MDImportRequest{TargetDir: dir, Blob: blob})
	req := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMarkdownImportBundle(w, req)
	var imp MDImportResponse
	_ = json.Unmarshal(w.Body.Bytes(), &imp)
	if len(imp.Written) != 0 || len(imp.Skipped) != 1 {
		t.Fatalf("traversal should be skipped, got %+v", imp)
	}
	if imp.Written != nil && len(imp.Skipped) < 1 {
		t.Fatalf("no written entries expected, got %+v", imp)
	}
}

func TestHandleMarkdownImportBundle_RequiresPost(t *testing.T) {
	withTempConfig(t)
	req := httptest.NewRequest(http.MethodGet, "/api/markdown/import-bundle", nil)
	w := httptest.NewRecorder()
	handleMarkdownImportBundle(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestHandleMarkdownImportBundle_NoMarkdownDirs(t *testing.T) {
	withTempConfig(t)
	// Force empty MarkdownDirs.
	saveConfig(loadConfig()) // reset
	req := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle",
		strings.NewReader(`{"blob":"PHIMD:abc:def"}`))
	w := httptest.NewRecorder()
	handleMarkdownImportBundle(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestHandleMarkdownImportBundle_RejectsBadBlob(t *testing.T) {
	withTempConfig(t)
	dir := t.TempDir()
	writeConfigWithMarkdownDirs(t, dir)
	cases := []string{"", "junk", "PHICONFIG:abc:def"}
	for _, bad := range cases {
		body, _ := json.Marshal(MDImportRequest{TargetDir: dir, Blob: bad})
		req := httptest.NewRequest(http.MethodPost, "/api/markdown/import-bundle", bytes.NewReader(body))
		w := httptest.NewRecorder()
		handleMarkdownImportBundle(w, req)
		if w.Code == http.StatusOK {
			t.Fatalf("expected error for blob %q, got 200", bad)
		}
	}
}

// helper: flip the first non-prefix character in the base64 segment so
// the encoded blob is actually tampered (still valid base64 shape, but
// mismatched hash).
func flipFirstChar(b64 string) string {
	if b64 == "" {
		return b64
	}
	first := b64[0]
	var repl byte
	if first == 'A' {
		repl = 'B'
	} else {
		repl = 'A'
	}
	return string(repl) + b64[1:]
}

// avoid an unused import warning if `crypto/sha256` is later dropped.
var _ = sha256.New
var _ = base64.StdEncoding
var _ = hex.EncodeToString
var _ = json.Marshal
