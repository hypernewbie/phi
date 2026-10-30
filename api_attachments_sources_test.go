package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestAttachmentBrowseUsesPaneCWDAndListsOnlyRegularEntries(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	inst, ok := ptyManager.Get(pane)
	if !ok {
		t.Fatal("live pane not found")
	}
	dir := filepath.Join(inst.Cwd, "inside")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(inst.Cwd, "note with space.txt")
	fileBytes := []byte("source bytes")
	if err := os.WriteFile(filePath, fileBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inst.Cwd, ".hidden"), []byte("hidden"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filePath, filepath.Join(inst.Cwd, "alias.txt")); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/attachments/v2/browse?pane="+url.QueryEscape(pane), nil)
	response := httptest.NewRecorder()
	handleAttachmentsV2Browse(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var listing attachmentBrowseResponse
	if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if listing.Path != inst.Cwd || listing.Parent != filepath.Dir(inst.Cwd) {
		t.Fatalf("listing root=%+v pane cwd=%q", listing, inst.Cwd)
	}
	if len(listing.Entries) != 2 || listing.Entries[0].Kind != "directory" || listing.Entries[1].Kind != "file" {
		t.Fatalf("unexpected entries: %+v", listing.Entries)
	}
	file := listing.Entries[1]
	if file.Name != filepath.Base(filePath) || file.SizeBytes != int64(len(fileBytes)) || file.Fingerprint == "" {
		t.Fatalf("file metadata=%+v", file)
	}
}

func TestAttachmentServerItemSnapshotsListedBytesAndRejectsChangedSource(t *testing.T) {
	withAttachmentTestGlobals(t)
	pane := withLiveAttachmentPi(t)
	inst, _ := ptyManager.Get(pane)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(outside, "source.txt")
	original := []byte("original source bytes")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	body, err := json.Marshal(attachmentServerItemRequest{
		ID: id, Pane: pane, Path: path, ExpectedFingerprint: attachmentSourceFingerprint(info),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/attachments/v2/server-items", bytes.NewReader(body))
	request.Host = "phi.test"
	request.Header.Set("Origin", "http://phi.test")
	request.Header.Set("Content-Type", "application/json")
	response := &attachmentDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	handleAttachmentsV2ServerItem(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var item AttachmentItem
	if err := json.Unmarshal(response.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.PaneID != "" || item.Name != "source.txt" || item.Path == path {
		t.Fatalf("snapshot metadata=%+v (pane cwd %q)", item, inst.Cwd)
	}
	stored, err := os.ReadFile(item.Path)
	if err != nil || !bytes.Equal(stored, original) {
		t.Fatalf("snapshot bytes=%q err=%v", stored, err)
	}

	if err := os.WriteFile(path, []byte("changed source bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale, _ := json.Marshal(attachmentServerItemRequest{
		ID: uuid.NewString(), Pane: pane, Path: path, ExpectedFingerprint: attachmentSourceFingerprint(info),
	})
	staleRequest := httptest.NewRequest(http.MethodPost, "/api/attachments/v2/server-items", bytes.NewReader(stale))
	staleRequest.Host = "phi.test"
	staleRequest.Header.Set("Origin", "http://phi.test")
	staleRequest.Header.Set("Content-Type", "application/json")
	staleResponse := &attachmentDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	handleAttachmentsV2ServerItem(staleResponse, staleRequest)
	if staleResponse.Code != http.StatusConflict || !bytes.Contains(staleResponse.Body.Bytes(), []byte(`"changed-source"`)) {
		t.Fatalf("stale snapshot status=%d body=%s", staleResponse.Code, staleResponse.Body.String())
	}
}

func TestAttachmentV2BrowseRequiresLivePiPaneAndSameOrigin(t *testing.T) {
	withAttachmentTestGlobals(t)
	for _, tc := range []struct {
		name   string
		pane   string
		origin string
		want   int
	}{
		{name: "missing pane", want: http.StatusNotFound},
		{name: "cross origin", pane: "pane", origin: "http://evil.test", want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			target := "/api/attachments/v2/browse?pane=" + url.QueryEscape(tc.pane)
			r := httptest.NewRequest(http.MethodGet, target, nil)
			r.Host = "phi.test"
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			handleAttachmentsV2Browse(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
